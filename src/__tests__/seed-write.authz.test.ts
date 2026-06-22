/**
 * src/__tests__/seed-write.authz.test.ts — T-0388 [D1]
 *
 * Proves the org-write ownership gate is resolved against the CALLER's OWN
 * tenant (derived from identity), NOT a hardcoded DEV_TENANT_ID.
 *
 * The bug (B6): a self-registered owner — who holds the tenant-owner role in
 * THEIR tenant — got 403 NOT_OWNER because the gate checked ownership against
 * DEV_TENANT_ID (where they hold no role). The fix loads loadAdminContext
 * against the caller's resolved tenant and requires body/param tenant_id ==
 * the caller's own tenant.
 *
 * Central security property proven here:
 *   (a) a tenant's own owner CAN write into THEIR tenant            → 201
 *   (b) a caller CANNOT write into a DIFFERENT tenant (cross-tenant) → 403
 *   (c) a non-owner of their own tenant is still rejected           → 403
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the two queries the
 * gate runs — resolveActorTenant (slug → caller's tenant) and loadAdminContext
 * (tenant-owner role lookup against the tenant passed in). The stub answers the
 * owner lookup TRUE only when the queried tenant is one the caller actually
 * owns, so a cross-tenant attempt is rejected by assertCallerOwnsTenant BEFORE
 * the gate, and an own-tenant attempt by a non-owner is rejected by the gate.
 *
 * Runs in dev auth mode (x-dev-user header) so no JWKS/keycloak network is
 * touched; the slug→tenant→owner resolution under test is auth-mode-independent.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerSeedWriteRoutes } from "../http/seed-write.js";

// ---------------------------------------------------------------------------
// Fixtures: two distinct tenants
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001"; // caller's own tenant
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002"; // a different tenant
const DEPT_ID = "cccccccc-0000-0000-0000-000000000003";
// The bootstrap silo (matches src/http/seed-write.ts DEV_TENANT_ID default). The
// genesis owner of THIS tenant is the forest-owner / importer super-admin who may
// write cross-tenant (seed-pack flow). DEV_TENANT_ID env is not set in tests.
const DEV_TENANT = "a0000000-0000-0000-0000-000000000001";

/**
 * Scripted stub pg.Pool.
 *
 * @param callerTenant  what resolveActorTenant returns for the caller's slug.
 * @param ownedTenants  the set of tenant UUIDs for which the caller holds the
 *                      tenant-owner role (loadAdminContext owner lookup → 1 row).
 *
 * The stub distinguishes queries by SQL substring:
 *   - resolveActorTenant: SELECTs e.tenant_id with a `JOIN choros.tenant` and a
 *     `CASE WHEN t.slug` ORDER BY → returns the configured callerTenant.
 *   - loadAdminContext owner lookup: contains `r.slug = 'tenant-owner'` and is
 *     parameterised by [tenantId, slug, nowMs] → returns 1 row iff that tenantId
 *     ∈ ownedTenants.
 *   - loadAdminContext assignment lookup (`SELECT ra.id, ra.role_id, ra.org_scope`)
 *     → empty (owner short-circuits, no grants needed).
 *   - BEGIN / SET LOCAL / COMMIT / ROLLBACK / INSERT → no-ops returning {rows:[]}.
 */
function makeStubPool(callerTenant: string, ownedTenants: string[]): pg.Pool {
  const owned = new Set(ownedTenants);
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: slug → caller's tenant
      if (text.includes("JOIN choros.tenant") && text.includes("CASE WHEN t.slug")) {
        return { rows: [{ tenant_id: callerTenant }], rowCount: 1 };
      }

      // loadAdminContext: tenant-owner role lookup, param[0] = tenantId
      if (text.includes("tenant-owner") && text.includes("role_assignment")) {
        const tenantId = Array.isArray(params) ? (params[0] as string) : undefined;
        const isOwner = tenantId !== undefined && owned.has(tenantId);
        return { rows: isOwner ? [{ id: "ra-1" }] : [], rowCount: isOwner ? 1 : 0 };
      }

      // loadAdminContext: assignment list (owner short-circuits → none needed)
      if (text.includes("ra.id") && text.includes("ra.org_scope")) {
        return { rows: [], rowCount: 0 };
      }

      // INSERT / BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op success
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// In-process server harness (mirrors floor1-editor.test.ts pattern)
// ---------------------------------------------------------------------------

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerSeedWriteRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e: Error | undefined) => (e ? reject(e) : resolve())),
      ),
  };
}

