/**
 * ci/checks/db/migration-130-fallback-name-cast.test.ts — T-0707 (судья T-0653
 * NB-1 · migrations/130_list_view_source_owner.sql fallback constraint-rename
 * search)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * THE DEFECT (NB-1, latent/inert). migrations/130's second DO $$ block DROPs
 * the pre-T-0653 table-level UNIQUE(tenant_id, registry_def_id, name)
 * constraint. Its PRIMARY path matches the constraint by the exact name
 * Postgres auto-generates for migration 123
 * (list_view_tenant_id_registry_def_id_name_key) — this always matches on the
 * real linear graph (001..130 applied in order), because 123 never renames it.
 * The ELSE branch is a defensive fallback: if some environment's constraint
 * carries a DIFFERENT name (e.g. a hand-renamed constraint, or the SQL body
 * raw-reapplied against a schema built outside the runner), it scans
 * pg_constraint for a 3-column UNIQUE constraint on exactly
 * (name, registry_def_id, tenant_id) and drops it by discovered name.
 *
 * That scan compared `array_agg(a.attname ORDER BY a.attname)` — pg_attribute
 * .attname is the Postgres system type `name`, so the aggregate is `name[]` —
 * against the untyped literal `ARRAY['name','registry_def_id','tenant_id']`,
 * which Postgres resolves to `text[]`. There is no `name[] = text[]` operator,
 * so the ELSE branch raised `ERROR: operator does not exist: name[] = text[]`
 * instead of ever finding/dropping the renamed constraint — i.e. it would
 * ABORT the whole migration (not silently no-op) on any schema that actually
 * needed the fallback path. Fixed forward by casting the aggregate element to
 * `::text` (T-0707), preserving the exact same search semantics.
 *
 * WHY THIS TEST DOES NOT TOUCH THE REAL choros.list_view TABLE: on every
 * environment that has migration 130 applied via the ordinary linear runner
 * (migrations/run.mjs), the PRIMARY IF-EXISTS path already matched and
 * dropped the canonically-named constraint — so the real table now carries
 * NO 3-column constraint of that shape at all, and the ELSE branch has
 * nothing to find. To exercise the ELSE branch's own SQL (not a
 * reimplementation of it) this test:
 *   1. reads migrations/130_list_view_source_owner.sql from disk,
 *   2. extracts the exact ELSE-branch DO $$ ... $$ block bytes (asserting
 *      the extraction landed on the right block via content sentinels, so a
 *      future edit to the file that breaks the anchors fails LOUD, not
 *      silently green),
 *   3. retargets ONLY the object name (choros.list_view →
 *      choros.t0707_130_fallback_fixture) via textual substitution, and
 *   4. executes the retargeted-but-otherwise-verbatim block against a
 *      throwaway fixture table that reproduces the pre-T-0653 shape with a
 *      NON-canonical constraint name — exactly the case the ELSE branch
 *      exists for.
 *
 * FF-1  the extracted ELSE-branch fragment matches the current on-disk
 *       migration 130 body (sentinel presence) and carries the ::text cast.
 * FF-2  running the (retargeted) ELSE-branch DO block against a fixture with
 *       a non-canonically-named 3-column UNIQUE constraint FINDS and DROPS
 *       it (proves the cast fixes the comparison without breaking the
 *       search semantics — before the T-0707 fix this raised
 *       `operator does not exist: name[] = text[]` on the identical
 *       fixture, reproduced manually via psql, see T-0707 handoff).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratorUrl, withClient } from './_helpers.js';

const LIVE = !!process.env['DATABASE_URL'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_130_PATH = path.resolve(
  HERE,
  '../../../migrations/130_list_view_source_owner.sql',
);

const FIXTURE_TABLE = 'choros.t0707_130_fallback_fixture';
const FIXTURE_CONSTRAINT = 't0707_weirdly_named_uniq'; // deliberately NOT the 123 auto-name

/**
 * Extract the ELSE-branch DO $$ ... $$ block from migration 130's on-disk
 * text (the "запасной путь" fallback constraint search). Anchored on stable
 * content sentinels rather than line numbers, so it survives comment/prose
 * edits above/below but fails loud if the block itself is restructured.
 */
