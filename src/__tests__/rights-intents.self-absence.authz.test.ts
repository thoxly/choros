/**
 * src/__tests__/rights-intents.self-absence.authz.test.ts — T-0429 [SECURITY]
 *
 * Covers POST /api/rights/intents/self-absence (registerSelfAbsence), the
 * self-service "я в отпуске" intent. Independent review found a privilege-
 * escalation hole: role_id arrived from the body and was NEVER tied to the
 * actor's own assignments, so any employee could declare self-absence on a role
 * they did NOT hold (e.g. a financial/approval role), nominate an accomplice as
 * substitute, and — on the Tier-2 path — have that role's confirmed grants minted
 * to the accomplice. The fix adds a ROLE-HOLDING GATE inside the write tx
 * (rights-intents.ts ~1175): the absent actor MUST hold a confirmed, in-window
 * role_assignment for role_id, else 403 ADMIN_GATE_REJECTED — fail-closed, BEFORE
 * any grant mint or substitution_rule INSERT.
 *
 * Proofs (full route through a scripted stub pool — dev auth, x-dev-user; no DB):
 *   (s1) actor does NOT hold role_id → 403, and NO grant / substitution_rule
 *        INSERT ever runs (tx aborts before mint). [CRITICAL gate]
 *   (s2) self-only: an employee CANNOT declare absence for another (absent =
 *        actor always; the body has no absent_employee_id field). Substitute ==
 *        actor → 400 (substitute must differ).
 *   (s3) owner-block: self-absence targeting the tenant-owner role → 403, before
 *        the holding gate even runs (isOwnerRoleScoped fires pre-tx).
 *   (s4) valid_until <= now → 400 (no absence in the past).
 *   (s5) Tier-1 split: actor holds the role AND another pool holder exists →
 *        200, tier="tier1", NO grant mint (ttl_grant_id null), rule INSERTed.
 *   (s6) Tier-2 split: actor holds the role, NO other pool holder → 200,
 *        tier="tier2", a TTL grant is minted (subset-gated) and rule INSERTed.
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries the route
 * issues (actor-employee lookup, isOwnerRoleScoped, the role-holding gate, the
 * tier-1 pool probe, the tier-2 parent-grant load). Writes (grant INSERT,
 * substitution_rule INSERT) are observed via a captured-query log so (s1) can
 * assert no mint/rule write was attempted.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerRightsIntentRoutes } from "../http/rights-intents.js";

// ---------------------------------------------------------------------------
// Fixtures — the self-absence path runs against DEV_TENANT_ID (default silo).
// ---------------------------------------------------------------------------

const ACTOR_SLUG = "alice";
const ACTOR_EMP_ID = "cccccccc-0000-0000-0000-000000000001";
const SUBSTITUTE_EMP_ID = "cccccccc-0000-0000-0000-000000000002";
const ROLE_ID = "e0000000-0000-0000-0000-000000000002"; // normal role
const OWNER_ROLE_ID = "e0000000-0000-0000-0000-000000000001"; // role.slug='tenant-owner'

const ORG_SCOPE = { kind: "set", members: [] }; // ⊥ org scope (flat oracle in self-absence)

// A delegable, inheritable parent grant for the role (Tier-2 mint source).
function delegableGrantRow() {
  return {
    id: "g-parent-1",
    role_id: ROLE_ID,
    resource_type: "object",
    resource_facet: null,
    operation: "read",
    scope: ORG_SCOPE,
    constraint: null,
    delegable: true,
    granted_by: "seed",
    valid_from: null,
    valid_until: null,
    created_at: "0",
  };
}

// ---------------------------------------------------------------------------
// Scripted stub pg.Pool.
//
// Distinguishes queries by SQL substring + params. Writes (BEGIN / SET LOCAL /
// COMMIT / ROLLBACK / INSERT) are captured into `captured` so a test can assert
// that a forbidden mint / rule write never ran.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  /** true iff the ACTOR holds a confirmed in-window role_assignment for ROLE_ID. */
  actorHoldsRole: boolean;
  /** true iff ANOTHER pool holder exists for ROLE_ID (Tier-1 vs Tier-2 split). */
  otherPoolHolder: boolean;
  /** roleIds whose role.slug = 'tenant-owner'. */
  ownerRoleIds: string[];
  /** parent grants returned for the Tier-2 mint source. */
  parentGrants?: Array<ReturnType<typeof delegableGrantRow>>;
  /** sink for every query the route issues (for write-suppression assertions). */
  captured: string[];
}): pg.Pool {
  const ownerRoles = new Set(opts.ownerRoleIds);
  const parentGrants = opts.parentGrants ?? [];

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };
      opts.captured.push(text);

      // --- pre-tx: actor employee lookup (slug → id). ---
      if (
        text.includes("SELECT id FROM choros.employee") &&
        text.includes("slug = $2")
      ) {
        return { rows: [{ id: ACTOR_EMP_ID }], rowCount: 1 };
      }

      // --- isOwnerRoleScoped: choros.role … slug = 'tenant-owner'. ---
      if (
        text.includes("FROM choros.role") &&
        text.includes("slug = 'tenant-owner'") &&
        !text.includes("role_assignment")
      ) {
        const roleId = Array.isArray(params) ? (params[1] as string) : undefined;
        const isOwner = roleId !== undefined && ownerRoles.has(roleId);
        return { rows: isOwner ? [{ id: roleId }] : [], rowCount: isOwner ? 1 : 0 };
      }

      // --- ROLE-HOLDING GATE: role_assignment WHERE employee_id = $3 (no <>). ---
      // Distinguished from the tier-1 pool probe (which uses employee_id <> $3).
      if (
        text.includes("FROM choros.role_assignment") &&
        text.includes("employee_id = $3") &&
        !text.includes("employee_id <>")
      ) {
        return {
          rows: opts.actorHoldsRole ? [{ employee_id: ACTOR_EMP_ID }] : [],
          rowCount: opts.actorHoldsRole ? 1 : 0,
        };
      }

      // --- Tier-1 pool probe: role_assignment WHERE employee_id <> $3 AND <> $4. ---
      if (
        text.includes("FROM choros.role_assignment") &&
        text.includes("employee_id <>")
      ) {
        return {
          rows: opts.otherPoolHolder ? [{ employee_id: "other-holder" }] : [],
          rowCount: opts.otherPoolHolder ? 1 : 0,
        };
      }

      // --- Tier-2: parent grants for the role (mint source). ---
      if (
        text.includes('FROM choros."grant"') &&
        text.includes("confirmed_by IS NOT NULL")
      ) {
        return { rows: parentGrants, rowCount: parentGrants.length };
      }

      // Everything else (BEGIN / SET LOCAL / COMMIT / ROLLBACK / INSERT grant /
      // INSERT substitution_rule) is a no-op (captured for write assertions).
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

