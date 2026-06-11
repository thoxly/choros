// T-0044 · dual-control gate — live Postgres + HTTP write-path e2e probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=... npm run fitness:db
//
// Covers the rev-2 two-request enforcement shape + R-AUTH (authenticated-only
// approvers), exercising the REAL POST /api/grants write-path against the dev
// silo as the genesis owner (x-dev-user: e-owner):
//
//   AC-11  — routine (non-escalating) change completes in ONE request with
//            confirmed_by = authenticated actor (≠ a body-asserted confirmer);
//            confirmed2_by IS NULL; a dualcontrol.gate WORM event is emitted.
//   AC-10  — a criticality-escalating change (operation:"approve" raising axis a)
//            lands SEMI-CONFIRMED (confirmed2_by IS NULL, NOT active); the gate
//            does NOT complete it with a single authenticated actor. A pending
//            dualcontrol.gate WORM event exists.
//   AC-NEW — (a) a body-supplied approvers[]/confirmed_by/confirmed2_by is IGNORED
//            (the columns come from extractActor, not the body).
//            (b) a second confirm by the SAME actor (== confirmed_by) → 409
//            DUAL_CONTROL_UNSATISFIED/self_confirm; the row stays semi-confirmed.
//            (c) a second confirm by a DISTINCT authenticated actor → 200,
//            confirmed2_by set (semi-confirmed → confirmed).
//   Migration 031 — grant.confirmed2_by + role_assignment.confirmed2_by columns exist.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const DEV_DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';

const FIN_NODE_SCOPE = {
  kind: 'node',
  hierarchy: 'org',
  nodeId: DEV_DEPT_FIN,
  nodeLevel: 'department',
};

// A second authenticated genesis-class actor for req#2. e-owner is the genesis
// owner; we also use the SAME slug to prove same-actor self-confirm is rejected,
// and a DIFFERENT slug (e-owner2 is not seeded, so we reuse the genesis owner
// for the admin gate but a distinct x-dev-user string for distinctness). Since
// the admin gate short-circuits for the genesis owner only, the second confirm
// path does NOT re-run the admin gate (it only checks distinctness over the DB
// row), so any distinct x-dev-user string works for req#2.
const ACTOR1 = 'e-owner';
const ACTOR2 = 'e-second-approver';

