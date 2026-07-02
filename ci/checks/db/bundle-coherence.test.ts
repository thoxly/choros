// T-0082 · Bundle Coherence — live DB invariants (FF-12 / FF-13)
//
// Verifies from choros_migrator role (bypasses RLS) that:
//   FF-12 / FR-2 / AC-12:
//     Every choros.registry_def.record_schema is parse-valid JSON and its
//     root is an object (typeof parsed === 'object' && !Array.isArray).
//   FF-13 / FR-3 / AC-13 (amended, T-0570 ADR §10):
//     Every choros."grant" with resource_type = 'record' has
//     resource_facet IS NOT NULL — EXCEPT the platform default-open READ
//     grant (operation='read' + RESOURCE_ROOT sentinel scope), for which a
//     NULL facet is the ratified whole-resource-read encoding (T-0021 core:
//     strictly-absent facet = every field visible). For every other
//     record-grant a null facet remains what T-0082 declared it: a hanging
//     grant = object-schema ↔ grant desync (T-0082 ADR §7).
//   FF-RP-14 (T-0570 ADR §10.3 p.3):
//     The carve-out is precise in BOTH directions, proven by force: inside a
//     rolled-back transaction, a planted NULL-facet record-grant with a
//     NON-sentinel scope (and one with a non-read operation) IS caught by the
//     amended predicate, while a planted read+sentinel row is NOT.
//
// Skip-friendly: if DATABASE_URL is not set (no DB in this environment),
// tests are skipped — they must NOT fail the static CI pipeline (job `ci`).
// They run in job `db` via `npm run fitness:db` when postgres:16 is present.
//
// Pattern follows cross_tenant.test.ts: migratorUrl() + withClient + _helpers.js.

import { describe, it, expect } from 'vitest';
import { migratorUrl, withClient, uuid } from './_helpers.js';

// ---------------------------------------------------------------------------
// Skip guard: if DATABASE_URL is absent, skip all tests in this file.
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
const skipAll = !DB_URL;

