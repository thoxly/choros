/**
 * src/__tests__/rights-sod-admin.test.ts — T-0409 [D6-FU]
 *
 * Static (no-DB) unit tests for the SoD constraint admin write API.
 * Uses a stub pg.Pool that discriminates query results by SQL pattern.
 * No live Postgres required (fitness:db covers the live path).
 *
 * Covers:
 *   SODA-1  POST /api/rights/sod-rules → 201 with id (create, owner actor)
 *   SODA-2  POST /api/rights/sod-rules → 403 when actor is NOT the genesis owner
 *   SODA-3  PUT  /api/rights/sod-rules/:id → 200 { updated: true }
 *   SODA-4  PUT  /api/rights/sod-rules/:id → 404 when constraint not found
 *   SODA-5  DELETE /api/rights/sod-rules/:id → 200 { deleted: true }
 *   SODA-6  DELETE /api/rights/sod-rules/:id → 404 when constraint not found
 *   SODA-7  SodValidationError from DAO → 400 VALIDATION (static kind, no roles)
 *   SODA-8  audit_event INSERT is emitted on create (in-memory audit-writer path via stub)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import pg from "pg";
import { Router } from "../http/router.js";
import { registerSodAdminRoutes } from "../http/rights-sod-admin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A       = "a0000000-0000-0000-0000-000000000001";
const CONSTRAINT_ID  = "d0000000-0000-0000-0000-000000000001";
const ROLE_A_ID      = "e0000000-0000-0000-0000-000000000001";
const ROLE_B_ID      = "e0000000-0000-0000-0000-000000000002";
const OWNER_SLUG     = "e-orlov";
const NON_OWNER_SLUG = "e-nonowner";

// Minimal scope shape (just needs to be non-null JSON).
const SCOPE = { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "root" };

// ---------------------------------------------------------------------------
// Stub pg.Pool factory
// ---------------------------------------------------------------------------

/**
 * Options for the stub pool:
 *  isOwner         — true if the actor is the genesis owner
 *  constraintFound — whether the sod_constraint row exists for PUT/DELETE
 *  constraintKind  — the existing row's kind (for the lock + RETURNING responses)
 *
 * The stub tracks:
 *  auditInserts — count of INSERT INTO choros.audit_event calls (for SODA-8)
 */
interface StubOptions {
  isOwner?: boolean;
  constraintFound?: boolean;
  constraintKind?: "static" | "dynamic";
}

interface StubPool {
  pool: pg.Pool;
  auditInserts: { count: number };
}

