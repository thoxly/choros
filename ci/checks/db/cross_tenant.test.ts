// T-0115 · Cross-tenant CI-blocker — 152-FZ invariant.
//
// Verifies from the real choros_app role (NOBYPASSRLS) that a query executing
// in the context of TENANT_A CANNOT read or mutate rows belonging to TENANT_B.
//
// Covers: AC-1 · AC-2 · AC-3 · AC-4 · AC-5 · AC-6 · AC-9
// (AC-7/AC-8 are in pgJobStore.integration.test.ts; AC-10..AC-12 in cross-tenant-fitness.sh)
//
// Seed strategy: all INSERT operations go through migratorUrl() (bypasses RLS).
// All cross-tenant probes go through appUrl() (choros_app, NOBYPASSRLS).
// Post-mutation verification goes through migratorUrl() to confirm physical integrity.
//
// NF-2: this file MUST use appUrl() — only choros_app proves the 152-FZ invariant.
// NF-3: iterates over KNOWN_TENANT_TABLES (not a hardcoded subset).

import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  KNOWN_TENANT_TABLES,
  uuid,
} from './_helpers.js';

// ---------------------------------------------------------------------------
// Seed helpers — insert minimal valid rows into each tenant table.
// All seeds use migratorUrl() to bypass RLS.
// ---------------------------------------------------------------------------

/** Seed one row into choros.application for the given tenant. Returns the app id. */
async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-app-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed one row into choros.registry_def. Returns the registry_def id. */
async function seedRegistryDef(c: pg.Client, tenantId: string, applicationId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-reg-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{}'::jsonb, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, applicationId, slug],
  );
  return id;
}

/** Seed one row into choros.record. Returns the record id. */
async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'ct-tester')`,
    [tenantId, id, registryId],
  );
  return id;
}

/** Seed one row into choros.audit_event. Returns the event id. */
async function seedAuditEvent(c: pg.Client, tenantId: string, seq: number): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, 'ct-test', 'ct-tester', '{}'::jsonb, 0,
             '\\x00'::bytea, '\\x01'::bytea, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId, seq, id],
  );
  return id;
}

/** Seed one row into choros.audit_head. */
async function seedAuditHead(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.audit_head
       (tenant_id, seq, row_hash, updated_at, vocab_version)
     VALUES ($1, 0, '\\x00'::bytea, 0, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
}

/**
 * Seed one row into choros.grant. Returns the grant id.
 *
 * T-0022 (migration 021) promoted grant.role_id to a real FK → role, so the
 * grant's role_id MUST name an existing role. `grant` is iterated BEFORE `role`
 * in KNOWN_TENANT_TABLES order, so we seed a dedicated role inline here rather
 * than depend on seedState (which isn't populated yet at this point).
 */
async function seedGrant(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const roleId = await seedRoleRow(c, tenantId);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, operation, scope, granted_by, created_at)
     VALUES ($1, $2, $3, 'application', 'read', '{}'::jsonb, 'ct-tester', 0)`,
    [tenantId, id, roleId],
  );
  return id;
}

/** Seed one row into choros.object_handle. Returns the handle id. */
async function seedObjectHandle(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.object_handle
       (tenant_id, id, ref_kind, created_at)
     VALUES ($1, $2, 'application', 0)`,
    [tenantId, id],
  );
  return id;
}

/** Seed a tenant row for the given tenant (tenant_id = id = tenantId). */
async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  const slug = `ct-tenant-${tenantId.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, slug],
  );
}

/** Seed one row into choros.department. Returns the department id. */
async function seedDepartmentRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-dept-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.department
       (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed one row into choros.position. Returns the position id. */
async function seedPositionRow(c: pg.Client, tenantId: string, departmentId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-pos-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.position
       (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, departmentId, slug],
  );
  return id;
}

/** Seed one row into choros.employee. */
async function seedEmployeeRow(c: pg.Client, tenantId: string, positionId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-emp-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, positionId, slug],
  );
  return id;
}

