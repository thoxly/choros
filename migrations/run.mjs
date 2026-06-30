#!/usr/bin/env node
// Choros migration runner (T-0053, E0.3) — zero-dependency.
//
// Imports ONLY Node builtins + the `pg` client (NF-1; the single added dep,
// FF-PG-ONCE). No migration framework (no Flyway/Liquibase/ORM for choros_*;
// Liquibase is Flowable's, for ACT_* only).
//
// Contract (ADR §4.1):
//   - Connects via DATABASE_URL, which resolves to the choros_migrator role.
//   - search_path = choros for our migrations; schema_migrations lives in choros.
//   - Ensures the choros schema + schema_migrations(version text PK,
//     applied_at timestamptz) exist (the ONLY pre-bookkeeping idempotent step).
//   - Lists migrations/NNN_<name>.sql, sorts LEXICOGRAPHICALLY (001 < 002 < ...
//     < 010 < ...) so a sister task's 010_* appends additively after the baseline.
//   - version key = the filename stem (e.g. "001_roles_and_schema").
//   - For each file whose version is NOT already recorded:
//       BEGIN; <file SQL>; INSERT INTO schema_migrations(version) VALUES ($1); COMMIT;
//     (bookkeeping row in the SAME transaction as the file's SQL).
//   - On any error: ROLLBACK that file's txn, print the failing file + error,
//     exit(1) — NO schema_migrations row for a partially-applied file (FR-2).
//   - Already-recorded versions are SKIPPED (no re-execution) — idempotency.
//   - Exit 0 when all pending files are applied (or none pending).
//
// SQL files may reference env placeholders of the form ${VAR:-default} (e.g. the
// dev-only choros_app password); these are expanded before execution so prod
// passwords are injected at deploy time and never committed (RL-1/NF-5).
//
// DEMO-SEED GATE (T-0549, founder decision 2026-06-30, flag T-0299-mock-removal):
//   A migration whose FIRST line is the sentinel `-- @demo-seed` carries
//   *demonstration* content (a fake reference company: TEL procurement process,
//   vendor-CRM, ₽ catalogs, contractor directory) — NOT schema and NOT system
//   bootstrap. Such files are applied only when CHOROS_SEED_DEMO is truthy.
//
//   CHOROS_SEED_DEMO defaults to ON (unset / '1' / 'true' / 'yes' / 'on') so dev,
//   CI, and the db-fitness template keep their demo fixtures (many tests assert on
//   them). The prod stack (docker-compose.prod.yml) sets CHOROS_SEED_DEMO=0, so a
//   fresh production deploy comes up with NO fake company — a new human lands in a
//   clean, empty tenant. The structural schema and the genesis-owner bootstrap silo
//   (e.g. migrations 013/019/026, NOT sentinel-marked) always apply, in every mode.
//
//   When demo is off, sentinel files are simply never applied and never recorded in
//   schema_migrations (they stay "pending" but inert); dependent later migrations
//   (e.g. 086/087) are pure keyed UPDATEs that no-op on the absent rows.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA = 'choros';
const MIGRATION_FILE_RE = /^(\d{3,}_[A-Za-z0-9_]+)\.sql$/;
// ${VAR} or ${VAR:-default}
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
// A demo-seed migration declares itself on its FIRST line (optional shebang-free).
const DEMO_SENTINEL_RE = /^[ \t]*--[ \t]*@demo-seed\b/;

/**
 * Demo seed applies by default; only an explicit OFF value disables it.
 * OFF ∈ {0, false, no, off} (case-insensitive). Anything else (incl. unset) = ON.
 */
function isDemoSeedEnabled() {
  const v = (process.env.CHOROS_SEED_DEMO ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/** True iff the migration file's first line is the `-- @demo-seed` sentinel. */
function isDemoSeedFile(rawSql) {
  const firstLine = rawSql.slice(0, rawSql.indexOf('\n') === -1 ? undefined : rawSql.indexOf('\n'));
  return DEMO_SENTINEL_RE.test(firstLine);
}

function expandEnv(sql) {
  return sql.replace(ENV_PLACEHOLDER_RE, (_m, name, dflt) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    if (dflt !== undefined) return dflt;
    throw new Error(`migration references unset env var \${${name}} with no default`);
  });
}

/** Discover migration files, lexicographically ordered. Returns [{version, file}]. */
async function listMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .map((name) => {
      const m = MIGRATION_FILE_RE.exec(name);
      return m ? { version: m[1], file: name } : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('FATAL: DATABASE_URL is not set (must resolve to choros_migrator).');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // 1. Pre-bookkeeping idempotent step: schema + bookkeeping table.
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`);
    await client.query(`SET search_path TO ${SCHEMA};`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       );`,
    );

    // 2. Already-applied set.
    const { rows } = await client.query(
      `SELECT version FROM ${SCHEMA}.schema_migrations;`,
    );
    const applied = new Set(rows.map((r) => r.version));

    // 3. Pending files, lexicographic order.
    const migrations = await listMigrations();
    const pending = migrations.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      console.log(
        `migrations: nothing to apply (${applied.size} already recorded, ${migrations.length} files).`,
      );
      return;
    }

    // 4. Apply each pending file in its own transaction.
    const demoEnabled = isDemoSeedEnabled();
    if (!demoEnabled) {
      console.log('migrations: CHOROS_SEED_DEMO is off — demo-seed migrations will be skipped (clean prod).');
    }
    let applied_count = 0;
    let skipped_demo = 0;
    for (const { version, file } of pending) {
      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      // Demo-seed gate: a `-- @demo-seed` file is inert when demo is disabled.
      // Not executed and not recorded (stays pending/inert) so toggling demo on
      // later still applies it. No partial state: the txn below never opens.
      if (!demoEnabled && isDemoSeedFile(raw)) {
        skipped_demo += 1;
        console.log(`migrations: skipped demo-seed ${version} (CHOROS_SEED_DEMO off)`);
        continue;
      }
      const sql = expandEnv(raw);
      try {
        await client.query('BEGIN;');
        // search_path is connection-scoped; re-assert inside the txn so DDL
        // without a schema qualifier lands in choros.
        await client.query(`SET LOCAL search_path TO ${SCHEMA};`);
        await client.query(sql);
        await client.query(
          `INSERT INTO ${SCHEMA}.schema_migrations(version) VALUES ($1);`,
          [version],
        );
        await client.query('COMMIT;');
        applied_count += 1;
        console.log(`migrations: applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK;');
        console.error(`migrations: FAILED on ${file}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(
      `migrations: applied ${applied_count} file(s)` +
        (skipped_demo > 0 ? `, skipped ${skipped_demo} demo-seed file(s).` : '.'),
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migrations: fatal: ${err.message}`);
  process.exit(1);
});
