/**
 * src/http/message-ingest.ts — T-0536 [D8-R4 delivery].
 *
 * The MESSAGE INGEST seam: the missing HTTP + internal door that lets a process
 * parked on a message-catch (receiveTask / intermediateCatchEvent(message|signal) /
 * message boundary) actually RECEIVE its message and continue.
 *
 * Until T-0536 the pure correlation core (src/core/message-correlation.ts) and the
 * delivery seam (deliverMessageEnvelope in process-projection.ts) existed but had no
 * producer: nothing called deliverMessageEnvelope. This module wires the TWO v1
 * sources the spec sanctions (process-element-runtime.spec §3.5 / PD-23):
 *
 *   1. EXTERNAL-HUMAN ingest — POST /api/message. An AUTHENTICATED actor submits a
 *      correlation envelope { messageName, correlationKey, payload }. The TENANT is
 *      taken from the ACTOR'S IDENTITY (resolveActorTenant), NEVER from the body —
 *      and the envelope's tenant is OVERWRITTEN with the actor tenant before
 *      correlation, so a forged body.tenant can never reach another tenant's
 *      instance (TENANT-FAIL-CLOSED at the door; the pure core re-checks on every
 *      candidate as a second wall).
 *
 *   2. INTERNAL-SIGNAL — emitInternalSignal(): a record status change / another
 *      process broadcasts a signal by signal-name WITHIN one tenant. Same envelope,
 *      same delivery path, source="internal-signal". The record-update route calls
 *      this after it commits a status change so a downstream process waiting on that
 *      signal advances. Broadcast is bounded to the tenant (correlateEnvelope keeps a
 *      signal in-tenant only).
 *
 * NOT a second transport (spec §3.5 «Транспорт = Pull»): this is the SINGLE
 * authenticated message-ingest door + the internal emitter. The connector-PULL
 * polling driver (опрос внешней системы) stays Stage-2 — its seam is documented in
 * message-correlation.ts (CONNECTOR_PULL_SEAM); we do NOT build a poller here.
 *
 * Auth: the route wraps its handler in withAuth (http-route-auth-coverage FF-0328-1)
 * and resolves the actor mode-aware (KC sub→slug, dev x-dev-user). emitInternalSignal
 * is server-internal (no HTTP) — its tenant is the already-resolved record tenant.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  deliverMessageEnvelope,
  makeEngineMessageSubscriptionSource,
  type MessageSubscriptionSource,
  type MessageDeliveryEnginePort,
  type MessageWaitEnginePort,
  type DeliveryResult,
} from "./process-projection.js";

// ---------------------------------------------------------------------------
// extractActor — mode-aware (mirrors files.ts / records.ts). KC mode resolves
// sub→employee slug (401 on no match); dev mode uses the x-dev-user header value.
// The x-dev-user read is inside the getAuthContext === undefined dev-fallback
// branch (http-route-auth-coverage FF-0328-2).
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// The combined engine port the delivery needs (correlateMessage to fire the
// catch + getActiveUserTasks to reconcile the new task) AND the wait-projection
// read (getMessageCatchWaits) so the same FlowableClient satisfies both. The
// real FlowableClient structurally satisfies all three.
// ---------------------------------------------------------------------------

export type MessageEngine = MessageDeliveryEnginePort & MessageWaitEnginePort;

// ---------------------------------------------------------------------------
// Deps. pool + actor→tenant resolver + the engine client + (injectable for
// tests) the subscription source factory. Production passes a FlowableClient;
// the source defaults to the engine-backed makeEngineMessageSubscriptionSource.
// ---------------------------------------------------------------------------

export interface MessageIngestDeps {
  readonly pool: pg.Pool;
  /** Resolve the tenant the actor (slug) belongs to — the ONLY tenant source. */
  readonly resolveActorTenant: (actorSlug: string) => Promise<string>;
  /** Live engine client (correlate + reconcile + wait-read). */
  readonly engine: MessageEngine;
  /**
   * Override the subscription source (tests). Production omits it ⇒ the
   * engine-backed source (makeEngineMessageSubscriptionSource) is used.
   */
  readonly subscriptionSource?: MessageSubscriptionSource;
}

/**
 * Resolve the subscription source for a delivery: the injected one (tests) or the
 * engine-backed one (production). The source is ALWAYS called with the envelope's
 * tenant (already forced to the actor tenant), and correlateEnvelope re-checks
 * tenant on every candidate — so even a leaky source cannot deliver cross-tenant.
 */
function subscriptionSourceFor(deps: MessageIngestDeps): MessageSubscriptionSource {
  return (
    deps.subscriptionSource ??
    makeEngineMessageSubscriptionSource(deps.pool, deps.engine)
  );
}

