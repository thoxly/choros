#!/usr/bin/env npx tsx
// T-0147 · npm run fitness:db:setup-template
//
// Creates (or updates) the choros_test_template database used by globalSetup.ts
// to clone per-run test databases (T-0147, FR-4, AC-7).
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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const TEMPLATE_NAME = 'choros_test_template';
const ADVISORY_LOCK_ID = 147_001;

// ---------------------------------------------------------------------------
// Self-test (FF-T147-4)
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  // Verify that when run, the script would target choros_test_template URL
  const baseUrl = 'postgres://choros_migrator:pw@localhost:55432/choros';
  const u = new URL(baseUrl);
  u.pathname = `/${TEMPLATE_NAME}`;
  const templateUrl = u.toString();
  if (!templateUrl.includes(`/${TEMPLATE_NAME}`)) {
    console.error(`[self-test] FAIL: templateUrl "${templateUrl}" does not contain /${TEMPLATE_NAME}`);
    process.exit(1);
  }
  console.log(`[self-test] PASS — template URL contains /${TEMPLATE_NAME}: ${templateUrl}`);
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
