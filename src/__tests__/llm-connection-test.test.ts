/**
 * src/__tests__/llm-connection-test.test.ts — T-0496
 *
 * Proves the "Проверить подключение" probe route (POST /api/llm-connections/:id/test):
 *
 *   (1) ok:true        — a working key → { ok:true, model, latency_ms, tokens }.
 *   (2) ok:false       — a bad key / provider error → { ok:false, error } (HTTP 200, NOT 500).
 *   (3) NON-EGRESS     — the raw key / raw provider-error body NEVER appears in the
 *                        response (assert the whole body contains no key sentinel).
 *   (4) 401            — unauthenticated (no x-dev-user) → 401.
 *   (5) 403            — authz is EXACTLY the edit gate (plain member rejected).
 *   (6) tenant-isolate — a connection id owned by another tenant is invisible → 404.
 *   (7) empty handle   — no key bound → { ok:false, error:"Ключ не задан" } (NOT 500).
 *
 * No real DB and no real network: a scripted in-memory pg.Pool replays the authz gate
 * + getLlmConnection, and the LlmPort is a stub injected via makeLlmPort. The stub
 * NEVER touches the secret — the route resolves nothing itself; the (real) port owns
 * the key. We assert the route's egress discipline, not the adapter's network code.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import {
  registerLlmConnectionTestRoute,
  sanitizeProviderError,
  type LlmPortFactory,
} from "../http/llm-connection-test.js";
import type { LlmPort } from "../core/llm-port.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const CONN_ID = "cccccccc-0000-0000-0000-000000000001";
const EMP_ID = "dddddddd-0000-0000-0000-000000000004";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";

// A raw key sentinel — it must NEVER appear in any response body. We thread it both
// through the connection's (opaque) handle position AND through a provider error that
// echoes it, to prove neither path egresses it.
const KEY_SENTINEL = "sk-SUPERSECRETKEY-do-not-leak-1234567890";

interface Principal {
  isOwner: boolean;
  grants: string[];
  /** When false, getLlmConnection returns no row (foreign-tenant / not found → 404). */
  connExists: boolean;
  /** secret_handle value the stored row carries (null → "Ключ не задан"). */
  secretHandle: string | null;
}

/** Scripted stub pg.Pool — replays the authz gate + getLlmConnection only. */
function makePool(p: Principal): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // isGenesisOwnerForTenant: tenant-owner role lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return p.isOwner
          ? { rows: [{ id: "ra-owner" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // getGrantsForSubject step 1: employee slug → id.
      if (text.includes("SELECT id FROM choros.employee") && text.includes("slug = $2")) {
        return { rows: [{ id: EMP_ID }], rowCount: 1 };
      }
      // getGrantsForSubject step 2: role_assignment → role_id.
      if (text.includes("SELECT ra.role_id") && text.includes("role_assignment")) {
        return { rows: [{ role_id: ROLE_ID }], rowCount: 1 };
      }
      // getGrantsForSubject step 3: grant rows for the role.
      if (text.includes('choros."grant"') && text.includes("role_id = ANY")) {
        const rows = p.grants.map((rt, i) => ({
          id: `g-${i}`,
          role_id: ROLE_ID,
          resource_type: rt,
          resource_facet: null,
          operation: rt === "llm_connection:configure" ? "configure" : "operate",
          scope: { kind: "set", members: [] },
          constraint: null,
          delegable: false,
          granted_by: "seed",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows, rowCount: rows.length };
      }
      // getLlmConnection SELECT → the stored row (or empty when foreign/not found).
      if (text.includes("FROM choros.llm_connection")) {
        if (!p.connExists) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: CONN_ID,
              tenant_id: TENANT_A,
              name: "DeepSeek",
              provider: "deepseek",
              endpoint: "https://api.deepseek.com/v1",
              model: "deepseek-chat",
              secret_handle: p.secretHandle,
              price_input_per_1k: null,
              price_output_per_1k: null,
              currency: "USD",
              is_default: false,
              created_by: null,
              created_at: "0",
              updated_at: "0",
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

/** Stub port that returns a working chat reply (with usage) — proves ok:true. */
const stubOkPort: LlmPort = {
  complete: () => Promise.reject(new Error("not used")),
  chat: async () => ({
    text: "pong",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }),
};

/**
 * Stub port that throws a provider error which ECHOES the raw key (some providers
 * reflect the Authorization header in 401 bodies). The route must sanitize it so the
 * sentinel never reaches the client.
 */
const stubLeakyErrorPort: LlmPort = {
  complete: () => Promise.reject(new Error("not used")),
  chat: () =>
    Promise.reject(
      new Error(
        `OpenAI API error 401: {"error":{"message":"Incorrect API key provided: ${KEY_SENTINEL}"}}`,
      ),
    ),
};

function startServer(
  pool: pg.Pool,
  makeLlmPort: LlmPortFactory,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerLlmConnectionTestRoute(router, {
    pool,
    resolveActorTenant: async () => TENANT_A,
    makeLlmPort,
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res2, rej) =>
            server.close((e: Error | undefined) => (e ? rej(e) : res2())),
          ),
      });
    });
  });
}

