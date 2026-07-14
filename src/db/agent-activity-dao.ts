/**
 * src/db/agent-activity-dao.ts — T-0499 [E-AGENTS] Agent activity reader.
 *
 * Reads an AGENT's outcome events from the REAL hash-chained audit_log
 * (choros.audit_event, migration 006) — the events `appendAuditEvent` writes from
 * src/runtime/agent-dispatch/dispatch-outcome.ts:
 *
 *   agent.proceeded — the agent answered and the step result was written.
 *   agent.deferred  — the agent escalated to a human (the inbox task is the event).
 *   agent.blocked   — the agent fail-closed (precheck/authz denied, no step close).
 *
 * AGENT IDENTITY (read from dispatch-outcome.ts): the dispatching agent is the
 * audit-event ACTOR — `actor = ctx.agentEmployeeId` (an employee UUID). The
 * `subject` field carries the decorated form `"agent:<employeeId>"`, but the
 * canonical, un-prefixed identity is `actor`. We therefore filter on
 *   actor = $2  AND  type IN ('agent.proceeded','agent.deferred','agent.blocked')
 * — the agent's own outcome stream, nothing else.
 *
 * TENANT-SCOPE (CRITICAL, the Враг target): the SELECT runs against a client the
 * caller has already put under SET LOCAL choros.tenant_id (RLS FORCE, migration
 * 006 policy audit_event_tenant_isolation) AND carries an explicit
 * `WHERE tenant_id = $1` predicate (defence-in-depth — RLS + literal). A caller
 * in tenant A can NEVER read tenant B's audit rows.
 *
 * PAGINATION: keyset (occurred_at, id) DESC — newest first — mirroring the records
 * cursor pattern (listRecordsPaginated / data-access-port.ts). Fetches limit+1 to
 * detect a next page without COUNT(*). `limit` is clamped by the caller.
 *
 * REDACTION (the security spine of this read — audit EXPOSURE): the audit payload
 * for these events can carry free-text reasons and an F5 agent draft. We NEVER
 * surface raw payload. `toActivityItem` projects ONLY a fixed allow-list of safe
 * fields (outcome type, time, process_key, instance_id, a short human summary).
 * The raw `payload`/`scope`/`agent_draft`/`doubt_reason` free-text and any secret
 * sentinel are dropped at the projection boundary — they never reach the wire.
 */

import type { PgClientLike } from "./audit-writer.js";

// ---------------------------------------------------------------------------
// The three agent-outcome audit types (exact strings from dispatch-outcome.ts).
// ---------------------------------------------------------------------------

export type AgentOutcome = "proceeded" | "deferred" | "blocked";

const AGENT_ACTION_TYPES = [
  "agent.proceeded",
  "agent.deferred",
  "agent.blocked",
] as const;

