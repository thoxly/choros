// T-0147 · globalSetup/globalTeardown — Postgres template-DB isolation for db-tests.
//
// Registered in vitest.config.js via test.globalSetup.
// Executed in vitest main-process (before worker fork) — mutations to
// process.env here ARE inherited by test workers (vitest 2.x contract, D-3).
//
// Mode selection:
//   DB_ISOLATION=off  → skip isolation, pass through current DATABASE_URL (legacy).
//   DATABASE_URL unset → skip silently (non-db vitest runs).
//   otherwise         → clone choros_test_template_<hash8> → choros_test_<epoch>_<hex>
//
// Template name encodes 8-hex-char SHA-256 of migrations/*.sql so different
// branches (different migration sets) never share a template (T-0192).
//
// Owner: T-0147 (do not edit without updating FF-T147-* checks)

import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Migrations hash (T-0192)
// ---------------------------------------------------------------------------

const _HERE = dirname(fileURLToPath(import.meta.url));
// globalSetup.ts lives at ci/checks/db/ → repo root = ../../../
const _REPO_ROOT = resolve(_HERE, '..', '..', '..');

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

const MIGRATIONS_HASH = computeMigrationsHash(_REPO_ROOT);
const TEMPLATE_NAME = `choros_test_template_${MIGRATIONS_HASH}`;

/** Advisory lock id: per-hash to avoid blocking branches with different migrations */
const ADVISORY_LOCK_ID = (parseInt(MIGRATIONS_HASH, 16) & 0x7fff_ffff) | 0x1000_0000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a run_id matching /^choros_test_\d{10,13}_[0-9a-f]{4}$/ (FF-T147-6). */
function makeRunId(): string {
  return `choros_test_${Date.now()}_${randomHex(2)}`;
}

/** Rewrite the dbname segment of a postgres connection URL. */
function withDbName(urlStr: string, dbName: string): string {
  const u = new URL(urlStr);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Point URL at the postgres system DB (for CREATE/DROP DATABASE). */
function adminUrl(urlStr: string): string {
  return withDbName(urlStr, 'postgres');
}

async function withClient<T>(urlStr: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlStr });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Self-test path (FF-T147-9)
// Called when the module is imported with ?self-test query param or
// argv includes --self-test. Used by the FF check shell script.
// ---------------------------------------------------------------------------

async function selfTest(): Promise<void> {
  // Verify run_id format
  const id = makeRunId();
  const RE = /^choros_test_\d{10,13}_[0-9a-f]{4}$/;
  if (!RE.test(id)) {
    throw new Error(`run_id "${id}" does not match expected pattern ${RE}`);
  }
  // Verify withDbName
  const base = 'postgres://choros_migrator:pw@localhost:55432/choros';
  const rewritten = withDbName(base, 'choros_test_template');
  if (!rewritten.includes('/choros_test_template')) {
    throw new Error(`withDbName failed: got ${rewritten}`);
  }
  // Verify adminUrl points to postgres
  const admin = adminUrl(base);
  if (!admin.endsWith('/postgres')) {
    throw new Error(`adminUrl failed: got ${admin}`);
  }
  // Verify TEMPLATE_NAME follows choros_test_template_<hash8> pattern (T-0192)
  const TEMPLATE_RE = /^choros_test_template_[0-9a-f]{8}$/;
  if (!TEMPLATE_RE.test(TEMPLATE_NAME)) {
    throw new Error(
      `TEMPLATE_NAME "${TEMPLATE_NAME}" does not match expected pattern ${TEMPLATE_RE}`,
    );
  }
  // Verify migrations hash is 8 hex chars
  if (!/^[0-9a-f]{8}$/.test(MIGRATIONS_HASH)) {
    throw new Error(`MIGRATIONS_HASH "${MIGRATIONS_HASH}" is not 8 lowercase hex chars`);
  }
  console.log('[globalSetup self-test] PASS — run_id pattern and URL rewriting OK');
  console.log(`[globalSetup self-test] sample run_id: ${id}`);
  console.log(`[globalSetup self-test] template name: ${TEMPLATE_NAME} (hash=${MIGRATIONS_HASH})`);
}

