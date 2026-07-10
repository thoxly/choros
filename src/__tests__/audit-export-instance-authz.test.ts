/**
 * src/__tests__/audit-export-instance-authz.test.ts — T-0737 [security P1]
 *
 * GET /api/audit/export and GET /api/audit/:instanceId used to carry NO
 * authority gate at all — /export only checked that an x-dev-user header was
 * PRESENT (any tenant member, or in keycloak mode any authenticated caller);
 * /:instanceId checked NOTHING (dev-mode auth is a no-op, and this route had
 * no per-route check either — an unauthenticated request got the demo trace).
 * The file's own "FORWARD-OBLIGATION" comment (present since T-0138/T-0500)
 * flagged this and required closing all three audit-surface routes together —
 * a T-0726 judge finding on T-0702's R-3 confirmed the live exposure: a
 * deactivated actor's residual JWT window would read all three unfiltered.
 *
 * Both routes now share requireAuditRead() — the SAME loadAdminContext +
 * holdsAuditRead (genesis-owner ONLY) gate as the pre-existing GET /api/audit
 * (T-0500). This suite proves the WIRING deterministically with a scripted
 * in-memory stub pg.Pool (same technique as audit-log.test.ts's T-0500 suite —
 * intercepts the resolveActorTenant / loadAdminContext query shapes without a
 * real DB), covering:
 *
 *   (1) owner reads /export (default + named instance) and /:instanceId → 200,
 *       byte-identical demo shape to before this fix (no data regression)
 *   (2) unknown instance → 404 on BOTH routes (gate passes, then lookup 404s)
 *   (3) no x-dev-user → 401 UNAUTHENTICATED on BOTH routes, BEFORE any demo
 *       lookup — this is the KEY NEW coverage for /:instanceId, which
 *       previously served the trace to a completely unauthenticated request
 *   (4) neither owner nor a delegable mgmt_object:* grant → 403
 *       ADMIN_GATE_REJECTED on BOTH routes (T-0500 review: audit read stays
 *       owner-only, a scoped mgmt grant must not open it)
 *   (5) no pool wired (memory mode) → 503 AUDIT_UNAVAILABLE on BOTH routes —
 *       the gate itself needs a DB read, so it cannot fail open
 *   (6) /api/audit/export is still NOT captured by the /:instanceId route
 *       (registration order regression, T-0138 AC-6)
 *
 * REAL deactivation-predicate behaviour (an actor whose employee.deactivated_at
 * is set) is proven against LIVE Postgres in
 * ci/checks/db/audit-route-deactivation-gate.db.test.ts — this stub cannot
 * exercise the SQL predicate itself (queries are intercepted by text-pattern,
 * not executed), only that the gate is APPLIED and yields the right decision
 * for the owner/non-owner shapes loadAdminContext already returns.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerAuditRoutes } from "../http/audit.js";
import type { AuditData } from "../http/audit.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";
const DEPT_ID = "dddddddd-0000-0000-0000-000000000004";

interface Scenario {
  tenantId: string;
  isOwner: boolean;
  hasMgmtGrant: boolean;
}

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return { tenantId: TENANT_A, isOwner: true, hasMgmtGrant: false, ...over };
}

/** Same intercept shapes as audit-log.test.ts's T-0500 makePool (no audit_event
 *  handling needed here — /export and /:instanceId never touch that table). */
function makePool(s: Scenario): pg.Pool {
  const client = {
    query: async (text: string) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: employee ⋈ tenant slug → tenant_id.
      if (text.includes("FROM choros.employee e") && text.includes("JOIN choros.tenant t")) {
        return { rows: [{ tenant_id: s.tenantId }], rowCount: 1 };
      }

      // loadAdminContext step 1: tenant-owner role lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return s.isOwner
          ? { rows: [{ id: "ra-owner" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // loadAdminContext step 2: confirmed in-window assignments for the actor.
      if (text.includes("SELECT ra.id, ra.role_id, ra.org_scope")) {
        return {
          rows: [
            {
              id: "ra-1",
              role_id: ROLE_ID,
              org_scope: { kind: "node", hierarchy: "org", nodeId: DEPT_ID, nodeLevel: "department" },
            },
          ],
          rowCount: 1,
        };
      }

      // loadAdminContext step 3: delegable mgmt_object:* grants on the role.
      if (text.includes('choros."grant"') && text.includes("mgmt_object:")) {
        if (!s.hasMgmtGrant) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: "g-1",
              role_id: ROLE_ID,
              resource_type: "mgmt_object:org",
              resource_facet: null,
              operation: "update",
              scope: { kind: "node", hierarchy: "org", nodeId: DEPT_ID, nodeLevel: "department" },
              constraint: null,
              delegable: true,
              granted_by: "seed",
              valid_from: null,
              valid_until: null,
              created_at: "0",
            },
          ],
          rowCount: 1,
        };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op OK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool | undefined): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerAuditRoutes(router, undefined, pool);
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

function request(
  port: number,
  path: string,
  opts: { devUser?: string | null } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.devUser !== null) headers["x-dev-user"] = opts.devUser ?? "e-owner";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : null, raw: data });
          } catch {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// ---------------------------------------------------------------------------
// (1) owner — 200 with regression-safe demo shape.
// ---------------------------------------------------------------------------

describe("T-0737 (1) — owner reads /export and /:instanceId", () => {
  it("GET /api/audit/export (default instance) → 200, attachment, byte-identical AuditData shape", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/export", { devUser: "e-owner" });
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("application/json");
      expect(r.headers["content-disposition"] ?? "").toContain("attachment");
      const data = r.body as AuditData;
      expect(data.instance.id).toBe("INS-7731");
      expect(Array.isArray(data.trace)).toBe(true);
    } finally {
      await close();
    }
  });

  it("GET /api/audit/export?instance=INS-7731 → 200, named instance", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/export?instance=INS-7731", { devUser: "e-owner" });
      expect(r.status).toBe(200);
      expect((r.body as AuditData).instance.id).toBe("INS-7731");
    } finally {
      await close();
    }
  });

  it("GET /api/audit/INS-7731 → 200 with the demo instance trace (previously served with NO gate at all)", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/INS-7731", { devUser: "e-owner" });
      expect(r.status).toBe(200);
      const data = r.body as Record<string, unknown>;
      const instance = data.instance as Record<string, unknown>;
      expect(instance.id).toBe("INS-7731");
      expect(Array.isArray(data.trace)).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) unknown instance → 404 on both routes (gate passes, then lookup 404s).
