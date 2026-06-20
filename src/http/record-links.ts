/**
 * src/http/record-links.ts — T-0352 [E16]
 *
 * GET /api/records/:id/links — 1-hop LIVE cross-app projection for the record card.
 *
 * §6 Resolution Policy (process-ui-binding-and-entry-points.md §6):
 *   • List view = native fields + denormalized snapshot (NO resolution here).
 *   • Card view = 1-hop resolved LIVE, lazy on section expand.
 *   • Aggregates/rollup = materialized via event-log outbox (S3 — future).
 *   • Deeper than hop-cap → separate report.
 *
 * This module implements the CARD policy: lazy, 1-hop, per-section expand.
 * The FE calls this endpoint when the user expands a linked section.
 *
 * Algorithm:
 *   1. Resolve actor → tenantId (RLS).
 *   2. Fetch the source record's data + registry_id (tenant-scoped TX).
 *   3. List all cross_app_ref definitions for source_registry_id (DAO).
 *   4. For each ref def, call resolveHop (pure core, per-hop ACL + redaction).
 *      The hop fetcher reads target records through the same tenant-scoped TX.
 *   5. Return a labeled projection per ref def:
 *        { refId, label, hop: CrossAppHopResult }
 *        - allowed hop → { allowed: true, targetRecordId, targetRegistryId, fields }
 *        - denied hop  → { allowed: false, reason, redactedProjection }
 *
 * ACL + Redaction per hop:
 *   The CrossAppHopFetcher impl (makeHopFetcher below) fetches the target record
 *   inside the SAME tenant-scoped TX (RLS enforced). A missing record → not_found;
 *   cross-tenant target → cross_tenant denial (structurally impossible via RLS, but
 *   treated as a denial to uphold the "fail-closed" contract). Since we have no
 *   field-level PDP here (no grant resolver threaded to this route), the hop fetcher
 *   returns all fields as-stored; field-level redaction is a future wiring point
 *   (marked // FUTURE: field-level PDP below). The structural ACL (can the caller
 *   see the target record at all) is enforced by the tenant RLS predicate.
 *
 * DB-untested paths: DB round-trips (steps 2–4) require server PG. Unit tests
 *   cover the pure core (cross-app-ref.ts) and the grouping/redaction helpers
 *   (record-links.js). This module's HTTP handler is not unit-tested DB-side
 *   (integration/acceptance test needed on server).
 *
 * Append-only in server.ts (T-0352 constraint):
 *   registerRecordLinksRoutes is appended AFTER the last existing register* call
 *   in buildRouter. No reordering of existing calls.
 *
 * Registers:
 *   GET /api/records/:id/links
 *     → 200 { record_id, links: LinkProjection[] }
 *     → 404 NOT_FOUND  — record not in tenant
 *     → 400 VALIDATION — invalid UUID
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  resolveHop,
  type CrossAppRefDef,
  type CrossAppRefDeps,
  type CrossAppHopFetcher,
  type CrossAppHopResult,
} from "../core/cross-app-ref.js";
import { listCrossAppRefsForSource } from "../db/cross-app-ref-dao.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/** The result of a single cross-app reference hop for a given ref definition. */
export interface LinkProjection {
  /** The cross_app_ref definition UUID. */
  refId: string;
  /** Display label for the section (e.g. «Из договора»). */
  label: string;
  /** The ref field key in the source record JSONB that holds the target UUID. */
  refField: string;
  /** Per-hop ACL result (allowed → fields; denied → redactedProjection). */
  hop: CrossAppHopResult;
}

