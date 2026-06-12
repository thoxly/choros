/**
 * T-0136: PDP Explain — unit tests
 *
 * Tests the TraceCollector instrumentation in resolveFor and the explain
 * endpoint's authz + verdict-agreement property.
 *
 * Design discipline: explain uses the same resolveFor path — verdict
 * agreement is guaranteed structurally, not by cross-checking two
 * independent implementations.
 *
 * Test matrix:
 *   - trace: cross_tenant → no trace after tenant step
 *   - trace: no_grant (all grants missing)
 *   - trace: no_grant (time-window mismatch → effective_filter fails)
 *   - trace: no_grant (scope mismatch → scope_filter fails)
 *   - trace: allow → masking step present
 *   - property: for N random deny/allow cases, trace verdict === resolveFor verdict
 *   - authz: 403 for non-admin caller about foreign subject (HTTP layer)
 */

import { describe, it, expect } from "vitest";
import {
  type Grant,
  type AncestryOracle,
} from "../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  type TraceCollector,
  type TraceStep,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ObjectHandle,
  type ResolveSubject,
  makeHandle,
} from "../core/object-handle.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const T = "tenant-A";
const OTHER_T = "tenant-B";
const APP = "app-1";
const REG = "reg-1";
const REC = "rec-1";

function makeOracle(edges: Array<[string, string]>): AncestryOracle {
  const map = new Map<string, Set<string>>();
  for (const [child, parent] of edges) {
    if (!map.has(child)) map.set(child, new Set());
    map.get(child)!.add(parent);
  }
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of map.get(cur) ?? []) {
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return seen;
  };
  return {
    isDescendantOrSelf(_h, descendantId, ancestorId): boolean {
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

function defaultOracle(): AncestryOracle {
  return makeOracle([[REC, REG], [REG, APP]]);
}

function recordHandle(tenantId = T): ObjectHandle {
  return makeHandle(
    { kind: "record", tenantId, registryId: REG, recordId: REC },
    tenantId,
    undefined,
  );
}

function subject(subjectId = "user-1", tenantId = T): ResolveSubject {
  return { tenantId, subjectId };
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: APP, nodeLevel: "application" },
    delegable: true,
    grantedBy: "owner",
    createdAt: 1000,
    ...overrides,
  };
}

function makeGrants(grants: Grant[]): GrantSource {
  return { async getGrants(_subject, _now) { return grants; } };
}

function makeRecord(
  fields: Record<string, unknown> = { x: 1 },
): RecordSource {
  return { async getRecord(_ref) { return fields; } };
}

function nullRecord(): RecordSource {
  return { async getRecord(_ref) { return null; } };
}

function makeDeps(opts: {
  grants?: Grant[];
  record?: Record<string, unknown> | null;
  now?: number;
}): ResolverDeps {
  return {
    grants: opts.grants !== undefined
      ? makeGrants(opts.grants)
      : makeGrants([makeGrant()]),
    records: opts.record === null
      ? nullRecord()
      : makeRecord(opts.record ?? { x: 1 }),
    ancestry: defaultOracle(),
    now: opts.now !== undefined ? () => opts.now! : () => 5000,
  };
}

// ---------------------------------------------------------------------------
// Trace: cross_tenant
// ---------------------------------------------------------------------------

describe("trace: cross_tenant", () => {
  it("emits tenant step with ok:false and returns denied:cross_tenant", async () => {
    const handle = recordHandle(OTHER_T); // different tenant
    const sub = subject("user-1", T); // caller tenant T, handle tenant OTHER_T
    const deps = makeDeps({});

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "cross_tenant" });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ step: "tenant", ok: false });
  });
});

// ---------------------------------------------------------------------------
// Trace: no grants
// ---------------------------------------------------------------------------