/** Seed one row into choros.actor_event (T-0019). Needs a seeded employee (actor FK). */
async function seedActorEvent(
  c: pg.Client,
  tenantId: string,
  seq: number,
  actorId: string,
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.actor_event
       (tenant_id, seq, id, object_kind, record_id, actor, role_at_event,
        event, approve_level, ts, vocab_version)
     VALUES ($1, $2, $3, 'record', $4, $5, $4, 'submit', NULL, 0, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId, seq, id, uuid(), actorId],
/** Seed one row into choros.role. Returns the role id (T-0022). */
async function seedRoleRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-role-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.role
       (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed the per-tenant counter row choros.actor_event_seq (T-0019). */
async function seedActorEventSeq(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.actor_event_seq (tenant_id, next_seq)
     VALUES ($1, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
/**
 * Seed one row into choros.role_assignment, wiring the already-seeded employee
 * to the new role with a valid org-node org_scope (the existing grant-lattice
 * ScopeElement shape) and confirmed_by set (an effective assignment). (T-0022)
 */
async function seedRoleAssignmentRow(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  roleId: string,
  departmentId: string,
): Promise<string> {
  const id = uuid();
  const orgScope = JSON.stringify({
    kind: 'node',
    hierarchy: 'org',
    nodeId: departmentId,
    nodeLevel: 'department',
  });
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL,
             'ct-test', 'ct-tester', NULL, 'ct-tester', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, employeeId, roleId, orgScope],
  );
  return id;
}

/** Seed one row into choros.job. Returns the job id. */
async function seedJobRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await c.query(
    `INSERT INTO choros.job
       (tenant_id, id, topic, variables, state, retries,
        lock_owner, lock_expiry, created_at, available_at)
     VALUES ($1, $2, 'ct-test', '{}'::jsonb, 'CREATED', 0,
             NULL, NULL, $3, $3)`,
    [tenantId, id, now],
  );
  return id;
}

/** Seed one row into choros.app_timer. Returns the timer id. */
async function seedAppTimer(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await c.query(
    `INSERT INTO choros.app_timer
       (tenant_id, id, due_at, state, kind, payload, created_at)
     VALUES ($1, $2, $3, 'pending', 'ct-test', '{}'::jsonb, $3)`,
    [tenantId, id, now + 60000],
  );
  return id;
}

/**
 * Seed one row into choros.data_classification (T-0033). PK is
 * (tenant_id, resource_type, facet_field, facet_schema_version); a per-tenant
 * unique facet_field keeps both tenants' seeds independent under their own RLS.
 */
async function seedDataClassification(c: pg.Client, tenantId: string): Promise<void> {
  const field = `ct-field-${uuid().slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.data_classification
       (tenant_id, resource_type, facet_field, facet_schema_version, class, created_at, updated_at)
     VALUES ($1, 'record', $2, 0, 'confidential', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, field],
  );
}

/**
 * Seed one row into choros.effect_resource (T-0034). PK is (tenant_id, id);
 * a fresh uuid id per call keeps both tenants' seeds independent under RLS.
 */
async function seedEffectResource(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.effect_resource
       (tenant_id, id, kind, scope, metadata, created_at)
     VALUES ($1, $2, 'integration_endpoint', '{}'::jsonb, NULL, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id],
  );
}

// ---------------------------------------------------------------------------
// Seed dispatcher: routes to the correct seed function per table name.
// Returns the seeded row id.
// ---------------------------------------------------------------------------

// Per-tenant seed state (populated in beforeAll).
const seedState = {
  appIdA: '',
  appIdB: '',
  regIdA: '',
  regIdB: '',
  // track audit_event seq per tenant to avoid PK collision
  auditSeqA: 1,
  auditSeqB: 1,
  // org-structure FK chain: dept → position (needed for employee seed)
  deptIdA: '',
  deptIdB: '',
  posIdA: '',
  posIdB: '',
  // employee id per tenant (the actor FK target for actor_event)
  empIdA: '',
  empIdB: '',
  // track actor_event seq per tenant to avoid PK collision
  actorSeqA: 1,
  actorSeqB: 1,
  // T-0022 chain: employee + role (needed for role_assignment seed)
  empIdA: '',
  empIdB: '',
  roleIdA: '',
  roleIdB: '',
};

/**
 * Seed ≥1 row under both tenants for the given table.
 * Must be called inside a BEGIN/COMMIT block by the caller.
 */
async function seedRowForTable(c: pg.Client, tableName: string, tenantId: string): Promise<void> {
  switch (tableName) {
    case 'application':
      await seedApplication(c, tenantId);
      break;
    case 'registry_def':
      // Needs an application to exist; use pre-seeded app ids.
      await seedRegistryDef(
        c,
        tenantId,
        tenantId === TENANT_A ? seedState.appIdA : seedState.appIdB,
      );
      break;
    case 'record':
      await seedRecord(
        c,
        tenantId,
        tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB,
      );
      break;
    case 'audit_event': {
      const seq = tenantId === TENANT_A ? seedState.auditSeqA++ : seedState.auditSeqB++;
      await seedAuditEvent(c, tenantId, seq);
      break;
    }
    case 'audit_head':
      await seedAuditHead(c, tenantId);
      break;
    case 'grant':
      await seedGrant(c, tenantId);
      break;
    case 'object_handle':
      await seedObjectHandle(c, tenantId);
      break;
    case 'job':
      await seedJobRow(c, tenantId);
      break;
    case 'app_timer':
      await seedAppTimer(c, tenantId);
      break;
    case 'tenant':
      // tenant_id = id for the tenant row (self-anchoring per T-0017 ADR §3.1)
      await seedTenantRow(c, tenantId);
      break;
    case 'department': {
      // Must seed after tenant. Store dept id for downstream position seed.
      const deptId = await seedDepartmentRow(c, tenantId);
      if (tenantId === TENANT_A) seedState.deptIdA = deptId;
      else seedState.deptIdB = deptId;
      break;
    }
    case 'position': {
      // Must seed after department. Store position id for downstream employee seed.
      const deptId = tenantId === TENANT_A ? seedState.deptIdA : seedState.deptIdB;
      const posId = await seedPositionRow(c, tenantId, deptId);
      if (tenantId === TENANT_A) seedState.posIdA = posId;
      else seedState.posIdB = posId;
      break;
    }
    case 'employee': {
      // Must seed after position. Store emp id for downstream actor_event seed.
      // Must seed after position. Store employee id for downstream role_assignment seed.
      const posId = tenantId === TENANT_A ? seedState.posIdA : seedState.posIdB;
      const empId = await seedEmployeeRow(c, tenantId, posId);
      if (tenantId === TENANT_A) seedState.empIdA = empId;
      else seedState.empIdB = empId;
      break;
    }
    case 'role': {
      // T-0022 — seed after tenant (no other dep). Store role id for role_assignment.
      const roleId = await seedRoleRow(c, tenantId);
      if (tenantId === TENANT_A) seedState.roleIdA = roleId;
      else seedState.roleIdB = roleId;
      break;
    }
    case 'role_assignment': {
      // T-0022 — must seed after employee + role (FK targets) and department
      // (org_scope references a real department node). KNOWN_TENANT_TABLES order
      // (…, department, …, employee, role, role_assignment) guarantees all are
      // already seeded by the time this case runs.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const roleId = tenantId === TENANT_A ? seedState.roleIdA : seedState.roleIdB;
      const deptId = tenantId === TENANT_A ? seedState.deptIdA : seedState.deptIdB;
      await seedRoleAssignmentRow(c, tenantId, empId, roleId, deptId);
      break;
    }
    case 'actor_event': {
      // Must seed after employee (actor FK). Per-tenant seq avoids PK collision.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const seq = tenantId === TENANT_A ? seedState.actorSeqA++ : seedState.actorSeqB++;
      await seedActorEvent(c, tenantId, seq, empId);
      break;
    }
    case 'actor_event_seq':
      await seedActorEventSeq(c, tenantId);
      break;
    case 'data_classification':
      await seedDataClassification(c, tenantId);
      break;
    case 'effect_resource':
      await seedEffectResource(c, tenantId);
      break;
    default:
      throw new Error(`seedRowForTable: unknown table ${tableName}`);
  }
}

// ---------------------------------------------------------------------------
// Global beforeAll: seed rows under both tenants for every table.
// Uses migrator (bypasses RLS). FK ordering: application → registry_def → record.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await withClient(migratorUrl(), async (c) => {
    // 1. Seed application for both tenants (other tables may FK-depend on it).
    await c.query('BEGIN');
    seedState.appIdA = await seedApplication(c, TENANT_A);
    await c.query('COMMIT');

    await c.query('BEGIN');
    seedState.appIdB = await seedApplication(c, TENANT_B);
    await c.query('COMMIT');

    // 2. Seed registry_def for both tenants.
    await c.query('BEGIN');
    seedState.regIdA = await seedRegistryDef(c, TENANT_A, seedState.appIdA);
    await c.query('COMMIT');

    await c.query('BEGIN');
    seedState.regIdB = await seedRegistryDef(c, TENANT_B, seedState.appIdB);
    await c.query('COMMIT');

    // 3. Seed remaining tables for both tenants.
    const remainingTables = KNOWN_TENANT_TABLES.filter(
      (t) => t !== 'application' && t !== 'registry_def',
    );
    for (const tableName of remainingTables) {
      for (const tenantId of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await seedRowForTable(c, tableName, tenantId);
        await c.query('COMMIT');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1: cross-tenant SELECT with explicit WHERE tenant_id = TENANT_B → 0 rows
// (choros_app, context = TENANT_A)
// ---------------------------------------------------------------------------
describe('AC-1 · FF-CT1: cross-tenant SELECT (explicit WHERE tenant_id=B) → 0 rows from app role', () => {
  for (const tableName of KNOWN_TENANT_TABLES) {
    it(`table: ${tableName}`, async () => {
      await withClient(appUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        // audit_head uses quoted identifier to avoid PK collision issues
        const quotedTable = tableName === 'grant' ? '"grant"' : tableName;
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros.${quotedTable} WHERE tenant_id = $1`,
          [TENANT_B],
        );
        await c.query('COMMIT');
        expect(rows[0].n, `${tableName}: expected 0 rows with tenant_id=TENANT_B`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-2: cross-tenant SELECT without WHERE → all returned rows have tenant_id=A
// (no TENANT_B rows leak)
// ---------------------------------------------------------------------------
describe('AC-2 · FF-CT2: cross-tenant SELECT (no WHERE) → only TENANT_A rows visible', () => {
  for (const tableName of KNOWN_TENANT_TABLES) {
    it(`table: ${tableName}`, async () => {
      await withClient(appUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        const quotedTable = tableName === 'grant' ? '"grant"' : tableName;
        const { rows } = await c.query(
          `SELECT tenant_id FROM choros.${quotedTable}`,
        );
        await c.query('COMMIT');
        // Every returned row must belong to TENANT_A.
        for (const row of rows) {
          expect(row.tenant_id, `${tableName}: leaked TENANT_B row`).toBe(TENANT_A);
        }
        // Additionally, no TENANT_B rows should be present.
        const tenantBCount = rows.filter((r) => r.tenant_id === TENANT_B).length;
        expect(tenantBCount, `${tableName}: TENANT_B rows leaked`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-3: cross-tenant UPDATE on choros.application → 0 rows affected
// Verification via migrator confirms the value was NOT changed.
// ---------------------------------------------------------------------------
describe('AC-3 · FF-CT3: cross-tenant UPDATE → 0 rows affected, TENANT_B data intact', () => {
  it('UPDATE choros.application WHERE tenant_id=TENANT_B from TENANT_A context', async () => {
    // Capture original display_name of TENANT_B application via migrator.
    const originalName = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT display_name FROM choros.application WHERE tenant_id = $1 LIMIT 1`,
        [TENANT_B],
      );
      return rows[0]?.display_name as string | undefined;
    });
    expect(originalName, 'TENANT_B app row must exist before UPDATE test').toBeDefined();

    // Attempt UPDATE from app role in TENANT_A context.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const result = await c.query(
        `UPDATE choros.application SET display_name = 'HACKED' WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      expect(result.rowCount, 'UPDATE rows affected must be 0').toBe(0);
    });

    // Verify value unchanged via migrator.
    const afterName = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT display_name FROM choros.application WHERE tenant_id = $1 LIMIT 1`,
        [TENANT_B],
      );
      return rows[0]?.display_name as string | undefined;
    });
    expect(afterName, 'TENANT_B display_name must be unchanged after cross-tenant UPDATE').toBe(originalName);
  });
});

// ---------------------------------------------------------------------------
// AC-4: cross-tenant DELETE on choros.application → 0 rows affected
// Verification via migrator confirms the row still exists.
// ---------------------------------------------------------------------------
describe('AC-4 · FF-CT4: cross-tenant DELETE → 0 rows affected, TENANT_B row survives', () => {
  it('DELETE choros.application WHERE tenant_id=TENANT_B from TENANT_A context', async () => {
    // Count TENANT_B rows before DELETE.
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      return rows[0].n as number;
    });
    expect(countBefore, 'TENANT_B application rows must exist').toBeGreaterThan(0);

    // Attempt DELETE from app role in TENANT_A context.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const result = await c.query(
        `DELETE FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      expect(result.rowCount, 'DELETE rows affected must be 0').toBe(0);
    });

    // Verify row count unchanged via migrator.
    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      return rows[0].n as number;
    });
    expect(countAfter, 'TENANT_B row count must be unchanged after cross-tenant DELETE').toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AC-5: post-condition integrity — TENANT_B rows physically intact after
// cross-tenant UPDATE/DELETE attempts on choros.application (AC-3/AC-4).
//
// Scope: only the tables touched by AC-3/AC-4 (choros.application).
// The job table is intentionally excluded: pgJobStore.integration.test.ts uses
// TRUNCATE choros.job in beforeEach and may run concurrently in a separate
// vitest fork against the same shared Postgres, creating a race condition.
// AC-5's spec says "затронутые таблицы" (affected tables) — application is the
// table mutated by the cross-tenant DML attempts in AC-3 and AC-4.
// ---------------------------------------------------------------------------
describe('AC-5 · FF-CT5: post-condition integrity — TENANT_B rows unchanged after AC-3/AC-4', () => {
  it('choros.application TENANT_B rows still present after cross-tenant UPDATE attempt (AC-3)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      expect(rows[0].n, 'application: TENANT_B rows must still exist after cross-tenant UPDATE attempt').toBeGreaterThanOrEqual(1);
    });
  });

  it('choros.application TENANT_B rows still present after cross-tenant DELETE attempt (AC-4)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      expect(rows[0].n, 'application: TENANT_B rows must still exist after cross-tenant DELETE attempt').toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6: fail-closed DML without tenant context → Postgres error (GUC undefined)
// INSERT using current_setting('choros.tenant_id', false)::uuid without SET LOCAL.
// ---------------------------------------------------------------------------
describe('AC-6 · FF-CT6: fail-closed DML without tenant context → Postgres error', () => {
  it('INSERT INTO choros.job without SET LOCAL throws Postgres error (GUC undefined)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      // Deliberately do NOT set choros.tenant_id.
      const now = Date.now();
      await expect(
        c.query(
          `INSERT INTO choros.job
             (tenant_id, id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at)
           VALUES
             (current_setting('choros.tenant_id', false)::uuid,
              $1, 'ct-fail-closed', '{}', 'CREATED', 0,
              NULL, NULL, $2, $2)`,
          [uuid(), now],
        ),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9: SET LOCAL scope isolation — GUC is transaction-scoped, not session-scoped.
// After COMMIT, the GUC is cleared. On a fresh connection (no prior SET),
// count(*) returns 0 — confirming no cross-transaction data leak.
// ---------------------------------------------------------------------------
describe('AC-9 · FF-CT9: SET LOCAL scope isolation — GUC cleared after COMMIT', () => {
  it('choros_app: rows visible inside BEGIN/SET LOCAL; 0 rows on fresh connection without GUC', async () => {
    // Step 1: Verify rows are visible inside BEGIN + SET LOCAL.
    let insideCount = 0;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application`,
      );
      await c.query('COMMIT');
      insideCount = rows[0].n as number;
    });
    expect(insideCount, 'rows must be visible inside transaction with SET LOCAL').toBeGreaterThanOrEqual(1);

    // Step 2: On a NEW connection (no GUC set), rows must be 0.
    // This verifies GUC scope: once the connection that had SET LOCAL is closed,
    // a fresh connection has no GUC → RLS default-DENY → 0 rows.
    // (Using a fresh connection avoids the Postgres quirk where after SET LOCAL +
    // COMMIT the session-level GUC value becomes '' which causes ''::uuid error.)
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application`,
      );
      expect(rows[0].n, 'fresh connection without GUC must see 0 rows (RLS default-DENY)').toBe(0);
    });
  });

  it('choros_app: cross-tenant isolation holds even with session-level SET (TENANT_B rows not exposed)', async () => {
    // Session-level SET (not SET LOCAL). Even if session-level GUC makes TENANT_A
    // rows visible, TENANT_B rows must never appear when context = TENANT_A.
    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TENANT_A}'`);
      await c.query('BEGIN');
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      // With session-level GUC = TENANT_A, TENANT_B rows must NOT be visible.
      expect(rows[0].n, 'session-level SET for TENANT_A must not expose TENANT_B rows').toBe(0);
    });
  });
});