// ---------------------------------------------------------------------------
// FF-12 / AC-12 — record_schema parse-valid JSON object
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'FF-12 / AC-12 · every registry_def.record_schema is a parse-valid JSON object',
  () => {
    it('all record_schema values parse as JSON objects', async () => {
      await withClient(migratorUrl(), async (c) => {
        // Read all record_schema values across all tenants (migrator bypasses RLS)
        const { rows } = await c.query<{ id: string; record_schema: unknown }>(
          `SELECT id::text, record_schema
           FROM choros.registry_def`,
        );

        for (const row of rows) {
          let parsed: unknown;
          // record_schema arrives as a JS object from pg (jsonb column) — but
          // we must verify it is ACTUALLY a non-null, non-array object.
          // pg deserialises jsonb to JS automatically; we do not need JSON.parse.
          parsed = row.record_schema;

          expect(
            parsed,
            `registry_def id=${row.id}: record_schema must not be null`,
          ).not.toBeNull();

          expect(
            typeof parsed,
            `registry_def id=${row.id}: record_schema must be of type 'object', got '${typeof parsed}'`,
          ).toBe('object');

          expect(
            Array.isArray(parsed),
            `registry_def id=${row.id}: record_schema root must not be an array`,
          ).toBe(false);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FF-13 / AC-13 — grant resource_facet NOT NULL when resource_type = 'record'
// (amended with the T-0570 sanctioned carve-out — see the comment on the
// predicate below and T-0570 ADR §10)
// ---------------------------------------------------------------------------

// SANCTIONED CARVE-OUT — T-0570 ADR §10 × T-0082 FR-3/AC-13: NULL-facet legal ONLY
// for the platform default-open READ grant (read + RESOURCE_ROOT sentinel scope);
// the invariant keeps full force for every other record-grant.
//
// Why the exemption is structural (scope-shape), not role-based (T-0570 ADR §10.2):
// the sentinel nodeId '00000000-0000-0000-0000-0000000000r0' ('r' is not hex) is
// NOT a valid uuid, so it can never collide with a real choros.application.id
// (uuid column) — any grant carrying this exact shape IS the default-read platform
// primitive by construction, regardless of which role holds it (full-width
// delegation legally reproduces the shape under another role). The literal below
// must stay byte-identical to RESOURCE_ROOT_NODE_ID in src/core/read-visibility.ts
// and to migrations/117_default_read_grant_backfill.sql — pinned by FF-RP-15
// (ci/checks/read-pdp-sentinel-coherence.sh); db-tests intentionally do not import
// from src/ (house pattern), hence grep-coherence instead of an import.
//
// This SINGLE predicate is shared by FF-13 (expects 0 rows on seeded data) and
// FF-RP-14 (force-proves the predicate still catches every non-exempt shape).
const HANGING_RECORD_GRANTS_SQL = `
  SELECT id::text, tenant_id::text
  FROM choros."grant"
  WHERE resource_type = 'record'
    AND resource_facet IS NULL
    AND NOT COALESCE(                                -- SANCTIONED CARVE-OUT (T-0570 ADR §10)
          operation = 'read'
      AND scope->>'kind'      = 'node'
      AND scope->>'hierarchy' = 'resource'
      AND scope->>'nodeLevel' = 'application'
      AND scope->>'nodeId'    = '00000000-0000-0000-0000-0000000000r0',  -- RESOURCE_ROOT_NODE_ID
          false
    )`;

describe.skipIf(skipAll)(
  'FF-13 / AC-13 · every grant with resource_type=\'record\' has resource_facet IS NOT NULL (T-0570 §10 carve-out: default-open READ grant exempt)',
  () => {
    it('no grant with resource_type=\'record\' and null resource_facet (outside the sanctioned default-read shape)', async () => {
      await withClient(migratorUrl(), async (c) => {
        // Hanging grants: resource_type='record' but no resource_facet —
        // excluding ONLY the exact structural shape of the platform
        // default-open READ grant (T-0570 ADR §10.2).
        const { rows } = await c.query<{ id: string; tenant_id: string }>(
          HANGING_RECORD_GRANTS_SQL,
        );

        expect(
          rows.length,
          `Found ${rows.length} grant(s) with resource_type='record' and null resource_facet ` +
            `outside the sanctioned default-read carve-out (T-0570 ADR §10). ` +
            `Hanging grants: ${rows.map((r) => `(tenant=${r.tenant_id}, id=${r.id})`).join(', ')}. ` +
            `This is an object-schema ↔ grant desync (T-0082 ADR §7 / FF-13).`,
        ).toBe(0);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FF-RP-14 (T-0570 ADR §10.3 p.3) — the invariant's force is PROVEN, not
// postulated: inside a transaction that is ALWAYS rolled back, plant
//   (a) a NULL-facet record-grant with a NON-sentinel scope   → MUST be caught
//   (b) a NULL-facet record-grant with a non-read operation
//       on the sentinel scope                                  → MUST be caught
//   (c) a NULL-facet read grant with the exact sentinel scope  → MUST be exempt
// and assert the SAME amended predicate (HANGING_RECORD_GRANTS_SQL above)
// returns (a) and (b) but not (c). Red if the carve-out is imprecise in
// either direction. ROLLBACK guarantees zero residue in the shared DB.
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'FF-RP-14 · carve-out precision force-test (ROLLBACK): non-sentinel/non-read NULL-facet caught, read+sentinel exempt',
  () => {
    it('amended predicate catches planted non-exempt shapes and exempts exactly the default-read shape', async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        try {
          const tenantId = uuid();
          const roleId = uuid();
          const badScopeId = uuid();        // (a) read + NON-sentinel scope, NULL facet
          const badOpId = uuid();           // (b) NON-read op + sentinel scope, NULL facet
          const incompleteScopeId = uuid(); // (d) read + INCOMPLETE scope (no nodeId), NULL facet
          const exemptId = uuid();          // (c) read + sentinel scope, NULL facet

          // Temp tenant + role (grant.role_id → role(tenant_id, id) FK,
          // migration 021). Rolled back below — never visible outside this tx.
          await c.query(
            `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
             VALUES ($1, $1, $2, $2, 0)`,
            [tenantId, `ffrp14-${tenantId.slice(0, 8)}`],
          );
          await c.query(
            `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
             VALUES ($1, $2, $3, $3, 0, 0)`,
            [tenantId, roleId, `ffrp14-role-${roleId.slice(0, 8)}`],
          );

          // (a) NON-sentinel scope (a realistic registry-level node) — the
          // exact hanging-grant shape T-0082 outlawed; must STILL be caught.
          await c.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, granted_by, created_at)
             VALUES ($1, $2, $3, 'record', NULL, 'read',
                     jsonb_build_object('kind','node','hierarchy','resource','nodeLevel','registry','nodeId',$4::text),
                     'ffrp14-force-test', 0)`,
            [tenantId, badScopeId, roleId, uuid()],
          );

          // (b) sentinel scope but NON-read operation — outside the carve-out
          // (the exemption requires operation='read'); must be caught.
          await c.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, granted_by, created_at)
             VALUES ($1, $2, $3, 'record', NULL, 'update',
                     '{"kind":"node","hierarchy":"resource","nodeLevel":"application","nodeId":"00000000-0000-0000-0000-0000000000r0"}'::jsonb,
                     'ffrp14-force-test', 0)`,
            [tenantId, badOpId, roleId],
          );

          // (d) read + INCOMPLETE scope (missing nodeId key, e.g. only kind),
          // NULL facet — the jsonb extraction scope->>'nodeId' will return NULL,
          // making the full AND-condition NULL; must be caught by COALESCE fallback.
          await c.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, granted_by, created_at)
             VALUES ($1, $2, $3, 'record', NULL, 'read',
                     '{"kind":"node"}'::jsonb,
                     'ffrp14-force-test', 0)`,
            [tenantId, incompleteScopeId, roleId],
          );

          // (c) the exact default-read shape (read + sentinel application
          // node, NULL facet) — the ONE sanctioned exemption; must NOT appear.
          await c.query(
            `INSERT INTO choros."grant"
               (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, granted_by, created_at)
             VALUES ($1, $2, $3, 'record', NULL, 'read',
                     '{"kind":"node","hierarchy":"resource","nodeLevel":"application","nodeId":"00000000-0000-0000-0000-0000000000r0"}'::jsonb,
                     'ffrp14-force-test', 0)`,
            [tenantId, exemptId, roleId],
          );

          const { rows } = await c.query<{ id: string; tenant_id: string }>(
            HANGING_RECORD_GRANTS_SQL,
          );
          const ids = rows.map((r) => r.id);

          expect(
            ids,
            'FF-RP-14: NULL-facet record-grant with a NON-sentinel scope must be caught by the amended FF-13 predicate (invariant lost its force)',
          ).toContain(badScopeId);
          expect(
            ids,
            'FF-RP-14: NULL-facet record-grant with a non-read operation must be caught by the amended FF-13 predicate (carve-out is wider than sanctioned)',
          ).toContain(badOpId);
          expect(
            ids,
            'FF-RP-14: NULL-facet record-grant with an INCOMPLETE scope (missing nodeId) must be caught by COALESCE fallback (NULL-propagation fix)',
          ).toContain(incompleteScopeId);
          expect(
            ids,
            'FF-RP-14: the exact default-read shape (read + RESOURCE_ROOT sentinel) must be exempt (carve-out is narrower than sanctioned — FF-13 would go red on every seeded tenant)',
          ).not.toContain(exemptId);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    });
  },
);
