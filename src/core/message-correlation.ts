/**
 * src/core/message-correlation.ts — T-0459 [D8-R4]: message/signal events (PD-23).
 *
 * Pure correlation engine. NO DB, NO IO, NO network, NO Flowable client. The
 * impure surfaces (delivery into the engine, the inbox projection, the throw
 * invoke-grant) live in src/http/process-projection.ts + the invoke seam and
 * call THESE pure functions for the actual decisions.
 *
 * PRINCIPLE (spec §3.5): a message is NOT a second transport. A message is a
 * correlation envelope:
 *
 *     { tenant, messageName, correlationKey, payload, source }
 *
 * correlation is by a BUSINESS KEY taken from a record field (бесшовность built
 * into the correlation), NOT by an opaque Flowable token id. A waiting
 * message-catch declares WHICH record field supplies its correlation key; an
 * inbound envelope carries the concrete key value. They correlate iff:
 *
 *   1. SAME TENANT — `envelope.tenant === subscription.tenant`. A message for the
 *      wrong / unknown tenant is REJECTED, never delivered cross-tenant
 *      (TENANT-FAIL-CLOSED; tenancy §9 «fail-closed in async/background»).
 *   2. SAME messageName (or signalName for a broadcast signal).
 *   3. The envelope's correlationKey EQUALS the subscription's correlationKey
 *      (the value read from the named record field).
 *
 * v1 SOURCES (spec §3.5): "external-human" (T-0122 token surface — a counterparty
 * signs/uploads against a record→instance) and "internal-signal" (a status change
 * broadcasts within a tenant by signal-name). The connector-PULL polling driver is
 * Stage-2: `CONNECTOR_PULL_SEAM` documents the clean seam; we do NOT build the poller.
 *
 * THROW (spec §3.5): a throw message = an invoke-grant on an effect_resource
 * (messaging_channel) — `buildThrowEffectDeclaration` maps a throw config to the
 * EffectDeclaration the invoke gateway (T-0034 verifyEffectGrants) checks. Pure;
 * the actual invoke happens at the call-site behind a held grant.
 */

import {
  verifyEffectGrants,
  type EffectDeclaration,
  type EffectSource,
} from "./effect-resource.js";
import type { Grant } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Source vocabulary (closed set — fail-closed on anything else, FR-3 style).
// ---------------------------------------------------------------------------

/**
 * The v1 transport sources a message envelope can originate from.
 *  - "external-human"   — T-0122 token surface (counterparty signs/uploads).
 *  - "internal-signal"  — a status change / another process, broadcast within tenant.
 *  - "connector-pull"   — Stage-2 polling driver (SEAM ONLY in v1; never produced yet).
 */
export type MessageSource = "external-human" | "internal-signal" | "connector-pull";

const MESSAGE_SOURCES = new Set<MessageSource>([
  "external-human",
  "internal-signal",
  "connector-pull",
]);

/** Total predicate: is `value` a known message source? */
export function isMessageSource(value: unknown): value is MessageSource {
  return typeof value === "string" && MESSAGE_SOURCES.has(value as MessageSource);
}

/**
 * CONNECTOR-PULL SEAM (Stage-2, spec §3.5 / §5).
 *
 * The polling driver (opros внешней системы — coннектор T-0128) is NOT built in
 * v1. When it lands it will: poll an external system, build a MessageEnvelope with
 * source="connector-pull", and feed it through the SAME correlateEnvelope() +
 * delivery path as the other two sources — no new branch in the engine, only a new
 * PRODUCER. This constant marks that seam so a sibling Stage-2 task knows exactly
 * where to plug in (and so a grep for the seam finds one anchor, not a scatter).
 */
export const CONNECTOR_PULL_SEAM = "connector-pull:stage-2" as const;

// ---------------------------------------------------------------------------
// Envelope + subscription shapes (the frozen correlation contract).
// ---------------------------------------------------------------------------

