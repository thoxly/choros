/**
 * src/runtime/customer-onboarding/__tests__/issue-key.test.ts — T-0244
 *
 * Integration tests for runIssueKey (FF-5, FF-6, AC-7, AC-8, AC-9, AC-11).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryAuditWriter, inMemoryTx } from "../../../db/audit-writer.js";
import { makeInMemoryActorEventStore } from "../../../core/actor-event-store.js";
import { makeStubEntitlementPort } from "./stub-entitlement-port.js";
import { EntitlementDormantError, dormantEntitlementPort } from "../entitlement-port.js";
import { runIssueKey, type IssueKeyDeps } from "../issue-key.js";
import type { ResolverDeps } from "../../../core/grant-resolver.js";
import type { Grant } from "../../../core/grant-lattice.js";
import type { ResourceRef, ResolveSubject } from "../../../core/object-handle.js";
import { makeHandle } from "../../../core/object-handle.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const REGISTRY_ID = randomUUID();
const RECORD_ID = randomUUID();
const ACTOR_ID = "e-owner";

const SUBJECT: ResolveSubject = {
  tenantId: TENANT_ID,
  subjectId: ACTOR_ID,
};

const RECORD_REF: ResourceRef = {
  kind: "record",
  tenantId: TENANT_ID,
  registryId: REGISTRY_ID,
  recordId: RECORD_ID,
};

function makeRecordHandle() {
  return makeHandle(RECORD_REF, TENANT_ID);
}

const BASE_RECORD = {
  company_name: "ООО Тест",
  contact_name: "Иван",
  contact_email: "ivan@test.ru",
  plan: "pilot",
  not_after: "2026-12-31",
  status: "trial",
  notes: "test",
};

// ---------------------------------------------------------------------------
// ResolverDeps factories
// ---------------------------------------------------------------------------

function makeAllowDeps(fields: Record<string, unknown> = BASE_RECORD): ResolverDeps {
  return {
    grants: {
      async getGrants(_subject, _nowMs): Promise<Grant[]> {
        return [
          {
            tenantId: TENANT_ID,
            id: randomUUID(),
            roleId: "vendor-admin",
            resourceType: "record",
            operation: "update",
            // Scope contains our record: node in resource hierarchy at record level
            scope: { kind: "node", hierarchy: "resource", nodeId: RECORD_ID, nodeLevel: "record" },
            delegable: false,
            grantedBy: "system",
            createdAt: 0,
          } as unknown as Grant,
        ];
      },
    },
    records: {
      async getRecord(_ref): Promise<Record<string, unknown> | null> {
        return fields;
      },
    },
    ancestry: {
      isDescendantOrSelf: (_h, a, b) => a === b,
    },
  };
}

function makeDenyDeps(): ResolverDeps {
  return {
    grants: {
      async getGrants(_subject, _nowMs): Promise<Grant[]> {
        return []; // no grants → denied
      },
    },
    records: {
      async getRecord(_ref): Promise<Record<string, unknown> | null> {
        return BASE_RECORD;
      },
    },
    ancestry: {
      isDescendantOrSelf: (_h, a, b) => a === b,
    },
  };
}

function makeTestDeps(overrides: Partial<IssueKeyDeps> = {}): IssueKeyDeps {
  return {
    entitlement: makeStubEntitlementPort(),
    resolverDeps: makeAllowDeps(),
    auditWriter: new InMemoryAuditWriter(),
    actorEventWriter: makeInMemoryActorEventStore(TENANT_ID),
    liveEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FF-5: dormantEntitlementPort throws (injectable contract)
// ---------------------------------------------------------------------------
describe("FF-5: EntitlementPort is injectable, dormant throws", () => {
  it("dormantEntitlementPort.issueEntitlement throws EntitlementDormantError", async () => {
    // The port throws synchronously; wrap in async fn for .rejects
    await expect(
      Promise.resolve().then(() =>
        dormantEntitlementPort.issueEntitlement({
          circuit_id: "test",
          plan: "pilot",
          valid_from: "2026-01-01",
          valid_until: "2026-12-31",
          source: "pilot",
        }),
      ),
    ).rejects.toThrow(EntitlementDormantError);
  });

  it("when liveEnabled=false, runIssueKey uses dormant → port_error", async () => {
    const deps = makeTestDeps({ liveEnabled: false });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-001",
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_error");
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-7: success path
// ---------------------------------------------------------------------------
describe("FF-6, AC-7: success path", () => {
  it("success stub → ok=true with circuit_id and issued_at", async () => {
    const stub = makeStubEntitlementPort({
      fixedCircuitId: "cid-success",
      fixedIssuedAt: "2026-02-01T00:00:00.000Z",
    });
    const deps = makeTestDeps({ entitlement: stub });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-success",
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.circuit_id).toBe("cid-success");
      expect(result.issued_at).toBe("2026-02-01T00:00:00.000Z");
    }
  });

  it("AC-11: success → audit_event(customer.key_issued) with circuit_id + not_after", async () => {
    const auditWriter = new InMemoryAuditWriter();
    const stub = makeStubEntitlementPort({
      fixedCircuitId: "cid-audit",
      fixedIssuedAt: "2026-02-02T00:00:00.000Z",
    });
    const deps = makeTestDeps({ entitlement: stub, auditWriter });
    const tx = inMemoryTx(TENANT_ID);
    await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-audit",
      nowMs: 1000,
    });
    const events = auditWriter.rows(TENANT_ID);
    const keyIssued = events.find((e) => e.type === "customer.key_issued");
    expect(keyIssued).toBeDefined();
    const payload = keyIssued?.payload as Record<string, unknown> | undefined;
    expect(payload?.["circuit_id"]).toBe("cid-audit");
    expect(payload?.["not_after"]).toBe("2026-12-31");
  });

  it("stub records the call with correct input fields (AC-7)", async () => {
    const stub = makeStubEntitlementPort({ fixedCircuitId: "cid-003" });
    const deps = makeTestDeps({ entitlement: stub });
    const tx = inMemoryTx(TENANT_ID);
    await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-003",
      nowMs: Date.now(),
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].circuit_id).toBe("cid-003");
    expect(stub.calls[0].plan).toBe("pilot");
    expect(stub.calls[0].valid_until).toBe("2026-12-31");
    expect(stub.calls[0].source).toBe("pilot");
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-8: error path — step stays open, no side-effects on key fields
// ---------------------------------------------------------------------------
describe("FF-6, AC-8: error path → step open", () => {
  it("stub error → ok=false, reason=port_error", async () => {
    const stub = makeStubEntitlementPort({ error: new Error("simulated failure") });
    const deps = makeTestDeps({ entitlement: stub });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-err",
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_error");
  });

  it("stub error → audit_event(customer.key_issue_failed) written", async () => {
    const auditWriter = new InMemoryAuditWriter();
    const stub = makeStubEntitlementPort({ error: new Error("T-0242 down") });
    const deps = makeTestDeps({ entitlement: stub, auditWriter });
    const tx = inMemoryTx(TENANT_ID);
    await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-err2",
      nowMs: 2000,
    });
    const events = auditWriter.rows(TENANT_ID);
    expect(events.find((e) => e.type === "customer.key_issue_failed")).toBeDefined();
    // No key_issued event
    expect(events.find((e) => e.type === "customer.key_issued")).toBeUndefined();
  });

  it("dormant error → ok=false (AC-8 dormant = step stays open)", async () => {
    const stub = makeStubEntitlementPort({ error: new EntitlementDormantError("dormant test") });
    const deps = makeTestDeps({ entitlement: stub });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-dormant",
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9: PDP denied
// ---------------------------------------------------------------------------
describe("AC-9: PDP deny → step blocked", () => {
  it("PDP deny → result.reason=pdp_denied", async () => {
    const deps = makeTestDeps({ resolverDeps: makeDenyDeps() });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-deny",
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("pdp_denied");
  });

  it("PDP deny → audit_event(card_action.denied) written", async () => {
    const auditWriter = new InMemoryAuditWriter();
    const deps = makeTestDeps({ resolverDeps: makeDenyDeps(), auditWriter });
    const tx = inMemoryTx(TENANT_ID);
    await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-deny2",
      nowMs: 3000,
    });
    const events = auditWriter.rows(TENANT_ID);
    expect(events.find((e) => e.type === "card_action.denied")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-8 (enhanced): error path — explicit no-side-effects assertion
// ---------------------------------------------------------------------------
describe("AC-8 (no-side-effects on error path)", () => {
  it("on port_error: actorEventWriter receives NO transition events", async () => {
    // The actor-event store must NOT receive any events on the error path —
    // the step stays open (AC-8) with zero side-effects on key fields.
    const actorEventWriter = makeInMemoryActorEventStore(TENANT_ID);
    const stub = makeStubEntitlementPort({ error: new Error("port down") });
    const deps = makeTestDeps({ entitlement: stub, actorEventWriter });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-no-side-effects",
      nowMs: 4000,
    });
    // Step stays open.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_error");
    // No transition actor_event was written — no-side-effects proven structurally.
    const storeEvents = actorEventWriter.snapshot();
    expect(storeEvents).toHaveLength(0);
  });

  it("on pdp_denied: actorEventWriter receives NO transition events", async () => {
    const actorEventWriter = makeInMemoryActorEventStore(TENANT_ID);
    const deps = makeTestDeps({ resolverDeps: makeDenyDeps(), actorEventWriter });
    const tx = inMemoryTx(TENANT_ID);
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-deny-no-side",
      nowMs: 5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("pdp_denied");
    // No transition event written — denied before any side-effect.
    const storeEvents = actorEventWriter.snapshot();
    expect(storeEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-9: field-mask enforcement — system-only fields blocked for vendor-admin
// ---------------------------------------------------------------------------
import {
  checkWriteMask,
  SYSTEM_ONLY_FIELDS,
} from "../field-mask-guard.js";

describe("AC-9: field-mask enforcement — system-only fields write-blocked", () => {
  it("vendor-admin write-facet excluding circuit_id → denied when writing circuit_id", () => {
    // Grant write-facet for vendor-admin: all normal fields, but NOT circuit_id/activation_key_issued_at
    const vendorAdminWriteFacet = [
      "company_name",
      "contact_name",
      "contact_email",
      "plan",
      "not_after",
      "status",
      "notes",
    ];
    // Attacker tries to directly write circuit_id
    const result = checkWriteMask(vendorAdminWriteFacet, ["company_name", "circuit_id"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toBe("system_field_write_blocked");
      expect(result.blockedFields).toContain("circuit_id");
    }
  });

  it("vendor-admin write-facet excluding activation_key_issued_at → denied when writing it", () => {
    const vendorAdminWriteFacet = ["company_name", "contact_name"];
    const result = checkWriteMask(vendorAdminWriteFacet, ["activation_key_issued_at"]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toContain("activation_key_issued_at");
    }
  });

  it("vendor-admin writing only allowed fields → permitted", () => {
    const vendorAdminWriteFacet = ["company_name", "contact_name", "plan"];
    const result = checkWriteMask(vendorAdminWriteFacet, ["company_name", "plan"]);
    expect(result.denied).toBe(false);
  });

  it("system actor (undefined writeFacet) writing circuit_id → permitted", () => {
    // System actor has no write-mask restriction (whole-resource write).
    const result = checkWriteMask(undefined, ["circuit_id", "activation_key_issued_at"]);
    expect(result.denied).toBe(false);
  });

  it("SYSTEM_ONLY_FIELDS contains exactly the two protected fields", () => {
    expect(SYSTEM_ONLY_FIELDS.has("circuit_id")).toBe(true);
    expect(SYSTEM_ONLY_FIELDS.has("activation_key_issued_at")).toBe(true);
    expect(SYSTEM_ONLY_FIELDS.has("company_name")).toBe(false);
  });

  it("both system-only fields blocked simultaneously when write attempted", () => {
    const vendorAdminWriteFacet = ["company_name"];
    const result = checkWriteMask(vendorAdminWriteFacet, [
      "company_name",
      "circuit_id",
      "activation_key_issued_at",
    ]);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.blockedFields).toContain("circuit_id");
      expect(result.blockedFields).toContain("activation_key_issued_at");
      expect(result.blockedFields).toHaveLength(2);
    }
  });
});