/**
 * Map a DeliveryResult to an HTTP response. delivered ⇒ 200 with firedInstances;
 * a rejected envelope ⇒ a fail-closed status:
 *   bad-envelope → 400 (malformed)
 *   wrong-tenant → 404 (HONEST no-leak: we do NOT reveal that a match exists in
 *                 another tenant — same body as no-match, so a probe can't use the
 *                 status to discover cross-tenant instances)
 *   no-match     → 404 (no waiting catch correlated)
 * The 404 for wrong-tenant is deliberate: tenant-fail-closed must not leak the
 * existence of a cross-tenant subscription via a distinct status/body.
 */
function respondDelivery(res: ServerResponse, result: DeliveryResult): void {
  res.setHeader("Content-Type", "application/json");
  if (result.delivered) {
    res.statusCode = 200;
    res.end(JSON.stringify({ delivered: true, firedInstances: result.firedInstances }));
    return;
  }
  if (result.rejected === "bad-envelope") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: "VALIDATION", reason: result.reason } }));
    return;
  }
  // wrong-tenant AND no-match both map to 404 with an identical body — no leak.
  res.statusCode = 404;
  res.end(JSON.stringify({ delivered: false, reason: "no waiting catch correlated this message" }));
}

// ---------------------------------------------------------------------------
// emitInternalSignal — the INTERNAL-SIGNAL door (source 2).
//
// Called server-internally (e.g. from the record-update route after a status
// change commits) to broadcast a signal by signal-name WITHIN one tenant. Reuses
// the SAME deliverMessageEnvelope path; source="internal-signal". The tenant is the
// caller's already-resolved record tenant (NOT a body field) — there is no HTTP
// surface here, so there is no cross-tenant vector to begin with, and the pure core
// still gates every candidate on tenant.
//
// Best-effort + never throws: a signal emit that fails (engine hiccup, no waiting
// catch) is non-fatal to the originating action (the record update already
// committed). Returns the DeliveryResult so a caller may log it.
// ---------------------------------------------------------------------------

export async function emitInternalSignal(
  deps: MessageIngestDeps,
  args: {
    readonly tenantId: string;
    readonly signalName: string;
    readonly correlationKey: string;
    readonly payload?: Record<string, unknown>;
    readonly actor?: string;
    readonly nowMs?: number;
  },
): Promise<DeliveryResult> {
  const envelope = {
    tenant: args.tenantId, // server-resolved record tenant — never a body field.
    messageName: args.signalName,
    correlationKey: args.correlationKey,
    payload: args.payload ?? {},
    source: "internal-signal" as const,
  };
  try {
    return await deliverMessageEnvelope(
      deps.pool,
      envelope,
      subscriptionSourceFor(deps),
      deps.engine,
      { nowMs: args.nowMs, actor: args.actor ?? "system:signal" },
    );
  } catch {
    // Internal emit is best-effort — never propagate past the originating action.
    return { delivered: false, rejected: "no-match", reason: "internal signal emit failed" };
  }
}

// ---------------------------------------------------------------------------
// registerMessageIngestRoutes — POST /api/message (source 1: external-human).
// ---------------------------------------------------------------------------

/**
 * Register the message-ingest route. When deps is absent (memory-mode / no engine),
 * NO route is registered (honest-degrade — there is no delivery path without a
 * tenant resolver + engine), mirroring the registerInboxRoutes write-deps gate.
 */
export function registerMessageIngestRoutes(
  router: Router,
  deps?: MessageIngestDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // -------------------------------------------------------------------------
  // POST /api/message
  //
  //   Body : { messageName: string, correlationKey: string, payload?: object }
  //          (a tenant field in the body is IGNORED — tenant comes from identity)
  //   Auth : withAuth — KC mode requires a valid Bearer (401 otherwise); the actor
  //          is resolved mode-aware and its tenant is the ONLY correlation tenant.
  //   200  : { delivered: true, firedInstances: [...] }
  //   400  : malformed envelope (missing messageName/correlationKey)
  //   404  : no waiting catch correlated (incl. a cross-tenant-only match — no leak)
  //
  // TENANT-FAIL-CLOSED: the envelope's tenant is set to the ACTOR'S tenant, so even
  // a body that names another tenant correlates only within the actor's tenant. The
  // pure core (correlateEnvelope) gates every candidate on tenant as a second wall.
  // -------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/message",
    withAuth(async (req: IncomingMessage, res: ServerResponse) => {
      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      // Build the envelope with tenant FORCED to the actor's tenant (body.tenant is
      // discarded). source = external-human (the v1 authenticated submit surface).
      const rawPayload = body["payload"];
      const envelope = {
        tenant: tenantId,
        messageName: body["messageName"],
        correlationKey: body["correlationKey"],
        payload:
          rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
            ? (rawPayload as Record<string, unknown>)
            : {},
        source: "external-human" as const,
      };

      const result = await deliverMessageEnvelope(
        pool,
        envelope,
        subscriptionSourceFor(deps),
        deps.engine,
        { actor },
      );

      respondDelivery(res, result);
    }),
  );
}
