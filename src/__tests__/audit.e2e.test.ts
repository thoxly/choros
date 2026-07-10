import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Audit API with real server.
//
// T-0500: GET /api/audit is now the REAL tenant-wide audit-log read (DB-backed).
// In memory mode (no DATABASE_URL) there is no audit store, so the route fails
// HONESTLY with 503 rather than serving the old fake "Счёт-агент" timeline.
// The demo instance-trace surface (GET /api/audit/:instanceId, .../export) is
// in-memory and UNCHANGED — those assertions live below.
// ---------------------------------------------------------------------------

describe("Audit API E2E", () => {
  let server: http.Server;
  let baseUrl: string;
  const hasDb = !!process.env["DATABASE_URL"];

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function makeRequest(
    method: string,
    path: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(
        url,
        { method, headers: { "x-dev-user": "e-owner" } },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode || 200, body });
          });
        },
      );
      req.on("error", (err: Error) => {
        reject(err);
      });
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // GET /api/audit — the REAL tenant-wide log.
  // -------------------------------------------------------------------------

  it.skipIf(hasDb)(
    "GET /api/audit without a DB → 503 (honest: no audit store, not a fake timeline)",
    async () => {
      const result = await makeRequest("GET", "/api/audit");
      expect(result.statusCode).toBe(503);
      const data = JSON.parse(result.body) as { error?: { code?: string } };
      expect(data.error?.code).toBe("AUDIT_UNAVAILABLE");
    },
  );

  it.skipIf(!hasDb)(
    "GET /api/audit with a DB → 200 { events, nextCursor } OR a fail-closed auth status",
    async () => {
      const result = await makeRequest("GET", "/api/audit");
      // With an ambient DB the seed owner reads the (possibly empty) event list;
      // an unresolvable identity fails closed (401/403). Never the old shape.
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body) as Record<string, unknown>;
        expect(Array.isArray(data["events"])).toBe(true);
        expect(data).not.toHaveProperty("trace");
        expect(data).not.toHaveProperty("instance");
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/audit/:instanceId — the demo instance-trace surface. T-0737:
  // this route now requires the SAME owner-only gate as GET /api/audit
  // (previously it had NO gate at all — not even an x-dev-user presence
  // check — so any request, authenticated or not in dev mode, got the demo
  // trace). Without a DB the gate itself is unavailable → 503, mirroring
  // GET /api/audit's existing "no store, fail honest" behaviour. Exact-shape
  // coverage for an AUTHORIZED reader, plus the 401/403 wiring regression
  // this fix introduces, live in the deterministic stub-pool suite
  // (audit-export-instance-authz.test.ts) — this e2e file only proves the
  // envelope against a real server in both DB states.
  // -------------------------------------------------------------------------

  it.skipIf(hasDb)(
    "GET /api/audit/INS-7731 without a DB → 503 (gate needs a DB read; T-0737)",
    async () => {
      const result = await makeRequest("GET", "/api/audit/INS-7731");
      expect(result.statusCode).toBe(503);
      const data = JSON.parse(result.body) as { error?: { code?: string } };
      expect(data.error?.code).toBe("AUDIT_UNAVAILABLE");
    },
  );

  it.skipIf(!hasDb)(
    "GET /api/audit/INS-7731 with a DB → 200 with the demo trace OR a fail-closed auth status",
    async () => {
      const result = await makeRequest("GET", "/api/audit/INS-7731");
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body) as Record<string, unknown>;
        const instance = data.instance as Record<string, unknown>;
        expect(instance.id).toBe("INS-7731");
        expect(Array.isArray(data.trace)).toBe(true);
      }
    },
  );

  it.skipIf(hasDb)(
    "GET /api/audit/NOPE without a DB → 503 (gate short-circuits before the 404 lookup)",
    async () => {
      const result = await makeRequest("GET", "/api/audit/NOPE");
      expect(result.statusCode).toBe(503);
    },
  );

  it.skipIf(!hasDb)(
    "GET /api/audit/NOPE with a DB → 404 for an authorized reader OR a fail-closed auth status",
    async () => {
      const result = await makeRequest("GET", "/api/audit/NOPE");
      expect([404, 401, 403]).toContain(result.statusCode);
    },
  );
});