/** Map an audit-event `type` to the wire `outcome` (or null if not an agent type). */
function outcomeOf(type: string): AgentOutcome | null {
  switch (type) {
    case "agent.proceeded":
      return "proceeded";
    case "agent.deferred":
      return "deferred";
    case "agent.blocked":
      return "blocked";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Redacted wire shape — ONLY safe fields. No raw payload, no secrets, no LLM text.
// ---------------------------------------------------------------------------

export interface AgentActivityItem {
  /** audit_event.id (UUID) — also the keyset tiebreaker / inbox_task_id for defers. */
  readonly id: string;
  /** occurred_at epoch ms (audit clock). */
  readonly ts: number;
  /** the outcome class — proceeded | deferred | blocked. */
  readonly outcome: AgentOutcome;
  /** the process key the step belonged to (safe — config identifier, not data). */
  readonly process_key: string | null;
  /** the engine instance id (safe — an opaque identifier). */
  readonly instance_id: string | null;
  /**
   * The BPMN step / activity, when present in payload (safe identifier). Most
   * agent events carry proc_key + instance_id but not a discrete step; null then.
   */
  readonly step: string | null;
  /**
   * A SHORT, human-classified one-liner derived from the outcome type only —
   * NEVER the raw doubt_reason / deny_reason free-text (which may quote an LLM
   * answer or sensitive context). Kept terse + canned per outcome.
   */
  readonly summary: string | null;
}

export interface AgentActivityPage {
  readonly items: AgentActivityItem[];
  /** opaque cursor for the next (older) page; null on the last page. */
  readonly nextCursor: string | null;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Cursor — keyset on (occurred_at, id) DESC. Opaque base64url JSON.
// ---------------------------------------------------------------------------

export interface AgentActivityCursor {
  readonly ts: number; // occurred_at epoch ms
  readonly id: string; // audit_event.id (UUID)
}

export function encodeActivityCursor(c: AgentActivityCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeActivityCursor(raw: string): AgentActivityCursor | null {
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
// Raw row shape (only the columns we read + project).
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  type: string;
  payload: unknown; // jsonb — node-postgres returns a parsed object
  occurred_at: string | number; // bigint comes back as a string
}

/**
 * Canned, outcome-only human summary. INTENTIONALLY does NOT echo any free-text
 * from the payload (doubt_reason / deny_reason / agent_draft) — those can quote an
 * LLM answer or sensitive context and are out of scope for this read surface.
 */
function summaryFor(outcome: AgentOutcome): string {
  switch (outcome) {
    case "proceeded":
      return "Агент выполнил шаг самостоятельно";
    case "deferred":
      return "Агент передал решение человеку";
    case "blocked":
      return "Агент остановился (нет прав или сработала проверка)";
  }
}

/**
 * Project a raw audit row to the REDACTED wire item. The ONLY payload fields read
 * are proc_key / instance_id / step — all safe identifiers. Everything else in the
 * payload (free-text reasons, agent_draft, signal, defer_*) is DROPPED here and
 * never reaches the response.
 */
function toActivityItem(row: AuditRow): AgentActivityItem | null {
  const outcome = outcomeOf(row.type);
  if (outcome === null) return null;

  const payload =
    row.payload !== null &&
    typeof row.payload === "object" &&
    !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};

  const procKey = payload["proc_key"];
  const instanceId = payload["instance_id"];
  // Allowlist hardening (T-0499 adversarial review): read ONLY the explicit
  // `step` key — a short BPMN step identifier — and DO NOT widen to `activity`.
  // Narrowing the projected key-set keeps a future writer that ever stored
  // free-text under `activity` from latently surfacing through this redaction
  // boundary. All projected fields are short identifiers, never free-text.
  const step = payload["step"];

  return {
    id: row.id,
    ts: Number(row.occurred_at),
    outcome,
    process_key: typeof procKey === "string" ? procKey : null,
    instance_id: typeof instanceId === "string" ? instanceId : null,
    step: typeof step === "string" ? step : null,
    summary: summaryFor(outcome),
  };
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/**
 * Read one page of an agent's outcome events from the REAL audit log.
 *
 * MUST be called with `client` already inside a tenant-scoped tx (SET LOCAL
 * choros.tenant_id = '<actor-tenant>' + FORCE RLS). This DAO does NOT open a tx.
 *
 * @param client     a tenant-scoped pg client (RLS + literal tenant predicate).
 * @param tenantId   the actor's resolved tenant (literal WHERE guard, defence-in-depth).
 * @param agentId    the agent employee UUID (audit `actor`); validated upstream.
 * @param limit      page size, already clamped by the caller.
 * @param cursor     keyset cursor (null = first/newest page).
 * @returns one page of REDACTED activity items + nextCursor.
 */
export async function readAgentActivity(
  client: PgClientLike,
  tenantId: string,
  agentId: string,
  limit: number,
  cursor: AgentActivityCursor | null,
): Promise<AgentActivityPage> {
  const params: unknown[] = [tenantId, agentId, AGENT_ACTION_TYPES as unknown as string[]];
  const conds: string[] = [
    "tenant_id = $1",
    "actor = $2",
    "type = ANY($3)",
  ];

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
    `SELECT id, type, payload, occurred_at
       FROM choros.audit_event
      WHERE ${conds.join(" AND ")}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
  const rows = res.rows as AuditRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: AgentActivityItem[] = [];
  for (const r of pageRows) {
    const item = toActivityItem(r);
    if (item !== null) items.push(item);
  }

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1]!;
    nextCursor = encodeActivityCursor({ ts: last.ts, id: last.id });
  }

  return { items, nextCursor, limit };
}
