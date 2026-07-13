/**
 * ci/checks/db/T-0249-action-route-effect.db.test.ts — T-0249 review CE-1/CE-2
 * RED-LOCK: the completion-effect wire is LIVE at the route level.
 *
 * Drives POST /api/inbox/:id/action through the REAL HTTP route
 * (registerInboxRoutes — the SAME handler production traffic hits) with the
 * writeDeps carrying the PRODUCTION-ASSEMBLED completion-effect registry
 * (buildCompletionEffectRegistry — the exact builder server.ts calls), against
 * live Postgres. No Flowable needed: engine honest-degrades to "not_configured";
 * the effect runs inside the approve tx regardless.
 *
 * RED-LOCK SEMANTICS (judge CE-1): this test is RED on the pre-wire tree —
 * src/composition/completion-effects-root.ts did not exist there (import fails),
 * and even hand-assembled writeDeps had no completionEffectRegistry, so the
 * approve returned 200 «done» with the record UNTOUCHED. Test (2) below encodes
 * that dead-wire behaviour as an explicit NEGATIVE CONTROL (registry omitted →
 * record unchanged), so the exact HEAD~ behaviour is executed and observable in
 * every run, not just claimed.
 *
 * WHAT IS PROVEN LIVE:
 *   (1) production registry (live entitlement env: temp Ed25519 PEM + ledger,
 *       CUSTOMER_ONBOARDING_LIVE=true) → approve the issue-key step over HTTP →
 *       200 «done» AND the record re-read from PG carries circuit_id +
 *       activation_key_issued_at + status='active'. Full production PDP path:
 *       makeDbGrantSource resolves the actor's REAL role_assignment + grant rows.
 *   (2) NEGATIVE CONTROL (the HEAD~ dead wire): same seed, registry OMITTED →
 *       200 «done» but record UNCHANGED — the exact silent-green this task's
 *       wire eliminates.
 *   (3) CE-2 fail-VISIBLE pin: production registry with DORMANT env (no
 *       CUSTOMER_ONBOARDING_LIVE) → approve → 422 STEP_EFFECT_FAILED, record
 *       unchanged AND the approve is ROLLED BACK (no task.approved audit row) —
 *       never a silent «done»+200 without a key.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { appUrl, migratorUrl, withClient } from "./_helpers.js";
import { Router } from "../../../src/http/router.js";
import { registerInboxRoutes, type InboxWriteDeps } from "../../../src/http/inbox.js";
import { appendProcessStarted } from "../../../src/http/process-projection.js";
import type { PgClientLike } from "../../../src/db/audit-writer.js";
import { buildCompletionEffectRegistry } from "../../../src/composition/completion-effects-root.js";
import {
  CUSTOMER_ONBOARDING_PROC_KEY,
  ISSUE_KEY_TASK_NAME,
  STEP_EFFECT_FAILED,
} from "../../../src/composition/customer-onboarding-effects.js";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const RUN = hasDb ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPROVER = "onboarding-approver-e2e";
// NB: the approver role slug is 'vendor-admin' — runIssueKey stamps this role
// slug as roleAtEvent on its guarded-transition actor_event, and the composition
// adapter resolves it to the tenant's role UUID (fail-closed when absent). The
// real founder tenant seeds this role via seed/vendor-crm/pack.json; the test
// tenant seeds its own row below (test data, not a platform constant).
const ROLE = "vendor-admin";

const CUSTOMER_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["company_name", "contact_name", "contact_email", "plan", "not_after", "status"],
  properties: {
    company_name: { type: "string" },
    contact_name: { type: "string" },
    contact_email: { type: "string" },
    plan: { type: "string", enum: ["pilot", "standard", "enterprise"] },
    not_after: { type: "string" },
    status: { type: "string", enum: ["draft", "trial", "active", "expired", "custom", "archived"] },
    circuit_id: { type: "string" },
    activation_key_issued_at: { type: "string" },
    notes: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// Seed helpers (mirror engine-drive-generic.db.test.ts's role/grant pattern)
// ---------------------------------------------------------------------------

async function seedTenantOrg(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

/** Employee + role + confirmed role_assignment + UPDATE grant on the record. */
async function seedApproverWithUpdateGrant(
  c: pg.Client,
  tenantId: string,
  recordId: string,
): Promise<void> {
  const empId = randomUUID();
  const roleId = randomUUID();
  await c.query("BEGIN");
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, empId, APPROVER, `Approver ${APPROVER}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, roleId, ROLE],
  );
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'genesis', $6, NULL, $6, 0, 0)`,
    [
      tenantId, randomUUID(), empId, roleId,
      JSON.stringify({ kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" }),
      APPROVER,
    ],
  );
  // The runIssueKey PDP path (resolveFor op=update) resolves the actor's grants
  // through the REAL DAO (role_assignment → grant). Seed an update grant whose
  // node-scope is the record itself (self-containment via the composite oracle).
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by, tier)
     VALUES ($1, $2, $3, 'record', NULL, 'update', $4::jsonb,
             NULL, false, $5, NULL, NULL, 0, NULL, $5, NULL, 'published')`,
    [
      tenantId, randomUUID(), roleId,
      JSON.stringify({ kind: "node", hierarchy: "resource", nodeId: recordId, nodeLevel: "record" }),
      APPROVER,
    ],
  );
  await c.query("COMMIT");
}

/** application + registry + customer record + process_app_binding + process.started. */
async function seedOnboardingCase(
  c: pg.Client,
  tenantId: string,
): Promise<{ recordId: string; taskId: string; instanceId: string }> {
  const appId = randomUUID();
  const registryId = randomUUID();
  const recordId = randomUUID();
  const instanceId = randomUUID();
  await c.query("BEGIN");
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, 'Vendor CRM (route test)', 'test', 0, 0)`,
    [tenantId, appId, `vendor-crm-${recordId.slice(0, 8)}`],
  );
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, is_system, created_at, updated_at)
     VALUES ($1, $2, $3, 'customer-subscription', 'Клиенты (route test)', 'test', $4::jsonb, false, 0, 0)`,
    [tenantId, registryId, appId, JSON.stringify(CUSTOMER_SCHEMA)],
  );
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
    [
      tenantId, recordId, registryId,
      JSON.stringify({
        company_name: "ООО Провод-Тест",
        contact_name: "Пётр",
        contact_email: "petr@wire-test.ru",
        plan: "pilot",
        not_after: "2027-12-31",
        status: "trial",
      }),
      APPROVER,
    ],
  );
  // The instance→application resolution path (resolveInstanceTargetOnClient).
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', '{}'::jsonb, 0, 0)`,
    [tenantId, randomUUID(), CUSTOMER_ONBOARDING_PROC_KEY, appId],
  );
  // The waiting issue-key task (base process.started projection row; step name =
  // the issue-key task name → the registry matches on task.step).
  const taskId = await appendProcessStarted(c as unknown as PgClientLike, {
    instanceId,
    procKey: CUSTOMER_ONBOARDING_PROC_KEY,
    actor: "system:test-seed",
    nowMs: Date.now(),
    tenantId,
    recordId,
    approverRole: ROLE,
    step: ISSUE_KEY_TASK_NAME,
    taskName: ISSUE_KEY_TASK_NAME,
  });
  await c.query("COMMIT");
  return { recordId, taskId, instanceId };
}

