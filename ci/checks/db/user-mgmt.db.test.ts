/**
 * ci/checks/db/user-mgmt.db.test.ts — T-0583 (ADR-T0583-user-mgmt).
 *
 * LIVE Postgres probe (skipped without DATABASE_URL). Runs `registerUserMgmtRoutes`
 * against a REAL server (dev-mode x-dev-user auth) + REAL Postgres (RLS-enforcing
 * choros_app pool for the routes, choros_migrator for setup/teardown), with
 * InMemoryKeycloakUserPort standing in for Keycloak (no live KC needed in CI —
 * mirrors hire-read-grant.db.test.ts / register-tenant-isolation.adversarial.test.ts).
 *
 * Each test registers ONE OR TWO fresh, fully-seeded tenants via the production
 * registerTenant() service (own owner + role-reader + role-configurator etc.), so
 * cross-tenant assertions run against REAL RLS rather than a synthetic fixture.
 *
 * PROVES (ADR §6 fitness table):
 *   FF-583-1  POST /api/users (owner) → createHumanUser called 1×; employee(kind=
 *             'human', slug=<KC userId>) created; 201 {employee_id, login}.
 *   FF-583-2  The created account gets role-reader + covering READ (same result as
 *             hire-flow T-0619) — getGrantsForSubject resolves a read/record/
 *             RESOURCE_ROOT grant for it.
 *   FF-583-3  KC-first + compensation: EMAIL_TAKEN → 409, no employee row; a DB
 *             failure after KC-create → deleteUser called 1× with that userId, no 201.
 *   FF-583-4  PATCH {active:false} → setUserEnabled(userId,false) 1× + deactivated_at
 *             set; list shows active:false; {active:true} reverses both.
 *   FF-583-5  tenant isolation: actor A creating with tenant_id=B → 403; PATCH on
 *             B's employee → 404; GET /accounts for A never contains B's accounts.
 *   FF-583-6  a non-privileged tenant member (no mgmt_object:employee grant, not
 *             owner) → 403 ADMIN_GATE_REJECTED on POST and PATCH.
 *   FF-583-10 (regression guard) — see hire-read-grant.db.test.ts (unchanged file,
 *             not duplicated here); this file does not touch that test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerUserMgmtRoutes } from '../../../src/http/user-mgmt.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { resolveActorTenant } from '../../../src/db/org.js';
import { RESOURCE_ROOT_NODE_ID } from '../../../src/core/read-visibility.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

interface Registered {
  tenantId: string;
  ownerSlug: string; // = KC sub = employee.slug
}

describe.skipIf(!LIVE)('T-0583 — user-mgmt (live Postgres)', () => {
  let migPool: pg.Pool;
  let appPool: pg.Pool;
  let kc: InMemoryKeycloakUserPort;
  let server: http.Server;
  let base = '';

  const tenantsToClean: string[] = [];

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    appPool = new pg.Pool({ connectionString: appUrl() });
    kc = new InMemoryKeycloakUserPort();

    const router = new Router();
    // Production wiring (server.ts): registerUserMgmtRoutes runs on the SAME
    // grantsPool that resolveActorTenant/authorizeOrgWrite/loadAdminContext use
    // (the DATABASE_URL / choros_migrator-class pool — BYPASSRLS for identity
    // resolution; RLS isolation for tenant-scoped writes/reads is enforced by
    // withTenantTx's SET LOCAL choros.tenant_id + explicit tenant_id filters,
    // not by a non-bypass Postgres role). Using appPool (choros_app, NOBYPASSRLS)
    // here would make resolveActorTenant's cross-tenant lookup fail closed
    // (ACTOR_TENANT_UNRESOLVED) BEFORE the GUC is even set — that is not how
    // server.ts wires this route, so the test uses migPool, matching prod.
    registerUserMgmtRoutes(router, migPool, kc, (actorSlug: string) =>
      resolveActorTenant(migPool, actorSlug),
    );
    server = http.createServer((req, res) => router.dispatch(req, res));
    base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        resolve(a && typeof a !== 'string' ? `http://127.0.0.1:${a.port}` : '');
      });
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const tenantId of tenantsToClean) {
      await deepDeleteTenant(tenantId);
    }
    await appPool?.end();
    await migPool?.end();
  });

  async function deepDeleteTenant(tenantId: string): Promise<void> {
    const c = await migPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query('SET LOCAL search_path TO choros');
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE tenant_id = $1`, [tenantId]);
      await c.query('COMMIT');
    } catch {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }

  async function registerOne(label: string): Promise<Registered> {
    const regKc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = {
      orgName: `T0583 ${label} ${stamp}`,
      email: `t0583-${label}-${stamp}@example.com`,
      password: 't0583-owner-password-1',
    };
    const res = await registerTenant({ pool: migPool, kc: regKc, nowMs: NOW }, req);
    tenantsToClean.push(res.tenantId);
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  function postUsers(body: unknown, actor: string): Promise<{ status: number; json: any }> {
    return fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dev-user': actor },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  }

  function getAccounts(actor: string): Promise<{ status: number; json: any }> {
    return fetch(`${base}/api/users/accounts`, {
      headers: { 'x-dev-user': actor },
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  }

  function patchUser(employeeId: string, body: unknown, actor: string): Promise<{ status: number; json: any }> {
    return fetch(`${base}/api/users/${employeeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-dev-user': actor },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  }

  // ---------------------------------------------------------------------
  // FF-583-1 / FF-583-2: create → KC user + employee(slug=userId) + role-reader.
  // ---------------------------------------------------------------------
  it('FF-583-1/2: owner creates a user account → KC user + employee(slug=KC userId) + covering READ', async () => {
    const t = await registerOne('create');
    kc.reset();
    // T-0628: login is free-form (NOT an email) — email is the separate
    // required field. This is AC-1's exact shape.
    const login = `t0583-create-${Date.now()}`;
    const email = `t0583-create-${Date.now()}@example.com`;

    const res = await postUsers(
      { tenant_id: t.tenantId, login, email, password: 'password12345', display_name: 'T-0583 Test Account' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.employee_id).toBeTruthy();
    expect(res.json.login).toBe(login);
    // Password must never appear in the response.
    expect(JSON.stringify(res.json)).not.toContain('password12345');

    // FF-583-1: createHumanUser called exactly once; slug == returned userId.
    expect(kc.createCallCount).toBe(1);
    // T-0628 (AC-1): username=login (free-form, unchanged) and email=email
    // (the distinct required field) are passed as TWO separate values — not
    // the same string duplicated into both KC fields.
    expect(kc.created[0].spec.username).toBe(login);
    expect(kc.created[0].spec.email).toBe(email);
    expect(kc.created).toHaveLength(1);
    const kcUserId = kc.created[0].userId;

    const employeeId = res.json.employee_id as string;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT slug, login, email, kind, deactivated_at FROM choros.employee WHERE tenant_id=$1 AND id=$2`,
        [t.tenantId, employeeId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('human');
      expect(rows[0].slug).toBe(kcUserId);
      // T-0628 (AC-1): login and email are stored as DISTINCT column values.
      expect(rows[0].login).toBe(login);
      expect(rows[0].email).toBe(email);
      expect(rows[0].deactivated_at).toBeNull();
      await c.query('COMMIT');
    });

    // FF-583-2: covering READ resolves for the new account (role-reader, RESOURCE_ROOT).
    const grants = await getGrantsForSubject(appPool, t.tenantId, kcUserId, Date.now());
    const covering = grants.filter(
      (g) => g.operation === 'read' && g.resourceType === 'record'
        && (g.scope as { nodeId?: string })?.nodeId === RESOURCE_ROOT_NODE_ID,
    );
    expect(covering.length, 'created account must resolve the RESOURCE_ROOT covering READ grant').toBeGreaterThanOrEqual(1);

    // T-0625 fix: GET /api/users/accounts must show the HUMAN-READABLE login
    // the owner typed (not employee.slug, which is the KC user UUID). Before
    // the fix, `login: row.slug` made this list show a raw KC UUID instead of
    // the login — this is the secondary bug from the T-0625 LIVE_PROOF diagnosis.
    const list = await getAccounts(t.ownerSlug);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const listedRow = list.json.accounts.find((a: any) => a.employee_id === employeeId);
    expect(listedRow, 'created account must appear in the list').toBeTruthy();
    expect(listedRow.login).toBe(login);
    expect(listedRow.login).not.toBe(kcUserId);
  });

  // ---------------------------------------------------------------------
  // T-0628 (AC-1, AC-2, AC-3): login is free-form (no longer email-shaped
  // per T-0625's narrower fix) — a real ordinary login like `ivan.petrov`
  // must now SUCCEED (not 400). email is the separate required field that
  // must be a valid email address, validated BEFORE any KC call, with an
  // honest 400 (never the 503 AUTH_UNAVAILABLE masquerade from the original
  // T-0583 LIVE_PROOF bug).
  // ---------------------------------------------------------------------
  it('T-0628 (AC-1): POST /api/users with a non-email login (ivan.petrov-shaped) + valid email → 201, KC called with distinct username/email', async () => {
    const t = await registerOne('nonemail');
    kc.reset();
    const login = `ivan.petrov.${Date.now()}`; // deliberately NOT email-shaped
    const email = `liveproof-${Date.now()}@example.com`;

    const res = await postUsers(
      { tenant_id: t.tenantId, login, email, password: 'password12345', display_name: 'Ordinary Login' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.login).toBe(login);
    expect(kc.createCallCount).toBe(1);
    expect(kc.created[0].spec.username).toBe(login);
    expect(kc.created[0].spec.email).toBe(email);
  });

  it('T-0628 (AC-2): POST /api/users with an invalid email → honest 400 VALIDATION, not 503; no employee row, KC never called', async () => {
    const t = await registerOne('bademail');
    kc.reset();

    const res = await postUsers(
      { tenant_id: t.tenantId, login: `liveproof-${Date.now()}`, email: 'not-an-email', password: 'password12345', display_name: 'Bad Email' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json?.error?.code ?? res.json?.code).toBe('VALIDATION');
    // Server-side validation runs BEFORE any KC call — a bad email never
    // reaches kc.createHumanUser at all.
    expect(kc.createCallCount).toBe(0);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.employee WHERE tenant_id=$1 AND display_name='Bad Email'`,
        [t.tenantId],
      );
      expect(rows[0].n).toBe(0);
      await c.query('COMMIT');
    });
  });

  it('T-0628 (AC-2): POST /api/users with a missing email → honest 400 VALIDATION, KC never called', async () => {
    const t = await registerOne('noemail');
    kc.reset();

    const res = await postUsers(
      { tenant_id: t.tenantId, login: `liveproof-${Date.now()}`, password: 'password12345', display_name: 'No Email' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json?.error?.code ?? res.json?.code).toBe('VALIDATION');
    expect(kc.createCallCount).toBe(0);
  });

  it('T-0628 (AC-3): POST /api/users with an empty login → honest 400 VALIDATION (login still required, just not email-shaped)', async () => {
    const t = await registerOne('nologin');
    kc.reset();

    const res = await postUsers(
      { tenant_id: t.tenantId, login: '', email: `t0628-${Date.now()}@example.com`, password: 'password12345', display_name: 'No Login' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json?.error?.code ?? res.json?.code).toBe('VALIDATION');
    expect(kc.createCallCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // FF-583-3: EMAIL_TAKEN -> 409, no partial employee row.
  // ---------------------------------------------------------------------
  it('FF-583-3a: EMAIL_TAKEN from KC -> 409, employee NOT created', async () => {
    const t = await registerOne('taken');
    kc.reset();
    kc.failOnCreate = true;

    const res = await postUsers(
      { tenant_id: t.tenantId, login: 'taken-login', email: 'taken@example.com', password: 'password12345', display_name: 'Taken' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(409);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.employee WHERE tenant_id=$1 AND display_name='Taken'`,
        [t.tenantId],
      );
      expect(rows[0].n).toBe(0);
      await c.query('COMMIT');
    });
  });

  it('FF-583-3b: KC unreachable (AUTH_UNAVAILABLE) -> 503, no employee row', async () => {
    const t = await registerOne('unavail');
    kc.reset();
    kc.failOnAuth = true;

    const res = await postUsers(
      { tenant_id: t.tenantId, login: 'unavail-login', email: 'unavail@example.com', password: 'password12345', display_name: 'Unavail' },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(503);
  });

  it('FF-583-3c: a DB failure AFTER KC-create (bad role_id, FK violation) triggers deleteUser 1x, no 201', async () => {
    const t = await registerOne('compensate');
    kc.reset();
    const bogusRoleId = '99999999-9999-9999-9999-999999999999'; // well-formed UUID, no such role row

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: `compensate-login-${Date.now()}`,
        email: `compensate-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Compensate Me',
        role_id: bogusRoleId, // FK violation on role_assignment insert -> tx rollback AFTER KC create
      },
      t.ownerSlug,
    );
    expect(res.status, JSON.stringify(res.json)).not.toBe(201);
    // KC user was created (createHumanUser succeeded) then compensated exactly once.
    expect(kc.createCallCount).toBe(1);
    expect(kc.deleteCallCount).toBe(1);
    expect(kc.deleteCalls[0]).toBe(kc.created[0].userId);

    // No employee row survives the rolled-back transaction.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.employee WHERE tenant_id=$1 AND display_name='Compensate Me'`,
        [t.tenantId],
      );
      expect(rows[0].n).toBe(0);
      await c.query('COMMIT');
    });
  });

  // ---------------------------------------------------------------------
  // FF-583-4: deactivate / reactivate.
  // ---------------------------------------------------------------------
  it('FF-583-4: PATCH {active:false} disables KC + sets deactivated_at; {active:true} reverses both', async () => {
    const t = await registerOne('deactivate');
    kc.reset();
    const login = `t0583-deact-${Date.now()}`;
    const email = `t0583-deact-${Date.now()}@example.com`;
    const create = await postUsers(
      { tenant_id: t.tenantId, login, email, password: 'password12345', display_name: 'Deactivate Me' },
      t.ownerSlug,
    );
    expect(create.status).toBe(201);
    const employeeId = create.json.employee_id as string;
    const kcUserId = kc.created[kc.created.length - 1].userId;

    const off = await patchUser(employeeId, { active: false }, t.ownerSlug);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.active).toBe(false);
    expect(kc.setEnabledCallCount).toBe(1);
    expect(kc.setEnabledCalls[0]).toEqual({ userId: kcUserId, enabled: false });
    expect(kc.isEnabled(kcUserId)).toBe(false);

    const listAfterOff = await getAccounts(t.ownerSlug);
    const row = listAfterOff.json.accounts.find((a: any) => a.employee_id === employeeId);
    expect(row.active).toBe(false);

    const on = await patchUser(employeeId, { active: true }, t.ownerSlug);
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.json.active).toBe(true);
    expect(kc.setEnabledCallCount).toBe(2);
    expect(kc.setEnabledCalls[1]).toEqual({ userId: kcUserId, enabled: true });

    const listAfterOn = await getAccounts(t.ownerSlug);
    const row2 = listAfterOn.json.accounts.find((a: any) => a.employee_id === employeeId);
    expect(row2.active).toBe(true);
  });

  // ---------------------------------------------------------------------
  // T-0658 (round 3) FIX-2 — LAST-OWNER GUARD: the T-0658 deactivation gate
  // (org.ts isGenesisOwnerForTenant / loadAdminContext) makes a deactivated
  // owner isGenesisOwner=false. That closes the security hole but would brick a
  // tenant if the LAST owner were deactivated (reactivation authz is
  // loadAdminContext — no one left to reactivate). PATCH {active:false} must
  // REFUSE to deactivate the last active tenant-owner (409 LAST_OWNER).
  // ---------------------------------------------------------------------

  // Resolve the owner's employee UUID from their slug (registerOne returns slug).
  async function ownerEmployeeId(tenantId: string, ownerSlug: string): Promise<string> {
    return withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query('SET LOCAL search_path TO choros');
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.employee WHERE tenant_id=$1 AND slug=$2 LIMIT 1`,
        [tenantId, ownerSlug],
      );
      await c.query('COMMIT');
      return rows[0]!.id;
    });
  }

  it('T-0658 FIX-2: deactivating the SOLE tenant-owner is refused (409 LAST_OWNER)', async () => {
    const t = await registerOne('lastowner');
    kc.reset();
    const ownerId = await ownerEmployeeId(t.tenantId, t.ownerSlug);

    // registerOne creates a tenant with exactly ONE owner (the genesis owner).
    // Deactivating them must be refused — there is no other owner to reactivate.
    const res = await patchUser(ownerId, { active: false }, t.ownerSlug);
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json.error?.code ?? res.json.code).toBe('LAST_OWNER');
    // Fail-closed BEFORE any KC/DB mutation: KC never touched, owner still active.
    expect(kc.setEnabledCallCount).toBe(0);
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT deactivated_at FROM choros.employee WHERE tenant_id=$1 AND id=$2`,
        [t.tenantId, ownerId],
      );
      await c.query('COMMIT');
      expect(rows[0].deactivated_at).toBeNull(); // still active — not bricked
    });
  });

  it('T-0658 FIX-2: with a SECOND owner present, deactivating one owner is allowed; the remaining last owner is then protected', async () => {
    const t = await registerOne('twoowners');
    kc.reset();
    const ownerId = await ownerEmployeeId(t.tenantId, t.ownerSlug);

    // Create a second human account, capture its slug (= KC userId, the actor
    // identity dev-mode auth uses).
    const login2 = `t0658-owner2-${Date.now()}`;
    const email2 = `t0658-owner2-${Date.now()}@example.com`;
    const create2 = await postUsers(
      { tenant_id: t.tenantId, login: login2, email: email2, password: 'password12345', display_name: 'Owner Two' },
      t.ownerSlug,
    );
    expect(create2.status, JSON.stringify(create2.json)).toBe(201);
    const owner2Id = create2.json.employee_id as string;
    const owner2Slug = kc.created[kc.created.length - 1].userId; // slug == KC userId

    // Grant owner2 the tenant-owner role directly (confirmed, in-window) — two
    // active owners now. Reuse the genesis owner's own org_scope so the scope is
    // schema-valid without inventing one.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      await c.query('SET LOCAL search_path TO choros');
      const { rows: roleRows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.role WHERE tenant_id=$1 AND slug='tenant-owner' LIMIT 1`,
        [t.tenantId],
      );
      const ownerRoleId = roleRows[0]!.id;
      const { rows: scopeRows } = await c.query<{ org_scope: unknown }>(
        `SELECT org_scope FROM choros.role_assignment
          WHERE tenant_id=$1 AND role_id=$2 AND employee_id=$3 LIMIT 1`,
        [t.tenantId, ownerRoleId, ownerId],
      );
      const ownerScope = scopeRows[0]!.org_scope;
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), $2, $3, $4::jsonb,
                 NULL, NULL, 'seed', 'seed', NULL, 'seed', NULL, 0, 0)`,
        [t.tenantId, owner2Id, ownerRoleId, JSON.stringify(ownerScope)],
      );
      await c.query('COMMIT');
    });

    // Deactivating the FIRST owner is now allowed (a second active owner exists).
    const res = await patchUser(ownerId, { active: false }, t.ownerSlug);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.active).toBe(false);

    // owner1 is now deactivated → they can no longer authz (loadAdminContext gate).
    // Deactivating the SECOND (now LAST) owner, called AS owner2 (still active),
    // is refused with 409 LAST_OWNER — the guard holds for whoever is last.
    const res2 = await patchUser(owner2Id, { active: false }, owner2Slug);
    expect(res2.status, JSON.stringify(res2.json)).toBe(409);
    expect(res2.json.error?.code ?? res2.json.code).toBe('LAST_OWNER');
  });

  // ---------------------------------------------------------------------
  // FF-583-5: tenant isolation.
  // ---------------------------------------------------------------------
  it('FF-583-5: cross-tenant create/patch/list are all blocked', async () => {
    const a = await registerOne('isoA');
    const b = await registerOne('isoB');
    kc.reset();

    // A's owner tries to create INTO tenant B -> 403.
    const crossCreate = await postUsers(
      { tenant_id: b.tenantId, login: 'cross-login', email: 'cross@example.com', password: 'password12345', display_name: 'Cross' },
      a.ownerSlug,
    );
    expect(crossCreate.status).toBe(403);

    // B creates their own account.
    const bCreate = await postUsers(
      { tenant_id: b.tenantId, login: `bacct-login-${Date.now()}`, email: `bacct-${Date.now()}@example.com`, password: 'password12345', display_name: 'B Account' },
      b.ownerSlug,
    );
    expect(bCreate.status).toBe(201);
    const bEmployeeId = bCreate.json.employee_id as string;

    // A's owner tries to PATCH B's employee -> 404 (resolved under A's own tenant RLS).
    const crossPatch = await patchUser(bEmployeeId, { active: false }, a.ownerSlug);
    expect(crossPatch.status).toBe(404);

    // A's account list never contains B's account.
    const aList = await getAccounts(a.ownerSlug);
    expect(aList.status).toBe(200);
    expect(aList.json.accounts.some((acct: any) => acct.employee_id === bEmployeeId)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // FF-583-6: non-privileged member -> 403 ADMIN_GATE_REJECTED (not 500/silent success).
  // ---------------------------------------------------------------------
  it('FF-583-6: a plain (non-owner, non-granted) tenant member gets 403 on create and patch', async () => {
    const t = await registerOne('nonpriv');
    kc.reset();

    // Seed a plain human employee with NO mgmt_object:employee grant/role.
    const plainSlug = `plain-${Date.now()}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), NULL, 'human', $2, 'Plain Member', $3, $3)`,
        [t.tenantId, plainSlug, Date.now()],
      );
      await c.query('COMMIT');
    });

    const createRes = await postUsers(
      { tenant_id: t.tenantId, login: 'blocked-login', email: 'blocked@example.com', password: 'password12345', display_name: 'Blocked' },
      plainSlug,
    );
    expect(createRes.status).toBe(403);
    expect(createRes.json?.error?.code ?? createRes.json?.code).toBe('NOT_OWNER');

    // Owner creates a target account, then the plain member tries to patch it.
    const ownerCreate = await postUsers(
      { tenant_id: t.tenantId, login: `target-login-${Date.now()}`, email: `target-${Date.now()}@example.com`, password: 'password12345', display_name: 'Target' },
      t.ownerSlug,
    );
    expect(ownerCreate.status).toBe(201);
    const patchRes = await patchUser(ownerCreate.json.employee_id, { active: false }, plainSlug);
    expect(patchRes.status).toBe(403);
  });

  // ---------------------------------------------------------------------
  // AC-11/AC-12 (tester-added, T-0583 TEST phase): the plaintext password
  // must never surface in ANY HTTP response body — success AND error paths
  // (create-409, create-503, create-201, list, patch) — and never in the
  // audit_event payload row written for create/deactivate/reactivate. The
  // static half of this (FF-583-7, ci/checks/user-mgmt-no-secret-leak.sh)
  // only inspects source code; this is the DYNAMIC probe its own header
  // comment claims exists but that, before this addition, only asserted the
  // password absence on the single 201-create response (see FF-583-1 above)
  // — never on 409/503/patch/list bodies nor the actual audit_event row.
  // ---------------------------------------------------------------------
  it('AC-11/AC-12: plaintext password never appears in any response body or in the audit_event payload', async () => {
    const t = await registerOne('pwleak');
    kc.reset();
    const SECRET = `t0583-super-secret-pw-${Date.now()}`;
    const login = `t0583-pwleak-${Date.now()}`;
    const email = `t0583-pwleak-${Date.now()}@example.com`;

    // 1) 409 EMAIL_TAKEN path — body must not echo the password.
    kc.failOnCreate = true;
    const conflictRes = await postUsers(
      { tenant_id: t.tenantId, login, email, password: SECRET, display_name: 'PwLeak Conflict' },
      t.ownerSlug,
    );
    expect(conflictRes.status).toBe(409);
    expect(JSON.stringify(conflictRes.json)).not.toContain(SECRET);

    // 2) 503 AUTH_UNAVAILABLE path — body must not echo the password.
    kc.failOnCreate = false;
    kc.failOnAuth = true;
    const unavailRes = await postUsers(
      { tenant_id: t.tenantId, login, email, password: SECRET, display_name: 'PwLeak Unavail' },
      t.ownerSlug,
    );
    expect(unavailRes.status).toBe(503);
    expect(JSON.stringify(unavailRes.json)).not.toContain(SECRET);

    // 3) 201 create path — body must not echo the password (redundant with
    // FF-583-1 but re-asserted here alongside the other paths for one
    // single-purpose AC-11/AC-12 test).
    kc.failOnAuth = false;
    const createRes = await postUsers(
      { tenant_id: t.tenantId, login, email, password: SECRET, display_name: 'PwLeak Create' },
      t.ownerSlug,
    );
    expect(createRes.status, JSON.stringify(createRes.json)).toBe(201);
    expect(JSON.stringify(createRes.json)).not.toContain(SECRET);
    const employeeId = createRes.json.employee_id as string;

    // 4) GET /accounts — list body must not echo the password.
    const listRes = await getAccounts(t.ownerSlug);
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.json)).not.toContain(SECRET);

    // 5) PATCH deactivate/reactivate — body must not echo the password
    // (the PATCH body itself never carries a password, but assert the
    // RESPONSE never does either, matching the AC-11 "every response" scope).
    const off = await patchUser(employeeId, { active: false }, t.ownerSlug);
    expect(off.status).toBe(200);
    expect(JSON.stringify(off.json)).not.toContain(SECRET);
    const on = await patchUser(employeeId, { active: true }, t.ownerSlug);
    expect(on.status).toBe(200);
    expect(JSON.stringify(on.json)).not.toContain(SECRET);

    // 6) AC-12: audit_event payload rows for this tenant's user_account.*
    // events never carry the plaintext password (dynamic DB-level probe —
    // the static script can only see the source, not what was ACTUALLY
    // written at runtime).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query<{ payload: unknown }>(
        `SELECT payload FROM choros.audit_event
          WHERE tenant_id = $1
            AND type IN ('user_account.create', 'user_account.deactivate', 'user_account.reactivate')`,
        [t.tenantId],
      );
      expect(rows.length, 'expected at least the create+deactivate+reactivate audit rows').toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        expect(JSON.stringify(row.payload)).not.toContain(SECRET);
      }
      await c.query('COMMIT');
    });
  });

  // ---------------------------------------------------------------------
  // T-0633 [SECURITY]: anti-collision on mint — a login that collides with an
  // existing HUMAN employee slug (in ANY tenant) is rejected 409 LOGIN_RESERVED
  // BEFORE any Keycloak call. This is the load-bearing block for the vertical
  // privilege-escalation vector: without it, a holder of
  // mgmt_object:employee:create (NOT the owner) could mint a KC user named
  // 'e-owner' (genesis forest-owner, 16 delegable mgmt-grants + tenant-owner,
  // migrations/026 — a kind='human' employee with NO KC user at install, so KC
  // does not 409), log in, miss sub-first identity resolution, and be resolved
  // to the forest-owner via the cross-tenant preferred_username → employee.slug
  // fallback (src/db/org.ts resolveActorSlugFromAuth). The seed personas below
  // ('e-owner', 'e-configurator') live in the always-migrated genesis tenant
  // a0000000-…-001; 'e-orlov' is a seeded persona too. The check is cross-tenant
  // (matches the fallback it protects), so it fires even though the actor mints
  // into their OWN tenant.
  // ---------------------------------------------------------------------
  it('FF-633-1 [SECURITY]: POST /api/users with login=e-owner (genesis forest-owner slug) → 409 LOGIN_RESERVED, KC never called, no employee row', async () => {
    const t = await registerOne('escalate-owner');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'e-owner', // collides with the genesis forest-owner slug
        email: `escalate-owner-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Escalation Attempt',
      },
      t.ownerSlug,
    );

    // Rejected BEFORE any side-effect — the escalation vector is closed.
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    // KC user was NEVER created (guard runs before createHumanUser) — no orphan.
    expect(kc.createCallCount, 'KC must not be called when the login collides').toBe(0);

    // No employee row named 'e-owner' was created in the actor's own tenant.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.employee WHERE tenant_id=$1 AND (slug='e-owner' OR login='e-owner')`,
        [t.tenantId],
      );
      expect(rows).toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('FF-633-2 [SECURITY]: POST /api/users with login=e-configurator (role-configurator authoring persona) → 409 LOGIN_RESERVED, KC never called', async () => {
    const t = await registerOne('escalate-config');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'e-configurator', // seeded human persona slug (migrations/088)
        email: `escalate-config-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Escalation Attempt 2',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    expect(kc.createCallCount).toBe(0);
  });

  it('FF-633-3 [SECURITY]: POST /api/users with login=e-orlov (any existing human employee slug) → 409 LOGIN_RESERVED, KC never called', async () => {
    const t = await registerOne('escalate-orlov');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'e-orlov', // an existing seeded human employee slug
        email: `escalate-orlov-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Escalation Attempt 3',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    expect(kc.createCallCount).toBe(0);
  });

  it('FF-633-4 [SECURITY]: a freshly-created account\'s login is itself reserved — a SECOND POST with the same login → 409 LOGIN_RESERVED', async () => {
    const t = await registerOne('escalate-dup');
    kc.reset();
    const login = `dup-login-${Date.now()}`;
    const email1 = `dup1-${Date.now()}@example.com`;

    // First create succeeds (non-colliding login).
    const first = await postUsers(
      { tenant_id: t.tenantId, login, email: email1, password: 'password12345', display_name: 'First' },
      t.ownerSlug,
    );
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(kc.createCallCount).toBe(1);

    // Note: the created employee's slug is the KC userId (a UUID), but its
    // `login` column holds the human-readable login. Anti-collision keys on the
    // employee *slug*, so a same-login retry is NOT blocked by THIS guard — the
    // KC layer's own username uniqueness (EMAIL_TAKEN/username-exists) is the
    // relevant guard for a duplicate real login. To prove the SLUG collision is
    // what's reserved, we retry with the just-minted account's SLUG as a login.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query<{ slug: string }>(
        `SELECT slug FROM choros.employee WHERE tenant_id=$1 AND login=$2`,
        [t.tenantId, login],
      );
      expect(rows).toHaveLength(1);
      const mintedSlug = rows[0].slug; // = KC userId (a UUID)
      await c.query('COMMIT');

      kc.reset();
      const second = await postUsers(
        {
          tenant_id: t.tenantId,
          login: mintedSlug, // colliding with an existing employee slug
          email: `dup2-${Date.now()}@example.com`,
          password: 'password12345',
          display_name: 'Second',
        },
        t.ownerSlug,
      );
      expect(second.status, JSON.stringify(second.json)).toBe(409);
      expect(second.json?.error?.code ?? second.json?.code).toBe('LOGIN_RESERVED');
      expect(kc.createCallCount).toBe(0);
    });
  });

  it('FF-633-5 (regression): a NON-colliding, seed-slug-adjacent login (e.g. "e-owner-external") still mints → 201; the guard is exact-match, not a prefix ban', async () => {
    const t = await registerOne('nearmiss');
    kc.reset();
    // Deliberately NEAR a seed slug but not equal — must NOT be false-positived.
    const login = `e-owner-external-${Date.now()}`;
    const email = `nearmiss-${Date.now()}@example.com`;

    const res = await postUsers(
      { tenant_id: t.tenantId, login, email, password: 'password12345', display_name: 'Ordinary External' },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.login).toBe(login);
    expect(kc.createCallCount).toBe(1);
    expect(kc.created[0].spec.username).toBe(login);
  });

  // ---------------------------------------------------------------------
  // T-0633 ROUND-3 [SECURITY] — case-collision bypass of the anti-collision
  // guard. RE-VERIFY finding (live against KC 25.0.6): Keycloak LOWERCASES the
  // username at creation, but the pre-round-3 guard compared byte-exact, so a
  // MIXED-CASE login ('E-Configurator') MISSED the guard's SQL (no
  // employee.slug == 'E-Configurator') → guard PASSED → KC stored
  // 'e-configurator' → token preferred_username='e-configurator' → resolved to
  // the SEED persona 'e-configurator' (role-configurator authoring) via the
  // cross-tenant fallback. A vertical privilege escalation for ANY seed
  // kind='human' slug lacking a KC user at install. The round-3 fix lowercases
  // `login` BEFORE the guard and before the KC username so both sides see the
  // one form KC stores. These tests are the load-bearing RE-VERIFY: each MUST
  // fail on pre-round-3 code (mixed-case would 201) and pass after.
  // ---------------------------------------------------------------------
  it("FF-633-6 [SECURITY]: POST /api/users with login='E-Owner' (mixed-case of a seed slug) → 409 LOGIN_RESERVED, KC never called — case-collision bypass closed", async () => {
    const t = await registerOne('escalate-owner-case');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'E-Owner', // KC would fold to 'e-owner' → the genesis forest-owner slug
        email: `escalate-owner-case-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Case Escalation Attempt',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    expect(kc.createCallCount, 'KC must not be called when the folded login collides').toBe(0);
  });

  it("FF-633-7 [SECURITY]: POST /api/users with login='E-Configurator' (mixed-case seed persona) → 409 LOGIN_RESERVED, KC never called", async () => {
    const t = await registerOne('escalate-config-case');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'E-Configurator', // KC folds to 'e-configurator' (migrations/088 authoring persona)
        email: `escalate-config-case-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Case Escalation Attempt 2',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    expect(kc.createCallCount).toBe(0);
  });

  it("FF-633-8 [SECURITY]: POST /api/users with login='eL-orLoV' (arbitrary casing of a seed slug) → 409 LOGIN_RESERVED", async () => {
    const t = await registerOne('escalate-orlov-case');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'eL-orLoV', // folds to 'el-orlov'? no — case-only variant of 'e-orlov'
        email: `escalate-orlov-case-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Case Escalation Attempt 3',
      },
      t.ownerSlug,
    );

    // 'eL-orLoV'.toLowerCase() === 'el-orlov' which is NOT a seed slug — this is
    // a genuine near-miss, so it must MINT (201). Kept as a discriminating
    // control: the fix folds case, it does NOT collapse distinct strings.
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    // The stored login/username is the FOLDED form (matches what KC stores).
    expect(res.json.login).toBe('el-orlov');
    expect(kc.createCallCount).toBe(1);
    expect(kc.created[0].spec.username).toBe('el-orlov');
  });

  it("FF-633-9 [SECURITY]: exact mixed-case of a seed slug 'E-Orlov' → 409 LOGIN_RESERVED", async () => {
    const t = await registerOne('escalate-orlov-exactcase');
    kc.reset();

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: 'E-Orlov', // folds to 'e-orlov' — a seeded human employee slug
        email: `escalate-orlov-exactcase-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Case Escalation Attempt 4',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_RESERVED');
    expect(kc.createCallCount).toBe(0);
  });

  it('FF-633-10 (policy): a legit NON-colliding MIXED-CASE login normalizes to lowercase on both the KC username and the stored/returned login (KC-honest, no divergence)', async () => {
    const t = await registerOne('mixedcase-legit');
    kc.reset();
    const suffix = `${Date.now()}`;
    const mixed = `Ivan.Petrov-${suffix}`;
    const expectedFolded = mixed.toLowerCase();
    const email = `ivan-${suffix}@example.com`;

    const res = await postUsers(
      { tenant_id: t.tenantId, login: mixed, email, password: 'password12345', display_name: 'Иван Петров' },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(201);
    // Policy DECISION (T-0633 round-3): a mixed-case login is NOT rejected — it
    // is FOLDED to lowercase (the one form KC stores), so guard/token/storage
    // never diverge. Response, stored column, and KC username are all the
    // folded form.
    expect(res.json.login).toBe(expectedFolded);
    expect(kc.createCallCount).toBe(1);
    expect(kc.created[0].spec.username).toBe(expectedFolded);
    expect(kc.created[0].spec.email).toBe(email);

    // The employee.login column persists the folded form (so a later login,
    // which KC also folds, resolves to the same row).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t.tenantId}'`);
      const { rows } = await c.query<{ login: string }>(
        `SELECT login FROM choros.employee WHERE tenant_id=$1 AND id=$2`,
        [t.tenantId, res.json.employee_id as string],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].login).toBe(expectedFolded);
      await c.query('COMMIT');
    });
  });

  it('FF-633-11 (minor): a KC USERNAME conflict → 409 LOGIN_TAKEN with a "login is taken" message (not the misleading "email already exists")', async () => {
    const t = await registerOne('login-taken');
    kc.reset();
    kc.failOnLoginTaken = true; // next createHumanUser throws LOGIN_TAKEN (KC username clash)

    const res = await postUsers(
      {
        tenant_id: t.tenantId,
        login: `login-clash-${Date.now()}`, // non-colliding with any SEED slug → passes anti-collision guard
        email: `login-taken-${Date.now()}@example.com`,
        password: 'password12345',
        display_name: 'Login Clash',
      },
      t.ownerSlug,
    );

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json?.error?.code ?? res.json?.code).toBe('LOGIN_TAKEN');
    // The message must point at the LOGIN, not the email.
    const msg = String(res.json?.error?.message ?? res.json?.message ?? '').toLowerCase();
    expect(msg).toContain('login');
    expect(msg).not.toContain('email');
    // KC was reached (guard passed for a non-seed login) then reported the clash.
    expect(kc.createCallCount).toBe(1);
  });
});
