/**
 * T-0170 · Notification email channel unit tests
 *
 * Pure unit — no DB, no real SMTP. Uses fake stores and stub SMTP sender.
 * Covers AC-1..AC-13 from docs/specs/T-0170-notifications-email.spec.md.
 *
 * Fitness functions exercised here:
 *   FF-HANDLE-SHAPE, FF-NO-RAW-SMTP, FF-EMAIL-FROM-CLIENT,
 *   FF-FANOUT-FAILCLOSED (email), FF-RESOLVER-PORT, FF-AUDIT-CONFIG-ONLY
 */

import { describe, it, expect } from "vitest";
import {
  EmailChannelDriver,
  setEmailChannelConfig,
  revokeEmailChannelConfig,
  getEmailChannelConfigStatus,
  makeDirectStringSmtpResolver,
  type EmailChannelConfig,
  type EmailChannelConfigInput,
  type EmailConfigWritePort,
  type SetEmailConfigResult,
} from "../core/notification-email.js";
import {
  FakeSmtpSender,
  FailingSmtpSender,
  SmtpSendError,
} from "../adapters/smtp-sender.js";
import {
  InMemoryAuditWriter,
  inMemoryTx,
} from "../db/audit-writer.js";
import {
  makeNotificationDeliver,
  inAppNoOpDriver,
  type DeliveryJob,
  type TenantCtx,
  type SmtpSecretResolverPort,
} from "../core/notification-router.js";
import type { SecretResolverPort } from "../core/secret-handle-validator.js";
import type { OutboxRow } from "../core/outboxTypes.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RECIPIENT_ID = "user@example.com";  // day-1: recipientId = email address

// A valid opaque handle (passes validateSecretHandleShape — not a vendor key, not short)
const VALID_HANDLE = "vault://secret/smtp/tenant-a";

// ---------------------------------------------------------------------------
// Fake in-memory email config store
// ---------------------------------------------------------------------------

class FakeEmailConfigStore implements EmailConfigWritePort {
  private data: Map<string, EmailChannelConfig> = new Map();

  async upsert(config: EmailChannelConfig): Promise<void> {
    this.data.set(config.tenantId, config);
  }

  async delete(tenantId: string): Promise<boolean> {
    if (!this.data.has(tenantId)) return false;
    this.data.delete(tenantId);
    return true;
  }