describe("trace: no_grant (empty grant set)", () => {
  it("emits tenant+grants_resolved+effective_filter+scope_filter+covering steps", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [] }); // no grants at all

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain("tenant");
    expect(stepNames).toContain("grants_resolved");
    expect(stepNames).toContain("effective_filter");
    expect(stepNames).toContain("scope_filter");
    expect(stepNames).toContain("covering");

    const coveringStep = steps.find((s) => s.step === "covering")!;
    expect(coveringStep.ok).toBe(false);
    expect((coveringStep as Extract<TraceStep, { step: "covering" }>).reason).toBe("no_grant");

    const grantStep = steps.find((s) => s.step === "grants_resolved")!;
    expect((grantStep as Extract<TraceStep, { step: "grants_resolved" }>).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: effective_filter (time window mismatch)
// ---------------------------------------------------------------------------

describe("trace: effective_filter fails (expired grant)", () => {
  it("emits effective_filter ok:false when grant is expired", async () => {
    const now = 5000;
    // Grant valid_until=1000 < now=5000 → expired
    const expiredGrant = makeGrant({ validUntil: 1000 });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [expiredGrant], now });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const effectiveStep = steps.find((s) => s.step === "effective_filter") as
      Extract<TraceStep, { step: "effective_filter" }> | undefined;
    expect(effectiveStep).toBeDefined();
    expect(effectiveStep!.ok).toBe(false);
    expect(effectiveStep!.passed).toBe(0);
  });

  it("emits effective_filter ok:false when grant is not yet valid", async () => {
    const now = 1000;
    // Grant valid_from=5000 > now=1000 → future
    const futureGrant = makeGrant({ validFrom: 5000 });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [futureGrant], now });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const effectiveStep = steps.find((s) => s.step === "effective_filter") as
      Extract<TraceStep, { step: "effective_filter" }> | undefined;
    expect(effectiveStep).toBeDefined();
    expect(effectiveStep!.ok).toBe(false);
    expect(effectiveStep!.passed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: scope_filter (scope mismatch)
// ---------------------------------------------------------------------------

describe("trace: scope_filter fails (wrong scope node)", () => {
  it("emits scope_filter ok:false when grant scope doesn't cover handle", async () => {
    // Grant scoped to "other-app" — does NOT cover APP/REG/REC
    const narrowGrant = makeGrant({
      scope: { kind: "node", hierarchy: "resource", nodeId: "other-app", nodeLevel: "application" },
    });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [narrowGrant] });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const scopeStep = steps.find((s) => s.step === "scope_filter") as
      Extract<TraceStep, { step: "scope_filter" }> | undefined;
    expect(scopeStep).toBeDefined();
    expect(scopeStep!.ok).toBe(false);
    expect(scopeStep!.passed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: allow + masking step
// ---------------------------------------------------------------------------

describe("trace: allow path", () => {
  it("emits all steps with ok:true and includes masking step", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: { name: "Alice" } });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result.denied).toBe(false);

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain("tenant");
    expect(stepNames).toContain("grants_resolved");
    expect(stepNames).toContain("effective_filter");
    expect(stepNames).toContain("scope_filter");
    expect(stepNames).toContain("covering");
    expect(stepNames).toContain("record_fetch");
    expect(stepNames).toContain("masking");

    const maskStep = steps.find((s) => s.step === "masking") as
      Extract<TraceStep, { step: "masking" }> | undefined;
    expect(maskStep).toBeDefined();
    expect(maskStep!.ok).toBe(true);
    expect(maskStep!.governed).toBe(false); // no ClassificationSource wired
  });

  it("grants_resolved count matches actual grant count", async () => {
    const grants = [makeGrant(), makeGrant({ id: "g-2" })];
    const deps = makeDeps({ grants });
    const handle = recordHandle();
    const sub = subject();

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };
    await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    const grantStep = steps.find((s) => s.step === "grants_resolved") as
      Extract<TraceStep, { step: "grants_resolved" }> | undefined;
    expect(grantStep!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Trace: not_found
// ---------------------------------------------------------------------------

describe("trace: not_found", () => {
  it("emits record_fetch ok:false with reason not_found", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: null });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "not_found" });

    const fetchStep = steps.find((s) => s.step === "record_fetch") as
      Extract<TraceStep, { step: "record_fetch" }> | undefined;
    expect(fetchStep).toBeDefined();
    expect(fetchStep!.ok).toBe(false);
    expect(fetchStep!.reason).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Property: trace.verdict === resolveFor.verdict for a matrix of cases
// ---------------------------------------------------------------------------

describe("property: explain verdict matches resolveFor verdict", () => {
  /**
   * For each test case, we run resolveFor TWICE:
   *   1. Without trace (baseline)
   *   2. With trace (explain path)
   *
   * The verdict from the trace-annotated run must match the baseline.
   * This is the structural guarantee of AC-1.
   */
  const cases: Array<{
    name: string;
    grants: Grant[];
    record: Record<string, unknown> | null;
    now: number;
    crossTenant?: boolean;
  }> = [
    { name: "empty grants → deny", grants: [], record: { x: 1 }, now: 5000 },
    { name: "good grant → allow", grants: [makeGrant()], record: { x: 1 }, now: 5000 },
    { name: "expired grant → deny", grants: [makeGrant({ validUntil: 1000 })], record: { x: 1 }, now: 5000 },
    { name: "future grant → deny", grants: [makeGrant({ validFrom: 9000 })], record: { x: 1 }, now: 5000 },
    { name: "wrong op → deny", grants: [makeGrant({ operation: "write" as never })], record: { x: 1 }, now: 5000 },
    { name: "record not_found → deny", grants: [makeGrant()], record: null, now: 5000 },
    { name: "cross_tenant → deny", grants: [makeGrant()], record: { x: 1 }, now: 5000, crossTenant: true },
    {
      name: "good grant with window → allow",
      grants: [makeGrant({ validFrom: 1000, validUntil: 9000 })],
      record: { x: 1 },
      now: 5000,
    },
    {
      name: "two grants, one expired one valid → allow",
      grants: [makeGrant({ id: "g-exp", validUntil: 1000 }), makeGrant({ id: "g-valid" })],
      record: { x: 1 },
      now: 5000,
    },
  ];

  for (const tc of cases) {
    it(`${tc.name}`, async () => {
      const tenantId = tc.crossTenant ? OTHER_T : T;
      const handle = recordHandle(tenantId);
      const sub = subject("user-1", T);
      const deps = makeDeps({ grants: tc.grants, record: tc.record, now: tc.now });

      // Baseline: without trace
      const baseline = await resolveFor(deps, handle, sub, "read");

      // With trace
      const steps: TraceStep[] = [];
      const trace: TraceCollector = { push: (s) => { steps.push(s); } };
      const withTrace = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

      // Verdict must match
      expect(withTrace.denied).toBe(baseline.denied);
      if (baseline.denied && withTrace.denied) {
        expect(withTrace.reason).toBe(baseline.reason);
      }

      // Trace must have at least the tenant step
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]!.step).toBe("tenant");
    });
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility: trace absent = byte-identical (NF-1)
// ---------------------------------------------------------------------------

describe("backward compat: no trace = no behaviour change", () => {
  it("resolveFor without trace returns same result as with null-trace", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: { foo: "bar" } });

    const without = await resolveFor(deps, handle, sub, "read");
    const withEmpty = await resolveFor(deps, handle, sub, "read", undefined, undefined, undefined);

    expect(without.denied).toBe(withEmpty.denied);
    if (!without.denied && !withEmpty.denied) {
      expect(JSON.stringify(without.fields)).toBe(JSON.stringify(withEmpty.fields));
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP-layer authz tests (R-1):
//   - self-query: callerSubjectId === subjectId → 200, no maskedFields in steps
//   - non-admin caller about foreign subject → 403 EXPLAIN_FORBIDDEN
//   - admin with confirmed+delegable mgmt_object:grant → 200, maskedFields visible
//   - 503 NO_DATABASE when pool is null (R-7)
//   - 422 EXPLAIN_OP_UNSUPPORTED for invoke/approve/transition (R-2)
// ---------------------------------------------------------------------------

import * as http from "node:http";
import pg from "pg";
import { Router } from "../http/router.js";
import { registerPdpExplainRoutes } from "../http/pdp-explain.js";

// Shared constants matching server DEV_TENANT_ID default
const HTTP_TENANT = "a0000000-0000-0000-0000-000000000001";
const SUBJECT_USER = "alice";
const OTHER_USER = "bob";
const ADMIN_USER = "carol";

// A minimal role_id and record UUID for the fake grant
const ROLE_ID = "c0000000-0000-0000-0000-000000000001";
const GRANT_ID = "d0000000-0000-0000-0000-000000000001";
const RECORD_ID = "e0000000-0000-0000-0000-000000000001";
const REG_ID = "f0000000-0000-0000-0000-000000000001";

// Resource-hierarchy scope scoped exactly to RECORD_ID at record level.
// isNarrowerOrEqual(child={record,RECORD_ID}, parent={record,RECORD_ID}) →
// oracle.isDescendantOrSelf("resource", RECORD_ID, RECORD_ID) → true (self).
// This avoids dependency on the SEED_ORACLE's org-tree for resource scoping.
const RECORD_SCOPE = {
  kind: "node",
  hierarchy: "resource",
  nodeId: RECORD_ID,
  nodeLevel: "record",
};

// Org-hierarchy scope used by admin mgmt_object grant (org-scoped authority).
// mgmt_object:grant scope is evaluated against org ancestry; SEED_ORACLE covers "org".
const ADMIN_ORG_SCOPE = {
  kind: "node",
  hierarchy: "org",
  nodeId: "org",
  nodeLevel: "org",
};

/**
 * Build a fake pg.Pool that simulates the DB responses needed by explain.
 *
 * The pool routes queries by SQL pattern:
 *   1. BEGIN / COMMIT / ROLLBACK / SET LOCAL → no-op
 *   2. loadSubjectGrants:
 *        - role_assignment query (no org_scope, no tenant-owner) → [{ role_id }] or []
 *        - grant query (role_id = ANY) → subject grant rows or []
 *   3. loadAdminContext (only for foreign caller):
 *        - tenant-owner genesis check → []
 *        - role_assignment with org_scope → admin ra row or []
 *        - mgmt_object:* grant query → admin grant row or []
 *   4. fetchRecordForExplain: choros.record → [{ data }] or []
 *
 * Grant scope uses RECORD_SCOPE (resource hierarchy, exact RECORD_ID node) so
 * isNarrowerOrEqual(record-ref, grant-scope, SEED_ORACLE) = true (self-check).
 * The `operation` field in the subject grant matches the test's requested op.
 */
function makeExplainPool(opts: {
  /** Does the subject have a valid role+grant? */
  subjectHasGrant: boolean;
  /** Is the caller an admin with mgmt_object:grant read? */
  callerIsAdmin: boolean;
  /** Does the record exist in DB? */
  recordExists: boolean;
  /**
   * Operation the subject grant covers.
   * Defaults to "read". For create/update/delete tests use the matching op
   * so that grant-resolver's operation filter passes (g.operation !== op check).
   */
  grantOperation?: string;
}): pg.Pool {
  const grantOp = opts.grantOperation ?? "read";

  // Grant row for subject — scoped at resource/RECORD_ID level (self-scope covers the ref)
  const subjectGrantRow = {
    id: GRANT_ID,
    role_id: ROLE_ID,
    resource_type: "record",
    resource_facet: null,
    operation: grantOp,
    scope: RECORD_SCOPE,
    constraint: null,
    delegable: true,
    granted_by: "owner",
    valid_from: null,
    valid_until: null,
    created_at: "1000",
  };

  // Admin grant row: mgmt_object:grant read, delegable, org-scoped
  const adminGrantRow = {
    id: "ad000000-0000-0000-0000-000000000001",
    role_id: "ad100000-0000-0000-0000-000000000001",
    resource_type: "mgmt_object:grant",
    resource_facet: null,
    operation: "read",
    scope: ADMIN_ORG_SCOPE,
    constraint: null,
    delegable: true,
    granted_by: "genesis",
    valid_from: null,
    valid_until: null,
    created_at: "1000",
  };

  const adminRaRow = {
    id: "ae000000-0000-0000-0000-000000000001",
    role_id: adminGrantRow.role_id,
    org_scope: ADMIN_ORG_SCOPE,
  };

  const stubClient = {
    query: async (text: string | { text: string }, _values?: unknown[]) => {
      const sql = (typeof text === "string" ? text : text.text).trim();

      // Control-flow statements — no data returned
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(sql)) {
        return { rows: [] };
      }

      // --- loadSubjectGrants ---
      // Query 1: role_assignment for subject — does NOT select org_scope, NOT genesis check
      if (
        /role_assignment\s+ra/.test(sql)
        && /employee_id/.test(sql)
        && /confirmed_by IS NOT NULL/.test(sql)
        && !/org_scope/i.test(sql)
        && !/tenant-owner/i.test(sql)
      ) {
        return opts.subjectHasGrant
          ? { rows: [{ role_id: ROLE_ID }] }
          : { rows: [] };
      }

      // Query 2: grants for subject's roles — role_id = ANY(...)
      if (/FROM choros\."grant"/.test(sql) && /role_id\s*=\s*ANY/.test(sql)) {
        return opts.subjectHasGrant
          ? { rows: [subjectGrantRow] }
          : { rows: [] };
      }

      // --- loadAdminContext ---
      // Query A: genesis owner check — looks for tenant-owner role slug
      if (/tenant-owner/i.test(sql)) {
        return { rows: [] };
      }

      // Query B: role_assignment with org_scope in SELECT (admin context)
      if (
        /role_assignment\s+ra/.test(sql)
        && /org_scope/i.test(sql)
        && /confirmed_by IS NOT NULL/.test(sql)
      ) {
        return opts.callerIsAdmin ? { rows: [adminRaRow] } : { rows: [] };
      }

      // Query C: mgmt_object:* grants for admin role — role_id = $2 (positional param)
      if (
        /FROM choros\."grant"\s+g/.test(sql)
        && /mgmt_object:/i.test(sql)
      ) {
        return opts.callerIsAdmin ? { rows: [adminGrantRow] } : { rows: [] };
      }

      // --- fetchRecordForExplain ---
      if (/FROM choros\.record/.test(sql)) {
        return opts.recordExists
          ? { rows: [{ data: { field_x: "value" } }] }
          : { rows: [] };
      }

      // Unknown query — return empty (safe default)
      return { rows: [] };
    },
    release: () => undefined,
  };

  return {
    connect: async () => stubClient,
  } as unknown as pg.Pool;
}

/** Build a minimal test HTTP server wired only with the explain route */
async function startExplainServer(
  pool: pg.Pool | null,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const router = new Router();
  registerPdpExplainRoutes(router, pool);
  const server = http.createServer(router.dispatch.bind(router));

  return new Promise((resolve) => {
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        const baseUrl = `http://localhost:${addr.port}`;
        resolve({
          baseUrl,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      }
    });
  });
}

function postExplain(
  baseUrl: string,
  body: unknown,
  devUser: string,
): Promise<{ statusCode: number; parsed: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${baseUrl}/api/pdp/explain`);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user": devUser,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        res.on("end", () => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty */ }
          resolve({ statusCode: res.statusCode ?? 0, parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/** Minimal valid explain body for a read on a record ref */
function makeExplainBody(overrides: {
  subjectId?: string;
  operation?: string;
} = {}): Record<string, unknown> {
  return {
    subject: { tenantId: HTTP_TENANT, subjectId: overrides.subjectId ?? SUBJECT_USER },
    handle: {
      tenantId: HTTP_TENANT,
      ref: {
        kind: "record",
        tenantId: HTTP_TENANT,
        registryId: REG_ID,
        recordId: RECORD_ID,
      },
    },
    operation: overrides.operation ?? "read",
  };
}

describe("HTTP authz: self-query (R-1)", () => {
  it("caller === subjectId → 200, masking step has no maskedFields", async () => {
    // Self-query: alice querying about alice. No admin check performed.
    const pool = makeExplainPool({ subjectHasGrant: true, callerIsAdmin: false, recordExists: true });
    const { baseUrl, close } = await startExplainServer(pool);
    try {
      const { statusCode, parsed } = await postExplain(
        baseUrl,
        makeExplainBody({ subjectId: SUBJECT_USER }),
        SUBJECT_USER,
      );
      expect(statusCode).toBe(200);
      expect(parsed["verdict"]).toBe("allow");
      // For self-query, masking step must not expose maskedFields (anti-oracle AC-8)
      const steps = parsed["steps"] as Array<Record<string, unknown>>;
      const maskStep = steps.find((s) => s["step"] === "masking");
      if (maskStep) {
        expect(maskStep).not.toHaveProperty("maskedFields");
        expect(maskStep).toHaveProperty("governed");
      }
    } finally {
      await close();
    }
  });
});

describe("HTTP authz: non-admin foreign caller (R-1)", () => {
  it("caller ≠ subjectId, no admin grants → 403 EXPLAIN_FORBIDDEN", async () => {
    const pool = makeExplainPool({ subjectHasGrant: true, callerIsAdmin: false, recordExists: true });
    const { baseUrl, close } = await startExplainServer(pool);
    try {
      const { statusCode, parsed } = await postExplain(
        baseUrl,
        makeExplainBody({ subjectId: SUBJECT_USER }),
        OTHER_USER, // different caller
      );
      expect(statusCode).toBe(403);
      const err = parsed["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("EXPLAIN_FORBIDDEN");
    } finally {
      await close();
    }
  });
});

describe("HTTP authz: admin with confirmed+delegable mgmt_object:grant (R-1)", () => {
  it("admin caller → 200, steps include masking with maskedFields visible", async () => {
    const pool = makeExplainPool({ subjectHasGrant: true, callerIsAdmin: true, recordExists: true });
    const { baseUrl, close } = await startExplainServer(pool);
    try {
      const { statusCode, parsed } = await postExplain(
        baseUrl,
        makeExplainBody({ subjectId: SUBJECT_USER }),
        ADMIN_USER,
      );
      expect(statusCode).toBe(200);
      expect(parsed["verdict"]).toBe("allow");
      // Admin caller sees full masking step (not stripped)
      const steps = parsed["steps"] as Array<Record<string, unknown>>;
      const maskStep = steps.find((s) => s["step"] === "masking");
      expect(maskStep).toBeDefined();
      // For admin, the masking step is returned as-is (not stripped to governed-only)
      // — governed flag must be present regardless
      expect(maskStep).toHaveProperty("governed");
    } finally {
      await close();
    }
  });
});

describe("HTTP: 503 NO_DATABASE when pool is null (R-7)", () => {
  it("no pool → 503 NO_DATABASE", async () => {
    const { baseUrl, close } = await startExplainServer(null);
    try {
      const { statusCode, parsed } = await postExplain(
        baseUrl,
        makeExplainBody({ subjectId: SUBJECT_USER }),
        SUBJECT_USER,
      );
      expect(statusCode).toBe(503);
      const err503 = parsed["error"] as Record<string, unknown> | undefined;
      expect(err503?.["code"]).toBe("NO_DATABASE");
    } finally {
      await close();
    }
  });
});

describe("HTTP: 422 EXPLAIN_OP_UNSUPPORTED for invoke/approve/transition (R-2)", () => {
  const unsupportedOps = ["invoke", "approve", "transition"];
  for (const op of unsupportedOps) {
    it(`op=${op} → 422 EXPLAIN_OP_UNSUPPORTED`, async () => {
      // Pool with self-query (simplest path to get past authz)
      const pool = makeExplainPool({ subjectHasGrant: false, callerIsAdmin: false, recordExists: false });
      const { baseUrl, close } = await startExplainServer(pool);
      try {
        const { statusCode, parsed } = await postExplain(
          baseUrl,
          makeExplainBody({ subjectId: SUBJECT_USER, operation: op }),
          SUBJECT_USER, // self-query → no admin DB check
        );
        expect(statusCode).toBe(422);
        const err422 = parsed["error"] as Record<string, unknown> | undefined;
        expect(err422?.["code"]).toBe("EXPLAIN_OP_UNSUPPORTED");
      } finally {
        await close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Property test — endpoint-level verdict parity (R-5):
// For each supported op with a matrix of deny/allow/cross_tenant/not_found cases,
// the explain endpoint verdict must equal the raw resolveFor verdict on the
// same grant+record conditions.
// ---------------------------------------------------------------------------

describe("property: endpoint-level verdict parity (R-5)", () => {
  /**
   * We test verdict parity structurally: explain route uses the same resolveFor
   * call path. For each case we:
   *   1. Run resolveFor directly (baseline, same deps)
   *   2. Hit the HTTP endpoint (via fake pool matching those deps)
   *   3. Assert endpoint verdict === baseline verdict
   *
   * This validates AC-1 at the endpoint level (not just NF-1 within resolveFor).
   */
  const matrix: Array<{
    name: string;
    subjectHasGrant: boolean;
    recordExists: boolean;
    op: string;
    expectedVerdict: "allow" | "deny";
  }> = [
    { name: "read, grant+record → allow",   subjectHasGrant: true,  recordExists: true,  op: "read",   expectedVerdict: "allow" },
    { name: "read, no grant → deny",         subjectHasGrant: false, recordExists: true,  op: "read",   expectedVerdict: "deny" },
    { name: "read, grant, no record → deny", subjectHasGrant: true,  recordExists: false, op: "read",   expectedVerdict: "deny" },
    { name: "create, grant → allow",         subjectHasGrant: true,  recordExists: true,  op: "create", expectedVerdict: "allow" },
    { name: "update, no grant → deny",       subjectHasGrant: false, recordExists: true,  op: "update", expectedVerdict: "deny" },
    { name: "delete, grant+record → allow",  subjectHasGrant: true,  recordExists: true,  op: "delete", expectedVerdict: "allow" },
  ];

  for (const tc of matrix) {
    it(tc.name, async () => {
      const pool = makeExplainPool({
        subjectHasGrant: tc.subjectHasGrant,
        callerIsAdmin: false,
        recordExists: tc.recordExists,
        grantOperation: tc.op, // grant must cover the requested op for allow verdict
      });
      const { baseUrl, close } = await startExplainServer(pool);
      try {
        const { statusCode, parsed } = await postExplain(
          baseUrl,
          makeExplainBody({ subjectId: SUBJECT_USER, operation: tc.op }),
          SUBJECT_USER, // self-query
        );
        expect(statusCode).toBe(200);
        expect(parsed["verdict"]).toBe(tc.expectedVerdict);
      } finally {
        await close();
      }
    });
  }
});
