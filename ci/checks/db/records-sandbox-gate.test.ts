// T-0558 · records sandbox gate — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=<migrator-url> npm run fitness:db
//
// Proves the sandbox read gate (src/core/sandbox-gate.ts) on the record runtime read
// paths against the REAL choros_app (NOBYPASSRLS) role — the production RLS path, not a
// query-filter shim. The gate is on the OWNING APPLICATION's tier (records inherit the
// app's sandbox state):
//
//   - PUBLISHED application's records: visible to everyone (gate is a no-op).
//   - DRAFT application's records: HIDDEN from a non-privileged caller (list omits them,
//     GET → 404), VISIBLE to a privileged caller (owner/admin OR authoring_draft grant).
//
// TENANT ISOLATION (T-0013, the Враг target): the sandbox predicate is an ADDITIONAL
// `AND` inside withTenantTx + RLS — it never relaxes the tenant scope. An actor in
// tenant A sees neither published NOR draft records of tenant B, even as a privileged
// owner.
//
// The privilege resolver is injected (resolveSandboxPrivilege) so the privileged /
// unprivileged branches are driven deterministically; the tier filtering + tenant
// isolation are enforced by REAL SQL against the real role.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import pg from "pg";
import { appUrl, migratorUrl, withClient, uuid } from "./_helpers.js";
import { Router } from "../../../src/http/router.js";
import { registerRecordRoutes } from "../../../src/http/records.js";
import type { ActorPrivilege } from "../../../src/db/sandbox-gate-dao.js";

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env["DATABASE_URL"]) {
      console.log("[skip] DATABASE_URL not set");
      return;
    }
    return fn();
  };
}

const hasDb = Boolean(process.env["DATABASE_URL"]);

