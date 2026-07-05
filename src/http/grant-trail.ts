/**
 * src/http/grant-trail.ts
 *
 * T-0031: HTTP route for the grant trail read API.
 * T-0514: Tenant isolation — resolve actor's REAL tenant via resolveActorTenant
 *         (same pattern as spend.ts / registry-defs.ts). Falls back to
 *         DEV_TENANT_ID only when no resolver is wired (no-DB degrade).
 *
 * Registers: GET /api/grant-trail
 *
 * DESIGN INVARIANTS (ADR §4.3):
 *  - Auth: X-Dev-User header (dev) or JWT sub (keycloak) for actor resolution.
 *  - Tenant: actor's REAL tenant resolved via resolveActorTenant (fail-closed).
 *  - Static fallback: when DATABASE_URL is absent, returns TRAIL seed data reformatted
 *    to GrantTrailRow shape (NF-8 / AC-18).
 *  - Validation: limit 1..500; before_seq must be integer if present.
 *  - HTTP error codes are machine-readable (NF-7): 400 INVALID_PARAM.
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { queryGrantTrail, type GrantTrailRow } from "../db/audit-grant-trail.js";
import { getOrgPool, DEV_TENANT_ID, resolveActorSlugFromAuth } from "../db/org.js";
import { batchResolveActors, type ResolvedActor } from "../db/actor-resolver.js";

// ---------------------------------------------------------------------------
// Deps — injectable for tests and server.ts wiring.
// ---------------------------------------------------------------------------

/** Resolver that maps an actor slug to their real tenant UUID (fail-closed). */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface GrantTrailRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Static seed — reformatted TRAIL from ra-data.jsx to GrantTrailRow shape.
// Used when DATABASE_URL is absent (NF-8 / AC-18).
// The ts field from ra-data.jsx is stored as a human-readable string;
// we convert it to epoch-ms for the GrantTrailRow.occurred_at field.
// ---------------------------------------------------------------------------

const TRAIL_SEED: GrantTrailRow[] = [
  {
    seq: 10,
    id: "grt-9f4a2c",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-250",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749383066318,
  },
  {
    seq: 9,
    id: "grt-9f49b1",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-50",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin-approve", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "registry", operation: "write" },
    occurred_at: 1749382724901,
  },
  {
    seq: 8,
    id: "grt-9f49b0",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-50",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin-approve", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749382724901,
  },
  {
    seq: 7,
    id: "grt-9f3d77",
    type: "grant.revoke",
    actor: "А. Кравцова",
    subject: "role-cs-l2",
    scope: { kind: "interval", axis: "payment", lo: 0, hi: 30000 },
    proposed_by: "human",
    confirmed_by: "А. Кравцова",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749375139044,
  },
  {
    seq: 6,
    id: "grt-9f2a10",
    type: "assignment.create",
    actor: "policy-sync",
    subject: "e-triage",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs-l1", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { roleId: "role-cs-l1" },
    occurred_at: 1749370502560,
  },
  {
    seq: 5,
    id: "grt-9e88c3",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-cs-l1",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749320031222,
  },
  {
    seq: 4,
    id: "grt-9e71fa",
    type: "grant.create",
    actor: "А. Кравцова",
    subject: "role-fin-escrcv",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "А. Кравцова",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749312450119,
  },
  {
    seq: 3,
    id: "grt-9e6d05",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-plat-ledger",
    scope: { kind: "node", hierarchy: "org", nodeId: "plat", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749295650005,
  },
  {
    seq: 2,
    id: "grt-9e2b88",
    type: "grant.create",
    actor: "Д. Гаврилов",
    subject: "role-fin-recon",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "Д. Гаврилов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749267108005,
  },
  {
    seq: 1,
    id: "grt-9d04f1",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-cs-l2",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749228913840,
  },
];

// ---------------------------------------------------------------------------
// extractQueryParams — parse and validate all query params from the request URL.
// Throws HttpError(400, "INVALID_PARAM") on invalid input (NF-7).
// ---------------------------------------------------------------------------