function extractFallbackDoBlock(migrationSql: string): string {
  const startMarker = 'DO $$\nDECLARE\n  conrec record;';
  const startIdx = migrationSql.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      'T-0707 test extraction anchor not found: "DO $$\\nDECLARE\\n  conrec record;" — migration 130 body changed shape',
    );
  }
  // The block's own terminator is the outer "END\n$$;" that closes the
  // DECLARE/BEGIN...END IF; block (immediately follows "END LOOP;\n  END IF;").
  const endMarker = 'END LOOP;\n  END IF;\nEND\n$$;';
  const endIdx = migrationSql.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    throw new Error(
      'T-0707 test extraction anchor not found: "END LOOP;\\n  END IF;\\nEND\\n$$;" — migration 130 body changed shape',
    );
  }
  return migrationSql.slice(startIdx, endIdx + endMarker.length);
}

describe.skipIf(!LIVE)('T-0707 — migration 130 ELSE-branch constraint-rename search (live Postgres)', () => {
  let migPool: pg.Pool;
  let migrationSql: string;
  let fallbackBlock: string;
  let retargetedBlock: string;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    migrationSql = fs.readFileSync(MIGRATION_130_PATH, 'utf-8');
    fallbackBlock = extractFallbackDoBlock(migrationSql);
    retargetedBlock = fallbackBlock.split('choros.list_view').join(FIXTURE_TABLE);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${FIXTURE_TABLE};`);
      await c.query(`
        CREATE TABLE ${FIXTURE_TABLE} (
          tenant_id uuid NOT NULL,
          registry_def_id uuid,
          name text NOT NULL,
          CONSTRAINT ${FIXTURE_CONSTRAINT} UNIQUE (tenant_id, registry_def_id, name)
        );
      `);
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${FIXTURE_TABLE};`);
    });
    if (migPool) await migPool.end();
  });

  it('FF-1: the extracted ELSE-branch fragment is genuinely from migration 130 and carries the T-0707 ::text cast', () => {
    expect(fallbackBlock).toMatch(/ARRAY\['name','registry_def_id','tenant_id'\]/);
    expect(fallbackBlock).toMatch(/EXECUTE format\('ALTER TABLE choros\.list_view DROP CONSTRAINT %I', conrec\.conname\)/);
    // The fix under test: attname is cast to ::text before array_agg so the
    // comparison against the text[] literal has a valid operator.
    expect(fallbackBlock).toMatch(/array_agg\(a\.attname::text ORDER BY a\.attname\)/);
  });

  it('the fixture genuinely reproduces the pre-fix shape: a 3-column UNIQUE constraint under a NON-canonical name', async () => {
    const c = await migPool.connect();
    try {
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'u'`,
        [FIXTURE_TABLE],
      );
      expect(rows.map((r: { conname: string }) => r.conname)).toEqual([FIXTURE_CONSTRAINT]);
    } finally {
      c.release();
    }
  });

  it('FF-2: running the (retargeted) ELSE-branch DO block finds and drops the non-canonically-named constraint — no type error', async () => {
    const c = await migPool.connect();
    try {
      // Pre-T-0707 (unpatched) this exact shape of comparison raised
      // "operator does not exist: name[] = text[]" — reproduced manually via
      // psql against an identical fixture (see T-0707 handoff for the raw
      // before/after transcript). With the ::text cast in place, execution
      // must succeed and the fallback-named constraint must be gone after.
      await expect(c.query(retargetedBlock)).resolves.toBeDefined();

      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'u'`,
        [FIXTURE_TABLE],
      );
      expect(rows).toHaveLength(0);
    } finally {
      c.release();
    }
  });
});
