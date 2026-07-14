/**
 * T-0513 [SECURITY] — artifacts.ts promote authority gate (fail-closed authz).
 *
 * AC coverage:
 *   AC-1  POST /api/artifacts/:id/promote with actor holding the promote grant → 200 or
 *         non-403 (gate passes; 404 when artifact not in fake DB rows).
 *   AC-2  POST promote WITHOUT the promote grant → 403 NO_PROMOTE_GRANT
 *         (was previously allowed — this is the core security fix).
 *   AC-3  Agent actor → 403 FORBIDDEN_AGENT_SELF_PROMOTE (existing guard unchanged).
 *   AC-4  promote already-published artifact → 409 NOT_IN_DRAFT (existing guard unchanged).
 *   AC-5  deny stub → 403 regardless of artifact state; proves gate fires before promoteTier.
 *   AC-6  deny deps blocks every actor slug (cross-tenant proxy for unauthorized actors).
 *
 * No live DATABASE_URL. Fake pool injected via _poolHint param (mirrors report-pages.ts).
 * T-0144 discipline: BEGIN before SET LOCAL handled inside withTenantTx (tested via pool structure).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import {
  registerArtifactRoutes,
  resetPoolForTesting,
  type ArtifactAuthzDeps,
  type ArtifactRoutesDeps,
} from "../http/artifacts.js";
import { Router } from "../http/router.js";

// ---------------------------------------------------------------------------
// Fake pool infrastructure (mirrors report-pages.test.ts / registry-defs-pdp.test.ts)
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakePoolClient {
  private _queryIndex = 0;
  private _rowSets: unknown[][];

  constructor(rowSets: unknown[][]) {
    this._rowSets = rowSets;
  }

  async query(_sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    const rows = (this._rowSets[this._queryIndex] ?? []) as unknown[];
    this._queryIndex++;
    return { rows, rowCount: rows.length };
  }

  release(): void { /* no-op */ }
}

function makeFakePool(rowSets: unknown[][]): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient(rowSets) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Injectable authz deps stubs
// ---------------------------------------------------------------------------

/** Always grants promote authority. */
const allowDeps: ArtifactAuthzDeps = {
  checkTierPromoteGrant: async () => ({ ok: true }),
};

/** Always denies promote authority. */
const denyDeps: ArtifactAuthzDeps = {
  checkTierPromoteGrant: async () => ({ ok: false, reason: "no_tier_promote_authority" }),
};

// ---------------------------------------------------------------------------
// Fake artifact data
// ---------------------------------------------------------------------------

const ARTIFACT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

// promoteTier row-sets for a DRAFT artifact (happy path).
// Query sequence inside withTenantTx + promoteTier + makePgAuditWriter:
//   [0] BEGIN                                                 → []
//   [1] SET LOCAL choros.tenant_id                           → []
//   [2] SET LOCAL search_path TO choros                      → []
//   [3] SELECT tier FROM ... FOR UPDATE                      → [{ tier: 'draft' }]
//   [4] SET LOCAL choros.promoting = '1'                     → []
//   [5] UPDATE ... SET tier = 'published'                    → []
//   [6] audit: SELECT current_setting('choros.tenant_id')   → [{ tenant_id }]
//   [7] audit: INSERT audit_head ON CONFLICT DO NOTHING      → []
//   [8] audit: SELECT seq, row_hash, vocab_version FOR UPDATE→ [{ seq:0, row_hash, vocab_version:1 }]
//   [9] audit: INSERT audit_event                            → []
//  [10] audit: UPDATE audit_head                             → []
//  [11] COMMIT                                               → []
function draftArtifactRowSets(): unknown[][] {
  return [
    [],                                    // [0] BEGIN
    [],                                    // [1] SET LOCAL choros.tenant_id
    [],                                    // [2] SET LOCAL search_path
    [{ tier: "draft" }],                   // [3] SELECT tier FOR UPDATE
    [],                                    // [4] SET LOCAL choros.promoting
    [],                                    // [5] UPDATE tier
    [{ tenant_id: DEV_TENANT_ID }],        // [6] audit: SELECT current_setting
    [],                                    // [7] audit: INSERT audit_head
    [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }], // [8] audit: SELECT head FOR UPDATE
    [],                                    // [9] audit: INSERT audit_event
    [],                                    // [10] audit: UPDATE audit_head
    [],                                    // [11] COMMIT
  ];
}