type ParsedGrantTrailParams = {
  roleId?: string;
  actor?: string;
  subject?: string;
  limit: number;
  beforeSeq?: number;
};

function extractQueryParams(req: IncomingMessage): ParsedGrantTrailParams {
  const rawUrl = req.url ?? "/";
  const questionIdx = rawUrl.indexOf("?");
  const query = questionIdx === -1 ? "" : rawUrl.slice(questionIdx + 1);
  const params = new URLSearchParams(query);

  const roleId = params.get("role_id") ?? undefined;
  const actor = params.get("actor") ?? undefined;
  const subject = params.get("subject") ?? undefined;

  // limit: default 100, max 500
  const limitRaw = params.get("limit");
  let limit = 100;
  if (limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      throw new HttpError(400, "INVALID_PARAM", "limit must be an integer 1–500");
    }
    if (n > 500) {
      throw new HttpError(400, "INVALID_PARAM", "limit must be an integer 1–500");
    }
    limit = n;
  }

  // before_seq: optional, must be non-negative integer if present
  const beforeSeqRaw = params.get("before_seq");
  let beforeSeq: number | undefined;
  if (beforeSeqRaw !== null && beforeSeqRaw !== "") {
    const n = Number(beforeSeqRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, "INVALID_PARAM", "before_seq must be an integer");
    }
    beforeSeq = n;
  }

  return { roleId, actor, subject, limit, beforeSeq };
}

// ---------------------------------------------------------------------------
// extractActor — mode-aware actor resolution (mirrors agents.ts::extractActor
// — T-0371/T-0633: keycloak mode resolves the JWT sub/preferred_username to
// the REAL employee slug via resolveActorSlugFromAuth before it drives tenant
// resolution — a seeded persona's KC sub is a random UUID, not its slug).
// Dev mode: x-dev-user header, unchanged.
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
// registerGrantTrailRoutes — main export. Registers GET /api/grant-trail.
//
// The deps parameter is optional for backwards-compatibility — when absent (or
// when DATABASE_URL is not set) the route returns the static TRAIL_SEED data
// (NF-8 / AC-18). When deps are provided, the actor's REAL tenant is resolved
// via deps.resolveActorTenant (T-0514); falls back to DEV_TENANT_ID only when
// no resolver is wired (no-DB degrade), exactly as registry-defs.ts does.
// ---------------------------------------------------------------------------

/**
 * GrantTrailRowWithDisplay — GrantTrailRow (unchanged, wire-frozen) plus THREE
 * additive optional fields carrying the T-0648 batch-resolved actor/subject/
 * confirmer display shape ({id, name, type, deactivated}). ADDITIVE ONLY:
 * `actor`/`subject`/`confirmed_by` on the row keep their original raw-string
 * shape (existing readers/tests are untouched) — the frontend prefers
 * `actorResolved`/`subjectResolved`/`confirmedResolved` when present and falls
 * back to the raw string otherwise.
 *
 * T-0685: `confirmedResolved` added — the «КТО-ПОДТВЕРДИЛ» (confirmed_by) actor
 * is the THIRD identifier column on /rights/trail (alongside «КТО-ВЫДАЛ» actor
 * and «КОМУ» subject); the capstone T-0647 live-proof showed a raw
 * employee-UUID leaking there too when confirmed_by holds a UUID/slug the seed
 * fixtures never showed (they carry human display names).
 */
type GrantTrailRowWithDisplay = GrantTrailRow & {
  actorResolved?: ResolvedActor;
  subjectResolved?: ResolvedActor;
  confirmedResolved?: ResolvedActor;
};

/**
 * T-0648/T-0685: batch-resolve every DISTINCT actor/subject/confirmer in a page
 * of grant-trail rows in ONE query (batchResolveActors) — not one lookup per
 * row. `subject` on an assignment/grant event is sometimes a role slug (not an
 * employee), so an unresolved subject simply keeps no `subjectResolved` field
 * (the frontend falls back to the raw string, exactly as it does today).
 */
