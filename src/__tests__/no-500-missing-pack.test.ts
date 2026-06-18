/**
 * T-0259 — no-500 when showcase pack file is absent.
 *
 * Simulates the production container condition where DATABASE_URL is set but
 * the seed/showcase/pack.json file does NOT exist (never shipped in the image).
 * Acceptance criteria:
 *   AC-1: GET /api/processes returns 200 + { instances: [], demo: true }
 *   AC-2: GET /api/rights   returns 200 + { roles:     [], demo: true }
 *   AC-3: tenant isolation preserved — endpoints still return 200 for any user
 *   AC-4: tryLoadShowcasePack() returns null when file is absent
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { tryLoadShowcasePack, clearPackCache } from "../http/pack-serve.js";

// ---------------------------------------------------------------------------
// Helper: make a GET request against a running server.
// ---------------------------------------------------------------------------

function get(
  baseUrl: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(url, { method: "GET", headers }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
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
// Helper: start a test server with specific env vars, return baseUrl + cleanup.
// ---------------------------------------------------------------------------

async function startServer(
  env: Record<string, string>,
): Promise<{ baseUrl: string; cleanup: () => Promise<void> }> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
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
    for (const [k] of Object.entries(env)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  };

  return { baseUrl, cleanup };
}

// ---------------------------------------------------------------------------
// Unit: tryLoadShowcasePack returns null when path is missing
// ---------------------------------------------------------------------------

describe("tryLoadShowcasePack — missing file (T-0259 AC-4)", () => {
  beforeEach(() => {
    clearPackCache();
  });

  afterEach(() => {
    clearPackCache();
    delete process.env["CHOROS_PACK_DIR"];
  });

  it("returns null when CHOROS_PACK_DIR points at a non-existent directory", () => {
    process.env["CHOROS_PACK_DIR"] = "/tmp/choros-t0259-missing-dir-that-does-not-exist";
    const result = tryLoadShowcasePack();
    expect(result).toBeNull();
  });

  it("does NOT throw when the file is missing", () => {
    process.env["CHOROS_PACK_DIR"] = "/tmp/choros-t0259-missing-dir-that-does-not-exist";
    expect(() => tryLoadShowcasePack()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HTTP: GET /api/processes and GET /api/rights return 200 when pack is absent.
// DATABASE_URL is set (simulating production) but CHOROS_PACK_DIR points at a
// missing directory so the pack file cannot be loaded.
// ---------------------------------------------------------------------------

describe("GET /api/processes — no-500 when pack file absent (T-0259 AC-1)", () => {
  let cleanup: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    clearPackCache();
    // DATABASE_URL set (non-connectable mock) + CHOROS_PACK_DIR missing directory.
    // This is the exact production container condition that caused the 500.
    const result = await startServer({
      DATABASE_URL: "postgres://mock:mock@127.0.0.1:59999/mock_nonexistent",
      CHOROS_PACK_DIR: "/tmp/choros-t0259-missing-dir-that-does-not-exist",
    });
    baseUrl = result.baseUrl;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    clearPackCache();
  });

  it("returns HTTP 200 (not 500) when pack file is absent", async () => {
    const { status } = await get(baseUrl, "/api/processes");
    expect(status).toBe(200);
  });

  it("returns { instances: [], demo: true } when pack file is absent", async () => {
    const { body } = await get(baseUrl, "/api/processes");
    const data = body as Record<string, unknown>;
    expect(Array.isArray(data["instances"])).toBe(true);
    expect((data["instances"] as unknown[]).length).toBe(0);
    expect(data["demo"]).toBe(true);
  });

  it("Content-Type is application/json", async () => {
    const result = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const url = new URL(baseUrl + "/api/processes");
        const req = http.request(url, { method: "GET" }, (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
      }
    );
    expect(result.headers["content-type"]).toBe("application/json");
  });
});

describe("GET /api/rights — no-500 when pack file absent (T-0259 AC-2)", () => {
  let cleanup: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    clearPackCache();
    const result = await startServer({
      DATABASE_URL: "postgres://mock:mock@127.0.0.1:59999/mock_nonexistent",
      CHOROS_PACK_DIR: "/tmp/choros-t0259-missing-dir-that-does-not-exist",
    });
    baseUrl = result.baseUrl;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    clearPackCache();
  });

  it("returns HTTP 200 (not 500) when pack file is absent", async () => {
    const { status } = await get(baseUrl, "/api/rights");
    expect(status).toBe(200);
  });

  it("returns { roles: [], demo: true } when pack file is absent", async () => {
    const { body } = await get(baseUrl, "/api/rights");
    const data = body as Record<string, unknown>;
    expect(Array.isArray(data["roles"])).toBe(true);
    expect((data["roles"] as unknown[]).length).toBe(0);
    expect(data["demo"]).toBe(true);
  });

  it("GET /api/rights/:roleId returns 404 (not 500) when pack file is absent", async () => {
    const { status } = await get(baseUrl, "/api/rights/role-fin-control");
    // With no pack data, any role lookup returns 404 — not 500.
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: existing no-DB fallback path must still work (PROCESSES_SEED
// and RIGHTS_SEED are still returned when DATABASE_URL is unset).
// ---------------------------------------------------------------------------

describe("No-DB fallback still works (regression guard, T-0259 AC-3)", () => {
  let cleanup: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    clearPackCache();
    // DATABASE_URL deliberately absent → in-memory seeds path.
    const result = await startServer({ DATABASE_URL: "" });
    baseUrl = result.baseUrl;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    clearPackCache();
  });

  it("GET /api/processes returns non-empty instances from in-memory seed", async () => {
    const { status, body } = await get(baseUrl, "/api/processes");
    expect(status).toBe(200);
    const data = body as { instances: unknown[] };
    expect(data.instances.length).toBeGreaterThan(0);
    // demo flag must NOT be set on the in-memory seed path.
    expect((body as Record<string, unknown>)["demo"]).toBeUndefined();
  });

  it("GET /api/rights returns non-empty roles from in-memory seed", async () => {
    const { status, body } = await get(baseUrl, "/api/rights");
    expect(status).toBe(200);
    const data = body as { roles: unknown[] };
    expect(data.roles.length).toBeGreaterThan(0);
    expect((body as Record<string, unknown>)["demo"]).toBeUndefined();
  });
});