// ---------------------------------------------------------------------------

describe("T-0737 (2) — unknown instance still 404s for an authorized reader", () => {
  it("GET /api/audit/export?instance=DOES-NOT-EXIST → 404 NOT_FOUND", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/export?instance=DOES-NOT-EXIST", { devUser: "e-owner" });
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("NOT_FOUND");
    } finally {
      await close();
    }
  });

  it("GET /api/audit/NOPE → 404 NOT_FOUND", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/NOPE", { devUser: "e-owner" });
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("NOT_FOUND");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) no x-dev-user → 401, BEFORE any demo lookup.
// ---------------------------------------------------------------------------

describe("T-0737 (3) — unauthenticated caller is rejected on BOTH routes, before any read", () => {
  it("GET /api/audit/export without x-dev-user → 401 UNAUTHENTICATED", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/export", { devUser: null });
      expect(r.status).toBe(401);
      expect(errCode(r.body)).toBe("UNAUTHENTICATED");
    } finally {
      await close();
    }
  });

  it("GET /api/audit/INS-7731 without x-dev-user → 401 UNAUTHENTICATED (regression: this route had ZERO gate before T-0737)", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/INS-7731", { devUser: null });
      expect(r.status).toBe(401);
      expect(errCode(r.body)).toBe("UNAUTHENTICATED");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) authenticated but not owner (with or without a scoped mgmt grant) → 403.
// ---------------------------------------------------------------------------

describe("T-0737 (4) — authz gate: only the genesis owner may read (T-0500 policy, reused verbatim)", () => {
  it("GET /api/audit/export as a non-owner → 403 ADMIN_GATE_REJECTED", async () => {
    const { port, close } = await startServer(makePool(baseScenario({ isOwner: false })));
    try {
      const r = await request(port, "/api/audit/export", { devUser: "e-nonowner" });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
    } finally {
      await close();
    }
  });

  it("GET /api/audit/INS-7731 as a non-owner → 403 ADMIN_GATE_REJECTED (regression: this route had ZERO gate before T-0737)", async () => {
    const { port, close } = await startServer(makePool(baseScenario({ isOwner: false })));
    try {
      const r = await request(port, "/api/audit/INS-7731", { devUser: "e-nonowner" });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
    } finally {
      await close();
    }
  });

  it("a non-owner holding a delegable mgmt_object:* grant still CANNOT read /export → 403 (a single-object grant must not open the journal surface)", async () => {
    const { port, close } = await startServer(makePool(baseScenario({ isOwner: false, hasMgmtGrant: true })));
    try {
      const r = await request(port, "/api/audit/export", { devUser: "e-nonowner" });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) no pool wired (memory mode) → 503, on both routes.
// ---------------------------------------------------------------------------

describe("T-0737 (5) — no DB configured → 503 AUDIT_UNAVAILABLE (the gate needs a DB read, cannot fail open)", () => {
  it("GET /api/audit/export → 503", async () => {
    const { port, close } = await startServer(undefined);
    try {
      const r = await request(port, "/api/audit/export", { devUser: "e-owner" });
      expect(r.status).toBe(503);
      expect(errCode(r.body)).toBe("AUDIT_UNAVAILABLE");
    } finally {
      await close();
    }
  });

  it("GET /api/audit/INS-7731 → 503", async () => {
    const { port, close } = await startServer(undefined);
    try {
      const r = await request(port, "/api/audit/INS-7731", { devUser: "e-owner" });
      expect(r.status).toBe(503);
      expect(errCode(r.body)).toBe("AUDIT_UNAVAILABLE");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) route registration order regression (T-0138 AC-6).
// ---------------------------------------------------------------------------

describe("T-0737 (6) — /api/audit/export is not swallowed by /:instanceId", () => {
  it("GET /api/audit/export never returns the shape of an instance whose id is literally 'export'", async () => {
    const { port, close } = await startServer(makePool(baseScenario()));
    try {
      const r = await request(port, "/api/audit/export", { devUser: "e-owner" });
      expect(r.status).toBe(200);
      const disposition = (r.headers["content-disposition"] as string) ?? "";
      expect(disposition).toContain("attachment");
    } finally {
      await close();
    }
  });
});
