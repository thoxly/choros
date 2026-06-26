/**
 * src/db/audit-read-dao.ts — T-0500 [reality-gap] Tenant-wide audit log reader.
 *
 * Reads the REAL hash-chained audit log (choros.audit_event, migration 006) — the
 * events `appendAuditEvent` (audit-writer.ts) writes — for the WHOLE tenant. This is
 * the tenant-wide sibling of agent-activity-dao.ts (T-0499, which reads ONE agent's
 * outcome stream). The shape is deliberately a near-clone of that proven, adversarially
 * reviewed read: keyset pagination, allowlist projection, tenant-scope, authz upstream.
 *
 * TENANT-SCOPE (CRITICAL — this is the WHOLE tenant's audit, the Враг's prize): the
 * SELECT runs against a client the caller has already put under SET LOCAL
 * choros.tenant_id (FORCE RLS, migration 006 policy audit_event_tenant_isolation) AND
 * carries an explicit `WHERE tenant_id = $1` predicate (defence-in-depth — RLS +
 * literal). A caller in tenant A can NEVER read tenant B's audit rows. The tenant id
 * is the ACTOR's resolved tenant (resolveActorTenant), NEVER a request-supplied value.
 *
 * AUTHZ: enforced UPSTREAM in src/http/audit.ts BEFORE this DAO runs (genesis-owner OR
 * a tenant-wide delegable mgmt_object:* grant — the whole tenant's audit is sensitive,
 * so the gate is conservative). This DAO is a pure read and assumes the gate passed.
 *
 * PAGINATION: keyset (occurred_at, id) DESC — newest first — mirroring agent-activity
 * and the records cursor pattern. Fetches limit+1 to detect a next page without
 * COUNT(*). `limit` is clamped by the caller.
 *
 * FILTERS (optional): `actor` (exact match) and `action` (type prefix). BOTH are bound
 * as parameters ($N) — NEVER string-interpolated — so a `'; DROP …` actor or a
 * `%`-laden action can never be SQL-injected or turn into a wildcard (the prefix is
 * escaped: LIKE special chars in the user value are neutralised, then a literal `%` is
 * appended in the parameter value).
 *
 * REDACTION (the security spine — this is audit EXPOSURE): the raw audit payload/scope
 * carry sensitive free-text (grant reasons, F5 agent drafts, record values, secret
 * sentinels). We NEVER surface them. `toAuditItem` projects ONLY a fixed allow-list of
 * safe identifiers: id, ts, actor (an opaque slug/UUID), action (the event `type`), and
 * a derived human `summary`/`target`. The raw `payload`/`scope`/`subject` free-text is
 * DROPPED at the projection boundary — it never reaches the wire.
 */

import type { PgClientLike } from "./audit-writer.js";

// ---------------------------------------------------------------------------
// Redacted wire shape — ONLY safe fields. No raw payload, no scope, no secrets.
// ---------------------------------------------------------------------------

export interface AuditLogItem {
  /** audit_event.id (UUID) — also the keyset tiebreaker. */
  readonly id: string;
  /** occurred_at epoch ms (audit clock). */
  readonly ts: number;
  /** the event ACTOR — an opaque employee slug or UUID (safe identifier, not data). */
  readonly actor: string;
  /** the event `type` — a config vocabulary token (e.g. "grant.create"), safe. */
  readonly action: string;
  /**
   * A SHORT, action-class human label derived from `type` ONLY — NEVER any free-text
   * from the payload. Canned per known prefix; falls back to the raw type token.
   */
  readonly summary: string;
  /**
   * An OPTIONAL safe target identifier extracted from a narrow allow-list of payload
   * keys (process/instance/grant ids — opaque identifiers, never free-text values).
   * null when no safe identifier is present.
   */
  readonly target: string | null;
}

export interface AuditLogPage {
  readonly items: AuditLogItem[];
  /** opaque cursor for the next (older) page; null on the last page. */
  readonly nextCursor: string | null;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Cursor — keyset on (occurred_at, id) DESC. Opaque base64url JSON. (Same wire
// encoding as agent-activity-dao so the two surfaces are interchangeable.)
// ---------------------------------------------------------------------------

export interface AuditLogCursor {
  readonly ts: number; // occurred_at epoch ms
  readonly id: string; // audit_event.id (UUID)
}

export function encodeAuditCursor(c: AuditLogCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeAuditCursor(raw: string): AuditLogCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf-8"),
    ) as unknown;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as Record<string, unknown>)["ts"] !== "number" ||
      typeof (decoded as Record<string, unknown>)["id"] !== "string"
    ) {
      return null;
    }
    const obj = decoded as Record<string, unknown>;
    return { ts: obj["ts"] as number, id: obj["id"] as string };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw row shape (only the columns we read + project — payload/scope are read so
// we can pull a SAFE target identifier, but are NEVER surfaced wholesale).
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  type: string;
  actor: string;
  payload: unknown; // jsonb — node-postgres returns a parsed object
  occurred_at: string | number; // bigint comes back as a string
}

// ---------------------------------------------------------------------------
// Action-class human summary. Keyed on the `type` PREFIX only — never echoes any
// free-text from the payload. Falls back to the raw type token (a safe vocabulary
// identifier) so an unknown action still renders honestly.
// ---------------------------------------------------------------------------

