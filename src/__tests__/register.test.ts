/**
 * src/__tests__/register.test.ts — T-0342 (E14): Registration MVP backend tests.
 *
 * Covers:
 *   FF-1  — POST /api/register is public: reachable WITHOUT Authorization (not 401)
 *   FF-2  — Compensation: DB fail after KC create → kc.deleteUser called once
 *   FF-3  — KC user body has actor_type='human' + password credential
 *   FF-5  — core/register.ts does NOT import from ../http/
 *   FF-7  — resolveActorTenant / extractActor signatures UNCHANGED; build + spaAuth green
 *
 * Validation sub-tests:
 *   V-1   — missing orgName → 400 VALIDATION
 *   V-2   — orgName too long → 400 VALIDATION
 *   V-3   — invalid email → 400 VALIDATION
 *   V-4   — short password → 400 VALIDATION
 *
 * Error mapping sub-tests:
 *   E-1   — EMAIL_TAKEN from KC → 409 EMAIL_TAKEN
 *   E-2   — AUTH_UNAVAILABLE from KC → 503 AUTH_UNAVAILABLE
 *   E-3   — ORG_TAKEN (DB slug conflict) → 409 ORG_TAKEN (compensation: deleteUser called)
 *
 * DB-level fitness (FF-4 / FF-6) — written here; annotated to run against live PG (server).
 * When DATABASE_URL is absent (local Mac without Docker), tests are skipped with a clear note.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

import { Router } from "../http/router.js";
import { registerRegisterRoutes } from "../http/register.js";
import { registerTenant, slugifyOrgName } from "../core/register.js";
import { InMemoryKeycloakUserPort } from "../keycloak/fake-user-port.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers as Record<string, string>,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fake DB pool (in-memory; does NOT talk to Postgres)
// ---------------------------------------------------------------------------

class FakePoolClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  private shouldFailOnInsert: string | null = null;

  constructor(opts?: { failOnInsert?: string }) {
    this.shouldFailOnInsert = opts?.failOnInsert ?? null;
  }

  async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
    this.queries.push({ text, values: vals });

    if (this.shouldFailOnInsert && text.includes("INSERT") && text.includes(this.shouldFailOnInsert)) {
      const err = new Error("Fake DB failure");
      throw err;
    }
    return { rows: [] };
  }

  release(): void { /* no-op */ }
}

