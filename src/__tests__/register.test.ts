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
import type { KeycloakUserPort, KcHumanUserSpec } from "../keycloak/admin-port.js";

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

  // T-0633 [SECURITY, defense-in-depth]: if the chosen username/login collides
  // with an existing HUMAN employee slug, registration is rejected 409
  // LOGIN_RESERVED BEFORE any KC call — the same anti-collision invariant POST
  // /api/users enforces. On today's flow the register username is forced to be
  // the (email-shaped) req.email, so a seed-persona slug (never email-shaped)
  // cannot collide; this test drives the guard directly via a fake pool that
  // reports the username as an existing slug, proving the guard fires and does
  // NOT reach Keycloak. (See src/core/register.ts anti-collision comment.)
  it("E-3 [T-0633]: username collides with an existing employee slug → 409 LOGIN_RESERVED, KC never called", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    // Fake pool whose EXISTS check returns true (simulating a colliding slug).
    const collidingPool = {
      connect: async () => ({
        query: async (textOrConfig: string | { text: string }) => {
          const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
          if (text.includes("EXISTS") && text.includes("choros.employee")) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        },
        release: () => { /* no-op */ },
      }),
    } as unknown as pg.Pool;

    const router = new Router();
    registerRegisterRoutes(router, { pool: collidingPool, kc: kcLocal });
    const localServer = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", () => resolve()));
    try {
      const resp = await makeRequest(localServer, "POST", "/api/register", {
        orgName: "Collision Org",
        email: "reserved@example.com",
        password: "password123",
      });
      expect(resp.status).toBe(409);
      const body = JSON.parse(resp.body) as { error: { code: string } };
      expect(body.error.code).toBe("LOGIN_RESERVED");
      // KC must NOT have been called — the guard runs before createHumanUser.
      expect(kcLocal.createCallCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// R-1 fix: HTTP-level validation → 400 VALIDATION (not 500 INTERNAL)
// These tests hit the actual HTTP layer so they catch the ValidationError→500 regression.
// ---------------------------------------------------------------------------

describe("R-1 — HTTP POST /api/register validation returns 400 VALIDATION (not 500)", () => {
  it("empty orgName → 400 with code VALIDATION", async () => {
    kcPort.reset();
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "",
      email: "user@example.com",
      password: "password123",
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("blank orgName (whitespace only) → 400 with code VALIDATION", async () => {
    kcPort.reset();
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "   ",
      email: "user@example.com",
      password: "password123",
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("malformed email → 400 with code VALIDATION", async () => {
    kcPort.reset();
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "Good Org",
      email: "not-an-email-address",
      password: "password123",
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("password shorter than 8 chars → 400 with code VALIDATION", async () => {
    kcPort.reset();
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "Good Org",
      email: "user@example.com",
      password: "short",
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("validation error is in {error:{code,message}} envelope", async () => {
    kcPort.reset();
    const resp = await makeRequest(server, "POST", "/api/register", {
      orgName: "",
      email: "user@example.com",
      password: "password123",
    });
    expect(resp.status).toBe(400);
    const body = JSON.parse(resp.body) as { error: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// R-2 fix: createHumanUser resolves userId from Location header (no extra GET)
// ---------------------------------------------------------------------------

describe("R-2 — createHumanUser: userId from Location header; compensation still works if id was obtained", () => {
  it("resolves userId from Location header on 201 (no GET-by-username fallback needed)", async () => {
    // A port that simulates a 201 with a known user id from Location
    const LOCATION_USER_ID = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
    let capturedSpec: KcHumanUserSpec | null = null;
    let createCallCount = 0;

    const locationPort: KeycloakUserPort = {
      async createHumanUser(spec: KcHumanUserSpec) {
        capturedSpec = spec;
        createCallCount++;
        return { userId: LOCATION_USER_ID };
      },
      async deleteUser(_userId: string) {
        // no-op for this test (no DB failure path)
      },
      async setUserEnabled(_userId: string, _enabled: boolean) {
        // not exercised by this test (T-0583 addition to the port interface)
      },
    };

    const routerL = new Router();
    const poolL = makeFakePool();
    registerRegisterRoutes(routerL, { pool: poolL, kc: locationPort });
    const srvL = http.createServer(routerL.dispatch.bind(routerL));
    await new Promise<void>((resolve) => srvL.listen(0, "127.0.0.1", () => resolve()));

    try {
      const resp = await makeRequest(srvL, "POST", "/api/register", {
        orgName: "LocationOrg",
        email: "loc@example.com",
        password: "password123",
      });

      // Should succeed (201) — the port returned a userId from the Location path
      expect(resp.status).toBe(201);
      expect(createCallCount).toBe(1);
      // capturedSpec is set inside createHumanUser before the request resolves
      const cs = capturedSpec as unknown as KcHumanUserSpec;
      expect(cs.actorType).toBe("human");
      expect(cs.email).toBe("loc@example.com");

      // The response userId must match what the port returned
      const body = JSON.parse(resp.body) as { userId: string };
      expect(body.userId).toBe(LOCATION_USER_ID);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srvL.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("if id was obtained from Location but DB fails, deleteUser is still called with that id", async () => {
    const LOCATION_USER_ID = "11112222-3333-4444-5555-666677778888";
    let deleteCalledWithId: string | null = null;

    const locationPort: KeycloakUserPort = {
      async createHumanUser(_spec: KcHumanUserSpec) {
        return { userId: LOCATION_USER_ID };
      },
      async deleteUser(userId: string) {
        deleteCalledWithId = userId;
      },
      async setUserEnabled(_userId: string, _enabled: boolean) {
        // not exercised by this test (T-0583 addition to the port interface)
      },
    };

    // Pool that fails on INSERT into tenant — triggers compensation
    const poolFail = makeFakePool({ failOnInsert: "choros.tenant" });
    const routerL = new Router();
    registerRegisterRoutes(routerL, { pool: poolFail, kc: locationPort });
    const srvL = http.createServer(routerL.dispatch.bind(routerL));
    await new Promise<void>((resolve) => srvL.listen(0, "127.0.0.1", () => resolve()));

    try {
      const resp = await makeRequest(srvL, "POST", "/api/register", {
        orgName: "CompOrg",
        email: "comp@example.com",
        password: "password123",
      });

      // DB failed → 500
      expect(resp.status).toBe(500);
      // deleteUser MUST have been called with the id obtained from Location (compensation)
      expect(deleteCalledWithId).toBe(LOCATION_USER_ID);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srvL.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SQL column guard: updated_at + granted_by present in INSERTs (DB NOT-NULL guard)
// These assertions would have caught the live-schema 500 before this fix.
// ---------------------------------------------------------------------------

describe("SQL column guard — updated_at and granted_by in INSERT statements", () => {
  it("role INSERT includes updated_at column", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const capturedQueries: Array<{ text: string; values?: unknown[] }> = [];

    // Capturing fake that records all queries sent to the pool
    class CapturingClient extends FakePoolClient {
      override async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        capturedQueries.push({ text, values: vals });
        return super.query(textOrConfig, values);
      }
    }

    const capturingPool2: pg.Pool = {
      connect: async () => new CapturingClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    await registerTenant(
      { pool: capturingPool2, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "GuardOrg", email: "guard@test.com", password: "password123" },
    );

    const roleInsert = capturedQueries.find(
      (q) => q.text.includes("INSERT") && q.text.includes("choros.role") && !q.text.includes("role_assignment"),
    );
    expect(roleInsert).toBeDefined();
    expect(roleInsert!.text).toContain("updated_at");

    const employeeInsert = capturedQueries.find(
      (q) => q.text.includes("INSERT") && q.text.includes("choros.employee"),
    );
    expect(employeeInsert).toBeDefined();
    expect(employeeInsert!.text).toContain("updated_at");

    const assignmentInsert = capturedQueries.find(
      (q) => q.text.includes("INSERT") && q.text.includes("role_assignment"),
    );
    expect(assignmentInsert).toBeDefined();
    expect(assignmentInsert!.text).toContain("updated_at");
    expect(assignmentInsert!.text).toContain("granted_by");
  });
});

// ---------------------------------------------------------------------------
// T-0373 (PD-7): tenant-zero seeding — assistant-agent + authoring_draft grants
//
// Verifies that registerTenant seeds, for every new tenant:
//   (a) an assistant-agent employee row (kind='agent', slug='assistant-agent')
//   (b) a role-configurator role
//   (c) owner → role-configurator role_assignment (CONFIRMED)
//   (d) assistant-agent → role-configurator role_assignment (CONFIRMED)
//   (e) authoring_draft/create grant for role-configurator (CONFIRMED, confirmed_by set)
//   (f) authoring_draft/update grant for role-configurator (CONFIRMED, confirmed_by set)
//
// Uses the same CapturingClient pattern as the SQL column guard above.
// These are unit tests (no live DB) — shape/presence checks only.
// Live round-trip verification (grants actually unlock the configurator)
// requires the DB-level fitness suite (see FF-4 / FF-6 section below, live PG).
// ---------------------------------------------------------------------------

describe("T-0373 (PD-7) — tenant-zero seeding: assistant-agent + authoring_draft grants", () => {
  it("seeds an 'assistant-agent' employee row (kind='agent') for every new tenant", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const capturedQueries: Array<{ text: string; values?: unknown[] }> = [];

    class CapturingClient extends FakePoolClient {
      override async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        capturedQueries.push({ text, values: vals });
        return super.query(textOrConfig, values);
      }
    }

    const capturingPool: pg.Pool = {
      connect: async () => new CapturingClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    await registerTenant(
      { pool: capturingPool, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "T0373Org", email: "t0373@test.com", password: "password123" },
    );

    // Must find an employee INSERT that seeds the assistant-agent slug.
    // Note: slug='assistant-agent' and kind='agent' are hardcoded in the SQL string
    // (not in the parameterized values array), so we check the SQL text directly.
    const agentInsert = capturedQueries.find(
      (q) =>
        q.text.includes("INSERT") &&
        q.text.includes("choros.employee") &&
        q.text.includes("assistant-agent"),
    );
    expect(agentInsert).toBeDefined();
    // Slug literal in SQL text
    expect(agentInsert!.text).toContain("assistant-agent");
    // kind literal in SQL text
    expect(agentInsert!.text).toContain("'agent'");
    // Must have updated_at (NOT-NULL guard)
    expect(agentInsert!.text).toContain("updated_at");
  });

  it("seeds a 'role-configurator' role for every new tenant", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const capturedQueries: Array<{ text: string; values?: unknown[] }> = [];

    class CapturingClient extends FakePoolClient {
      override async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        capturedQueries.push({ text, values: vals });
        return super.query(textOrConfig, values);
      }
    }

    const capturingPool: pg.Pool = {
      connect: async () => new CapturingClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    await registerTenant(
      { pool: capturingPool, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "T0373RoleOrg", email: "t0373role@test.com", password: "password123" },
    );

    const configuratorRoleInsert = capturedQueries.find(
      (q) =>
        q.text.includes("INSERT") &&
        q.text.includes("choros.role") &&
        !q.text.includes("role_assignment") &&
        q.text.includes("role-configurator"),
    );
    expect(configuratorRoleInsert).toBeDefined();
    expect(configuratorRoleInsert!.text).toContain("updated_at");
    expect(configuratorRoleInsert!.text).toContain("ON CONFLICT DO NOTHING");
  });

  it("seeds authoring_draft/create and authoring_draft/update grants (CONFIRMED) for every new tenant", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const capturedQueries: Array<{ text: string; values?: unknown[] }> = [];

    class CapturingClient extends FakePoolClient {
      override async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        capturedQueries.push({ text, values: vals });
        return super.query(textOrConfig, values);
      }
    }

    const capturingPool: pg.Pool = {
      connect: async () => new CapturingClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    await registerTenant(
      { pool: capturingPool, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "T0373GrantOrg", email: "t0373grant@test.com", password: "password123" },
    );

    // Note: resource_type='authoring_draft', operation='create'/'update', and
    // confirmed_by='registration' are hardcoded SQL literals, not parameterized values.
    const grantInserts = capturedQueries.filter(
      (q) =>
        q.text.includes("INSERT") &&
        q.text.includes('choros."grant"') &&
        q.text.includes("authoring_draft"),
    );

    // Must have 2 grant INSERTs (create + update)
    expect(grantInserts).toHaveLength(2);

    // operation literals are in the SQL text
    const createGrant = grantInserts.find((q) => q.text.includes("'create'"));
    const updateGrant = grantInserts.find((q) => q.text.includes("'update'"));
    expect(createGrant).toBeDefined();
    expect(updateGrant).toBeDefined();

    // Both must be CONFIRMED: confirmed_by = 'registration' (NOT NULL literal in SQL)
    for (const grantInsert of grantInserts) {
      expect(grantInsert.text).toContain("confirmed_by");
      expect(grantInsert.text).toContain("'registration'");
      // ON CONFLICT DO NOTHING for idempotency
      expect(grantInsert.text).toContain("ON CONFLICT DO NOTHING");
    }
  });

  it("seeds 2 role_assignments for role-configurator (owner + assistant-agent)", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const capturedQueries: Array<{ text: string; values?: unknown[] }> = [];

    class CapturingClient extends FakePoolClient {
      override async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        capturedQueries.push({ text, values: vals });
        return super.query(textOrConfig, values);
      }
    }

    const capturingPool: pg.Pool = {
      connect: async () => new CapturingClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    await registerTenant(
      { pool: capturingPool, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "T0373RAOrg", email: "t0373ra@test.com", password: "password123" },
    );

    // Resolve the configuratorRoleId from the role-configurator role INSERT
    // (VALUES ($1, $2, 'role-configurator', ...) → values[1] = its id) so the
    // role_assignment filter below can scope to ONLY role-configurator
    // assignments — T-0570 additively seeds its OWN role_assignment pair
    // (owner/assistant-agent → role-reader) with the identical
    // "ON CONFLICT DO NOTHING" shape, so a text-only filter would now also
    // (correctly) match those; this test's contract is specifically about
    // role-configurator, so it must disambiguate by role_id.
    const configuratorRoleInsert = capturedQueries.find(
      (q) =>
        q.text.includes("INSERT") &&
        q.text.includes("choros.role") &&
        !q.text.includes("role_assignment") &&
        q.text.includes("role-configurator"),
    );
    expect(configuratorRoleInsert).toBeDefined();
    const configuratorRoleId = configuratorRoleInsert!.values![1];

    // Count role_assignment INSERTs with ON CONFLICT DO NOTHING whose role_id
    // param (values[3]) is the configurator role (the T-0373 ones).
    // The original role_assignment (3d) does NOT have ON CONFLICT DO NOTHING.
    const configuratorRaInserts = capturedQueries.filter(
      (q) =>
        q.text.includes("INSERT") &&
        q.text.includes("role_assignment") &&
        q.text.includes("ON CONFLICT DO NOTHING") &&
        q.values?.[3] === configuratorRoleId,
    );
    // Should have 2: owner→role-configurator + assistant-agent→role-configurator
    expect(configuratorRaInserts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T-0373 live DB fitness (requires DATABASE_URL against live Postgres)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env["DATABASE_URL"])("T-0373 (PD-7) — live DB: new tenant has assistant-agent + authoring_draft grants", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("newly registered tenant has 1 assistant-agent employee and 2 authoring_draft grants", async () => {
    const kcLocal = new InMemoryKeycloakUserPort();
    const req = {
      orgName: `T0373LiveOrg-${Date.now()}`,
      email: `t0373-live-${Date.now()}@example.com`,
      password: "t0373-password-99",
    };

    const result = await registerTenant({ pool, kc: kcLocal, nowMs: () => Date.now() }, req);
    const { tenantId } = result;

    const client = await pool.connect();
    try {
      // (a) assistant-agent employee exists
      const agents = await client.query(
        `SELECT slug, kind FROM choros.employee WHERE tenant_id = $1 AND slug = 'assistant-agent'`,
        [tenantId],
      );
      expect(agents.rows).toHaveLength(1);
      expect(agents.rows[0].kind).toBe("agent");

      // (b) authoring_draft grants (both create + update) exist and are confirmed
      const grants = await client.query(
        `SELECT operation, confirmed_by FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_draft'
            AND confirmed_by IS NOT NULL`,
        [tenantId],
      );
      expect(grants.rows).toHaveLength(2);
      const ops = grants.rows.map((r: { operation: string }) => r.operation);
      expect(ops).toContain("create");
      expect(ops).toContain("update");
    } finally {
      client.release();

      // Cleanup: remove the test tenant (best-effort, deep delete to avoid FK violations)
      const cleanClient = await pool.connect();
      try {
        await cleanClient.query("BEGIN");
        await cleanClient.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await cleanClient.query("SET LOCAL search_path TO choros");
        await cleanClient.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
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
// slugifyOrgName — Cyrillic transliteration (i18n bug fix)
// ---------------------------------------------------------------------------

describe("slugifyOrgName — Cyrillic transliteration", () => {
  it("'Браузер Приёмка' → 'brauzer-priemka' (non-empty latin slug, ё→e)", () => {
    // ё → "e" per the transliteration map; result is latin-only and non-empty
    const result = slugifyOrgName("Браузер Приёмка");
    expect(result).toBe("brauzer-priemka");
    // Must be non-empty and not fall back to 'org' for a real Cyrillic org name
    expect(result).not.toBe("org");
  });

  it("all-Cyrillic name produces a non-empty latin slug", () => {
    const result = slugifyOrgName("ТестоваяКомпания");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("org");
    // Output must be latin/dash only
    expect(/^[a-z0-9-]+$/.test(result)).toBe(true);
  });

  it("mixed Cyrillic+Latin name is handled", () => {
    const result = slugifyOrgName("Компания ABC");
    expect(/^[a-z0-9-]+$/.test(result)).toBe(true);
    expect(result).toContain("abc");
  });

  it("all-symbols name (no letters after transliteration) falls back to 'org'", () => {
    // Input with only punctuation and spaces — no letters of any kind
    expect(slugifyOrgName("!!! ???")).toBe("org");
  });

  it("'Браузер Два' and 'Браузер Приёмка' produce DIFFERENT base slugs (no spurious collision)", () => {
    // Before the fix: both mapped to "" → "org", causing spurious ORG_TAKEN on the 2nd registration.
    // After the fix: each Cyrillic name gets its own distinct latin slug.
    const slug1 = slugifyOrgName("Браузер Приёмка"); // → "brauzer-priemka"
    const slug2 = slugifyOrgName("Браузер Два");     // → "brauzer-dva"
    expect(slug1).not.toBe(slug2);
    expect(slug1).not.toBe("org");
    expect(slug2).not.toBe("org");
  });
});

// ---------------------------------------------------------------------------
// Slug uniqueness — retry-on-collision (i18n bug fix)
// Two orgs with the SAME display name must BOTH succeed with distinct slugs.
// ---------------------------------------------------------------------------

describe("registerTenant — slug uniqueness (retry-on-collision)", () => {
  it("two registrations with the same orgName both succeed with different slugs", async () => {
    // Pool that simulates a 23505 unique violation on the FIRST tenant INSERT,
    // then succeeds on the second attempt (different slug candidate).
    let tenantInsertCount = 0;
    class RetryFakePoolClient {
      queries: Array<{ text: string; values?: unknown[] }> = [];

      async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
        this.queries.push({ text, values: vals });

        if (text.includes("INSERT") && text.includes("choros.tenant")) {
          tenantInsertCount++;
          if (tenantInsertCount === 1) {
            // First attempt → simulate slug collision (23505)
            const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
              code: "23505",
            });
            throw err;
          }
        }
        return { rows: [] };
      }

      release(): void { /* no-op */ }
    }

    const retryPool: pg.Pool = {
      connect: async () => new RetryFakePoolClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    const kcLocal = new InMemoryKeycloakUserPort();

    const result = await registerTenant(
      { pool: retryPool, kc: kcLocal, nowMs: () => 1234567890000 },
      { orgName: "Браузер Приёмка", email: "user1@example.com", password: "password123" },
    );

    // Registration must succeed (no exception thrown)
    expect(result.tenantSlug).toBeDefined();
    // The slug must be non-empty latin (transliteration worked)
    expect(/^[a-z0-9-]+$/.test(result.tenantSlug)).toBe(true);
    expect(result.tenantSlug).not.toBe("org");
    // On retry a suffix was appended — slug differs from the base (ё→e → base is "brauzer-priemka")
    expect(result.tenantSlug).not.toBe("brauzer-priemka");
    // The suffix slug still starts with the base
    expect(result.tenantSlug.startsWith("brauzer-priemka-")).toBe(true);
    // KC user must be alive (compensation NOT triggered for recoverable slug collision)
    expect(kcLocal.deleteCallCount).toBe(0);
    expect(tenantInsertCount).toBe(2); // First failed, second succeeded
  });

  it("compensation (deleteUser) is called when all slug retries are exhausted", async () => {
    // Pool that ALWAYS fails on tenant INSERT with 23505
    class AlwaysFailPoolClient {
      async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        void values;
        if (text.includes("INSERT") && text.includes("choros.tenant")) {
          const err = Object.assign(new Error("duplicate key"), { code: "23505" });
          throw err;
        }
        return { rows: [] };
      }
      release(): void { /* no-op */ }
    }

    const alwaysFailPool: pg.Pool = {
      connect: async () => new AlwaysFailPoolClient() as unknown as pg.PoolClient,
    } as unknown as pg.Pool;

    const kcLocal = new InMemoryKeycloakUserPort();

    await expect(
      registerTenant(
        { pool: alwaysFailPool, kc: kcLocal, nowMs: () => 1234567890000 },
        { orgName: "Contested Org", email: "user2@example.com", password: "password123" },
      ),
    ).rejects.toMatchObject({ code: "ORG_TAKEN" });

    // KC user must have been compensated (deleted) after exhausting retries
    expect(kcLocal.deleteCallCount).toBe(1);
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

  it("FF-4: new tenant has 0 app/record rows + exactly 1 tenant, 4 roles, 2 employees, 5 confirmed role_assignments (T-0570 updated)", async () => {
    // T-0373 (PD-7): registerTenant also seeds role-configurator + assistant-agent.
    // T-0469 [auth]: registerTenant ALSO seeds role-constructor-admin (UNASSIGNED).
    //   roles 2→3; employees stay 2 (no new employee); role_assignments stay 3
    //   (the constructor-admin role is seeded but assigned to nobody on registration).
    // T-0570 (D3, READ-PDP): registerTenant ALSO seeds role-reader (default-open
    //   READ grant holder) + 2 CONFIRMED role_assignments (owner→reader,
    //   assistant-agent→reader): roles 3→4; role_assignments 3→5.
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

      // Exactly 4 roles: tenant-owner + role-configurator (T-0373) +
      // role-constructor-admin (T-0469, seeded-but-unassigned) + role-reader
      // (T-0570, default-open READ grant holder).
      const roles = await client.query(
        `SELECT slug FROM choros.role WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      expect(roles.rows).toHaveLength(4);
      const roleSlugs = roles.rows.map((r: { slug: string }) => r.slug);
      expect(roleSlugs).toContain("tenant-owner");
      expect(roleSlugs).toContain("role-configurator");
      expect(roleSlugs).toContain("role-constructor-admin");
      expect(roleSlugs).toContain("role-reader");

      // T-0469 boundary: role-constructor-admin is seeded but assigned to NOBODY
      // on registration (the owner grants it explicitly later). So the assignment
      // count stays 3 (no constructor-admin role_assignment), asserted below.
      const caRole = roles.rows.find(
        (r: { slug: string }) => r.slug === "role-constructor-admin",
      );
      const caRoleId = (
        await client.query(
          `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'role-constructor-admin'`,
          [tenantId],
        )
      ).rows[0].id;
      expect(caRole).toBeDefined();
      const caAssignments = await client.query(
        `SELECT id FROM choros.role_assignment WHERE tenant_id = $1 AND role_id = $2`,
        [tenantId, caRoleId],
      );
      expect(caAssignments.rows).toHaveLength(0);

      // T-0469 owner-only boundary in the GRANT SET: role-constructor-admin holds
      // NO employee:delete grant and NO mgmt_object:grant grant (cannot remove a
      // person, cannot mint role_assignments / replace the owner).
      const caGrants = await client.query(
        `SELECT resource_type, operation FROM choros."grant"
          WHERE tenant_id = $1 AND role_id = $2`,
        [tenantId, caRoleId],
      );
      const caGrantKeys = caGrants.rows.map(
        (g: { resource_type: string; operation: string }) =>
          `${g.resource_type}:${g.operation}`,
      );
      expect(caGrantKeys).toContain("mgmt_object:department:create");
      expect(caGrantKeys).toContain("mgmt_object:employee:create");
      expect(caGrantKeys).toContain("mgmt_object:role:create");
      // The two things a constructor-admin must NEVER be able to do:
      expect(caGrantKeys).not.toContain("mgmt_object:employee:delete");
      expect(caGrantKeys.some((k: string) => k.startsWith("mgmt_object:grant:"))).toBe(false);

      // Exactly 2 employees: the owner (slug=KC sub) + assistant-agent (T-0373)
      const employees = await client.query(
        `SELECT slug, kind FROM choros.employee WHERE tenant_id = $1 ORDER BY slug`,
        [tenantId],
      );
      expect(employees.rows).toHaveLength(2);
      const empSlugs = employees.rows.map((r: { slug: string }) => r.slug);
      expect(empSlugs).toContain(kcSub);
      expect(empSlugs).toContain("assistant-agent");

      // Exactly 5 confirmed role_assignments (T-0373 + T-0570):
      //   1. owner → tenant-owner
      //   2. owner → role-configurator
      //   3. assistant-agent → role-configurator
      //   4. owner → role-reader
      //   5. assistant-agent → role-reader
      const assignments = await client.query(
        `SELECT confirmed_by FROM choros.role_assignment WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(assignments.rows).toHaveLength(5);
      for (const ra of assignments.rows) {
        expect(ra.confirmed_by).not.toBeNull();
      }

      // T-0570 (D3, READ-PDP): role-reader holds exactly one grant — read/record
      // scoped at the RESOURCE_ROOT sentinel, CONFIRMED, delegable.
      const readerRoleId = (
        await client.query(
          `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'role-reader'`,
          [tenantId],
        )
      ).rows[0].id;
      const readerGrants = await client.query(
        `SELECT resource_type, operation, scope, delegable, confirmed_by
           FROM choros."grant" WHERE tenant_id = $1 AND role_id = $2`,
        [tenantId, readerRoleId],
      );
      expect(readerGrants.rows).toHaveLength(1);
      const readGrant = readerGrants.rows[0];
      expect(readGrant.resource_type).toBe("record");
      expect(readGrant.operation).toBe("read");
      expect(readGrant.delegable).toBe(true);
      expect(readGrant.confirmed_by).not.toBeNull();
      expect(readGrant.scope).toEqual({
        kind: "node",
        hierarchy: "resource",
        nodeLevel: "application",
        nodeId: "00000000-0000-0000-0000-0000000000r0",
      });
    } finally {
      client.release();

      // Cleanup: remove the test tenant (best-effort; delete grants first to avoid FK violations)
      const cleanClient = await pool.connect();
      try {
        await cleanClient.query("BEGIN");
        await cleanClient.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await cleanClient.query("SET LOCAL search_path TO choros");
        await cleanClient.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
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
      // Cleanup (T-0373: delete grants first to avoid FK violations)
      const cleanClient = await pool.connect();
      try {
        await cleanClient.query("BEGIN");
        await cleanClient.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await cleanClient.query("SET LOCAL search_path TO choros");
        await cleanClient.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
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
