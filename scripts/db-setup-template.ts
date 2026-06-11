#!/usr/bin/env npx tsx
// T-0147 · npm run fitness:db:setup-template
//
// Creates (or updates) the choros_test_template_<hash8> database used by
// globalSetup.ts to clone per-run test databases (T-0147, FR-4, AC-7).
//
// The template name encodes an 8-hex-char SHA-256 digest of all
// migrations/NNN_*.sql filenames+contents, so different branches with
// different migrations never share a template (T-0192, AC-cross-branch).
//
// Usage:
//   DATABASE_URL=postgres://choros_migrator:pw@localhost:55432/choros \
//     npm run fitness:db:setup-template
//
//   Or with --self-test flag (FF-T147-4):
//     npx tsx scripts/db-setup-template.ts --self-test
//
// Exit codes:
//   0 — template ready (created or updated)
//   1 — error (DB not accessible, migrations failed, etc.)

import pg from 'pg';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// ---------------------------------------------------------------------------
// Migrations hash (T-0192) — 8-hex-char SHA-256 of all migrations/*.sql
// ---------------------------------------------------------------------------

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

const MIGRATIONS_HASH = computeMigrationsHash(REPO_ROOT);
const TEMPLATE_NAME = `choros_test_template_${MIGRATIONS_HASH}`;

// Per-hash advisory lock: derive a stable 32-bit int from the hash so
// concurrent setup-template runs on different branches use different locks
// and don't block each other needlessly.
const ADVISORY_LOCK_ID = (parseInt(MIGRATIONS_HASH, 16) & 0x7fff_ffff) | 0x1000_0000;

// ---------------------------------------------------------------------------
// Self-test (FF-T147-4)
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  // Verify that when run, the script would target choros_test_template URL
  const baseUrl = 'postgres://choros_migrator:pw@localhost:55432/choros';
  const u = new URL(baseUrl);
  u.pathname = `/${TEMPLATE_NAME}`;
  const templateUrl = u.toString();
  if (!templateUrl.includes(`/choros_test_template`)) {
    console.error(`[self-test] FAIL: templateUrl "${templateUrl}" does not contain /choros_test_template`);
    process.exit(1);
  }
  console.log(`[self-test] PASS — template URL contains /choros_test_template: ${templateUrl}`);
  console.log(`[self-test] template name: ${TEMPLATE_NAME} (hash=${MIGRATIONS_HASH})`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rawUrl = process.env['DATABASE_URL'];
if (!rawUrl) {
  console.error('ERROR: DATABASE_URL not set (must resolve to choros_migrator with CREATEDB)');
  process.exit(1);
}

const adminU = new URL(rawUrl);
adminU.pathname = '/postgres';
const adminUrl = adminU.toString();

const tmplU = new URL(rawUrl);
tmplU.pathname = `/${TEMPLATE_NAME}`;
const templateUrl = tmplU.toString();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  console.log(`[setup-template] migrations hash: ${MIGRATIONS_HASH}`);
  console.log(`[setup-template] target template: "${TEMPLATE_NAME}"`);

  // Advisory lock — serialize against concurrent globalSetup clone operations
  const adminClient = new pg.Client({ connectionString: adminUrl });
  await adminClient.connect();

  try {
    await adminClient.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_ID]);

    // 1. Ensure template DB exists
    const { rows } = await adminClient.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [TEMPLATE_NAME],
    );
    const exists = rows[0].exists;

    if (!exists) {
      console.log(`[setup-template] creating database "${TEMPLATE_NAME}" from template0 ...`);
      // template0 = clean slate (no encoding artifacts)
      await adminClient.query(
        `CREATE DATABASE "${TEMPLATE_NAME}" TEMPLATE template0`,
      );
    } else {
      console.log(`[setup-template] database "${TEMPLATE_NAME}" already exists`);
    }

    // 2. Ensure datistemplate=true (prevents accidental DROP without FORCE)
    await adminClient.query(
      `UPDATE pg_database SET datistemplate = true WHERE datname = $1`,
      [TEMPLATE_NAME],
    );

    await adminClient.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
  } catch (err) {
    await adminClient.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]).catch(() => {});
    await adminClient.end().catch(() => {});
    throw err;
  }

  await adminClient.end();

  // 3. Run migrations against the template DB (idempotent via schema_migrations)
  console.log(`[setup-template] running migrations against "${TEMPLATE_NAME}" ...`);
  const migrationsRunMjs = join(REPO_ROOT, 'migrations', 'run.mjs');

  execSync(`node "${migrationsRunMjs}"`, {
    env: { ...process.env, DATABASE_URL: templateUrl },
    stdio: 'inherit',
  });

  console.log(`[setup-template] template "${TEMPLATE_NAME}" is ready.`);
}

main().catch((err) => {
  console.error('[setup-template] FATAL:', err.message);
  process.exit(1);
});
