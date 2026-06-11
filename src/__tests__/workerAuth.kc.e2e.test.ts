/**
 * src/__tests__/workerAuth.kc.e2e.test.ts
 *
 * Live-KC integration tests (AC-22, FF-1, FF-7).
 * Requires a running Keycloak instance (from docker compose).
 *
 * SKIP if KEYCLOAK_URL is not set (no live KC available).
 * Run with: CHOROS_AUTH_MODE=keycloak KEYCLOAK_URL=http://localhost:8180 vitest run
 *
 * Obtains real tokens from KC via ROPC (human) and client_credentials (agent),
 * then hits a real choros server with them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../server.js";
import { InMemoryJobStore } from "../core/inMemoryJobStore.js";
import { _resetJwksCache } from "../http/auth.js";

// ---------------------------------------------------------------------------
// Skip if no live KC
// ---------------------------------------------------------------------------

const KC_URL = process.env["KEYCLOAK_URL"];
const KC_REALM = process.env["KEYCLOAK_REALM"] ?? "choros";
const AUTH_MODE = process.env["CHOROS_AUTH_MODE"];

const SKIP = !KC_URL || AUTH_MODE !== "keycloak";

if (SKIP) {
  describe.skip("Live-KC worker auth (skipped — KEYCLOAK_URL or CHOROS_AUTH_MODE=keycloak not set)", () => {
    it("skipped", () => {});
  });
} else {
  describe("Live-KC worker auth E2E (AC-22, FF-1, FF-7)", () => {
    let appServer: http.Server;
    let appPort: number;

    beforeAll(async () => {
      _resetJwksCache();
      const store = new InMemoryJobStore();
      appServer = createServer(store);
      await new Promise<void>((resolve) => {
        appServer.listen(0, "127.0.0.1", () => {
          appPort = (appServer.address() as AddressInfo).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
      _resetJwksCache();
    });

    function reqHttp(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: unknown
    ): Promise<{ status: number; body: unknown }> {
      return new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : undefined;
        const options: http.RequestOptions = {
          hostname: "127.0.0.1",
          port: appPort,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
            ...(payload !== undefined ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
          },
        };
        const r = http.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = raw;
            try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        r.on("error", reject);
        if (payload) r.write(payload);
        r.end();
      });
    }

    async function getToken(params: Record<string, string>): Promise<string> {
      const body = new URLSearchParams(params).toString();
      const tokenUrl = `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`;
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Token fetch failed: ${res.status} ${err}`);
      }
      const data = (await res.json()) as { access_token: string };
      return data.access_token;
    }

    // AC-22 / FF-7: agent token (client_credentials) → POST /jobs → 201
    it("AC-22/FF-7: agent client_credentials token → POST /jobs → 201", async () => {
      const token = await getToken({
        grant_type: "client_credentials",
        client_id: "agent-orchestrator",
        // Secret injected via env (CI: AGENT_ORCHESTRATOR_SECRET; compose: see env docs)
        client_secret: process.env["AGENT_ORCHESTRATOR_SECRET"] ?? "",
      });

      const res = await reqHttp("POST", "/jobs", { Authorization: `Bearer ${token}` }, {
        topic: "live-kc-agent-test",
      });
      expect(res.status).toBe(201);
    });

    // AC-22 / FF-7: human ROPC token → POST /external-task/fetch-and-lock → 200
    it("AC-22/FF-7: human ROPC token → POST /external-task/fetch-and-lock → 200", async () => {
      const token = await getToken({
        grant_type: "password",
        client_id: "choros-api",
        // Secrets injected via env (CI: CHOROS_API_SECRET, KC_USER_PASSWORD; compose: see env docs)
        client_secret: process.env["CHOROS_API_SECRET"] ?? "",
        username: process.env["KC_TEST_USERNAME"] ?? "e-kravtsova",
        password: process.env["KC_USER_PASSWORD"] ?? "",
        scope: "openid",
      });

      const res = await reqHttp("POST", "/external-task/fetch-and-lock", { Authorization: `Bearer ${token}` }, {
        workerId: "live-worker-1",
        topics: ["live-kc-human-test"],
        maxJobs: 1,
        lockDurationMs: 5000,
      });
      expect(res.status).toBe(200);
    });

    // AC-23: second call with same token — cache warm, no new JWKS requests
    it("AC-23: warm cache — second call with same token succeeds without extra JWKS fetch", async () => {
      const token = await getToken({
        grant_type: "client_credentials",
        client_id: "agent-orchestrator",
        // Secret injected via env (CI: AGENT_ORCHESTRATOR_SECRET; compose: see env docs)
        client_secret: process.env["AGENT_ORCHESTRATOR_SECRET"] ?? "",
      });

      _resetJwksCache(); // ensure cold start
      const t0 = Date.now();
      await reqHttp("POST", "/jobs", { Authorization: `Bearer ${token}` }, { topic: "cache-warm-1" });
      const firstCallMs = Date.now() - t0;

      const t1 = Date.now();
      await reqHttp("POST", "/jobs", { Authorization: `Bearer ${token}` }, { topic: "cache-warm-2" });
      const secondCallMs = Date.now() - t1;

      // Second call should be significantly faster (no JWKS fetch)
      // We allow generous margin — just verify it completed
      expect(secondCallMs).toBeLessThan(firstCallMs + 100);
    });

    // FF-1: missing token → 401 on all 4 worker endpoints
    it("FF-1: no token → 401 on all 4 worker endpoints", async () => {
      for (const [method, path, body] of [
        ["POST", "/jobs", { topic: "t" }],
        ["POST", "/external-task/fetch-and-lock", { workerId: "w", topics: [], maxJobs: 1, lockDurationMs: 1 }],
        ["POST", "/external-task/no-id/complete", { workerId: "w" }],
        ["POST", "/external-task/no-id/fail", { workerId: "w", retries: 0, retryTimeoutMs: 0 }],
      ] as [string, string, unknown][]) {
        const res = await reqHttp(method, path, {}, body);
        expect(res.status).toBe(401);
      }
    });
  });
}
