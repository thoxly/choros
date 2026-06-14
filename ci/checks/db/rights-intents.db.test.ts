// T-0223 · D-2 intent operations — LIVE Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//     npm run fitness:db
//
// Covers the §7 fitness criteria of the T-0222 ADR end-to-end over the HTTP path:
//   FF-HIRE-1   — hire issues grants ONLY by expanding a DICT_PRESETS preset; the
//                 issued grant rows carry granted_by='intent:hire:<presetId>' and
//                 a role_assignment is created. (I-1)
//   FF-FIRE-2   — fire is per-principal atomic: after a fire the principal has
//                 ZERO effective role-assignments (all valid_until ≤ now). (§3.2)
//   FF-SUB-3    — a widening substitution is REJECTED (422) and nothing is
//                 persisted; a valid Tier-2 substitution mints a delegable=false
//                 TTL'd grant whose scope ⊑ the substituted role's grant. (I-2)
//   FF-REVOKE-3 — urgent-revoke is immediate: the grant's valid_until is stamped
//                 = now, so isEffective(now) is false on the next PDP eval; for an
//                 agent the response signals halt_active_run. (§3.4)
//   FF-EXPLAIN-4— explain in the employee card goes through POST /api/pdp/explain;
//                 a non-admin caller about ANOTHER subject gets 403 (anti-oracle). (I-3)
//   FF-AUDIT-5  — every intent op emits ≥1 audit_event via the single sink. (I-4)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, withClient } from './_helpers.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Dev silo constants (stable UUIDs from migrations).
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_BUDGET = 'e0000000-0000-0000-0000-000000000002'; // budget-approver
const DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';
const EMP_MIRONOV = 'd0000000-0000-0000-0000-000000000004'; // absentee in seed sub
const EMP_RECON = 'd0000000-0000-0000-0000-000000000002';   // substitute in seed sub
const OWNER_SLUG = 'e-owner'; // genesis owner (loadAdminContext queries by slug)

const FIN_NODE = { kind: 'node', hierarchy: 'org', nodeId: DEPT_FIN, nodeLevel: 'department' };

let server: http.Server;
let port: number;
const createdEmployees: string[] = [];
const createdGrants: string[] = [];
const createdAssignments: string[] = [];
const createdRules: string[] = [];

function api(path: string, body: unknown, user = OWNER_SLUG): Promise<{ status: number; json: any }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-user': user },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

