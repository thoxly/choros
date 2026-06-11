// T-0082 · Bundle Coherence — live DB invariants (FF-12 / FF-13)
//
// Verifies from choros_migrator role (bypasses RLS) that:
//   FF-12 / FR-2 / AC-12:
//     Every choros.registry_def.record_schema is parse-valid JSON and its
//     root is an object (typeof parsed === 'object' && !Array.isArray).
//   FF-13 / FR-3 / AC-13:
//     Every choros."grant" with resource_type = 'record' has
//     resource_facet IS NOT NULL. A null facet = hanging grant =
//     object-schema ↔ grant desync (ADR §7).
//
// Skip-friendly: if DATABASE_URL is not set (no DB in this environment),
// tests are skipped — they must NOT fail the static CI pipeline (job `ci`).
// They run in job `db` via `npm run fitness:db` when postgres:16 is present.
//
// Pattern follows cross_tenant.test.ts: migratorUrl() + withClient + _helpers.js.

import { describe, it, expect } from 'vitest';
import { migratorUrl, withClient } from './_helpers.js';

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
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'FF-13 / AC-13 · every grant with resource_type=\'record\' has resource_facet IS NOT NULL',
  () => {
    it('no grant with resource_type=\'record\' and null resource_facet', async () => {
      await withClient(migratorUrl(), async (c) => {
        // Hanging grants: resource_type='record' but no resource_facet
        const { rows } = await c.query<{ id: string; tenant_id: string }>(
          `SELECT id::text, tenant_id::text
           FROM choros."grant"
           WHERE resource_type = 'record'
             AND resource_facet IS NULL`,
        );

        expect(
          rows.length,
          `Found ${rows.length} grant(s) with resource_type='record' and null resource_facet. ` +
            `Hanging grants: ${rows.map((r) => `(tenant=${r.tenant_id}, id=${r.id})`).join(', ')}. ` +
            `This is an object-schema ↔ grant desync (ADR §7 / FF-13).`,
        ).toBe(0);
      });
    });
  },
);
