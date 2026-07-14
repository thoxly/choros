/**
 * src/http/notification-prefs.ts — T-0171 E-N.4
 *
 * REST endpoints for notification_preference management:
 *   GET  /api/notification-preferences          — tenant-admin: list all
 *   PUT  /api/notification-preferences          — tenant-admin: UPSERT
 *   GET  /api/notification-preferences/self     — any user: own preferences
 *   PUT  /api/notification-preferences/self     — any user: UPSERT own (actor:<self>)
 *
 * DESIGN INVARIANTS (ADR T-0120 §2.4/§5 E-N.4/§6):
 *  - Admin routes: authorization via PDP resolveFor / mgmt_object:notification_config
 *    (FF-PREF-AUTHZ). No new ACL mechanism.
 *  - Self route: recipient_scope ALWAYS = 'actor:<actorId>' — server-constructed,
 *    never from request body (FF-SELF-PREF-SCOPED).
 *  - Audit: appendAuditEvent on every preference change (admin + self PUT).
 *    type = 'notif.preference.changed' (FF-AUDIT-CONFIG-ONLY).
 *  - No second at-least-once mechanism, no new tables.
 *  - DEV_USER_HEADER used for dev-mode actor identity (matches grant-propose.ts pattern).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { PostgresPrefStore } from "../core/postgres/pgPrefStore.js";
import { loadAdminContext } from "../db/org.js";
import type { Operation } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The audit writer instance for this module (single canonical sink per T-0016).
const prefAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// PrefAuthzDeps — injectable PDP gate (R-1 / AC-6/AC-7/AC-10)
//
// The gate checks that the actor holds a grant on mgmt_object:notification_config
// for the required operation (read for GET, update for PUT).
//
// Default implementation uses loadAdminContext + validateAdminDelegation — the
// same pattern used by all other mgmt-route writes (agents.ts, grants.ts, etc).
// Injected as deps to allow unit tests to supply a fake without a live DB.
// ---------------------------------------------------------------------------

export interface PrefAuthzDeps {
  /**
   * Check whether `actorId` holds admin authority for `mgmt_object:notification_config`
   * with the given `operation` in `tenantId`. Returns `{ ok: true }` if allowed or
   * `{ ok: false, reason: string }` to trigger a 403.
   */
  checkAdminGrant: (
    pool: pg.Pool,
    tenantId: string,
    actorId: string,
    operation: Operation,
    nowMs: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

async function defaultCheckAdminGrant(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  operation: Operation,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  // Genesis owner is the un-parented delegation root — always allowed (T-0029 §2 step 3).
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // For non-owners: check that adminGrants contains a delegable grant on
  // mgmt_object:notification_config with the required operation (read or update).
  // loadAdminContext fetches all LIKE 'mgmt_object:%' delegable grants — this
  // covers mgmt_object:notification_config without expanding MGMT_OBJECT_KINDS.
  const hasCovering = admin.adminGrants.some(
    (g) =>
      g.delegable &&
      g.resourceType === "mgmt_object:notification_config" &&
      g.operation === operation,
  );

  if (!hasCovering) {
    return { ok: false, reason: "no_admin_authority" };
  }
  return { ok: true };
}

const defaultPrefAuthzDeps: PrefAuthzDeps = {
  checkAdminGrant: defaultCheckAdminGrant,
};

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors grants.ts / grant-propose.ts pattern)
// Opens a pg transaction, sets choros.tenant_id GUC SET LOCAL, runs fn, commits.
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function appendPrefAudit(
  client: pg.PoolClient,
  input: AuditEventInput,
): Promise<void> {
  await prefAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

interface PrefPutBody {
  eventKind: string;
  recipientScope?: string;
  channels: string[];
}

function parsePutBody(raw: unknown): PrefPutBody {
  const b = raw as Record<string, unknown>;
  if (typeof b["eventKind"] !== "string" || b["eventKind"].trim() === "") {
    throw new HttpError(400, "VALIDATION", "eventKind is required");
  }
  if (!Array.isArray(b["channels"]) || b["channels"].some((c: unknown) => typeof c !== "string")) {
    throw new HttpError(400, "VALIDATION", "channels must be an array of strings");
  }
  return {
    eventKind: b["eventKind"] as string,
    recipientScope: typeof b["recipientScope"] === "string" ? b["recipientScope"] : undefined,
    channels: b["channels"] as string[],
  };
}

// Structural guard: self-endpoint must not allow setting role: or any explicit actor: scope.
// The actual recipientScope is ALWAYS server-constructed as actor:<self>.
// We reject both role: scopes AND any explicit actor: scope from the body — the server
// overrides the value, but we return a clear 400 so the client knows the field is ignored.
// (R-2: reject actor:foreign too, not only role:)
function assertSelfScopeValid(scope: string | undefined): void {
  if (scope === undefined) return;
  if (scope.startsWith("role:")) {
    throw new HttpError(400, "VALIDATION", "self-endpoint may not set role: recipient_scope");
  }
  // Reject any explicit actor: value — the server always constructs actor:<self>;
  // providing a different actor: in the body is an error (either self-redundant or foreign).
  if (scope.startsWith("actor:")) {
    throw new HttpError(400, "VALIDATION", "self-endpoint may not set actor: recipient_scope; scope is always actor:<self>");
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the four notification-preference endpoints.
 *
 * Authorization:
 *   Admin routes (GET/PUT /api/notification-preferences) — require X-Dev-User header
 *     as actorId AND PDP gate via deps.checkAdminGrant (mgmt_object:notification_config
 *     / read or update). 403 NO_PREF_MGMT_GRANT if actor lacks the grant (AC-6/AC-7).
 *   Self routes — require X-Dev-User header; scope is structurally locked to actor:<self>.
 *
 * @param deps  - Injectable authz deps (default: production loadAdminContext gate).
 *                Override in tests to supply a fake resolver without a live DB.
 */
export function registerNotificationPrefRoutes(
  router: Router,
  pool: pg.Pool,
  deps: PrefAuthzDeps = defaultPrefAuthzDeps,
): void {
  const store = new PostgresPrefStore(pool);

  // -------------------------------------------------------------------------
  // GET /api/notification-preferences  — admin: list all tenant preferences
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notification-preferences", withAuth(async (req, res) => {
    let actorId: string;
    {
      const authCtx = getAuthContext(req);
      if (authCtx !== undefined) {
        actorId = authCtx.sub;
      } else {
        let devUser = req.headers[DEV_USER_HEADER];
        if (Array.isArray(devUser)) devUser = devUser[0];
        if (!devUser || typeof devUser !== "string") {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
        actorId = devUser;
      }
    }

    // PDP gate: actor must hold mgmt_object:notification_config / read (AC-6/AC-10).
    const tenantId = DEV_TENANT_ID;
    const gateResult = await deps.checkAdminGrant(pool, tenantId, actorId, "read", Date.now());
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_PREF_MGMT_GRANT", `mgmt_object:notification_config/read denied: ${gateResult.reason}`);
    }

    const preferences = await withTenantTx(pool, tenantId, (client) =>
      store.listByTenant(client),
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ preferences }));
  }));

  // -------------------------------------------------------------------------
  // PUT /api/notification-preferences  — admin: UPSERT + audit
  // -------------------------------------------------------------------------
  router.register("PUT", "/api/notification-preferences", withAuth(async (req, res) => {
    let actorId: string;
    {
      const authCtx = getAuthContext(req);
      if (authCtx !== undefined) {
        actorId = authCtx.sub;
      } else {
        let devUser = req.headers[DEV_USER_HEADER];
        if (Array.isArray(devUser)) devUser = devUser[0];
        if (!devUser || typeof devUser !== "string") {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
        actorId = devUser;
      }
    }

    // PDP gate: actor must hold mgmt_object:notification_config / update (AC-7/AC-10).
    const tenantId = DEV_TENANT_ID;
    const gateResult = await deps.checkAdminGrant(pool, tenantId, actorId, "update", Date.now());
    if (!gateResult.ok) {
      throw new HttpError(403, "NO_PREF_MGMT_GRANT", `mgmt_object:notification_config/update denied: ${gateResult.reason}`);
    }

    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const { eventKind, recipientScope, channels } = parsePutBody(rawBody);

    if (!recipientScope || recipientScope.trim() === "") {
      throw new HttpError(400, "VALIDATION", "recipientScope is required for admin endpoint");
    }

    await withTenantTx(pool, tenantId, async (client) => {
      await store.upsert(client, {
        tenantId,
        eventKind,
        recipientScope,
        channels,
        updatedBy: actorId,
        updatedAt: nowMs,
      });

      // Audit: notif.preference.changed (FF-AUDIT-CONFIG-ONLY; no smtp_handle/secrets here)
      const auditInput: AuditEventInput = {
        id: randomUUID(),
        type: "notif.preference.changed",
        actor: actorId,
        subject: `${eventKind}:${recipientScope}`,
        scope: null,
        via: "notification-prefs",
        proposed_by: null,
        confirmed_by: null,
        payload: {
          eventKind,
          recipientScope,
          channels,
        },
        occurred_at: nowMs,
      };
      await appendPrefAudit(client, auditInput);
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, eventKind, recipientScope, channels }));
  }));

  // -------------------------------------------------------------------------
  // GET /api/notification-preferences/self  — own preferences (actor:<self>)
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notification-preferences/self", withAuth(async (req, res) => {
    let actorId: string;
    {
      const authCtx = getAuthContext(req);
      if (authCtx !== undefined) {
        actorId = authCtx.sub;
      } else {
        let devUser = req.headers[DEV_USER_HEADER];
        if (Array.isArray(devUser)) devUser = devUser[0];
        if (!devUser || typeof devUser !== "string") {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
        actorId = devUser;
      }
    }

    const tenantId = DEV_TENANT_ID;
    const selfScope = `actor:${actorId}`;

    const preferences = await withTenantTx(pool, tenantId, async (client) => {
      const all = await store.listByTenant(client);
      // Structural filter: only rows belonging to actor:<self>
      return all.filter((p) => p.recipientScope === selfScope);
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ preferences }));
  }));

  // -------------------------------------------------------------------------
  // PUT /api/notification-preferences/self  — UPSERT own (FF-SELF-PREF-SCOPED)
  // -------------------------------------------------------------------------
  router.register("PUT", "/api/notification-preferences/self", withAuth(async (req, res) => {
    let actorId: string;
    {
      const authCtx = getAuthContext(req);
      if (authCtx !== undefined) {
        actorId = authCtx.sub;
      } else {
        let devUser = req.headers[DEV_USER_HEADER];
        if (Array.isArray(devUser)) devUser = devUser[0];
        if (!devUser || typeof devUser !== "string") {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
        actorId = devUser;
      }
    }

    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const rawBody = await readJsonBody(req);
    const { eventKind, recipientScope: bodyScope, channels } = parsePutBody(rawBody);

    // FF-SELF-PREF-SCOPED: structural barrier — reject if body tries to set role: scope.
    // The actual recipientScope is ALWAYS server-constructed as actor:<self>.
    assertSelfScopeValid(bodyScope);

    // Server constructs the scope — body value is ignored/overridden.
    const recipientScope = `actor:${actorId}`;

    await withTenantTx(pool, tenantId, async (client) => {
      await store.upsert(client, {
        tenantId,
        eventKind,
        recipientScope,
        channels,
        updatedBy: actorId,
        updatedAt: nowMs,
      });

      // Audit: notif.preference.changed (FF-AUDIT-CONFIG-ONLY)
      const auditInput: AuditEventInput = {
        id: randomUUID(),
        type: "notif.preference.changed",
        actor: actorId,
        subject: `${eventKind}:${recipientScope}`,
        scope: null,
        via: "notification-prefs/self",
        proposed_by: null,
        confirmed_by: null,
        payload: {
          eventKind,
          recipientScope,
          channels,
        },
        occurred_at: nowMs,
      };
      await appendPrefAudit(client, auditInput);
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, eventKind, recipientScope, channels }));
  }));
}