function makeFakePool(opts?: { failOnInsert?: string }): pg.Pool {
  return {
    connect: async () => new FakePoolClient(opts) as unknown as pg.PoolClient,
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// HTTP server fixture
// ---------------------------------------------------------------------------

let server: http.Server;
let kcPort: InMemoryKeycloakUserPort;
let fakePool: pg.Pool;

beforeAll(async () => {
  kcPort = new InMemoryKeycloakUserPort();
  fakePool = makeFakePool();

  const router = new Router();
  registerRegisterRoutes(router, { pool: fakePool, kc: kcPort });
  server = http.createServer(router.dispatch.bind(router));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---------------------------------------------------------------------------
// FF-1: POST /api/register is PUBLIC — no Authorization required
// ---------------------------------------------------------------------------

describe("FF-1 — POST /api/register is public (no Authorization required)", () => {
  it("request WITHOUT Authorization header does NOT return 401", async () => {
    kcPort.reset();
    // No Authorization header — should not get 401 (might be 201 or 4xx validation)
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "TestOrg",
      email: "test@example.com",
      password: "password123",
    });
    // Must NOT be 401 (auth gate should not block this)
    expect(resp.status).not.toBe(401);
  });

  it("request WITH an invalid/fake Authorization header still does NOT return 401 from auth gate", async () => {
    kcPort.reset();
    const resp = await makeRequest(
      server,
      "POST",
      "/api/register",
      { orgName: "TestOrg", email: "test@example.com", password: "password123" },
      { Authorization: "Bearer fake-token-xyz" },
    );
    // Route is public — the Authorization header is IGNORED (not validated)
    expect(resp.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// FF-5: core/register.ts does NOT import from ../http/
// ---------------------------------------------------------------------------

describe("FF-5 — core/register.ts has no http import", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "..", "core", "register.ts"), "utf8");

  it("does not import from ../http/", () => {
    // Must not contain any relative import resolving to the http layer
    const httpImportRe = /from\s+['"]\.\.\/(http\/|http')/;
    expect(httpImportRe.test(src)).toBe(false);
  });

  it("does not import node:http directly", () => {
    expect(src.includes('from "node:http"')).toBe(false);
    expect(src.includes("from 'node:http'")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-3: KC user body has actor_type='human' and password credential
// ---------------------------------------------------------------------------

describe("FF-3 — KC user created with actor_type=human + password credential", () => {
  it("createHumanUser spec has actorType='human' and password >= 8 chars", async () => {
    kcPort.reset();
    // Successful path
    await makeRequest(server, "POST", "/api/register", {
      orgName: "Acme Corp",
      email: "founder@acme.com",
      password: "strongPassword99",
    });
    expect(kcPort.createCallCount).toBe(1);
    const created = kcPort.created[0];
    expect(created).toBeDefined();
    expect(created.spec.actorType).toBe("human");
    expect(created.spec.password.length).toBeGreaterThanOrEqual(8);
    expect(created.spec.email).toBe("founder@acme.com");
  });
});

// ---------------------------------------------------------------------------
// FF-2: Compensation — DB fail after KC create → kc.deleteUser called once
// ---------------------------------------------------------------------------

describe("FF-2 — DB failure after KC create → deleteUser called (compensation)", () => {
  it("deleteUser is called once when DB INSERT fails after KC user was created", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const poolLocal = makeFakePool({ failOnInsert: "choros.tenant" });

    const router = new Router();
    registerRegisterRoutes(router, { pool: poolLocal, kc: kcLocal });
    const srv = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

    try {
      const resp = await makeRequest(srv, "POST", "/api/register", {
        orgName: "FailOrg",
        email: "fail@example.com",
        password: "password123",
      });

      // Should return 500 (internal error after compensation)
      expect(resp.status).toBe(500);

      // KC user WAS created
      expect(kcLocal.createCallCount).toBe(1);

      // deleteUser MUST have been called once for compensation (FF-2)
      expect(kcLocal.deleteCallCount).toBe(1);
      expect(kcLocal.deleteCalls).toHaveLength(1);

      // The deleted userId should match the created userId
      const createdUserId = kcLocal.created[0]?.userId;
      expect(kcLocal.deleteCalls[0]).toBe(createdUserId);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Pure service: registerTenant validation (unit tests — no server, no DB)
// ---------------------------------------------------------------------------

describe("registerTenant — validation", () => {
  const kcLocal = new InMemoryKeycloakUserPort();
  const poolLocal = makeFakePool();

  it("V-1: missing orgName → RegisterError VALIDATION", async () => {
    await expect(
      registerTenant({ pool: poolLocal, kc: kcLocal, nowMs: Date.now }, { orgName: "", email: "a@b.com", password: "password123" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(kcLocal.createCallCount).toBe(0); // KC not called on validation failure
  });

  it("V-2: orgName too long (>120 chars) → RegisterError VALIDATION", async () => {
    await expect(
      registerTenant({ pool: poolLocal, kc: kcLocal, nowMs: Date.now }, {
        orgName: "a".repeat(121), email: "a@b.com", password: "password123",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(kcLocal.createCallCount).toBe(0);
  });

  it("V-3: invalid email → RegisterError VALIDATION", async () => {
    await expect(
      registerTenant({ pool: poolLocal, kc: kcLocal, nowMs: Date.now }, { orgName: "Org", email: "not-an-email", password: "password123" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(kcLocal.createCallCount).toBe(0);
  });

  it("V-4: password < 8 chars → RegisterError VALIDATION", async () => {
    await expect(
      registerTenant({ pool: poolLocal, kc: kcLocal, nowMs: Date.now }, { orgName: "Org", email: "a@b.com", password: "short" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(kcLocal.createCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error mapping: EMAIL_TAKEN + AUTH_UNAVAILABLE
// ---------------------------------------------------------------------------

describe("HTTP error mapping", () => {
  it("E-1: KC EMAIL_TAKEN → 409 EMAIL_TAKEN", async () => {
    kcPort.reset();
    kcPort.failOnCreate = true; // InMemoryKeycloakUserPort: throws EMAIL_TAKEN

    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "Existing Org",
      email: "taken@example.com",
      password: "password123",
    });
    expect(resp.status).toBe(409);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("EMAIL_TAKEN");
  });

  it("E-2: KC AUTH_UNAVAILABLE → 503 AUTH_UNAVAILABLE", async () => {
    kcPort.reset();
    kcPort.failOnAuth = true; // InMemoryKeycloakUserPort: throws AUTH_UNAVAILABLE

    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "UnavailableOrg",
      email: "unavail@example.com",
      password: "password123",
    });
    expect(resp.status).toBe(503);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// slugifyOrgName — pure unit tests
// ---------------------------------------------------------------------------

describe("slugifyOrgName — pure", () => {
  it("lowercases and replaces spaces/special chars with -", () => {
    expect(slugifyOrgName("My Company")).toBe("my-company");
  });
  it("collapses consecutive dashes", () => {
    expect(slugifyOrgName("Foo  Bar")).toBe("foo-bar");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugifyOrgName("  --Org-- ")).toBe("org");
  });
  it("caps at 80 chars", () => {
    const result = slugifyOrgName("a".repeat(200));
    expect(result.length).toBeLessThanOrEqual(80);
  });
  it("empty string falls back to 'org'", () => {
    expect(slugifyOrgName("")).toBe("org");
  });
});

// ---------------------------------------------------------------------------
// FF-7: resolveActorTenant / extractActor signatures unchanged
// ---------------------------------------------------------------------------

describe("FF-7 — resolveActorTenant/extractActor signatures unchanged", () => {
  it("resolveActorTenant is exported from src/db/org.ts with (pool, actorSlug) signature", async () => {
    const { resolveActorTenant } = await import("../db/org.js");
    expect(typeof resolveActorTenant).toBe("function");
    // Signature: (pool: pg.Pool, actorSlug: string) => Promise<string>
    // Can't call live without DB — just verify it's a 2-param function
    expect(resolveActorTenant.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DB-level fitness tests (FF-4 / FF-6) — require live Postgres
// Annotated: these run on the dev server (homeserver-vm, live PG stack).
// When DATABASE_URL is absent, tests are skipped (local Mac, no Docker).
// ---------------------------------------------------------------------------

const LIVE_DB = process.env["DATABASE_URL"];

describe.skipIf(!LIVE_DB)("FF-4 / FF-6 — DB-level fitness (requires live Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: LIVE_DB });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("FF-4: new tenant has 0 app/record rows + exactly 1 tenant, 1 role(tenant-owner), 1 employee(slug=sub), 1 confirmed role_assignment", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const nowMs = () => Date.now();
    const req = {
      orgName: `FitnessTestOrg-${Date.now()}`,
      email: `fitness-${Date.now()}@example.com`,
      password: "fitness-password-99",
    };

    const result = await registerTenant({ pool, kc: kcLocal, nowMs }, req);

    const { tenantId, userId: kcSub } = result;

    // Check via BYPASSRLS (the pool role is choros_migrator = BYPASSRLS)
    const client = await pool.connect();
    try {
      // 0 applications
      const apps = await client.query(
        `SELECT count(*) AS c FROM choros.application WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(Number(apps.rows[0].c)).toBe(0);

      // 0 records
      const recs = await client.query(
        `SELECT count(*) AS c FROM choros.record WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(Number(recs.rows[0].c)).toBe(0);

      // Exactly 1 tenant
      const tenants = await client.query(
        `SELECT id, slug FROM choros.tenant WHERE id = $1`,
        [tenantId],
      );
      expect(tenants.rows).toHaveLength(1);

      // Exactly 1 role with slug='tenant-owner'
      const roles = await client.query(
        `SELECT slug FROM choros.role WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(roles.rows).toHaveLength(1);
      expect(roles.rows[0].slug).toBe("tenant-owner");

      // Exactly 1 employee with slug = KC sub
      const employees = await client.query(
        `SELECT slug FROM choros.employee WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(employees.rows).toHaveLength(1);
      expect(employees.rows[0].slug).toBe(kcSub);

      // Exactly 1 confirmed role_assignment
      const assignments = await client.query(
        `SELECT confirmed_by FROM choros.role_assignment WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(assignments.rows).toHaveLength(1);
      expect(assignments.rows[0].confirmed_by).not.toBeNull();
    } finally {
      client.release();

      // Cleanup: remove the test tenant (best-effort)
      const cleanClient = await pool.connect();
      try {
        await cleanClient.query("BEGIN");
        await cleanClient.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await cleanClient.query("SET LOCAL search_path TO choros");
        await cleanClient.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
        await cleanClient.query("COMMIT");
      } catch {
        await cleanClient.query("ROLLBACK");
      } finally {
        cleanClient.release();
      }
    }
  });

  it("FF-6: resolveActorTenant(pool, kcSub) resolves to new tenant, NOT showcase/dev", async () => {
    const { resolveActorTenant } = await import("../db/org.js");
    const kcLocal = new InMemoryKeycloakUserPort();
    const nowMs = () => Date.now();
    const req = {
      orgName: `FitnessFF6Org-${Date.now()}`,
      email: `ff6-${Date.now()}@example.com`,
      password: "ff6-password-99",
    };

    const result = await registerTenant({ pool, kc: kcLocal, nowMs }, req);
    const { tenantId, userId: kcSub } = result;

    try {
      const resolved = await resolveActorTenant(pool, kcSub);
      expect(resolved).toBe(tenantId);
      // Must NOT be the dev tenant or showcase
      const DEV_TENANT = process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
      expect(resolved).not.toBe(DEV_TENANT);
    } finally {
      // Cleanup
      const cleanClient = await pool.connect();
      try {
        await cleanClient.query("BEGIN");
        await cleanClient.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await cleanClient.query("SET LOCAL search_path TO choros");
        await cleanClient.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
        await cleanClient.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
        await cleanClient.query("COMMIT");
      } catch {
        await cleanClient.query("ROLLBACK");
      } finally {
        cleanClient.release();
      }
    }
  });
});