// For a PUBLISHED artifact → decidePromote throws 409.
// Query sequence: BEGIN, SET LOCAL ×2, SELECT tier (published), ROLLBACK.
function publishedArtifactRowSets(): unknown[][] {
  return [
    [],                         // BEGIN
    [],                         // SET LOCAL choros.tenant_id
    [],                         // SET LOCAL search_path
    [{ tier: "published" }],    // SELECT tier FOR UPDATE → already published
    [],                         // ROLLBACK
  ];
}

// For DENY tests: gate fires BEFORE withTenantTx is entered.
// Pool is still needed (for extractActorWithType in KC mode), but in dev mode
// extractActorWithType doesn't use the pool either. Supply empty sets.
function emptyRowSets(): unknown[][] {
  return Array.from({ length: 20 }, () => []);
}

// For agent test: SELECT returns draft artifact row, then decidePromote fires 403.
// Query sequence: BEGIN, SET LOCAL ×2, SELECT tier (draft), ROLLBACK.
function agentPromoteRowSets(): unknown[][] {
  return [
    [],                      // BEGIN
    [],                      // SET LOCAL choros.tenant_id
    [],                      // SET LOCAL search_path
    [{ tier: "draft" }],     // SELECT tier FOR UPDATE → draft, but actor is agent
    [],                      // ROLLBACK (decidePromote throws before SET LOCAL promoting)
  ];
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const reqHeaders: Record<string, string> = { ...headers };
    if (buf) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = String(buf.length);
    }
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: "POST",
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test server builder
// ---------------------------------------------------------------------------

function buildServer(
  routeDeps: ArtifactRoutesDeps,
  rowSets: unknown[][],
): { server: http.Server; baseUrl: () => string } {
  resetPoolForTesting();
  const fakePool = makeFakePool(rowSets);
  const router = new Router();
  // Pass fakePool as _poolHint so the handler never calls getPool() (and never throws 503).
  registerArtifactRoutes(router, routeDeps, fakePool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    if (s.listening) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  }
  resetPoolForTesting();
});

async function startServer(
  routeDeps: ArtifactRoutesDeps,
  rowSets: unknown[][],
): Promise<string> {
  const { server, baseUrl } = buildServer(routeDeps, rowSets);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return baseUrl();
}

// ---------------------------------------------------------------------------
// AC-2 (CORE SECURITY FIX): promote WITHOUT grant → 403 NO_PROMOTE_GRANT
// This was previously allowed (fail-open). Now must be fail-closed.
// ---------------------------------------------------------------------------

describe("T-0513 AC-2: promote without grant → 403 NO_PROMOTE_GRANT (core security fix)", () => {
  it("human actor with denyDeps → 403 NO_PROMOTE_GRANT before promoteTier runs", async () => {
    const base = await startServer({ authzDeps: denyDeps }, emptyRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      {
        "x-dev-user": "e-orlov",
        "content-type": "application/json",
      },
      { artifact_table: "application" },
    );

    expect(result.status).toBe(403);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body?.error?.["code"]).toBe("NO_PROMOTE_GRANT");
  });

  it("deny deps: gate fires even without a request body (default artifact_table)", async () => {
    const base = await startServer({ authzDeps: denyDeps }, emptyRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      { "x-dev-user": "e-orlov" },
    );

    expect(result.status).toBe(403);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body?.error?.["code"]).toBe("NO_PROMOTE_GRANT");
  });
});

// ---------------------------------------------------------------------------
// AC-1: promote WITH grant → gate passes (promote succeeds or hits downstream error)
// With allowDeps, the gate does NOT throw 403; promoteTier runs against the fake pool.
// A draft artifact → 200 promoted.
// ---------------------------------------------------------------------------

