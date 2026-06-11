#!/usr/bin/env npx tsx
// T-0147 · npm run fitness:db:cleanup-orphans
//
// Drops all orphaned choros_test_* databases (created by globalSetup.ts but not
// cleaned up due to SIGKILL or other crashes).
//
// Skips choros_test_template_* databases (per-hash migration templates, T-0192).
// Also supports --stale-templates to drop templates whose hash no longer matches
// the current migrations set (useful post-merge cleanup).
//
// Usage:
//   DATABASE_URL=postgres://choros_migrator:pw@localhost:55432/choros \
//     npm run fitness:db:cleanup-orphans
//
//   Dry run (list only, no drops):
//     ... npm run fitness:db:cleanup-orphans -- --dry-run
//
//   Also drop stale per-hash templates:
//     ... npm run fitness:db:cleanup-orphans -- --stale-templates
//
// Exit codes:
//   0 — success (including N=0 when no orphans found)
//   1 — connection or SQL error

import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

/** Compute SHA-256 over sorted migration filenames+contents → first 8 hex chars. */
function computeMigrationsHash(repoRoot: string): string {
  const migrationsDir = join(repoRoot, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3,}_[A-Za-z0-9_]+\.sql$/.test(f))
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(readFileSync(join(migrationsDir, f)));
  }
  return h.digest('hex').slice(0, 8);
}

const CURRENT_HASH = computeMigrationsHash(REPO_ROOT);
const CURRENT_TEMPLATE = `choros_test_template_${CURRENT_HASH}`;

const rawUrl = process.env['DATABASE_URL'];
if (!rawUrl) {
  console.error('ERROR: DATABASE_URL not set (must resolve to choros_migrator with CREATEDB)');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const includeStaleTemplates = process.argv.includes('--stale-templates');

const adminU = new URL(rawUrl);
adminU.pathname = '/postgres';
const adminUrl = adminU.toString();

async function dropDb(client: pg.Client, datname: string): Promise<void> {
  // Terminate all active connections first (FR-8)
  await client.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [datname],
  );
  // Templates have datistemplate=true; must clear it before DROP
  await client.query(
    `UPDATE pg_database SET datistemplate = false WHERE datname = $1`,
    [datname],
  );
  await client.query(`DROP DATABASE IF EXISTS "${datname}"`);
  console.log(`[cleanup-orphans] dropped: ${datname}`);
}

async function main(): Promise<void> {
  console.log(`[cleanup-orphans] current migrations hash: ${CURRENT_HASH}`);
  console.log(`[cleanup-orphans] current template: ${CURRENT_TEMPLATE}`);

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();

  try {
    // Find all choros_test_* databases:
    //   - run databases: choros_test_<epoch>_<hex> → always orphan-eligible
    //   - template databases: choros_test_template_<hash8> → skip current, optionally drop stale
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'choros_test_%'
        ORDER BY datname`,
    );

    // Partition into run-orphans vs templates
    const TEMPLATE_RE = /^choros_test_template_[0-9a-f]{8}$/;
    const orphans: string[] = [];
    const staleTemplates: string[] = [];

    for (const { datname } of rows) {
      if (TEMPLATE_RE.test(datname)) {
        // It's a per-hash template: stale if not current hash
        if (datname !== CURRENT_TEMPLATE) {
          staleTemplates.push(datname);
        }
        // else: current template — always skip
      } else {
        // run database (choros_test_<epoch>_<hex>) or legacy choros_test_template
        orphans.push(datname);
      }
    }

    let totalToDrop = orphans.length + (includeStaleTemplates ? staleTemplates.length : 0);

    if (totalToDrop === 0 && staleTemplates.length === 0) {
      console.log('[cleanup-orphans] no orphaned test databases found.');
      return;
    }

    if (orphans.length > 0) {
      console.log(`[cleanup-orphans] found ${orphans.length} orphaned run database(s):`);
      for (const n of orphans) console.log(`  - ${n}`);
    }

    if (staleTemplates.length > 0) {
      console.log(`[cleanup-orphans] found ${staleTemplates.length} stale template(s):`);
      for (const n of staleTemplates) console.log(`  - ${n}`);
      if (!includeStaleTemplates) {
        console.log('[cleanup-orphans] (use --stale-templates to also drop stale templates)');
      }
    }

    if (dryRun) {
      console.log('[cleanup-orphans] DRY-RUN: no databases dropped.');
      return;
    }

    for (const datname of orphans) {
      await dropDb(client, datname);
    }

    if (includeStaleTemplates) {
      for (const datname of staleTemplates) {
        await dropDb(client, datname);
      }
    }

    const dropped = orphans.length + (includeStaleTemplates ? staleTemplates.length : 0);
    console.log(`[cleanup-orphans] done — dropped ${dropped} database(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[cleanup-orphans] FATAL:', err.message);
  process.exit(1);
});