function request(
  port: number,
  path: string,
  opts: { devUser?: string | null } = {},
): Promise<{ status: number; raw: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.devUser !== null) headers["x-dev-user"] = opts.devUser ?? "e-someone";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          let body: unknown = data;
          try {
            body = data ? JSON.parse(data) : null;
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode ?? 0, raw: data, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const okPrincipal = (overrides: Partial<Principal> = {}): Principal => ({
  isOwner: true,
  grants: [],
  connExists: true,
  secretHandle: "app://11111111-1111-1111-1111-111111111111",
  ...overrides,
});

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// ---------------------------------------------------------------------------
// (1) ok:true — a working key.
// ---------------------------------------------------------------------------

describe("T-0496 (1) — a working connection probes ok:true", () => {
  it("POST .../test → 200 { ok:true, model, latency_ms, tokens }", async () => {
    const { port, close } = await startServer(makePool(okPrincipal()), () => stubOkPort);
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, model: "deepseek-chat" });
      const b = r.body as { latency_ms: number; tokens?: unknown };
      expect(typeof b.latency_ms).toBe("number");
      expect(b.tokens).toEqual({ prompt: 1, completion: 1, total: 2 });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) ok:false — a bad key / provider error is a RESULT, not a 500.
// ---------------------------------------------------------------------------

describe("T-0496 (2) — a bad key probes ok:false (HTTP 200, not 500)", () => {
  it("POST .../test → 200 { ok:false, error:<sanitized> }", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal()),
      () => stubLeakyErrorPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(200);
      expect((r.body as { ok: boolean }).ok).toBe(false);
      const err = (r.body as { error: string }).error;
      expect(typeof err).toBe("string");
      // 401 → "ключ отклонён" class message.
      expect(err).toMatch(/отклонил ключ|неверный/i);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) NON-EGRESS — the raw key never appears in the response body.
// ---------------------------------------------------------------------------

describe("T-0496 (3) — the raw key NEVER egresses (keystone RL-3)", () => {
  it("a provider error that echoes the key is sanitized — sentinel absent from body", async () => {
    const { port, close } = await startServer(
      // The stored handle ALSO carries the sentinel shape — prove neither path leaks.
      makePool(okPrincipal({ secretHandle: "app://22222222-2222-2222-2222-222222222222" })),
      () => stubLeakyErrorPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(200);
      // The ENTIRE raw response must not contain the key sentinel, nor "sk-", nor the
      // raw provider error body markers.
      expect(r.raw).not.toContain(KEY_SENTINEL);
      expect(r.raw).not.toContain("sk-");
      expect(r.raw).not.toContain("Incorrect API key provided");
      expect(r.raw).not.toContain("OpenAI API error");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) 401 — unauthenticated.
// ---------------------------------------------------------------------------

describe("T-0496 (4) — unauthenticated → 401", () => {
  it("no x-dev-user header → 401", async () => {
    const { port, close } = await startServer(makePool(okPrincipal()), () => stubOkPort);
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`, { devUser: null });
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) 403 — authz is EXACTLY the edit gate (plain member rejected).
// ---------------------------------------------------------------------------

describe("T-0496 (5) — a plain member CANNOT probe (same gate as edit)", () => {
  it("non-owner, no llm_connection:configure grant → 403", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal({ isOwner: false, grants: [] })),
      () => stubOkPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("LLM_CONNECTION_CONFIGURE_REQUIRED");
    } finally {
      await close();
    }
  });

  it("a member holding ONLY authoring_draft is STILL rejected → 403", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal({ isOwner: false, grants: ["authoring_draft"] })),
      () => stubOkPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(403);
    } finally {
      await close();
    }
  });

  it("a non-owner holding llm_connection:configure CAN probe → 200", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal({ isOwner: false, grants: ["llm_connection:configure"] })),
      () => stubOkPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(200);
      expect((r.body as { ok: boolean }).ok).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) tenant-isolation — a foreign / missing connection id → 404 (not probeable).
// ---------------------------------------------------------------------------

describe("T-0496 (6) — a foreign-tenant connection id cannot be probed", () => {
  it("connection not visible in the actor's tenant → 404", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal({ connExists: false })),
      () => stubOkPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("CONNECTION_NOT_FOUND");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (7) empty handle — no key bound → honest ok:false (NOT 500).
// ---------------------------------------------------------------------------

describe("T-0496 (7) — no key bound → ok:false 'Ключ не задан' (not 500)", () => {
  it("secret_handle null → 200 { ok:false, error:'Ключ не задан' }", async () => {
    const { port, close } = await startServer(
      makePool(okPrincipal({ secretHandle: null })),
      () => stubOkPort,
    );
    try {
      const r = await request(port, `/api/llm-connections/${CONN_ID}/test`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: false, error: "Ключ не задан" });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeProviderError — unit-level RL-3 coverage (never echoes raw text).
// ---------------------------------------------------------------------------

describe("T-0496 — sanitizeProviderError never echoes the raw error", () => {
  it("a 401 body echoing the key → key-free 'отклонил ключ' message", () => {
    const out = sanitizeProviderError(
      new Error(`OpenAI API error 401: {"message":"key ${KEY_SENTINEL}"}`),
    );
    expect(out).not.toContain(KEY_SENTINEL);
    expect(out).not.toContain("sk-");
    expect(out).toMatch(/отклонил ключ|неверный/i);
  });

  it("a timeout → key-free timeout message", () => {
    expect(sanitizeProviderError(new Error("timeout: OpenAI request exceeded 15000ms"))).toMatch(
      /время ожидания/i,
    );
  });

  it("a dormant port → 'порт не активен' message", () => {
    expect(sanitizeProviderError(new Error("llm runtime dormant"))).toMatch(/не активен/i);
  });

  it("an arbitrary error with a key fragment → generic fallback, no echo", () => {
    const out = sanitizeProviderError(new Error(`weird failure carrying ${KEY_SENTINEL}`));
    expect(out).not.toContain(KEY_SENTINEL);
    expect(out).toMatch(/не удалось проверить/i);
  });
});