/**
 * A message envelope — the ONLY thing that crosses the message boundary. Carries
 * no record-identity object (no registryId/recordId payload), just the business
 * correlation key + an opaque payload bag. (The linter's raw-object guard still
 * applies to anything serialised into the BPMN.)
 */
export interface MessageEnvelope {
  /** Tenant the envelope is addressed to. Cross-tenant delivery is rejected. */
  readonly tenant: string;
  /** Message name (or signal name) — must equal the waiting catch's messageName. */
  readonly messageName: string;
  /**
   * The business correlation key value — taken from a record field at the source
   * (e.g. the «номер договора» the counterparty signed against). Correlates against
   * the subscription's correlationKey (read from its named record field).
   */
  readonly correlationKey: string;
  /** Opaque payload bag (e.g. the signed document ref, the new status). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Where this envelope came from (closed vocabulary). */
  readonly source: MessageSource;
}

/**
 * A waiting message-catch subscription — what a process instance that is parked on
 * a receiveTask / intermediateCatchEvent(message|signal) is waiting for. Built from
 * the BPMN element config (messageName + correlationField) resolved against the
 * instance's bound record (the field value becomes correlationKey).
 */
export interface MessageSubscription {
  /** Flowable process-instance id parked on the catch. */
  readonly inst: string;
  /** Tenant the instance belongs to. */
  readonly tenant: string;
  /** The message/signal name the catch is waiting for. */
  readonly messageName: string;
  /**
   * The concrete correlation key for THIS instance — the value of the record field
   * named by the element's correlationField, resolved when the instance parked.
   */
  readonly correlationKey: string;
  /**
   * Whether this is a broadcast signal (delivered to ALL matching subscriptions in
   * the tenant) vs a message (point-to-point, delivered to the single match). Signals
   * still respect the tenant + key gate — broadcast is WITHIN one tenant only.
   */
  readonly broadcast: boolean;
}

// ---------------------------------------------------------------------------
// Validation — fail-closed envelope shape guard.
// ---------------------------------------------------------------------------

/** Result of validating an inbound envelope shape. */
export type EnvelopeValidation =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; reason: string };

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate + normalise a raw inbound envelope. Fail-closed: any missing/empty
 * required field, an unknown source, or a non-object payload rejects the envelope
 * (returns ok:false) — a malformed message is NEVER delivered. Pure.
 */
export function validateEnvelope(raw: unknown): EnvelopeValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "envelope must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;

  if (!nonEmptyString(o["tenant"])) {
    return { ok: false, reason: "envelope.tenant is required (non-empty string)" };
  }
  if (!nonEmptyString(o["messageName"])) {
    return { ok: false, reason: "envelope.messageName is required (non-empty string)" };
  }
  if (!nonEmptyString(o["correlationKey"])) {
    return { ok: false, reason: "envelope.correlationKey is required (non-empty string)" };
  }
  if (!isMessageSource(o["source"])) {
    return { ok: false, reason: "envelope.source must be one of external-human | internal-signal | connector-pull" };
  }
  const payload = o["payload"];
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    return { ok: false, reason: "envelope.payload must be a JSON object when present" };
  }

  return {
    ok: true,
    envelope: {
      tenant: (o["tenant"] as string).trim(),
      messageName: (o["messageName"] as string).trim(),
      correlationKey: (o["correlationKey"] as string).trim(),
      payload: (payload as Record<string, unknown>) ?? {},
      source: o["source"] as MessageSource,
    },
  };
}

// ---------------------------------------------------------------------------
// Correlation — the heart. Tenant-fail-closed.
// ---------------------------------------------------------------------------

/** Why a single subscription did not correlate (for honest diagnostics/tests). */
export type CorrelationMiss =
  | "wrong-tenant"
  | "wrong-message-name"
  | "wrong-correlation-key";

/** Outcome for ONE subscription against ONE envelope. */
export type CorrelationDecision =
  | { matched: true }
  | { matched: false; miss: CorrelationMiss };

/**
 * Decide whether a single subscription correlates with an envelope.
 *
 * TENANT-FAIL-CLOSED IS FIRST AND ABSOLUTE: a tenant mismatch returns
 * matched:false BEFORE any name/key comparison. There is no code path by which an
 * envelope for tenant B reaches an instance in tenant A. Pure.
 */
