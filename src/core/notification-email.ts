/**
 * src/core/notification-email.ts — T-0170 E-N.3
 *
 * Notifications E-N.3: EmailChannelDriver + RL-3 smtp_handle custody +
 * email_channel_config CRUD + wiring exports.
 *
 * DESIGN INVARIANTS:
 *  - Pure-core: NO pg/node:http/node:net/node:https/fetch imports (NF-7).
 *    All IO behind injected ports (SmtpSenderPort, EmailConfigWritePort, AuditWriter).
 *  - RL-3 shape-guard (T-0025): validateSecretHandleShape + redactHandle imported,
 *    not redeclared (FF-HANDLE-SHAPE).
 *  - Raw SMTP secret NEVER in log/audit/exception/API response (FF-NO-RAW-SMTP).
 *    appendAuditEvent payload carries from_address/smtp_host only.
 *  - requiresEmailConfig=true REQUIRED on EmailChannelDriver (T-0169 jsdoc contract).
 *  - Immediate-dead semantics: retryable:false → IMMEDIATE_DEAD_ERROR_PREFIX error
 *    in makeNotificationDeliver (T-0169); lifecycle-bridge wiring uses perRowMaxAttempts
 *    to force maxAttempts=1 for IMMEDIATE_DEAD rows (row dies on first attempt, AC-13/FR-8).
 *  - No appendAuditEvent in deliver path (FF-NO-DELIVERY-AUDIT).
 *  - DataClass imported from data-classification.ts, NOT redeclared (FF-EGRESS-CLASS).
 *  - No new setInterval/startEmailDispatcher (FF-ONE-OUTBOX).
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2.3/§2.6/§2.8/§4.2/§4.4/§8.
 * Spec: docs/specs/T-0170-notifications-email.spec.md.
 */

import { randomUUID } from "node:crypto";

// RL-3 custody — imported, NOT redeclared (T-0025)
import {
  validateSecretHandleShape,
  redactHandle,
  type SecretResolverPort,
} from "./secret-handle-validator.js";

// Notification types from T-0169 (imports, NOT redeclarations)
import type {
  ChannelDriver,
  DeliveryJob,
  DeliveryResult,
  TenantCtx,
  SmtpSecretResolverPort,
} from "./notification-router.js";

// DataClass imported, NOT redeclared (T-0033 / FF-EGRESS-CLASS)
import type { DataClass } from "./data-classification.js";

// Audit types
import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";

// SMTP adapter (injected port — this module stays pure-core)
import type { SmtpSenderPort, SmtpSendError } from "../adapters/smtp-sender.js";

// Re-export DataClass so callers importing from notification-email.ts have it.
export type { DataClass };

// ---------------------------------------------------------------------------
// EmailChannelConfig — domain record mirroring choros.email_channel_config
// ---------------------------------------------------------------------------

/**
 * Domain record for email channel configuration.
 * Mirrors choros.email_channel_config (migration 047).
 * smtp_handle = opaque RL-3 handle (T-0025 — NOT a raw secret).
 */
