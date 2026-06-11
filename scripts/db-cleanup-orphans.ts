#!/usr/bin/env npx tsx
// T-0147 · npm run fitness:db:cleanup-orphans
//
// Drops all orphaned choros_test_* databases (created by globalSetup.ts but not
// cleaned up due to SIGKILL or other crashes). Skips choros_test_template.
//
// Usage:
//   DATABASE_URL=postgres://choros_migrator:pw@localhost:55432/choros \
//     npm run fitness:db:cleanup-orphans
//
//   Dry run (list only, no drops):
//     ... npm run fitness:db:cleanup-orphans -- --dry-run
//
// Exit codes:
//   0 — success (including N=0 when no orphans found)
//   1 — connection or SQL error

import pg from 'pg';

const rawUrl = process.env['DATABASE_URL'];
if (!rawUrl) {
  console.error('ERROR: DATABASE_URL not set (must resolve to choros_migrator with CREATEDB)');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

const adminU = new URL(rawUrl);
adminU.pathname = '/postgres';
const adminUrl = adminU.toString();

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();

  try {
    // Find all choros_test_* databases except the template itself
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'choros_test_%'
          AND datname != 'choros_test_template'
        ORDER BY datname`,
    );

    if (rows.length === 0) {
      console.log('[cleanup-orphans] no orphaned test databases found.');
      return;
    }

    console.log(`[cleanup-orphans] found ${rows.length} orphaned database(s):`);
    for (const { datname } of rows) {
      console.log(`  - ${datname}`);
    }

    if (dryRun) {
      console.log('[cleanup-orphans] DRY-RUN: no databases dropped.');
      return;
    }

    for (const { datname } of rows) {
      // Terminate all active connections first (FR-8)
      await client.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [datname],
      );
      await client.query(`DROP DATABASE IF EXISTS "${datname}"`);
      console.log(`[cleanup-orphans] dropped: ${datname}`);
    }

    console.log(`[cleanup-orphans] done — dropped ${rows.length} database(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[cleanup-orphans] FATAL:', err.message);
  process.exit(1);
});
