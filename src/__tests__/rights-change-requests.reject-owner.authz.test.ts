/**
 * src/__tests__/rights-change-requests.reject-owner.authz.test.ts — T-0469 [SECURITY]
 *
 * Closes the THIRD escalation surface found while converging the re-review:
 *
 *   POST /api/rights/change-requests/:id/reject soft-deletes a role_assignment
 *   (UPDATE valid_until=now, honoured at the RA read-path) for ANY row whose
 *   confirmed2_by IS NULL, gated ONLY on assertApproverIsHuman. The genesis
 *   owner's seeded tenant-owner RA is confirmed_by-set and confirmed2_by NULL,
 *   so it matches this path. Without the fix, a constructor-admin (a human) could
 *   reject the genesis owner's RA id → strip the tenant-owner assignment
 *   (owner-strip / denial-of-owner) — the same class as the fire and
 *   role-assignments/:id/revoke vectors. This violates T-0469's MUST.
 *
 * The fix resolves owner-ness from role.slug='tenant-owner' on the targeted RA
 * and requires the actor to be the genesis owner (isGenesisOwnerForTenant,
 * DB-resolved per NF-3) before the soft-delete; a non-owner is 403.
 *
 * Proofs (full route through a scripted stub pool — dev auth, x-dev-user; no DB):
 *   (r1) non-owner human rejecting the genesis owner's tenant-owner RA → 403
 *        owner_assignment_owner_only, and NO role_assignment UPDATE is issued.
 *   (r2) the genesis OWNER rejecting a tenant-owner RA → 200 (legit; no
 *        over-restriction of the owner).
 *   (r3) a non-owner human rejecting a NORMAL (non-owner) semi-confirmed RA → 200
 *        (carve-out is owner-role-specific; the normal dual-control reject path
 *        is intact).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerRightsChangeRequestRoutes } from "../http/rights-change-requests.js";

const TENANT_A = "a0000000-0000-0000-0000-000000000001";
const OWNER_RA_ID = "fa000000-0000-0000-0000-000000000001";
const NORMAL_RA_ID = "fa000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Scripted stub pg.Pool. Captures every query so a test can assert the forbidden
// role_assignment UPDATE never ran on the rejection path.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  /** true iff the rejecting ACTOR is the genesis tenant-owner. */
  actorIsOwner: boolean;
  /** the targeted RA's role.slug ('tenant-owner' = the owner RA). */
  targetRoleSlug: string;
  /** sink for every query (for write-suppression assertions). */
  captured: string[];
}): pg.Pool {
  const client = {
    query: async (text: string | { text: string }, _params?: unknown[]) => {
      const sql = typeof text === "string" ? text : text?.text;
      if (typeof sql !== "string") return { rows: [], rowCount: 0 };
      opts.captured.push(sql);

      // BEGIN / COMMIT / ROLLBACK / SET LOCAL — no-op.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // resolveActorTenant — choros.employee e JOIN choros.tenant t … WHERE e.slug.
      if (/FROM\s+choros\.employee\s+e/i.test(sql) && /WHERE\s+e\.slug/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // assertApproverIsHuman — SELECT kind FROM choros.employee … (the actor is human).
      if (/SELECT\s+kind\s+FROM\s+choros\.employee/i.test(sql)) {
        return { rows: [{ kind: "human" }], rowCount: 1 };
      }

      // isGenesisOwnerForTenant — role_assignment ra JOIN choros.role r … slug='tenant-owner'.
      if (
        /role_assignment\s+ra/i.test(sql) &&
        /JOIN\s+choros\.role/i.test(sql) &&
        /slug\s*=\s*'tenant-owner'/i.test(sql)
      ) {
        return {
          rows: opts.actorIsOwner ? [{ id: "ra-owner-actor" }] : [],
          rowCount: opts.actorIsOwner ? 1 : 0,
        };
      }

      // rejectChangeRequest — grant table probed first (no grant row here → RA path).
      if (/SELECT\s+confirmed2_by\s+FROM\s+choros\."grant"/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // rejectChangeRequest — RA SELECT (T-0469 shape: ra.confirmed2_by, ra.role_id,
      // r.slug AS role_slug FROM choros.role_assignment ra LEFT JOIN choros.role r).
      if (
        /FROM\s+choros\.role_assignment\s+ra/i.test(sql) &&
        /role_slug/i.test(sql)
      ) {
        return {
          rows: [
            {
              confirmed2_by: null, // semi-confirmed / seeded owner RA → matches reject path
              role_id: opts.targetRoleSlug === "tenant-owner" ? OWNER_RA_ID : NORMAL_RA_ID,
              role_slug: opts.targetRoleSlug,
            },
          ],
          rowCount: 1,
        };
      }

      // Audit writer — order audit_head before current_setting (shared GUC substring).
      if (/INSERT\s+INTO\s+choros\.audit_head/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE\s+choros\.audit_head/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/audit_head/i.test(sql) && /FOR\s+UPDATE/i.test(sql)) {
        return {
          rows: [{ seq: 0n, row_hash: Buffer.alloc(32, 0), vocab_version: 1 }],
          rowCount: 1,
        };
      }
      if (/current_setting.*choros\.tenant_id/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // Audit event INSERT.
      if (/INSERT\s+INTO/i.test(sql)) return { rows: [], rowCount: 1 };

      // The reject soft-delete UPDATE (and any other UPDATE).
      if (/UPDATE\s+choros/i.test(sql)) return { rows: [], rowCount: 1 };

      return { rows: [], rowCount: 0 };
    },
    release() {
      /* no-op */
    },
  };

  return {
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
}

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerRightsChangeRequestRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e: Error | undefined) => (e ? reject(e) : resolve())),
      ),
  };
}

