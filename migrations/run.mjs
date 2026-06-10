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
    for (const { version, file } of pending) {
      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
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
        console.log(`migrations: applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK;');
        console.error(`migrations: FAILED on ${file}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`migrations: applied ${pending.length} file(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migrations: fatal: ${err.message}`);
  process.exit(1);
});
