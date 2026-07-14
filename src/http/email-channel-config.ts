/**
 * src/http/email-channel-config.ts — T-0203 E-N.6 (email-config REST surface)
 *
 * REST endpoints for email channel configuration (ADR T-0120 §2.3):
 *   GET    /api/email-channel-config   — tenant-admin: status view (handle REDACTED)
 *   PUT    /api/email-channel-config   — tenant-admin: set/update (RL-3 shape-guard + audit)
 *   DELETE /api/email-channel-config   — tenant-admin: revoke + audit
 *
 * This handler is the missing HTTP surface over the already-implemented CRUD in
 * src/core/notification-email.ts (setEmailChannelConfig / revokeEmailChannelConfig /
 * getEmailChannelConfigStatus). It mirrors src/http/notification-prefs.ts:
 *   - Same withTenantTx (SET LOCAL choros.tenant_id GUC) pattern.
 *   - Same injectable PDP gate (deps.checkAdminGrant) on mgmt_object:email_config.
 *
 * DESIGN INVARIANTS (ADR T-0120 §2.3/§2.8/§5 E-N.3/E-N.6):
 *  - Authorization via PDP loadAdminContext / mgmt_object:email_config (FF-PREF-AUTHZ
 *    pattern; no new ACL mechanism). read for GET, update for PUT/DELETE.
 *  - smtp_handle NEVER returned raw: status view uses redactHandle (FF-NO-RAW-SMTP).
 *    Set/update runs validateSecretHandleShape inside setEmailChannelConfig (FF-HANDLE-SHAPE).
 *  - Audit (notif.email_config.set/.revoke) emitted by the core CRUD — single
 *    appendAuditEvent sink (T-0016); this handler adds NO second audit path.
 *  - All DB work inside a tenant transaction (RLS fail-closed without GUC).
 *  - The EmailConfigWritePort is bound to the transaction client so the GUC the
 *    handler SET LOCAL applies (the pool-based PgEmailConfigStore would grab a
 *    different connection and lose the GUC — see txEmailConfigStore below).
 */

import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { loadAdminContext } from "../db/org.js";
import type { Operation } from "../core/grant-lattice.js";
import {
  setEmailChannelConfig,
  revokeEmailChannelConfig,
  getEmailChannelConfigStatus,
  type EmailChannelConfig,
  type EmailChannelConfigInput,
  type EmailConfigWritePort,
} from "../core/notification-email.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single canonical audit writer (T-0016) — the core CRUD appends through this.
const emailConfigAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// PrefAuthzDeps-shaped gate for email config (mirrors notification-prefs.ts)
// ---------------------------------------------------------------------------

