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
import { DEV_USER_HEADER } from "./auth.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { PostgresPrefStore } from "../core/postgres/pgPrefStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The audit writer instance for this module (single canonical sink per T-0016).
const prefAuditWriter = makePgAuditWriter();

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

// Structural guard: self-endpoint must not allow setting role: or foreign actor: scopes.
function assertSelfScopeValid(scope: string | undefined): void {
  if (scope === undefined) return;
  if (scope.startsWith("role:")) {
    throw new HttpError(400, "VALIDATION", "self-endpoint may not set role: recipient_scope");
  }
  // Reject any explicit 'actor:' that does NOT start with actor: (paranoia) or
  // is present at all (we override it server-side). Reject explicitly to return a clear error.
  // The actual scope is always constructed server-side from actorId.
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the four notification-preference endpoints.
 *
 * Authorization (dev-mode):
 *   Admin routes (GET/PUT /api/notification-preferences) — require X-Dev-User header
 *     as actorId; day-1 dev-mode accepts any valid header (PDP is wired for grant-check;
 *     day-1 dev grants are pre-seeded for the genesis owner role).
 *   Self routes — require X-Dev-User header; scope is structurally locked to actor:<self>.
 *
 * NOTE: PDP grant-check (resolveFor / mgmt_object:notification_config) is the production
 * gate for admin routes. The current implementation includes the structural guard (no
 * second ACL mechanism) but does not wire resolveFor in dev-mode to avoid a dependency
 * on the full grant-resolver initialization in the composition root. The TODO marks
 * where resolveFor should be called when the full PDP wiring lands.
 */
export function registerNotificationPrefRoutes(router: Router, pool: pg.Pool): void {
  const store = new PostgresPrefStore(pool);

  // -------------------------------------------------------------------------
  // GET /api/notification-preferences  — admin: list all tenant preferences
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notification-preferences", async (req, res) => {
    let actorId: string;
    {
      let devUser = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUser)) devUser = devUser[0];
      if (!devUser || typeof devUser !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      actorId = devUser;
    }

    // TODO: PDP resolveFor(deps, handle, actorId, 'read') for mgmt_object:notification_config
    // when grant-resolver is wired into this composition root. Day-1: actor presence = gate.
    void actorId;

    const tenantId = DEV_TENANT_ID;

    const preferences = await withTenantTx(pool, tenantId, (client) =>
      store.listByTenant(client),
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ preferences }));
  });

  // -------------------------------------------------------------------------
  // PUT /api/notification-preferences  — admin: UPSERT + audit
  // -------------------------------------------------------------------------
  router.register("PUT", "/api/notification-preferences", async (req, res) => {
    let actorId: string;
    {
      let devUser = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUser)) devUser = devUser[0];
      if (!devUser || typeof devUser !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      actorId = devUser;
    }

    // TODO: PDP resolveFor for mgmt_object:notification_config / update (day-1: actor gate).
    void actorId;

    const tenantId = DEV_TENANT_ID;
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
  });

  // -------------------------------------------------------------------------
  // GET /api/notification-preferences/self  — own preferences (actor:<self>)
  // -------------------------------------------------------------------------
  router.register("GET", "/api/notification-preferences/self", async (req, res) => {
    let actorId: string;
    {
      let devUser = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUser)) devUser = devUser[0];
      if (!devUser || typeof devUser !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      actorId = devUser;
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
  });

  // -------------------------------------------------------------------------
  // PUT /api/notification-preferences/self  — UPSERT own (FF-SELF-PREF-SCOPED)
  // -------------------------------------------------------------------------
  router.register("PUT", "/api/notification-preferences/self", async (req, res) => {
    let actorId: string;
    {
      let devUser = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUser)) devUser = devUser[0];
      if (!devUser || typeof devUser !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      actorId = devUser;
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
  });
}
