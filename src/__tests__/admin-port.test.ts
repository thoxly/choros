/**
 * src/__tests__/admin-port.test.ts — T-0470
 *
 * Unit tests for the live Keycloak admin-port adapter (src/keycloak/admin-port.ts).
 *
 * These tests are PURE — no live Keycloak required.  They verify:
 *   AP-1  resolveConfig() reads KC_REGISTRAR_CLIENT_ID / KC_REGISTRAR_CLIENT_SECRET
 *          (i.e. the fix in T-0470: uses the confidential registrar client, NOT admin-cli).
 *   AP-2  resolveConfig() falls back to "choros-registrar" / "" when env vars are absent.
 *   AP-3  getAdminToken sends a client_credentials grant (NOT password / NOT direct grant).
 *   AP-4  makeHttpKeycloakAdminPort accepts an explicit KcAdminConfig override.
 *   AP-5  makeHttpKeycloakAdminPort instantiates without arguments (structural).
 *
 * Strategy: each test starts a local HTTP stub server.  The stub captures requests
 * in order; we assert on the FIRST request (the token acquisition call).
 *
 * Server-gated (live KC required, NOT tested here):
 *   - POST /admin/realms/<realm>/clients — hire e2e on the dev stack.
 *   - DELETE /admin/realms/<realm>/clients/<id> — orphan cleanup on dev.
 *   Covered by the deploy-acceptance gate (T-0511 / T-0470 hire e2e).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeHttpKeycloakAdminPort, makeHttpKeycloakUserPort } from "../keycloak/admin-port.js";
import type { KcAdminConfig, KcRegistrarConfig } from "../keycloak/admin-port.js";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured data for one HTTP request received by the stub. */
interface CapturedRequest {
  path: string;
  body: string;
}

/**
 * Start a local stub server that records every inbound request in `calls`.
 * Responds to the first call with a valid token JSON; all subsequent calls
 * with 500 (so getAdminToken succeeds but further KC API calls fail cleanly).
 */
function startStubServer(): Promise<{
  url: string;
  calls: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const calls: CapturedRequest[] = [];

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? "";
      readBody(req)
        .then((body) => {
          calls.push({ path, body });
          if (calls.length === 1) {
            // First call is the token endpoint — return a valid token.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "stub-access-token" }));
          } else {
            // Subsequent calls (client create/get) — respond 500 to abort early.
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("stub: not token endpoint");
          }
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    },
  );

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Env-var save/restore helpers (shared across describe blocks)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "KC_REGISTRAR_CLIENT_ID",
  "KC_REGISTRAR_CLIENT_SECRET",
  "KEYCLOAK_BASE_URL",
  "KEYCLOAK_REALM",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) {
      process.env[k] = savedEnv[k];
    } else {
      delete process.env[k];
    }
  }
}

// ---------------------------------------------------------------------------
// AP-1: resolveConfig reads KC_REGISTRAR_CLIENT_ID / KC_REGISTRAR_CLIENT_SECRET
// ---------------------------------------------------------------------------

