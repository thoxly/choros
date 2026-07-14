// T-0397 · PDP dual-control read-path — LIVE Postgres integration probe.
//
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
// (server-gated: PG :55432 is CLOSED at authoring time — this test is written to
//  run on the server CI against the real compose Postgres, NOT locally.)
//
// WHY THIS EXISTS (review B2 — close the test-theater): the unit test
// src/__tests__/grants-dao.test.ts uses a FAKE pg.Pool that RE-IMPLEMENTS the
// criticality predicate in TS, so it proves the mirror logic, not the REAL SQL —
// and it has NO axis-c case at all. This probe seeds rows into a fresh tenant and
// calls the REAL DAO functions (getGrantsForSubject / getRoleSlugsForActor)
// against a REAL Postgres, so the ACTUAL grants-dao.ts SQL predicate (all four
// escalation axes, incl. axis-c clearance JSONB parsing) is what is exercised.
//
// COVERAGE (the four escalation axes + the M1 window-scope + regressions):
//   B1/axis-c — a READ grant with { clearance: 'confidential' }:
//       * one approver  (confirmed2_by NULL) → NOT PDP-active
//       * two approvers (confirmed2_by set)  → PDP-active
//     (this is the exact hole the prior axis-a/b-only predicate left open.)
//   B1/Q-2    — a READ grant with a GARBAGE clearance token → critical (one
//               approver → NOT active).
//   axis-a    — an 'approve' grant: one approver → NOT active; two → active.
//   regression — a plain 'read' grant (no clearance marker) single-confirmed →
//               STILL active (non-critical path untouched).
//   regression — a 'read' grant with { clearance: 'internal' } (a VALID,
//               NON-sensitive DataClass) single-confirmed → STILL active.
//   M1        — an EXPIRED critical grant does NOT criticize a sibling assignment
//               (the assignment with only an expired critical grant stays active).
//   assignment-axis-c — an assignment whose role holds an axis-c critical grant,
//               with the ASSIGNMENT itself confirmed2_by NULL → role slug excluded.
//
// Seeding goes through migratorUrl() (BYPASSRLS); the DAO calls run through a
// choros_app Pool (RLS-enforced) so the SET LOCAL choros.tenant_id scoping is the
// real production path. A fresh per-suite tenant keeps rows off the dev seed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import {
  getGrantsForSubject,
  getRoleSlugsForActor,
} from '../../../src/db/grants-dao.js';

const NOW = 1_000_000; // fixed instant for deterministic window math
const EXPIRED_UNTIL = 500_000; // < NOW → expired

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

const TENANT = uuid();
// Each fixture carries BOTH the employee id (FK target for seedAssignment) and the
// employee SLUG. The DAO under test (getGrantsForSubject / getRoleSlugsForActor)
// resolves an actor by SLUG (employee.slug), not by id — passing the raw id makes
// the lookup miss and every grant read return empty, which silently passed the
// "expected 0" cases and broke the "expected ≥1" cases. So the DAO calls below
// MUST use `.slug`; seedAssignment MUST use `.id`.
type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };
const fx: {
  empAxisCSingle: EmpFx;
  empAxisCDual: EmpFx;
  empQ2: EmpFx;
  empApproveSingle: EmpFx;
  empReadPlain: EmpFx;
  empReadInternal: EmpFx;
  empExpiredCrit: EmpFx;
  empAsgAxisC: EmpFx;
  empCritRoutine: EmpFx;
  critRoutineSlug: string;
} = {
  empAxisCSingle: EMPTY_EMP,  // holds a role with a read+confidential grant, confirmed2_by NULL
  empAxisCDual: EMPTY_EMP,    // same but confirmed2_by set
  empQ2: EMPTY_EMP,           // holds a role with a read+GARBAGE clearance grant, no #2
  empApproveSingle: EMPTY_EMP,// holds a role with an approve grant, no #2
  empReadPlain: EMPTY_EMP,    // plain read grant (no clearance), no #2 → active
  empReadInternal: EMPTY_EMP, // read + internal clearance (valid non-sensitive), no #2 → active
  empExpiredCrit: EMPTY_EMP,  // role's ONLY critical grant is expired → assignment active
  empAsgAxisC: EMPTY_EMP,     // T-0605: SEMI-CONFIRMED assignment (proposed_by set) → excluded
  empCritRoutine: EMPTY_EMP,  // T-0605 FIX: ROUTINE assignment to a critical (approve) role → slug INCLUDED
  critRoutineSlug: '',        // slug of the approve-role empCritRoutine is assigned to
};