let TENANT_A: string;
let TENANT_B: string;

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string", title: "Name" } },
  required: ["name"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApp(c: pg.Client, tenantId: string, slug: string, tier: "draft" | "published"): Promise<string> {
  const id = uuid();
  await c.query("BEGIN");
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, $4, 0, 0)`,
    [tenantId, id, slug, tier],
  );
  await c.query("COMMIT");
  return id;
}

async function seedRegDef(c: pg.Client, tenantId: string, appId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query("BEGIN");
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, JSON.stringify(SCHEMA)],
  );
  await c.query("COMMIT");
  return id;
}

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  regId: string,
  data: object,
  createdBy = "seed",
): Promise<string> {
  const id = uuid();
  await c.query("BEGIN");
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
    [tenantId, id, regId, JSON.stringify(data), createdBy],
  );
  await c.query("COMMIT");
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: extraHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (ch: Buffer) => chunks.push(ch));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures + server
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = "";
let appPool: pg.Pool;

let pubAppId = "", pubRegId = "", pubRecId = "";
let draftAppId = "", draftRegId = "", draftRecId = "";
let bPubRecId = "", bDraftRecId = "";
// T-0623 (столп-4): draft-app records DISTINGUISHED by author.
//   - draftRecOwnByA: created_by='actor-a' — actor-a must see + delete their own even in a draft app.
//   - draftRecOwnByOther: created_by='someone-else' — actor-a must NOT see it (draft, not theirs).
let draftRecOwnByA = "", draftRecOwnByOther = "";

// Privilege the injected resolver returns — mutated per test.
let injectedPriv: ActorPrivilege = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === "actor-a") return TENANT_A;
  if (slug === "actor-b") return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(requireDb(async () => {
  TENANT_A = crypto.randomUUID();
  TENANT_B = crypto.randomUUID();

  await withClient(migratorUrl(), async (c) => {
    await seedTenantRow(c, TENANT_A);
    await seedTenantRow(c, TENANT_B);

    // Tenant A: a PUBLISHED app with a record, and a DRAFT app with a record.
    pubAppId = await seedApp(c, TENANT_A, `pub-${uuid().slice(0, 8)}`, "published");
    pubRegId = await seedRegDef(c, TENANT_A, pubAppId, "reg-pub");
    pubRecId = await seedRecord(c, TENANT_A, pubRegId, { name: "published-rec" });

    draftAppId = await seedApp(c, TENANT_A, `draft-${uuid().slice(0, 8)}`, "draft");
    draftRegId = await seedRegDef(c, TENANT_A, draftAppId, "reg-draft");
    draftRecId = await seedRecord(c, TENANT_A, draftRegId, { name: "draft-rec" });

    // T-0623: two more draft-app records in the SAME draft app, differing only by author.
    draftRecOwnByA = await seedRecord(c, TENANT_A, draftRegId, { name: "draft-mine" }, "actor-a");
    draftRecOwnByOther = await seedRecord(c, TENANT_A, draftRegId, { name: "draft-theirs" }, "actor-other");

    // Tenant B: one published + one draft record (must never appear for actor-a).
    const bPubApp = await seedApp(c, TENANT_B, `bpub-${uuid().slice(0, 8)}`, "published");
    const bPubReg = await seedRegDef(c, TENANT_B, bPubApp, "reg-bpub");
    bPubRecId = await seedRecord(c, TENANT_B, bPubReg, { name: "b-published" });

    const bDraftApp = await seedApp(c, TENANT_B, `bdraft-${uuid().slice(0, 8)}`, "draft");
    const bDraftReg = await seedRegDef(c, TENANT_B, bDraftApp, "reg-bdraft");
    bDraftRecId = await seedRecord(c, TENANT_B, bDraftReg, { name: "b-draft" });
  });

  appPool = new pg.Pool({ connectionString: appUrl(), max: 4 });
  const router = new Router();
  registerRecordRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    resolveSandboxPrivilege: async () => injectedPriv,
  });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    r();
  }));
}));

afterAll(requireDb(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (appPool) await appPool.end();
  // Cleanup: delete seeded rows (migrator role bypasses RLS; respect FK order).
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query("BEGIN");
      await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
      // The tier_published_locked trigger forbids DELETE of published config rows
      // unless the sanctioned-promote GUC is set — set it here for cleanup only.
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query("DELETE FROM choros.record WHERE tenant_id = $1", [t]);
      await c.query("DELETE FROM choros.registry_def WHERE tenant_id = $1", [t]);
      await c.query("DELETE FROM choros.application WHERE tenant_id = $1", [t]);
      await c.query("COMMIT");
    }
  });
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0558 records sandbox gate (live RLS + tier)", () => {
  it("unprivileged caller: LIST shows published-app record, HIDES draft-app record", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    const r = await makeRequest(baseUrl, "GET", "/api/records", { "x-dev-user": "actor-a" });
    expect(r.statusCode).toBe(200);
    const ids = (JSON.parse(r.body).records as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(pubRecId);
    expect(ids).not.toContain(draftRecId);
  }));

  it("unprivileged caller: GET draft-app record → 404; published → 200", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    const draft = await makeRequest(baseUrl, "GET", `/api/records/${draftRecId}`, { "x-dev-user": "actor-a" });
    expect(draft.statusCode).toBe(404);
    const pub = await makeRequest(baseUrl, "GET", `/api/records/${pubRecId}`, { "x-dev-user": "actor-a" });
    expect(pub.statusCode).toBe(200);
  }));

  it("privileged owner/admin: LIST + GET include the draft-app record", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false };
    const list = await makeRequest(baseUrl, "GET", "/api/records", { "x-dev-user": "actor-a" });
    const ids = (JSON.parse(list.body).records as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(draftRecId);
    expect(ids).toContain(pubRecId);
    const get = await makeRequest(baseUrl, "GET", `/api/records/${draftRecId}`, { "x-dev-user": "actor-a" });
    expect(get.statusCode).toBe(200);
  }));

  it("privileged via authoring_draft grant: draft-app record visible", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: true };
    const get = await makeRequest(baseUrl, "GET", `/api/records/${draftRecId}`, { "x-dev-user": "actor-a" });
    expect(get.statusCode).toBe(200);
  }));

  it("tenant isolation: actor-a (even privileged) never sees tenant B's published OR draft records", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false };
    const list = await makeRequest(baseUrl, "GET", "/api/records", { "x-dev-user": "actor-a" });
    const ids = (JSON.parse(list.body).records as Array<{ id: string }>).map((x) => x.id);
    expect(ids).not.toContain(bPubRecId);
    expect(ids).not.toContain(bDraftRecId);
    // GET of a tenant-B record by actor-a → 404 (RLS-filtered, never the sandbox path).
    const getB = await makeRequest(baseUrl, "GET", `/api/records/${bPubRecId}`, { "x-dev-user": "actor-a" });
    expect(getB.statusCode).toBe(404);
  }));
});

describe("T-0623 creator-own floor over the sandbox gate (столп-4)", () => {
  it("unprivileged author SEES their OWN draft-app record (GET 200), NOT another's (404)", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    // Own draft record → visible even though the app is draft and actor is unprivileged.
    const mine = await makeRequest(baseUrl, "GET", `/api/records/${draftRecOwnByA}`, { "x-dev-user": "actor-a" });
    expect(mine.statusCode).toBe(200);
    // Another author's draft record → still hidden (sandbox gate holds for non-own rows).
    const theirs = await makeRequest(baseUrl, "GET", `/api/records/${draftRecOwnByOther}`, { "x-dev-user": "actor-a" });
    expect(theirs.statusCode).toBe(404);
    // The seed-authored draft record (created_by='seed') is likewise NOT theirs → hidden.
    const seedRec = await makeRequest(baseUrl, "GET", `/api/records/${draftRecId}`, { "x-dev-user": "actor-a" });
    expect(seedRec.statusCode).toBe(404);
  }));

  it("unprivileged author's LIST includes their OWN draft record, excludes others' draft records", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    const r = await makeRequest(baseUrl, "GET", "/api/records", { "x-dev-user": "actor-a" });
    expect(r.statusCode).toBe(200);
    const ids = (JSON.parse(r.body).records as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(pubRecId);          // published — everyone
    expect(ids).toContain(draftRecOwnByA);    // own draft — T-0623 floor
    expect(ids).not.toContain(draftRecOwnByOther); // others' draft — still hidden
    expect(ids).not.toContain(draftRecId);         // seed-authored draft — still hidden
  }));

  it("TENANT ISOLATION preserved: the creator floor never crosses tenants", requireDb(async () => {
    // actor-a authored nothing in tenant B; even if a B row shared the slug string,
    // the withTenantTx + RLS scope + explicit r.tenant_id guard keep B rows invisible.
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    const list = await makeRequest(baseUrl, "GET", "/api/records", { "x-dev-user": "actor-a" });
    const ids = (JSON.parse(list.body).records as Array<{ id: string }>).map((x) => x.id);
    expect(ids).not.toContain(bPubRecId);
    expect(ids).not.toContain(bDraftRecId);
  }));

  it("unprivileged author may DELETE their OWN draft-app record (204); NOT another's (403)", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    // Cannot delete a draft record they did not author → 403 (столп-4 does not widen).
    const delTheirs = await makeRequest(baseUrl, "DELETE", `/api/records/${draftRecOwnByOther}`, { "x-dev-user": "actor-a" });
    expect(delTheirs.statusCode).toBe(403);
    // CAN delete their own → 204. (Runs last: it removes the row.)
    const delMine = await makeRequest(baseUrl, "DELETE", `/api/records/${draftRecOwnByA}`, { "x-dev-user": "actor-a" });
    expect(delMine.statusCode).toBe(204);
    // Gone now (404).
    const getGone = await makeRequest(baseUrl, "GET", `/api/records/${draftRecOwnByA}`, { "x-dev-user": "actor-a" });
    expect(getGone.statusCode).toBe(404);
  }));

  it("non-existent id → 404 (never a 403 that would leak existence)", requireDb(async () => {
    injectedPriv = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
    const del = await makeRequest(baseUrl, "DELETE", `/api/records/${uuid()}`, { "x-dev-user": "actor-a" });
    expect(del.statusCode).toBe(404);
  }));
});

if (!hasDb) {
  describe("T-0558 records sandbox gate", () => {
    it("skipped (no DATABASE_URL)", () => { expect(true).toBe(true); });
  });
}
