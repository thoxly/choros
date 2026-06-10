// FF-2 (idempotency re-run) + FF-2TENANT (anti-decorative tenant_id, tenancy §9
// guard 5, blocking). Invokes the real runner as a subprocess.
//
// Precondition: the runner has already been applied once (the db CI job + the
// local repro run `node migrations/run.mjs` before this suite). These tests
// re-run it and assert idempotency, then seed ≥2 tenants and re-run again.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUNNER = join(REPO_ROOT, 'migrations', 'run.mjs');

function runMigrations(): string {
  return execFileSync('node', [RUNNER], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
}

async function countMigrations(): Promise<number> {
  return withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM choros.schema_migrations`,
    );
    return rows[0].n;
  });
}

describe('FF-2: runner is idempotent (re-run applies nothing)', () => {
  beforeAll(() => {
    // Ensure baseline is applied (first run; may be a no-op if the job already ran it).
    runMigrations();
  });

  it('a second run leaves schema_migrations row count unchanged and exits 0', async () => {
    const before = await countMigrations();
    const out = runMigrations(); // throws on non-zero exit
    const after = await countMigrations();
    expect(after).toBe(before);
    expect(out).toMatch(/nothing to apply/);
  });

  it('all 10 migration files (001–010) are recorded', async () => {
    // T-0114 adds 010_job_available_at; updated from 9 to 10.
    const n = await countMigrations();
    expect(n).toBe(10);
  });
});

describe('FF-2TENANT: migrations consistent with ≥2 tenants; re-run stays clean', () => {
  beforeAll(async () => {
    // Seed ≥2 distinct tenants across tenant tables. Re-run-safe (the suite may
    // run against a non-fresh DB): UPSERT on the scoped business keys and reuse
    // the stored ids so FKs always resolve.
    await withClient(migratorUrl(), async (c) => {
      for (const tenant of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
        const appRes = await c.query(
          `INSERT INTO choros.application
             (tenant_id, id, slug, display_name, created_at, updated_at)
           VALUES ($1, $2, '2tenant-app', '2tenant-app', 0, 0)
           ON CONFLICT (tenant_id, slug)
             DO UPDATE SET updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [tenant, uuid()],
        );
        const appId = appRes.rows[0].id;
        const regRes = await c.query(
          `INSERT INTO choros.registry_def
             (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
           VALUES ($1, $2, $3, '2tenant-reg', 'r', '{}'::jsonb, 0, 0)
           ON CONFLICT (tenant_id, application_id, slug)
             DO UPDATE SET updated_at = EXCLUDED.updated_at
           RETURNING id`,
          [tenant, uuid(), appId],
        );
        const regId = regRes.rows[0].id;
        await c.query(
          `INSERT INTO choros.record
             (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
           VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'tester')`,
          [tenant, uuid(), regId],
        );
        await c.query('COMMIT');
      }
    });
  });

  it('the same business key exists independently under both tenants (no global degeneration / merge)', async () => {
    // The migrator/bootstrap role is a superuser (RLS does not filter it), so we
    // scope by tenant_id explicitly: the anti-decorative-tenant_id assertion is
    // that the SAME slug coexists once per tenant (scoped uniqueness did NOT
    // degenerate to a global UNIQUE(slug), and the two tenants did not merge).
    await withClient(migratorUrl(), async (c) => {
      for (const tenant of [TENANT_A, TENANT_B]) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros.application
             WHERE tenant_id = $1 AND slug = '2tenant-app'`,
          [tenant],
        );
        expect(rows[0].n, `tenant ${tenant} app count`).toBe(1);
      }
      // And globally both rows coexist (would be impossible under a global UNIQUE(slug)).
      const total = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE slug = '2tenant-app'`,
      );
      expect(total.rows[0].n).toBe(2);
    });
  });

  it('re-running the runner with ≥2 tenants present is still idempotent (no unique violation)', async () => {
    const before = await countMigrations();
    const out = runMigrations();
    const after = await countMigrations();
    expect(after).toBe(before);
    expect(out).toMatch(/nothing to apply/);
  });
});
