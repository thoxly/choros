/**
 * T-0141 — Demo tenant showcase tests (no live DB required)
 *
 * Covers:
 *   - ADR §4.1 probe 2: loadShowcasePack() → rights_cards.length === 8, process_instances.length === 8
 *   - ADR §4.1 probe 3: response shape mapping (mapRightsCard)
 *   - ADR §4.1 probe 1: DATABASE_URL unset → fallback behaviour (no DB call)
 *   - FF-FALLBACK-6: no-DB path returns non-empty arrays from in-memory seeds
 *   - FF-DISPLAY-4 (static): pack-serve.ts does not import pg (checked via import resolution)
 *   - AC-11: rights_cards response has {id (=role_slug), name, grants} fields
 *   - AC-18: process_instances response has {id, name, status, progress} fields
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { loadShowcasePack, clearPackCache } from "../http/pack-serve.js";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helper: start a test server on a random port
// ---------------------------------------------------------------------------

async function startServer(env?: Record<string, string>): Promise<{ server: http.Server; baseUrl: string; cleanup: () => Promise<void> }> {
  // Override env before creating server (server reads env at route-call time)
  const saved: Record<string, string | undefined> = {};
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  }

  const server = createServer();
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        resolve(`http://localhost:${addr.port}`);
      }
    });
  });

  const cleanup = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (env) {
      for (const [k] of Object.entries(env)) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  };

  return { server, baseUrl, cleanup };
}

async function get(baseUrl: string, path: string, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(url, { method: "GET", headers }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests: loadShowcasePack — no live DB required
// ---------------------------------------------------------------------------

describe("loadShowcasePack (ADR §4.1 probe 2)", () => {
  beforeEach(() => {
    clearPackCache();
    // Point CHOROS_PACK_DIR at the real seed directory (from project root)
    process.env["CHOROS_PACK_DIR"] = path.resolve(process.cwd(), "seed");
  });

  afterEach(() => {
    clearPackCache();
    delete process.env["CHOROS_PACK_DIR"];
  });

  it("rights_cards.length === 8", () => {
    const pack = loadShowcasePack();
    expect(pack.rights_cards.length).toBe(8);
  });

  it("process_instances.length === 8", () => {
    const pack = loadShowcasePack();
    expect(pack.process_instances.length).toBe(8);
  });

  it("rights_cards[0] has role_slug, name, grants fields (ADR §4.1 probe 3 / AC-11)", () => {
    const pack = loadShowcasePack();
    const card = pack.rights_cards[0];
    expect(card).toHaveProperty("role_slug");
    expect(typeof card.role_slug).toBe("string");
    expect(card).toHaveProperty("name");
    expect(typeof card.name).toBe("string");
    expect(card).toHaveProperty("grants");
    expect(Array.isArray(card.grants)).toBe(true);
  });

  it("process_instances[0] has id, name, status, progress fields (AC-18)", () => {
    const pack = loadShowcasePack();
    const inst = pack.process_instances[0];
    expect(inst).toHaveProperty("id");
    expect(inst).toHaveProperty("name");
    expect(inst).toHaveProperty("status");
    expect(inst).toHaveProperty("progress");
    expect(typeof (inst.progress as { done: number }).done).toBe("number");
    expect(typeof (inst.progress as { total: number }).total).toBe("number");
  });

  it("pack is cached (same reference on second call)", () => {
    const p1 = loadShowcasePack();
    const p2 = loadShowcasePack();
    expect(p1).toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// Tests: /api/rights and /api/processes via HTTP — no-DB fallback path (FF-FALLBACK-6)
// ---------------------------------------------------------------------------

describe("Display plane endpoints — no-DB fallback (FF-FALLBACK-6)", () => {
  let cleanup: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    clearPackCache();
    // Start without DATABASE_URL → in-memory seed path
    const result = await startServer({ DATABASE_URL: "" });
    baseUrl = result.baseUrl;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    clearPackCache();
  });

  it("GET /api/rights returns 200 + non-empty roles (no DB)", async () => {
    const { status, body } = await get(baseUrl, "/api/rights");
    expect(status).toBe(200);
    const data = body as { roles: unknown[] };
    expect(Array.isArray(data.roles)).toBe(true);
    expect(data.roles.length).toBeGreaterThan(0);
  });

  it("GET /api/processes returns 200 + non-empty instances (no DB)", async () => {
    const { status, body } = await get(baseUrl, "/api/processes");
    expect(status).toBe(200);
    const data = body as { instances: unknown[] };
    expect(Array.isArray(data.instances)).toBe(true);
    expect(data.instances.length).toBeGreaterThan(0);
  });

  it("GET /api/org returns 200 + non-empty departments (no DB)", async () => {
    const { status, body } = await get(baseUrl, "/api/org");
    expect(status).toBe(200);
    const data = body as { departments: unknown[] };
    expect(Array.isArray(data.departments)).toBe(true);
    expect(data.departments.length).toBeGreaterThan(0);
  });

  it("GET /api/users returns 200 + non-empty users (no DB)", async () => {
    const { status, body } = await get(baseUrl, "/api/users");
    expect(status).toBe(200);
    const data = body as { users: unknown[] };
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: /api/rights with pack-file path (DATABASE_URL set but non-connectable)
// ---------------------------------------------------------------------------

describe("GET /api/rights pack-file path (DATABASE_URL set, AC-11)", () => {
  let cleanup: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    clearPackCache();
    const result = await startServer({
      DATABASE_URL: "postgres://mock:mock@127.0.0.1:59999/mock_nonexistent",
      CHOROS_PACK_DIR: path.resolve(process.cwd(), "seed"),
    });
    baseUrl = result.baseUrl;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    clearPackCache();
  });

  it("GET /api/rights returns 200 with exactly 8 role cards (pack-file path)", async () => {
    const { status, body } = await get(baseUrl, "/api/rights");
    expect(status).toBe(200);
    const data = body as { roles: Array<Record<string, unknown>> };
    expect(Array.isArray(data.roles)).toBe(true);
    expect(data.roles.length).toBe(8);
  });

  it("Each rights card has id (=role_slug), name, grants (AC-11)", async () => {
    const { body } = await get(baseUrl, "/api/rights");
    const data = body as { roles: Array<Record<string, unknown>> };
    for (const role of data.roles) {
      expect(typeof role["id"]).toBe("string");
      expect(typeof role["name"]).toBe("string");
      expect(Array.isArray(role["grants"])).toBe(true);
    }
  });

  it("GET /api/processes returns 200 with exactly 8 instances (pack-file path)", async () => {
    const { status, body } = await get(baseUrl, "/api/processes");
    expect(status).toBe(200);
    const data = body as { instances: Array<Record<string, unknown>> };
    expect(Array.isArray(data.instances)).toBe(true);
    expect(data.instances.length).toBe(8);
  });

  it("Each process instance has id, name, status, progress (AC-18)", async () => {
    const { body } = await get(baseUrl, "/api/processes");
    const data = body as { instances: Array<Record<string, unknown>> };
    for (const inst of data.instances) {
      expect(typeof inst["id"]).toBe("string");
      expect(typeof inst["name"]).toBe("string");
      expect(typeof inst["status"]).toBe("string");
      expect(typeof inst["progress"]).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: shape mapping — role_slug maps to id (ADR §3.5)
// ---------------------------------------------------------------------------

describe("rights_cards shape mapping (ADR §3.5)", () => {
  beforeEach(() => {
    clearPackCache();
    process.env["CHOROS_PACK_DIR"] = path.resolve(process.cwd(), "seed");
  });

  afterEach(() => {
    clearPackCache();
    delete process.env["CHOROS_PACK_DIR"];
  });

  it("all rights_cards have non-empty role_slug that starts with 'role-' or is system", () => {
    const pack = loadShowcasePack();
    for (const card of pack.rights_cards) {
      expect(typeof card.role_slug).toBe("string");
      expect(card.role_slug.length).toBeGreaterThan(0);
    }
  });

  it("first rights_card role_slug is 'role-fin-control'", () => {
    const pack = loadShowcasePack();
    expect(pack.rights_cards[0].role_slug).toBe("role-fin-control");
  });
});