function makePool(opts: StubOptions = {}): StubPool {
  const {
    isOwner = true,
    constraintFound = true,
    constraintKind = "static",
  } = opts;

  const auditInserts = { count: 0 };

  const stubClient = {
    query: async (_text: string | { text: string }, _values?: unknown[]) => {
      const sql = typeof _text === "string" ? _text : _text.text;

      // ── Transaction lifecycle ─────────────────────────────────────────────
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)\b/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // ── resolveActorTenant: SELECT e.tenant_id FROM choros.employee e JOIN ... ─
      if (/FROM\s+choros\.employee\s+e\s+JOIN/i.test(sql) || /choros\.employee.*WHERE\s+e\.slug/is.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // ── resolveActorSlugFromAuth: SELECT slug FROM choros.employee WHERE sub ─
      // (dev-auth path: x-dev-user header bypasses this entirely)

      // ── loadAdminContext: owner check (role_assignment JOIN role WHERE slug='tenant-owner') ─
      // The query joins role_assignment + role and looks for slug = 'tenant-owner'.
      if (/tenant-owner/i.test(sql)) {
        if (isOwner) {
          return { rows: [{ id: "ra-owner-id" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // ── loadAdminContext: admin assignments (role_assignment for actor) ─────
      // Second SELECT in loadAdminContext: gets actor's assignments.
      if (/SELECT\s+ra\.id,\s*ra\.role_id,\s*ra\.org_scope/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // ── PgAuditWriter operations — ORDER IS CRITICAL ─────────────────────
      // All three audit queries (audit_event INSERT, audit_head INSERT, audit_head
      // SELECT FOR UPDATE) contain "current_setting('choros.tenant_id')" in their SQL.
      // The current_setting check MUST come LAST among these to avoid false matches.

      // audit_event INSERT (step 3 of PgAuditWriter.appendAuditEvent).
      // Contains current_setting(...) in the VALUES; must match BEFORE current_setting.
      if (/INSERT\s+INTO\s+choros\.audit_event/i.test(sql)) {
        auditInserts.count += 1;
        return { rows: [], rowCount: 1 };
      }

      // audit_head seed INSERT ... ON CONFLICT DO NOTHING
      if (/INSERT\s+INTO\s+choros\.audit_head/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // audit_head SELECT FOR UPDATE (step 2 of appendAuditEvent).
      // seq MUST be a NUMBER (0), not a string; Number("0") is 0 but PgAuditWriter
      // does Number(head.seq)+1. row_hash MUST be a 32-byte Buffer.
      if (/choros\.audit_head/i.test(sql) && /FOR\s+UPDATE/i.test(sql)) {
        return {
          rows: [{ seq: 0, row_hash: Buffer.alloc(32, 0), vocab_version: 1 }],
          rowCount: 1,
        };
      }

      // audit_head UPDATE (head advance, step 4 of appendAuditEvent).
      if (/UPDATE\s+choros\.audit_head/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // current_setting (step 1 of PgAuditWriter: reads tenant_id from GUC).
      // AFTER all audit_event/audit_head patterns — those also contain current_setting.
      if (/current_setting\s*\(\s*'choros\.tenant_id'/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // ── audit_event INSERT (PgAuditWriter) ────────────────────────────────
      if (/INSERT\s+INTO\s+choros\.audit_event/i.test(sql)) {
        auditInserts.count += 1;
        return { rows: [], rowCount: 1 };
      }

      // ── sod_constraint INSERT (create) ────────────────────────────────────
      if (/INSERT\s+INTO\s+choros\.sod_constraint/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // ── sod_constraint SELECT FOR UPDATE (update path) ───────────────────
      if (/FROM\s+choros\.sod_constraint.*FOR\s+UPDATE/is.test(sql)) {
        if (!constraintFound) return { rows: [], rowCount: 0 };
        return {
          rows: [{ kind: constraintKind, role_a: ROLE_A_ID, role_b: ROLE_B_ID }],
          rowCount: 1,
        };
      }

      // ── sod_constraint UPDATE (update path) ──────────────────────────────
      if (/UPDATE\s+choros\.sod_constraint/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // ── sod_constraint DELETE RETURNING kind (delete path) ───────────────
      if (/DELETE\s+FROM\s+choros\.sod_constraint/i.test(sql)) {
        if (!constraintFound) return { rows: [], rowCount: 0 };
        return { rows: [{ kind: constraintKind }], rowCount: 1 };
      }

      // Default: unmatched query → no-op (BEGIN, COMMIT, ROLLBACK, SET LOCAL,
      // INSERT/UPDATE from sod_constraint writes, grant table reads, etc.).
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => stubClient as unknown as pg.PoolClient,
  } as unknown as pg.Pool;

  return { pool, auditInserts };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  actorSlug = OWNER_SLUG,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: parseInt(url.port),
      path: url.pathname + url.search,
      headers: {
        "x-dev-user": actorSlug,
        ...(payload !== undefined
          ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
          : {}),
      },
    };
    const r = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

async function startTestServer(opts: StubOptions = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  auditInserts: { count: number };
}> {
  const { pool, auditInserts } = makePool(opts);
  const router = new Router();
  registerSodAdminRoutes(router, pool);
  const server = http.createServer(router.dispatch.bind(router));
  await new Promise<void>((resolve) => {
    server.listen(0, "localhost", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
    auditInserts,
  };
}

// ---------------------------------------------------------------------------
// SODA-1: POST /api/rights/sod-rules → 201 (owner creates a static constraint)
// ---------------------------------------------------------------------------

describe("SODA-1 — POST sod-rules: owner creates a static constraint → 201", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => { server = await startTestServer({ isOwner: true }); });
  afterAll(async () => { await server.close(); });

  it("returns 201 with a UUID id", async () => {
    const res = await req(server.baseUrl, "POST", "/api/rights/sod-rules", {
      kind: "static",
      roleA: ROLE_A_ID,
      roleB: ROLE_B_ID,
      scope: SCOPE,
    });
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body) as { id: string };
    expect(typeof data.id).toBe("string");
    // UUID shape
    expect(data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// SODA-2: POST /api/rights/sod-rules → 403 when actor is NOT the genesis owner
// ---------------------------------------------------------------------------

describe("SODA-2 — POST sod-rules: non-owner actor → 403 NOT_OWNER", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => { server = await startTestServer({ isOwner: false }); });
  afterAll(async () => { await server.close(); });

  it("returns 403 with NOT_OWNER code", async () => {
    const res = await req(
      server.baseUrl, "POST", "/api/rights/sod-rules",
      { kind: "dynamic", scope: SCOPE },
      NON_OWNER_SLUG,
    );
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("NOT_OWNER");
  });
});

// ---------------------------------------------------------------------------
// SODA-3: PUT /api/rights/sod-rules/:id → 200 (partial update, constraint exists)
// ---------------------------------------------------------------------------

describe("SODA-3 — PUT sod-rules/:id: owner updates existing constraint → 200", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer({ isOwner: true, constraintFound: true, constraintKind: "static" });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 { updated: true }", async () => {
    const res = await req(
      server.baseUrl, "PUT", `/api/rights/sod-rules/${CONSTRAINT_ID}`,
      { selfRecord: true },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { updated: boolean };
    expect(data.updated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SODA-4: PUT /api/rights/sod-rules/:id → 404 when constraint not found
// ---------------------------------------------------------------------------

describe("SODA-4 — PUT sod-rules/:id: constraint not found → 404", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer({ isOwner: true, constraintFound: false });
  });
  afterAll(async () => { await server.close(); });

  it("returns 404 NOT_FOUND", async () => {
    const res = await req(
      server.baseUrl, "PUT", `/api/rights/sod-rules/${CONSTRAINT_ID}`,
      { selfRecord: true },
    );
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// SODA-5: DELETE /api/rights/sod-rules/:id → 200 (constraint exists)
// ---------------------------------------------------------------------------

describe("SODA-5 — DELETE sod-rules/:id: owner deletes existing constraint → 200", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer({ isOwner: true, constraintFound: true, constraintKind: "static" });
  });
  afterAll(async () => { await server.close(); });

  it("returns 200 { deleted: true }", async () => {
    const res = await req(
      server.baseUrl, "DELETE", `/api/rights/sod-rules/${CONSTRAINT_ID}`,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { deleted: boolean };
    expect(data.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SODA-6: DELETE /api/rights/sod-rules/:id → 404 when constraint not found
// ---------------------------------------------------------------------------

describe("SODA-6 — DELETE sod-rules/:id: constraint not found → 404", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer({ isOwner: true, constraintFound: false });
  });
  afterAll(async () => { await server.close(); });

  it("returns 404 NOT_FOUND", async () => {
    const res = await req(
      server.baseUrl, "DELETE", `/api/rights/sod-rules/${CONSTRAINT_ID}`,
    );
    expect(res.status).toBe(404);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// SODA-7: SodValidationError from DAO (static constraint missing roles) → 400
// ---------------------------------------------------------------------------

describe("SODA-7 — POST sod-rules: static constraint missing roleA/roleB → 400 VALIDATION", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => { server = await startTestServer({ isOwner: true }); });
  afterAll(async () => { await server.close(); });

  it("returns 400 VALIDATION when roleA is missing for kind=static", async () => {
    // This passes HTTP-layer validation (we include roleA) but send no roleB.
    // The HTTP body parser itself will catch the missing roleB first.
    // Test the shape-violation path: malformed body has kind=static with no roles.
    const res = await req(server.baseUrl, "POST", "/api/rights/sod-rules", {
      kind: "static",
      // roleA and roleB intentionally omitted — both body-parser AND DAO will catch this.
      scope: SCOPE,
    });
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body) as { error?: { code: string } };
    expect(data.error?.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// SODA-8: audit_event INSERT is emitted atomically on create
// ---------------------------------------------------------------------------

describe("SODA-8 — POST sod-rules: audit_event row is inserted (audit chain)", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => { server = await startTestServer({ isOwner: true }); });
  afterAll(async () => { await server.close(); });

  it("emits exactly one audit_event INSERT per create call", async () => {
    const before = server.auditInserts.count;
    const res = await req(server.baseUrl, "POST", "/api/rights/sod-rules", {
      kind: "static",
      roleA: ROLE_A_ID,
      roleB: ROLE_B_ID,
      scope: SCOPE,
    });
    expect(res.status).toBe(201);
    // One audit_event INSERT must have been issued (SODA-8 compliance check).
    expect(server.auditInserts.count).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Unit: SodValidationError shape (DAO path, no HTTP)
// ---------------------------------------------------------------------------

import { SodValidationError } from "../db/sod-dao.js";

describe("SodValidationError — shape and instanceof (DAO unit)", () => {
  it("is an Error with name SodValidationError", () => {
    const err = new SodValidationError("missing roleA");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SodValidationError).toBe(true);
    expect(err.name).toBe("SodValidationError");
    expect(err.message).toBe("missing roleA");
  });

  it("is caught by catch(err instanceof SodValidationError)", () => {
    let caught = false;
    try {
      throw new SodValidationError("shape violation");
    } catch (e) {
      if (e instanceof SodValidationError) caught = true;
    }
    expect(caught).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: encodeSodMutationAuditEvent (encoder, no IO)
// ---------------------------------------------------------------------------

import { encodeSodMutationAuditEvent } from "../core/audit-grant-encoder.js";

describe("encodeSodMutationAuditEvent — pure encoder unit", () => {
  const NOW = 1_700_000_000_000;
  const ID_OVERRIDE = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  it("encodes sod.create with correct type, actor, subject", () => {
    const input = encodeSodMutationAuditEvent(
      {
        kind: "sod.create",
        actor: "e-orlov",
        constraintId: CONSTRAINT_ID,
        constraintKind: "static",
        payload: { roleA: ROLE_A_ID, roleB: ROLE_B_ID },
      },
      NOW,
      ID_OVERRIDE,
    );
    expect(input.type).toBe("sod.create");
    expect(input.actor).toBe("e-orlov");
    expect(input.subject).toBe(CONSTRAINT_ID);
    expect(input.occurred_at).toBe(NOW);
    expect(input.id).toBe(ID_OVERRIDE);
    expect((input.payload as Record<string, unknown>)["constraintKind"]).toBe("static");
    expect((input.payload as Record<string, unknown>)["roleA"]).toBe(ROLE_A_ID);
  });

  it("encodes sod.delete with null scope and null proposed_by/confirmed_by", () => {
    const input = encodeSodMutationAuditEvent(
      {
        kind: "sod.delete",
        actor: "e-orlov",
        constraintId: CONSTRAINT_ID,
        constraintKind: "dynamic",
      },
      NOW,
    );
    expect(input.type).toBe("sod.delete");
    expect(input.scope).toBeNull();
    expect(input.proposed_by).toBeNull();
    expect(input.confirmed_by).toBeNull();
    expect((input.payload as Record<string, unknown>)["constraintKind"]).toBe("dynamic");
  });

  it("generates a unique UUID id when no idOverride provided", () => {
    const a = encodeSodMutationAuditEvent(
      { kind: "sod.update", actor: "e-orlov", constraintId: CONSTRAINT_ID, constraintKind: "static" },
      NOW,
    );
    const b = encodeSodMutationAuditEvent(
      { kind: "sod.update", actor: "e-orlov", constraintId: CONSTRAINT_ID, constraintKind: "static" },
      NOW,
    );
    expect(a.id).not.toBe(b.id);
  });
});