function reject(
  port: number,
  raId: string,
  actor: string,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({ reason: "test" });
  return new Promise((resolve, rej) => {
    const httpReq = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/rights/change-requests/${raId}/reject`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-dev-user": actor,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    httpReq.on("error", rej);
    httpReq.write(payload);
    httpReq.end();
  });
}

function errMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } })?.error?.message;
}
function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

describe("T-0469 (r) — change-request reject CANNOT strip the tenant-owner RA", () => {
  it("(r1) non-owner human rejecting the genesis owner's tenant-owner RA → 403, no UPDATE", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({ actorIsOwner: false, targetRoleSlug: "tenant-owner", captured }),
    );
    try {
      const resp = await reject(port, OWNER_RA_ID, "constructor-admin");
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
      expect(errMessage(resp.body)).toContain("owner_assignment_owner_only");
      // CRITICAL: the soft-delete UPDATE on role_assignment must NEVER have run.
      const ranUpdate = captured.some(
        (q) =>
          /UPDATE\s+choros\.role_assignment/i.test(q) && /valid_until/i.test(q),
      );
      expect(ranUpdate).toBe(false);
    } finally {
      await close();
    }
  });

  it("(r2) the genesis OWNER CAN reject a tenant-owner RA → 200", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({ actorIsOwner: true, targetRoleSlug: "tenant-owner", captured: [] }),
    );
    try {
      const resp = await reject(port, OWNER_RA_ID, "genesis-owner");
      expect(resp.status).toBe(200);
      expect((resp.body as { state?: string }).state).toBe("rejected");
    } finally {
      await close();
    }
  });

  it("(r3) non-owner human rejecting a NORMAL semi-confirmed RA → 200 (no over-restriction)", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({ actorIsOwner: false, targetRoleSlug: "approver", captured: [] }),
    );
    try {
      const resp = await reject(port, NORMAL_RA_ID, "constructor-admin");
      expect(resp.status).toBe(200);
      expect((resp.body as { state?: string }).state).toBe("rejected");
    } finally {
      await close();
    }
  });
});