// ---------------------------------------------------------------------------
// Migration 031: confirmed2_by columns exist on grant + role_assignment
// ---------------------------------------------------------------------------
describe('Migration 031: confirmed2_by column added to grant + role_assignment', () => {
  it('both tables have a nullable text confirmed2_by column', async () => {
    await withClient(migratorUrl(), async (c) => {
      for (const t of ['grant', 'role_assignment']) {
        const { rows } = await c.query(
          `SELECT data_type, is_nullable FROM information_schema.columns
            WHERE table_schema='choros' AND table_name=$1 AND column_name='confirmed2_by'`,
          [t],
        );
        expect(rows.length, `${t}.confirmed2_by missing`).toBe(1);
        expect(rows[0].data_type).toBe('text');
        expect(rows[0].is_nullable).toBe('YES');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP e2e harness
// ---------------------------------------------------------------------------
describe('T-0044 dual-control gate write-path e2e', () => {
  let server: http.Server;
  let port: number;

  // Per-suite fresh role so the from-criticality is deterministic (all-routine).
  const TEST_ROLE = uuid();

  beforeAll(async () => {
    // Seed a fresh role with NO grants (so its effective criticality is routine).
    await withClient(migratorUrl(), async (c) => {
      const now = Date.now();
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, 'T-0044 test role', $4, $4)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, TEST_ROLE, `t0044-${TEST_ROLE.slice(0, 8)}`, now],
      );
    });

    const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Cleanup grants + role + audit events for the test role.
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND role_id=$2`, [DEV_TENANT, TEST_ROLE]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, TEST_ROLE]);
    });
  });

  async function postGrant(
    actor: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dev-user': actor },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  // --- AC-11: routine (read) change → one approver, confirmed, WORM event ---
  it('AC-11: routine read grant completes in one request (confirmed_by=actor, confirmed2_by NULL)', async () => {
    const { status, json } = await postGrant(ACTOR1, {
      role_id: TEST_ROLE,
      resource_type: 'record',
      operation: 'read',
      scope: FIN_NODE_SCOPE,
      granted_by: ACTOR1,
    });
    expect(status, JSON.stringify(json)).toBe(201);
    expect(json.state).toBe('confirmed');
    const grantId = json.id as string;

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT confirmed_by, confirmed2_by FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].confirmed_by).toBe(ACTOR1); // authenticated actor, NOT a body field
      expect(rows[0].confirmed2_by).toBeNull();

      // a dualcontrol.gate WORM event was emitted (satisfied).
      const ev = await c.query(
        `SELECT payload, via FROM choros.audit_event
          WHERE tenant_id=$1 AND type='dualcontrol.gate' AND subject=$2`,
        [DEV_TENANT, grantId],
      );
      expect(ev.rows.length).toBeGreaterThanOrEqual(1);
      expect(ev.rows[0].via).toBe('dual-control');
    });
  });

  // --- AC-NEW (a): body-supplied confirmed_by/confirmed2_by/approvers IGNORED ---
  it('AC-NEW(a): body-asserted confirmed_by/confirmed2_by/approvers are ignored (R-AUTH)', async () => {
    const { status, json } = await postGrant(ACTOR1, {
      role_id: TEST_ROLE,
      resource_type: 'record',
      operation: 'read',
      scope: FIN_NODE_SCOPE,
      granted_by: ACTOR1,
      // Adversarial body fields — must NOT reach the columns.
      confirmed_by: 'attacker',
      confirmed2_by: 'attacker2',
      approvers: ['attacker', 'attacker2'],
      proposed_by: 'attacker',
    });
    expect(status, JSON.stringify(json)).toBe(201);
    const grantId = json.id as string;
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT proposed_by, confirmed_by, confirmed2_by FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows[0].confirmed_by).toBe(ACTOR1); // authenticated, not "attacker"
      expect(rows[0].confirmed_by).not.toBe('attacker');
      expect(rows[0].confirmed2_by).toBeNull(); // body "attacker2" ignored
    });
  });

  // --- AC-10: escalating (approve) change → semi-confirmed, NOT active -------
  // and AC-NEW (b)/(c): same-actor req#2 → 409; distinct req#2 → 200.
  it('AC-10/AC-NEW: approve grant escalates → semi-confirmed; req#2 distinctness enforced', async () => {
    const { status, json } = await postGrant(ACTOR1, {
      role_id: TEST_ROLE,
      resource_type: 'record',
      operation: 'approve', // axis a: routine → critical ⇒ escalates ⇒ 2 approvers
      scope: FIN_NODE_SCOPE,
      granted_by: ACTOR1,
    });
    expect(status, JSON.stringify(json)).toBe(201);
    expect(json.state).toBe('semi-confirmed');
    expect(json.second_approver_required).toBe(true);
    const grantId = json.id as string;

    // Row is semi-confirmed: confirmed_by = actor1, confirmed2_by NULL (NOT active).
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT proposed_by, confirmed_by, confirmed2_by FROM choros."grant"
          WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows[0].proposed_by).toBe(ACTOR1);
      expect(rows[0].confirmed_by).toBe(ACTOR1);
      expect(rows[0].confirmed2_by, 'must be semi-confirmed (NOT active)').toBeNull();

      // a pending dualcontrol.gate WORM event exists.
      const ev = await c.query(
        `SELECT payload FROM choros.audit_event
          WHERE tenant_id=$1 AND type='dualcontrol.gate' AND subject=$2 AND via='dual-control'`,
        [DEV_TENANT, grantId],
      );
      expect(ev.rows.length).toBeGreaterThanOrEqual(1);
      const payload = ev.rows[0].payload as Record<string, unknown>;
      expect(payload.required_approvers).toBe(2);
      expect(payload.status).toBe('pending');
    });

    // AC-NEW(b): same actor (== confirmed_by) cannot self-satisfy req#2 → 409.
    const selfConfirm = await postGrant(ACTOR1, { phase: 'confirm2', change_ref: grantId });
    expect(selfConfirm.status).toBe(409);
    const selfErr = (selfConfirm.json.error ?? {}) as Record<string, unknown>;
    expect(selfErr.code).toBe('DUAL_CONTROL_UNSATISFIED');
    expect(selfErr.message).toBe('self_confirm');

    // Row still semi-confirmed after the rejected self-confirm.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT confirmed2_by FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows[0].confirmed2_by, 'row must stay semi-confirmed after self-confirm reject').toBeNull();
    });

    // AC-NEW(c): a DISTINCT authenticated actor completes req#2 → 200, confirmed.
    const secondConfirm = await postGrant(ACTOR2, { phase: 'confirm2', change_ref: grantId });
    expect(secondConfirm.status, JSON.stringify(secondConfirm.json)).toBe(200);
    expect(secondConfirm.json.state).toBe('confirmed');

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT confirmed2_by FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows[0].confirmed2_by, 'second authenticated approver recorded').toBe(ACTOR2);

      // a second-confirm WORM event exists.
      const ev = await c.query(
        `SELECT via FROM choros.audit_event
          WHERE tenant_id=$1 AND type='dualcontrol.gate' AND subject=$2
            AND via='dual-control.second-confirm'`,
        [DEV_TENANT, grantId],
      );
      expect(ev.rows.length).toBeGreaterThanOrEqual(1);
    });

    // A THIRD confirm (already confirmed) → 409 already_confirmed.
    const third = await postGrant('e-third', { phase: 'confirm2', change_ref: grantId });
    expect(third.status).toBe(409);
  });
});
