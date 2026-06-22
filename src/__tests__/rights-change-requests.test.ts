/**
 * src/__tests__/rights-change-requests.test.ts — T-0390 [D2-FU]
 *
 * Static (no-DB) tests for the dual-control change-request API.
 * Uses stub pg.Pool that discriminates query results by SQL pattern.
 * No live Postgres required.
 *
 * Covers:
 *   CR-1  list returns tenant's pending (semi-confirmed) change requests
 *   CR-2  approve by a DIFFERENT person succeeds (sets confirmed2_by)
 *   CR-3  approve by the proposer (same as confirmed_by) is rejected 409
 *   CR-4  approve by an agent is rejected 403 AGENT_NOT_ALLOWED (DC-3)
 *   CR-5  approve on already-confirmed row is rejected 409 ALREADY_CONFIRMED
 *   CR-6  cross-tenant isolation — empty rows from stub = 404
 *   CR-7  reject succeeds for a pending row (grant hard-deleted; not in list)
 *   CR-8  approve on non-existent id is rejected 404
 *   CR-9  routing — list endpoint wins when registered before :roleId catch-all
 *   CR-10 reject removes the pending grant row (hard-delete, not present after)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRightsChangeRequestRoutes } from "../http/rights-change-requests.js";
import { registerRightsRoutes } from "../http/rights.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A     = "a0000000-0000-0000-0000-000000000001";
const GRANT_ID     = "b0000000-0000-0000-0000-000000000001";
const ACTOR_HUMAN  = "e-human";
const ACTOR_PROPOSER = "e-proposer";
const ACTOR_AGENT  = "e-agent";

// ---------------------------------------------------------------------------
// Stub pg.Pool factory
// ---------------------------------------------------------------------------

interface StubOptions {
  /** Rows to return for LIST grants query + approve/reject SELECT queries */
  grantRows?: Record<string, unknown>[];
  /** Rows to return for LIST role_assignments query */
  raRows?: Record<string, unknown>[];
  /** Employee kind for DC-3 check */
  employeeKind?: "human" | "agent";
  /** rowCount returned by UPDATE (1 = success, 0 = race) */
  updateRowCount?: number;
  /** Callback invoked when a DELETE statement is executed (for assertion) */
  onDelete?: (sql: string) => void;
}