// ---------------------------------------------------------------------------
// Tiny HTTP harness (mirrors rights-intents.fire-owner.authz.test.ts).
// ---------------------------------------------------------------------------

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerRightsIntentRoutes(router, pool);
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

function post(
  port: number,
  path: string,
  body: unknown,
  actor = ACTOR_SLUG,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
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
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}
function errMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } })?.error?.message;
}

function ranGrantInsert(captured: string[]): boolean {
  return captured.some((q) => q.includes('INSERT INTO choros."grant"'));
}
function ranRuleInsert(captured: string[]): boolean {
  return captured.some((q) => q.includes("INSERT INTO choros.substitution_rule"));
}

const FUTURE = () => Date.now() + 86_400_000; // +1 day

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0429 (s) — self-absence role-holding gate (privilege escalation closed)", () => {
  it("(s1) CRITICAL: actor does NOT hold role_id → 403, NO grant/rule INSERT", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: false, // actor holds NOTHING for ROLE_ID
        otherPoolHolder: false, // would be Tier-2 (mint) if the gate were missing
        ownerRoleIds: [OWNER_ROLE_ID],
        parentGrants: [delegableGrantRow()],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: SUBSTITUTE_EMP_ID,
        role_id: ROLE_ID,
        valid_until: FUTURE(),
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
      expect(errMessage(resp.body)).toContain("role you currently hold");
      // CRITICAL: neither a grant mint NOR a substitution_rule write may have run.
      expect(ranGrantInsert(captured)).toBe(false);
      expect(ranRuleInsert(captured)).toBe(false);
    } finally {
      await close();
    }
  });

  it("(s2) self-only: substitute == actor → 400 (cannot nominate self)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: true,
        otherPoolHolder: true,
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: ACTOR_EMP_ID, // same as the resolved actor employee
        role_id: ROLE_ID,
        valid_until: FUTURE(),
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(400);
      expect(errCode(resp.body)).toBe("VALIDATION");
      expect(ranRuleInsert(captured)).toBe(false);
    } finally {
      await close();
    }
  });

  it("(s3) owner-block: targeting the tenant-owner role → 403 (pre-tx)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: true, // even if the actor held it, owner-block wins
        otherPoolHolder: true,
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: SUBSTITUTE_EMP_ID,
        role_id: OWNER_ROLE_ID,
        valid_until: FUTURE(),
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
      expect(errMessage(resp.body)).toContain("tenant-owner role");
      expect(ranGrantInsert(captured)).toBe(false);
      expect(ranRuleInsert(captured)).toBe(false);
    } finally {
      await close();
    }
  });

  it("(s4) valid_until in the past → 400 (no absence in the past)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: true,
        otherPoolHolder: true,
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: SUBSTITUTE_EMP_ID,
        role_id: ROLE_ID,
        valid_until: Date.now() - 1000, // in the past
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(400);
      expect(errCode(resp.body)).toBe("VALIDATION");
      expect(ranRuleInsert(captured)).toBe(false);
    } finally {
      await close();
    }
  });

  it("(s5) Tier-1: actor holds role + another pool holder → 200 tier1, NO mint, rule written", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: true,
        otherPoolHolder: true, // → Tier-1 (no grant mint)
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: SUBSTITUTE_EMP_ID,
        role_id: ROLE_ID,
        valid_until: FUTURE(),
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(200);
      const b = resp.body as { tier?: string; ttl_grant_id?: unknown };
      expect(b.tier).toBe("tier1");
      expect(b.ttl_grant_id).toBeNull();
      // Tier-1 mints NOTHING but DOES write the rule.
      expect(ranGrantInsert(captured)).toBe(false);
      expect(ranRuleInsert(captured)).toBe(true);
    } finally {
      await close();
    }
  });

  it("(s6) Tier-2: actor holds role, NO other pool holder → 200 tier2, grant minted, rule written", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorHoldsRole: true,
        otherPoolHolder: false, // → Tier-2 (mint a TTL grant)
        ownerRoleIds: [OWNER_ROLE_ID],
        parentGrants: [delegableGrantRow()],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/self-absence", {
        substitute_employee_id: SUBSTITUTE_EMP_ID,
        role_id: ROLE_ID,
        valid_until: FUTURE(),
        org_scope: ORG_SCOPE,
      });
      expect(resp.status).toBe(200);
      const b = resp.body as { tier?: string; ttl_grant_id?: unknown };
      expect(b.tier).toBe("tier2");
      expect(b.ttl_grant_id).not.toBeNull();
      expect(ranGrantInsert(captured)).toBe(true);
      expect(ranRuleInsert(captured)).toBe(true);
    } finally {
      await close();
    }
  });
});
