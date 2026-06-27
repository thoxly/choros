// T-0515 — live-Postgres behavioral test for loadTenantOrgAncestry (src/db/org-ancestry.ts).
//
// Proves the org-ancestry oracle is built from the tenant's REAL choros.department
// adjacency tree (parent_id chain), NOT from the hardcoded seed map. Seeds a CUSTOM
// asymmetric tree in a FRESH tenant and asserts containment semantics + that the
// query is tenant-scoped (RLS + explicit WHERE).
//
// Tree (per fresh tenant):
//        A (root)
//       / \
//      B   D        (D is A's other child — a sibling subtree of B)
//      |
//      C
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_migrator_dev_pw@localhost:5432/choros \
//     npx vitest run --dir ci/checks/db --no-file-parallelism org-ancestry.db.test.ts \
//     --testTimeout=120000 --hookTimeout=120000

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { appUrl, uuid } from './_helpers.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';

const { Pool } = pg;

// A NOBYPASSRLS app pool — the same connection class the production handlers use.
// RLS (department_tenant_isolation) is enforced; loadTenantOrgAncestry opens its
// own tenant-scoped tx (SET LOCAL choros.tenant_id) exactly like withTenantTx.
const pool = new Pool({ connectionString: appUrl() });

afterAll(async () => {
  await pool.end();
});

/** Seed a tenant + the asymmetric A→B→C, A→D department tree. Returns the ids. */
async function seedCustomTree(): Promise<{
  tenantId: string;
  a: string;
  b: string;
  c: string;
  d: string;
}> {
  const tenantId = uuid();
  const a = uuid();
  const b = uuid();
  const c = uuid();
  const d = uuid();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query('SET LOCAL search_path TO choros');
    // tenant row (other org tests create one; harmless if the table is permissive)
    await client.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [tenantId, `t0515-${tenantId.slice(0, 8)}`],
    );
    // Departments — insert parents before children (composite self-FK).
    const ins = async (id: string, parent: string | null, slug: string) =>
      client.query(
        `INSERT INTO choros.department
           (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, 0, 0)`,
        [tenantId, id, parent, slug],
      );
    await ins(a, null, 'A-root');
    await ins(b, a, 'B-mid');
    await ins(c, b, 'C-leaf');
    await ins(d, a, 'D-sibling');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { tenantId, a, b, c, d };
}

describe('T-0515 loadTenantOrgAncestry — REAL department tree', () => {
  it('builds the oracle from the tenant custom tree (A→B→C, A→D)', async () => {
    const { tenantId, a, b, c, d } = await seedCustomTree();
    const oracle = await loadTenantOrgAncestry(pool, tenantId);

    // Self is always descendant-or-self.
    expect(oracle.isDescendantOrSelf('org', a, a)).toBe(true);
    expect(oracle.isDescendantOrSelf('org', c, c)).toBe(true);

    // A is an ancestor of B, C (deep), and D — so a grant scoped to A COVERS them.
    // isDescendantOrSelf(_, descendant, ancestor): C is a descendant of A.
    expect(oracle.isDescendantOrSelf('org', b, a)).toBe(true);
    expect(oracle.isDescendantOrSelf('org', c, a)).toBe(true);
    expect(oracle.isDescendantOrSelf('org', d, a)).toBe(true);

    // B is an ancestor of C but NOT of D (sibling subtree).
    expect(oracle.isDescendantOrSelf('org', c, b)).toBe(true);
    expect(oracle.isDescendantOrSelf('org', d, b)).toBe(false);

    // A grant scoped to C does NOT cover A (descendant is not ancestor's ancestor).
    expect(oracle.isDescendantOrSelf('org', a, c)).toBe(false);
    // C and D are incomparable.
    expect(oracle.isDescendantOrSelf('org', c, d)).toBe(false);
    expect(oracle.isDescendantOrSelf('org', d, c)).toBe(false);

    // Unknown id → false (conservative).
    expect(oracle.isDescendantOrSelf('org', uuid(), a)).toBe(false);
    expect(oracle.isDescendantOrSelf('org', a, uuid())).toBe(false);
  });

  it('is tenant-scoped: another tenant tree is NOT visible to this oracle', async () => {
    const t1 = await seedCustomTree();
    const t2 = await seedCustomTree();

    // Oracle for tenant 1 must know nothing about tenant 2's nodes — even though
    // t2.c is a real department, it does NOT belong to t1, so containment against
    // t1's root is false (RLS + explicit WHERE both scope the load to t1).
    const oracle1 = await loadTenantOrgAncestry(pool, t1.tenantId);
    expect(oracle1.isDescendantOrSelf('org', t1.c, t1.a)).toBe(true); // own tree
    expect(oracle1.isDescendantOrSelf('org', t2.c, t1.a)).toBe(false); // foreign node
    expect(oracle1.isDescendantOrSelf('org', t2.b, t2.a)).toBe(false); // foreign edge invisible
  });

  it('accepts an already-open tenant client (client path) with identical results', async () => {
    const { tenantId, a, c } = await seedCustomTree();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query('SET LOCAL search_path TO choros');
      const oracle = await loadTenantOrgAncestry(client, tenantId);
      await client.query('COMMIT');
      expect(oracle.isDescendantOrSelf('org', c, a)).toBe(true);
      expect(oracle.isDescendantOrSelf('org', a, c)).toBe(false);
    } finally {
      client.release();
    }
  });
});
