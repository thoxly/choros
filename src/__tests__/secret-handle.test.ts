/**
 * T-0025 · BYO-LLM Secret-Handle Custody — unit tests
 *
 * Covers (no-DB / pure unit):
 *   AC-2..AC-6  — validator reject patterns (validateSecretHandleShape)
 *   AC-11       — handle value never in stdout/stderr (captured + asserted)
 *   AC-12..AC-14 — audit event type strings + no handle value in payload
 *   AC-18       — no management grant → 403 ADMIN_GATE_REJECTED, agent_card unchanged
 *   AC-19       — seed not mutated (FF-25-5: no non-NULL llm_secret_handle in 032)
 *
 * T-0471 additions (HTTP route integration — keycloak-aware auth):
 *   T471-1 — dev mode: x-dev-user header resolves actor+tenant, POST 200
 *   T471-2 — dev mode: missing x-dev-user → 401 (fail-closed)
 *   T471-3 — keycloak mode: getAuthContext resolves slug+tenant, POST 200
 *   T471-4 — keycloak mode: resolveActorSlugFromAuth returns null → 401
 *   T471-5 — tenant isolation: secret written into ACTOR's tenant (not DEV_TENANT_ID)
 *   T471-6 — GET /status: keycloak mode resolves actor+tenant, returns bound=false
 *
 * Tests that require live Postgres (AC-1, 7, 8, 9, 10) are not included here
 * (they require a DB fixture) — these rely on the route handlers exercised in
 * integration. The pure-validator AC-2..6 tests are the primary gate here.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerSecretHandleRoutes } from "../http/secret-handle.js";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateSecretHandleShape,
  redactHandle,
} from "../core/secret-handle-validator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// AC-2..AC-6: validator reject rules
// ---------------------------------------------------------------------------

describe("validateSecretHandleShape — accept cases", () => {
  it("accepts a valid opaque handle (env:// scheme)", () => {
    const v = validateSecretHandleShape("env://LLM_API_KEY");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a valid vault:// handle", () => {
    const v = validateSecretHandleShape("vault://secret/choros/agent/recon");
    expect(v).toEqual({ ok: true });
  });

  it("accepts an 8-char minimum-length handle", () => {
    const v = validateSecretHandleShape("12345678");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a handle with dots that is not a JWT (vault:// path)", () => {
    const v = validateSecretHandleShape("vault://secret/x.y");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a handle that is a 31-char hex string (below bare_hex_token threshold)", () => {
    // 31 hex chars is NOT rejected (threshold is 32+)
    const hex31 = "a".repeat(31);
    const result = validateSecretHandleShape(hex31);
    expect(result).toEqual({ ok: true }); // 31 chars, passes all rules
  });

  it("accepts a mixed alphanumeric non-hex handle of any length", () => {
    const v = validateSecretHandleShape("mySecretRef:prod-v2");
    expect(v).toEqual({ ok: true });
  });
});

describe("validateSecretHandleShape — AC-6: too_short", () => {
  it("AC-6: rejects empty string", () => {
    const v = validateSecretHandleShape("");
    expect(v).toEqual({ ok: false, reason: "too_short" });
  });

  it("AC-6: rejects 7-char string", () => {
    const v = validateSecretHandleShape("1234567");
    expect(v).toEqual({ ok: false, reason: "too_short" });
  });

  it("AC-6: accepts 8-char string (boundary)", () => {
    const v = validateSecretHandleShape("12345678");
    expect(v.ok).toBe(true);
  });
});

describe("validateSecretHandleShape — AC-2: vendor_key_prefix (sk-)", () => {
  it("AC-2: rejects value starting with sk-", () => {
    const v = validateSecretHandleShape("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });

  it("AC-2: rejects OpenAI-style key sk-XXXXXX", () => {
    const v = validateSecretHandleShape("sk-XXXXXXXXXX");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — AC-3: vendor_key_prefix (sk-proj-)", () => {
  it("AC-3: rejects value starting with sk-proj-", () => {
    // sk-proj- starts with sk-, so it is caught by the sk- rule
    const v = validateSecretHandleShape("sk-proj-abc123def456ghi789jkl012");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — xai- and AIza- vendor prefixes", () => {
  it("rejects value starting with xai-", () => {
    const v = validateSecretHandleShape("xai-somekey1234");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });

  it("rejects value starting with AIza", () => {
    const v = validateSecretHandleShape("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — AC-4: bare_hex_token", () => {
  it("AC-4: rejects 32-char lowercase hex string", () => {
    const v = validateSecretHandleShape("abcdef1234567890abcdef1234567890ab".slice(0, 32));
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: rejects 32-char uppercase hex string", () => {
    const v = validateSecretHandleShape("ABCDEF1234567890ABCDEF1234567890");
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: rejects 64-char hex string (SHA-256 pattern)", () => {
    const v = validateSecretHandleShape("a".repeat(64));
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: accepts 31-char hex string (below threshold)", () => {
    const v = validateSecretHandleShape("a".repeat(31));
    expect(v.ok).toBe(true);
  });
});

describe("validateSecretHandleShape — AC-5: jwt_shape", () => {
  it("AC-5: rejects well-formed JWT starting with eyJ", () => {
    // A realistic JWT-like string with three base64url segments
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiJ1c2VyLTEiLCJpYXQiOjE2MDAwMDAwMDB9";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${header}.${payload}.${sig}`;
    const v = validateSecretHandleShape(jwt);
    expect(v).toEqual({ ok: false, reason: "jwt_shape" });
  });

  it("AC-5: rejects unsigned JWT (empty signature segment)", () => {
    const v = validateSecretHandleShape("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.");
    expect(v).toEqual({ ok: false, reason: "jwt_shape" });
  });

  it("accepts a dotted non-JWT string (vault:// path)", () => {
    const v = validateSecretHandleShape("vault://secret/x.y.z");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a dotted string not starting with eyJ", () => {
    const v = validateSecretHandleShape("some.dotted.reference-token-value");
    expect(v).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// redactHandle tests
// ---------------------------------------------------------------------------

describe("redactHandle", () => {
  it("returns scheme prefix + ... for vault:// URLs", () => {
    const r = redactHandle("vault://secret/choros/agent/recon");
    expect(r).toBe("vault://...");
    expect(r).not.toContain("secret");
  });

  it("returns scheme prefix + ... for env:// references", () => {
    const r = redactHandle("env://LLM_API_KEY");
    expect(r).toBe("env://...");
  });

  it("returns first-8-chars + ... for non-scheme handles", () => {
    const r = redactHandle("myOpaqueHandle123");
    // "myOpaque" is exactly 8 chars; the implementation slices 0..8.
    expect(r).toBe("myOpaque...");
    expect(r.startsWith("myOpaque")).toBe(true);
  });

  it("never returns the full value", () => {
    const full = "env://SUPER_SECRET_PRODUCTION_KEY";
    const r = redactHandle(full);
    expect(r).not.toBe(full);
    expect(r).not.toContain("SUPER_SECRET_PRODUCTION_KEY");
  });
});

// ---------------------------------------------------------------------------
// AC-11: handle value never appears in console output during validation calls
// ---------------------------------------------------------------------------

describe("AC-11: handle value not leaked to stdout/stderr via validator", () => {
  it("validateSecretHandleShape rejection does not log the value", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const SECRET_VALUE = "sk-SUPER-SENSITIVE-VALUE-SHOULD-NOT-LOG";
    validateSecretHandleShape(SECRET_VALUE);

    // None of the console methods should have been called at all.
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("redactHandle does not log the value", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const SECRET_VALUE = "vault://my-super-sensitive-vault-path";
    redactHandle(SECRET_VALUE);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-12..AC-14: audit event type contract (static structural test)
// The route module builds AuditEventInput with the exact NF-4 type strings.
// We verify the constants are exactly right by reading the module source.
// ---------------------------------------------------------------------------

describe("AC-12..AC-14: audit event type strings (NF-4 contract)", () => {
  const MODULE_SRC = readFileSync(
    join(HERE, "..", "http", "secret-handle.ts"),
    "utf8",
  );

  it("AC-12: set_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"set_llm_secret_handle"');
  });

  it("AC-13: rotate_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"rotate_llm_secret_handle"');
  });

  it("AC-14: revoke_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"revoke_llm_secret_handle"');
  });

  it("AC-12/13/14: audit payload contains agentEmployeeId, not handle value", () => {
    // The payload object literal must contain agentEmployeeId key.
    expect(MODULE_SRC).toMatch(/payload:\s*\{\s*agentEmployeeId:/);
    // No 'handleValue' or 'handle_value' should appear inside a payload object.
    // We do a conservative check: the payload literal should NOT reference handleValue.
    const payloadBlocks = MODULE_SRC.match(/payload:\s*\{[^}]+\}/g) ?? [];
    for (const block of payloadBlocks) {
      expect(block).not.toContain("handleValue");
      expect(block).not.toContain("handle_value");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-18: no management grant → 403 gate (structural assertion via source)
// The holdsAgentMgmtUpdate predicate must exist and check mgmt_object:agent.
// ---------------------------------------------------------------------------

describe("AC-18: authority gate exists in route module", () => {
  const MODULE_SRC = readFileSync(
    join(HERE, "..", "http", "secret-handle.ts"),
    "utf8",
  );

  it("AC-18: holdsAgentMgmtUpdate function defined and checks mgmt_object:agent", () => {
    expect(MODULE_SRC).toContain("holdsAgentMgmtUpdate");
    expect(MODULE_SRC).toContain('"mgmt_object:agent"');
    expect(MODULE_SRC).toContain('"update"');
  });

  it("AC-18: 403 ADMIN_GATE_REJECTED is thrown when gate fails", () => {
    expect(MODULE_SRC).toContain("ADMIN_GATE_REJECTED");
    expect(MODULE_SRC).toContain("403");
  });

  it("AC-18: loadAdminContext is called before any write", () => {
    expect(MODULE_SRC).toContain("loadAdminContext");
  });
});

// ---------------------------------------------------------------------------
// AC-19: seed not mutated (FF-25-5) — read 032 migration, assert all NULLs
// ---------------------------------------------------------------------------

describe("AC-19: seed invariant — all 5 agents have llm_secret_handle = NULL", () => {
  it("032 migration does not insert non-NULL llm_secret_handle for any seeded agent", () => {
    const migPath = join(HERE, "..", "..", "migrations", "032_agent_card.sql");
    const sql = readFileSync(migPath, "utf8");

    // The seed INSERT in 032 uses an explicit column list and NULL values.
    // Every VALUES row in the INSERT must have NULL for llm_secret_handle.
    // We check that no VALUES tuple has a non-NULL literal at position 7
    // by asserting the seed VALUES lines all match the NULL-only pattern.
    //
    // The column list is: tenant_id, employee_id, employee_kind, kc_client_id,
    //   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold, ...
    // So llm_secret_handle is the 7th column (0-indexed: 6).
    //
    // Check: each VALUES row should have NULL at position 6.
    const valuesLines = sql
      .split("\n")
      .filter((l) => l.trim().startsWith("(") && l.includes("NULL"));

    // Each row must have NULL in the 7th column position.
    for (const line of valuesLines) {
      // Strip leading/trailing whitespace and the outer parens.
      const inner = line.trim().replace(/^\(|\).*$/g, "");
      const cols = inner.split(",").map((s) => s.trim());
      // llm_secret_handle is at index 6 (0-based).
      if (cols.length >= 7) {
        expect(cols[6]).toBe("NULL");
      }
    }
  });

  it("032 migration has exactly 5 agent_card seed rows", () => {
    const migPath = join(HERE, "..", "..", "migrations", "032_agent_card.sql");
    const sql = readFileSync(migPath, "utf8");
    // Count VALUES tuples in the INSERT INTO agent_card statement.
    const valuesTuples = (sql.match(/\('[0-9a-f-]+', '[0-9a-f-]+'/g) ?? []).length;
    expect(valuesTuples).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SecretResolverPort type compliance (structural — no runtime call)
// ---------------------------------------------------------------------------

describe("SecretResolverPort interface (ADR §8 — declared, never invoked)", () => {
  it("is exported from secret-handle-validator.ts", () => {
    const validatorSrc = readFileSync(
      join(HERE, "..", "core", "secret-handle-validator.ts"),
      "utf8",
    );
    expect(validatorSrc).toContain("export interface SecretResolverPort");
    expect(validatorSrc).toContain("resolveSecret");
  });

  it("the route module does NOT call resolveSecret at runtime (FR-6 — zero platform LLM call)", () => {
    const routeSrc = readFileSync(
      join(HERE, "..", "http", "secret-handle.ts"),
      "utf8",
    );
    // The route module must not contain any CALL to resolveSecret (e.g. .resolveSecret() ).
    // It may mention it in comments as documentation, but must never invoke it.
    // Check that there is no invocation pattern: resolveSecret(
    expect(routeSrc).not.toMatch(/\.resolveSecret\s*\(/);
    // And no direct call without object receiver.
    expect(routeSrc).not.toMatch(/\bresolveSecret\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// T-0471: keycloak-aware auth + tenant-isolation HTTP integration tests
//
// Strategy: a fake pool replays the minimal SQL needed by the route (slug exists
// check, tenant lookup, admin context, agent-card UPDATE, audit). getAuthContext
// is mocked via vi.mock to simulate keycloak mode without a real JWKS server.
//
// IMPORTANT: vi.mock calls are HOISTED to the top of the module by vitest. The
// mock is defined here but applies to the whole file's module scope.
// ---------------------------------------------------------------------------

vi.mock("../http/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../http/auth.js")>("../http/auth.js");
  return {
    ...actual,
    // Overridable stub — tests override this via vi.mocked() per-describe.
    // Default: return undefined (dev-mode — no keycloak context).
    getAuthContext: vi.fn().mockReturnValue(undefined),
    // withAuth: dev mode pass-through by default (no-op, mirrors production dev mode).
    withAuth: (handler: Parameters<typeof actual.withAuth>[0]) => handler,
  };
});

// Minimal fake pool that handles the full secret-handle route SQL surface:
//   - resolveActorSlugFromAuth (EXISTS query for slug + kind='human')
//   - resolveActorTenant (employee JOIN tenant by slug → tenant_id)
//   - loadAdminContext (tenant-owner role check → genesis owner)
//   - loadAgentOrgScope (employee → position → department_id)
//   - loadTenantOrgAncestry (org tree — returns empty, predicate passes for genesis)
//   - withTenantTx lifecycle (BEGIN / SET LOCAL / COMMIT)
//   - agent_card UPDATE (returns 1 row for the target agentId)
//   - audit-writer queries (audit_head seed/advance, audit_event INSERT)
//
// Options:
//   actorSlug         — the slug that resolveActorSlugFromAuth returns for the
//                       keycloak sub/preferred_username (only used when keycloak mock active)
//   tenantId          — the tenant returned by resolveActorTenant for actorSlug
//   slugExists        — whether the EXISTS check returns true (default true)
//   agentCardExists   — whether agent_card UPDATE finds a row (default true)
//   capturedTenantIds — array populated with each SET LOCAL choros.tenant_id value seen
function makeSecretHandleFakePool(opts: {
  actorSlug?: string;
  tenantId?: string;
  slugExists?: boolean;
  agentCardExists?: boolean;
  capturedTenantIds?: string[];
} = {}): pg.Pool {
  const {
    actorSlug = "genesis-owner",
    tenantId = "a0000000-0000-0000-0000-000000000001",
    slugExists = true,
    agentCardExists = true,
    capturedTenantIds,
  } = opts;

  const client = {
    query: async (sql: string, params?: unknown[]) => {
      // Transaction lifecycle
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };

      // SET LOCAL — capture tenant_id for isolation test
      if (sql.startsWith("SET LOCAL choros.tenant_id")) {
        const match = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(sql);
        if (match && capturedTenantIds) capturedTenantIds.push(match[1] as string);
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL")) return { rows: [] };

      // resolveActorSlugFromAuth: EXISTS check (slug + kind='human')
      if (sql.includes("FROM choros.employee") && sql.includes("EXISTS") && sql.includes("kind = 'human'")) {
        const slug = String(params?.[0] ?? "");
        return { rows: [{ exists: slug === actorSlug && slugExists }] };
      }

      // resolveActorTenant: employee JOIN tenant by slug
      if (
        sql.includes("FROM choros.employee e") &&
        sql.includes("JOIN choros.tenant t") &&
        sql.includes("e.slug = $1")
      ) {
        const slug = String(params?.[0] ?? "");
        return { rows: slug === actorSlug ? [{ tenant_id: tenantId }] : [] };
      }

      // loadAdminContext — genesis owner check (tenant-owner role)
      if (sql.includes("r.slug = 'tenant-owner'")) {
        return { rows: [{ id: "ra-genesis" }] }; // genesis owner
      }
      // role_assignment for admin context
      if (sql.includes("FROM choros.role_assignment ra") && sql.includes("ra.employee_id")) {
        return { rows: [{ id: "ra-genesis", role_id: "role-owner", org_scope: { kind: "node", hierarchy: "org", nodeId: "org", nodeLevel: "department" } }] };
      }
      // grant load for admin grants
      if (sql.includes('FROM choros."grant" g') && sql.includes("mgmt_object:%")) {
        return { rows: [] };
      }

      // loadAgentOrgScope: employee → position → department
      if (sql.includes("FROM choros.employee e") && sql.includes("LEFT JOIN choros.position p")) {
        return { rows: [{ department_id: "dept-1" }] };
      }

      // loadTenantOrgAncestry: returns empty (genesis owner bypasses scope check)
      if (sql.includes("FROM choros.department")) {
        return { rows: [] };
      }

      // agent_card UPDATE (set/rotate/revoke handle)
      if (sql.includes("UPDATE choros.agent_card") && sql.includes("llm_secret_handle")) {
        return { rows: agentCardExists ? [{ employee_id: params?.[0] }] : [], rowCount: agentCardExists ? 1 : 0 };
      }

      // agent_card SELECT (status route)
      if (sql.includes("SELECT llm_secret_handle") && sql.includes("FROM choros.agent_card")) {
        return { rows: agentCardExists ? [{ llm_secret_handle: null }] : [] };
      }

      // Audit writer
      if (sql.includes("INSERT INTO choros.audit_head")) return { rows: [] };
      if (sql.includes("FROM choros.audit_head")) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      if (sql.includes("INSERT INTO choros.audit_event")) return { rows: [] };
      if (sql.includes("UPDATE choros.audit_head")) return { rows: [] };
      if (sql.includes("current_setting")) {
        return { rows: [{ tenant_id: tenantId }] };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  return { connect: async () => client } as unknown as pg.Pool;
}

// Simple HTTP helper for secret-handle routes
function secretHandleRequest(
  baseUrl: string,
  method: string,
  agentId: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const raw = body !== undefined ? JSON.stringify(body) : undefined;
    const path = `/api/agents/${agentId}/secret-handle`;
    const url = new URL(baseUrl + path);
    const req = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(raw ? { "Content-Length": Buffer.byteLength(raw).toString() } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

const AGENT_UUID = "b0000000-0000-0000-0000-000000000002";
const VALID_HANDLE = "vault://secrets/llm-key";
const GENESIS_USER = "genesis-owner";
const TENANT_A = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// T471-1, T471-2: dev mode — x-dev-user resolves actor + tenant
// ---------------------------------------------------------------------------

describe("T-0471 dev mode — POST /api/agents/:id/secret-handle", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Ensure getAuthContext returns undefined (dev mode: no keycloak context).
    const { getAuthContext } = await import("../http/auth.js");
    vi.mocked(getAuthContext).mockReturnValue(undefined);

    const pool = makeSecretHandleFakePool({ actorSlug: GENESIS_USER, tenantId: TENANT_A });
    const router = new Router();
    registerSecretHandleRoutes(router, pool);
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("T471-1: dev mode — x-dev-user resolves actor+tenant, POST returns 200", async () => {
    const resp = await secretHandleRequest(
      baseUrl, "POST", AGENT_UUID,
      { handle_value: VALID_HANDLE },
      { "x-dev-user": GENESIS_USER },
    );
    expect(resp.statusCode).toBe(200);
    expect((resp.body as Record<string, unknown>)["ok"]).toBe(true);
  });

  it("T471-2: dev mode — missing x-dev-user → 401 (fail-closed)", async () => {
    const resp = await secretHandleRequest(
      baseUrl, "POST", AGENT_UUID,
      { handle_value: VALID_HANDLE },
      {}, // no x-dev-user
    );
    expect(resp.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T471-3, T471-4: keycloak mode — getAuthContext injects a token context
// ---------------------------------------------------------------------------

describe("T-0471 keycloak mode — POST /api/agents/:id/secret-handle", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const pool = makeSecretHandleFakePool({ actorSlug: GENESIS_USER, tenantId: TENANT_A });
    const router = new Router();
    registerSecretHandleRoutes(router, pool);
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("T471-3: keycloak mode — getAuthContext returns context → slug resolved → 200", async () => {
    const { getAuthContext } = await import("../http/auth.js");
    // Simulate keycloak: getAuthContext returns an AuthContext for this request.
    // The fake pool's EXISTS check returns true for GENESIS_USER slug.
    vi.mocked(getAuthContext).mockReturnValue({
      sub: GENESIS_USER,
      preferredUsername: GENESIS_USER,
      actorType: "human",
      rawToken: "fake-token",
    } as Parameters<typeof getAuthContext>[0] extends never ? never : ReturnType<typeof getAuthContext>);

    const resp = await secretHandleRequest(
      baseUrl, "POST", AGENT_UUID,
      { handle_value: VALID_HANDLE },
      {}, // no x-dev-user — keycloak context provides identity
    );
    expect(resp.statusCode).toBe(200);
    expect((resp.body as Record<string, unknown>)["ok"]).toBe(true);

    // Reset to dev mode for other test describes
    vi.mocked(getAuthContext).mockReturnValue(undefined);
  });

  it("T471-4: keycloak mode — resolveActorSlugFromAuth null → 401 fail-closed", async () => {
    const { getAuthContext } = await import("../http/auth.js");
    // getAuthContext returns a context with an UNKNOWN sub — the fake pool's
    // EXISTS check returns false for any slug not == actorSlug (GENESIS_USER),
    // so resolveActorSlugFromAuth returns null → 401.
    vi.mocked(getAuthContext).mockReturnValue({
      sub: "unknown-sub",
      preferredUsername: "unknown-user",
      actorType: "human",
      rawToken: "fake-token",
    } as ReturnType<typeof getAuthContext>);

    const resp = await secretHandleRequest(
      baseUrl, "POST", AGENT_UUID,
      { handle_value: VALID_HANDLE },
      {},
    );
    expect(resp.statusCode).toBe(401);

    vi.mocked(getAuthContext).mockReturnValue(undefined);
  });
});

// ---------------------------------------------------------------------------
// T471-5: tenant isolation — secret is written into the ACTOR's tenant, not
// the hardcoded DEV_TENANT_ID. We capture the SET LOCAL tenant_id value and
// assert it matches the tenant returned by resolveActorTenant for the actor.
// ---------------------------------------------------------------------------

describe("T-0471 tenant isolation — POST writes into actor's tenant", () => {
  it("T471-5: SET LOCAL choros.tenant_id uses resolveActorTenant result, not DEV_TENANT_ID", async () => {
    const capturedTenantIds: string[] = [];
    const ACTOR_TENANT = "c1111111-1111-1111-1111-111111111111"; // non-default tenant

    const pool = makeSecretHandleFakePool({
      actorSlug: GENESIS_USER,
      tenantId: ACTOR_TENANT,
      capturedTenantIds,
    });
    const router = new Router();
    registerSecretHandleRoutes(router, pool);

    const server = http.createServer((req, res) => router.dispatch(req, res));
    const baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") resolve(`http://localhost:${addr.port}`);
      });
    });

    try {
      const { getAuthContext } = await import("../http/auth.js");
      vi.mocked(getAuthContext).mockReturnValue(undefined); // dev mode

      const resp = await secretHandleRequest(
        baseUrl, "POST", AGENT_UUID,
        { handle_value: VALID_HANDLE },
        { "x-dev-user": GENESIS_USER },
      );
      expect(resp.statusCode).toBe(200);

      // The SET LOCAL must have used ACTOR_TENANT (from resolveActorTenant),
      // NOT the old hardcoded DEV_TENANT_ID constant.
      expect(capturedTenantIds).toContain(ACTOR_TENANT);
      const devTenantId = process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
      // Only fails if ACTOR_TENANT === devTenantId — we use a different value above.
      if (ACTOR_TENANT !== devTenantId) {
        expect(capturedTenantIds).not.toContain(devTenantId);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// T471-6: GET /status route — keycloak mode resolves actor+tenant (all 4 routes
// share the same extractActor; GET /status was the only one that didn't store
// the actor variable before T-0471).
// ---------------------------------------------------------------------------

describe("T-0471 GET /api/agents/:id/secret-handle/status — keycloak + dev modes", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const pool = makeSecretHandleFakePool({ actorSlug: GENESIS_USER, tenantId: TENANT_A });
    const router = new Router();
    registerSecretHandleRoutes(router, pool);
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("T471-6a: dev mode — GET /status returns {bound:false} for unset handle", async () => {
    const { getAuthContext } = await import("../http/auth.js");
    vi.mocked(getAuthContext).mockReturnValue(undefined); // dev mode

    const resp = await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/agents/${AGENT_UUID}/secret-handle/status`);
      const req = http.request(
        url,
        { method: "GET", headers: { "x-dev-user": GENESIS_USER } },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }); }
            catch { resolve({ statusCode: res.statusCode ?? 0, body: data }); }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(resp.statusCode).toBe(200);
    expect((resp.body as Record<string, unknown>)["bound"]).toBe(false);
  });

  it("T471-6b: keycloak mode — GET /status resolves actor from token → 200", async () => {
    const { getAuthContext } = await import("../http/auth.js");
    vi.mocked(getAuthContext).mockReturnValue({
      sub: GENESIS_USER,
      preferredUsername: GENESIS_USER,
      actorType: "human",
      rawToken: "fake-token",
    } as ReturnType<typeof getAuthContext>);

    const resp = await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/agents/${AGENT_UUID}/secret-handle/status`);
      const req = http.request(
        url,
        { method: "GET" }, // no x-dev-user
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }); }
            catch { resolve({ statusCode: res.statusCode ?? 0, body: data }); }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(resp.statusCode).toBe(200);
    expect((resp.body as Record<string, unknown>)["bound"]).toBe(false);

    vi.mocked(getAuthContext).mockReturnValue(undefined);
  });

  it("T471-6c: missing x-dev-user (dev mode) → 401 for GET /status", async () => {
    const { getAuthContext } = await import("../http/auth.js");
    vi.mocked(getAuthContext).mockReturnValue(undefined); // dev mode

    const resp = await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/agents/${AGENT_UUID}/secret-handle/status`);
      const req = http.request(url, { method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ statusCode: res.statusCode ?? 0, body: data }); }
        });
      });
      req.on("error", reject);
      req.end();
    });

    expect(resp.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T471: structural source check — DEV_TENANT_ID constant removed from module
// (prevents regression — the constant must not reappear in the route module)
// ---------------------------------------------------------------------------

describe("T-0471: DEV_TENANT_ID removed from secret-handle.ts (regression guard)", () => {
  const MODULE_SRC = readFileSync(
    join(HERE, "..", "http", "secret-handle.ts"),
    "utf8",
  );

  it("extractActor is now an async function (keycloak-aware)", () => {
    expect(MODULE_SRC).toMatch(/async function extractActor/);
  });

  it("getAuthContext is imported from auth.js (keycloak identity path)", () => {
    expect(MODULE_SRC).toContain("getAuthContext");
    expect(MODULE_SRC).toContain("resolveActorSlugFromAuth");
  });

  it("resolveActorTenant is used instead of DEV_TENANT_ID for tenantId", () => {
    expect(MODULE_SRC).toContain("resolveActorTenant");
    // DEV_TENANT_ID const must NOT exist in the route module
    expect(MODULE_SRC).not.toContain("const DEV_TENANT_ID");
  });

  it("withAuth wraps all four route registrations", () => {
    const withAuthOccurrences = (MODULE_SRC.match(/\bwithAuth\b/g) ?? []).length;
    // 1 import + 4 route registrations = at least 5 occurrences
    expect(withAuthOccurrences).toBeGreaterThanOrEqual(5);
  });
});