describe("AP-1 — resolveConfig reads registrar env vars (T-0470 fix)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("token request uses KC_REGISTRAR_CLIENT_ID and KC_REGISTRAR_CLIENT_SECRET", async () => {
    const stub = await startStubServer();
    try {
      process.env["KEYCLOAK_BASE_URL"] = stub.url;
      process.env["KEYCLOAK_REALM"] = "test-realm";
      process.env["KC_REGISTRAR_CLIENT_ID"] = "my-registrar-client";
      process.env["KC_REGISTRAR_CLIENT_SECRET"] = "my-registrar-secret";

      const port = makeHttpKeycloakAdminPort(); // uses resolveConfig()
      try {
        await port.createServiceAccountClient({
          clientId: "agent-test-ap1",
          serviceAccountsEnabled: true,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          actorType: "agent",
        });
      } catch {
        // Ignore: stub returns 500 for non-token calls.
      }

      // At least one request must have been captured.
      expect(stub.calls.length).toBeGreaterThan(0);
      const tokenCall = stub.calls[0]; // first call is always the token request

      // AP-1: token endpoint URL
      expect(tokenCall.path).toContain("/realms/test-realm/protocol/openid-connect/token");

      const params = new URLSearchParams(tokenCall.body);

      // AP-1: uses the correct client_id from env
      expect(params.get("client_id")).toBe("my-registrar-client");
      expect(params.get("client_id")).not.toBe("admin-cli"); // was the broken default

      // AP-1: uses the correct client_secret from env
      expect(params.get("client_secret")).toBe("my-registrar-secret");
      expect(params.get("client_secret")).not.toBe("admin"); // was the broken default

      // AP-3 (verified here too): grant_type is client_credentials, NOT password
      expect(params.get("grant_type")).toBe("client_credentials");
      expect(params.has("password")).toBe(false);
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-2: resolveConfig falls back to "choros-registrar" when env vars are absent
// ---------------------------------------------------------------------------

describe("AP-2 — resolveConfig default client_id is choros-registrar (NOT admin-cli)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("falls back to 'choros-registrar' when KC_REGISTRAR_CLIENT_ID is unset", async () => {
    const stub = await startStubServer();
    try {
      process.env["KEYCLOAK_BASE_URL"] = stub.url;
      process.env["KEYCLOAK_REALM"] = "choros";
      delete process.env["KC_REGISTRAR_CLIENT_ID"];
      delete process.env["KC_REGISTRAR_CLIENT_SECRET"];

      const port = makeHttpKeycloakAdminPort();
      try {
        await port.createServiceAccountClient({
          clientId: "agent-fallback-test",
          serviceAccountsEnabled: true,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          actorType: "agent",
        });
      } catch {
        // Ignore non-token errors.
      }

      expect(stub.calls.length).toBeGreaterThan(0);
      const params = new URLSearchParams(stub.calls[0].body);

      // AP-2: default must be "choros-registrar", NOT "admin-cli"
      expect(params.get("client_id")).toBe("choros-registrar");
      expect(params.get("client_id")).not.toBe("admin-cli");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-3: getAdminToken sends client_credentials grant (standalone)
// ---------------------------------------------------------------------------

describe("AP-3 — token request uses client_credentials grant (not password grant)", () => {
  it("grant_type=client_credentials; no username or password fields in body", async () => {
    const stub = await startStubServer();
    try {
      const cfg: KcAdminConfig = {
        baseUrl: stub.url,
        realm: "choros",
        adminClient: "choros-registrar",
        adminSecret: "test-secret",
      };
      const port = makeHttpKeycloakAdminPort(cfg);
      try {
        await port.createServiceAccountClient({
          clientId: "agent-grant-type-test",
          serviceAccountsEnabled: true,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          actorType: "agent",
        });
      } catch {
        // Ignore non-token errors.
      }

      expect(stub.calls.length).toBeGreaterThan(0);
      const params = new URLSearchParams(stub.calls[0].body);

      expect(params.get("grant_type")).toBe("client_credentials");
      expect(params.has("username")).toBe(false);
      expect(params.has("password")).toBe(false);
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-4: explicit KcAdminConfig override is respected (env vars are ignored)
// ---------------------------------------------------------------------------

describe("AP-4 — explicit KcAdminConfig override bypasses env vars", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("uses provided adminClient/adminSecret regardless of env vars", async () => {
    const stub = await startStubServer();
    try {
      // Set env vars to values that differ from the explicit config.
      process.env["KC_REGISTRAR_CLIENT_ID"] = "env-registrar";
      process.env["KC_REGISTRAR_CLIENT_SECRET"] = "env-secret";

      const explicit: KcAdminConfig = {
        baseUrl: stub.url,
        realm: "choros",
        adminClient: "explicit-client",
        adminSecret: "explicit-secret",
      };
      const port = makeHttpKeycloakAdminPort(explicit);
      try {
        await port.createServiceAccountClient({
          clientId: "agent-explicit-test",
          serviceAccountsEnabled: true,
          standardFlowEnabled: false,
          directAccessGrantsEnabled: false,
          actorType: "agent",
        });
      } catch {
        // Ignore non-token errors.
      }

      expect(stub.calls.length).toBeGreaterThan(0);
      const params = new URLSearchParams(stub.calls[0].body);

      expect(params.get("client_id")).toBe("explicit-client");
      expect(params.get("client_secret")).toBe("explicit-secret");
      // Must NOT have used the env values.
      expect(params.get("client_id")).not.toBe("env-registrar");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-5: factory instantiates without arguments (structural — no crash)
// ---------------------------------------------------------------------------

describe("AP-5 — makeHttpKeycloakAdminPort structural", () => {
  it("does not throw when called with no arguments", () => {
    expect(() => makeHttpKeycloakAdminPort()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AP-6 [T-0633 round-3]: createHumanUser disambiguates a KC 409 by its body —
// a USERNAME conflict → LOGIN_TAKEN; an EMAIL conflict (or unparseable body) →
// EMAIL_TAKEN (prior default, never a regression).
// ---------------------------------------------------------------------------

/**
 * Stub that answers the token endpoint with a valid token, then answers the
 * FIRST /users POST with a 409 carrying `conflictBody`. Lets us drive
 * createHumanUser's 409 branch deterministically without a live KC.
 */
function startUserConflictStub(conflictBody: string): Promise<{
  cfg: KcRegistrarConfig;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (path.includes("/protocol/openid-connect/token")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "stub-token" }));
      } else if (path.includes("/users") && req.method === "POST") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(conflictBody);
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    req.on("error", () => { res.writeHead(500); res.end(); });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        cfg: {
          baseUrl: `http://127.0.0.1:${port}`,
          realm: "choros",
          clientId: "choros-registrar",
          clientSecret: "stub-secret",
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function createExpectingCode(cfg: KcRegistrarConfig): Promise<string | undefined> {
  const port = makeHttpKeycloakUserPort(cfg);
  try {
    await port.createHumanUser({
      username: "someone",
      email: "someone@example.com",
      password: "password12345",
      actorType: "human",
    });
    return undefined; // should not reach here
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
}

describe("AP-6 — createHumanUser 409 username-vs-email disambiguation (T-0633)", () => {
  it("409 'User exists with same username' → LOGIN_TAKEN", async () => {
    const stub = await startUserConflictStub(
      JSON.stringify({ errorMessage: "User exists with same username" }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("LOGIN_TAKEN");
    } finally {
      await stub.close();
    }
  });

  it("409 'User exists with same email' → EMAIL_TAKEN", async () => {
    const stub = await startUserConflictStub(
      JSON.stringify({ errorMessage: "User exists with same email" }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_TAKEN");
    } finally {
      await stub.close();
    }
  });

  it("409 with an unparseable/empty body → EMAIL_TAKEN (safe default, no regression)", async () => {
    const stub = await startUserConflictStub("not-json");
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_TAKEN");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-7 [T-0702, ADR-T0702 §5 FF-702-PORT-UNIT]: revokeUserSessions posts to
// POST /admin/realms/<realm>/users/<id>/logout with the registrar bearer
// token, and NEVER throws — a non-2xx or unreachable stub degrades to
// {revoked:false} instead of propagating an error.
// ---------------------------------------------------------------------------

/**
 * Stub that answers the token endpoint with a valid token, then answers the
 * logout POST with `logoutStatus`. Captures the logout request's path/method
 * so we can assert the exact endpoint shape without a live KC.
 */
function startLogoutStub(logoutStatus: number): Promise<{
  cfg: KcRegistrarConfig;
  logoutCalls: Array<{ path: string; method: string; authHeader: string | undefined }>;
  close: () => Promise<void>;
}> {
  const logoutCalls: Array<{ path: string; method: string; authHeader: string | undefined }> = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (path.includes("/protocol/openid-connect/token")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "stub-token" }));
      } else if (path.includes("/logout") && req.method === "POST") {
        logoutCalls.push({ path, method: req.method ?? "", authHeader: req.headers.authorization });
        res.writeHead(logoutStatus);
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    req.on("error", () => { res.writeHead(500); res.end(); });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        cfg: {
          baseUrl: `http://127.0.0.1:${port}`,
          realm: "choros",
          clientId: "choros-registrar",
          clientSecret: "stub-secret",
        },
        logoutCalls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("AP-7 — revokeUserSessions (T-0702)", () => {
  it("204 from KC → {revoked:true}; posts to /admin/realms/<realm>/users/<id>/logout with a bearer token", async () => {
    const stub = await startLogoutStub(204);
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      const result = await port.revokeUserSessions("some-kc-user-id");
      expect(result).toEqual({ revoked: true });
      expect(stub.logoutCalls).toHaveLength(1);
      expect(stub.logoutCalls[0].method).toBe("POST");
      expect(stub.logoutCalls[0].path).toBe(
        "/admin/realms/choros/users/some-kc-user-id/logout",
      );
      expect(stub.logoutCalls[0].authHeader).toBe("Bearer stub-token");
    } finally {
      await stub.close();
    }
  });

  it("200 from KC → {revoked:true} (some deployments may answer 200 instead of 204)", async () => {
    const stub = await startLogoutStub(200);
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      expect(await port.revokeUserSessions("user-x")).toEqual({ revoked: true });
    } finally {
      await stub.close();
    }
  });

  it("404 (unknown user) → {revoked:false}, does NOT throw", async () => {
    const stub = await startLogoutStub(404);
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      await expect(port.revokeUserSessions("unknown-user")).resolves.toEqual({ revoked: false });
    } finally {
      await stub.close();
    }
  });

  it("500 from KC → {revoked:false}, does NOT throw", async () => {
    const stub = await startLogoutStub(500);
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      await expect(port.revokeUserSessions("user-y")).resolves.toEqual({ revoked: false });
    } finally {
      await stub.close();
    }
  });

  it("KC completely unreachable (connection refused) → {revoked:false}, does NOT throw", async () => {
    const cfg: KcRegistrarConfig = {
      baseUrl: "http://127.0.0.1:1", // nothing listens on port 1 — ECONNREFUSED
      realm: "choros",
      clientId: "choros-registrar",
      clientSecret: "stub-secret",
    };
    const port = makeHttpKeycloakUserPort(cfg);
    await expect(port.revokeUserSessions("user-z")).resolves.toEqual({ revoked: false });
  });
});
