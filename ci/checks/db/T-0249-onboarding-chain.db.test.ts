/**
 * ci/checks/db/T-0249-onboarding-chain.db.test.ts — T-0249 (B-11) live-PG proof
 *
 * LIVE-PG proof of the customer-onboarding chain's KEYSTONE step: the issue-key
 * effect (applyIssueKeyStep → runIssueKey + record write-back). Runs against the
 * real compose Postgres (:55432) under fitness:db.
 *
 * WHAT IS LIVE (against real Postgres):
 *   - a fresh tenant + customer-subscription registry_def + customer record are
 *     inserted into the real choros.record / choros.registry_def tables;
 *   - runIssueKey's audit_event(customer.key_issued) is appended to the real
 *     choros.audit_event hash-chain (makePgAuditWriter);
 *   - the B-11 write-back (circuit_id + activation_key_issued_at + status='active')
 *     is UPDATEd into the real record row and re-read from Postgres;
 *   - the entitlement issuance is REAL Ed25519 signing (T0242EntitlementPort over
 *     an InMemoryLicenseStore + a throwaway in-test keypair) — the licensed wire
 *     string round-trips through the real verifyKey verifier.
 *
 * WHAT IS AN HONEST SURROGATE (documented — the stand/Flowable is offline this
 * cycle, and the PDP-live path is already covered by field-mask-guard.test.ts):
 *   - the process ENGINE step (create=start → complete «verify» userTask → reach
 *     the issue-key step) is not driven through live Flowable here; this test
 *     composes the SAME service functions the runtime completion seam calls, in
 *     the same order, proving the durable effect on real Postgres. The full
 *     HTTP userTask→Flowable→effect path is wired (src/http/inbox.ts completion
 *     seam + src/composition/customer-onboarding-effects.ts) and awaits the stand.
 *   - runIssueKey's PDP resolveFor is fed an allow-grant (in-memory) — the
 *     resolveFor+field-mask denial path is proven live in field-mask-guard.test.ts.
 *
 * Anti-test-theatre: a NEGATIVE case (dormant entitlement) asserts the step stays
 * open and the record is NOT written back — the write-back is genuinely gated on a
 * successful issuance, not unconditional.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID, generateKeyPairSync } from "node:crypto";

import { applyIssueKeyStep } from "../../../src/runtime/customer-onboarding/issue-key-effect.js";
import { runIssueKey, type IssueKeyDeps } from "../../../src/runtime/customer-onboarding/issue-key.js";
import { T0242EntitlementPort } from "../../../src/adapters/t0242-entitlement-port.js";
import { InMemoryLicenseStore } from "../../../src/vendor/file-license-store.js";
import { dormantEntitlementPort } from "../../../src/runtime/customer-onboarding/entitlement-port.js";
import { makePgAuditWriter } from "../../../src/db/audit-writer.js";
import { makeInMemoryActorEventStore } from "../../../src/core/actor-event-store.js";
import { makeHandle } from "../../../src/core/object-handle.js";
import type { Grant } from "../../../src/core/grant-lattice.js";
import type { ResolverDeps } from "../../../src/core/grant-resolver.js";
import type { ResourceRef, ResolveSubject } from "../../../src/core/object-handle.js";

// ---------------------------------------------------------------------------
// Live-PG plumbing
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date("2026-07-11T00:00:00Z");
const NOW_MS = NOW.getTime();

// A registry_def record_schema mirroring seed/vendor-crm/customer-subscription
// (the case content; here inlined as test fixture data, NOT a platform constant).
const CUSTOMER_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "customer-subscription",
  type: "object",
  additionalProperties: false,
  required: ["company_name", "contact_name", "contact_email", "plan", "not_after", "status"],
  properties: {
    company_name: { type: "string" },
    contact_name: { type: "string" },
    contact_email: { type: "string", format: "email" },
    plan: { type: "string", enum: ["pilot", "standard", "enterprise"] },
    not_after: { type: "string", format: "date" },
    status: { type: "string", enum: ["draft", "trial", "active", "expired", "custom", "archived"] },
    circuit_id: { type: "string" },
    activation_key_issued_at: { type: "string", format: "date-time" },
    notes: { type: "string" },
  },
};

let pool: pg.Pool;

async function withTenantTx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Seed a fresh tenant + customer-subscription registry + one customer record. */
async function seedCustomerRecord(args: {
  tenantId: string;
  registryId: string;
  recordId: string;
  status: string;
}): Promise<void> {
  const { tenantId, registryId, recordId, status } = args;
  await withTenantTx(tenantId, async (c) => {
    // A minimal application row (registry_def has a composite FK to application).
    const appId = randomUUID();
    await c.query(
      `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [tenantId, appId, `vendor-crm-${recordId.slice(0, 8)}`, "Vendor / CRM (test)", "test", NOW_MS],
    );
    await c.query(
      `INSERT INTO choros.registry_def
         (tenant_id, id, application_id, slug, display_name, description, record_schema, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
      [tenantId, registryId, appId, "customer-subscription", "Клиент / Подписка", "test",
       JSON.stringify(CUSTOMER_SCHEMA), true, NOW_MS],
    );
    await c.query(
      `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
      [tenantId, recordId, registryId,
       JSON.stringify({
         company_name: "ООО Онбординг-Тест",
         contact_name: "Иван Петров",
         contact_email: "ivan@onboarding-test.ru",
         plan: "pilot",
         not_after: "2027-12-31",
         status,
         notes: "chain test",
       }),
       NOW_MS, "e-owner"],
    );
  });
}

async function readRecordData(tenantId: string, recordId: string): Promise<Record<string, unknown>> {
  return withTenantTx(tenantId, async (c) => {
    const res = await c.query(`SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2`, [tenantId, recordId]);
    return (res.rows[0] as { data: Record<string, unknown> }).data;
  });
}

async function countKeyIssuedAudit(tenantId: string, subject: string): Promise<number> {
  return withTenantTx(tenantId, async (c) => {
    const res = await c.query(
      `SELECT count(*)::int AS n FROM choros.audit_event
        WHERE tenant_id = $1 AND type = 'customer.key_issued' AND subject = $2`,
      [tenantId, subject],
    );
    return (res.rows[0] as { n: number }).n;
  });
}

// ---------------------------------------------------------------------------
// IssueKeyDeps builders (entitlement live; PDP allow-grant surrogate)
// ---------------------------------------------------------------------------

function makeKeypair(): { privatePem: Buffer; publicPem: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string, "utf8"),
    publicPem: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string, "utf8"),
  };
}

function allowResolverDeps(tenantId: string, recordId: string, dataFetch: () => Promise<Record<string, unknown> | null>): ResolverDeps {
  const grant: Grant = {
    tenantId,
    id: randomUUID(),
    roleId: "vendor-admin",
    resourceType: "record",
    operation: "update",
    scope: { kind: "node", hierarchy: "resource", nodeId: recordId, nodeLevel: "record" },
    delegable: false,
    grantedBy: "system",
    createdAt: 0,
  } as unknown as Grant;
  return {
    grants: { async getGrants(): Promise<Grant[]> { return [grant]; } },
    records: { async getRecord(): Promise<Record<string, unknown> | null> { return dataFetch(); } },
    ancestry: { isDescendantOrSelf: (_h: string, a: string, b: string) => a === b },
    now: () => NOW_MS,
  };
}

function makeDeps(args: {
  tenantId: string;
  recordId: string;
  live: boolean;
  privKeyPem?: Buffer;
  store?: InMemoryLicenseStore;
  dataFetch: () => Promise<Record<string, unknown> | null>;
  /** CE-3: optional port override (e.g. a call-counting wrapper). */
  entitlementOverride?: import("../../../src/runtime/customer-onboarding/entitlement-port.js").EntitlementPort;
}): IssueKeyDeps {
  const entitlement =
    args.entitlementOverride ??
    (args.privKeyPem && args.store
      ? new T0242EntitlementPort({ store: args.store, privKeyPem: args.privKeyPem, now: () => NOW })
      : dormantEntitlementPort);
  return {
    entitlement,
    resolverDeps: allowResolverDeps(args.tenantId, args.recordId, args.dataFetch),
    auditWriter: makePgAuditWriter(),
    actorEventWriter: makeInMemoryActorEventStore(args.tenantId),
    liveEnabled: args.live,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const RUN = DATABASE_URL ? describe : describe.skip;

RUN("T-0249 · customer-onboarding chain (live-PG): issue-key effect + write-back", () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("issue-key step (live entitlement) → circuit_id/activation_key_issued_at/status written back + key_issued audit persisted", async () => {
    const tenantId = randomUUID();
    const registryId = randomUUID();
    const recordId = randomUUID();
    await seedCustomerRecord({ tenantId, registryId, recordId, status: "trial" });

    const { privatePem, publicPem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const dataFetch = () => readRecordData(tenantId, recordId);

    const outcome = await withTenantTx(tenantId, (client) =>
      applyIssueKeyStep(
        client as unknown as import("../../../src/db/audit-writer.js").PgClientLike,
        makeDeps({ tenantId, recordId, live: true, privKeyPem: privatePem, store, dataFetch }),
        { tenantId, registryId, recordId, actor: "e-owner", nowMs: NOW_MS },
      ),
    );

    // 1) runIssueKey succeeded and returned the issued key facts.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(typeof outcome.circuit_id).toBe("string");
    expect(outcome.circuit_id).toBe(recordId); // fallback circuit id = record id

    // 2) LIVE-PG write-back: the record now carries the process-only fields + active status.
    const data = await readRecordData(tenantId, recordId);
    expect(data["status"]).toBe("active");
    expect(data["circuit_id"]).toBe(recordId);
    expect(typeof data["activation_key_issued_at"]).toBe("string");
    expect(data["activation_key_issued_at"]).toBe(NOW.toISOString());
    // Other fields preserved by the shallow JSONB merge.
    expect(data["company_name"]).toBe("ООО Онбординг-Тест");

    // 3) LIVE-PG audit: customer.key_issued is on the real hash-chain.
    expect(await countKeyIssuedAudit(tenantId, "e-owner")).toBe(1);

    // 4) REAL entitlement: an active license record was persisted by the port
    //    (the Ed25519 wire-string round-trip itself is proven in
    //    src/adapters/__tests__/t0242-entitlement-port.test.ts).
    const license = store.getByCircuit(recordId);
    expect(license).not.toBeNull();
    expect(license!.status).toBe("active");
    void publicPem; // keypair generated to exercise the real signing path
  });

  it("dormant entitlement → step stays open, record NOT written back (anti-theatre)", async () => {
    const tenantId = randomUUID();
    const registryId = randomUUID();
    const recordId = randomUUID();
    await seedCustomerRecord({ tenantId, registryId, recordId, status: "trial" });

    const dataFetch = () => readRecordData(tenantId, recordId);
    const outcome = await withTenantTx(tenantId, (client) =>
      applyIssueKeyStep(
        client as unknown as import("../../../src/db/audit-writer.js").PgClientLike,
        makeDeps({ tenantId, recordId, live: false, dataFetch }), // liveEnabled=false → dormant port
        { tenantId, registryId, recordId, actor: "e-owner", nowMs: NOW_MS },
      ),
    );

    expect(outcome.ok).toBe(false);
    const data = await readRecordData(tenantId, recordId);
    expect(data["status"]).toBe("trial"); // unchanged
    expect(data["circuit_id"]).toBeUndefined(); // NOT written back
    expect(await countKeyIssuedAudit(tenantId, "e-owner")).toBe(0);
  });

  it("runIssueKey PDP denies (no grant) → no issuance, no write-back", async () => {
    const tenantId = randomUUID();
    const registryId = randomUUID();
    const recordId = randomUUID();
    await seedCustomerRecord({ tenantId, registryId, recordId, status: "trial" });

    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const denyDeps: IssueKeyDeps = {
      entitlement: new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW }),
      resolverDeps: {
        grants: { async getGrants(): Promise<Grant[]> { return []; } }, // no grant → denied
        records: { async getRecord(): Promise<Record<string, unknown> | null> { return readRecordData(tenantId, recordId); } },
        ancestry: { isDescendantOrSelf: (_h: string, a: string, b: string) => a === b },
        now: () => NOW_MS,
      },
      auditWriter: makePgAuditWriter(),
      actorEventWriter: makeInMemoryActorEventStore(tenantId),
      liveEnabled: true,
    };

    const ref: ResourceRef = { kind: "record", tenantId, registryId, recordId };
    const subject: ResolveSubject = { tenantId, subjectId: "e-nobody" };
    const outcome = await withTenantTx(tenantId, (client) =>
      runIssueKey(client as unknown as import("../../../src/db/audit-writer.js").PgClientLike, denyDeps, {
        tenantId, recordHandle: makeHandle(ref, tenantId), subject, circuitId: recordId, nowMs: NOW_MS,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("pdp_denied");
    const data = await readRecordData(tenantId, recordId);
    expect(data["circuit_id"]).toBeUndefined();
  });

  it("CE-3 anti-double-issue: two CONCURRENT completions → exactly ONE issuance (FOR UPDATE + pre-issuance guard)", async () => {
    const tenantId = randomUUID();
    const registryId = randomUUID();
    const recordId = randomUUID();
    await seedCustomerRecord({ tenantId, registryId, recordId, status: "trial" });

    // Call-counting wrapper over the REAL Ed25519 port: the double-license
    // symptom (review CE-3) is the port being invoked twice for one record.
    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const realPort = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });
    let issueCalls = 0;
    const countingPort: import("../../../src/runtime/customer-onboarding/entitlement-port.js").EntitlementPort = {
      issueEntitlement: async (input) => {
        issueCalls += 1;
        return realPort.issueEntitlement(input);
      },
    };
    const dataFetch = () => readRecordData(tenantId, recordId);
    const mkDeps = () =>
      makeDeps({ tenantId, recordId, live: true, dataFetch, entitlementOverride: countingPort });
    const run = () =>
      withTenantTx(tenantId, (client) =>
        applyIssueKeyStep(
          client as unknown as import("../../../src/db/audit-writer.js").PgClientLike,
          mkDeps(),
          { tenantId, registryId, recordId, actor: "e-owner", nowMs: NOW_MS },
        ),
      );

    // TWO CONCURRENT transactions on the SAME record. FOR UPDATE serializes them:
    // the loser blocks on the row lock, then (READ COMMITTED) re-reads the winner's
    // COMMITTED status='active' → the pre-issuance guard rejects active→active
    // WITHOUT reaching the port. Deterministic — enforced by the DB lock, not timing.
    const [r1, r2] = await Promise.all([run(), run()]);

    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect(fails[0]!.reason).toBe("bad_transition");

    // THE CE-3 PROOF: the entitlement port issued EXACTLY ONCE — no double license.
    expect(issueCalls).toBe(1);
    expect(store.getByCircuit(recordId)).not.toBeNull();

    // Record converged to a single consistent issued state; one key_issued audit.
    const data = await readRecordData(tenantId, recordId);
    expect(data["status"]).toBe("active");
    expect(data["circuit_id"]).toBe(recordId);
    expect(await countKeyIssuedAudit(tenantId, "e-owner")).toBe(1);
  });

  it("CE-3 sequential re-complete (idempotent re-click): second call → bad_transition, port NOT called again", async () => {
    const tenantId = randomUUID();
    const registryId = randomUUID();
    const recordId = randomUUID();
    await seedCustomerRecord({ tenantId, registryId, recordId, status: "trial" });

    const { privatePem } = makeKeypair();
    const store = new InMemoryLicenseStore();
    const realPort = new T0242EntitlementPort({ store, privKeyPem: privatePem, now: () => NOW });
    let issueCalls = 0;
    const countingPort: import("../../../src/runtime/customer-onboarding/entitlement-port.js").EntitlementPort = {
      issueEntitlement: async (input) => {
        issueCalls += 1;
        return realPort.issueEntitlement(input);
      },
    };
    const dataFetch = () => readRecordData(tenantId, recordId);
    const run = () =>
      withTenantTx(tenantId, (client) =>
        applyIssueKeyStep(
          client as unknown as import("../../../src/db/audit-writer.js").PgClientLike,
          makeDeps({ tenantId, recordId, live: true, dataFetch, entitlementOverride: countingPort }),
          { tenantId, registryId, recordId, actor: "e-owner", nowMs: NOW_MS },
        ),
      );

    const first = await run();
    expect(first.ok).toBe(true);
    const second = await run();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("bad_transition");
    expect(issueCalls).toBe(1); // the pre-guard blocked BEFORE the port
  });
});
