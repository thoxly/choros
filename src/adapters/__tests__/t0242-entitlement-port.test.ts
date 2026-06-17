/**
 * src/adapters/__tests__/t0242-entitlement-port.test.ts — T-0246 B-3
 *
 * Unit + round-trip tests for T0242EntitlementPort live adapter.
 * Covers AC-1..AC-7 / FF-1..FF-6.
 *
 * Design:
 *  - Uses InMemoryLicenseStore (no filesystem, no DB, no network).
 *  - Generates a throwaway Ed25519 keypair in-test (no committed private key).
 *  - Uses REAL verifyKey from activation.ts for round-trip test (FF-4 / AC-5).
 *  - Imports verifyKey IN THE TEST ONLY — the adapter itself never imports activation.ts
 *    (no-killswitch-in-crm.sh FF-7(1) covers the adapter file, not this test file).
 *
 * NOTE: verifyKey is imported here for round-trip proof only. The adapter itself
 * does NOT import activation.ts — no-killswitch-in-crm.sh verifies this separately.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { InMemoryLicenseStore } from "../../vendor/file-license-store.js";
import { verifyKey } from "../../vendor/activation.js";
import { T0242EntitlementPort } from "../t0242-entitlement-port.js";
import {
  dormantEntitlementPort,
  type IssueEntitlementInput,
} from "../../runtime/customer-onboarding/entitlement-port.js";
import { inMemoryTx, InMemoryAuditWriter } from "../../db/audit-writer.js";
import { makeInMemoryActorEventStore } from "../../core/actor-event-store.js";
import { runIssueKey, type IssueKeyDeps } from "../../runtime/customer-onboarding/issue-key.js";
import type { Grant } from "../../core/grant-lattice.js";
import type { ResourceRef, ResolveSubject } from "../../core/object-handle.js";
import { makeHandle } from "../../core/object-handle.js";
import { randomUUID } from "node:crypto";
import type { ResolverDeps } from "../../core/grant-resolver.js";

// ---------------------------------------------------------------------------
// Keypair + timing helpers
// ---------------------------------------------------------------------------

function makeKeypair(): { privatePem: Buffer; publicPem: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = Buffer.from(
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    "utf8",
  );
  const publicPem = Buffer.from(
    publicKey.export({ type: "spki", format: "pem" }) as string,
    "utf8",
  );
  return { privatePem, publicPem };
}

const NOW = new Date("2026-06-17T00:00:00Z");
const VALID_FROM = NOW.toISOString();
const VALID_UNTIL = "2027-06-17T00:00:00.000Z";
const MID = new Date("2026-12-01T00:00:00Z"); // in-term for round-trip

function baseInput(overrides: Partial<IssueEntitlementInput> = {}): IssueEntitlementInput {
  return {
    circuit_id: "cid-test-001",
    plan: "pilot",
    valid_from: VALID_FROM,
    valid_until: VALID_UNTIL,
    source: "pilot",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FF-1 / AC-1: issueEntitlement calls vendor + returns {circuit_id, issued_at}
// ---------------------------------------------------------------------------

describe("FF-1 / AC-1: live adapter calls vendor issueEntitlement+signKey", () => {
  it("returns {circuit_id, issued_at} without throwing", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    const result = await adapter.issueEntitlement(baseInput());

    expect(result.circuit_id).toBe("cid-test-001");
    expect(typeof result.issued_at).toBe("string");
    expect(result.issued_at).toBe(NOW.toISOString());
  });

  it("record is persisted in store after call", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    await adapter.issueEntitlement(baseInput({ circuit_id: "cid-persist-001" }));

    const rec = store.getByCircuit("cid-persist-001");
    expect(rec).not.toBeNull();
    expect(rec?.status).toBe("active");
    expect(rec?.plan.tier).toBe("pilot");
  });

  it("plan='pro' maps to PRO_PLAN (agentic_ops=true)", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    await adapter.issueEntitlement(baseInput({ plan: "pro", circuit_id: "cid-pro" }));

    const rec = store.getByCircuit("cid-pro");
    expect(rec?.plan.tier).toBe("pro");
    expect(rec?.plan.entitlements.agentic_ops).toBe(true);
  });

  it("unknown plan maps to PILOT_PLAN (fail-safe)", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    await adapter.issueEntitlement(baseInput({ plan: "unknown-tier", circuit_id: "cid-unknown" }));

    const rec = store.getByCircuit("cid-unknown");
    expect(rec?.plan.tier).toBe("pilot");
  });

  it("unknown source maps to 'pilot' (fail-closed)", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    await adapter.issueEntitlement(baseInput({ source: "bad-source", circuit_id: "cid-src" }));

    const rec = store.getByCircuit("cid-src");
    expect(rec?.source).toBe("pilot");
  });
});

// ---------------------------------------------------------------------------
// FF-2 / AC-2: env-gate via runIssueKey + makeEntitlementWiring
// ---------------------------------------------------------------------------

describe("FF-2 / AC-2: env-gate — dormant vs live in runIssueKey", () => {
  const TENANT_ID = "b0000000-0000-0000-0000-000000000002";
  const REGISTRY_ID = randomUUID();
  const RECORD_ID = randomUUID();

  const BASE_RECORD = {
    company_name: "ООО Гейт-тест",
    contact_name: "Гейт",
    contact_email: "gate@test.ru",
    plan: "pilot",
    not_after: VALID_UNTIL,
    status: "trial",
  };

  function makeAllowDeps(record = BASE_RECORD): ResolverDeps {
    return {
      grants: {
        async getGrants(): Promise<Grant[]> {
          return [
            {
              tenantId: TENANT_ID,
              id: randomUUID(),
              roleId: "vendor-admin",
              resourceType: "record",
              operation: "update",
              scope: {
                kind: "node",
                hierarchy: "resource",
                nodeId: RECORD_ID,
                nodeLevel: "record",
              },
              delegable: false,
              grantedBy: "system",
              createdAt: 0,
            } as unknown as Grant,
          ];
        },
      },
      records: {
        async getRecord(): Promise<Record<string, unknown> | null> {
          return record;
        },
      },
      ancestry: { isDescendantOrSelf: (_h: string, a: string, b: string) => a === b },
    };
  }

  function makeRecordHandle() {
    const ref: ResourceRef = {
      kind: "record",
      tenantId: TENANT_ID,
      registryId: REGISTRY_ID,
      recordId: RECORD_ID,
    };
    return makeHandle(ref, TENANT_ID);
  }

  const SUBJECT: ResolveSubject = { tenantId: TENANT_ID, subjectId: "e-vendor-admin" };

  it("liveEnabled=false → runIssueKey uses dormant → {ok:false, reason:'port_error'}", async () => {
    const tx = inMemoryTx(TENANT_ID);
    const deps: IssueKeyDeps = {
      entitlement: dormantEntitlementPort,
      resolverDeps: makeAllowDeps(),
      auditWriter: new InMemoryAuditWriter(),
      actorEventWriter: makeInMemoryActorEventStore(TENANT_ID),
      liveEnabled: false,
    };
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-dormant",
      nowMs: NOW.getTime(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_error");
  });

  it("liveEnabled=true + live adapter → {ok:true}", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    const tx = inMemoryTx(TENANT_ID);
    const deps: IssueKeyDeps = {
      entitlement: adapter,
      resolverDeps: makeAllowDeps(),
      auditWriter: new InMemoryAuditWriter(),
      actorEventWriter: makeInMemoryActorEventStore(TENANT_ID),
      liveEnabled: true,
    };
    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle: makeRecordHandle(),
      subject: SUBJECT,
      circuitId: "cid-live",
      nowMs: NOW.getTime(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.circuit_id).toBe("cid-live");
      expect(typeof result.issued_at).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// FF-3 / AC-4: idempotent by circuit_id
// ---------------------------------------------------------------------------

describe("FF-3 / AC-4: idempotent by circuit_id", () => {
  it("repeat call preserves issued_at", async () => {
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });

    const input = baseInput({ circuit_id: "cid-idempotent" });
    const first = await adapter.issueEntitlement(input);

    // Second call with a different "now" — issued_at must stay the same.
    const LATER = new Date("2026-07-01T00:00:00Z");
    const adapter2 = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => LATER });
    const second = await adapter2.issueEntitlement(input);

    expect(second.issued_at).toBe(first.issued_at);
    expect(second.circuit_id).toBe(first.circuit_id);
  });
});

// ---------------------------------------------------------------------------
// FF-4 / AC-5: round-trip — signKey → verifyKey returns 'active'
// ---------------------------------------------------------------------------

describe("FF-4 / AC-5: round-trip signKey → verifyKey", () => {
  it("wire string verifies as active in-term", async () => {
    const { privatePem, publicPem } = makeKeypair();
    const store = new InMemoryLicenseStore();

    // Issue via adapter (this calls signKey internally).
    const adapter = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });
    await adapter.issueEntitlement(baseInput({ circuit_id: "cid-roundtrip" }));

    // Get the stored record and sign again to get the wire string for verification.
    // (The adapter does not return the wire string — it's B-11 boundary.)
    // We re-sign here in the test to prove the key is verifiable.
    const { signKey } = await import("../../vendor/issuance.js");
    const rec = store.getByCircuit("cid-roundtrip");
    expect(rec).not.toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const wire = signKey(rec!, privatePem, MID);
    const status = verifyKey(wire, publicPem, MID);

    expect(status.state).toBe("active");
    expect(status.circuit_id).toBe("cid-roundtrip");
  });
});

// ---------------------------------------------------------------------------
// FF-5 / AC-6: bad PEM → adapter throws → runIssueKey {ok:false, reason:'port_error'}
// ---------------------------------------------------------------------------

describe("FF-5 / AC-6: bad PEM → adapter throws → port_error", () => {
  it("invalid PEM causes issueEntitlement to throw", async () => {
    const store = new InMemoryLicenseStore();
    const adapter = new T0242EntitlementPort({
      store,
      privKeyPem: "THIS IS NOT A VALID PEM",
      now: () => NOW,
    });

    await expect(adapter.issueEntitlement(baseInput({ circuit_id: "cid-badpem" }))).rejects.toThrow();
  });

  it("bad PEM → runIssueKey returns {ok:false, reason:'port_error'} + writes key_issue_failed audit", async () => {
    const TENANT_ID = "c0000000-0000-0000-0000-000000000003";
    const REGISTRY_ID = randomUUID();
    const RECORD_ID = randomUUID();

    const ref: ResourceRef = {
      kind: "record",
      tenantId: TENANT_ID,
      registryId: REGISTRY_ID,
      recordId: RECORD_ID,
    };
    const recordHandle = makeHandle(ref, TENANT_ID);
    const subject: ResolveSubject = { tenantId: TENANT_ID, subjectId: "e-vendor-admin" };

    const resolverDeps: ResolverDeps = {
      grants: {
        async getGrants(): Promise<Grant[]> {
          return [
            {
              tenantId: TENANT_ID,
              id: randomUUID(),
              roleId: "vendor-admin",
              resourceType: "record",
              operation: "update",
              scope: {
                kind: "node",
                hierarchy: "resource",
                nodeId: RECORD_ID,
                nodeLevel: "record",
              },
              delegable: false,
              grantedBy: "system",
              createdAt: 0,
            } as unknown as Grant,
          ];
        },
      },
      records: {
        async getRecord(): Promise<Record<string, unknown> | null> {
          return {
            company_name: "Bad PEM Co",
            contact_name: "Bad",
            contact_email: "bad@pem.ru",
            plan: "pilot",
            not_after: VALID_UNTIL,
            status: "trial",
          };
        },
      },
      ancestry: { isDescendantOrSelf: (_h: string, a: string, b: string) => a === b },
    };

    const store = new InMemoryLicenseStore();
    const badAdapter = new T0242EntitlementPort({
      store,
      privKeyPem: "INVALID PEM DATA",
      now: () => NOW,
    });

    const auditWriter = new InMemoryAuditWriter();
    const tx = inMemoryTx(TENANT_ID);

    const deps: IssueKeyDeps = {
      entitlement: badAdapter,
      resolverDeps,
      auditWriter,
      actorEventWriter: makeInMemoryActorEventStore(TENANT_ID),
      liveEnabled: true,
    };

    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle,
      subject,
      circuitId: "cid-badpem-run",
      nowMs: NOW.getTime(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("port_error");

    // Audit event written, no actor_event.
    const auditRows = auditWriter.rows(TENANT_ID);
    const failEvent = auditRows.find((r) => r.type === "customer.key_issue_failed");
    expect(failEvent).toBeDefined();
    // No actor_event should be in the store (transition not committed).
    // (actor_event store tracks events separately; we just verify audit was written)
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-7: success → audit_event(customer.key_issued) written
// ---------------------------------------------------------------------------

describe("FF-6 / AC-7: success → customer.key_issued audit event", () => {
  it("successful issueEntitlement → audit_event type='customer.key_issued' with circuit_id", async () => {
    const { privatePem } = makeKeypair();
    const TENANT_ID = "d0000000-0000-0000-0000-000000000004";
    const REGISTRY_ID = randomUUID();
    const RECORD_ID = randomUUID();

    const ref: ResourceRef = {
      kind: "record",
      tenantId: TENANT_ID,
      registryId: REGISTRY_ID,
      recordId: RECORD_ID,
    };
    const recordHandle = makeHandle(ref, TENANT_ID);
    const subject: ResolveSubject = { tenantId: TENANT_ID, subjectId: "e-vendor-admin-ok" };

    const resolverDeps: ResolverDeps = {
      grants: {
        async getGrants(): Promise<Grant[]> {
          return [
            {
              tenantId: TENANT_ID,
              id: randomUUID(),
              roleId: "vendor-admin",
              resourceType: "record",
              operation: "update",
              scope: {
                kind: "node",
                hierarchy: "resource",
                nodeId: RECORD_ID,
                nodeLevel: "record",
              },
              delegable: false,
              grantedBy: "system",
              createdAt: 0,
            } as unknown as Grant,
          ];
        },
      },
      records: {
        async getRecord(): Promise<Record<string, unknown> | null> {
          return {
            company_name: "ООО Успех",
            contact_name: "Успех",
            contact_email: "ok@success.ru",
            plan: "pilot",
            not_after: VALID_UNTIL,
            status: "trial",
          };
        },
      },
      ancestry: { isDescendantOrSelf: (_h: string, a: string, b: string) => a === b },
    };

    const store = new InMemoryLicenseStore();
    const liveAdapter = new T0242EntitlementPort({
      store,
      privKeyPem: privatePem,
      now: () => NOW,
    });

    const auditWriter = new InMemoryAuditWriter();
    const tx = inMemoryTx(TENANT_ID);

    const deps: IssueKeyDeps = {
      entitlement: liveAdapter,
      resolverDeps,
      auditWriter,
      actorEventWriter: makeInMemoryActorEventStore(TENANT_ID),
      liveEnabled: true,
    };

    const result = await runIssueKey(tx, deps, {
      tenantId: TENANT_ID,
      recordHandle,
      subject,
      circuitId: "cid-success-audit",
      nowMs: NOW.getTime(),
    });

    expect(result.ok).toBe(true);

    const auditRows = auditWriter.rows(TENANT_ID);
    const keyIssuedEvent = auditRows.find((r) => r.type === "customer.key_issued");
    expect(keyIssuedEvent).toBeDefined();
    expect((keyIssuedEvent?.payload as Record<string, unknown>)?.["circuit_id"]).toBe(
      "cid-success-audit",
    );
    expect((keyIssuedEvent?.payload as Record<string, unknown>)?.["not_after"]).toBe(VALID_UNTIL);
  });
});
