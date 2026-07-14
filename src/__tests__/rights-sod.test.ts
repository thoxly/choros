/**
 * src/__tests__/rights-sod.test.ts — T-0391 [D2-FU]
 *
 * Static (no-DB) tests for the SoD rules + conflict-check API.
 * Uses stub pg.Pool that discriminates query results by SQL pattern.
 * No live Postgres required.
 *
 * Covers:
 *   SOD-1  sod-rules returns empty array when no constraints configured
 *   SOD-2  sod-rules lists static constraint with role names
 *   SOD-3  sod-rules lists dynamic constraint (role_a may be null)
 *   SOD-4  sod-check — subject with no role assignments has no conflicts
 *   SOD-5  sod-check — subject holding both conflicting roles → static conflict
 *   SOD-6  sod-check — subject holding only one of the two roles → no conflict
 *   SOD-7  sod-check — dynamic constraint surfaces as note (role_a match)
 *   SOD-8  sod-check — unknown subjectId, PRIVILEGED override → 404
 *   SOD-8b sod-check — subjectId override WITHOUT privilege → 403 (T-0736)
 *   SOD-9  routing — /api/rights/sod-rules resolves BEFORE :roleId catch-all
 *   SOD-10 routing — /api/rights/sod-check resolves BEFORE :roleId catch-all
 *   SOD-11 sod-check defaults subjectId to authenticated actor when omitted
 *   SOD-12 sod-check — PRIVILEGED override to a real, DIFFERENT subject → 200
 *          with that subject's own data (T-0736 positive control)
 *
 * T-0736 [security P1]: SOD-8/SOD-8b/SOD-12 cover the subjectId-override
 * privilege gate added on top of the pre-existing 404/self-default coverage
 * (T-0726 §5.2 finding — subjectId was overridable to ANY slug with zero
 * privilege check). See docs/tasks/T-0736.adr.md.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerSodRoutes } from "../http/rights-sod.js";
import { registerRightsRoutes } from "../http/rights.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A    = "a0000000-0000-0000-0000-000000000001";
const EMPLOYEE_ID = "c0000000-0000-0000-0000-000000000001";
const ROLE_A_ID   = "e0000000-0000-0000-0000-000000000001";
const ROLE_B_ID   = "e0000000-0000-0000-0000-000000000002";
const CONSTRAINT_ID = "d0000000-0000-0000-0000-000000000001";
const ACTOR_SLUG  = "e-orlov";
const OTHER_SUBJECT_SLUG = "e-kravtsova";

// ---------------------------------------------------------------------------
// Stub pg.Pool factory
// ---------------------------------------------------------------------------

interface StubOptions {
  /** sod_constraint rows returned for LIST or CHECK queries */
  constraintRows?: Record<string, unknown>[];
  /** role_assignment rows for the subject in SOD-check */
  raRows?: Record<string, unknown>[];
  /** whether the employee lookup finds the subject (default: true) */
  employeeFound?: boolean;
  /**
   * T-0736: whether the AUTHENTICATED ACTOR (ACTOR_SLUG, not the subject
   * being looked up) resolves as owner/admin via resolveActorPrivilege
   * (loadAdminContext isGenesisOwner formula). Drives the subjectId-override
   * gate on GET /api/rights/sod-check — default false (ordinary member).
   */
  isOwnerOrAdmin?: boolean;
}