export function correlateOne(
  envelope: MessageEnvelope,
  sub: MessageSubscription,
): CorrelationDecision {
  // 1. TENANT GATE — absolute, first, no exceptions. Cross-tenant = reject.
  if (envelope.tenant !== sub.tenant) {
    return { matched: false, miss: "wrong-tenant" };
  }
  // 2. Message/signal name must match.
  if (envelope.messageName !== sub.messageName) {
    return { matched: false, miss: "wrong-message-name" };
  }
  // 3. Business correlation key (record-field value) must be equal.
  if (envelope.correlationKey !== sub.correlationKey) {
    return { matched: false, miss: "wrong-correlation-key" };
  }
  return { matched: true };
}

/** The result of correlating an envelope against a set of subscriptions. */
export interface CorrelationResult {
  /** true iff ≥1 subscription matched (and thus the message can fire). */
  readonly delivered: boolean;
  /**
   * The instance ids the catch fires for. For a message (point-to-point) this is at
   * most one (the FIRST in-tenant match); for a broadcast signal it is EVERY matching
   * in-tenant subscription. Empty when nothing correlated.
   */
  readonly firedInstances: readonly string[];
  /**
   * True iff the envelope was rejected purely on the tenant gate against every
   * candidate (i.e. there WAS a name+key match but only in another tenant). Lets the
   * delivery seam log a tenant-fail-closed rejection distinctly from "no such
   * subscription". Never causes cross-tenant delivery either way.
   */
  readonly tenantRejected: boolean;
}

/**
 * Correlate an envelope against a candidate subscription set and return which
 * instances the catch fires for.
 *
 * Behaviour:
 *  - MESSAGE (point-to-point): the FIRST subscription that fully matches fires
 *    (Flowable message correlation is single-target). If a name+key match exists
 *    only in a DIFFERENT tenant, nothing fires and tenantRejected=true.
 *  - SIGNAL (broadcast): EVERY matching subscription in the SAME tenant fires.
 *    Broadcast is bounded to the envelope's tenant — never cross-tenant.
 *
 * The `broadcast` flag is read off the matched subscription(s): a signal-catch
 * declares broadcast=true. Mixed sets are handled per-subscription (a message-catch
 * in the set still fires single-target).
 *
 * Pure: no IO. The caller (process-projection delivery seam) takes firedInstances
 * and signals the live engine + emits the inbox advance projection.
 */
export function correlateEnvelope(
  envelope: MessageEnvelope,
  subscriptions: readonly MessageSubscription[],
): CorrelationResult {
  const fired: string[] = [];
  let sawCrossTenantNameKeyMatch = false;

  for (const sub of subscriptions) {
    const decision = correlateOne(envelope, sub);
    if (decision.matched) {
      fired.push(sub.inst);
      // A point-to-point message stops at the first match; a broadcast signal keeps
      // collecting every in-tenant match.
      if (!sub.broadcast) break;
      continue;
    }
    // Track whether a name+key match existed but was blocked SOLELY by the tenant
    // gate — for honest tenant-fail-closed diagnostics. We re-check name+key here
    // without the tenant gate (this never delivers — it only flags the rejection).
    if (
      decision.miss === "wrong-tenant" &&
      envelope.messageName === sub.messageName &&
      envelope.correlationKey === sub.correlationKey
    ) {
      sawCrossTenantNameKeyMatch = true;
    }
  }

  return {
    delivered: fired.length > 0,
    firedInstances: fired,
    tenantRejected: fired.length === 0 && sawCrossTenantNameKeyMatch,
  };
}

// ---------------------------------------------------------------------------
// Subscription construction from element config + a bound record.
// ---------------------------------------------------------------------------

/**
 * Build the concrete correlation key for a waiting catch by reading the value of the
 * record field named by the element's `correlationField`. Returns null when the
 * field is absent / not a scalar (the instance cannot correlate without a key — a
 * fail-closed condition the linter also guards against at publish time).
 *
 * Pure: the record is passed in (the impure read happens at the call-site).
 */
