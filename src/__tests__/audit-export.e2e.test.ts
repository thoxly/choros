/**
 * T-0138: E2E tests for GET /api/audit/export (write-path «Экспорт лога»).
 *
 * T-0737 (security P1): this route now requires the SAME owner-only
 * requireAuditRead() gate as GET /api/audit (loadAdminContext, T-0500
 * policy) — previously it only checked that an x-dev-user header was
 * PRESENT, not who it named. The gate needs a DB read, so with no pool
 * wired (memory mode) it fails 503 rather than silently allowing the
 * request through. Exact-shape coverage for an AUTHORIZED reader, the
 * non-owner 403, and the pool-absent 503 all live in the deterministic
 * stub-pool suite (audit-export-instance-authz.test.ts); this e2e file
 * keeps a real-server envelope check in both DB states.
 *
 * Covers (envelope, DB-state-aware):
 *   AC-1: 401 when x-dev-user header is absent (requires a DB — the gate
 *         itself needs one to resolve the actor's admin context; without a
 *         DB the route 503s before auth is even evaluated, same as
 *         GET /api/audit)
 *   AC-2..AC-6: same envelope pattern as audit.e2e.test.ts's GET /api/audit
 *         and GET /api/audit/:instanceId sections — 503 without a DB, a
 *         fail-closed envelope with one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import type { AuditData } from "../http/audit.js";

describe("Audit export E2E (T-0138 / T-0737)", () => {
  let server: http.Server;
  let baseUrl: string;
  const hasDb = !!process.env["DATABASE_URL"];

  beforeAll(async () => {
    server = createServer(undefined, undefined, "memory");
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

  function request(
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body: buf, headers: res.headers }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  // AC-1: without a DB, the gate itself is unavailable → 503, regardless of
  // the auth header. With a DB, a genuinely missing header still 401s (the
  // gate's extractActor step runs first).
  it.skipIf(hasDb)("without a DB → 503 AUDIT_UNAVAILABLE (gate needs a DB read)", async () => {
    const result = await request("GET", "/api/audit/export");
    expect(result.statusCode).toBe(503);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("AUDIT_UNAVAILABLE");
  });

  it.skipIf(!hasDb)("with a DB, no x-dev-user → 401 UNAUTHENTICATED", async () => {
    const result = await request("GET", "/api/audit/export");
    expect(result.statusCode).toBe(401);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("UNAUTHENTICATED");
  });

  // AC-2/AC-3: with a DB and an actor header, either the caller is authorized
  // (200, attachment, valid AuditData) or the gate fail-closes (401/403) —
  // this test doesn't assume "e-sokolov" is a genesis owner in whatever
  // ambient DB the suite runs against.
  it.skipIf(!hasDb)(
    "with a DB → 200 with attachment Content-Disposition + valid AuditData, OR a fail-closed status",
    async () => {
      const result = await request("GET", "/api/audit/export", { "x-dev-user": "e-sokolov" });
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        expect(result.headers["content-type"]).toContain("application/json");
        const disposition = result.headers["content-disposition"] ?? "";
        expect(disposition).toContain("attachment");
        expect(disposition).toContain("filename=");
        const data = JSON.parse(result.body) as AuditData;
        expect(data).toHaveProperty("instance");
        expect(data).toHaveProperty("trace");
        expect(typeof data.instance.id).toBe("string");
        expect(Array.isArray(data.trace)).toBe(true);
      }
    },
  );

  it.skipIf(!hasDb)(
    "with a DB, ?instance= param → named instance on 200, OR a fail-closed status",
    async () => {
      const result = await request("GET", "/api/audit/export?instance=INS-7731", {
        "x-dev-user": "e-sokolov",
      });
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body) as AuditData;
        expect(data.instance.id).toBe("INS-7731");
      }
    },
  );

  it.skipIf(!hasDb)(
    "with a DB, unknown ?instance= → 404 for an authorized reader, OR a fail-closed status",
    async () => {
      const result = await request("GET", "/api/audit/export?instance=DOES-NOT-EXIST", {
        "x-dev-user": "e-sokolov",
      });
      expect([404, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 404) {
        const data = JSON.parse(result.body) as Record<string, unknown>;
        expect((data.error as Record<string, unknown>)?.code).toBe("NOT_FOUND");
      }
    },
  );

  // AC-6: /api/audit/:instanceId still routes correctly (export route does not
  // shadow it) — T-0737: this route is ALSO gated now, so the envelope check
  // applies here too (previously this test relied on the route having no auth
  // gate at all; that is precisely the P1 this task closes).
  it.skipIf(hasDb)(
    "without a DB, GET /api/audit/INS-7731 → 503 (T-0737: this route is now gated too)",
    async () => {
      const result = await request("GET", "/api/audit/INS-7731");
      expect(result.statusCode).toBe(503);
    },
  );

  it.skipIf(!hasDb)(
    "with a DB, GET /api/audit/INS-7731 → 200 not captured by /export, OR a fail-closed status",
    async () => {
      const result = await request("GET", "/api/audit/INS-7731", { "x-dev-user": "e-sokolov" });
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body) as AuditData;
        expect(data.instance.id).toBe("INS-7731");
        const disposition = result.headers["content-disposition"] ?? "";
        expect(disposition).not.toContain("attachment");
      }
    },
  );
});
