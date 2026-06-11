#!/usr/bin/env npx tsx
/**
 * T-0144 · One-shot sanitation script
 *
 * Deletes leaked test grant rows from choros."grant" that were inserted by
 * automated tests and not cleaned up (granted_by IN ('test', DEV_EMP_OWNER UUID)).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/cleanup-test-grants.ts [--dry-run]
 *
 * Exit codes:
 *   0 — success (including N=0 on a clean DB)
 *   1 — connection or SQL error
 */

import pg from 'pg';

const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const DEV_ROLE_OWNER = 'e0000000-0000-0000-0000-000000000001';

// Known test-actor markers per FR-6: 'test' = direct-SQL tests,
// UUID = DEV_EMP_OWNER used in HTTP-based FF-10 tests.
// None of these values can appear in production (prod uses real UUIDs for granted_by).
const TEST_ACTORS = ['test', 'd0000000-0000-0000-0000-0000000000ff'];

const dryRun = process.argv.includes('--dry-run');

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });

async function main(): Promise<void> {
  await client.connect();

  try {
    // Count matching rows first
    const countRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM choros."grant"
        WHERE tenant_id = $1
          AND role_id   = $2
          AND resource_type LIKE 'mgmt_object:%'
          AND granted_by = ANY($3::text[])`,
      [DEV_TENANT, DEV_ROLE_OWNER, TEST_ACTORS],
    );
    const count = parseInt(countRes.rows[0].n, 10);

    if (dryRun) {
      console.log(`DRY-RUN: would delete ${count} rows from choros."grant"`);
      process.exit(0);
    }

    const delRes = await client.query(
      `DELETE FROM choros."grant"
        WHERE tenant_id = $1
          AND role_id   = $2
          AND resource_type LIKE 'mgmt_object:%'
          AND granted_by = ANY($3::text[])`,
      [DEV_TENANT, DEV_ROLE_OWNER, TEST_ACTORS],
    );

    const deleted = delRes.rowCount ?? 0;
    console.log(`Deleted ${deleted} rows from choros."grant"`);
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
