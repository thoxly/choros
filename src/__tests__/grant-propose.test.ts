/**
 * T-0039 · grant-propose unit tests
 *
 * Tests registerGrantProposeRoute using injected stubs — no real DB or LLM.
 * Covers:
 *   AC-06 — freeform scope stripped from proposal output
 *   AC-07 — no platform key (static grep — see FF-39-2 fitness check)
 *   AC-11 — invalid atoms dropped, never 500
 *   AC-13 — secret handle not in response (NF-4/FF-39-8)
 *   AC-14 — parseScopeElement used as single scope parser
 *
 * Integration tests (DB-backed) for AC-01..05, AC-08..10, AC-12, AC-15
 * require DATABASE_URL and are exercised in the full e2e suite.
 * This file covers the pure-logic / stub-able paths that don't need a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import {
  registerGrantProposeRoute,
  type GrantProposeDeps,
  type LlmProposeRequest,
  type LlmProposeResponse,
} from "../http/grant-propose.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

/**
 * Make a fake pg.Pool whose client discriminates queries by SQL pattern:
 * - BEGIN/COMMIT/ROLLBACK/SET LOCAL/UPDATE audit_head → no-op rows: []
 * - current_setting GUC → returns test tenant UUID
 * - audit_head SELECT (FOR UPDATE seed-head) → genesis head row
 * - INSERT → accepted silently
 * - agent_card / employee SELECT → returns agentRows
 */
function makeAgentPool(agentRow: Record<string, unknown> | null): pg.Pool {
  const agentRows = agentRow ? [agentRow] : [];

  const stubClient = {
    query: async (_text: string | { text: string }, _values?: unknown[]) => {
      const sql = typeof _text === "string" ? _text : _text.text;

      // Control flow — no meaningful return
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(sql)) return { rows: [] };

      // GUC tenant_id read (used by appendAuditEvent)
      if (/current_setting.*choros\.tenant_id/i.test(sql) && !/INSERT|UPDATE/i.test(sql)) {
        return { rows: [{ tenant_id: TEST_TENANT_ID }] };
      }

      // audit_head SELECT FOR UPDATE → genesis head row
      if (/audit_head/i.test(sql) && /SELECT/i.test(sql)) {
        return {
          rows: [{
            seq: 0,
            row_hash: Buffer.alloc(32, 0),
            vocab_version: 1,
          }],
        };
      }

      // audit_head UPDATE + INSERT (audit_event, audit_head seed) → swallow
      if (/^\s*(INSERT|UPDATE)/i.test(sql)) return { rows: [], rowCount: 1 };

      // agent_card / employee SELECT → return stub rows
      return { rows: agentRows };
    },
    release: () => undefined,
  };
  return {
    connect: async () => stubClient,
  } as unknown as pg.Pool;
}

/** Make a stub audit writer that silently discards audit events */
function makeStubDeps(
  agentRow: Record<string, unknown> | null,
  llmAtoms: unknown[],
): { pool: pg.Pool; deps: GrantProposeDeps } {
  const pool = makeAgentPool(agentRow);


  const deps: GrantProposeDeps = {
    resolveSecret: async (_handle, _ctx) => "test-secret-placeholder",
    callLlm: async (_req: LlmProposeRequest): Promise<LlmProposeResponse> => ({
      atoms: llmAtoms,
    }),
    now: () => 1_700_000_000_000,
  };

  return { pool, deps };
}

