/**
 * T-0174 · E-N.7 — notification e2e wired-pipeline test
 *
 * Integration-honesty test (same pattern as main-wired-entry.test.ts / D-056).
 * Drives the REAL notification delivery chain with only boundary IO faked:
 *
 *   publishNotificationEvent
 *     ├─ in-memory PrefStore (one 'actor:<user>' scope, channels [in_app, email])
 *     ├─ in-memory EmailConfigStore (is_enabled=true, valid handle)
 *     ├─ in-memory NotifStore (captures inserts)
 *     ├─ in-memory OutboxStore (captures enqueues)
 *     └─ defaultTemplateRenderer (real code-bundled templates)
 *
 *   runOutboxOnce(fakeOutboxStore, makeNotificationDeliver(registry))
 *     ├─ in_app row → inAppNoOpDriver → {ok:true} → markDispatched
 *     └─ email row → EmailChannelDriver(fakeConfigStore, directResolver, FakeSmtpSender)
 *                    → FakeSmtpSender captures the sent message
 *                    → {ok:true} → markDispatched
 *
 * None of publishNotificationEvent / makeNotificationDeliver / EmailChannelDriver /
 * inAppNoOpDriver / runOutboxOnce / defaultTemplateRenderer are mocked — they run
 * as production code. Only boundary IO (stores, SMTP sender) is in-memory.
 *
 * If any link in the chain is broken (missing wiring, wrong interface, etc.)
 * the assertions below will fail — the test is a liveness gate, not a unit test.
 *
 * Fitness functions confirmed:
 *   FF-AUDIT-CONFIG-ONLY: no appendAuditEvent in deliver path (observable: no audit writer injected)
 *   FF-NO-DELIVERY-AUDIT: confirmed by observation (delivery path has no audit calls)
 *   FF-ONE-OUTBOX: delivery via runOutboxOnce + makeNotificationDeliver (no second dispatcher)
 *   FF-FANOUT-FAILCLOSED: tenantId='' → throw (AC-5 in routing test already covers this)
 *
 * AC coverage (docs/specs/T-0174-notifications-e2e.spec.md):
 *   AC-2  publishNotificationEvent: inAppCreated=1, outboxEnqueued=2
 *   AC-3  runOutboxOnce: dispatched=2, failed=0, dead=0; FakeSmtpSender received one email
 *   AC-4  immediate-dead path: FailingSmtpSender(retryable=false) → dead=1 on first attempt
 */