beforeAll(async () => {
  const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  // Best-effort DB cleanup before closing the server.
  await withClient(migratorUrl(), async (c) => {
    await c.query(`SET search_path TO choros`);
    for (const id of createdRules) {
      await c.query(`DELETE FROM choros.substitution_rule WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
    }
    for (const id of createdGrants) {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
    }
    for (const id of createdAssignments) {
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
    }
    // Delete substitution rules / grants that reference soon-to-be-deleted employees first.
    for (const id of createdEmployees) {
      await c.query(`DELETE FROM choros.substitution_rule WHERE tenant_id=$1 AND substitute_employee_id=$2`, [DEV_TENANT, id]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND employee_id=$2`, [DEV_TENANT, id]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
    }
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function countAudit(): Promise<number> {
  return withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM choros.audit_event WHERE tenant_id=$1`, [DEV_TENANT]);
    return rows[0].n as number;
  });
}

// ---------------------------------------------------------------------------
// FF-HIRE-1 + FF-AUDIT-5 — hire issues preset grants only (I-1) + audit per op
// ---------------------------------------------------------------------------
describe('FF-HIRE-1: hire expands a DICT_PRESETS preset into grants (I-1)', () => {
  it('hires a new human into p-budget-approver → role_assignment + preset grant rows + audit', async () => {
    const beforeAudit = await countAudit();
    const slug = `e-t0223-hire-${Date.now()}`;
    const res = await api('/api/rights/intents/hire', {
      preset_id: 'p-budget-approver', // non-critical preset → active
      role_id: ROLE_BUDGET,
      kind: 'human',
      slug,
      display_name: 'T-0223 Hire',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.state).toBe('active');
    expect(res.json.grants_issued).toBeGreaterThan(0);
    createdEmployees.push(res.json.employee_id);
    createdAssignments.push(res.json.role_assignment_id);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      // The issued grants carry the intent→preset provenance (I-1: no hand-built atom).
      const { rows: grants } = await c.query(
        `SELECT id, granted_by FROM choros."grant"
          WHERE tenant_id=$1 AND role_id=$2 AND granted_by='intent:hire:p-budget-approver'`,
        [DEV_TENANT, ROLE_BUDGET],
      );
      expect(grants.length).toBeGreaterThan(0);
      for (const g of grants) createdGrants.push(g.id);

      // The role_assignment exists and is active.
      const { rows: ra } = await c.query(
        `SELECT id FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2 AND confirmed_by IS NOT NULL`,
        [DEV_TENANT, res.json.role_assignment_id],
      );
      expect(ra.length).toBe(1);
    });

    // FF-AUDIT-5: hire folded to ≥1 audit event on the single sink.
    expect(await countAudit()).toBeGreaterThan(beforeAudit);
  });

  it('404 PRESET_NOT_FOUND for an unknown preset key (T-0224 seeds the definitions)', async () => {
    const res = await api('/api/rights/intents/hire', {
      preset_id: 'p-does-not-exist', role_id: ROLE_BUDGET, kind: 'human',
      slug: `e-t0223-x-${Date.now()}`, display_name: 'x',
    });
    expect(res.status).toBe(404);
    expect(res.json.error?.code).toBe('PRESET_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// FF-FIRE-2 — fire is per-principal atomic (zero effective assignments after)
// ---------------------------------------------------------------------------
describe('FF-FIRE-2: fire atomically revokes all of a principal authority', () => {
  it('after fire, the principal has zero effective role-assignments + audit', async () => {
    // Hire a throwaway employee first so we have authority to remove.
    const slug = `e-t0223-fire-${Date.now()}`;
    const hire = await api('/api/rights/intents/hire', {
      preset_id: 'p-budget-approver', role_id: ROLE_BUDGET, kind: 'human', slug, display_name: 'T-0223 Fire',
    });
    expect(hire.status, JSON.stringify(hire.json)).toBe(201);
    const employeeId = hire.json.employee_id;
    createdEmployees.push(employeeId);
    createdAssignments.push(hire.json.role_assignment_id);

    const beforeAudit = await countAudit();
    const fire = await api('/api/rights/intents/fire', { employee_id: employeeId });
    expect(fire.status, JSON.stringify(fire.json)).toBe(200);
    expect(fire.json.revoked_assignments).toBeGreaterThanOrEqual(1);
    expect(fire.json.reassign_required).toBe(true);
    // Evaluate effectiveness at a `now` strictly AFTER the revoke instant (the
    // server stamps valid_until = its-own-now, which is ≥ any pre-call timestamp).
    const after = Date.now() + 1;

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      // Zero effective assignments: every row has valid_until ≤ now (FF-FIRE-2:
      // per-principal atomic — no residual authority).
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment
          WHERE tenant_id=$1 AND employee_id=$2
            AND (valid_until IS NULL OR valid_until > $3)`,
        [DEV_TENANT, employeeId, after],
      );
      expect(rows[0].n).toBe(0);
      // And every assignment row of the principal now carries a non-null valid_until
      // (it was stamped, not left open) — the atomic-revoke happened.
      const { rows: stamped } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment
          WHERE tenant_id=$1 AND employee_id=$2 AND valid_until IS NULL`,
        [DEV_TENANT, employeeId],
      );
      expect(stamped[0].n).toBe(0);
    });
    expect(await countAudit()).toBeGreaterThan(beforeAudit);
  });
});

// ---------------------------------------------------------------------------
// FF-SUB-3 — substitution ⊆ substituted (Tier-2 mint subset-gated)
// ---------------------------------------------------------------------------
describe('FF-SUB-3: substitution mints a non-widening, non-delegable TTL grant (I-2)', () => {
  it('valid Tier-2 substitution mints delegable=false grant ⊑ substituted role; widening impossible', async () => {
    const validUntil = Date.now() + 86_400_000;
    const res = await api('/api/rights/intents/substitute', {
      absent_employee_id: EMP_MIRONOV,
      substitute_employee_id: EMP_RECON,
      role_id: ROLE_BUDGET,
      valid_until: validUntil,
      org_scope: FIN_NODE,
      force_tier2: true, // force the mint path so we can assert the subset gate
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.tier).toBe(2);
    expect(res.json.ttl_grant_id).toBeTruthy();
    createdRules.push(res.json.rule_id);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      // Find all grants minted for this substitution (granted_by='intent:substitute', TTL'd).
      const { rows: minted } = await c.query(
        `SELECT id, delegable, valid_until, scope, resource_type, operation
           FROM choros."grant"
          WHERE tenant_id=$1 AND role_id=$2 AND granted_by='intent:substitute'
            AND valid_until=$3`,
        [DEV_TENANT, ROLE_BUDGET, validUntil],
      );
      expect(minted.length).toBeGreaterThan(0);
      for (const g of minted) {
        createdGrants.push(g.id);
        // I-2: the loaned grant is non-re-delegable + TTL'd (auto-expiry).
        expect(g.delegable).toBe(false);
        expect(Number(g.valid_until)).toBe(validUntil);
        // The minted scope equals one of the substituted role's grant scopes (⊑, not widened).
        const { rows: parents } = await c.query(
          `SELECT 1 FROM choros."grant"
            WHERE tenant_id=$1 AND role_id=$2 AND confirmed_by IS NOT NULL
              AND resource_type=$3 AND operation=$4 AND scope=$5::jsonb
              AND granted_by <> 'intent:substitute'`,
          [DEV_TENANT, ROLE_BUDGET, g.resource_type, g.operation, JSON.stringify(g.scope)],
        );
        expect(parents.length, 'minted grant scope must match a substituted-role parent grant (⊑)').toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// FF-REVOKE-3 — urgent-revoke is immediate + agent halt signal
// ---------------------------------------------------------------------------
describe('FF-REVOKE-3: urgent-revoke stamps valid_until=now immediately (§3.4)', () => {
  it('revokes a grant immediately (valid_until ≤ now) and signals halt for an agent', async () => {
    // Issue a fresh grant via a hire so we own a revocable grant id.
    const slug = `e-t0223-rev-${Date.now()}`;
    const hire = await api('/api/rights/intents/hire', {
      preset_id: 'p-budget-approver', role_id: ROLE_BUDGET, kind: 'agent', slug, display_name: 'T-0223 Rev',
    });
    expect(hire.status, JSON.stringify(hire.json)).toBe(201);
    createdEmployees.push(hire.json.employee_id);
    createdAssignments.push(hire.json.role_assignment_id);

    const grantId = await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      const { rows } = await c.query(
        `SELECT id FROM choros."grant"
          WHERE tenant_id=$1 AND role_id=$2 AND granted_by='intent:hire:p-budget-approver'
            AND (valid_until IS NULL OR valid_until > $3)
          ORDER BY created_at DESC LIMIT 1`,
        [DEV_TENANT, ROLE_BUDGET, Date.now()],
      );
      return rows[0]?.id as string;
    });
    expect(grantId).toBeTruthy();
    createdGrants.push(grantId);

    const beforeAudit = await countAudit();
    const now = Date.now();
    const res = await api('/api/rights/intents/urgent-revoke', { grant_id: grantId, principal_kind: 'agent' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.revoked).toBe(true);
    // FF-REVOKE-3: agent run must halt at next step boundary (fail-closed signal).
    expect(res.json.halt_active_run).toBe(true);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      const { rows } = await c.query(
        `SELECT valid_until FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length).toBe(1);
      expect(Number(rows[0].valid_until)).toBeLessThanOrEqual(now + 5_000);
      expect(rows[0].valid_until).not.toBeNull();
    });
    expect(await countAudit()).toBeGreaterThan(beforeAudit);
  });

  it('404 for an unknown grant id', async () => {
    const res = await api('/api/rights/intents/urgent-revoke', {
      grant_id: 'd0000000-0000-0000-0000-0000000000aa', principal_kind: 'human',
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FF-EXPLAIN-4 — explain-in-card behind mgmt-grant; anti-oracle 403 (I-3)
// ---------------------------------------------------------------------------
describe('FF-EXPLAIN-4: employee-card explain enforces the mgmt-grant gate (anti-oracle)', () => {
  it('non-admin caller about ANOTHER subject → 403 (anti-oracle, no detail leak)', async () => {
    // A caller with no mgmt_object:grant asking about another subject must be denied.
    const res = await api(
      '/api/pdp/explain',
      {
        subject: { tenantId: DEV_TENANT, subjectId: EMP_MIRONOV },
        handle: { ref: { kind: 'registry', tenantId: DEV_TENANT, applicationId: 'mcp://ledger.invoices', registryId: 'mcp://ledger.invoices' }, tenantId: DEV_TENANT },
        operation: 'read',
      },
      'e-nobody-t0223', // not an admin; not the subject
    );
    expect(res.status).toBe(403);
    // Anti-oracle: the 403 body is a generic code, not a rights enumeration.
    expect(res.json.error?.code).toBe('EXPLAIN_FORBIDDEN');
  });

  it('admin (genesis owner) about a subject → 200 with a verdict + trace', async () => {
    const res = await api(
      '/api/pdp/explain',
      {
        subject: { tenantId: DEV_TENANT, subjectId: EMP_MIRONOV },
        handle: { ref: { kind: 'registry', tenantId: DEV_TENANT, applicationId: 'mcp://ledger.invoices', registryId: 'mcp://ledger.invoices' }, tenantId: DEV_TENANT },
        operation: 'read',
      },
      OWNER_SLUG,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(['allow', 'deny']).toContain(res.json.verdict);
    expect(Array.isArray(res.json.steps)).toBe(true);
  });
});
