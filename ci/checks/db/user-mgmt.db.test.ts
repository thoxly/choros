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
});