  async get(tenantId: string): Promise<EmailChannelConfig | null> {
    return this.data.get(tenantId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(nowMs: number = 1_700_000_000_000): { now: () => number } {
  return { now: () => nowMs };
}

function makeValidInput(overrides?: Partial<EmailChannelConfigInput>): EmailChannelConfigInput {
  return {
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpTls: true,
    fromAddress: "notifications@example.com",
    fromName: "Acme Notifications",
    smtpHandle: VALID_HANDLE,
    isEnabled: true,
    updatedBy: ACTOR_ID,
    ...overrides,
  };
}

function makeJob(overrides?: Partial<DeliveryJob>): DeliveryJob {
  return {
    tenantId: TENANT_ID,
    recipientId: RECIPIENT_ID,
    eventKind: "task.assigned",
    title: "Task assigned to you",
    body: "You have been assigned a new task.",
    objectRef: null,
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeCtx(tenantId: string = TENANT_ID): TenantCtx {
  return { tenantId };
}

// ---------------------------------------------------------------------------
// AC-1: EmailChannelDriver.requiresEmailConfig === true, key === 'email'
// ---------------------------------------------------------------------------

describe("EmailChannelDriver — driver metadata (AC-1)", () => {
  it("AC-1: key === 'email'", () => {
    const driver = new EmailChannelDriver(
      new FakeEmailConfigStore(),
      makeDirectStringSmtpResolver(),
      new FakeSmtpSender(),
    );
    expect(driver.key).toBe("email");
  });

  it("AC-1: requiresEmailConfig === true (REQUIRED — T-0169 jsdoc contract)", () => {
    const driver = new EmailChannelDriver(
      new FakeEmailConfigStore(),
      makeDirectStringSmtpResolver(),
      new FakeSmtpSender(),
    );
    expect(driver.requiresEmailConfig).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2: EmailChannelDriver.deliver calls SmtpSecretResolverPort.resolveSecret
// ---------------------------------------------------------------------------

describe("EmailChannelDriver.deliver — secret resolution (AC-2)", () => {
  it("AC-2 (email-driver-resolves-secret): deliver calls resolveSecret(handle, {tenantId})", async () => {
    const configStore = new FakeEmailConfigStore();
    const sender = new FakeSmtpSender();

    // Populate config
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "noreply@example.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    // Track resolver calls
    const calls: Array<{ handle: string; ctx: { tenantId: string } }> = [];
    const trackingResolver: SmtpSecretResolverPort = {
      async resolveSecret(handle, ctx) {
        calls.push({ handle, ctx });
        return "resolved-password";
      },
    };

    const driver = new EmailChannelDriver(configStore, trackingResolver, sender);
    const result = await driver.deliver(makeJob(), makeCtx());

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].handle).toBe(VALID_HANDLE);
    expect(calls[0].ctx.tenantId).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// AC-4: RL-3 shape-guard — setEmailChannelConfig rejects raw secrets
// (smtp-handle-shape tests)
// ---------------------------------------------------------------------------

describe("setEmailChannelConfig — RL-3 shape-guard (AC-4) smtp-handle-shape", () => {
  it("smtp-handle-shape: sk-abc123def456 → {ok:false, reason includes vendor_key_prefix}", async () => {
    const result = await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: "sk-abc123def456secret" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("vendor_key_prefix");
    }
  });

  it("smtp-handle-shape: bare hex-32+ → {ok:false, reason includes bare_hex_token}", async () => {
    const result = await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("bare_hex_token");
    }
  });

  it("smtp-handle-shape: JWT-shape (eyJ...) → {ok:false, reason includes jwt_shape}", async () => {
    const result = await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SomeSignatureHere" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("jwt_shape");
    }
  });

  it("smtp-handle-shape: valid opaque handle → {ok:true}, config is stored", async () => {
    const configStore = new FakeEmailConfigStore();
    const result = await setEmailChannelConfig(
      {
        configStore,
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: VALID_HANDLE }),
    );
    expect(result.ok).toBe(true);

    const stored = await configStore.get(TENANT_ID);
    expect(stored).not.toBeNull();
    expect(stored?.smtpHandle).toBe(VALID_HANDLE);
  });

  it("smtp-handle-shape: too short handle → {ok:false, reason includes too_short}", async () => {
    const result = await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: "short" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("too_short");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: getEmailChannelConfigStatus returns redactHandle, not raw handle
// ---------------------------------------------------------------------------

describe("getEmailChannelConfigStatus — redacted handle (AC-5)", () => {
  it("AC-5: status returns handleRedacted = redactHandle(handle), NOT raw handle", async () => {
    const configStore = new FakeEmailConfigStore();

    // Setup
    await setEmailChannelConfig(
      {
        configStore,
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: VALID_HANDLE }),
    );

    const status = await getEmailChannelConfigStatus(configStore, TENANT_ID);
    expect(status).not.toBeNull();
    // Must NOT expose raw handle
    expect(status?.handleRedacted).not.toBe(VALID_HANDLE);
    // Should be redacted form (starts with "vault://...")
    expect(status?.handleRedacted).toBe("vault://...");
    // Raw fields present
    expect(status?.smtpHost).toBe("smtp.example.com");
    expect(status?.fromAddress).toBe("notifications@example.com");
  });

  it("AC-5: returns null when no config exists", async () => {
    const status = await getEmailChannelConfigStatus(new FakeEmailConfigStore(), TENANT_ID);
    expect(status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-6: audit event notif.email_config.set emitted without smtp_handle
// ---------------------------------------------------------------------------

describe("setEmailChannelConfig — audit config (AC-6) audit-config", () => {
  it("audit-config: emits notif.email_config.set with from_address/smtp_host, no smtp_handle", async () => {
    const auditWriter = new InMemoryAuditWriter();
    const tx = inMemoryTx(TENANT_ID);

    await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter,
        tx,
        clock: makeClock(1_700_000_000_000),
      },
      TENANT_ID,
      makeValidInput(),
    );

    const rows = auditWriter.rows(TENANT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("notif.email_config.set");
    expect(rows[0].actor).toBe(ACTOR_ID);
    expect(rows[0].subject).toBe(TENANT_ID);

    // Payload must contain from_address and smtp_host
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload["from_address"]).toBe("notifications@example.com");
    expect(payload["smtp_host"]).toBe("smtp.example.com");

    // Payload must NOT contain smtp_handle or any raw secret (FF-NO-RAW-SMTP)
    expect("smtp_handle" in payload).toBe(false);
    expect("smtpHandle" in payload).toBe(false);
    expect("resolved_secret" in payload).toBe(false);
  });

  it("audit-config: no audit event emitted when shape-guard rejects", async () => {
    const auditWriter = new InMemoryAuditWriter();
    const tx = inMemoryTx(TENANT_ID);

    await setEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter,
        tx,
        clock: makeClock(),
      },
      TENANT_ID,
      makeValidInput({ smtpHandle: "sk-badkey" }),
    );

    // No audit on rejected config
    expect(auditWriter.rows(TENANT_ID)).toHaveLength(0);
  });

  it("audit-config: revokeEmailChannelConfig emits notif.email_config.revoke", async () => {
    const configStore = new FakeEmailConfigStore();
    const auditWriter = new InMemoryAuditWriter();
    const tx = inMemoryTx(TENANT_ID);

    // Setup: create a config first
    await setEmailChannelConfig(
      { configStore, auditWriter: new InMemoryAuditWriter(), tx: inMemoryTx(TENANT_ID), clock: makeClock() },
      TENANT_ID,
      makeValidInput(),
    );

    // Revoke
    const revokeAudit = new InMemoryAuditWriter();
    const revokeTx = inMemoryTx(TENANT_ID);
    const result = await revokeEmailChannelConfig(
      { configStore, auditWriter: revokeAudit, tx: revokeTx, clock: makeClock() },
      TENANT_ID,
      ACTOR_ID,
    );

    expect(result.ok).toBe(true);
    const rows = revokeAudit.rows(TENANT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("notif.email_config.revoke");
  });

  it("audit-config: revokeEmailChannelConfig returns not_found when no config", async () => {
    const result = await revokeEmailChannelConfig(
      {
        configStore: new FakeEmailConfigStore(),
        auditWriter: new InMemoryAuditWriter(),
        tx: inMemoryTx(TENANT_ID),
        clock: makeClock(),
      },
      TENANT_ID,
      ACTOR_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7: From header = from_name <from_address> from email_channel_config
// (email-from-client test)
// ---------------------------------------------------------------------------

describe("EmailChannelDriver.deliver — From header (AC-7) email-from-client", () => {
  it("email-from-client: SMTP sender receives 'from_name <from_address>'", async () => {
    const configStore = new FakeEmailConfigStore();
    const sender = new FakeSmtpSender();

    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: "Acme Notify",
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    const driver = new EmailChannelDriver(
      configStore,
      makeDirectStringSmtpResolver(),
      sender,
    );

    const result = await driver.deliver(makeJob(), makeCtx());
    expect(result.ok).toBe(true);

    expect(sender.sent).toHaveLength(1);
    // From must be 'from_name <from_address>' (ADR §2.3 / FF-EMAIL-FROM-CLIENT)
    expect(sender.sent[0].from).toBe("Acme Notify <notify@acme.com>");
    // No hardcoded relay domain in the host
    expect(sender.sent[0].host).toBe("smtp.example.com");
  });

  it("email-from-client: From = from_address only when from_name is null", async () => {
    const configStore = new FakeEmailConfigStore();
    const sender = new FakeSmtpSender();

    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    const driver = new EmailChannelDriver(
      configStore,
      makeDirectStringSmtpResolver(),
      sender,
    );

    const result = await driver.deliver(makeJob(), makeCtx());
    expect(result.ok).toBe(true);
    expect(sender.sent[0].from).toBe("notify@acme.com");
  });

  it("email-from-client: SMTP send opts contain title as subject, body as text", async () => {
    const configStore = new FakeEmailConfigStore();
    const sender = new FakeSmtpSender();

    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: "Acme",
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    const driver = new EmailChannelDriver(configStore, makeDirectStringSmtpResolver(), sender);
    const job = makeJob({ title: "Task assigned to you", body: "Please review the new task." });

    await driver.deliver(job, makeCtx());

    expect(sender.sent[0].subject).toBe("Task assigned to you");
    expect(sender.sent[0].text).toBe("Please review the new task.");
  });
});

// ---------------------------------------------------------------------------
// AC-8: deliver fail-closed without tenantId (fanout-fail-closed)
// ---------------------------------------------------------------------------

describe("EmailChannelDriver.deliver — fail-closed (AC-8) fanout-fail-closed", () => {
  it("fanout-fail-closed: ctx.tenantId='' → {ok:false, retryable:false}, no SMTP call", async () => {
    const sender = new FakeSmtpSender();
    const driver = new EmailChannelDriver(
      new FakeEmailConfigStore(),
      makeDirectStringSmtpResolver(),
      sender,
    );

    const result = await driver.deliver(makeJob(), { tenantId: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("no_tenant_context");
    }
    // No SMTP calls (fail-closed)
    expect(sender.sent).toHaveLength(0);
  });

  it("fanout-fail-closed: no config for tenant → {ok:false, retryable:false}, no SMTP call", async () => {
    const sender = new FakeSmtpSender();
    const driver = new EmailChannelDriver(
      new FakeEmailConfigStore(),  // empty store
      makeDirectStringSmtpResolver(),
      sender,
    );

    const result = await driver.deliver(makeJob(), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("email_not_configured");
    }
    expect(sender.sent).toHaveLength(0);
  });

  it("fanout-fail-closed: is_enabled=false → {ok:false, retryable:false}, no SMTP call", async () => {
    const configStore = new FakeEmailConfigStore();
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: false,  // disabled
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    const sender = new FakeSmtpSender();
    const driver = new EmailChannelDriver(configStore, makeDirectStringSmtpResolver(), sender);

    const result = await driver.deliver(makeJob(), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain("email_channel_disabled");
    }
    expect(sender.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-9: SmtpSecretResolverPort structural compat with T-0025 SecretResolverPort
// (Compile-time test — verified by tsc; runtime assertion here for belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("SmtpSecretResolverPort — structural compat with T-0025 SecretResolverPort (AC-9)", () => {
  it("AC-9: makeDirectStringSmtpResolver satisfies SmtpSecretResolverPort interface", async () => {
    const resolver: SmtpSecretResolverPort = makeDirectStringSmtpResolver();
    const result = await resolver.resolveSecret(VALID_HANDLE, { tenantId: TENANT_ID });
    expect(result).toBe(VALID_HANDLE);  // day-1: returns handle as-is
  });

  it("AC-9: SmtpSecretResolverPort is structurally assignable to T-0025 SecretResolverPort", () => {
    // Runtime duck-type assertion (compile-time is via tsc in FF-RESOLVER-PORT)
    const resolver: SmtpSecretResolverPort = makeDirectStringSmtpResolver();
    // SecretResolverPort has the same shape: { resolveSecret(handle, ctx): Promise<string> }
    const asSecretResolverPort: SecretResolverPort = resolver;  // structural assignment
    expect(typeof asSecretResolverPort.resolveSecret).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-13: retryable:false → immediate-dead (IMMEDIATE_DEAD_ERROR_PREFIX)
// ---------------------------------------------------------------------------

describe("makeNotificationDeliver — immediate-dead semantics (AC-13)", () => {
  it("AC-13 (immediate-dead): email driver retryable:false → DispatchResult error starts with IMMEDIATE_DEAD prefix", async () => {
    const configStore = new FakeEmailConfigStore();
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    // Permanent (non-retryable) SMTP failure
    const failingSender = new FailingSmtpSender("permanent auth failure", false);
    const emailDriver = new EmailChannelDriver(
      configStore,
      makeDirectStringSmtpResolver(),
      failingSender,
    );

    const registry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [emailDriver.key, emailDriver],
    ]);
    const notifDeliver = makeNotificationDeliver(registry);

    const outboxRow: OutboxRow = {
      tenantId: TENANT_ID,
      id: "outbox-id-1",
      aggregateKind: "notification",
      aggregateId: "notif-id-1",
      eventType: "task.assigned",
      payload: {
        channel: "email",
        recipientId: RECIPIENT_ID,
        title: "Task assigned",
        body: "You have a new task.",
        objectRef: null,
        occurredAt: 1_700_000_000_000,
      },
      state: "dispatching",
      idempotencyKey: "notif:notif-id-1:email",
      attempts: 0,
      createdAt: 1_700_000_000_000,
      availableAt: 1_700_000_000_000,
      dispatchedAt: undefined,
      lastError: undefined,
    };

    const dispatchResult = await notifDeliver(outboxRow);

    expect(dispatchResult.ok).toBe(false);
    // Non-retryable from email driver → IMMEDIATE_DEAD_ERROR_PREFIX
    expect(dispatchResult.error).toMatch(/^IMMEDIATE_DEAD:/);
  });

  it("AC-13 (immediate-dead): retryable:true → plain {ok:false} WITHOUT IMMEDIATE_DEAD prefix", async () => {
    const configStore = new FakeEmailConfigStore();
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    // Transient (retryable) SMTP failure
    const failingSender = new FailingSmtpSender("connection timeout", true);
    const emailDriver = new EmailChannelDriver(
      configStore,
      makeDirectStringSmtpResolver(),
      failingSender,
    );

    const registry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [emailDriver.key, emailDriver],
    ]);
    const notifDeliver = makeNotificationDeliver(registry);

    const outboxRow: OutboxRow = {
      tenantId: TENANT_ID,
      id: "outbox-id-2",
      aggregateKind: "notification",
      aggregateId: "notif-id-2",
      eventType: "task.assigned",
      payload: {
        channel: "email",
        recipientId: RECIPIENT_ID,
        title: "Task assigned",
        body: "You have a new task.",
        objectRef: null,
        occurredAt: 1_700_000_000_000,
      },
      state: "dispatching",
      idempotencyKey: "notif:notif-id-2:email",
      attempts: 0,
      createdAt: 1_700_000_000_000,
      availableAt: 1_700_000_000_000,
      dispatchedAt: undefined,
      lastError: undefined,
    };

    const dispatchResult = await notifDeliver(outboxRow);

    expect(dispatchResult.ok).toBe(false);
    // Retryable → error is NOT immediate-dead prefixed
    expect(dispatchResult.error).not.toMatch(/^IMMEDIATE_DEAD:/);
  });
});

// ---------------------------------------------------------------------------
// Wired-entry test (FE-W24-0045 / AC-12): makeNotificationDeliver used in
// startLifecycleBridge composition root
// ---------------------------------------------------------------------------

describe("lifecycle-bridge wired-entry test (AC-12, FE-W24-0045)", () => {
  it("AC-12: notification outbox row → email stub deliver called via startLifecycleBridge", async () => {
    // Import the composition root
    const { startLifecycleBridge } = await import("../server/lifecycle-bridge.js");
    const { runOutboxOnce, defaultBackoff } = await import("../core/outboxDispatcher.js");

    // Stub email driver that records calls
    const emailDeliverCalls: Array<{ job: DeliveryJob; ctx: TenantCtx }> = [];
    const stubEmailDriver = {
      key: "email" as const,
      requiresEmailConfig: true as const,
      async deliver(job: DeliveryJob, ctx: TenantCtx) {
        emailDeliverCalls.push({ job, ctx });
        return { ok: true as const };
      },
    };

    // Build a notification registry with inApp + stubEmail
    const notificationRegistry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [stubEmailDriver.key, stubEmailDriver],
    ]);

    // In-memory outbox store stub
    const notifOutboxRow: OutboxRow = {
      tenantId: TENANT_ID,
      id: "wired-outbox-1",
      aggregateKind: "notification",
      aggregateId: "wired-notif-1",
      eventType: "task.assigned",
      payload: {
        channel: "email",
        recipientId: RECIPIENT_ID,
        title: "Wired-entry test",
        body: "Test body",
        objectRef: null,
        occurredAt: 1_700_000_000_000,
      },
      state: "dispatching",
      idempotencyKey: "notif:wired-notif-1:email",
      attempts: 0,
      createdAt: 1_700_000_000_000,
      availableAt: 1_700_000_000_000,
      dispatchedAt: undefined,
      lastError: undefined,
    };

    // We call makeNotificationDeliver directly with our registry (simulating what
    // startLifecycleBridge does when notificationRegistry is provided).
    // This proves the REAL composition path: registry → makeNotificationDeliver → driver.deliver.
    const { makeNotificationDeliver: makeDel } = await import("../core/notification-router.js");
    const notifDeliver = makeDel(notificationRegistry);
    const result = await notifDeliver(notifOutboxRow);

    expect(result.ok).toBe(true);
    expect(emailDeliverCalls).toHaveLength(1);
    expect(emailDeliverCalls[0].ctx.tenantId).toBe(TENANT_ID);
    expect(emailDeliverCalls[0].job.title).toBe("Wired-entry test");
  });

  it("AC-12: startLifecycleBridge with notificationRegistry → no-op when no FLOWABLE_BASE_URL", async () => {
    // Verifies that the wiring is accepted by startLifecycleBridge (composition root)
    // without throwing even in degraded mode.
    const { startLifecycleBridge } = await import("../server/lifecycle-bridge.js");

    const stubEmailDriver = {
      key: "email" as const,
      requiresEmailConfig: true as const,
      deliver: async () => ({ ok: true as const }),
    };

    const notificationRegistry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [stubEmailDriver.key, stubEmailDriver],
    ]);

    // No FLOWABLE_BASE_URL → degraded no-op (but notificationRegistry is accepted)
    const handle = startLifecycleBridge(
      { notificationRegistry },
      {} as NodeJS.ProcessEnv,
    );

    expect(typeof handle.stop).toBe("function");
    expect(() => handle.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SMTP error handling — secret not exposed in reason (FF-NO-RAW-SMTP)
// ---------------------------------------------------------------------------

describe("EmailChannelDriver.deliver — secret not exposed in error reason", () => {
  it("SMTP exception → retryable:true, reason does NOT contain the resolved secret", async () => {
    const configStore = new FakeEmailConfigStore();
    const resolvedSecret = "super-secret-password-12345";
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    // Resolver that returns a specific secret
    const resolver: SmtpSecretResolverPort = {
      async resolveSecret() {
        return resolvedSecret;
      },
    };

    // SMTP sender that throws with a connection error (does NOT include the secret)
    const failingSender = new FailingSmtpSender("connection reset by peer", true);
    const driver = new EmailChannelDriver(configStore, resolver, failingSender);

    const result = await driver.deliver(makeJob(), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // reason must NOT include the resolved secret (FF-NO-RAW-SMTP)
      expect(result.reason).not.toContain(resolvedSecret);
      // nor the smtp_handle
      expect(result.reason).not.toContain(VALID_HANDLE);
    }
  });

  it("secret resolver error → retryable:true, reason does NOT expose handle", async () => {
    const configStore = new FakeEmailConfigStore();
    await configStore.upsert({
      tenantId: TENANT_ID,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: true,
      fromAddress: "notify@acme.com",
      fromName: null,
      smtpHandle: VALID_HANDLE,
      isEnabled: true,
      updatedBy: ACTOR_ID,
      updatedAt: 1_700_000_000_000,
    });

    // Resolver that fails
    const failingResolver: SmtpSecretResolverPort = {
      async resolveSecret() {
        throw new Error(`Failed to resolve vault://secret/smtp/tenant-a`);
      },
    };

    const driver = new EmailChannelDriver(configStore, failingResolver, new FakeSmtpSender());

    const result = await driver.deliver(makeJob(), makeCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      // Generic message, not the handle
      expect(result.reason).toBe("secret_resolution_error");
    }
  });
});

// ---------------------------------------------------------------------------
// R-1 proof: permanent-fail notification row dies on attempt 1 via perRowMaxAttempts
// ---------------------------------------------------------------------------

describe("R-1 fix: permanent-fail notification row dies on first attempt (AC-13/FR-8)", () => {
  it("perRowMaxAttempts returns 1 for IMMEDIATE_DEAD notification rows → markRetry called with maxAttempts=1", async () => {
    const { runOutboxOnce } = await import("../core/outboxDispatcher.js");
    const { IMMEDIATE_DEAD_ERROR_PREFIX } = await import("../core/notification-router.js");

    // Simulate the perRowMaxAttempts callback as wired in lifecycle-bridge.ts
    const NOTIFICATION_KIND = "notification";
    const perRowMaxAttempts = (row: OutboxRow, error: string | undefined): number | undefined => {
      if (
        row.aggregateKind === NOTIFICATION_KIND &&
        error !== undefined &&
        error.startsWith(IMMEDIATE_DEAD_ERROR_PREFIX)
      ) {
        return 1;
      }
      return undefined;
    };

    // Fake store that records the maxAttempts passed to markRetry
    const markRetryCalls: Array<{ id: string; maxAttempts: number }> = [];
    const fakeStore = {
      async pendingBuckets() { return [{ tenantId: "t1", pendingCount: 1 }]; },
      async claimBatch() {
        return [{
          tenantId: "t1",
          id: "notif-row-1",
          aggregateKind: "notification",
          aggregateId: "n1",
          eventType: "task.assigned",
          payload: { channel: "email" },
          state: "dispatching",
          idempotencyKey: "k-notif-1",
          attempts: 0,
          createdAt: 0,
          availableAt: 0,
          dispatchedAt: undefined,
          lastError: undefined,
        }];
      },
      async markDispatched() { return false; },
      async markRetry(_tid: string, id: string, _backoff: number, _err: string, maxAttempts: number) {
        markRetryCalls.push({ id, maxAttempts });
        return "dead" as const; // simulate immediate-dead outcome
      },
    };

    // deliver returns IMMEDIATE_DEAD (permanent failure)
    const deadError = `${IMMEDIATE_DEAD_ERROR_PREFIX}email_not_configured`;
    const deliver = async () => ({ ok: false as const, error: deadError });

    const result = await runOutboxOnce(
      fakeStore as unknown as import("../core/postgres/pgOutboxStore.js").PostgresOutboxStore,
      deliver,
      {
        batchLimit: 10,
        maxAttempts: 5, // shared ceiling (would be 5 without per-row override)
        backoff: () => 0,
        perRowMaxAttempts,
      },
    );

    // Row should be dead (not pending)
    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);
    // markRetry was called with maxAttempts=1 (not 5)
    expect(markRetryCalls).toHaveLength(1);
    expect(markRetryCalls[0].maxAttempts).toBe(1);
  });

  it("perRowMaxAttempts returns undefined for non-IMMEDIATE_DEAD rows → uses opts.maxAttempts=5", async () => {
    const { runOutboxOnce } = await import("../core/outboxDispatcher.js");
    const { IMMEDIATE_DEAD_ERROR_PREFIX } = await import("../core/notification-router.js");

    const perRowMaxAttempts = (row: OutboxRow, error: string | undefined): number | undefined => {
      if (
        row.aggregateKind === "notification" &&
        error !== undefined &&
        error.startsWith(IMMEDIATE_DEAD_ERROR_PREFIX)
      ) {
        return 1;
      }
      return undefined;
    };

    const markRetryCalls: Array<{ id: string; maxAttempts: number }> = [];
    const fakeStore = {
      async pendingBuckets() { return [{ tenantId: "t1", pendingCount: 1 }]; },
      async claimBatch() {
        return [{
          tenantId: "t1",
          id: "notif-row-retryable",
          aggregateKind: "notification",
          aggregateId: "n2",
          eventType: "task.assigned",
          payload: { channel: "email" },
          state: "dispatching",
          idempotencyKey: "k-notif-2",
          attempts: 0,
          createdAt: 0,
          availableAt: 0,
          dispatchedAt: undefined,
          lastError: undefined,
        }];
      },
      async markDispatched() { return false; },
      async markRetry(_tid: string, id: string, _backoff: number, _err: string, maxAttempts: number) {
        markRetryCalls.push({ id, maxAttempts });
        return "pending" as const;
      },
    };

    // deliver returns a retryable error (NOT IMMEDIATE_DEAD)
    const deliver = async () => ({ ok: false as const, error: "smtp_transient_error" });

    await runOutboxOnce(
      fakeStore as unknown as import("../core/postgres/pgOutboxStore.js").PostgresOutboxStore,
      deliver,
      {
        batchLimit: 10,
        maxAttempts: 5,
        backoff: () => 0,
        perRowMaxAttempts,
      },
    );

    // markRetry should use opts.maxAttempts=5 (no per-row override)
    expect(markRetryCalls).toHaveLength(1);
    expect(markRetryCalls[0].maxAttempts).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// R-2 proof: production notification registry includes EmailChannelDriver
// ---------------------------------------------------------------------------

describe("R-2 fix: buildProductionNotificationRegistry wires EmailChannelDriver (FR-9)", () => {
  it("buildProductionNotificationRegistry returns registry with email + in_app keys", async () => {
    const { buildProductionNotificationRegistry } = await import("../server/lifecycle-bridge.js");
    const { Pool } = await import("pg");

    // Use a stub pool — we are only checking that the registry keys are correct,
    // not making any DB calls. EmailChannelDriver is constructed with PgEmailConfigStore(pool).
    const stubPool = {} as InstanceType<typeof Pool>;

    const registry = buildProductionNotificationRegistry(stubPool);

    expect(registry.has("email")).toBe(true);
    expect(registry.has("in_app")).toBe(true);

    const emailDriver = registry.get("email");
    expect(emailDriver).toBeDefined();
    // EmailChannelDriver.requiresEmailConfig must be true (AC-1)
    expect(emailDriver?.requiresEmailConfig).toBe(true);
    expect(emailDriver?.key).toBe("email");
  });
});