// ---------------------------------------------------------------------------
// globalSetup (vitest export)
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  // --- Fallback: DB_ISOLATION=off → skip (AC old-behavior compat)
  if (process.env['DB_ISOLATION'] === 'off') {
    console.log('[T-0147] DB isolation skipped (DB_ISOLATION=off)');
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    // No DATABASE_URL → not a db-tier run, skip silently
    return;
  }

  console.log(`[T-0147] migrations hash: ${MIGRATIONS_HASH}, template: ${TEMPLATE_NAME}`);

  // --- AC-6: verify template exists ---
  const templateExists = await withClient(adminUrl(databaseUrl), async (c) => {
    const res = await c.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [TEMPLATE_NAME],
    );
    return res.rows[0].exists;
  });

  if (!templateExists) {
    console.error(
      `[T-0147] ERROR: template database "${TEMPLATE_NAME}" not found.\n` +
        `Run: DATABASE_URL=<migrator-url> npm run fitness:db:setup-template first`,
    );
    process.exit(1);
  }

  // --- Advisory lock: serialize against concurrent setup-template runs ---
  const adminConn = new Client({ connectionString: adminUrl(databaseUrl) });
  await adminConn.connect();

  try {
    await adminConn.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_ID]);

    // --- Generate unique run_id (D-2) ---
    const runId = makeRunId();

    // --- Clone template → run DB (FR-5 step 1) ---
    // NOTE: CREATE DATABASE cannot run inside a transaction block; Client auto-commits.
    await adminConn.query(`CREATE DATABASE "${runId}" TEMPLATE "${TEMPLATE_NAME}"`);
    console.log(`[T-0147] cloned ${TEMPLATE_NAME} → ${runId}`);

    await adminConn.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);

    // --- Mutate process.env so vitest workers inherit clone URLs (D-3) ---
    process.env['DATABASE_URL'] = withDbName(databaseUrl, runId);
    process.env['APP_DATABASE_URL'] = withDbName(
      process.env['APP_DATABASE_URL'] ?? (() => {
        const u = new URL(databaseUrl);
        u.username = 'choros_app';
        u.password = process.env['CHOROS_APP_PASSWORD'] ?? 'choros_app_dev_pw';
        return u.toString();
      })(),
      runId,
    );
    process.env['CHOROS_TEST_RUN_ID'] = runId;
    process.env['CHOROS_TEST_ADMIN_URL'] = adminUrl(databaseUrl);
  } catch (err) {
    await adminConn.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]).catch(() => {});
    await adminConn.end().catch(() => {});
    throw err;
  }

  await adminConn.end();
}

// ---------------------------------------------------------------------------
// globalTeardown (vitest export)
// ---------------------------------------------------------------------------

export async function teardown(): Promise<void> {
  const runId = process.env['CHOROS_TEST_RUN_ID'];
  if (!runId) {
    // DB_ISOLATION=off path — nothing to drop
    return;
  }

  const adminUrlStr = process.env['CHOROS_TEST_ADMIN_URL'];
  if (!adminUrlStr) {
    console.warn('[T-0147] teardown: CHOROS_TEST_ADMIN_URL not set, cannot drop test DB');
    return;
  }

  await withClient(adminUrlStr, async (c) => {
    // FR-8: terminate all backends before DROP (required; DROP DATABASE rejects if connections exist)
    await c.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [runId],
    );
    await c.query(`DROP DATABASE IF EXISTS "${runId}"`);
    console.log(`[T-0147] dropped test database: ${runId}`);
  });
}

// ---------------------------------------------------------------------------
// CLI: --self-test (FF-T147-9)
// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  selfTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[globalSetup self-test] FAIL:', err.message);
      process.exit(1);
    });
}
