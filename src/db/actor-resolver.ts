/**
 * src/db/actor-resolver.ts — T-0648 batch actor display resolver.
 *
 * WHY (D-064 finding, docs/design/ux-study-2026-07-05.md §3): every reader of
 * a raw actor identifier (inbox claimedBy, audit_event.actor, grant-trail
 * actor/subject, operational-analytics top_actors, process-instance
 * completedBy) surfaced the bare employee SLUG (occasionally an unresolved
 * UUID) to the end user instead of a human name. `findEmployeeById` (org.ts)
 * already solves this for ONE slug at a time, but every caller that needs to
 * resolve a LIST of actors (a page of N rows) either skipped resolution
 * entirely or would have had to call findEmployeeById in a loop — an N+1 DB
 * fan-out (T-0380's own comment on resolveExecutorFallbackBatch documents the
 * same anti-pattern being fixed once for the inbox fallback path; this module
 * is the GENERIC sibling for actor *display* resolution, reused everywhere).
 *
 * CONTRACT: batchResolveActors(pool, tenantId, ids) issues EXACTLY ONE SQL
 * query for the whole batch (`WHERE tenant_id = $1 AND slug = ANY($2::text[])`),
 * regardless of how many distinct ids are requested — O(1) additional queries
 * per page, not O(N). Callers dedupe by building a `Set` before calling (the
 * function also dedupes internally as a second line of defence).
 *
 * WHAT COUNTS AS AN "ACTOR": any row in choros.employee — kind='human' or
 * kind='agent'. There is no separate service-actor table in this schema
 * (016_employee.sql: "service workers (s-ledger, s-ocr) map to kind='agent'
 * (two-value constraint)"); a "service" is simply an agent-kind employee whose
 * slug follows the `s-` convention. This module surfaces the DB's real `kind`
 * for human/agent; the caller (ActorChip) decides whether to draw a distinct
 * "service" glyph for agent-kind rows using a slug/id-shape heuristic — this
 * module ITSELF never invents a third kind that the schema does not have.
 *
 * AGENT NAMES: an agent's display name is `choros.employee.display_name` —
 * agent_card carries NO name/title column of its own (032_agent_card.sql /
 * 093_agent_taxonomy_employee_nullable.sql: the card is a per-agent CONFIG
 * row — kc_client_id, LLM wiring — keyed by employee_id; the human-readable
 * name always lives on the joined employee row, exactly like a human). So a
 * single `choros.employee` query resolves BOTH kinds with no join to
 * agent_card at all.
 *
 * UNRESOLVED IDS: an id that matches no employee row (already-deleted actor,
 * a raw UUID nobody ever backfilled a slug for, a synthetic system actor like
 * "control-plane"/"policy-sync") is NOT an error — the caller gets back a Map
 * that simply lacks that key. Callers must supply their own honest fallback
 * (typically: render the id itself in a MonoId, never throw).
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// Wire shape — the resolved actor as ActorChip (frontend) expects it.
// ---------------------------------------------------------------------------

/** DB-level kind (choros.employee.kind — the only two values the schema has). */
export type EmployeeKind = "human" | "agent";

/**
 * Display-level type. Widens EmployeeKind with a "service" bucket for DISPLAY
 * ONLY (see displayTypeFor below) — an agent-kind employee whose slug follows a
 * service naming convention (prefix "s-", "svc-", "system-", or suffix "-sync",
 * "-gateway", "-bridge") already used by the dev-seed fixtures (migrations/016_
 * employee.sql: "service workers (s-ledger, s-ocr) map to kind='agent'") renders
 * with the distinct service glyph. This NEVER changes `kind` in the DB and never
 * feeds back into authz — it only picks which of the three existing ExecGlyph
 * shapes to draw.
 */
export type ActorKind = "human" | "agent" | "service";

export interface ResolvedActor {
  /** The employee slug (the SAME string used as the lookup key). */
  readonly id: string;
  /** choros.employee.display_name. */
  readonly name: string;
  /** display bucket — see ActorKind. */
  readonly type: ActorKind;
  /** true when the employee row is soft-deactivated (migration 125). */
  readonly deactivated: boolean;
  /** true when `id` matched a real choros.employee row (false ⇒ honest fallback). */
  readonly resolved: boolean;
}

// ---------------------------------------------------------------------------
// Service-slug display heuristic — generic naming CONVENTION, not case content.
// ---------------------------------------------------------------------------

const SERVICE_SLUG_PREFIXES = ["s-", "svc-", "system-"] as const;
const SERVICE_SLUG_SUFFIXES = ["-sync", "-gateway", "-bridge"] as const;

