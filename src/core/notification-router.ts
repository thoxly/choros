/**
 * src/core/notification-router.ts — T-0169 E-N.2
 *
 * Notifications routing: event → subscription → notification rows + outbox rows.
 * Implements ADR T-0120 §2.1 (pipeline), §2.5 (ChannelDriver/Map-реестр),
 * §2.6 (outbox T-0062 integration), §4.4 (contracts), §4.5 (fanout sequence).
 *
 * DESIGN INVARIANTS (ADR §2 / Fitness functions):
 *  - IO-FREE module: no pg/node:http/node:net/node:https/fetch imports (NF-3, FF-NO-ENV).
 *    All IO behind injected ports (deps: prefStore, notifStore, outboxStore, …).
 *  - No switch/enum on channel key in routing or deliver paths (FF-NO-SWITCH-CHANNEL).
 *    Routing uses driverMap.get(key) exclusively.
 *  - No new dispatcher/retry loop (FF-ONE-OUTBOX): delivery via existing runOutboxOnce T-0062.
 *  - NotificationEvent: one export interface. publishNotificationEvent: one export function.
 *  - No appendAuditEvent in delivery path (FF-NO-DELIVERY-AUDIT).
 *  - Fail-closed without tenantId: 0 INSERT/outbox (FF-FANOUT-FAILCLOSED).
 *  - SmtpSecretResolverPort structurally compatible with T-0025 SecretResolverPort.
 *  - DataClass imported from data-classification.ts, NOT redeclared.
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2/§4/§5 E-N.2.
 * Spec: docs/specs/T-0169-notifications-routing.spec.md.
 */

import { randomUUID } from "node:crypto";
import type { Deliver, DispatchResult } from "./outboxDispatcher.js";
import type { OutboxInsert, OutboxRow } from "./outboxTypes.js";
import type { Clock } from "./types.js";
// DataClass imported, NOT redeclared (NF-8 / T-0033).
import type { DataClass } from "./data-classification.js";

// Re-export DataClass for consumers that need it in notification context.
export type { DataClass };

// ---------------------------------------------------------------------------
// ObjectRef — opaque source handle (T-0015/T-0019 pattern; text-serializable)
// ---------------------------------------------------------------------------

/**
 * Opaque handle to the notification source (record/instance).
 * Stored as text in choros.notification.object_ref (nullable).
 * Carries NO object field values — identity only (T-0015 discipline).
 */
export interface ObjectRef {
  /** Resource kind: 'record' | 'instance' | 'application' | … (extensible vocab). */
  readonly kind: string;
  /** Identity within the tenant (UUID). */
  readonly id: string;
}