/** Response shape for GET /api/records/:id/links */
export interface RecordLinksResponse {
  record_id: string;
  links: LinkProjection[];
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface RecordLinksDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors the pattern in records.ts (RLS + choros schema)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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
// extractActor — mirrors records.ts (Keycloak + dev-mode header)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.sub;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Source record fetch — get data + registry_id for a record in tenant
// ---------------------------------------------------------------------------

interface SourceRecordRow {
  id: string;
  registry_id: string;
  data: unknown;
}

async function fetchSourceRecord(
  client: pg.PoolClient,
  tenantId: string,
  recordId: string,
): Promise<SourceRecordRow | null> {
  const res = await client.query<SourceRecordRow>(
    `SELECT id, registry_id, data
       FROM choros.record
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, recordId],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// makeHopFetcher — CrossAppHopFetcher impl backed by a tenant-scoped DB client
//
// Fetches the target record from choros.record inside the SAME tenant-scoped TX.
// RLS enforces tenant isolation; a missing row → not_found.
//
// FUTURE: field-level PDP (grant resolver) would be wired here so that
//   individual fields within the target record are redacted by T-0081 roleFieldVisibility.
//   For now, all accessible fields are returned (structural ACL only via RLS).
// ---------------------------------------------------------------------------

function makeHopFetcher(client: pg.PoolClient, tenantId: string): CrossAppHopFetcher {
  return {
    async fetchHop({ targetRegistryId, targetRecordId }) {
      // Structural ACL: RLS ensures the caller's tenant cannot see other tenants' rows.
      // Cross-tenant protection: if the target_registry_id doesn't belong to the same
      // tenant (impossible via RLS but we check registry ownership for defense).
      const res = await client.query<{ data: unknown; registry_id: string }>(
        `SELECT r.data, r.registry_id
           FROM choros.record r
          WHERE r.tenant_id = $1
            AND r.id = $2`,
        [tenantId, targetRecordId],
      );
      const row = res.rows[0];
      if (!row) {
        return { ok: false, reason: "not_found" };
      }
      // Defense: target record must belong to the expected registry (same tenant by RLS).
      if (row.registry_id !== targetRegistryId) {
        // The ref def points to a different registry than the actual record's registry.
        // Treat as cross_tenant since the pointer is structurally mismatched.
        return { ok: false, reason: "cross_tenant" };
      }
      // FUTURE: apply field-level PDP here (T-0081 roleFieldVisibility via grant resolver).
      const fields: Record<string, unknown> =
        row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : {};
      return { ok: true, fields };
    },
  };
}

// ---------------------------------------------------------------------------
// resolveLinksForRecord — pure orchestration (testable with mock client)
//
// Given a source record row, lists all cross-app ref defs for its registry,
// then resolves 1-hop for each via resolveHop (pure core). Returns an ordered
// array of LinkProjection (one per ref def found). If no ref defs → [].
//
// DB-UNTESTED: This function touches the DB via client; covered by integration
// tests on the server. Unit tests use the pure core directly.
// ---------------------------------------------------------------------------

export async function resolveLinksForRecord(
  client: pg.PoolClient,
  tenantId: string,
  record: SourceRecordRow,
  nowMs?: number, // reserved for future snapshot timestamping (unused)
): Promise<LinkProjection[]> {
  void nowMs;

  // Step 1: list cross_app_ref definitions for this record's registry.
  const refDefs = await listCrossAppRefsForSource(client, tenantId, record.registry_id);
  if (refDefs.length === 0) {
    return [];
  }

  // Step 2: build the hop fetcher (single PDP path via RLS-gated DB).
  const fetcher = makeHopFetcher(client, tenantId);
  const deps: CrossAppRefDeps = { fetcher };

  // Step 3: resolve 1-hop for each ref def (parallel — hops are independent per §6).
  const sourceData: Record<string, unknown> =
    record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};

  const projections: LinkProjection[] = await Promise.all(
    refDefs.map(async (refDef): Promise<LinkProjection> => {
      // Build CrossAppRefDef from the DAO row (depth = 0 for 1-hop card policy).
      const crossAppRefDef: CrossAppRefDef = {
        tenantId,
        id: refDef.id,
        sourceRegistryId: refDef.sourceRegistryId,
        targetRegistryId: refDef.targetRegistryId,
        refField: refDef.refField,
        label: refDef.label,
        refStrength: refDef.refStrength,
        createdAt: 0, // not used by resolveHop
        updatedAt: 0, // not used by resolveHop
      };

      // §6 card policy: 1-hop live, depth=0.
      const hop = await resolveHop(crossAppRefDef, sourceData, 0, deps);

      return {
        refId: refDef.id,
        label: refDef.label,
        refField: refDef.refField,
        hop,
      };
    }),
  );

  return projections;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register GET /api/records/:id/links.
 *
 * Deps-gated: when `deps` is absent (no DATABASE_URL), the route is NOT
 * registered — honest-degrade pattern matching records.ts / applications.ts.
 *
 * Append-only: MUST be appended AFTER the last existing register* call in
 * buildRouter (server.ts). No reordering of existing calls.
 *
 * @param router The Router instance.
 * @param deps   Injected { pool, resolveActorTenant }. Omitted → not registered.
 */
export function registerRecordLinksRoutes(
  router: Router,
  deps?: RecordLinksDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // GET /api/records/:id/links
  // Returns the 1-hop LIVE cross-app projection for the record's card view.
  // Lazy: called by the FE only when a linked section is expanded.
  router.register(
    "GET",
    "/api/records/:id/links",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);

      const result = await withTenantTx(pool, tenantId, async (client) => {
        // Step 1: fetch source record (404 if not in tenant via RLS).
        const record = await fetchSourceRecord(client, tenantId, id);
        if (record === null) {
          return null;
        }

        // Step 2: resolve 1-hop links for each cross_app_ref definition.
        const links = await resolveLinksForRecord(client, tenantId, record);
        return { record_id: id, links } satisfies RecordLinksResponse;
      });

      if (result === null) {
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    }),
  );
}