function makePool(opts: StubOptions = {}): pg.Pool {
  const {
    grantRows = [],
    raRows = [],
    employeeKind = "human",
    updateRowCount = 1,
    onDelete,
  } = opts;

  const stubClient = {
    query: async (_text: string | { text: string }, _values?: unknown[]) => {
      const sql = typeof _text === "string" ? _text : _text.text;

      // ── Transaction lifecycle ──────────────────────────────────────────────
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // ── resolveActorTenant ─────────────────────────────────────────────────
      // SELECT e.tenant_id FROM choros.employee e JOIN choros.tenant ... WHERE e.slug = $1
      if (/choros\.employee.*WHERE\s+e\.slug/is.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // ── assertApproverIsHuman ──────────────────────────────────────────────
      // SELECT kind FROM choros.employee WHERE tenant_id = $1 AND slug = $2
      if (/SELECT\s+kind\s+FROM\s+choros\.employee/i.test(sql)) {
        return { rows: [{ kind: employeeKind }], rowCount: 1 };
      }

      // ── LIST: semi-confirmed grants ────────────────────────────────────────
      // The list query joins to choros.role — distinguish by LEFT JOIN choros.role
      if (
        /FROM\s+choros\."grant"\s+g/i.test(sql) &&
        /LEFT\s+JOIN\s+choros\.role\s+r/i.test(sql)
      ) {
        return { rows: grantRows, rowCount: grantRows.length };
      }

      // ── LIST: semi-confirmed role_assignments ──────────────────────────────
      if (
        /FROM\s+choros\.role_assignment\s+ra/i.test(sql) &&
        /LEFT\s+JOIN\s+choros\.role\s+r/i.test(sql)
      ) {
        return { rows: raRows, rowCount: raRows.length };
      }

      // ── APPROVE/REJECT: SELECT proposed_by, confirmed_by, confirmed2_by FROM choros."grant" ──
      if (
        /SELECT\s+proposed_by,\s+confirmed_by,\s+confirmed2_by\s+FROM\s+choros\."grant"/i.test(sql)
      ) {
        return { rows: grantRows.slice(0, 1), rowCount: Math.min(grantRows.length, 1) };
      }

      // ── APPROVE/REJECT: SELECT proposed_by, confirmed_by, confirmed2_by FROM choros.role_assignment ──
      if (
        /SELECT\s+proposed_by,\s+confirmed_by,\s+confirmed2_by\s+FROM\s+choros\.role_assignment/i.test(sql)
      ) {
        if (grantRows.length > 0) {
          // Grant table already returned a row; this RA query won't be reached
          return { rows: [], rowCount: 0 };
        }
        return { rows: raRows.slice(0, 1), rowCount: Math.min(raRows.length, 1) };
      }

      // ── REJECT: SELECT confirmed2_by FROM choros."grant" ──────────────────
      if (
        /SELECT\s+confirmed2_by\s+FROM\s+choros\."grant"/i.test(sql)
      ) {
        return { rows: grantRows.slice(0, 1), rowCount: Math.min(grantRows.length, 1) };
      }

      // ── REJECT: SELECT confirmed2_by FROM choros.role_assignment ──────────
      if (
        /SELECT\s+confirmed2_by\s+FROM\s+choros\.role_assignment/i.test(sql)
      ) {
        if (grantRows.length > 0) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: raRows.slice(0, 1), rowCount: Math.min(raRows.length, 1) };
      }

      // ── Audit queries — ordered carefully to avoid current_setting false-match ──
      //
      // Both INSERT INTO choros.audit_head and UPDATE choros.audit_head embed
      // `current_setting('choros.tenant_id', false)::uuid` in their SQL, so they
      // would match the current_setting pattern if it came first. We match the
      // more specific audit_head patterns BEFORE the generic current_setting check.
      //
      // INSERT INTO choros.audit_head ... ON CONFLICT DO NOTHING (seed)
      if (/INSERT\s+INTO\s+choros\.audit_head/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // UPDATE choros.audit_head SET seq ... (advance)
      if (/UPDATE\s+choros\.audit_head/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      // SELECT seq, row_hash, vocab_version FROM choros.audit_head ... FOR UPDATE
      if (/audit_head/i.test(sql) && /FOR\s+UPDATE/i.test(sql)) {
        return {
          rows: [{
            seq: 0n,
            // row_hash must be a Buffer (audit-writer.ts buildRow takes prevHash: Buffer)
            row_hash: Buffer.alloc(32, 0),
            vocab_version: 1,
          }],
          rowCount: 1,
        };
      }

      // ── current_setting GUC (SELECT current_setting(...) AS tenant_id) ────
      if (/current_setting.*choros\.tenant_id/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // ── Audit INSERT (audit_event) ─────────────────────────────────────────
      if (/INSERT\s+INTO/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // ── DELETE (reject grant — hard-delete of pending row) ────────────────
      if (/DELETE\s+FROM\s+choros\."grant"/i.test(sql)) {
        onDelete?.(sql);
        return { rows: [], rowCount: 1 };
      }

      // ── UPDATE (approve / reject — grant or role_assignment table) ────────
      if (/UPDATE\s+choros/i.test(sql)) {
        return { rows: [], rowCount: updateRowCount };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  return {
    connect: async () => stubClient as unknown as pg.PoolClient,
    query: async (...args: Parameters<typeof stubClient.query>) =>
      stubClient.query(...args) as unknown as pg.QueryResult,
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function makeHttpServer(pool: pg.Pool): http.Server {
  const router = new Router();
  registerRightsChangeRequestRoutes(router, pool);
  return http.createServer(router.dispatch.bind(router));
}

async function startTestServer(
  pool: pg.Pool,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = makeHttpServer(pool);
  return new Promise((resolve) => {
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        resolve({
          baseUrl: `http://localhost:${addr.port}`,
          close: () => new Promise((res) => server.close(() => res())),
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const url = new URL(baseUrl + path);
    const httpReq = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(bodyStr !== undefined
            ? { "Content-Length": String(Buffer.byteLength(bodyStr)) }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    httpReq.on("error", reject);
    if (bodyStr !== undefined) httpReq.write(bodyStr);
    httpReq.end();
  });
}

// ---------------------------------------------------------------------------
// CR-1: list returns tenant's pending change requests
// ---------------------------------------------------------------------------

describe("CR-1 — list pending change requests", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const GRANT_ROW = {
    id: GRANT_ID,
    role_id: "role-1",
    role_name: "Согласование",
    resource_type: "invoice",
    operation: "approve",
    scope: { kind: "node" },
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    created_at: "1700000000000",
  };

  beforeAll(async () => {
    const s = await startTestServer(makePool({ grantRows: [GRANT_ROW] }));
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("returns 200 with a change_requests array", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/change-requests", {
      "x-dev-user": ACTOR_HUMAN,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { change_requests: unknown[]; total: number };
    expect(Array.isArray(data.change_requests)).toBe(true);
    expect(data.total).toBeGreaterThanOrEqual(1);
    const item = data.change_requests[0] as Record<string, unknown>;
    expect(item["id"]).toBe(GRANT_ID);
    expect(item["kind"]).toBe("grant");
    expect(item["description"]).toBe("invoice:approve");
  });

  it("returns 401 without auth header", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/change-requests");
    expect(res.status).toBe(401);
  });

  it("returns empty list when no pending requests exist", async () => {
    const pool = makePool({ grantRows: [], raRows: [] });
    const s = await startTestServer(pool);
    try {
      const res = await req(s.baseUrl, "GET", "/api/rights/change-requests", {
        "x-dev-user": ACTOR_HUMAN,
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body) as { change_requests: unknown[]; total: number };
      expect(data.total).toBe(0);
      expect(data.change_requests).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CR-2: approve by a DIFFERENT person succeeds
// ---------------------------------------------------------------------------

describe("CR-2 — approve by different human returns 200", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: null,
  };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({ grantRows: [GRANT_ROW], employeeKind: "human", updateRowCount: 1 }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("different human actor → 200 confirmed", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_HUMAN },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as Record<string, unknown>;
    expect(data["state"]).toBe("confirmed");
    expect(data["id"]).toBe(GRANT_ID);
    expect(data["kind"]).toBe("grant");
  });
});

// ---------------------------------------------------------------------------
// CR-3: approve by the proposer/first confirmer is rejected
// ---------------------------------------------------------------------------

describe("CR-3 — self-approve rejected 409 (DC-1/DC-2)", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  // proposed_by == confirmed_by == ACTOR_PROPOSER; actor = ACTOR_PROPOSER → self-approve
  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: null,
  };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({ grantRows: [GRANT_ROW], employeeKind: "human" }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("proposer approving own request → 409 DUAL_CONTROL_SELF_APPROVE", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_PROPOSER },
    );
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("DUAL_CONTROL_SELF_APPROVE");
  });
});

// ---------------------------------------------------------------------------
// CR-4: approve by an agent is rejected 403 (DC-3)
// ---------------------------------------------------------------------------

describe("CR-4 — agent approver rejected 403 (DC-3)", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: null,
  };

  beforeAll(async () => {
    // employeeKind = "agent" → assertApproverIsHuman fires before any DB write
    const s = await startTestServer(
      makePool({ grantRows: [GRANT_ROW], employeeKind: "agent" }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("agent actor → 403 AGENT_NOT_ALLOWED", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_AGENT },
    );
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_NOT_ALLOWED");
  });
});

// ---------------------------------------------------------------------------
// CR-5: approve on already-confirmed row → 409 ALREADY_CONFIRMED
// ---------------------------------------------------------------------------

describe("CR-5 — already-confirmed row rejected 409", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: "e-already-approved", // already set!
  };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({ grantRows: [GRANT_ROW], employeeKind: "human" }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("approve already-confirmed → 409 ALREADY_CONFIRMED", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_HUMAN },
    );
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("ALREADY_CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// CR-6: cross-tenant isolation — empty rows = 404
// ---------------------------------------------------------------------------

describe("CR-6 — cross-tenant isolation returns 404", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    // Empty rows: RLS returns nothing for a change_request owned by another tenant.
    const s = await startTestServer(
      makePool({ grantRows: [], raRows: [], employeeKind: "human" }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("approve unknown id → 404", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_HUMAN },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CR-7: reject succeeds for a pending row
// ---------------------------------------------------------------------------

describe("CR-7 — reject pending row returns 200", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: null,
  };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({ grantRows: [GRANT_ROW], employeeKind: "human", updateRowCount: 1 }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("reject returns 200 with state=rejected", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/reject`,
      { "x-dev-user": ACTOR_HUMAN },
      { reason: "Не соответствует политике" },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as Record<string, unknown>;
    expect(data["id"]).toBe(GRANT_ID);
    expect(data["state"]).toBe("rejected");
    expect(data["kind"]).toBe("grant");
  });
});

// ---------------------------------------------------------------------------
// CR-8: approve non-existent id → 404
// ---------------------------------------------------------------------------

describe("CR-8 — approve non-existent id returns 404", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({ grantRows: [], raRows: [], employeeKind: "human" }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("approve missing id → 404", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/approve`,
      { "x-dev-user": ACTOR_HUMAN },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CR-9: routing collision — list endpoint wins when registered before :roleId
// ---------------------------------------------------------------------------

describe("CR-9 — routing: list endpoint resolves before :roleId catch-all", () => {
  // This test registers BOTH route sets in server.ts order:
  //   1. registerRightsChangeRequestRoutes (static literal paths)
  //   2. registerRightsRoutes              (includes GET /api/rights/:roleId)
  // The list endpoint MUST resolve to the change-request handler, not :roleId.
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const router = new Router();
    const pool = makePool({ grantRows: [], raRows: [] });
    // Register in server.ts order — change-requests BEFORE :roleId catch-all.
    registerRightsChangeRequestRoutes(router, pool);
    registerRightsRoutes(router);
    server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://localhost:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it("GET /api/rights/change-requests resolves to list handler (not :roleId 404)", async () => {
    // The list handler returns 200 with change_requests array (empty, no rows).
    // If :roleId catch-all wins instead, it would call findRole("change-requests")
    // and return 404. We assert 200 + JSON shape.
    const res = await req(baseUrl, "GET", "/api/rights/change-requests", {
      "x-dev-user": ACTOR_HUMAN,
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { change_requests: unknown[]; total: number };
    expect(Array.isArray(data.change_requests)).toBe(true);
    expect(typeof data.total).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// CR-10: reject hard-deletes the pending grant row (not a soft-delete)
// ---------------------------------------------------------------------------

describe("CR-10 — reject issues DELETE (not UPDATE) for pending grant", () => {
  let close: () => Promise<void>;
  let baseUrl: string;
  const deletedSqls: string[] = [];

  const GRANT_ROW = {
    proposed_by: ACTOR_PROPOSER,
    confirmed_by: ACTOR_PROPOSER,
    confirmed2_by: null,
  };

  beforeAll(async () => {
    const pool = makePool({
      grantRows: [GRANT_ROW],
      employeeKind: "human",
      onDelete: (sql) => deletedSqls.push(sql),
    });
    const s = await startTestServer(pool);
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("reject returns 200 state=rejected", async () => {
    const res = await req(
      baseUrl, "POST", `/api/rights/change-requests/${GRANT_ID}/reject`,
      { "x-dev-user": ACTOR_HUMAN },
      { reason: "не соответствует политике" },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as Record<string, unknown>;
    expect(data["state"]).toBe("rejected");
    expect(data["kind"]).toBe("grant");
  });

  it("a DELETE statement was issued for the grant row (hard-delete, not soft)", () => {
    // The stub onDelete callback fires on DELETE FROM choros."grant".
    // If the old soft-delete code (UPDATE SET valid_until) ran instead,
    // deletedSqls would be empty and this test would fail.
    expect(deletedSqls.length).toBeGreaterThanOrEqual(1);
    expect(deletedSqls[0]).toMatch(/DELETE\s+FROM\s+choros\."grant"/i);
    expect(deletedSqls[0]).toMatch(/confirmed2_by\s+IS\s+NULL/i);
  });
});