/** Build a test HTTP server with the propose route only */
function buildTestServer(
  pool: pg.Pool,
  deps: GrantProposeDeps,
): { server: http.Server; baseUrl: string; close: () => Promise<void> } {
  const router = new Router();
  registerGrantProposeRoute(router, pool, deps);

  const server = http.createServer(router.dispatch.bind(router));
  let baseUrl = "";

  return {
    server,
    get baseUrl() {
      return baseUrl;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startServer(
  pool: pg.Pool,
  deps: GrantProposeDeps,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const t = buildTestServer(pool, deps);
  return new Promise((resolve) => {
    t.server.listen(0, "localhost", () => {
      const addr = t.server.address();
      if (addr && typeof addr !== "string") {
        const baseUrl = `http://localhost:${addr.port}`;
        resolve({ baseUrl, close: t.close });
      }
    });
  });
}

function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(baseUrl + path);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-user": "e-mironov",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 200, body: raw }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test agent card row fixture
// ---------------------------------------------------------------------------

const AGENT_ROW = {
  employee_id: "d0000000-0000-0000-0000-000000000002",
  llm_endpoint: "http://byo-llm.internal/v1/chat/completions",
  llm_secret_handle: "handle-test",
  llm_model: "gpt-4o",
};

const VALID_ROLE_ID = "e0000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// AC-11: invalid atoms dropped, no 500
// ---------------------------------------------------------------------------

describe("AC-11: invalid / freeform atoms dropped, no 500", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const atoms = [
      // Valid node scope atom
      {
        resource_type: "mcp://ledger.invoices",
        operation: "read",
        scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
        reason: "needs ledger read",
      },
      // Freeform scope → must be dropped (NF-3/AC-06)
      {
        resource_type: "mcp://payments.initiate",
        operation: "invoke",
        scope: { kind: "freeform", predicate: "amount < 5000" },
        reason: "freeform should be stripped",
      },
      // Invalid scope (missing nodeId) → dropped
      {
        resource_type: "mcp://support.queue",
        operation: "read",
        scope: { kind: "node", hierarchy: "org" }, // missing nodeId + nodeLevel
      },
      // Null scope → dropped
      {
        resource_type: "mcp://crm.customer",
        operation: "read",
        scope: null,
      },
      // Valid tags scope atom
      {
        resource_type: "mcp://contracts.lookup",
        operation: "read",
        scope: { kind: "tags", tags: ["pii"] },
        reason: "tagged read",
      },
    ];

    const { pool, deps } = makeStubDeps(AGENT_ROW, atoms);
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("returns 200 with only valid atoms (freeform + invalid dropped)", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "finance approver",
      role_id: VALID_ROLE_ID,
    });

    expect(statusCode).toBe(200);
    const data = JSON.parse(body) as { proposal_agent_id: string; proposed: unknown[] };
    expect(data).toHaveProperty("proposal_agent_id");
    expect(data).toHaveProperty("proposed");
    expect(Array.isArray(data.proposed)).toBe(true);

    // Only 2 valid atoms should survive: node + tags
    expect(data.proposed).toHaveLength(2);

    const types = data.proposed.map((a) => (a as { resource_type: string }).resource_type);
    expect(types).toContain("mcp://ledger.invoices");
    expect(types).toContain("mcp://contracts.lookup");

    // Freeform must not appear
    expect(types).not.toContain("mcp://payments.initiate");
  });

  it("does not 500 on a mix of valid and invalid atoms (AC-11)", async () => {
    const { statusCode } = await post(baseUrl, "/api/grants/propose", {
      text: "some role",
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
// AC-06: freeform-only response → empty proposal list, 200 (not 500)
// ---------------------------------------------------------------------------

describe("AC-06: freeform-only LLM response → empty proposed list", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const { pool, deps } = makeStubDeps(AGENT_ROW, [
      { resource_type: "mcp://x", operation: "read", scope: { kind: "freeform", predicate: "x" } },
    ]);
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("returns 200 with empty proposed list when all atoms are freeform", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "admin",
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).toBe(200);
    const data = JSON.parse(body) as { proposed: unknown[] };
    expect(data.proposed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-08: 503 NO_PROPOSAL_AGENT when no BYO agent configured
// ---------------------------------------------------------------------------

describe("AC-08: 503 NO_PROPOSAL_AGENT when no agent configured", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const { pool, deps } = makeStubDeps(null /* no agent */, []);
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("returns 503 with NO_PROPOSAL_AGENT code (AC-08/FR-7)", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "some role",
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).toBe(503);
    const data = JSON.parse(body) as { error: { code: string } };
    expect(data.error.code).toBe("NO_PROPOSAL_AGENT");
  });
});

// ---------------------------------------------------------------------------
// AC-13: secret handle not in response body (NF-4 / FF-39-8)
// ---------------------------------------------------------------------------

describe("AC-13: secret handle not in HTTP response body", () => {
  let close: () => Promise<void>;
  let baseUrl: string;
  const SECRET_SENTINEL = "SUPER-SECRET-TEST-VALUE-AC13";

  beforeAll(async () => {
    const pool = makeAgentPool(AGENT_ROW);
    const deps: GrantProposeDeps = {
      resolveSecret: async (_handle, _ctx) => SECRET_SENTINEL,
      callLlm: async (_req) => ({
        atoms: [
          {
            resource_type: "mcp://ledger.invoices",
            operation: "read",
            scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
          },
        ],
      }),
      now: () => 1_700_000_000_000,
    };
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("response body does not contain the resolved secret (AC-13/NF-4)", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "finance approver",
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).toBe(200);
    // The secret sentinel must never appear in the HTTP response.
    expect(body).not.toContain(SECRET_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Validation: 400 on missing / invalid fields
// ---------------------------------------------------------------------------

describe("Validation: 400 on bad inputs", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const { pool, deps } = makeStubDeps(AGENT_ROW, []);
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("returns 400 VALIDATION when text is missing", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).toBe(400);
    const data = JSON.parse(body) as { error: { code: string } };
    expect(data.error.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION when role_id is not a UUID", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "some role",
      role_id: "not-a-uuid",
    });
    expect(statusCode).toBe(400);
    const data = JSON.parse(body) as { error: { code: string } };
    expect(data.error.code).toBe("VALIDATION");
  });

  it("returns 401 UNAUTHENTICATED when x-dev-user header is missing", async () => {
    const { statusCode } = await post(
      baseUrl,
      "/api/grants/propose",
      { text: "role", role_id: VALID_ROLE_ID },
      { "x-dev-user": "" }, // empty header triggers UNAUTHENTICATED
    );
    expect(statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-01: proposal_agent_id present in response
// ---------------------------------------------------------------------------

describe("AC-01: 200 response includes proposal_agent_id and proposed array", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const { pool, deps } = makeStubDeps(AGENT_ROW, [
      {
        resource_type: "mcp://ledger.invoices",
        operation: "read",
        scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
        reason: "ledger access",
      },
    ]);
    const started = await startServer(pool, deps);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterAll(async () => { await close(); });

  it("returns 200 with proposal_agent_id and proposed list (AC-01)", async () => {
    const { statusCode, body } = await post(baseUrl, "/api/grants/propose", {
      text: "finance approver",
      role_id: VALID_ROLE_ID,
    });
    expect(statusCode).toBe(200);
    const data = JSON.parse(body) as {
      proposal_agent_id: string;
      proposed: Array<{ resource_type: string; operation: string; scope: unknown; reason?: string }>;
    };
    expect(data.proposal_agent_id).toBe(AGENT_ROW.employee_id);
    expect(Array.isArray(data.proposed)).toBe(true);
    expect(data.proposed).toHaveLength(1);
    expect(data.proposed[0].resource_type).toBe("mcp://ledger.invoices");
    expect(data.proposed[0].operation).toBe("read");
    expect(data.proposed[0].scope).toBeDefined();
    expect(data.proposed[0].reason).toBe("ledger access");
  });
});