export interface EmailConfigAuthzDeps {
  /**
   * Check whether `actorId` holds admin authority for `mgmt_object:email_config`
   * with the given `operation` in `tenantId`. `{ ok: true }` → allowed,
   * `{ ok: false, reason }` → 403. Injectable so unit tests skip the live DB.
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

  // Non-owners: require a delegable grant on mgmt_object:email_config with the
  // required operation. loadAdminContext fetches all LIKE 'mgmt_object:%' delegable
  // grants — covering email_config WITHOUT expanding MGMT_OBJECT_KINDS (same as
  // the notification_config gate in notification-prefs.ts).
  const hasCovering = admin.adminGrants.some(
    (g) =>
      g.delegable &&
      g.resourceType === "mgmt_object:email_config" &&
      g.operation === operation,
  );

  if (!hasCovering) {
    return { ok: false, reason: "no_admin_authority" };
  }
  return { ok: true };
}

const defaultEmailConfigAuthzDeps: EmailConfigAuthzDeps = {
  checkAdminGrant: defaultCheckAdminGrant,
};

// ---------------------------------------------------------------------------
// withTenantTx — SET LOCAL choros.tenant_id GUC (mirrors notification-prefs.ts)
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
// txEmailConfigStore — EmailConfigWritePort bound to the open tx client.
//
// PgEmailConfigStore (pool-based) calls pool.query, which acquires a DIFFERENT
// connection that does NOT carry the SET LOCAL GUC of this handler's transaction.
// Under FORCE RLS that would fail closed. So we bind the port to the transaction
// client here (the same approach pgPrefStore takes by accepting a PgClientLike).
// ---------------------------------------------------------------------------

function txEmailConfigStore(client: pg.PoolClient): EmailConfigWritePort {
  return {
    async upsert(config: EmailChannelConfig): Promise<void> {
      await client.query(
        `INSERT INTO choros.email_channel_config
           (tenant_id, smtp_host, smtp_port, smtp_tls, from_address, from_name,
            smtp_handle, is_enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           smtp_host    = EXCLUDED.smtp_host,
           smtp_port    = EXCLUDED.smtp_port,
           smtp_tls     = EXCLUDED.smtp_tls,
           from_address = EXCLUDED.from_address,
           from_name    = EXCLUDED.from_name,
           smtp_handle  = EXCLUDED.smtp_handle,
           is_enabled   = EXCLUDED.is_enabled,
           updated_by   = EXCLUDED.updated_by,
           updated_at   = EXCLUDED.updated_at`,
        [
          config.tenantId,
          config.smtpHost,
          config.smtpPort,
          config.smtpTls,
          config.fromAddress,
          config.fromName,
          config.smtpHandle,
          config.isEnabled,
          config.updatedBy,
          config.updatedAt,
        ],
      );
    },
    async delete(tenantId: string): Promise<boolean> {
      const { rowCount } = await client.query(
        `DELETE FROM choros.email_channel_config WHERE tenant_id = $1`,
        [tenantId],
      );
      return (rowCount ?? 0) > 0;
    },
    async get(tenantId: string): Promise<EmailChannelConfig | null> {
      const { rows } = await client.query(
        `SELECT tenant_id, smtp_host, smtp_port, smtp_tls, from_address, from_name,
                smtp_handle, is_enabled, updated_by, updated_at
         FROM choros.email_channel_config
         WHERE tenant_id = $1`,
        [tenantId],
      );
      if (rows.length === 0) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        tenantId: String(r["tenant_id"]),
        smtpHost: String(r["smtp_host"]),
        smtpPort: Number(r["smtp_port"]),
        smtpTls: Boolean(r["smtp_tls"]),
        fromAddress: String(r["from_address"]),
        fromName: r["from_name"] === null ? null : String(r["from_name"]),
        smtpHandle: String(r["smtp_handle"]),
        isEnabled: Boolean(r["is_enabled"]),
        updatedBy: String(r["updated_by"]),
        updatedAt: Number(r["updated_at"]),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Actor extraction
// ---------------------------------------------------------------------------

// T-0420 [SECURITY] P1: mode-aware caller identity (mirrors binding.ts::extractActorSlug
// and the T-0418 P0 process-defs::extractActor). email-channel-config is an SPA
// tenant-admin surface gated by a real PDP check (loadAdminContext / mgmt_object:email_config).
// The routes are now withAuth-wrapped (Bearer validated + getAuthContext populated BEFORE
// this runs), so the identity feeding that PDP gate is the VALIDATED token in keycloak mode,
// not an unauthenticated x-dev-user header.
//   - keycloak: identity from the validated token (sub/preferred_username → employee.slug);
//     null → 401 fail-closed. x-dev-user is NOT consulted once a token authenticated.
//   - dev: getAuthContext is undefined (withAuth no-op) → x-dev-user, unchanged.
async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
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
// PUT body validation
// ---------------------------------------------------------------------------

function parsePutBody(raw: unknown, actorId: string): EmailChannelConfigInput {
  const b = raw as Record<string, unknown>;
  if (typeof b["smtpHost"] !== "string" || b["smtpHost"].trim() === "") {
    throw new HttpError(400, "VALIDATION", "smtpHost is required");
  }
  const port = Number(b["smtpPort"]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new HttpError(400, "VALIDATION", "smtpPort must be a valid port number");
  }
  if (typeof b["fromAddress"] !== "string" || b["fromAddress"].trim() === "") {
    throw new HttpError(400, "VALIDATION", "fromAddress is required");
  }
  if (typeof b["smtpHandle"] !== "string" || b["smtpHandle"].trim() === "") {
    throw new HttpError(400, "VALIDATION", "smtpHandle is required");
  }
  return {
    smtpHost: b["smtpHost"] as string,
    smtpPort: port,
    smtpTls: b["smtpTls"] === undefined ? true : Boolean(b["smtpTls"]),
    fromAddress: b["fromAddress"] as string,
    fromName: typeof b["fromName"] === "string" ? (b["fromName"] as string) : null,
    smtpHandle: b["smtpHandle"] as string,
    isEnabled: Boolean(b["isEnabled"]),
    updatedBy: actorId,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the three email-channel-config endpoints.
 *
 * @param deps  Injectable authz deps (default: production loadAdminContext gate).
 *              Override in tests to supply a fake resolver without a live DB.
 */
export function registerEmailChannelConfigRoutes(
  router: Router,
  pool: pg.Pool,
  deps: EmailConfigAuthzDeps = defaultEmailConfigAuthzDeps,
): void {
  // -------------------------------------------------------------------------
  // GET /api/email-channel-config — status view (handle REDACTED)
  // -------------------------------------------------------------------------
  // T-0420 [SECURITY] P1: withAuth-wrapped — keycloak mode REQUIRES a valid Bearer
  // (401 otherwise; no x-dev-user bypass); dev mode is a no-op pass-through.
  router.register("GET", "/api/email-channel-config", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    // PDP gate: mgmt_object:email_config / read (FF-PREF-AUTHZ pattern).
    const gate = await deps.checkAdminGrant(pool, tenantId, actorId, "read", Date.now());
    if (!gate.ok) {
      throw new HttpError(403, "NO_EMAIL_CFG_GRANT", `mgmt_object:email_config/read denied: ${gate.reason}`);
    }

    const status = await withTenantTx(pool, tenantId, (client) =>
      getEmailChannelConfigStatus(txEmailConfigStore(client), tenantId),
    );

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    // status.handleRedacted is the redacted form; raw smtp_handle is never serialized.
    res.end(JSON.stringify({ config: status }));
  }));

  // -------------------------------------------------------------------------
  // PUT /api/email-channel-config — set/update (RL-3 shape-guard + audit)
  // -------------------------------------------------------------------------
  // T-0420 [SECURITY] P1: withAuth-wrapped write — keycloak REQUIRES a valid Bearer.
  router.register("PUT", "/api/email-channel-config", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    const gate = await deps.checkAdminGrant(pool, tenantId, actorId, "update", Date.now());
    if (!gate.ok) {
      throw new HttpError(403, "NO_EMAIL_CFG_GRANT", `mgmt_object:email_config/update denied: ${gate.reason}`);
    }

    const rawBody = await readJsonBody(req);
    const input = parsePutBody(rawBody, actorId);

    const result = await withTenantTx(pool, tenantId, (client) =>
      setEmailChannelConfig(
        {
          configStore: txEmailConfigStore(client),
          auditWriter: emailConfigAuditWriter,
          tx: client as unknown as PgClientLike,
          clock: { now: () => Date.now() },
        },
        tenantId,
        input,
      ),
    );

    // RL-3 shape-guard rejection (FF-HANDLE-SHAPE): raw sk-/hex/JWT → 422, no write.
    if (!result.ok) {
      throw new HttpError(422, "SMTP_HANDLE_REJECTED", result.reason);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }));

  // -------------------------------------------------------------------------
  // DELETE /api/email-channel-config — revoke + audit
  // -------------------------------------------------------------------------
  // T-0420 [SECURITY] P1: withAuth-wrapped write — keycloak REQUIRES a valid Bearer.
  router.register("DELETE", "/api/email-channel-config", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = DEV_TENANT_ID;

    const gate = await deps.checkAdminGrant(pool, tenantId, actorId, "update", Date.now());
    if (!gate.ok) {
      throw new HttpError(403, "NO_EMAIL_CFG_GRANT", `mgmt_object:email_config/update denied: ${gate.reason}`);
    }

    const result = await withTenantTx(pool, tenantId, (client) =>
      revokeEmailChannelConfig(
        {
          configStore: txEmailConfigStore(client),
          auditWriter: emailConfigAuditWriter,
          tx: client as unknown as PgClientLike,
          clock: { now: () => Date.now() },
        },
        tenantId,
        actorId,
      ),
    );

    if (!result.ok) {
      // not_found → 404 (no config to revoke)
      throw new HttpError(404, "NOT_FOUND", "email channel config not found");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }));
}
