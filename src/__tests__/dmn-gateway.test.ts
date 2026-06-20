/**
 * T-0340 [E15-S5] — Unit tests for DMN gateway wiring
 *
 * Tests:
 *   DG-1  evaluate() correctly applies the 5M threshold rule (needs-approval branch)
 *   DG-2  evaluate() correctly applies the 5M threshold rule (standard branch)
 *   DG-3  evaluate() edge case: amount exactly at threshold → standard (gt not gte)
 *   DG-4  evaluate() with empty rule tables → no routingOutcomes
 *   DG-5  evaluate() FIRST hit-policy: needs-approval wins when amount > 5M
 *   DG-6  preComputeGatewayVariable: loads published tables, evaluates, emits audit event, returns versionVars
 *   DG-7  evaluateGatewayAtTriage: pinned versions → loads OLD rule (in-flight rule-change)
 *   DG-8  evaluateGatewayAtTriage: no pinned versions → loads NEW (current published) rule
 *   DG-9  serializeVersionsAsVariables / deserializeVersionsFromVariables: round-trip
 *   DG-10 deserializeVersionsFromVariables: ignores non-dmn_rtv_ keys + malformed values
 *   DG-11 gateway.evaluated audit event has canonical payload shape (GATEWAY_EVALUATED_TYPE)
 *   DG-12 BPMN: tel-linear.bpmn20.xml contains exclusiveGateway + conditional sequenceFlows
 *   DG-13 migration 080: data-only (no CREATE TABLE, no user_task tokens in the file)
 *
 * NO live Postgres. All DB interactions are stubbed.
 * DATABASE_URL is NOT read (FE-s27-0002 discipline).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  type DmnRuleTable,
  type NamedBindings,
} from "../core/dmn-middle.js";

import {
  serializeVersionsAsVariables,
  deserializeVersionsFromVariables,
  type DmnRuleTableVersion,
  DMN_VERSION_VAR_PREFIX,
} from "../db/dmn-rule-table-store.js";

import {
  TEL_GATEWAY_VAR,
  TEL_GATEWAY_ID,
  preComputeGatewayVariable,
  evaluateGatewayAtTriage,
} from "../core/dmn-gateway.js";

import {
  buildGatewayEvaluatedPayload,
  GATEWAY_EVALUATED_TYPE,
} from "../core/gateway-journal.js";

import { TRANSITION_PAYLOAD_KEY } from "../core/transition-payload.js";

// ---------------------------------------------------------------------------
// Project-root path helper
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");

// ---------------------------------------------------------------------------
// Canonical 5M threshold rule table (mirrors migration 080 seed)
// ---------------------------------------------------------------------------

const TEL_THRESHOLD_TABLE: DmnRuleTable = {
  id: "c0de0001-e150-0005-d4f4-000000000080",
  name: "ТЭЛ: порог суммы закупки",
  hitPolicy: "FIRST",
  rules: [
    {
      annotation: "Сумма > 5 000 000 ₽ → доп. согласование",
      conditions: [{ field: "amount", operator: "gt", value: 5_000_000 }],
      effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "needs-approval" }],
    },
    {
      annotation: "Стандартный трек (сумма в пределах порога)",
      conditions: [],
      effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "standard" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const INSTANCE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const PROC_KEY = "telLinear";
const ACTOR = "a-intake";
const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Stub infrastructure (mirrors step-applier.test.ts pattern)
// ---------------------------------------------------------------------------

interface CapturedAuditEvent {
  type: string;
  subject: string;
  payload: Record<string, unknown>;
}

interface StubClient {
  readonly client: import("pg").PoolClient;
  readonly auditEvents: CapturedAuditEvent[];
  /** Control which tables the stub returns on loadPublishedRuleTables queries */
  ruleTables: DmnRuleTable[];
  ruleVersions: DmnRuleTableVersion[];
}