/** Serialize ObjectRef to the text column value. */
export function serializeObjectRef(ref: ObjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

// ---------------------------------------------------------------------------
// TenantCtx — minimal tenant context for delivery / driver calls
// ---------------------------------------------------------------------------

/**
 * Tenant context threaded through driver calls and fanout.
 * Provides the tenant identity without carrying raw credentials.
 */
export interface TenantCtx {
  readonly tenantId: string;
}

// ---------------------------------------------------------------------------
// NotificationEvent — transient source signal (ADR §2.1/§4.4)
// ONE export interface (FF-EVENT-CONTRACT).
// ---------------------------------------------------------------------------

/**
 * Normalized signal from a system component (process engine, SLA-watchdog, grant-layer).
 * NOT a table row — transient input to publishNotificationEvent.
 * SLA-watchdog / escalation engine (T-0095/E7) publish the SAME shape (AC-20 ADR).
 *
 * payload: ≤ 'internal' data-class — no raw object fields, no confidential/restricted data.
 */
export interface NotificationEvent {
  readonly eventKind: string;
  readonly tenantId: string;
  readonly subjectActorId: string;
  readonly objectRef: ObjectRef | null;
  readonly payload: Record<string, unknown>;  // ≤ internal data-class
  readonly occurredAt: number;                 // unix epoch ms
}

// ---------------------------------------------------------------------------
// ChannelDriver contract (ADR §2.5/§4.4)
// ---------------------------------------------------------------------------

export interface DeliveryJob {
  readonly tenantId: string;
  readonly recipientId: string;
  readonly eventKind: string;
  readonly title: string;
  readonly body: string;
  readonly objectRef: ObjectRef | null;
  readonly occurredAt: number;
}

export type DeliveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

/**
 * Contract for a notification delivery channel (ADR §2.5).
 * New channel = implement ONE interface + register in Map. Core does NOT change.
 * (FF-NO-SWITCH-CHANNEL: no switch/case on key anywhere in core.)
 *
 * ADR §2.5 base contract: `{ key: string; deliver(job, ctx): Promise<DeliveryResult> }`.
 *
 * E-N.2 delta (two optional flags added above the ADR §2.5 base — not in ADR text):
 *
 *   `requiresInAppRow` — replaces a channel-name string comparison that would
 *   violate FF-NO-SWITCH-CHANNEL.  The fanout reads this flag to decide whether
 *   to INSERT a choros.notification row; no driver key is ever compared in core.
 *   (in-app "delivery" = the INSERT itself, per ADR §2.1а.)
 *
 *   `requiresEmailConfig` — gates email delivery on email_channel_config.is_enabled
 *   (ADR §2.4: "email-if-configured").  Without this flag the core would need to
 *   compare channel keys to decide which channels to gate — another FF-NO-SWITCH-CHANNEL
 *   violation.  REQUIRED: any EmailChannelDriver implementation (E-N.3) MUST set
 *   `requiresEmailConfig: true`; omitting it skips the is_enabled gate entirely.
 */
export interface ChannelDriver {
  /** Stable channel key: 'in_app' | 'email' | 'telegram' | … */
  readonly key: string;
  /**
   * True if fanout must INSERT a choros.notification row before enqueuing
   * the outbox row (ADR §2.1а: in-app "delivery" = the INSERT itself).
   * Defaults to false for email/external channels.
   */
  readonly requiresInAppRow?: boolean;
  /**
   * True if fanout must gate delivery on email_channel_config.is_enabled
   * (ADR §2.4: "email-if-configured" — routing skips if is_enabled=false).
   * Defaults to false (no config gate for non-email channels).
   */
  readonly requiresEmailConfig?: boolean;
  deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult>;
}

/**
 * Channel registry — Map (NOT switch/enum in core). (FF-NO-SWITCH-CHANNEL / NF-6 / AC-6 ADR)
 * Adding a channel = new Driver + registration; core is unchanged.
 */
export type ChannelRegistry = ReadonlyMap<string, ChannelDriver>;

// ---------------------------------------------------------------------------
// SmtpSecretResolverPort — custody seam (ADR §4.4/§8; T-0025 RL-3 pattern)
// Structurally compatible with T-0025 SecretResolverPort (FF-RESOLVER-PORT).
// Day-1 = stub/direct-string. Stage-2 = real vault/env resolver injected here.
// ---------------------------------------------------------------------------

/**
 * Custody-seam for SMTP credential resolution (ADR §8 / T-0025 §8 pattern).
 * Structurally compatible with T-0025 SecretResolverPort (FF-RESOLVER-PORT / AC-9):
 *   { resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string> }
 * Day-1 = stub returning handle as-is (if valid shape) or throwing 'not_implemented'.
 * Stage-2 = real vault/env resolver behind same port; core/driver unchanged.
 * Platform does NOT resolve to raw secret except in the driver worker context.
 */
export interface SmtpSecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}

// ---------------------------------------------------------------------------
// in_app no-op driver (ADR §2.6 day-1)
// ---------------------------------------------------------------------------

/**
 * In-app delivery driver — day-1 no-op success.
 * The choros.notification row is already INSERTed during fanout (the "delivery"
 * for in-app = the INSERT itself). The outbox row exists for pipeline uniformity
 * and future push-notification readiness; day-1 driver just acknowledges success.
 * (ADR §2.6: "in_app-драйвер day-1 = no-op success")
 *
 * requiresInAppRow=true: fanout reads this flag and INSERTs the notification row
 * WITHOUT comparing the channel key by name (FF-NO-SWITCH-CHANNEL discipline).
 */
