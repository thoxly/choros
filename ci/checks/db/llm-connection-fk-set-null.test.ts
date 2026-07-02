/**
 * ci/checks/db/llm-connection-fk-set-null.test.ts — migration 116 (schema-defect
 * fix discovered while authoring T-0574's live tests)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * THE DEFECT (migrations 094/107/113, fixed by 116): a bare `ON DELETE SET NULL`
 * on a COMPOSITE FK nulls EVERY referencing column — including tenant_id, which
 * is NOT NULL on all three child tables (agent_card / spend_ledger /
 * application). So deleting a referenced llm_connection (or section) row aborted
 * with `null value in column "tenant_id" ... violates not-null constraint`
 * instead of detaching the child. Migration 116 recreates the FKs with the
 * PG-15+ column-specific action `ON DELETE SET NULL (<child-col>)`.
 *
 * Proved here against LIVE Postgres:
 *
 *   1. BEHAVIORAL (the reported case). Deleting an llm_connection row that an
 *      agent_card references does NOT error and does NOT touch
 *      agent_card.tenant_id — the card simply loses the link
 *      (llm_connection_id → NULL), everything else intact.
 *   2. CATALOG (all three siblings). Each of the three FKs carries a
 *      column-specific SET NULL list that excludes tenant_id — so the same
 *      class of defect cannot silently ride along in the other two.
 *
 * The fixture is PURE SQL (tenant/employee/agent_card/llm_connection inserted
 * directly) — deliberately independent of registerTenant and of any in-flight
 * application code: this is a SCHEMA test, it must hold on any checkout where
 * the migrations have been applied.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, withClient, uuid } from './_helpers.js';

const LIVE = !!process.env['DATABASE_URL'];

describe.skipIf(!LIVE)('migration 116 — composite-FK SET NULL must not null tenant_id (live Postgres)', () => {
  const tenantId = uuid();
  const employeeId = uuid();
  const kcClientId = `fk-setnull-test-${uuid()}`; // agent_card.kc_client_id is globally unique (092)

  beforeAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, 'FK SET NULL probe tenant', 0)`,
        [tenantId, `fk-setnull-${tenantId.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, 'fk-setnull-agent', 'agent', 'FK probe agent', NULL, 0, 0)`,
        [tenantId, employeeId],
      );
      await c.query(
        `INSERT INTO choros.agent_card (tenant_id, employee_id, kc_client_id, created_at, updated_at)
         VALUES ($1, $2, $3, 0, 0)`,
        [tenantId, employeeId, kcClientId],
      );
      await c.query('COMMIT');
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.llm_connection WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE tenant_id = $1`, [tenantId]);
      await c.query('COMMIT');
    });
  });

  // ---------------------------------------------------------------------------
  // 1. BEHAVIORAL — deleting a referenced llm_connection detaches the agent_card
  //    (llm_connection_id → NULL) and leaves tenant_id untouched. Before 116 this
  //    exact DELETE aborted 23502 on agent_card.tenant_id.
  // ---------------------------------------------------------------------------
  it('DELETE llm_connection with a bound agent_card: no error, card keeps tenant_id, loses only the link', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      // A connection profile, bound to the card.
      const conn = await c.query<{ id: string }>(
        `INSERT INTO choros.llm_connection
           (tenant_id, name, provider, endpoint, model, created_at, updated_at)
         VALUES ($1, 'FK SET NULL probe', 'anthropic', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet', 0, 0)
         RETURNING id`,
        [tenantId],
      );
      const connId = conn.rows[0]!.id;
      await c.query(
        `UPDATE choros.agent_card SET llm_connection_id = $3
          WHERE tenant_id = $1 AND employee_id = $2`,
        [tenantId, employeeId, connId],
      );

      // THE probe: before migration 116 this DELETE died with
      // `null value in column "tenant_id" of relation "agent_card"` (23502).
      const del = await c.query(
        `DELETE FROM choros.llm_connection WHERE tenant_id = $1 AND id = $2`,
        [tenantId, connId],
      );
      expect(del.rowCount).toBe(1);

      // The card survived: same tenant_id, same identity, only the link gone.
      const after = await c.query<{
        tenant_id: string; kc_client_id: string; llm_connection_id: string | null;
      }>(
        `SELECT tenant_id, kc_client_id, llm_connection_id
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [tenantId, employeeId],
      );
      expect(after.rows.length, 'agent_card row must survive the profile delete').toBe(1);
      expect(after.rows[0]!.tenant_id).toBe(tenantId);
      expect(after.rows[0]!.kc_client_id).toBe(kcClientId);
      expect(after.rows[0]!.llm_connection_id).toBeNull();

      await c.query('COMMIT');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. CATALOG — all three composite FKs fixed by 116 carry a column-specific
  //    SET NULL list (pg_constraint.confdelsetcols) that names ONLY the link
  //    column, never tenant_id. Guards the sibling FKs (spend_ledger /
  //    application) without re-staging their heavier row fixtures.
  // ---------------------------------------------------------------------------
  it('all three FKs SET NULL only their link column (confdelsetcols excludes tenant_id)', async () => {
    const expected: Record<string, string[]> = {
      agent_card_llm_connection_fk: ['llm_connection_id'],
      spend_ledger_llm_connection_fk: ['llm_connection_id'],
      application_section_fk: ['section_id'],
    };
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ conname: string; set_null_cols: string[] | null }>(
        `SELECT con.conname,
                -- ::text so node-pg parses the array (name[] comes back as a raw string)
                (SELECT array_agg(att.attname::text ORDER BY att.attname)
                   FROM unnest(con.confdelsetcols) AS d(attnum)
                   JOIN pg_attribute att
                     ON att.attrelid = con.conrelid AND att.attnum = d.attnum
                ) AS set_null_cols
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE ns.nspname = 'choros'
            AND con.contype = 'f'
            AND con.conname = ANY($1)`,
        [Object.keys(expected)],
      );
      expect(rows.length, 'all three constraints must exist').toBe(3);
      for (const row of rows) {
        expect(
          row.set_null_cols,
          `${row.conname}: bare SET NULL (confdelsetcols empty) would null tenant_id on delete`,
        ).toEqual(expected[row.conname]);
      }
    });
  });
});