async function seedEmployee(c: pg.Client, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `dc-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `dc-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
    [TENANT, empId, posId, slug],
  );
  return { id: empId, slug };
}

async function seedRole(c: pg.Client, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [TENANT, id, slug],
  );
  return id;
}

async function seedGrant(
  c: pg.Client,
  args: {
    roleId: string;
    operation: string;
    resourceType?: string;
    constraint?: unknown;     // JSONB constraint surface (carries the clearance marker)
    confirmed2: boolean;      // is the second approver present?
    validUntil?: number | null;
  },
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, $4, NULL,
             $5, $6::jsonb, $7::jsonb, false, 'seed',
             NULL, $8, 0,
             'seed', 'seed', $9)`,
    [
      TENANT, id, args.roleId,
      args.resourceType ?? 'mcp://record.x',
      args.operation, scope,
      args.constraint !== undefined ? JSON.stringify(args.constraint) : null,
      args.validUntil === undefined ? null : args.validUntil,
      args.confirmed2 ? 'seed2' : null,
    ],
  );
  return id;
}

// T-0605: `proposed` controls the write-side ROUTINE-vs-ESCALATING signal that
// the canonical assignment-active predicate keys on. Default (proposed=false) =
// ROUTINE (proposed_by NULL) — active on one confirm, mirroring the real write
// path (grants.ts / rights-intents.ts hire). proposed=true = ESCALATING /
// semi-confirmed (proposed_by set) — pending until confirmed2_by.
async function seedAssignment(
  c: pg.Client,
  args: { empId: string; roleId: string; confirmed2: boolean; proposed?: boolean },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             $6, 'seed', $7, 0, 0)`,
    [
      TENANT, uuid(), args.empId, args.roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
      args.proposed ? 'seed' : null,
      args.confirmed2 ? 'seed2' : null,
    ],
  );
}

