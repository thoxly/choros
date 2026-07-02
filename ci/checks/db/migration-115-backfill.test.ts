/**
 * ci/checks/db/migration-115-backfill.test.ts — T-0574 (ADR-T0574 §2.2, FF-5/FF-6)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * migrations/115_assistant_agent_card_backfill.sql closes the gap for tenants
 * that were registered BEFORE this task landed (their assistant-agent employee
 * exists, but has no agent_card row — the exact pre-existing-tenant anti-case
 * ADR-T0574 §2.2 names). Since the live test-template DB already has migration
 * 115 applied (it runs once, tracked in schema_migrations), this file proves the
 * backfill's OWN properties by:
 *
 *   1. Simulating a PRE-T-0574 tenant directly: INSERT an assistant-agent
 *      employee row WITHOUT any agent_card row (exactly the historical shape
 *      documented in migrations/093's comment — "assistant-agent is created
 *      per-tenant as an EMPLOYEE only ... and writes NO agent_card row today").
 *   2. Re-running the migration 115 SQL body (read straight from the .sql file
 *      — not re-implemented/duplicated here) against that tenant BACKFILLS the
 *      missing row (FF-5: the migration is set-driven over ALL tenants missing
 *      the row, so it also covers this freshly-inserted one on any re-run).
 *   3. Running the SAME SQL body AGAIN (second execution) is a no-op — no
 *      duplicate agent_card row is created (FF-6: idempotency), backstopped by
 *      BOTH the migration's own `WHERE ac.id IS NULL` predicate AND the
 *      pre-existing partial UNIQUE index `agent_card_tenant_employee_uq`
 *      (tenant_id, employee_id) WHERE employee_id IS NOT NULL (migration 093).
 *   4. Static check (companion to the shell fitness checks
 *      ci/checks/demo/no-hardcoded-tenant.sh / ci/checks/seed/no-hardcoded-fixture-ids.sh):
 *      the migration file contains NO literal tenant UUID and is driven by a
 *      SELECT over choros.employee (set-driven, FF-5).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';

const LIVE = !!process.env['DATABASE_URL'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_115_PATH = path.resolve(HERE, '../../../migrations/115_assistant_agent_card_backfill.sql');

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

/**
 * Simulate the PRE-T-0574 shape: an assistant-agent employee row with NO
 * agent_card row at all (migrations/093's documented historical gap).
 */
async function seedPreT0574AssistantEmployee(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
     VALUES ($1, $2, 'assistant-agent', 'agent', 'Ассистент (AI-агент)', NULL, 0, 0)`,
    [tenantId, employeeId],
  );
  await c.query('COMMIT');
}

async function countAgentCardRows(c: pg.Client, tenantId: string, employeeId: string): Promise<number> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query(
    `SELECT count(*)::int AS c FROM choros.agent_card WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, employeeId],
  );
  await c.query('COMMIT');
  return (rows[0] as { c: number }).c;
}

describe.skipIf(!LIVE)('T-0574 — migration 115 backfill (live Postgres)', () => {
  let migPool: pg.Pool;
  let migrationSql: string;
  const TENANT = uuid();
  const ASSISTANT_EMP = uuid();

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    migrationSql = fs.readFileSync(MIGRATION_115_PATH, 'utf-8');
    await withClient(migratorUrl(), async (c) => {
      await seedTenant(c, TENANT);
      await seedPreT0574AssistantEmployee(c, TENANT, ASSISTANT_EMP);
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
      await c.query('COMMIT');
    });
    if (migPool) await migPool.end();
  });

  it('FF-5: migration 115 contains no literal tenant UUID and is driven by SELECT FROM choros.employee', () => {
    const uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
    expect(migrationSql).not.toMatch(uuidRe);
    expect(migrationSql).toMatch(/FROM\s+choros\.employee\s+e/i);
    expect(migrationSql).toMatch(/LEFT JOIN\s+choros\.agent_card\s+ac/i);
    expect(migrationSql).toMatch(/WHERE\s+e\.slug\s*=\s*'assistant-agent'/i);
    expect(migrationSql).toMatch(/AND\s+ac\.id\s+IS\s+NULL/i);
  });

  it('the seeded pre-T-0574 tenant genuinely has NO agent_card row before any backfill runs', async () => {
    const c = await migPool.connect();
    try {
      const count = await countAgentCardRows(c, TENANT, ASSISTANT_EMP);
      expect(count).toBe(0);
    } finally {
      c.release();
    }
  });

  it('FF-5/§2.2: re-running the migration 115 SQL body backfills the missing agent_card row', async () => {
    const c = await migPool.connect();
    try {
      await c.query(migrationSql);
      const count = await countAgentCardRows(c, TENANT, ASSISTANT_EMP);
      expect(count).toBe(1);

      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query(
        `SELECT agent_type, kc_client_id, llm_endpoint, llm_model, llm_secret_handle, llm_connection_id
           FROM choros.agent_card WHERE tenant_id = $1 AND employee_id = $2`,
        [TENANT, ASSISTANT_EMP],
      );
      await c.query('COMMIT');
      const row = rows[0] as Record<string, unknown>;
      expect(row.agent_type).toBe('assistant');
      expect(row.kc_client_id).toBe(`assistant-agent-${TENANT}`);
      expect(row.llm_endpoint).toBeNull();
      expect(row.llm_model).toBeNull();
      expect(row.llm_secret_handle).toBeNull();
      expect(row.llm_connection_id).toBeNull();
    } finally {
      c.release();
    }
  });

  it('FF-6: running the SAME SQL body AGAIN is a no-op (idempotent) — no duplicate row', async () => {
    const c = await migPool.connect();
    try {
      // Two more executions back-to-back — still exactly 1 row.
      await c.query(migrationSql);
      await c.query(migrationSql);
      const count = await countAgentCardRows(c, TENANT, ASSISTANT_EMP);
      expect(count).toBe(1);
    } finally {
      c.release();
    }
  });

  it('FF-6 (belt-and-braces): the partial UNIQUE index (tenant_id, employee_id) WHERE employee_id IS NOT NULL rejects a manual duplicate', async () => {
    const c = await migPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      let rejected = false;
      try {
        await c.query(
          `INSERT INTO choros.agent_card
             (tenant_id, id, employee_id, employee_kind, agent_type, kc_client_id, created_at, updated_at)
           VALUES ($1, gen_random_uuid(), $2, 'agent', 'assistant', 'assistant-agent-dup-test', 0, 0)`,
          [TENANT, ASSISTANT_EMP],
        );
      } catch (err) {
        rejected = (err as { code?: string }).code === '23505'; // unique_violation
      }
      await c.query('ROLLBACK');
      expect(rejected, 'a second agent_card row for the same (tenant_id, employee_id) must violate the partial UNIQUE index').toBe(true);
    } finally {
      c.release();
    }
  });
});