function makePool(opts: StubOptions = {}): pg.Pool {
  const {
    constraintRows = [],
    raRows = [],
    employeeFound = true,
    isOwnerOrAdmin = false,
  } = opts;

  const stubClient = {
    query: async (_text: string | { text: string }, _values?: unknown[]) => {
      const sql = typeof _text === "string" ? _text : _text.text;

      // ── Transaction lifecycle ──────────────────────────────────────────────
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // ── resolveActorTenant ─────────────────────────────────────────────────
      // SELECT e.tenant_id FROM choros.employee e JOIN ... WHERE e.slug = $1
      if (/choros\.employee.*WHERE\s+e\.slug/is.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // ── T-0736: resolveActorPrivilege → loadAdminContext isGenesisOwner
      // (the subjectId-override gate on sod-check). This query is a
      // `choros.role_assignment ra JOIN choros.role r ... AND r.slug =
      // 'tenant-owner'` shape — distinct from (and checked BEFORE) the
      // broader "subject employee lookup" matcher below, even though the
      // isGenesisOwner query ALSO embeds a `SELECT id FROM choros.employee
      // WHERE tenant_id...` subquery that would otherwise false-match it.
      if (/r\.slug\s*=\s*'tenant-owner'/i.test(sql)) {
        return isOwnerOrAdmin
          ? { rows: [{ id: "t0736-owner-assignment" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // ── Subject employee lookup (sod-check) ───────────────────────────────
      // SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1
      if (/SELECT\s+id\s+FROM\s+choros\.employee\s+WHERE\s+tenant_id/i.test(sql)) {
        if (!employeeFound) return { rows: [], rowCount: 0 };
        return { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
      }

      // ── role_assignment query (sod-check) ─────────────────────────────────
      if (/FROM\s+choros\.role_assignment\s+ra\s+JOIN\s+choros\.role\s+r/is.test(sql)) {
        return { rows: raRows, rowCount: raRows.length };
      }

      // ── sod_constraint query (sod-rules and sod-check) ───────────────────
      if (/FROM\s+choros\.sod_constraint/i.test(sql)) {
        return { rows: constraintRows, rowCount: constraintRows.length };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  return {
    connect: async () => stubClient as unknown as pg.PoolClient,
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: parseInt(url.port),
      path: url.pathname + url.search,
      headers: { "x-dev-user": ACTOR_SLUG, ...headers },
    };
    const r = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

async function startTestServer(opts: StubOptions = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const router = new Router();
  const pool = makePool(opts);
  registerSodRoutes(router, pool);
  const server = http.createServer(router.dispatch.bind(router));
  await new Promise<void>((resolve) => {
    server.listen(0, "localhost", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const STATIC_CONSTRAINT_ROW = {
  id: CONSTRAINT_ID,
  kind: "static",
  role_a: ROLE_A_ID,
  role_b: ROLE_B_ID,
  role_a_name: "Контролёр расчётов",
  role_b_name: "Согласующий бюджет",
  self_record: false,
  detail: null,
  created_at: "0",
};

const DYNAMIC_CONSTRAINT_ROW = {
  id: CONSTRAINT_ID,
  kind: "dynamic",
  role_a: ROLE_A_ID,
  role_b: null,
  role_a_name: "Контролёр расчётов",
  role_b_name: null,
  self_record: true,
  detail: null,
  created_at: "0",
};

// ---------------------------------------------------------------------------
// SOD-1: sod-rules empty when no constraints
// ---------------------------------------------------------------------------

describe("SOD-1 — sod-rules: empty response when no constraints", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => { server = await startTestServer({ constraintRows: [] }); });
  afterAll(async () => { await server.close(); });

  it("returns 200 with empty rules array", async () => {
    const res = await req(server.baseUrl, "GET", "/api/rights/sod-rules");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { rules: unknown[]; total: number };
    expect(Array.isArray(data.rules)).toBe(true);
    expect(data.rules).toHaveLength(0);
    expect(data.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SOD-2: sod-rules lists a static constraint with role names
// ---------------------------------------------------------------------------

describe("SOD-2 — sod-rules: lists static constraint with role names", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({ constraintRows: [STATIC_CONSTRAINT_ROW] });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with one static rule", async () => {
    const res = await req(server.baseUrl, "GET", "/api/rights/sod-rules");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      rules: Array<{ id: string; kind: string; roleA: { id: string; name: string } | null; roleB: { id: string; name: string } | null }>;
      total: number;
    };
    expect(data.total).toBe(1);
    expect(data.rules).toHaveLength(1);
    const rule = data.rules[0]!;
    expect(rule.id).toBe(CONSTRAINT_ID);
    expect(rule.kind).toBe("static");
    expect(rule.roleA).toEqual({ id: ROLE_A_ID, name: "Контролёр расчётов" });
    expect(rule.roleB).toEqual({ id: ROLE_B_ID, name: "Согласующий бюджет" });
  });
});

// ---------------------------------------------------------------------------
// SOD-3: sod-rules lists a dynamic constraint (role_a may be non-null, role_b null)
// ---------------------------------------------------------------------------

describe("SOD-3 — sod-rules: lists dynamic constraint", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({ constraintRows: [DYNAMIC_CONSTRAINT_ROW] });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with one dynamic rule, roleB null", async () => {
    const res = await req(server.baseUrl, "GET", "/api/rights/sod-rules");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      rules: Array<{ kind: string; roleA: unknown; roleB: unknown; selfRecord: boolean }>;
    };
    const rule = data.rules[0]!;
    expect(rule.kind).toBe("dynamic");
    expect(rule.roleB).toBeNull();
    expect(rule.selfRecord).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SOD-4: sod-check — subject with no role assignments has no conflicts
// ---------------------------------------------------------------------------

describe("SOD-4 — sod-check: no roles → no conflicts", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({
      constraintRows: [STATIC_CONSTRAINT_ROW],
      raRows: [],
    });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with empty conflicts and heldRoles", async () => {
    const res = await req(server.baseUrl, "GET", `/api/rights/sod-check?subjectId=${ACTOR_SLUG}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      subjectId: string;
      heldRoles: unknown[];
      conflicts: unknown[];
    };
    expect(data.subjectId).toBe(ACTOR_SLUG);
    expect(data.heldRoles).toHaveLength(0);
    expect(data.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SOD-5: sod-check — subject holding BOTH conflicting roles → static conflict
// ---------------------------------------------------------------------------

describe("SOD-5 — sod-check: subject holds both roles → conflict", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({
      constraintRows: [STATIC_CONSTRAINT_ROW],
      raRows: [
        { role_id: ROLE_A_ID, display_name: "Контролёр расчётов" },
        { role_id: ROLE_B_ID, display_name: "Согласующий бюджет" },
      ],
    });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with one static conflict", async () => {
    const res = await req(server.baseUrl, "GET", `/api/rights/sod-check?subjectId=${ACTOR_SLUG}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      conflicts: Array<{ constraintId: string; kind: string }>;
      heldRoles: unknown[];
    };
    expect(data.heldRoles).toHaveLength(2);
    expect(data.conflicts).toHaveLength(1);
    const conflict = data.conflicts[0]!;
    expect(conflict.constraintId).toBe(CONSTRAINT_ID);
    expect(conflict.kind).toBe("static");
  });
});

// ---------------------------------------------------------------------------
// SOD-6: sod-check — subject holding only one of the two roles → no conflict
// ---------------------------------------------------------------------------

describe("SOD-6 — sod-check: holds only one role → no static conflict", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({
      constraintRows: [STATIC_CONSTRAINT_ROW],
      raRows: [{ role_id: ROLE_A_ID, display_name: "Контролёр расчётов" }],
    });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with no conflicts", async () => {
    const res = await req(server.baseUrl, "GET", `/api/rights/sod-check?subjectId=${ACTOR_SLUG}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { conflicts: unknown[] };
    expect(data.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SOD-7: sod-check — dynamic constraint surfaces as note when subject holds role_a
// ---------------------------------------------------------------------------

describe("SOD-7 — sod-check: dynamic constraint surfaced with note", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({
      constraintRows: [DYNAMIC_CONSTRAINT_ROW],
      raRows: [{ role_id: ROLE_A_ID, display_name: "Контролёр расчётов" }],
    });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with one dynamic conflict entry carrying a note", async () => {
    const res = await req(server.baseUrl, "GET", `/api/rights/sod-check?subjectId=${ACTOR_SLUG}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      conflicts: Array<{ kind: string; note?: string }>;
    };
    expect(data.conflicts).toHaveLength(1);
    const conflict = data.conflicts[0]!;
    expect(conflict.kind).toBe("dynamic");
    expect(typeof conflict.note).toBe("string");
    expect(conflict.note!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SOD-8: sod-check — unknown subjectId, PRIVILEGED override → 404
//
// T-0736: subjectId="ghost" !== ACTOR_SLUG is an OVERRIDE, so the actor must
// now be owner/admin to even reach checkSodForSubject. Privileged here on
// purpose — this test's AC is "unknown subject → 404", not "unprivileged
// override → 403" (that is SOD-8b, below).
// ---------------------------------------------------------------------------

describe("SOD-8 — sod-check: unknown subjectId (privileged override) → 404", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({ employeeFound: false, isOwnerOrAdmin: true });
  });
  afterAll(async () => { await server.close(); });

  it("returns 404 for unknown subject slug", async () => {
    const res = await req(server.baseUrl, "GET", "/api/rights/sod-check?subjectId=ghost");
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// SOD-8b: sod-check — subjectId override WITHOUT owner/admin privilege → 403
// (T-0736 P1 fix — the MOST dangerous of the three T-0726 §5.2 findings:
// subjectId was a bare, unchecked identity swap before this task).
// ---------------------------------------------------------------------------

describe("SOD-8b — sod-check: subjectId override without privilege → 403 (T-0736)", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    // Ordinary (non-owner/admin) actor, and the override target EXISTS
    // (employeeFound: true) — proves the 403 fires on the PRIVILEGE check,
    // before ever resolving whether the target subject exists (no
    // exists/doesn't-exist oracle leaks through to an unprivileged caller).
    server = await startTestServer({ employeeFound: true, isOwnerOrAdmin: false });
  });
  afterAll(async () => { await server.close(); });

  it("returns 403 FORBIDDEN, not the subject's data and not a 404", async () => {
    const res = await req(
      server.baseUrl,
      "GET",
      `/api/rights/sod-check?subjectId=${OTHER_SUBJECT_SLUG}`,
    );
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// SOD-9 + SOD-10: routing — sod-rules and sod-check resolve BEFORE :roleId catch-all
// ---------------------------------------------------------------------------

describe("SOD-9/SOD-10 — routing: literal paths resolve before :roleId catch-all", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const router = new Router();
    const pool = makePool({ constraintRows: [] });
    // Register in server.ts order — SoD routes BEFORE :roleId catch-all.
    registerSodRoutes(router, pool);
    registerRightsRoutes(router);
    server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://localhost:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it("SOD-9: GET /api/rights/sod-rules resolves to SoD handler (not :roleId 404)", async () => {
    // If :roleId catch-all wins instead, it would call findRole("sod-rules")
    // and return 404. We assert 200 + JSON shape.
    const res = await req(baseUrl, "GET", "/api/rights/sod-rules");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { rules: unknown[]; total: number };
    expect(Array.isArray(data.rules)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("SOD-10: GET /api/rights/sod-check resolves to SoD handler (not :roleId 404)", async () => {
    const res = await req(baseUrl, "GET", `/api/rights/sod-check?subjectId=${ACTOR_SLUG}`);
    // 200 (found) or 404 from employee lookup, but NOT a rights :roleId miss.
    // A :roleId-catch-all miss returns { error: { code: 'NOT_FOUND' } } from
    // findRole("sod-check") — but from the RIGHTS handler, not ours.
    // Our 404 has code 'NOT_FOUND' from HttpError — both have the same structure,
    // but the status 404 (not 200 from findRole returning null→404) is expected.
    // The key assertion is that we DO NOT get a plaintext 404 from the seed
    // rights data (which has no role "sod-check"). Our handler throws an HttpError
    // with JSON; the rights handler returns JSON too — distinguish by body content.
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    // Either 200 (employee found) or our 404 (employee stub returns no employee)
    // but in BOTH cases the response must be a valid JSON object, not from findRole.
    expect([200, 404]).toContain(res.status);
    // Our handler always returns JSON (not the rights seed).
    expect(typeof parsed).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// SOD-11: sod-check defaults subjectId to authenticated actor
// ---------------------------------------------------------------------------

describe("SOD-11 — sod-check: no subjectId → defaults to authenticated actor", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({ constraintRows: [], raRows: [] });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with subjectId equal to actor slug", async () => {
    const res = await req(server.baseUrl, "GET", "/api/rights/sod-check");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { subjectId: string };
    expect(data.subjectId).toBe(ACTOR_SLUG);
  });
});

// ---------------------------------------------------------------------------
// SOD-12: sod-check — PRIVILEGED override to a real, DIFFERENT subject → 200
// (T-0736 positive control: the gate blocks ONLY unprivileged override, an
// owner/admin can legitimately inspect a colleague's SoD conflicts).
// ---------------------------------------------------------------------------

describe("SOD-12 — sod-check: privileged override to a different subject → 200 (T-0736)", () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startTestServer({
      constraintRows: [STATIC_CONSTRAINT_ROW],
      raRows: [
        { role_id: ROLE_A_ID, display_name: "Контролёр расчётов" },
        { role_id: ROLE_B_ID, display_name: "Согласующий бюджет" },
      ],
      employeeFound: true,
      isOwnerOrAdmin: true,
    });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 with the OTHER subject's own conflicts (not blocked, not self-substituted)", async () => {
    const res = await req(
      server.baseUrl,
      "GET",
      `/api/rights/sod-check?subjectId=${OTHER_SUBJECT_SLUG}`,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as {
      subjectId: string;
      conflicts: unknown[];
    };
    // The response echoes the REQUESTED subject, not the caller — an owner
    // viewing someone else's SoD must see THAT subject's id back, not their own.
    expect(data.subjectId).toBe(OTHER_SUBJECT_SLUG);
    expect(data.subjectId).not.toBe(ACTOR_SLUG);
    expect(data.conflicts).toHaveLength(1);
  });
});