beforeAll(async () => {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [TENANT, `dc-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');

    // axis-c: read grant w/ { clearance: 'confidential' } — single vs dual confirm.
    fx.empAxisCSingle = await seedEmployee(c, `dc-axisc-single-${uuid().slice(0, 6)}`);
    const rAxisCSingle = await seedRole(c, `dc-r-axisc-single-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rAxisCSingle, operation: 'read', constraint: { clearance: 'confidential' }, confirmed2: false });
    await seedAssignment(c, { empId: fx.empAxisCSingle.id, roleId: rAxisCSingle, confirmed2: true });

    fx.empAxisCDual = await seedEmployee(c, `dc-axisc-dual-${uuid().slice(0, 6)}`);
    const rAxisCDual = await seedRole(c, `dc-r-axisc-dual-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rAxisCDual, operation: 'read', constraint: { clearance: 'confidential' }, confirmed2: true });
    await seedAssignment(c, { empId: fx.empAxisCDual.id, roleId: rAxisCDual, confirmed2: true });

    // Q-2: read grant w/ a GARBAGE clearance token → critical, single confirm.
    fx.empQ2 = await seedEmployee(c, `dc-q2-${uuid().slice(0, 6)}`);
    const rQ2 = await seedRole(c, `dc-r-q2-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rQ2, operation: 'read', constraint: { clearance: 'top-secret-garbage' }, confirmed2: false });
    await seedAssignment(c, { empId: fx.empQ2.id, roleId: rQ2, confirmed2: true });

    // axis-a: approve grant, single confirm.
    fx.empApproveSingle = await seedEmployee(c, `dc-approve-${uuid().slice(0, 6)}`);
    const rApprove = await seedRole(c, `dc-r-approve-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rApprove, operation: 'approve', confirmed2: false });
    await seedAssignment(c, { empId: fx.empApproveSingle.id, roleId: rApprove, confirmed2: true });

    // regression: plain read grant (no clearance) single confirm → active.
    fx.empReadPlain = await seedEmployee(c, `dc-readplain-${uuid().slice(0, 6)}`);
    const rReadPlain = await seedRole(c, `dc-r-readplain-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rReadPlain, operation: 'read', confirmed2: false });
    await seedAssignment(c, { empId: fx.empReadPlain.id, roleId: rReadPlain, confirmed2: true });

    // regression: read + 'internal' (valid, non-sensitive DataClass) single confirm → active.
    fx.empReadInternal = await seedEmployee(c, `dc-readint-${uuid().slice(0, 6)}`);
    const rReadInternal = await seedRole(c, `dc-r-readint-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rReadInternal, operation: 'read', constraint: { clearance: 'internal' }, confirmed2: false });
    await seedAssignment(c, { empId: fx.empReadInternal.id, roleId: rReadInternal, confirmed2: true });

    // M1: a role whose ONLY critical grant is EXPIRED → the assignment (single
    // confirm) must STAY active (the expired grant must not criticize it).
    fx.empExpiredCrit = await seedEmployee(c, `dc-expcrit-${uuid().slice(0, 6)}`);
    const rExpiredCrit = await seedRole(c, `dc-r-expcrit-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rExpiredCrit, operation: 'approve', confirmed2: true, validUntil: EXPIRED_UNTIL });
    await seedAssignment(c, { empId: fx.empExpiredCrit.id, roleId: rExpiredCrit, confirmed2: false });

    // assignment SEMI-CONFIRMED (T-0605): role holds an ACTIVE axis-c critical
    // grant, but the ASSIGNMENT is ESCALATING (proposed_by set, confirmed2_by
    // NULL) → pending a distinct second approver → excluded. The gate is the
    // assignment's OWN semi-confirmed state, NOT the role's criticality.
    fx.empAsgAxisC = await seedEmployee(c, `dc-asg-axisc-${uuid().slice(0, 6)}`);
    const rAsgAxisC = await seedRole(c, `dc-r-asg-axisc-${uuid().slice(0, 6)}`);
    await seedGrant(c, { roleId: rAsgAxisC, operation: 'read', constraint: { clearance: 'restricted' }, confirmed2: true });
    await seedAssignment(c, { empId: fx.empAsgAxisC.id, roleId: rAsgAxisC, confirmed2: false, proposed: true });

    // T-0605 FIX: ROUTINE assignment (proposed_by NULL, confirmed2_by NULL) to an
    // approve-role (axis-a critical). Under the canonical predicate this assignment
    // is ACTIVE on one confirm → role slug INCLUDED. This is the exact live-факт
    // shape (owner self-assigns a workflow role) the prior gate wrongly blocked.
    fx.empCritRoutine = await seedEmployee(c, `dc-crit-routine-${uuid().slice(0, 6)}`);
    fx.critRoutineSlug = `dc-r-crit-routine-${uuid().slice(0, 6)}`;
    const rCritRoutine = await seedRole(c, fx.critRoutineSlug);
    await seedGrant(c, { roleId: rCritRoutine, operation: 'approve', confirmed2: false });
    await seedAssignment(c, { empId: fx.empCritRoutine.id, roleId: rCritRoutine, confirmed2: false });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

afterAll(async () => {
  if (_pool) await _pool.end();
});

