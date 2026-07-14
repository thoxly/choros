/**
 * src/db/org-ancestry.ts — T-0515: per-tenant org-ancestry oracle, built from
 * the REAL choros.department adjacency tree.
 *
 * THE BUG THIS FIXES: src/http/seed-ancestry.ts::SEED_ORACLE answered org
 * ancestry from a HARDCODED map of the dev-seed topology (partly fictional
 * sub-slugs). Any tenant whose org tree differs from the seed got WRONG grant
 * scoping — delegation/coverage was computed against a fake tree. This module
 * replaces that source with the tenant's actual department parent_id chain.
 *
 * loadTenantOrgAncestry(q, tenantId):
 *   - Runs ONE tenant-scoped query: SELECT id, parent_id FROM choros.department
 *     WHERE tenant_id = $1.
 *   - The explicit `WHERE tenant_id = $1` AND the RLS policy
 *     (department_tenant_isolation, keyed on the choros.tenant_id GUC) BOTH apply:
 *       * given a pool → we open our OWN short tenant-scoped tx (SET LOCAL
 *         choros.tenant_id) so the GUC is set exactly as every other handler tx;
 *       * given an already-open client → we assume the caller's open tenant tx
 *         has the GUC set (it always does — handlers use withTenantTx), and run
 *         the SELECT on it.
 *     RLS is NEVER bypassed; the explicit predicate is additive defence (it also
 *     scopes the result for a BYPASSRLS migrator connection used in tests/CI,
 *     mirroring src/db/org.ts's T-0141 pattern).
 *   - Builds an in-memory adjacency map (ancestor id → direct child ids) keyed by
 *     department id (string), then returns a SYNCHRONOUS AncestryOracle via the
 *     SHARED traversal `makeOrgAncestryOracle` (src/http/seed-ancestry.ts) — so
 *     the DB-backed oracle and SEED_ORACLE walk identical containment logic and
 *     differ ONLY in the map source.
 *
 * The AncestryOracle interface is synchronous (the pure-core lattice/scoped-admin
 * code calls it synchronously). Loading is async (one DB round-trip), but the
 * returned oracle is sync — handlers `await loadTenantOrgAncestry(...)` ONCE,
 * before the synchronous validate-/covers-/isNarrower- call, then pass the oracle.
 */

import type pg from "pg";
import type { AncestryOracle } from "../core/grant-lattice.js";
import { makeOrgAncestryOracle } from "../http/seed-ancestry.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

function isPool(q: pg.Pool | pg.PoolClient): q is pg.Pool {
  // pg.Pool exposes `connect()` returning a client; PoolClient exposes `release()`.
  // PoolClient has `release`; Pool does not. This is the cleanest structural test.
  return typeof (q as { release?: unknown }).release !== "function";
}

const SELECT_DEPARTMENTS =
  `SELECT id, parent_id FROM choros.department WHERE tenant_id = $1`;

type DeptRow = { id: string; parent_id: string | null };

/**
 * buildChildrenMap — adjacency map (ancestor id → direct child ids) from the rows.
 * A row with parent_id = NULL is a root (it appears as a child of nobody). The
 * map keys/values are department ids (strings). Ids absent from the map have no
 * children (the shared walk treats a missing key as an empty child list).
 */
function buildChildrenMap(rows: readonly DeptRow[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    // Ensure every department appears as a key (so a leaf is known to exist with
    // no children — harmless for the walk, but keeps the map complete).
    if (!children.has(r.id)) children.set(r.id, []);
    if (r.parent_id != null) {
      const siblings = children.get(r.parent_id);
      if (siblings) siblings.push(r.id);
      else children.set(r.parent_id, [r.id]);
    }
  }
  return children;
}

/**
 * loadTenantOrgAncestry — load the tenant's real department tree and return a
 * synchronous AncestryOracle over it.
 *
 * @param q        a pg.Pool (we open our own tenant-scoped tx) OR an already-open
 *                 pg.PoolClient inside the caller's tenant tx (GUC already set).
 * @param tenantId the tenant whose tree to load — used in the explicit WHERE and
 *                 (for the pool path) as the RLS GUC.
 */
export async function loadTenantOrgAncestry(
  q: pg.Pool | pg.PoolClient,
  tenantId: string,
): Promise<AncestryOracle> {
  assertUuid(tenantId, "tenantId");

  let rows: DeptRow[];
  if (isPool(q)) {
    // Pool path: open our own short tenant-scoped tx so the RLS GUC is set
    // exactly like every other handler transaction (withTenantTx pattern).
    const client = await q.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");
      const res = await client.query<DeptRow>(SELECT_DEPARTMENTS, [tenantId]);
      await client.query("COMMIT");
      rows = res.rows;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Client path: run on the caller's already-open tenant tx (GUC already set
    // by the surrounding withTenantTx). The explicit WHERE scopes the result.
    const res = await (q as pg.PoolClient).query<DeptRow>(SELECT_DEPARTMENTS, [
      tenantId,
    ]);
    rows = res.rows;
  }

  return makeOrgAncestryOracle(buildChildrenMap(rows));
}

// Exposed for unit testing of the map-building step in isolation.
export const __test = { buildChildrenMap };