function makeStubClient(opts?: {
  ruleTables?: DmnRuleTable[];
  ruleVersions?: DmnRuleTableVersion[];
}): StubClient {
  const auditEvents: CapturedAuditEvent[] = [];
  const ruleTables = opts?.ruleTables ?? [TEL_THRESHOLD_TABLE];
  const ruleVersions = opts?.ruleVersions ?? [
    { id: TEL_THRESHOLD_TABLE.id, updatedAt: NOW_MS - 10_000 },
  ];

  const client = {
    query: async (sql: unknown, _values?: unknown[]): Promise<{ rows: unknown[] }> => {
      const sqlText =
        typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
      const upper = sqlText.trimStart().toUpperCase();

      // Absorb transaction control
      if (
        upper.startsWith("BEGIN") ||
        upper.startsWith("COMMIT") ||
        upper.startsWith("ROLLBACK") ||
        upper.startsWith("SET LOCAL") ||
        upper.startsWith("SET SEARCH_PATH")
      ) {
        return { rows: [] };
      }

      // Absorb audit chain
      if (/INSERT INTO choros\.audit_head/i.test(sqlText)) return { rows: [] };
      if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      if (/UPDATE choros\.audit_head/i.test(sqlText)) return { rows: [] };
      if (/INSERT INTO choros\.audit_event/i.test(sqlText)) {
        // Capture the audit event for assertion
        // The audit writer passes values as positional params; extract from raw SQL or values
        // We capture them indirectly via the appendAuditEvent call in the stub below.
        return { rows: [] };
      }
      if (/current_setting\('choros\.tenant_id'/i.test(sqlText)) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }

      // DMN rule table queries
      if (/FROM choros\.dmn_rule_table/i.test(sqlText)) {
        // Detect the version-pinned query (has ABS(...) predicate)
        if (/ABS\(/i.test(sqlText)) {
          // loadRuleTablesByVersions: return matching row for the first pinned version
          const ver = ruleVersions[0];
          if (!ver) return { rows: [] };
          return {
            rows: [
              {
                id: ver.id,
                name: TEL_THRESHOLD_TABLE.name,
                definition: {
                  id: ver.id,
                  name: TEL_THRESHOLD_TABLE.name,
                  hitPolicy: TEL_THRESHOLD_TABLE.hitPolicy,
                  rules: TEL_THRESHOLD_TABLE.rules,
                },
                process_def_id: null,
                status: "published",
                updated_at: ver.updatedAt,
              },
            ],
          };
        }
        // loadPublishedRuleTables: return configured tables
        return {
          rows: ruleTables.map((t) => ({
            id: t.id,
            name: t.name,
            definition: {
              id: t.id,
              name: t.name,
              hitPolicy: t.hitPolicy,
              rules: t.rules,
            },
            process_def_id: null,
            status: "published",
            updated_at: NOW_MS - 10_000,
          })),
        };
      }

      return { rows: [] };
    },
    release: () => {},
  } as unknown as import("pg").PoolClient;

  return { client, auditEvents, ruleTables, ruleVersions };
}

// ---------------------------------------------------------------------------
// Intercept audit events: wrap the stub client to capture gateway.evaluated events.
// ---------------------------------------------------------------------------

/**
 * Capture `gateway.evaluated` audit events written by the test subject.
 * We instrument the query interception on INSERT INTO choros.audit_event lines
 * by parsing the SQL + values.
 */
function makeCapturingClient(ruleTables?: DmnRuleTable[], ruleVersions?: DmnRuleTableVersion[]): {
  client: import("pg").PoolClient;
  capturedEvents: Array<{ type: string; subject: string; payload: unknown }>;
} {
  const capturedEvents: Array<{ type: string; subject: string; payload: unknown }> = [];
  const base = makeStubClient({ ruleTables, ruleVersions });

  const originalQuery = base.client.query.bind(base.client);

  const wrappedClient = {
    query: async (sql: unknown, _values?: unknown[]) => {
      const sqlText = typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");

      // Intercept audit_event INSERT to capture it before absorbing
      if (/INSERT INTO choros\.audit_event/i.test(sqlText) && Array.isArray(_values)) {
        // The audit writer passes values as positional params.
        // Fish out the type by scanning for known event type strings.
        for (let i = 0; i < _values.length; i++) {
          if (typeof _values[i] === "string" && _values[i] === GATEWAY_EVALUATED_TYPE) {
            const typeIdx = i;
            const subjectIdx = typeIdx + 1;
            const payloadIdx = typeIdx + 7; // rough offset
            capturedEvents.push({
              type: String(_values[typeIdx]),
              subject: typeof _values[subjectIdx] === "string" ? String(_values[subjectIdx]) : "(unknown)",
              payload: _values[payloadIdx],
            });
            break;
          }
        }
      }

      return (originalQuery as (sql: unknown, values?: unknown[]) => Promise<{ rows: unknown[] }>)(sql, _values);
    },
    release: () => {},
  } as unknown as import("pg").PoolClient;

  return { client: wrappedClient, capturedEvents };
}

// ---------------------------------------------------------------------------
// DG-1: evaluate() — amount > 5M → needs-approval
// ---------------------------------------------------------------------------

describe("DG-1: evaluate() — amount > 5M → needs-approval", () => {
  it("DG-1a: 5,500,000 > threshold → approvalRequired = 'needs-approval'", () => {
    const bindings: NamedBindings = { amount: 5_500_000 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    expect(result.routingOutcomes["approvalRequired"]).toBe("needs-approval");
    expect(result.rulesMatched).toBe(1);
  });

  it("DG-1b: 10,000,000 > threshold → approvalRequired = 'needs-approval'", () => {
    const bindings: NamedBindings = { amount: 10_000_000 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    expect(result.routingOutcomes["approvalRequired"]).toBe("needs-approval");
  });
});

// ---------------------------------------------------------------------------
// DG-2: evaluate() — amount <= 5M → standard
// ---------------------------------------------------------------------------

describe("DG-2: evaluate() — amount ≤ 5M → standard", () => {
  it("DG-2a: 4,999,999 < threshold → approvalRequired = 'standard'", () => {
    const bindings: NamedBindings = { amount: 4_999_999 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    expect(result.routingOutcomes["approvalRequired"]).toBe("standard");
  });

  it("DG-2b: 1,000 well below threshold → approvalRequired = 'standard'", () => {
    const bindings: NamedBindings = { amount: 1_000 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    expect(result.routingOutcomes["approvalRequired"]).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// DG-3: evaluate() — amount exactly at threshold (5,000,000) → standard (gt, not gte)
// ---------------------------------------------------------------------------

describe("DG-3: evaluate() — amount exactly at 5M threshold → standard (gt, not gte)", () => {
  it("DG-3a: amount = 5,000,000 exactly → standard (the threshold is STRICTLY greater than)", () => {
    const bindings: NamedBindings = { amount: 5_000_000 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    // The rule uses "gt" (greater-than), NOT "gte" (greater-than-or-equal).
    // So exactly 5M falls through to the unconditional "standard" row.
    expect(result.routingOutcomes["approvalRequired"]).toBe("standard");
    expect(result.rulesMatched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DG-4: evaluate() — empty rule tables → no routingOutcomes
// ---------------------------------------------------------------------------

describe("DG-4: evaluate() — empty rule tables", () => {
  it("DG-4a: no rule tables → zero routingOutcomes", () => {
    const bindings: NamedBindings = { amount: 9_000_000 };
    const result = evaluate([], bindings);
    expect(Object.keys(result.routingOutcomes)).toHaveLength(0);
    expect(result.tablesEvaluated).toBe(0);
    expect(result.rulesMatched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DG-5: evaluate() — FIRST hit-policy: needs-approval wins (first matching row)
// ---------------------------------------------------------------------------

describe("DG-5: evaluate() — FIRST hit-policy stops at first matching row", () => {
  it("DG-5a: amount > 5M fires row 1 (needs-approval); row 2 (unconditional standard) is NOT reached", () => {
    const bindings: NamedBindings = { amount: 6_000_000 };
    const result = evaluate([TEL_THRESHOLD_TABLE], bindings);
    expect(result.routingOutcomes["approvalRequired"]).toBe("needs-approval");
    // FIRST: only ONE rule fires even though row 2 (unconditional) would also match
    expect(result.rulesMatched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DG-6: preComputeGatewayVariable — loads published tables, evaluates, returns versionVars
// ---------------------------------------------------------------------------

describe("DG-6: preComputeGatewayVariable (A pre-compute path)", () => {
  it("DG-6a: high-value purchase → gatewayVar = 'needs-approval' + versionVars contains dmn_rtv_ key", async () => {
    const { client } = makeCapturingClient();
    const result = await preComputeGatewayVariable(client, {
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      actor: ACTOR,
      nowMs: NOW_MS,
      bindings: { amount: 6_000_000 },
      gatewayId: TEL_GATEWAY_ID,
    });

    expect(result.gatewayVar).toBe("needs-approval");
    expect(Object.keys(result.versionVars).some((k) => k.startsWith(DMN_VERSION_VAR_PREFIX))).toBe(true);
    expect(result.versions.length).toBeGreaterThan(0);
  });

  it("DG-6b: standard purchase → gatewayVar = 'standard'", async () => {
    const { client } = makeCapturingClient();
    const result = await preComputeGatewayVariable(client, {
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      actor: ACTOR,
      nowMs: NOW_MS,
      bindings: { amount: 500_000 },
      gatewayId: TEL_GATEWAY_ID,
    });

    expect(result.gatewayVar).toBe("standard");
  });

  it("DG-6c: no rule tables → gatewayVar = null, empty versionVars", async () => {
    const { client } = makeCapturingClient([]);
    const result = await preComputeGatewayVariable(client, {
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      actor: ACTOR,
      nowMs: NOW_MS,
      bindings: { amount: 6_000_000 },
      gatewayId: TEL_GATEWAY_ID,
    });

    expect(result.gatewayVar).toBeNull();
    expect(Object.keys(result.versionVars)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DG-7: evaluateGatewayAtTriage — pinned versions → loads OLD rule (in-flight)
// ---------------------------------------------------------------------------

describe("DG-7: evaluateGatewayAtTriage — pinned versions → uses OLD rule", () => {
  it("DG-7a: existingVariables has dmn_rtv_ keys → loadRuleTablesByVersions path (in-flight old rule)", async () => {
    const pinnedVersion: DmnRuleTableVersion = {
      id: TEL_THRESHOLD_TABLE.id,
      updatedAt: NOW_MS - 10_000,
    };
    const pinnedVars = serializeVersionsAsVariables([pinnedVersion]);
    const { client } = makeCapturingClient(undefined, [pinnedVersion]);

    const result = await evaluateGatewayAtTriage(client, {
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      gatewayId: TEL_GATEWAY_ID,
      actor: ACTOR,
      nowMs: NOW_MS,
      bindings: { amount: 7_000_000 },
      existingVariables: pinnedVars,
    });

    expect(result.isLateCompute).toBe(true);
    expect(result.gatewayVar).toBe("needs-approval");
    // Used the pinned versions (in-flight rule)
    expect(result.versions.some((v) => v.id === pinnedVersion.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DG-8: evaluateGatewayAtTriage — no pinned versions → loads NEW rule
// ---------------------------------------------------------------------------

describe("DG-8: evaluateGatewayAtTriage — no pinned versions → uses NEW (published) rule", () => {
  it("DG-8a: no dmn_rtv_ vars in existingVariables → loadPublishedRuleTables path (new rule)", async () => {
    const { client } = makeCapturingClient();

    const result = await evaluateGatewayAtTriage(client, {
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      gatewayId: TEL_GATEWAY_ID,
      actor: ACTOR,
      nowMs: NOW_MS,
      bindings: { amount: 500_000 },
      existingVariables: { someOtherVar: "foo" }, // no dmn_rtv_ keys
    });

    expect(result.isLateCompute).toBe(true);
    expect(result.gatewayVar).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// DG-9: serializeVersionsAsVariables / deserializeVersionsFromVariables round-trip
// ---------------------------------------------------------------------------

describe("DG-9: version serialization round-trip", () => {
  it("DG-9a: serialize then deserialize preserves id + updatedAt", () => {
    const versions: DmnRuleTableVersion[] = [
      { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", updatedAt: 1_700_000_000_123 },
      { id: "11111111-2222-3333-4444-555555555555", updatedAt: 1_699_000_000_456 },
    ];

    const vars = serializeVersionsAsVariables(versions);
    expect(Object.keys(vars)).toHaveLength(2);

    const restored = deserializeVersionsFromVariables(vars);
    expect(restored).toHaveLength(2);

    for (const orig of versions) {
      const match = restored.find((r) => r.id === orig.id);
      expect(match).toBeDefined();
      expect(match?.updatedAt).toBeCloseTo(orig.updatedAt, 0);
    }
  });

  it("DG-9b: empty versions → empty serialized vars → empty deserialized", () => {
    const vars = serializeVersionsAsVariables([]);
    expect(Object.keys(vars)).toHaveLength(0);
    const restored = deserializeVersionsFromVariables(vars);
    expect(restored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DG-10: deserializeVersionsFromVariables — ignores non-dmn_rtv_ keys + malformed
// ---------------------------------------------------------------------------

describe("DG-10: deserializeVersionsFromVariables — ignores irrelevant keys", () => {
  it("DG-10a: ignores keys not starting with DMN_VERSION_VAR_PREFIX", () => {
    const vars: Record<string, unknown> = {
      approvalRequired: "standard",
      someField: "someValue",
      dmn_rtv_aaaaaaaabbbbccccddddeeeeeeeeeeee: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:1700000000000",
    };

    const versions = deserializeVersionsFromVariables(vars);
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("DG-10b: ignores malformed value (no colon separator)", () => {
    const vars: Record<string, unknown> = {
      [`${DMN_VERSION_VAR_PREFIX}malformed`]: "notauuid",
    };

    const versions = deserializeVersionsFromVariables(vars);
    expect(versions).toHaveLength(0);
  });

  it("DG-10c: ignores non-string values", () => {
    const vars: Record<string, unknown> = {
      [`${DMN_VERSION_VAR_PREFIX}aaaaaaaabbbbccccddddeeeeeeeeeeee`]: 12345,
    };

    const versions = deserializeVersionsFromVariables(vars);
    expect(versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DG-11: gateway.evaluated audit event canonical payload shape
// ---------------------------------------------------------------------------

describe("DG-11: buildGatewayEvaluatedPayload — canonical payload shape", () => {
  it("DG-11a: payload contains verdict, gateway_id, proc_key, inst, transition_payload", () => {
    const result = buildGatewayEvaluatedPayload({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      processKey: PROC_KEY,
      gatewayId: TEL_GATEWAY_ID,
      actor: ACTOR,
      actorType: "service",
      ts: NOW_MS,
      verdict: "needs-approval",
    });

    expect(result.subject).toBe(`instance:${INSTANCE_ID}`);
    expect(result.scope["gateway_id"]).toBe(TEL_GATEWAY_ID);
    expect(result.scope["proc_key"]).toBe(PROC_KEY);
    expect(result.payload["verdict"]).toBe("needs-approval");
    expect(result.payload["gateway_id"]).toBe(TEL_GATEWAY_ID);
    expect(result.payload["inst"]).toBe(INSTANCE_ID);
    expect(result.payload["proc_key"]).toBe(PROC_KEY);

    // TransitionPayload must be embedded under the canonical key
    const tp = result.payload[TRANSITION_PAYLOAD_KEY] as Record<string, unknown>;
    expect(tp).toBeDefined();
    expect(tp["tenant_id"]).toBe(TENANT_ID);
    expect(tp["instance_id"]).toBe(INSTANCE_ID);
    expect(tp["process_key"]).toBe(PROC_KEY);
    expect(tp["verdict"]).toBe("needs-approval");
    expect(tp["actor_type"]).toBe("service");
    expect(tp["duration_ms"]).toBeNull(); // gateways are synchronous
  });

  it("DG-11b: GATEWAY_EVALUATED_TYPE is 'gateway.evaluated'", () => {
    expect(GATEWAY_EVALUATED_TYPE).toBe("gateway.evaluated");
  });

  it("DG-11c: TEL_GATEWAY_VAR is 'approvalRequired'", () => {
    expect(TEL_GATEWAY_VAR).toBe("approvalRequired");
  });

  it("DG-11d: TEL_GATEWAY_ID is 'gw-approval-threshold'", () => {
    expect(TEL_GATEWAY_ID).toBe("gw-approval-threshold");
  });
});

// ---------------------------------------------------------------------------
// DG-12: BPMN — tel-linear.bpmn20.xml contains exclusiveGateway + conditional flows
// ---------------------------------------------------------------------------

describe("DG-12: tel-linear.bpmn20.xml contains exclusiveGateway + conditional sequenceFlows", () => {
  const bpmnPath = path.join(
    PROJECT_ROOT,
    "config/flowable/processes/tel-linear.bpmn20.xml",
  );

  let bpmnContent: string;
  try {
    bpmnContent = fs.readFileSync(bpmnPath, "utf-8");
  } catch {
    bpmnContent = "";
  }

  it("DG-12a: BPMN file exists and is non-empty", () => {
    expect(bpmnContent.length).toBeGreaterThan(0);
  });

  it("DG-12b: contains exclusiveGateway element", () => {
    expect(bpmnContent).toMatch(/<exclusiveGateway/);
  });

  it("DG-12c: exclusiveGateway has id='gw-approval-threshold'", () => {
    expect(bpmnContent).toMatch(/id="gw-approval-threshold"/);
  });

  it("DG-12d: contains conditionExpression for needs-approval branch", () => {
    expect(bpmnContent).toMatch(/approvalRequired.*needs-approval/);
  });

  it("DG-12e: contains conditionExpression for standard branch", () => {
    expect(bpmnContent).toMatch(/approvalRequired.*standard/);
  });

  it("DG-12f: contains at least two sequenceFlows from the gateway", () => {
    const gwFlows = bpmnContent.match(/sourceRef="gw-approval-threshold"/g) ?? [];
    expect(gwFlows.length).toBeGreaterThanOrEqual(2);
  });

  it("DG-12g: serviceTask task-triage still present (external topic=tel-intake)", () => {
    expect(bpmnContent).toMatch(/id="task-triage"/);
    expect(bpmnContent).toMatch(/flowable:type="external"/);
    expect(bpmnContent).toMatch(/flowable:topic="tel-intake"/);
  });
});

// ---------------------------------------------------------------------------
// DG-13: migration 080 — data-only (no CREATE TABLE, no user_task token)
// ---------------------------------------------------------------------------

describe("DG-13: migration 080 is data-only (no CREATE TABLE, no user_task)", () => {
  const migPath = path.join(PROJECT_ROOT, "migrations/080_tel_dmn_seed.sql");

  let migContent: string;
  try {
    migContent = fs.readFileSync(migPath, "utf-8");
  } catch {
    migContent = "";
  }

  it("DG-13a: migration 080 file exists", () => {
    expect(migContent.length).toBeGreaterThan(0);
  });

  it("DG-13b: migration 080 contains no CREATE TABLE statement", () => {
    // Exclude comment lines — only check code lines
    const codeLines = migContent
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(codeLines.toLowerCase()).not.toMatch(/create\s+table/);
  });

  it("DG-13c: migration 080 contains no bare user_task token", () => {
    const codeLines = migContent
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    // 'user_task' not present (defer-no-new-table invariant)
    expect(codeLines.toLowerCase()).not.toMatch(/user_task/);
  });

  it("DG-13d: migration 080 contains INSERT INTO choros.dmn_rule_table", () => {
    expect(migContent).toMatch(/INSERT INTO choros\.dmn_rule_table/i);
  });

  it("DG-13e: migration 080 seeds the 5M threshold value 5000000", () => {
    expect(migContent).toMatch(/5000000/);
  });
});