function displayTypeFor(kind: EmployeeKind, slug: string): ActorKind {
  if (kind === "human") return "human";
  const lower = slug.toLowerCase();
  if (
    SERVICE_SLUG_PREFIXES.some((p) => lower.startsWith(p)) ||
    SERVICE_SLUG_SUFFIXES.some((s) => lower.endsWith(s))
  ) {
    return "service";
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// withTenant — local copy of the established T-0013 pattern (org.ts /
// audit-grant-trail.ts / operational-analytics-dao.ts all carry their own
// byte-identical copy — see audit-grant-trail.ts's own comment on why a
// shared extraction is a separate, out-of-scope refactor).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
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

/**
 * batchResolveActors — resolve a list of actor identifiers (employee slugs;
 * an already-known-non-employee string like "control-plane" simply comes back
 * absent from the Map) to their display shape, in ONE query.
 *
 * NO N+1: exactly one `SELECT ... WHERE slug = ANY($2::text[])` regardless of
 * how many distinct ids are passed (callers should still dedupe before
 * calling — this function also dedupes internally so a caller that forgets
 * still gets the O(1)-query guarantee, just with a marginally larger IN-list).
 *
 * Empty input short-circuits to an empty Map with ZERO queries (callers that
 * pass no ids should not pay a round-trip).
 */
export async function batchResolveActors(
  pool: pg.Pool,
  tenantId: string,
  ids: ReadonlyArray<string>,
): Promise<Map<string, ResolvedActor>> {
  const result = new Map<string, ResolvedActor>();
  const distinct = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (distinct.length === 0) return result;

  return withTenant(pool, tenantId, async (client) => {
    // Match by slug OR by id (both are tried in the same query): most callers hold
    // an employee SLUG (the intended, common shape), but a few older write paths
    // stored the employee UUID (`id`) instead — resolving both keeps this a single
    // generic entry point rather than forcing every caller to know which shape it
    // has (mirrors the same defensive choice already made for tenant resolution
    // elsewhere in db/org.ts).
    const { rows } = await client.query<{
      slug: string;
      id: string;
      display_name: string;
      kind: EmployeeKind;
      deactivated_at: string | null;
    }>(
      `SELECT slug, id::text AS id, display_name, kind, deactivated_at
         FROM choros.employee
        WHERE tenant_id = $1 AND (slug = ANY($2::text[]) OR id::text = ANY($2::text[]))`,
      [tenantId, distinct],
    );

    for (const row of rows) {
      const resolvedActor: ResolvedActor = {
        id: row.slug,
        name: row.display_name,
        type: displayTypeFor(row.kind, row.slug),
        deactivated: row.deactivated_at != null,
        resolved: true,
      };
      // Index by BOTH the slug and the raw id unconditionally — a caller that
      // looked up by slug can still find the SAME resolved entry via the raw id
      // (and vice versa), which is useful when a page mixes both shapes (e.g.
      // one column keyed by slug, another by employee_id). Callers that only
      // care about "one entry per input id" should read resolved.get(id) for
      // each id in THEIR OWN list rather than relying on Map.size.
      result.set(row.slug, resolvedActor);
      result.set(row.id, resolvedActor);
    }

    return result;
  });
}

/**
 * resolveActorDisplay — convenience accessor for a Map produced by
 * batchResolveActors: returns the resolved actor, or an honest fallback shape
 * (type defaults to "service" — an unresolved id is usually a system
 * pseudo-actor like "control-plane"/"policy-sync", never a fabricated human/
 * agent identity — name falls back to the raw id) when the id did not
 * resolve. Callers that must distinguish "resolved" from "fallback" should
 * read the Map directly, or check `.resolved` on the returned shape instead.
 */
export function resolveActorDisplay(
  resolved: ReadonlyMap<string, ResolvedActor>,
  id: string | null | undefined,
): ResolvedActor {
  if (id === null || id === undefined || id === "") {
    return { id: "", name: "—", type: "service", deactivated: false, resolved: false };
  }
  const hit = resolved.get(id);
  if (hit) return hit;
  // Unresolved: a system pseudo-actor ("control-plane"/"policy-sync" — see
  // src/http/audit.ts / src/http/grant-trail.ts) or any other unmatched id
  // (unresolvable KC sub, stale slug). Never invent a human/agent identity for
  // an id we could not verify — "service" is the least-alarming honest default,
  // and `resolved:false` lets a caller distinguish this from a real service.
  return { id, name: id, type: "service", deactivated: false, resolved: false };
}