async function attachResolvedActors(
  pool: pg.Pool,
  tenantId: string,
  rows: GrantTrailRow[],
): Promise<GrantTrailRowWithDisplay[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.actor) ids.add(r.actor);
    if (r.subject) ids.add(r.subject);
    if (r.confirmed_by) ids.add(r.confirmed_by);
  }
  if (ids.size === 0) return rows;

  let resolved: Map<string, ResolvedActor>;
  try {
    resolved = await batchResolveActors(pool, tenantId, [...ids]);
  } catch {
    // Degrade gracefully: read-projection, never a write path.
    return rows;
  }

  return rows.map((r) => ({
    ...r,
    ...(r.actor && resolved.has(r.actor) ? { actorResolved: resolved.get(r.actor) } : {}),
    ...(r.subject && resolved.has(r.subject) ? { subjectResolved: resolved.get(r.subject) } : {}),
    ...(r.confirmed_by && resolved.has(r.confirmed_by) ? { confirmedResolved: resolved.get(r.confirmed_by) } : {}),
  }));
}

export function registerGrantTrailRoutes(router: Router, deps?: GrantTrailRouteDeps): void {
  router.register("GET", "/api/grant-trail", withAuth(async (req, res) => {
    const parsed = extractQueryParams(req);

    let rows: GrantTrailRowWithDisplay[];
    let hasMore: boolean;

    const dbPool: pg.Pool | undefined = deps?.pool ?? (process.env["DATABASE_URL"] ? getOrgPool() : undefined);

    if (dbPool) {
      // T-0514: resolve actor's REAL tenant via resolveActorTenant (fail-closed).
      // Falls back to DEV_TENANT_ID only when no resolver is wired (no-DB degrade).
      // Mirrors the pattern established in registry-defs.ts (T-0177 fix) and spend.ts.
      const actor = await extractActor(req, dbPool);
      const tenantId = deps?.resolveActorTenant
        ? await deps.resolveActorTenant(actor)
        : DEV_TENANT_ID;

      const result = await queryGrantTrail(dbPool, tenantId, {
        roleId: parsed.roleId,
        actor: parsed.actor,
        subject: parsed.subject,
        limit: parsed.limit,
        beforeSeq: parsed.beforeSeq,
      });
      // T-0648: batch-resolve actor/subject display shape in ONE additional
      // query (no N+1) — additive fields only, raw actor/subject unchanged.
      rows = await attachResolvedActors(dbPool, tenantId, result.rows);
      hasMore = result.hasMore;
    } else {
      // Static fallback — no DATABASE_URL (NF-8 / AC-18).
      let seedRows = TRAIL_SEED;

      // Apply client-side filters to seed data to honour AC-13 / AC-14 / AC-15.
      if (parsed.actor !== undefined) {
        seedRows = seedRows.filter((r) => r.actor === parsed.actor);
      }
      if (parsed.subject !== undefined) {
        seedRows = seedRows.filter((r) => r.subject === parsed.subject);
      }
      if (parsed.roleId !== undefined) {
        seedRows = seedRows.filter(
          (r) =>
            r.subject === parsed.roleId ||
            (r.payload !== null &&
              typeof r.payload === "object" &&
              (r.payload as Record<string, unknown>)["roleId"] === parsed.roleId),
        );
      }
      if (parsed.beforeSeq !== undefined) {
        seedRows = seedRows.filter((r) => r.seq < parsed.beforeSeq!);
      }

      // Limit + hasMore for seed data
      const limitedRows = seedRows.slice(0, parsed.limit + 1);
      hasMore = limitedRows.length > parsed.limit;
      rows = hasMore ? limitedRows.slice(0, parsed.limit) : limitedRows;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rows, hasMore }));
  }));
}