const SUMMARY_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["grant.create", "Выдан грант прав"],
  ["grant.revoke", "Отозван грант прав"],
  ["grant.", "Изменён грант прав"],
  ["assignment.create", "Назначена роль"],
  ["assignment.revoke", "Снята роль"],
  ["assignment.", "Изменено назначение роли"],
  ["agent.proceeded", "Агент выполнил шаг самостоятельно"],
  ["agent.deferred", "Агент передал решение человеку"],
  ["agent.blocked", "Агент остановился (нет прав или сработала проверка)"],
  ["agent.", "Событие агента"],
  ["set_agent_llm_connection", "Привязано LLM-соединение к агенту"],
  ["agent_hire", "Нанят агент"],
  ["substitution.", "Замещение"],
  ["task.", "Событие задачи"],
  ["record.", "Событие записи"],
  ["process.", "Событие процесса"],
];

function summaryFor(type: string): string {
  for (const [prefix, label] of SUMMARY_BY_PREFIX) {
    if (type === prefix || type.startsWith(prefix)) return label;
  }
  // Unknown action: surface the raw vocabulary token (safe — a config identifier).
  return type;
}

// The ONLY payload keys we ever read for the `target` field — all opaque identifiers
// (never free-text values, reasons, drafts, or PII). Narrowing this set keeps a future
// writer that stores free-text under a different key from latently leaking through.
const SAFE_TARGET_KEYS = [
  "instance_id",
  "proc_key",
  "process_key",
  "grant_id",
  "assignment_id",
  "role_id",
  "agentEmployeeId",
  "task_id",
  "record_id",
] as const;

function safeTarget(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  for (const k of SAFE_TARGET_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 128) return v;
  }
  return null;
}

/**
 * Project a raw audit row to the REDACTED wire item. The ONLY payload field read is a
 * SAFE target identifier (allow-listed keys). Everything else in payload/scope/subject
 * (free-text reasons, drafts, record values, secrets) is DROPPED here and never reaches
 * the response.
 */
function toAuditItem(row: AuditRow): AuditLogItem {
  return {
    id: row.id,
    ts: Number(row.occurred_at),
    actor: row.actor,
    action: row.type,
    summary: summaryFor(row.type),
    target: safeTarget(row.payload),
  };
}

// ---------------------------------------------------------------------------
// LIKE-escape: neutralise LIKE wildcards (% _ \) in a user-supplied prefix so the
// filter is a literal prefix match, then append a single trailing % (the wildcard).
// Returned value is passed as a BOUND parameter ($N) — never interpolated.
// ---------------------------------------------------------------------------

function likePrefixParam(prefix: string): string {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `${escaped}%`;
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

export interface AuditReadFilters {
  /** exact-match actor (employee slug or UUID); null = no actor filter. */
  readonly actor: string | null;
  /** action TYPE prefix (e.g. "grant"); null = no action filter. */
  readonly action: string | null;
}

/**
 * Read one page of the tenant-wide audit log from the REAL audit_event table.
 *
 * MUST be called with `client` already inside a tenant-scoped tx (SET LOCAL
 * choros.tenant_id = '<actor-tenant>' + FORCE RLS). This DAO does NOT open a tx and
 * assumes the authz gate has already passed upstream.
 *
 * @param client   a tenant-scoped pg client (RLS + literal tenant predicate).
 * @param tenantId the actor's resolved tenant (literal WHERE guard, defence-in-depth).
 * @param limit    page size, already clamped by the caller.
 * @param cursor   keyset cursor (null = first/newest page).
 * @param filters  optional actor (exact) + action (type-prefix) filters — parameterised.
 * @returns one page of REDACTED audit items + nextCursor.
 */
export async function readAuditLog(
  client: PgClientLike,
  tenantId: string,
  limit: number,
  cursor: AuditLogCursor | null,
  filters: AuditReadFilters = { actor: null, action: null },
): Promise<AuditLogPage> {
  const params: unknown[] = [tenantId];
  const conds: string[] = ["tenant_id = $1"];

  // Optional filters — ALWAYS bound as parameters ($N), never interpolated.
  if (filters.actor !== null && filters.actor !== "") {
    params.push(filters.actor);
    conds.push(`actor = $${params.length}`);
  }
  if (filters.action !== null && filters.action !== "") {
    params.push(likePrefixParam(filters.action));
    // ESCAPE '\' makes the backslash the escape char for the neutralised wildcards.
    conds.push(`type LIKE $${params.length} ESCAPE '\\'`);
  }

  // Keyset: ORDER BY occurred_at DESC, id DESC. "after cursor" (older) means:
  //   occurred_at < cursor.ts  OR  (occurred_at = cursor.ts AND id < cursor.id)
  if (cursor !== null) {
    params.push(cursor.ts);
    const tsParam = `$${params.length}`;
    params.push(cursor.id);
    const idParam = `$${params.length}`;
    conds.push(
      `(occurred_at < ${tsParam} OR (occurred_at = ${tsParam} AND id < ${idParam}))`,
    );
  }

  // Fetch limit+1 to detect a next page without COUNT(*).
  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  const res = await client.query(
    `SELECT id, type, actor, payload, occurred_at
       FROM choros.audit_event
      WHERE ${conds.join(" AND ")}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
  const rows = res.rows as AuditRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: AuditLogItem[] = pageRows.map(toAuditItem);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]!;
    nextCursor = encodeAuditCursor({ ts: last.ts, id: last.id });
  }

  return { items, nextCursor, limit };
}