// ---------------------------------------------------------------------------
// B1 — axis-c (read + sensitive clearance) is gated by confirmed2_by
// ---------------------------------------------------------------------------
describe('T-0397 B1 — axis-c (read + confidential clearance) PDP dual-control gate', () => {
  it('axis-c read grant, ONE approver (confirmed2_by NULL) → NOT PDP-active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empAxisCSingle.slug, NOW);
    // The ONLY grant on this actor's role is the read+confidential one; it must be
    // gated out because confirmed2_by is NULL. THIS is the hole the prior
    // axis-a/b-only predicate left open (a read op gave the left OR = TRUE).
    expect(grants.length).toBe(0);
  });

  it('axis-c read grant, TWO approvers (confirmed2_by set) → PDP-active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empAxisCDual.slug, NOW);
    expect(grants.length).toBe(1);
    expect(grants[0]!.operation).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// B1 — Q-2 (garbage clearance token) is fail-closed critical
// ---------------------------------------------------------------------------
describe('T-0397 B1 — Q-2 (garbage clearance token) fail-closed', () => {
  it('read grant with a NON-DataClass clearance token, ONE approver → NOT active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empQ2.slug, NOW);
    expect(grants.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// axis-a (approve) — confirmed for the SQL-expressible axis the prior code had
// ---------------------------------------------------------------------------
describe('T-0397 — axis-a (approve) PDP dual-control gate', () => {
  it('approve grant, ONE approver → NOT active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empApproveSingle.slug, NOW);
    expect(grants.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Regressions — non-critical reads stay active on a single confirm
// ---------------------------------------------------------------------------
describe('T-0397 — non-critical read grants remain single-confirm active', () => {
  it('plain read grant (no clearance marker), ONE approver → STILL active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empReadPlain.slug, NOW);
    expect(grants.length).toBe(1);
    expect(grants[0]!.operation).toBe('read');
  });

  it('read grant with VALID non-sensitive clearance (internal), ONE approver → STILL active', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empReadInternal.slug, NOW);
    expect(grants.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M1 — an EXPIRED critical grant must not criticize a sibling assignment
// ---------------------------------------------------------------------------
describe('T-0397 M1 — expired critical grant does not criticize the assignment', () => {
  it('assignment (single confirm) whose ONLY critical grant is EXPIRED → role slug INCLUDED', async () => {
    const slugs = await getRoleSlugsForActor(getPool(), TENANT, fx.empExpiredCrit.slug, NOW);
    // The expired approve grant must NOT force the assignment's second-approver
    // gate; the assignment (confirmed2_by NULL) must therefore stay active.
    expect(slugs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T-0605 — CANONICAL assignment-active gate: a SEMI-CONFIRMED assignment
// (proposed_by set, confirmed2_by NULL) is pending and excluded; a ROUTINE
// assignment (proposed_by NULL) to a critical role is ACTIVE on one confirm.
// ---------------------------------------------------------------------------
describe('T-0605 — semi-confirmed assignment is excluded (its OWN pending state)', () => {
  it('SEMI-CONFIRMED assignment (proposed_by set, confirmed2_by NULL) → role slug excluded', async () => {
    const slugs = await getRoleSlugsForActor(getPool(), TENANT, fx.empAsgAxisC.slug, NOW);
    expect(slugs).toEqual([]);
  });

  it('same semi-confirmed assignment contributes ZERO grants on the PDP path', async () => {
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empAsgAxisC.slug, NOW);
    expect(grants).toEqual([]);
  });
});

describe('T-0605 FIX — routine assignment to a CRITICAL role is active on one confirm', () => {
  it('ROUTINE assignment (proposed_by NULL, confirmed2_by NULL) to an approve-role → role slug INCLUDED', async () => {
    // The self-lock: prior T-0397 gate withheld this slug because the role holds
    // an approve grant. The canonical predicate returns it (one confirm suffices).
    const slugs = await getRoleSlugsForActor(getPool(), TENANT, fx.empCritRoutine.slug, NOW);
    expect(slugs).toContain(fx.critRoutineSlug);
  });

  it('routine assignment to a critical role also yields the role grants that ARE grant-active', async () => {
    // The assignment activates (step 2). The approve grant here is single-confirm
    // (confirmed2_by NULL) so the GRANT-level dual-control still withholds it —
    // proving grant authority is untouched: the assignment activated, but the
    // critical GRANT still needs its own second approver.
    const grants = await getGrantsForSubject(getPool(), TENANT, fx.empCritRoutine.slug, NOW);
    expect(grants).toEqual([]);
  });
});
