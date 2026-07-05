/**
 * src/__tests__/seed-write.auto-slug.test.ts — T-0650 [W4-UX §7]
 *
 * Proves POST /api/departments, /api/positions, /api/employees, /api/roles accept
 * an OMITTED (or blank-string) `slug` and auto-generate one from the entity's
 * display name (auto-slugs — see ADR-T0650-auto-slugs.md), while an EXPLICIT slug
 * still validates/behaves exactly as before (backward compatible, no DB needed —
 * mirrors the scripted stub-pool harness of seed-write.authz.test.ts).
 *
 * The stub pool distinguishes queries by SQL substring (same convention as
 * seed-write.authz.test.ts) and additionally simulates a UNIQUE-constraint
 * collision (pg 23505) on specific INSERT candidate slugs so the retry-on-conflict
 * atomic suffix resolution (insertWithUniqueSlugRetry) is exercised end-to-end
 * through the real HTTP route — not just the pure generator unit tests.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerSeedWriteRoutes } from "../http/seed-write.js";

const TENANT_A = "aaaaaaaa-1111-0000-0000-000000000001";

/**
 * Scripted stub pg.Pool — the caller is always the genesis owner of TENANT_A
 * (so the authorizeOrgWrite / delegation gates always pass). `takenSlugs` is a
 * set of INSERT slug values that should be reported as ALREADY EXISTING (pg
 * 23505 unique_violation) — everything else succeeds.
 */
function makeStubPool(takenSlugs: Set<string> = new Set()): pg.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: slug → caller's tenant (always TENANT_A here).
      if (text.includes("JOIN choros.tenant") && text.includes("CASE WHEN t.slug")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // loadAdminContext: tenant-owner role lookup → always owner of TENANT_A.
      if (text.includes("tenant-owner") && text.includes("role_assignment")) {
        return { rows: [{ id: "ra-1" }], rowCount: 1 };
      }

      // loadAdminContext: assignment list (owner short-circuits → none needed).
      if (text.includes("ra.id") && text.includes("ra.org_scope")) {
        return { rows: [], rowCount: 0 };
      }

      // INSERT into the four org tables — simulate a collision for a specific
      // slug candidate (the LAST bound parameter of the value-tuple that carries
      // the slug varies per table, so we just scan ALL params for a match).
      if (text.trim().toUpperCase().startsWith("INSERT INTO CHOROS.")) {
        const hitsTaken = Array.isArray(params) && params.some((p) => typeof p === "string" && takenSlugs.has(p));
        if (hitsTaken) {
          const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
          err.code = "23505";
          throw err;
        }
        return { rows: [], rowCount: 1 };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-ops.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startTestServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
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

// ---------------------------------------------------------------------------
// Department
// ---------------------------------------------------------------------------

describe("T-0650: POST /api/departments — auto-slug", () => {
  it("omitted slug → 201 with a slug auto-derived from display_name", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        display_name: "Отдел продаж",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("otdel-prodazh");
    } finally {
      await close();
    }
  });

  it("blank-string slug is treated as omitted (auto-generates)", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        slug: "",
        display_name: "Отдел продаж",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("otdel-prodazh");
    } finally {
      await close();
    }
  });

  it("collision on the base slug → atomic -2 suffix (not 409)", async () => {
    const { port, close } = await startTestServer(makeStubPool(new Set(["otdel-prodazh"])));
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        display_name: "Отдел продаж",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("otdel-prodazh-2");
    } finally {
      await close();
    }
  });

  it("explicit slug still works exactly as before (backward compat)", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        slug: "ops",
        display_name: "Operations",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("ops");
    } finally {
      await close();
    }
  });

  it("explicit slug collision → 409 CONFLICT (unchanged behavior, no auto-suffix)", async () => {
    const { port, close } = await startTestServer(makeStubPool(new Set(["ops"])));
    try {
      const resp = await post(port, "/api/departments", {
        tenant_id: TENANT_A,
        slug: "ops",
        display_name: "Operations",
      });
      expect(resp.status).toBe(409);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

describe("T-0650: POST /api/positions — auto-slug", () => {
  it("omitted slug → 201 with a slug auto-derived from title", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/positions", {
        tenant_id: TENANT_A,
        department_id: "dddddddd-0000-0000-0000-000000000001",
        title: "Ведущий специалист",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("veduschiy-spetsialist");
    } finally {
      await close();
    }
  });

  it("collision on the base slug → atomic -2 suffix", async () => {
    const { port, close } = await startTestServer(makeStubPool(new Set(["veduschiy-spetsialist"])));
    try {
      const resp = await post(port, "/api/positions", {
        tenant_id: TENANT_A,
        department_id: "dddddddd-0000-0000-0000-000000000001",
        title: "Ведущий специалист",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("veduschiy-spetsialist-2");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

describe("T-0650: POST /api/employees — auto-slug", () => {
  it("omitted slug → 201 with a slug auto-derived from display_name", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        display_name: "Дж. Доу",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("dzh-dou");
    } finally {
      await close();
    }
  });

  it("collision on the base slug → atomic -2 suffix", async () => {
    const { port, close } = await startTestServer(makeStubPool(new Set(["dzh-dou"])));
    try {
      const resp = await post(port, "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        display_name: "Дж. Доу",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("dzh-dou-2");
    } finally {
      await close();
    }
  });

  it("explicit slug still validates as before (regression)", async () => {
    const { port, close } = await startTestServer(makeStubPool());
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
});

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

describe("T-0650: POST /api/roles — auto-slug", () => {
  it("omitted slug → 201 with a slug auto-derived from display_name", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/roles", {
        tenant_id: TENANT_A,
        display_name: "Согласующий",
      });
      expect(resp.status).toBe(201);
      const slug = (resp.body as { slug: string }).slug;
      expect(slug).toBe("soglasuyuschiy");
      // Anti-regression (T-0642): even the auto-generated slug must satisfy the
      // charset gate (it always does, by construction of generateSlugFromName).
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    } finally {
      await close();
    }
  });

  it("collision on the base slug → atomic -2 suffix (not 409)", async () => {
    const { port, close } = await startTestServer(makeStubPool(new Set(["soglasuyuschiy"])));
    try {
      const resp = await post(port, "/api/roles", {
        tenant_id: TENANT_A,
        display_name: "Согласующий",
      });
      expect(resp.status).toBe(201);
      expect((resp.body as { slug: string }).slug).toBe("soglasuyuschiy-2");
    } finally {
      await close();
    }
  });

  it("explicit invalid slug still 400s (T-0642 charset gate unchanged)", async () => {
    const { port, close } = await startTestServer(makeStubPool());
    try {
      const resp = await post(port, "/api/roles", {
        tenant_id: TENANT_A,
        slug: "Not A Slug!",
        display_name: "Bad Slug Role",
      });
      expect(resp.status).toBe(400);
    } finally {
      await close();
    }
  });
});