export const inAppNoOpDriver: ChannelDriver = {
  key: "in_app",
  requiresInAppRow: true,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  deliver(_job: DeliveryJob, _ctx: TenantCtx): Promise<DeliveryResult> {
    return Promise.resolve({ ok: true });
  },
};

// ---------------------------------------------------------------------------
// Notification preference row (from choros.notification_preference)
// ---------------------------------------------------------------------------

export interface NotificationPreference {
  readonly tenantId: string;
  readonly eventKind: string;
  readonly recipientScope: string;   // 'actor:<id>' | 'role:<id>' | 'object_owner' | 'escalation_chain'
  readonly channels: string[];        // ['in_app', 'email', …]
}

// ---------------------------------------------------------------------------
// Injected store ports (pure static-now; Postgres RLS DAOs land in T-0053)
// ---------------------------------------------------------------------------

/**
 * Reads active preferences for a (tenantId, eventKind) pair.
 * Returns an empty array when no preferences are configured.
 */
export interface NotificationPrefStore {
  getPreferences(tenantId: string, eventKind: string): Promise<NotificationPreference[]>;
}

/**
 * Minimal outbox enqueue port — delegates to pgOutboxStore.enqueueInTx.
 * The client carries the active Postgres transaction with the GUC set.
 */
export interface NotifOutboxEnqueuePort {
  enqueue(row: OutboxInsert): Promise<void>;
}

/**
 * Minimal notification INSERT port — inserts one choros.notification row.
 */
export interface NotifInsertPort {
  insert(row: NotifInsertRow): Promise<void>;
}