export interface EmailChannelConfig {
  readonly tenantId: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpTls: boolean;
  readonly fromAddress: string;
  readonly fromName: string | null;
  /** Opaque RL-3 handle to SMTP credential (T-0025). NOT a raw secret. */
  readonly smtpHandle: string;
  readonly isEnabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

/**
 * Input for set/update operations — from_address/from_name/smtp fields.
 * smtpHandle MUST pass validateSecretHandleShape (RL-3 shape-guard).
 */
export interface EmailChannelConfigInput {
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpTls: boolean;
  readonly fromAddress: string;
  readonly fromName?: string | null;
  /** Opaque RL-3 handle — must pass validateSecretHandleShape. */
  readonly smtpHandle: string;
  readonly isEnabled: boolean;
  /** Actor performing the operation (for audit). */
  readonly updatedBy: string;
}

/**
 * Status view returned by getEmailChannelConfigStatus.
 * smtp_handle is REDACTED via redactHandle — never raw (FF-NO-RAW-SMTP).
 */
export interface EmailChannelConfigStatus {
  readonly tenantId: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpTls: boolean;
  readonly fromAddress: string;
  readonly fromName: string | null;
  /** Redacted handle for status view — never the raw handle. */
  readonly handleRedacted: string;
  readonly isEnabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Ports for email config CRUD
// ---------------------------------------------------------------------------

/**
 * Write port for email_channel_config table.
 * Implemented by a Postgres DAO (T-0053 / live-impl). In tests: fake.
 */
export interface EmailConfigWritePort {
  upsert(config: EmailChannelConfig): Promise<void>;
  delete(tenantId: string): Promise<boolean>;
  get(tenantId: string): Promise<EmailChannelConfig | null>;
}

// ---------------------------------------------------------------------------
// setEmailChannelConfig result
// ---------------------------------------------------------------------------

export type SetEmailConfigResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// setEmailChannelConfig — RL-3 shape-guard + upsert + audit
// ---------------------------------------------------------------------------

/**
 * Set (create or update) the email channel configuration for a tenant.
 *
 * RL-3 discipline (FF-HANDLE-SHAPE / ADR §2.3):
 *  - Calls validateSecretHandleShape on smtpHandle BEFORE any DB write.
 *  - Raw sk-prefix/bare-hex-32+/JWT → {ok:false, reason}. No write, no audit.
 *  - Valid opaque handle → upsert to choros.email_channel_config.
 *
 * Audit (FF-AUDIT-CONFIG-ONLY / ADR §2.8):
 *  - appendAuditEvent type='notif.email_config.set' with from_address/smtp_host.
 *  - NEVER includes smtpHandle or resolved secret in audit payload.
 *
 * @param deps.configStore  write port for email_channel_config table
 * @param deps.auditWriter  canonical audit writer (T-0016)
 * @param deps.tx           pg client in the caller's tenant transaction
 * @param deps.clock        clock.now() → epoch ms
 * @param tenantId          tenant being configured
 * @param input             config input (smtpHandle must pass shape-guard)
 */
export async function setEmailChannelConfig(
  deps: {
    configStore: EmailConfigWritePort;
    auditWriter: AuditWriter;
    tx: PgClientLike;
    clock: { now: () => number };
  },
  tenantId: string,
  input: EmailChannelConfigInput,
): Promise<SetEmailConfigResult> {
  // RL-3 shape-guard (FF-HANDLE-SHAPE): validateSecretHandleShape before write
  const verdict = validateSecretHandleShape(input.smtpHandle);
  if (!verdict.ok) {
    return { ok: false, reason: `smtp_handle rejected: ${verdict.reason}` };
  }

  const now = deps.clock.now();

  const config: EmailChannelConfig = {
    tenantId,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpTls: input.smtpTls,
    fromAddress: input.fromAddress,
    fromName: input.fromName ?? null,
    smtpHandle: input.smtpHandle,  // stored as-is (opaque RL-3 handle)
    isEnabled: input.isEnabled,
    updatedBy: input.updatedBy,
    updatedAt: now,
  };

  await deps.configStore.upsert(config);

  // Audit: notif.email_config.set — NO smtpHandle in payload (FF-NO-RAW-SMTP)
  const auditInput: AuditEventInput = {
    id: randomUUID(),
    type: "notif.email_config.set",
    actor: input.updatedBy,
    subject: tenantId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      smtp_host: input.smtpHost,
      smtp_port: input.smtpPort,
      smtp_tls: input.smtpTls,
      from_address: input.fromAddress,
      from_name: input.fromName ?? null,
      is_enabled: input.isEnabled,
      // smtp_handle intentionally ABSENT — FF-NO-RAW-SMTP / ADR §2.8
    },
    occurred_at: now,
  };
  await deps.auditWriter.appendAuditEvent(deps.tx, auditInput);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// revokeEmailChannelConfig — revoke + audit
// ---------------------------------------------------------------------------

/**
 * Revoke (delete) the email channel configuration for a tenant.
 * Emits audit event notif.email_config.revoke.
 * Returns {ok:false, reason:'not_found'} if no config exists.
 */
export async function revokeEmailChannelConfig(
  deps: {
    configStore: EmailConfigWritePort;
    auditWriter: AuditWriter;
    tx: PgClientLike;
    clock: { now: () => number };
  },
  tenantId: string,
  actor: string,
): Promise<SetEmailConfigResult> {
  const deleted = await deps.configStore.delete(tenantId);
  if (!deleted) {
    return { ok: false, reason: "not_found" };
  }

  const now = deps.clock.now();
  const auditInput: AuditEventInput = {
    id: randomUUID(),
    type: "notif.email_config.revoke",
    actor,
    subject: tenantId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      // Only actor/tenant in revoke — no config data needed
    },
    occurred_at: now,
  };
  await deps.auditWriter.appendAuditEvent(deps.tx, auditInput);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// getEmailChannelConfigStatus — status view with redacted handle
// ---------------------------------------------------------------------------

/**
 * Returns the email channel config status with smtp_handle REDACTED.
 * Returns null if no config exists for the tenant.
 *
 * FF-NO-RAW-SMTP: handleRedacted = redactHandle(smtp_handle), never the raw handle.
 */
export async function getEmailChannelConfigStatus(
  configStore: EmailConfigWritePort,
  tenantId: string,
): Promise<EmailChannelConfigStatus | null> {
  const config = await configStore.get(tenantId);
  if (config === null) return null;

  return {
    tenantId: config.tenantId,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpTls: config.smtpTls,
    fromAddress: config.fromAddress,
    fromName: config.fromName,
    // redactHandle — FF-NO-RAW-SMTP / ADR §2.3 (never the raw smtpHandle)
    handleRedacted: redactHandle(config.smtpHandle),
    isEnabled: config.isEnabled,
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// EmailChannelDriver — ChannelDriver for email (ADR §2.5/§4.4)
// ---------------------------------------------------------------------------

/**
 * Email channel driver. Implements ChannelDriver (T-0169).
 *
 * REQUIRED flags (T-0169 jsdoc contract):
 *  - requiresEmailConfig=true: fanout gates delivery on email_channel_config.is_enabled.
 *  - key='email': registry key.
 *
 * Delivery sequence:
 *  1. Fail-closed without tenantId (FF-FANOUT-FAILCLOSED).
 *  2. Load email_channel_config (is_enabled should be true — fanout gates, but
 *     driver also defensively checks to avoid delivery when disabled).
 *  3. Resolve smtp_handle via SmtpSecretResolverPort (in worker context only).
 *  4. Send via SmtpSenderPort (injected — no direct SMTP in tests).
 *  5. Return DeliveryResult; resolved secret stays inside this method.
 *
 * Raw secret NEVER leaves deliver(): not in return value, not in error.reason,
 * not in logs (FF-NO-RAW-SMTP).
 * No appendAuditEvent in this path (FF-NO-DELIVERY-AUDIT / ADR §2.8).
 */
export class EmailChannelDriver implements ChannelDriver {
  /** Stable channel key. */
  readonly key = "email" as const;

  /**
   * REQUIRED: gates fanout on email_channel_config.is_enabled (T-0169 delta).
   * Without this flag the fanout core would need to compare channel keys —
   * a FF-NO-SWITCH-CHANNEL violation.
   */
  readonly requiresEmailConfig = true as const;

  constructor(
    private readonly configStore: EmailConfigWritePort,
    private readonly secretResolver: SmtpSecretResolverPort,
    private readonly smtpSender: SmtpSenderPort,
  ) {}

  async deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult> {
    // 1. Fail-closed: no tenant context (FF-FANOUT-FAILCLOSED)
    if (!ctx.tenantId) {
      return {
        ok: false,
        retryable: false,
        reason: "no_tenant_context",
      };
    }

    // 2. Load email_channel_config (defensive check even though fanout gates on is_enabled)
    let config: EmailChannelConfig | null;
    try {
      config = await this.configStore.get(ctx.tenantId);
    } catch (err) {
      // Config read error → retryable (transient DB issue)
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, retryable: true, reason: `config_load_error: ${msg}` };
    }

    if (config === null) {
      // No config for tenant — non-retryable: channel not configured
      return { ok: false, retryable: false, reason: "email_not_configured" };
    }

    if (!config.isEnabled) {
      // Channel disabled — non-retryable for this delivery attempt
      return { ok: false, retryable: false, reason: "email_channel_disabled" };
    }

    // 3. Resolve smtp_handle → raw secret (in worker context only).
    //    Raw secret stays inside this scope — never propagated (FF-NO-RAW-SMTP).
    let resolvedSecret: string;
    try {
      resolvedSecret = await this.secretResolver.resolveSecret(
        config.smtpHandle,
        { tenantId: ctx.tenantId },
      );
    } catch (err) {
      // Secret resolution error → retryable (transient resolver issue)
      // DO NOT include resolved secret or smtpHandle in error reason (FF-NO-RAW-SMTP)
      return { ok: false, retryable: true, reason: "secret_resolution_error" };
    }

    // 4. Format From header (ADR §2.3 / FF-EMAIL-FROM-CLIENT)
    const from = config.fromName
      ? `${config.fromName} <${config.fromAddress}>`
      : config.fromAddress;

    // 5. Send via SMTP adapter (injected port — no real network in tests)
    try {
      await this.smtpSender.sendEmail({
        host: config.smtpHost,
        port: config.smtpPort,
        tls: config.smtpTls,
        authUser: config.fromAddress,   // from_address as SMTP login (day-1 convention)
        authPass: resolvedSecret,        // resolved only here, not propagated
        from,
        to: job.recipientId,            // day-1: recipientId = email address
        subject: job.title,
        text: job.body,
        timeoutMs: 30_000,
      });

      // Secret is done — cleared from scope naturally (JS GC)
      return { ok: true };
    } catch (err) {
      // SmtpSendError carries retryable flag (src/adapters/smtp-sender.ts)
      if (isSmtpSendError(err)) {
        // DO NOT include authPass/smtpHandle/resolvedSecret in reason (FF-NO-RAW-SMTP)
        return {
          ok: false,
          retryable: err.retryable,
          reason: err.retryable ? "smtp_transient_error" : "smtp_permanent_error",
        };
      }
      // Unknown exception → retryable (transient network pattern)
      return { ok: false, retryable: true, reason: "smtp_send_exception" };
    }
  }
}

/** Type guard for SmtpSendError (avoids circular import by duck-typing). */
function isSmtpSendError(err: unknown): err is { retryable: boolean; message: string } {
  return (
    err instanceof Error &&
    err.constructor.name === "SmtpSendError" &&
    "retryable" in err &&
    typeof (err as { retryable: unknown }).retryable === "boolean"
  );
}

// ---------------------------------------------------------------------------
// makeDirectStringSmtpResolver — day-1 stub resolver (ADR §8)
// ---------------------------------------------------------------------------

/**
 * Day-1 SmtpSecretResolverPort implementation (ADR §8):
 * Returns the handle as-is if it passed the shape-guard (i.e. it is already a
 * usable password/app-token that the client stored directly in the handle field,
 * knowing it does not look like a vendor key).
 * Stage-2 = real vault/env resolver injected behind the same port.
 *
 * Structurally compatible with T-0025 SecretResolverPort (FF-RESOLVER-PORT):
 *   { resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string> }
 */
export const makeDirectStringSmtpResolver = (): SmtpSecretResolverPort => ({
  async resolveSecret(handle: string, _ctx: { tenantId: string }): Promise<string> {
    // Day-1: treat the handle as the raw credential (client stored it directly,
    // it passed the shape-guard, so it is not a known vendor key pattern).
    return handle;
  },
});

// Verify structural compatibility with T-0025 SecretResolverPort at compile time.
// This assignment is never called; it is a compile-time assertion only.
// (FF-RESOLVER-PORT: SmtpSecretResolverPort ↔ SecretResolverPort compatible under tsc)
declare function _assertResolverCompat(p: SmtpSecretResolverPort): SecretResolverPort;
// The above declaration is INTENTIONALLY unused — it is a compile-time type check only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _resolverCompatCheck: typeof _assertResolverCompat = (p) => p as SecretResolverPort;