export function resolveCorrelationKey(
  record: Readonly<Record<string, unknown>> | null | undefined,
  correlationField: string,
): string | null {
  if (!record || !nonEmptyString(correlationField)) return null;
  const v = record[correlationField];
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // objects/arrays/null are not valid correlation keys.
}

// ---------------------------------------------------------------------------
// THROW side — message send = invoke-grant on a messaging_channel (T-0034).
// ---------------------------------------------------------------------------

/** The on-element config for a THROW message (spec §3.7 «throw: channel/connector»). */
export interface ThrowMessageConfig {
  /** The message name being thrown (informational; the channel does the delivery). */
  readonly messageName: string;
  /**
   * The effect_resource id of the messaging_channel/connector the throw uses. This
   * is what the invoke-grant is checked against — a throw with no channel cannot be
   * sent (fail-closed).
   */
  readonly channelResourceId: string;
  /** Record field keys whose values form the throw payload (бесшовность). */
  readonly payloadFields: readonly string[];
}

/**
 * Map a throw-message config to the EffectDeclaration the invoke gateway
 * (T-0034 verifyEffectGrants) checks against the caller's held grants.
 *
 * A throw message is sent THROUGH a messaging_channel effect-resource; the send is
 * authorised by the SAME invoke-grant model as any other effect (spec §3.5 «Throw =
 * invoke-грант на effect_resource через канал»). Returns null when the config names
 * no channel — a throw with no channel is unsendable (fail-closed at the call-site).
 */
export function buildThrowEffectDeclaration(
  config: ThrowMessageConfig,
): EffectDeclaration | null {
  if (!nonEmptyString(config.channelResourceId)) return null;
  return { resourceId: config.channelResourceId.trim(), kind: "messaging_channel" };
}

/** Outcome of authorizing a throw-message against the caller's held grants. */
export type ThrowAuthResult =
  | { ok: true }
  | { ok: false; reason: "no-channel" | "no-invoke-grant"; missingResourceId?: string };

/**
 * Authorize a throw-message via the EXISTING invoke-grant mechanism (T-0034).
 *
 * THE throw-side wiring (spec §3.5 part 3): a throw message is an `invoke` on a
 * `messaging_channel` effect_resource. This composes:
 *   buildThrowEffectDeclaration(config) → the EffectDeclaration, then
 *   verifyEffectGrants([decl], grants, nowMs, source, tenant) → the SAME gateway
 *   check any effect-invoke goes through (resourceType==="effect_resource" AND
 *   operation==="invoke" AND effective AND tenant-scoped).
 *
 * Fail-closed: a throw with no channel, or with no covering invoke-grant, is denied —
 * never sent. The actual send (notifications/email/connector) only runs when this
 * returns ok:true. Pure aside from the injected EffectSource port (no IO here).
 */
export function authorizeThrowMessage(
  config: ThrowMessageConfig,
  coveringGrants: readonly Grant[],
  nowMs: number,
  source: EffectSource,
  tenantId: string,
): ThrowAuthResult {
  const decl = buildThrowEffectDeclaration(config);
  if (decl === null) {
    return { ok: false, reason: "no-channel" };
  }
  const verdict = verifyEffectGrants([decl], coveringGrants as Grant[], nowMs, source, tenantId);
  if (!verdict.ok) {
    return { ok: false, reason: "no-invoke-grant", missingResourceId: verdict.missingResourceId };
  }
  return { ok: true };
}

/**
 * Assemble the throw payload bag from a bound record by projecting only the
 * configured payloadFields (no full-record dump — only the declared fields cross the
 * boundary). Pure; record is supplied by the caller.
 */
export function buildThrowPayload(
  record: Readonly<Record<string, unknown>> | null | undefined,
  payloadFields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!record) return out;
  for (const key of payloadFields) {
    if (nonEmptyString(key) && key in record) out[key] = record[key];
  }
  return out;
}