describe("T-0513 AC-1: promote WITH grant → gate passes, promote succeeds", () => {
  it("human actor with allowDeps + draft artifact → 200 promoted", async () => {
    const base = await startServer({ authzDeps: allowDeps }, draftArtifactRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      {
        "x-dev-user": "e-orlov",
        "content-type": "application/json",
      },
      { artifact_table: "application" },
    );

    // Gate passed (not 403 NO_PROMOTE_GRANT) and promoteTier ran against fake pool.
    expect(result.status).not.toBe(403);
    expect(result.status).toBe(200);
    const body = result.json as Record<string, unknown>;
    expect(body["promoted"]).toBe(true);
    expect(body["tier"]).toBe("published");
  });
});

// ---------------------------------------------------------------------------
// AC-3: agent actor → 403 FORBIDDEN_AGENT_SELF_PROMOTE (pre-existing guard).
// a-recon is in ORG_SEED as type='agent' so findEmployee returns agent in no-DB mode.
// The agent check fires inside decidePromote (inside promoteTier), AFTER the authz gate.
// With allowDeps: gate passes, then decidePromote fires → 403 FORBIDDEN_AGENT_SELF_PROMOTE.
// ---------------------------------------------------------------------------

describe("T-0513 AC-3: agent actor → 403 FORBIDDEN_AGENT_SELF_PROMOTE", () => {
  it("a-recon (kind=agent in ORG_SEED) with allowDeps → 403 FORBIDDEN_AGENT_SELF_PROMOTE", async () => {
    const base = await startServer({ authzDeps: allowDeps }, agentPromoteRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      { "x-dev-user": "a-recon" },
    );

    expect(result.status).toBe(403);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body?.error?.["code"]).toBe("FORBIDDEN_AGENT_SELF_PROMOTE");
  });
});

// ---------------------------------------------------------------------------
// AC-4: promote already-published artifact → 409 NOT_IN_DRAFT (pre-existing guard).
// With allowDeps: gate passes, then decidePromote sees tier='published' → 409.
// ---------------------------------------------------------------------------

describe("T-0513 AC-4: already-published artifact → 409 NOT_IN_DRAFT", () => {
  it("human actor with allowDeps + published artifact → 409 NOT_IN_DRAFT", async () => {
    const base = await startServer({ authzDeps: allowDeps }, publishedArtifactRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      {
        "x-dev-user": "e-orlov",
        "content-type": "application/json",
      },
      { artifact_table: "application" },
    );

    expect(result.status).toBe(409);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body?.error?.["code"]).toBe("NOT_IN_DRAFT");
  });
});

// ---------------------------------------------------------------------------
// AC-5: deny gate fires BEFORE promoteTier (gate ordering proof).
// Even when fake pool row-sets would allow a successful promote, denyDeps → 403.
// ---------------------------------------------------------------------------

describe("T-0513 AC-5: deny gate fires before promoteTier (ordering proof)", () => {
  it("deny deps → 403 even when draft artifact rows are present", async () => {
    // Provide draft artifact row-sets that WOULD allow promote — but the gate fires first.
    const base = await startServer({ authzDeps: denyDeps }, draftArtifactRowSets());

    const result = await httpPost(
      `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
      {
        "x-dev-user": "e-orlov",
        "content-type": "application/json",
      },
      { artifact_table: "application" },
    );

    // Gate MUST fire and return 403, not 200.
    expect(result.status).toBe(403);
    const body = result.json as { error?: Record<string, unknown> };
    expect(body?.error?.["code"]).toBe("NO_PROMOTE_GRANT");
  });
});

// ---------------------------------------------------------------------------
// AC-6: deny deps blocks every actor (cross-tenant proxy / unauthorized actors).
// ---------------------------------------------------------------------------

describe("T-0513 AC-6: deny gate blocks all actors (unauthorized promote attempt)", () => {
  it("deny deps blocks e-owner, e-orlov, and other slugs", async () => {
    const actors = ["e-owner", "e-orlov", "e-mironov", "e-larina"];

    for (const actor of actors) {
      const base = await startServer({ authzDeps: denyDeps }, emptyRowSets());

      const result = await httpPost(
        `${base}/api/artifacts/${ARTIFACT_ID}/promote`,
        { "x-dev-user": actor },
      );

      expect(result.status, `actor ${actor} should be blocked`).toBe(403);
      const body = result.json as { error?: Record<string, unknown> };
      expect(body?.error?.["code"]).toBe("NO_PROMOTE_GRANT");
    }
  });
});