async function readRecord(tenantId: string, recordId: string): Promise<Record<string, unknown>> {
  return withClient(migratorUrl(), async (c) => {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const r = await c.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2`,
      [tenantId, recordId],
    );
    await c.query("COMMIT");
    return r.rows[0]!.data;
  });
}

async function countTaskApproved(tenantId: string, taskId: string): Promise<number> {
  return withClient(migratorUrl(), async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM choros.audit_event
        WHERE tenant_id = $1 AND type = 'task.approved' AND subject = $2`,
      [tenantId, taskId],
    );
    return r.rows[0]!.n;
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing (mirrors engine-drive-generic.db.test.ts makeRequest)
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (ch: Buffer) => chunks.push(ch));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function bootServer(writeDeps: InboxWriteDeps): Promise<{ server: http.Server; baseUrl: string }> {
  const router = new Router();
  registerInboxRoutes(router, undefined, writeDeps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, "localhost", () => {
      const addr = server.address();
      resolve(addr && typeof addr !== "string" ? `http://localhost:${addr.port}` : "");
    });
  });
  return { server, baseUrl };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let appPool: pg.Pool;
const servers: http.Server[] = [];

// Live entitlement env for the PRODUCTION builder: throwaway Ed25519 key + ledger
// in a temp dir (never committed; mirrors t0242-entitlement-port.test.ts).
function makeLiveEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "t0249-wire-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pemPath = join(dir, "vendor-priv.pem");
  writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, "utf8");
  return {
    CUSTOMER_ONBOARDING_LIVE: "true",
    VENDOR_PRIV_KEY_PATH: pemPath,
    VENDOR_LEDGER_PATH: join(dir, "ledger.json"),
  };
}