export interface NotifInsertRow {
  readonly tenantId: string;
  readonly id: string;
  readonly recipientId: string;
  readonly eventKind: string;
  readonly title: string;
  readonly body: string;
  readonly objectRef: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

/**
 * Minimal email channel config lookup port.
 * Returns null if no config row exists for the tenant.
 */
export interface EmailChannelConfigStore {
  getConfig(tenantId: string): Promise<{ isEnabled: boolean } | null>;
}

/**
 * Role resolver port — expands 'role:<id>' recipient_scope to concrete recipient IDs.
 * Other scope types ('actor:<id>', 'object_owner', 'escalation_chain') are resolved locally.
 */
export interface RoleResolverPort {
  resolveRole(tenantId: string, roleId: string): Promise<string[]>;
}

/**
 * Minimal template renderer port (full renderer is E-N.5; day-1 stub sufficient).
 */
export interface TemplateRendererPort {
  render(eventKind: string, payload: Record<string, unknown>): { title: string; body: string };
}

// ---------------------------------------------------------------------------
// Deps bundle for publishNotificationEvent (ADR §4.4)
// ---------------------------------------------------------------------------

export interface PublishNotificationDeps {
  readonly prefStore: NotificationPrefStore;
  readonly notifStore: NotifInsertPort;
  readonly outboxStore: NotifOutboxEnqueuePort;
  readonly emailConfigStore: EmailChannelConfigStore;
  readonly channelRegistry: ChannelRegistry;  // Map<key, ChannelDriver> (FF-NO-SWITCH-CHANNEL)
  readonly templates: TemplateRendererPort;
  readonly roleResolver: RoleResolverPort;
  readonly clock: Clock;
}

// ---------------------------------------------------------------------------
// publishNotificationEvent — THE SINGLE publishing function (ADR §4.4)
// ONE export function (FF-EVENT-CONTRACT / NF-6). No second publishing path.
// ---------------------------------------------------------------------------

/**
 * Fanout a NotificationEvent through active preferences to notification rows + outbox rows.
 *
 * Sequence (ADR §4.5):
 *  1. Tenant-gate fail-closed: empty tenantId → throw (FF-FANOUT-FAILCLOSED).
 *  2. Read notification_preference for (tenantId, eventKind).
 *  3. Expand each recipient_scope to concrete recipient_id[].
 *  4. Render title/body from template (payload ≤ internal).
 *  5. Per (recipient × channel from channels[]):
 *     - in_app → INSERT notification row + outbox row (no-op driver day-1).
 *     - email  → outbox row only (if email_channel_config.is_enabled=true).
 *  6. Does NOT write its own audit_event (FF-NO-DELIVERY-AUDIT; actor_event is
 *     the single ledger trace of the source action).
 *
 * Returns counts for observability.
 */
export async function publishNotificationEvent(
  deps: PublishNotificationDeps,
  ev: NotificationEvent,
  ctx: TenantCtx,
): Promise<{ inAppCreated: number; outboxEnqueued: number }> {
  // Step 1: tenant-gate fail-closed (FF-FANOUT-FAILCLOSED / AC-5)
  if (!ev.tenantId || !ctx.tenantId) {
    throw new Error("publishNotificationEvent: tenantId required (fail-closed)");
  }
  if (ev.tenantId !== ctx.tenantId) {
    throw new Error("publishNotificationEvent: tenantId mismatch (cross-tenant denied)");
  }

  const tenantId = ev.tenantId;

  // Step 2: read active preferences for (tenantId, eventKind)
  const prefs = await deps.prefStore.getPreferences(tenantId, ev.eventKind);
  if (prefs.length === 0) {
    return { inAppCreated: 0, outboxEnqueued: 0 };
  }

  // Step 4: render title/body (done once per event, reused per recipient/channel)
  const { title, body } = deps.templates.render(ev.eventKind, ev.payload);
  const objectRefText = ev.objectRef ? serializeObjectRef(ev.objectRef) : null;
  const now = deps.clock.now();

  let inAppCreated = 0;
  let outboxEnqueued = 0;

  // Email config is lazily fetched (at most once per event, only when needed)
  let emailEnabled: boolean | undefined;

  for (const pref of prefs) {
    // Step 3: expand recipient_scope → concrete recipient_id[]
    const recipients = await expandScope(pref.recipientScope, tenantId, ev, deps.roleResolver);

    for (const recipientId of recipients) {
      for (const channel of pref.channels) {
        // Look up the registered driver for this channel key — Map only, no switch/enum.
        // (FF-NO-SWITCH-CHANNEL: routing by registry.get, NOT by channel-name comparison)
        const driver = deps.channelRegistry.get(channel);

        if (!driver) {
          // No driver registered yet (e.g. 'telegram' before E-N.x) — skip silently.
          continue;
        }

        // Check driver capability flag: does this channel require an in-app row INSERT?
        // (ADR §2.1а: in_app INSERT triggered by driver.requiresInAppRow, NOT by key comparison)
        if (driver.requiresInAppRow) {
          // INSERT notification row (the in-app "delivery" = the INSERT itself)
          const notifId = randomUUID();
          await deps.notifStore.insert({
            tenantId,
            id: notifId,
            recipientId,
            eventKind: ev.eventKind,
            title,
            body,
            objectRef: objectRefText,
            createdAt: now,
            expiresAt: null,
          });
          inAppCreated += 1;

          // Outbox row for in-app channel (pipeline uniformity + future push; day-1 driver = no-op)
          await deps.outboxStore.enqueue({
            aggregateKind: "notification",
            aggregateId: notifId,
            eventType: ev.eventKind,
            payload: {
              channel,
              recipientId,
              title,
              body,
              objectRef: ev.objectRef ?? null,
              occurredAt: ev.occurredAt,
            },
            idempotencyKey: `notif:${notifId}:${channel}`,
          });
          outboxEnqueued += 1;
        } else {
          // External channel (email, telegram, webhook, …): outbox row only.
          // For email specifically, check is_enabled via config store (ADR §2.4).
          // The check is triggered by the driver exposing a `requiresEmailConfig` flag,
          // or more simply: all non-in_app channels may be config-gated.
          // Day-1: email config gate is the only external gate; others are always-on.
          // We gate on requiresEmailConfig flag to avoid channel-name comparison.
          if (driver.requiresEmailConfig) {
            // Lazy fetch email config (once per event)
            if (emailEnabled === undefined) {
              const cfg = await deps.emailConfigStore.getConfig(tenantId);
              emailEnabled = cfg?.isEnabled ?? false;
            }
            // Skip if channel not configured/enabled (ADR §2.4 "email-if-configured")
            if (!emailEnabled) {
              continue;
            }
          }

          // Outbox row for external channel delivery
          const deliveryId = randomUUID();
          await deps.outboxStore.enqueue({
            aggregateKind: "notification",
            aggregateId: deliveryId,
            eventType: ev.eventKind,
            payload: {
              channel,
              recipientId,
              title,
              body,
              objectRef: ev.objectRef ?? null,
              occurredAt: ev.occurredAt,
            },
            idempotencyKey: `notif:${deliveryId}:${channel}`,
          });
          outboxEnqueued += 1;
        }
      }
    }
  }

  return { inAppCreated, outboxEnqueued };
}

// ---------------------------------------------------------------------------
// Scope expansion (ADR §2.4 recipient_scope vocab)
// ---------------------------------------------------------------------------

/**
 * Expand a recipient_scope string to a list of concrete recipient employee IDs.
 * Vocab (ADR §2.4):
 *  - 'actor:<id>'        → [id] (specific employee)
 *  - 'role:<id>'         → role-resolver expansion (T-0018)
 *  - 'object_owner'      → [subjectActorId] (owner of the event object; day-1 approx)
 *  - 'escalation_chain'  → [] (day-1 empty hook; T-0095/E7 fills this later)
 */
async function expandScope(
  scope: string,
  tenantId: string,
  ev: NotificationEvent,
  roleResolver: RoleResolverPort,
): Promise<string[]> {
  if (scope.startsWith("actor:")) {
    const id = scope.slice("actor:".length);
    return id ? [id] : [];
  }

  if (scope.startsWith("role:")) {
    const roleId = scope.slice("role:".length);
    if (!roleId) return [];
    return roleResolver.resolveRole(tenantId, roleId);
  }

  if (scope === "object_owner") {
    // Day-1: the subject actor is the closest approximation of the object owner.
    // T-0095/E7 will supply a proper owner resolver when needed.
    return ev.subjectActorId ? [ev.subjectActorId] : [];
  }

  if (scope === "escalation_chain") {
    // Day-1: empty hook — escalation chain resolution is Stage-2 / T-0095.
    return [];
  }

  // Unknown scope — fail-closed: no recipients (log-worthy but not crash).
  return [];
}

// ---------------------------------------------------------------------------
// makeNotificationDeliver — notification-specific Deliver for runOutboxOnce (T-0062)
// ADR §2.6/§4.4: distributes by payload.channel via Map, NO switch/enum.
// (FF-NO-SWITCH-CHANNEL / FF-ONE-OUTBOX)
// ---------------------------------------------------------------------------

/**
 * Prefix appended to `DispatchResult.error` when a delivery fails with
 * `retryable: false` (unknown channel, malformed payload, or driver returning
 * a permanent-failure result).
 *
 * ACTUAL SEMANTICS (as wired today — E-N.2 scope, pending E-N.3 wiring):
 *   T-0062's `runOutboxOnce` does NOT parse this prefix.  A row whose deliver()
 *   returns `{ok:false, error: "IMMEDIATE_DEAD:…"}` enters the normal back-off
 *   cycle and is retried until `opts.maxAttempts` is exhausted, at which point
 *   the row transitions to `state='dead'`.
 *
 * INTENDED SEMANTICS (target, to be realised in E-N.3 wiring):
 *   The lifecycle-bridge must either (a) compose `makeNotificationDeliver` with a
 *   dispatcher-instance whose `maxAttempts=1`, so the row dies on first attempt,
 *   OR (b) extend `runOutboxOnce` with a per-row maxAttempts override that reads
 *   this prefix and calls `markRetry(id, 0)` directly.
 *
 * TODO E-N.3: implement immediate-dead shortcut; until then `retryable:false`
 * rows use the shared `opts.maxAttempts` ceiling.
 */
export const IMMEDIATE_DEAD_ERROR_PREFIX = "IMMEDIATE_DEAD:";

/**
 * Build the notification-specific Deliver function to inject into runOutboxOnce.
 *
 * Dispatching logic (ADR §2.6 / §4.4):
 *  - row.aggregateKind !== 'notification' → {ok:true} (idempotent pass-through for other kinds)
 *  - payload.channel → registry.get(channel) → driver.deliver(job, ctx)
 *  - {ok:true} → {ok:true}
 *  - {ok:false, retryable:true} → {ok:false, error} → markRetry (back-off)
 *  - {ok:false, retryable:false} → immediate-dead: error prefixed with IMMEDIATE_DEAD_ERROR_PREFIX
 *    → caller wires to markRetry with maxAttempts=0 → state='dead'
 *
 * No switch/enum on channel: routing via driverMap.get(key) only (FF-NO-SWITCH-CHANNEL).
 * No appendAuditEvent in delivery path (FF-NO-DELIVERY-AUDIT).
 */
export function makeNotificationDeliver(registry: ChannelRegistry): Deliver {
  return async function notificationDeliver(row: OutboxRow): Promise<DispatchResult> {
    // Pass-through non-notification rows (pipeline polymorphism, ADR §2.6)
    if (row.aggregateKind !== "notification") {
      return { ok: true, idempotentSuccess: true };
    }

    const channel = row.payload["channel"];
    if (typeof channel !== "string") {
      // Malformed payload: dead immediately (non-retryable structural error)
      return {
        ok: false,
        error: `${IMMEDIATE_DEAD_ERROR_PREFIX}notification outbox row missing payload.channel`,
      };
    }

    // Map-based routing — NO switch/enum (FF-NO-SWITCH-CHANNEL)
    const driver = registry.get(channel);
    if (!driver) {
      // Unknown channel: dead immediately (no registered driver = non-retryable)
      return {
        ok: false,
        error: `${IMMEDIATE_DEAD_ERROR_PREFIX}no ChannelDriver registered for channel '${channel}'`,
      };
    }

    const tenantId = row.tenantId;
    const ctx: TenantCtx = { tenantId };

    const job: DeliveryJob = {
      tenantId,
      recipientId: String(row.payload["recipientId"] ?? ""),
      eventKind: row.eventType,
      title: String(row.payload["title"] ?? ""),
      body: String(row.payload["body"] ?? ""),
      objectRef: decodeObjectRef(row.payload["objectRef"]),
      occurredAt: Number(row.payload["occurredAt"] ?? row.createdAt),
    };

    let result: DeliveryResult;
    try {
      result = await driver.deliver(job, ctx);
    } catch (err) {
      // Unexpected exception from driver: retryable (transient network error pattern)
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `driver exception: ${message}` };
    }

    if (result.ok) {
      return { ok: true };
    }

    if (result.retryable) {
      // Retryable failure: back-off retry via markRetry (ADR §2.6)
      return { ok: false, error: result.reason };
    }

    // Non-retryable: immediate-dead (ADR §2.6: maxAttempts=0 semantics)
    return {
      ok: false,
      error: `${IMMEDIATE_DEAD_ERROR_PREFIX}${result.reason}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode an objectRef from outbox payload (may be serialized or null). */
function decodeObjectRef(value: unknown): ObjectRef | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v["kind"] === "string" && typeof v["id"] === "string") {
      return { kind: v["kind"], id: v["id"] };
    }
  }
  // Try text 'kind:id' format
  if (typeof value === "string") {
    const idx = value.indexOf(":");
    if (idx > 0) {
      return { kind: value.slice(0, idx), id: value.slice(idx + 1) };
    }
  }
  return null;
}