import { describe, it, expect } from "vitest";
import {
  publishNotificationEvent,
  makeNotificationDeliver,
  inAppNoOpDriver,
  IMMEDIATE_DEAD_ERROR_PREFIX,
  type NotificationEvent,
  type NotificationPreference,
  type NotificationPrefStore,
  type NotifInsertPort,
  type NotifInsertRow,
  type NotifOutboxEnqueuePort,
  type EmailChannelConfigStore,
  type PublishNotificationDeps,
  type TenantCtx,
  type ChannelRegistry,
  type RoleResolverPort,
} from "../core/notification-router.js";
import {
  EmailChannelDriver,
  makeDirectStringSmtpResolver,
  type EmailChannelConfig,
  type EmailConfigWritePort,
} from "../core/notification-email.js";
import { defaultTemplateRenderer } from "../core/notification-templates.js";
import {
  FakeSmtpSender,
  FailingSmtpSender,
} from "../adapters/smtp-sender.js";
import type { OutboxInsert, OutboxRow } from "../core/outboxTypes.js";
import { runOutboxOnce, defaultBackoff, type RunOutboxOptions } from "../core/outboxDispatcher.js";
import type { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RECIPIENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";  // a concrete employee-like UUID
const ACTOR_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const EVENT_KIND = "task.assigned";

// A valid opaque SMTP handle (passes validateSecretHandleShape — not a vendor key)
const VALID_SMTP_HANDLE = "vault://secret/smtp/test-tenant";

const CTX: TenantCtx = { tenantId: TENANT_ID };

// ---------------------------------------------------------------------------
// In-memory store implementations
// ---------------------------------------------------------------------------

/** In-memory NotificationPrefStore. Returns a fixed list of prefs per eventKind. */
class InMemoryPrefStore implements NotificationPrefStore {
  constructor(private readonly prefs: NotificationPreference[]) {}

  async getPreferences(tenantId: string, eventKind: string): Promise<NotificationPreference[]> {
    if (!tenantId) return [];
    return this.prefs.filter((p) => p.eventKind === eventKind);
  }
}

/** In-memory notification INSERT capture store. */
class InMemoryNotifStore implements NotifInsertPort {
  readonly rows: NotifInsertRow[] = [];

  async insert(row: NotifInsertRow): Promise<void> {
    this.rows.push(row);
  }
}

/**
 * In-memory outbox ENQUEUE + DISPATCH store.
 *
 * Two responsibilities:
 *  1. enqueue() — captures rows during publishNotificationEvent
 *  2. pendingBuckets/claimBatch/markDispatched/markRetry — drives runOutboxOnce
 */
class InMemoryOutboxStore implements NotifOutboxEnqueuePort {
  private nextId = 1;
  readonly enqueued: OutboxInsert[] = [];
  private claimed = false;
  private bucketsServed = false;

  // OutboxRows available for dispatch (populated from enqueued after publishNotificationEvent)
  private dispatchRows: OutboxRow[] = [];

  // Dispatch outcome counters
  readonly dispatched: string[] = [];
  readonly retried: Array<{ id: string; maxAttempts: number }> = [];

  // --- NotifOutboxEnqueuePort ---
  async enqueue(row: OutboxInsert): Promise<void> {
    const id = `outbox-row-${this.nextId++}`;
    this.enqueued.push(row);
    // Pre-build dispatch row so runOutboxOnce can claim it
    this.dispatchRows.push({
      tenantId: TENANT_ID,
      id,
      aggregateKind: row.aggregateKind,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      state: "pending",
      idempotencyKey: row.idempotencyKey,
      attempts: 0,
      createdAt: Date.now(),
      availableAt: 0,
      dispatchedAt: undefined,
      lastError: undefined,
    });
  }

  // --- PostgresOutboxStore-compatible (minimal subset for runOutboxOnce) ---

  async pendingBuckets(_now?: number): Promise<Array<{ tenantId: string; pendingCount: number }>> {
    if (this.bucketsServed) return [];
    this.bucketsServed = true;
    const pending = this.dispatchRows.filter((r) => r.state === "pending");
    if (pending.length === 0) return [];
    return [{ tenantId: TENANT_ID, pendingCount: pending.length }];
  }

  async claimBatch(_tenantId: string, _limit: number): Promise<OutboxRow[]> {
    if (this.claimed) return [];
    this.claimed = true;
    const rows = this.dispatchRows.filter((r) => r.state === "pending");
    // Advance to 'dispatching' — OutboxRow is readonly but we own these objects in test
    rows.forEach((r) => { (r as unknown as Record<string, unknown>)["state"] = "dispatching"; });
    return rows;
  }

  async markDispatched(_tenantId: string, id: string): Promise<boolean> {
    const row = this.dispatchRows.find((r) => r.id === id);
    if (row) {
      (row as unknown as Record<string, unknown>)["state"] = "dispatched";
      this.dispatched.push(id);
    }
    return !!row;
  }

  async markRetry(
    _tenantId: string,
    id: string,
    _backoff: number,
    _err: string,
    maxAttempts: number,
  ): Promise<"pending" | "dead"> {
    const row = this.dispatchRows.find((r) => r.id === id);
    if (!row) return "dead";
    const attempts = (row.attempts || 0) + 1;
    (row as unknown as Record<string, unknown>)["attempts"] = attempts;
    this.retried.push({ id, maxAttempts });
    if (attempts >= maxAttempts) {
      (row as unknown as Record<string, unknown>)["state"] = "dead";
      return "dead";
    }
    (row as unknown as Record<string, unknown>)["state"] = "pending";
    return "pending";
  }
}

/** In-memory EmailConfigWritePort: always returns the provided config. */
class InMemoryEmailConfigStore implements EmailConfigWritePort {
  constructor(private readonly config: EmailChannelConfig | null = null) {}

  async upsert(_config: EmailChannelConfig): Promise<void> { /* no-op */ }
  async delete(_tenantId: string): Promise<boolean> { return false; }
  async get(_tenantId: string): Promise<EmailChannelConfig | null> {
    return this.config;
  }
}

/** In-memory EmailChannelConfigStore (for publishNotificationEvent). */
class InMemoryEmailGateStore implements EmailChannelConfigStore {
  constructor(private readonly isEnabled: boolean) {}

  async getConfig(_tenantId: string): Promise<{ isEnabled: boolean } | null> {
    return { isEnabled: this.isEnabled };
  }
}

/** No-op RoleResolverPort (no role-scoped preferences in this test). */
const noopRoleResolver: RoleResolverPort = {
  async resolveRole(_tenantId: string, _roleId: string): Promise<string[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Test event factory
// ---------------------------------------------------------------------------

function makeNotifEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventKind: EVENT_KIND,
    tenantId: TENANT_ID,
    subjectActorId: ACTOR_ID,
    objectRef: null,
    payload: { assigneeName: "Alice" },
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid email config fixture
// ---------------------------------------------------------------------------

const VALID_EMAIL_CONFIG: EmailChannelConfig = {
  tenantId: TENANT_ID,
  smtpHost: "smtp.test.example.com",
  smtpPort: 587,
  smtpTls: true,
  fromAddress: "test@example.com",
  fromName: "Choros Test",
  smtpHandle: VALID_SMTP_HANDLE,
  isEnabled: true,
  updatedBy: "test",
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// perRowMaxAttempts helper (mirrors lifecycle-bridge.ts wiring)
// ---------------------------------------------------------------------------

const perRowMaxAttempts: RunOutboxOptions["perRowMaxAttempts"] = (row, error) => {
  if (
    row.aggregateKind === "notification" &&
    error !== undefined &&
    error.startsWith(IMMEDIATE_DEAD_ERROR_PREFIX)
  ) {
    return 1; // immediate-dead: die on first attempt
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// AC-2: publishNotificationEvent — fanout counts
// ---------------------------------------------------------------------------

describe("AC-2: publishNotificationEvent fanout with [in_app, email] → inAppCreated=1, outboxEnqueued=2", () => {
  it("returns inAppCreated=1 and outboxEnqueued=2 for actor:user scope with in_app+email", async () => {
    const prefStore = new InMemoryPrefStore([{
      tenantId: TENANT_ID,
      eventKind: EVENT_KIND,
      recipientScope: `actor:${RECIPIENT_ID}`,
      channels: ["in_app", "email"],
    }]);
    const notifStore = new InMemoryNotifStore();
    const outboxStore = new InMemoryOutboxStore();
    const emailGateStore = new InMemoryEmailGateStore(true); // email enabled

    const emailDriverAC2 = new EmailChannelDriver(
      new InMemoryEmailConfigStore(VALID_EMAIL_CONFIG),
      makeDirectStringSmtpResolver(),
      new FakeSmtpSender(),
    );
    const driverRegistry: ChannelRegistry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [emailDriverAC2.key, emailDriverAC2],
    ]);

    const deps: PublishNotificationDeps = {
      prefStore,
      notifStore,
      outboxStore,
      emailConfigStore: emailGateStore,
      channelRegistry: driverRegistry,
      templates: defaultTemplateRenderer,
      roleResolver: noopRoleResolver,
      clock: { now: () => 1_700_000_000_000 },
    };

    const result = await publishNotificationEvent(deps, makeNotifEvent(), CTX);

    expect(result.inAppCreated, "one in_app notification row must be created").toBe(1);
    expect(result.outboxEnqueued, "two outbox rows must be enqueued (in_app + email)").toBe(2);

    // Verify notification INSERT (in_app only)
    expect(notifStore.rows).toHaveLength(1);
    expect(notifStore.rows[0].tenantId).toBe(TENANT_ID);
    expect(notifStore.rows[0].recipientId).toBe(RECIPIENT_ID);
    expect(notifStore.rows[0].eventKind).toBe(EVENT_KIND);

    // Verify outbox rows: one per channel
    expect(outboxStore.enqueued).toHaveLength(2);
    const channels = outboxStore.enqueued.map((r) => r.payload["channel"]);
    expect(channels).toContain("in_app");
    expect(channels).toContain("email");

    // Both rows must have aggregate_kind='notification'
    for (const row of outboxStore.enqueued) {
      expect(row.aggregateKind, "all outbox rows must be aggregateKind=notification").toBe("notification");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: full pipeline — publishNotificationEvent → runOutboxOnce → FakeSmtpSender
// ---------------------------------------------------------------------------

describe("AC-3: full pipeline — publishNotificationEvent → runOutboxOnce → FakeSmtpSender", () => {
  it("dispatches both rows; FakeSmtpSender receives one email with correct from/to", async () => {
    const smtpSender = new FakeSmtpSender();

    const emailDriver = new EmailChannelDriver(
      new InMemoryEmailConfigStore(VALID_EMAIL_CONFIG),
      makeDirectStringSmtpResolver(),
      smtpSender,
    );

    const registry: ChannelRegistry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [emailDriver.key, emailDriver],
    ]);

    const prefStore = new InMemoryPrefStore([{
      tenantId: TENANT_ID,
      eventKind: EVENT_KIND,
      recipientScope: `actor:${RECIPIENT_ID}`,
      channels: ["in_app", "email"],
    }]);
    const notifStore = new InMemoryNotifStore();
    const outboxStore = new InMemoryOutboxStore();
    const emailGateStore = new InMemoryEmailGateStore(true);

    const deps: PublishNotificationDeps = {
      prefStore,
      notifStore,
      outboxStore,
      emailConfigStore: emailGateStore,
      channelRegistry: registry,
      templates: defaultTemplateRenderer,
      roleResolver: noopRoleResolver,
      clock: { now: () => 1_700_000_000_000 },
    };

    // Step 1: fanout
    const fanoutResult = await publishNotificationEvent(deps, makeNotifEvent(), CTX);
    expect(fanoutResult.inAppCreated).toBe(1);
    expect(fanoutResult.outboxEnqueued).toBe(2);

    // Step 2: dispatch via runOutboxOnce
    const deliver = makeNotificationDeliver(registry);
    const result = await runOutboxOnce(
      outboxStore as unknown as PostgresOutboxStore,
      deliver,
      {
        batchLimit: 10,
        maxAttempts: 5,
        backoff: defaultBackoff,
        perRowMaxAttempts,
      },
    );

    expect(result.dispatched, "both rows must be dispatched").toBe(2);
    expect(result.failed, "no rows must fail").toBe(0);
    expect(result.dead, "no rows must die").toBe(0);

    // Step 3: FakeSmtpSender received one email (only email channel does SMTP)
    expect(smtpSender.sent, "FakeSmtpSender must receive exactly one email").toHaveLength(1);

    const sent = smtpSender.sent[0];
    expect(sent.from, "From must include from_address").toContain("test@example.com");
    // to = recipientId (day-1: recipientId treated as email address by EmailChannelDriver)
    expect(sent.to, "To must equal recipientId").toBe(RECIPIENT_ID);
    expect(sent.host, "SMTP host must come from config").toBe("smtp.test.example.com");
    expect(sent.port).toBe(587);
  });
});

// ---------------------------------------------------------------------------
// AC-4: immediate-dead path — FailingSmtpSender(retryable=false) → dead=1
// ---------------------------------------------------------------------------

describe("AC-4: immediate-dead — FailingSmtpSender(retryable=false) → email row dead=1", () => {
  it("email row becomes dead=1 on first attempt; in_app row dispatched=1", async () => {
    const failingSender = new FailingSmtpSender("permanent auth failure", false);

    const emailDriver = new EmailChannelDriver(
      new InMemoryEmailConfigStore(VALID_EMAIL_CONFIG),
      makeDirectStringSmtpResolver(),
      failingSender,
    );

    const registry: ChannelRegistry = new Map([
      [inAppNoOpDriver.key, inAppNoOpDriver],
      [emailDriver.key, emailDriver],
    ]);

    const prefStore = new InMemoryPrefStore([{
      tenantId: TENANT_ID,
      eventKind: EVENT_KIND,
      recipientScope: `actor:${RECIPIENT_ID}`,
      channels: ["in_app", "email"],
    }]);
    const notifStore = new InMemoryNotifStore();
    const outboxStore = new InMemoryOutboxStore();
    const emailGateStore = new InMemoryEmailGateStore(true);

    const deps: PublishNotificationDeps = {
      prefStore,
      notifStore,
      outboxStore,
      emailConfigStore: emailGateStore,
      channelRegistry: registry,
      templates: defaultTemplateRenderer,
      roleResolver: noopRoleResolver,
      clock: { now: () => 1_700_000_000_000 },
    };

    // Step 1: fanout (same as before)
    await publishNotificationEvent(deps, makeNotifEvent(), CTX);

    // Step 2: dispatch — email fails permanently, in_app succeeds
    const deliver = makeNotificationDeliver(registry);
    const result = await runOutboxOnce(
      outboxStore as unknown as PostgresOutboxStore,
      deliver,
      {
        batchLimit: 10,
        maxAttempts: 5,
        backoff: () => 0,
        perRowMaxAttempts,
      },
    );

    // in_app row dispatched, email row dead
    expect(result.dispatched, "in_app row must be dispatched").toBe(1);
    expect(result.dead, "email row must die on first attempt (immediate-dead)").toBe(1);
    expect(result.failed, "no rows must be in transient-failed state").toBe(0);

    // Verify the retried entry for email had maxAttempts=1 (immediate-dead override)
    const emailRetry = outboxStore.retried.find((r) => r.maxAttempts === 1);
    expect(emailRetry, "perRowMaxAttempts must have set maxAttempts=1 for email IMMEDIATE_DEAD row").toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-3 supplement: FF-NO-DELIVERY-AUDIT confirmed — deliver path has no audit writer
// (structural: makeNotificationDeliver takes only ChannelRegistry; no audit writer seam)
// ---------------------------------------------------------------------------

describe("FF-NO-DELIVERY-AUDIT structural: makeNotificationDeliver takes no audit writer", () => {
  it("makeNotificationDeliver signature accepts only ChannelRegistry — no audit seam", () => {
    // If makeNotificationDeliver accepted an audit writer parameter, this call
    // would need to supply one. The fact that it only takes a registry confirms
    // the deliver path has NO audit writer seam (FF-NO-DELIVERY-AUDIT).
    const deliver = makeNotificationDeliver(new Map([[inAppNoOpDriver.key, inAppNoOpDriver]]));
    expect(typeof deliver).toBe("function");
    // No audit assertion possible here by design — that's the point (FF-NO-DELIVERY-AUDIT)
  });
});