async function post(
  port: number,
  path: string,
  body: unknown,
  devUser = "e-owner-a",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(devUser ? { "x-dev-user": devUser } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// ---------------------------------------------------------------------------
// (a) Own-tenant owner CAN write — the B6 fix
// ---------------------------------------------------------------------------

describe("T-0388 (a) — a tenant's own owner CAN write into their tenant", () => {
  it("POST /api/employees into own tenant → 201 (was 403 against DEV_TENANT_ID)", async () => {
    // Caller resolves to TENANT_A and owns TENANT_A.
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        slug: "e-new",
        display_name: "New Person",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("e-new");
    } finally {
      await close();
    }
  });

  it("POST /api/departments into own tenant → 201", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        slug: "ops",
        display_name: "Operations",
      });
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("POST /api/roles into own tenant → 201 (delegation gate via genesis owner)", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/roles", {
        tenant_id: TENANT_A,
        slug: "manager",
        display_name: "Manager",
      });
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("POST /api/positions into own tenant → 201", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/positions", {
        tenant_id: TENANT_A,
        department_id: DEPT_ID,
        slug: "lead",
        title: "Team Lead",
      });
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Cross-tenant write is BLOCKED — the central security property
// ---------------------------------------------------------------------------

describe("T-0388 (b) — a caller CANNOT write into a different tenant (cross-tenant 403)", () => {
  it("owner of TENANT_A writing into TENANT_B → 403 NOT_OWNER", async () => {
    // Caller resolves to TENANT_A and owns TENANT_A — but the body targets TENANT_B.
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: TENANT_B, // foreign tenant
        kind: "human",
        slug: "e-intruder",
        display_name: "Intruder",
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("cross-tenant department create → 403 NOT_OWNER", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_B,
        slug: "foreign",
        display_name: "Foreign Dept",
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("cross-tenant role create → 403 NOT_OWNER", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/roles", {
        tenant_id: TENANT_B,
        slug: "foreign-role",
        display_name: "Foreign Role",
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("cross-tenant DELETE employee → 403 NOT_OWNER", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const payload = JSON.stringify({ tenant_id: TENANT_B });
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/employees/${"dddddddd-0000-0000-0000-000000000004"}`,
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              "x-dev-user": "e-owner-a",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (c: Buffer) => (data += c.toString()));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
              } catch {
                resolve({ status: res.statusCode ?? 0, body: data });
              }
            });
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b2) Forest-owner exemption — the bootstrap genesis owner (importer) MAY write
// cross-tenant. This preserves the seed-pack importer (runs as e-owner, the
// dev-silo genesis owner, seeding arbitrary fresh tenants).
// ---------------------------------------------------------------------------

describe("T-0388 (b2) — the bootstrap forest-owner MAY write cross-tenant (importer)", () => {
  it("genesis owner of DEV_TENANT writing into a fresh tenant → 201", async () => {
    // Caller's own employee row lives in the dev silo → resolveActorTenant returns
    // DEV_TENANT; caller owns DEV_TENANT (forest-owner). Target = TENANT_B (fresh).
    const { port, close } = await startTestServer(makeStubPool(DEV_TENANT, [DEV_TENANT]));
    try {
      const resp = await post(
        port,
        "/api/employees",
        { tenant_id: TENANT_B, kind: "human", slug: "e-seeded", display_name: "Seeded" },
        "e-owner",
      );
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("a NON-forest owner (owns only TENANT_A) cannot write into the dev silo → 403", async () => {
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, [TENANT_A]));
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: DEV_TENANT,
        kind: "human",
        slug: "e-x",
        display_name: "X",
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Non-owner of own tenant is still rejected (NF-3: owner-ness from DB)
// ---------------------------------------------------------------------------

describe("T-0388 (c) — a non-owner of their own tenant is still rejected (403)", () => {
  it("caller resolves to TENANT_A but owns NOTHING → 403 NOT_OWNER on own-tenant write", async () => {
    // callerTenant = TENANT_A, owns [] → assertCallerOwnsTenant passes (same tenant)
    // but loadAdminContext finds no tenant-owner role → gate rejects.
    const { port, close } = await startTestServer(makeStubPool(TENANT_A, []));
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        slug: "e-x",
        display_name: "X",
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });
});
