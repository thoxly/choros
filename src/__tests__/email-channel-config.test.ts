/**
 * T-0203 · email-channel-config HTTP handler unit tests
 *
 * Pure unit — no live Postgres. Covers:
 *   - module exports registerEmailChannelConfigRoutes
 *   - 401 UNAUTHENTICATED when X-Dev-User header is absent
 *   - 403 NO_EMAIL_CFG_GRANT when the injected PDP gate denies (FF-PREF-AUTHZ pattern)
 *   - 400 VALIDATION on malformed PUT body (missing required fields)
 *   - RL-3 shape-guard wiring (FF-HANDLE-SHAPE / FF-NO-RAW-SMTP): a raw sk-/hex/JWT
 *     handle is rejected by setEmailChannelConfig and NEVER written / audited; a
 *     valid opaque handle is accepted; the status view redacts the handle.
 *
 * The allow-path that reaches Postgres (withTenantTx) is exercised in the live-DB
 * suite (ci/checks/db). Here we drive the gate/validation logic with an injected
 * fake authz dep and a null pool (denied/unauth paths never touch the pool), plus
 * the core CRUD directly with a fake EmailConfigWritePort + fake audit writer.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import {
  registerEmailChannelConfigRoutes,
  type EmailConfigAuthzDeps,
} from "../http/email-channel-config.js";
import {
  setEmailChannelConfig,
  getEmailChannelConfigStatus,
  type EmailChannelConfig,
  type EmailConfigWritePort,
} from "../core/notification-email.js";
import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { Router } from "../http/router.js";

// ---------------------------------------------------------------------------
// Test HTTP harness (mirrors notification-prefs.test.ts)
// ---------------------------------------------------------------------------

function buildTestServer(authzDeps: EmailConfigAuthzDeps): {
  server: http.Server;
  baseUrl: () => string;
} {
  const router = new Router();
  const fakePool = null as unknown as import("pg").Pool;
  registerEmailChannelConfigRoutes(router, fakePool, authzDeps);
  const server = http.createServer((req, res) => {
    router.dispatch(req, res);
  });
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname,
      method,
      headers: {
        ...headers,
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function errCode(json: unknown): unknown {
  const e = (json as Record<string, unknown>)["error"];
  return e && typeof e === "object" ? (e as Record<string, unknown>)["code"] : undefined;
}

const denyAllDeps: EmailConfigAuthzDeps = {
  checkAdminGrant: async () => ({ ok: false, reason: "no_admin_authority" }),
};

const allowAllDeps: EmailConfigAuthzDeps = {
  checkAdminGrant: async () => ({ ok: true }),
};

// ---------------------------------------------------------------------------
// module export
// ---------------------------------------------------------------------------

describe("email-channel-config: module export", () => {
  it("exports registerEmailChannelConfigRoutes", async () => {
    const mod = await import("../http/email-channel-config.js");
    expect(typeof mod.registerEmailChannelConfigRoutes).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 401 — no actor header
// ---------------------------------------------------------------------------

describe("email-channel-config: 401 without X-Dev-User", () => {
  const { server, baseUrl } = buildTestServer(allowAllDeps);
  beforeAll(() => new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  }));
  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("GET → 401 UNAUTHENTICATED", async () => {
    const res = await httpReq("GET", `${baseUrl()}/api/email-channel-config`);
    expect(res.status).toBe(401);
    expect(errCode(res.json)).toBe("UNAUTHENTICATED");
  });
});

// ---------------------------------------------------------------------------
// 403 — PDP gate denies (FF-PREF-AUTHZ pattern, mgmt_object:email_config)
// ---------------------------------------------------------------------------

describe("email-channel-config: 403 when checkAdminGrant denies", () => {
  const { server, baseUrl } = buildTestServer(denyAllDeps);
  beforeAll(() => new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  }));
  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("GET → 403 NO_EMAIL_CFG_GRANT", async () => {
    const res = await httpReq("GET", `${baseUrl()}/api/email-channel-config`, { "x-dev-user": "no-grant" });
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(errCode(res.json)).toBe("NO_EMAIL_CFG_GRANT");
  });

  it("PUT → 403 NO_EMAIL_CFG_GRANT", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/email-channel-config`,
      { "x-dev-user": "no-grant" },
      { smtpHost: "smtp.example.com", smtpPort: 587, fromAddress: "a@b.com", smtpHandle: "h-1234567890" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(errCode(res.json)).toBe("NO_EMAIL_CFG_GRANT");
  });

  it("DELETE → 403 NO_EMAIL_CFG_GRANT", async () => {
    const res = await httpReq("DELETE", `${baseUrl()}/api/email-channel-config`, { "x-dev-user": "no-grant" });
    expect(res.status, JSON.stringify(res.json)).toBe(403);
    expect(errCode(res.json)).toBe("NO_EMAIL_CFG_GRANT");
  });
});

// ---------------------------------------------------------------------------
// 400 — malformed PUT body (validation runs after the allow gate, before any DB)
// Note: with the allow gate + null pool, a *valid* body would reach withTenantTx
// and throw on the null pool (500). A malformed body must short-circuit at 400
// BEFORE touching the pool — that is exactly what we assert here.
// ---------------------------------------------------------------------------

describe("email-channel-config: 400 on malformed PUT body", () => {
  const { server, baseUrl } = buildTestServer(allowAllDeps);
  beforeAll(() => new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  }));
  afterAll(() => new Promise<void>((res) => server.close(() => res())));

  it("missing smtpHost → 400 VALIDATION (no pool access)", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/email-channel-config`,
      { "x-dev-user": "admin" },
      { smtpPort: 587, fromAddress: "a@b.com", smtpHandle: "h-1234567890" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(errCode(res.json)).toBe("VALIDATION");
  });

  it("bad smtpPort → 400 VALIDATION", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/email-channel-config`,
      { "x-dev-user": "admin" },
      { smtpHost: "smtp.example.com", smtpPort: 0, fromAddress: "a@b.com", smtpHandle: "h-1234567890" },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(errCode(res.json)).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// RL-3 shape-guard wiring (FF-HANDLE-SHAPE / FF-NO-RAW-SMTP) via the core CRUD
// the handler invokes. A fake store + fake audit writer (no DB).
// ---------------------------------------------------------------------------

class FakeEmailConfigStore implements EmailConfigWritePort {
  public stored: EmailChannelConfig | null = null;
  async upsert(config: EmailChannelConfig): Promise<void> { this.stored = config; }
  async delete(_tenantId: string): Promise<boolean> { const had = this.stored !== null; this.stored = null; return had; }
  async get(_tenantId: string): Promise<EmailChannelConfig | null> { return this.stored; }
}

class FakeAuditWriter implements AuditWriter {
  public events: AuditEventInput[] = [];
  async appendAuditEvent(_tx: PgClientLike, input: AuditEventInput) {
    this.events.push(input);
    return { id: input.id, seq: this.events.length, prev_hash: null, hash: "x" } as never;
  }
}

const fakeTx = {} as unknown as PgClientLike;
const fixedClock = { now: () => 1000 };

describe("email-config RL-3 shape-guard (FF-HANDLE-SHAPE / FF-NO-RAW-SMTP)", () => {
  it("rejects a raw sk- handle: no write, no audit", async () => {
    const store = new FakeEmailConfigStore();
    const audit = new FakeAuditWriter();
    const result = await setEmailChannelConfig(
      { configStore: store, auditWriter: audit, tx: fakeTx, clock: fixedClock },
      "t-1",
      { smtpHost: "smtp.example.com", smtpPort: 587, smtpTls: true, fromAddress: "a@b.com", smtpHandle: "sk-abcdef0123456789abcdef0123456789", isEnabled: true, updatedBy: "admin" },
    );
    expect(result.ok).toBe(false);
    expect(store.stored, "raw secret must NOT be written").toBeNull();
    expect(audit.events.length, "no audit on rejected handle").toBe(0);
  });

  it("rejects a bare-hex-32 handle", async () => {
    const store = new FakeEmailConfigStore();
    const audit = new FakeAuditWriter();
    const result = await setEmailChannelConfig(
      { configStore: store, auditWriter: audit, tx: fakeTx, clock: fixedClock },
      "t-1",
      { smtpHost: "smtp.example.com", smtpPort: 587, smtpTls: true, fromAddress: "a@b.com", smtpHandle: "0123456789abcdef0123456789abcdef", isEnabled: true, updatedBy: "admin" },
    );
    expect(result.ok).toBe(false);
    expect(store.stored).toBeNull();
  });

  it("accepts a valid opaque handle: writes + audits notif.email_config.set WITHOUT smtp_handle", async () => {
    const store = new FakeEmailConfigStore();
    const audit = new FakeAuditWriter();
    const result = await setEmailChannelConfig(
      { configStore: store, auditWriter: audit, tx: fakeTx, clock: fixedClock },
      "t-1",
      { smtpHost: "smtp.example.com", smtpPort: 587, smtpTls: true, fromAddress: "noreply@client.com", fromName: "Client", smtpHandle: "vault://smtp/client-1", isEnabled: true, updatedBy: "admin" },
    );
    expect(result.ok).toBe(true);
    expect(store.stored).not.toBeNull();
    expect(store.stored!.fromAddress).toBe("noreply@client.com");
    // FF-AUDIT-CONFIG-ONLY + FF-NO-RAW-SMTP: audit emitted, handle absent.
    expect(audit.events.length).toBe(1);
    expect(audit.events[0]!.type).toBe("notif.email_config.set");
    const payloadStr = JSON.stringify(audit.events[0]!.payload);
    expect(payloadStr, "audit payload must not carry the handle").not.toContain("vault://smtp/client-1");
  });

  it("status view redacts the handle (FF-NO-RAW-SMTP)", async () => {
    const store = new FakeEmailConfigStore();
    store.stored = {
      tenantId: "t-1", smtpHost: "smtp.example.com", smtpPort: 587, smtpTls: true,
      fromAddress: "noreply@client.com", fromName: "Client",
      smtpHandle: "vault://smtp/client-1", isEnabled: true, updatedBy: "admin", updatedAt: 1000,
    };
    const status = await getEmailChannelConfigStatus(store, "t-1");
    expect(status).not.toBeNull();
    expect(status!.handleRedacted).not.toBe("vault://smtp/client-1");
    // The status object must not contain the raw handle under any key.
    expect(JSON.stringify(status)).not.toContain("vault://smtp/client-1");
  });
});