RUN("T-0249 CE-1 RED-LOCK · /action drives the PRODUCTION completion-effect wire (live PG)", () => {
  beforeAll(() => {
    appPool = new pg.Pool({ connectionString: appUrl() });
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    if (appPool) await appPool.end();
  });

  it("(1) PRODUCTION registry (live env) → approve issue-key over HTTP → 200 + circuit_id/status=active written back", async () => {
    const tenantId = randomUUID();
    const seeded = await withClient(migratorUrl(), async (c) => {
      await seedTenantOrg(c, tenantId);
      const s = await seedOnboardingCase(c, tenantId);
      await seedApproverWithUpdateGrant(c, tenantId, s.recordId);
      return s;
    });

    // THE PRODUCTION ASSEMBLY — the exact builder server.ts calls (CE-1).
    const registry = buildCompletionEffectRegistry(appPool, makeLiveEnv());
    const { server, baseUrl } = await bootServer({
      pool: appPool,
      resolveActorTenant: async () => tenantId,
      completionEffectRegistry: registry,
    });
    servers.push(server);

    const r = await makeRequest(baseUrl, "POST", `/api/inbox/${seeded.taskId}/action`,
      { action: "approve" }, { "x-dev-user": APPROVER });

    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body) as { status: string };
    expect(body.status).toBe("done");

    // THE WIRE PROOF: the record — re-read from live PG — carries the issued key.
    const data = await readRecord(tenantId, seeded.recordId);
    expect(data["status"]).toBe("active");
    expect(data["circuit_id"]).toBe(seeded.recordId);
    expect(typeof data["activation_key_issued_at"]).toBe("string");
  });

  it("(2) NEGATIVE CONTROL — registry omitted (the exact HEAD~ dead wire): 200 «done» but record UNCHANGED", async () => {
    const tenantId = randomUUID();
    const seeded = await withClient(migratorUrl(), async (c) => {
      await seedTenantOrg(c, tenantId);
      const s = await seedOnboardingCase(c, tenantId);
      await seedApproverWithUpdateGrant(c, tenantId, s.recordId);
      return s;
    });

    const { server, baseUrl } = await bootServer({
      pool: appPool,
      resolveActorTenant: async () => tenantId,
      // NO completionEffectRegistry — byte-identical to the pre-CE-1 production
      // wiring. This is the RED condition test (1) locks against.
    });
    servers.push(server);

    const r = await makeRequest(baseUrl, "POST", `/api/inbox/${seeded.taskId}/action`,
      { action: "approve" }, { "x-dev-user": APPROVER });

    expect(r.statusCode, r.body).toBe(200);
    const data = await readRecord(tenantId, seeded.recordId);
    expect(data["status"]).toBe("trial");        // unchanged
    expect(data["circuit_id"]).toBeUndefined();  // no key — the dead-wire symptom
  });

  it("(3) CE-2 fail-VISIBLE — DORMANT env: approve → 422 STEP_EFFECT_FAILED, record unchanged, approve ROLLED BACK", async () => {
    const tenantId = randomUUID();
    const seeded = await withClient(migratorUrl(), async (c) => {
      await seedTenantOrg(c, tenantId);
      const s = await seedOnboardingCase(c, tenantId);
      await seedApproverWithUpdateGrant(c, tenantId, s.recordId);
      return s;
    });

    // PRODUCTION builder with the DEFAULT (dormant) env — no CUSTOMER_ONBOARDING_LIVE.
    const registry = buildCompletionEffectRegistry(appPool, {});
    const { server, baseUrl } = await bootServer({
      pool: appPool,
      resolveActorTenant: async () => tenantId,
      completionEffectRegistry: registry,
    });
    servers.push(server);

    const r = await makeRequest(baseUrl, "POST", `/api/inbox/${seeded.taskId}/action`,
      { action: "approve" }, { "x-dev-user": APPROVER });

    // Fail-VISIBLE (T-0571 AC-7): typed 422, never a silent «done»+200 without a key.
    expect(r.statusCode, r.body).toBe(422);
    const body = JSON.parse(r.body) as { error: { code: string } };
    expect(body.error.code).toBe(STEP_EFFECT_FAILED);

    // Nothing half-done: record untouched AND the approve itself rolled back
    // (no task.approved audit row → the step is honestly still open for retry).
    const data = await readRecord(tenantId, seeded.recordId);
    expect(data["status"]).toBe("trial");
    expect(data["circuit_id"]).toBeUndefined();
    expect(await countTaskApproved(tenantId, seeded.taskId)).toBe(0);
  });
});
