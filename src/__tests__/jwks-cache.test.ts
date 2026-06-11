/**
 * src/__tests__/jwks-cache.test.ts
 *
 * FF-9 (unit): in-memory JWKS cache — verifies that a warm cache does NOT
 * initiate a new HTTP request to Keycloak on the second verifyJwt call.
 *
 * Uses a test RSA key pair (generated once) + an in-process mock JWKS server.
 * No live Keycloak required.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { getJwks, _resetJwksCache } from "../http/auth.js";

// ---------------------------------------------------------------------------
// RSA key pair for testing
// ---------------------------------------------------------------------------

let publicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };

beforeAll(() => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const raw = publicKey.export({ format: "jwk" });
  publicJwk = { ...raw, kid: "cache-test-key", alg: "RS256", use: "sig" };
});

// ---------------------------------------------------------------------------
// Mock JWKS server
// ---------------------------------------------------------------------------

let mockServer: http.Server;
let mockPort = 0;
let discoveryFetchCount = 0;
let jwksFetchCount = 0;

beforeAll(async () => {
  mockServer = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    if (_req.url?.includes("openid-configuration")) {
      discoveryFetchCount++;
      res.end(JSON.stringify({
        issuer: `http://127.0.0.1:${mockPort}/realms/choros`,
        jwks_uri: `http://127.0.0.1:${mockPort}/certs`,
      }));
    } else if (_req.url?.includes("/certs")) {
      jwksFetchCount++;
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  _resetJwksCache();
});

beforeEach(() => {
  _resetJwksCache();
  discoveryFetchCount = 0;
  jwksFetchCount = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function makeCfg() {
  return {
    mode: "keycloak" as const,
    issuer: `http://127.0.0.1:${mockPort}/realms/choros`,
    keycloakUrl: `http://127.0.0.1:${mockPort}`,
    realm: "choros",
    audience: "choros-api",
    jwksUri: undefined,
    jwksCacheTtlMs: 300000,
  };
}

describe("FF-9 — JWKS in-memory cache", () => {
  it("first getJwks call fetches JWKS from server", async () => {
    const cfg = makeCfg();
    const keys = await getJwks(cfg);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.kid).toBe("cache-test-key");
    expect(jwksFetchCount).toBe(1);
  });

  it("second getJwks call (within TTL) does NOT fetch again", async () => {
    const cfg = makeCfg();
    // First call — primes cache
    await getJwks(cfg);
    const fetchesAfterFirst = jwksFetchCount;

    // Second call — should use cache (0 new network requests)
    await getJwks(cfg);
    expect(jwksFetchCount).toBe(fetchesAfterFirst); // no new fetches
  });

  it("forceRefresh=true bypasses cache and fetches again", async () => {
    const cfg = makeCfg();
    await getJwks(cfg); // prime cache
    const fetchesAfterFirst = jwksFetchCount;

    await getJwks(cfg, true); // force refresh
    expect(jwksFetchCount).toBeGreaterThan(fetchesAfterFirst);
  });

  it("cache respects TTL — expired cache re-fetches", async () => {
    const cfg = { ...makeCfg(), jwksCacheTtlMs: 0 }; // immediate expiry
    await getJwks(cfg); // prime cache (immediately expired)
    const countAfterFirst = jwksFetchCount;

    await getJwks(cfg); // TTL=0 → always expired → fetches again
    expect(jwksFetchCount).toBeGreaterThan(countAfterFirst);
  });

  it("_resetJwksCache clears the cache — next call fetches again", async () => {
    const cfg = makeCfg();
    await getJwks(cfg);
    const countAfterFirst = jwksFetchCount;

    _resetJwksCache();
    await getJwks(cfg);
    expect(jwksFetchCount).toBeGreaterThan(countAfterFirst);
  });

  it("AC-23: warm cache — second call adds 0 network requests (NF-3 ≤ 2ms overhead)", async () => {
    const cfg = makeCfg();
    // Warm the cache
    await getJwks(cfg);

    // Measure second call latency (should be sync from cache)
    const start = Date.now();
    await getJwks(cfg);
    const elapsed = Date.now() - start;

    // No network hop: elapsed should be well under 50ms (being conservative)
    expect(elapsed).toBeLessThan(50);
    // And no additional fetch happened:
    expect(jwksFetchCount).toBe(1); // only the initial fetch
  });
});
