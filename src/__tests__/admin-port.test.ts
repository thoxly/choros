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
import {
  makeHttpKeycloakAdminPort,
  makeHttpKeycloakUserPort,
  splitDisplayName,
} from "../keycloak/admin-port.js";
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

// ---------------------------------------------------------------------------
// AP-8 [T-0741, follow-up on T-0734 §5]: createHumanUser derives KC
// firstName/lastName from an optional spec.displayName via splitDisplayName().
// LIVE_PROOF (docs/live-proof/T-0741-firstname-lastname.live-proof.md): a user
// created WITHOUT firstName/lastName cannot obtain ANY token via direct grant
// (400 invalid_grant "Account is not fully set up") against a real KC 25.0.6 —
// this pure function + the payload-capture test below are the regression lock
// for that fix.
// ---------------------------------------------------------------------------

describe("AP-8a — splitDisplayName (T-0741, pure)", () => {
  it("two tokens: first word -> firstName, second word -> lastName", () => {
    expect(splitDisplayName("Иван Петров")).toEqual({ firstName: "Иван", lastName: "Петров" });
  });

  it("matches this codebase's own seed convention (migrations/016_employee.sql e-petrov: 'И. Петров')", () => {
    expect(splitDisplayName("И. Петров")).toEqual({ firstName: "И.", lastName: "Петров" });
  });

  it("3+ tokens: first word -> firstName, REMAINDER (rejoined) -> lastName", () => {
    expect(splitDisplayName("Иван Петрович Петров")).toEqual({
      firstName: "Иван",
      lastName: "Петрович Петров",
    });
  });

  it("single token (no space) -> duplicated into BOTH fields (never leave lastName blank)", () => {
    expect(splitDisplayName("Мадонна")).toEqual({ firstName: "Мадонна", lastName: "Мадонна" });
  });

  it("Latin-script name passes through unchanged (no transliteration)", () => {
    expect(splitDisplayName("John Smith")).toEqual({ firstName: "John", lastName: "Smith" });
  });

  it("anti-case: irregular whitespace (leading/trailing/double spaces) normalizes cleanly", () => {
    expect(splitDisplayName("   Иван   Петров   ")).toEqual({ firstName: "Иван", lastName: "Петров" });
  });

  it("anti-case: empty/whitespace-only input -> both fields empty (defensive; upstream already rejects this)", () => {
    expect(splitDisplayName("")).toEqual({ firstName: "", lastName: "" });
    expect(splitDisplayName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

/**
 * Stub that answers the token endpoint, captures the /users POST body, then
 * answers 201 followed by a GET-lookup response carrying a fake userId — lets
 * us drive createHumanUser's SUCCESS path end-to-end and inspect the exact
 * JSON body sent to Keycloak (not just the port's return value).
 */
function startCreateCaptureStub(): Promise<{
  cfg: KcRegistrarConfig;
  createCalls: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const createCalls: Array<Record<string, unknown>> = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (path.includes("/protocol/openid-connect/token")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "stub-token" }));
      } else if (path.endsWith("/users") && req.method === "POST") {
        createCalls.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(201);
        res.end();
      } else if (path.includes("/users?username=") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: "stub-kc-user-id" }]));
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
        createCalls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("AP-8b — createHumanUser payload carries firstName/lastName from displayName (T-0741)", () => {
  it("displayName provided -> POST /users body carries firstName+lastName derived from it", async () => {
    const stub = await startCreateCaptureStub();
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      const result = await port.createHumanUser({
        username: "ivan.petrov",
        email: "ivan.petrov@example.com",
        password: "password12345",
        actorType: "human",
        displayName: "Иван Петров",
      });
      expect(result).toEqual({ userId: "stub-kc-user-id" });
      expect(stub.createCalls).toHaveLength(1);
      const body = stub.createCalls[0];
      expect(body["firstName"]).toBe("Иван");
      expect(body["lastName"]).toBe("Петров");
      // Unaffected fields — regression guard the new fields didn't clobber anything.
      expect(body["username"]).toBe("ivan.petrov");
      expect(body["email"]).toBe("ivan.petrov@example.com");
      expect((body["attributes"] as { actor_type: string[] }).actor_type).toEqual(["human"]);
    } finally {
      await stub.close();
    }
  });

  it("AC-3 regression guard: displayName ABSENT -> POST /users body carries NEITHER firstName NOR lastName (register.ts's exact call shape, byte-identical to pre-T-0741)", async () => {
    const stub = await startCreateCaptureStub();
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      await port.createHumanUser({
        username: "owner@example.com",
        email: "owner@example.com",
        password: "password12345",
        actorType: "human",
        // no displayName — mirrors src/core/register.ts's call site exactly
      });
      const body = stub.createCalls[0];
      expect("firstName" in body).toBe(false);
      expect("lastName" in body).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it("displayName is an empty/whitespace string -> treated as absent (no firstName/lastName sent)", async () => {
    const stub = await startCreateCaptureStub();
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      await port.createHumanUser({
        username: "someone",
        email: "someone@example.com",
        password: "password12345",
        actorType: "human",
        displayName: "   ",
      });
      const body = stub.createCalls[0];
      expect("firstName" in body).toBe(false);
      expect("lastName" in body).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it("single-token displayName -> firstName and lastName both carry the SAME value (never sent blank)", async () => {
    const stub = await startCreateCaptureStub();
    try {
      const port = makeHttpKeycloakUserPort(stub.cfg);
      await port.createHumanUser({
        username: "mono",
        email: "mono@example.com",
        password: "password12345",
        actorType: "human",
        displayName: "Мадонна",
      });
      const body = stub.createCalls[0];
      expect(body["firstName"]).toBe("Мадонна");
      expect(body["lastName"]).toBe("Мадонна");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-9 [T-0748, NF-1 from T-0741's own review]: createHumanUser's 400 branch
// disambiguates a Keycloak person-name-character rejection (firstName/
// lastName, triggered by T-0741's own new firstName/lastName payload) from a
// genuine bad `email` — instead of folding EVERY 400 into EMAIL_INVALID (the
// prior behavior, which told the owner "email must be a valid email address"
// for a display_name like "Bot #1" or "A&B"; the email was never the
// problem). Body shapes below are LIVE-CONFIRMED against a real KC 25.0.6
// (t-0633-keycloak-1, 2026-07-11) — see docs/tasks/T-0748.spec.md for the
// full transcript.
// ---------------------------------------------------------------------------

/**
 * Stub that answers the token endpoint with a valid token, then answers the
 * FIRST /users POST with HTTP 400 carrying `body400`. Drives createHumanUser's
 * 400 branch deterministically without a live KC.
 */
function startUser400Stub(body400: string): Promise<{
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
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(body400);
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

describe("AP-9 — createHumanUser 400 person-name-vs-email disambiguation (T-0748)", () => {
  it("KC 400 {field:'lastName', errorMessage:'error-person-name-invalid-character'} -> NAME_INVALID_CHARACTERS (live shape: displayName='Bot #1')", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "lastName", errorMessage: "error-person-name-invalid-character", params: ["lastName"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_INVALID_CHARACTERS");
    } finally {
      await stub.close();
    }
  });

  it("KC 400 {field:'firstName', errorMessage:'error-person-name-invalid-character'} -> NAME_INVALID_CHARACTERS (live shape: displayName='A&B')", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "firstName", errorMessage: "error-person-name-invalid-character", params: ["firstName"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_INVALID_CHARACTERS");
    } finally {
      await stub.close();
    }
  });

  it("KC 400 {errors:[...]} multi-field shape (email AND firstName both bad) -> NAME_INVALID_CHARACTERS (live shape, name problem still surfaces honestly)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({
        errors: [
          { field: "email", errorMessage: "error-invalid-email", params: ["email", "not-an-email"] },
          { field: "firstName", errorMessage: "error-person-name-invalid-character", params: ["firstName"] },
        ],
      }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_INVALID_CHARACTERS");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: KC 400 {field:'email', errorMessage:'error-invalid-email'} -> EMAIL_INVALID (unchanged, live shape)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "email", errorMessage: "error-invalid-email", params: ["email", "not-an-email"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: KC 400 with an unparseable/empty body -> EMAIL_INVALID (safe default, no regression)", async () => {
    const stub = await startUser400Stub("not-json");
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: KC 400 on an unrelated field (e.g. 'username') -> EMAIL_INVALID (safe default — only firstName/lastName person-name errors map to NAME_INVALID_CHARACTERS)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "username", errorMessage: "error-username-invalid-character", params: ["username"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AP-10 [T-0762, R-2 follow-up from T-0748's own review]: createHumanUser's
// 400 branch ALSO disambiguates a Keycloak person-name LENGTH-validator
// rejection (firstName/lastName exceeding the declarative `length:{max:255}`
// cap, realm-choros.json) from a genuine bad `email` — T-0748 fixed the
// CHARACTER-validator class but explicitly scoped this sibling class out
// (spec.md §7). Body shapes below are LIVE-CONFIRMED against a real KC
// 25.0.6 (t-0633-keycloak-1, :8180, 2026-07-13 — same container T-0748's own
// live probe used, choros-registrar client_credentials): a single field over
// the cap (ordinary two-word name where the first token alone is 300 chars)
// produces the single-object shape; BOTH fields over the cap in the SAME
// request (a single-TOKEN 300-char displayName, which splitDisplayName
// duplicates into both firstName AND lastName — see its own doc comment)
// produces the `{errors:[...]}` array shape. No orphan KC user was left by
// either live probe (verified via GET .../users?username=...=exact after
// each; a control 201 create with an ordinary two-word Cyrillic name was
// also probed live and cleaned up).
// ---------------------------------------------------------------------------

describe("AP-10 — createHumanUser 400 person-name-length-vs-email disambiguation (T-0762)", () => {
  it("KC 400 {field:'firstName', errorMessage:'error-invalid-length-too-long'} (single field over cap, live shape) -> NAME_TOO_LONG", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({
        field: "firstName",
        errorMessage: "error-invalid-length-too-long",
        params: ["firstName", null, 255],
      }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_TOO_LONG");
    } finally {
      await stub.close();
    }
  });

  it("KC 400 {field:'lastName', errorMessage:'error-invalid-length-too-long'} -> NAME_TOO_LONG", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({
        field: "lastName",
        errorMessage: "error-invalid-length-too-long",
        params: ["lastName", null, 255],
      }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_TOO_LONG");
    } finally {
      await stub.close();
    }
  });

  it("KC 400 {errors:[...]} BOTH firstName and lastName over cap (live shape: single-token 300-char displayName duplicated by splitDisplayName) -> NAME_TOO_LONG", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({
        errors: [
          { field: "lastName", errorMessage: "error-invalid-length-too-long", params: ["lastName", null, 255] },
          { field: "firstName", errorMessage: "error-invalid-length-too-long", params: ["firstName", null, 255] },
        ],
      }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_TOO_LONG");
    } finally {
      await stub.close();
    }
  });

  it("KC 400 {errors:[...]} mixed shape (email invalid AND firstName too long) -> NAME_TOO_LONG (name-length problem not masked by co-occurring email problem)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({
        errors: [
          { field: "email", errorMessage: "error-invalid-email", params: ["email", "not-an-email"] },
          { field: "firstName", errorMessage: "error-invalid-length-too-long", params: ["firstName", null, 255] },
        ],
      }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_TOO_LONG");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: a firstName/lastName CHARACTER error (T-0748's own class) still maps to NAME_INVALID_CHARACTERS, not NAME_TOO_LONG — the two length/character checks do not cross-fire", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "lastName", errorMessage: "error-person-name-invalid-character", params: ["lastName"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("NAME_INVALID_CHARACTERS");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: KC 400 {field:'email', errorMessage:'error-invalid-email'} -> unchanged EMAIL_INVALID (length check does not over-fire on email)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "email", errorMessage: "error-invalid-email", params: ["email", "not-an-email"] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: KC 400 with an unparseable/empty body -> unchanged EMAIL_INVALID (safe default, no regression)", async () => {
    const stub = await startUser400Stub("not-json");
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });

  it("REGRESSION: a length error on an unrelated field (e.g. 'username') -> EMAIL_INVALID (safe default — only firstName/lastName length errors map to NAME_TOO_LONG)", async () => {
    const stub = await startUser400Stub(
      JSON.stringify({ field: "username", errorMessage: "error-invalid-length-too-long", params: ["username", null, 255] }),
    );
    try {
      expect(await createExpectingCode(stub.cfg)).toBe("EMAIL_INVALID");
    } finally {
      await stub.close();
    }
  });
});
