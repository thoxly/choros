// T-0645 [SECURITY] · agent-instruction promote is SCOPED to the owning agent.
//
// Live-Postgres proof (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Closes the T-0637 privilege-escalation ASYMMETRY: publishing an AGENT
// INSTRUCTION (which becomes the live LLM agent's system prompt) previously
// required only the GENERIC, agent-unbound `mgmt_object:tier_promote/transition`
// grant that grant/registry/app publishing shares — a WEAKER right than saving the
// draft (which needs scoped `mgmt_object:agent/update` over the owning agent).
//
// After the fix `POST /api/artifacts/:id/promote { artifact_table:'agent_instruction' }`
// gates on the SAME scoped authority as saveDraft (holdsAgentMgmtUpdate over the
// owning agent), REPLACING the generic gate for THIS artifact type only:
//
//   (a) genesis-OWNER can publish an agent instruction                     → 200
//   (a') a holder of mgmt_object:agent/update over the owning agent        → 200
//   (b) an actor with ONLY generic tier_promote and NO agent/update over X → 403
//       (the escalation — this is the RED→GREEN mutation-proof pivot)
//   (c) the SAME tier_promote-only actor can still promote an APPLICATION   → 200
//       (grant/registry/app promotion is UNAFFECTED — no collateral tighten)
//
// The instruction row stays 'draft' after the denied (b) attempt (the escalation
// truly does not land).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// Departments seeded by migration 026 in the DEV tenant.
const FIN_DEPT = 'b0000000-0000-0000-0000-000000000001';

// The org-set the seed owner grants are scoped to (fin, cs, plat).
const DEPT_SET_SCOPE = JSON.stringify({
  kind: 'set',
  members: [
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000001', nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000002', nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000003', nodeLevel: 'department' },
  ],
});

// A short unique suffix so re-runs against a reused DB never collide on slugs.
const SFX = uuid().slice(0, 8);

// Seeded identities.
const AGENT_OWNER = uuid();   // owned instruction promoted by the genesis owner
const AGENT_DELEG = uuid();   // owned instruction promoted by an agent/update holder (fin)
const AGENT_ESCAL = uuid();   // owned instruction that the escalation attempt targets
const POS_FIN = uuid();
const H_TP = uuid();          // human: ONLY tier_promote, NO agent/update
const H_AU = uuid();          // human: agent/update over fin, NO tier_promote
const R_TP = uuid();
const R_AU = uuid();
const INSTR_OWNER = uuid();
const INSTR_DELEG = uuid();
const INSTR_ESCAL = uuid();
const APP_C = uuid();

const H_TP_SLUG = `e-tp-only-${SFX}`;
const H_AU_SLUG = `e-au-fin-${SFX}`;

async function seedAll(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
    await c.query('SET LOCAL search_path TO choros');

    // Position in fin (for the delegated-holder scenario's agent scope).
    await c.query(
      `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Test Fin Position',0,0)`,
      [DEV_TENANT_ID, POS_FIN, FIN_DEPT, `pos-fin-${SFX}`],
    );

    // Agents (kind='agent'). OWNER/ESCAL are org-less; DELEG sits in fin.
    for (const [id, slug, pos] of [
      [AGENT_OWNER, `agent-owner-${SFX}`, null],
      [AGENT_ESCAL, `agent-escal-${SFX}`, null],
      [AGENT_DELEG, `agent-deleg-${SFX}`, POS_FIN],
    ] as Array<[string, string, string | null]>) {
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1,$2,$3,'agent',$4,$4,0,0)`,
        [DEV_TENANT_ID, id, pos, slug],
      );
    }

    // Human admins (kind='human') — the callers; resolveActorTenant maps them to DEV.
    for (const [id, slug] of [
      [H_TP, H_TP_SLUG],
      [H_AU, H_AU_SLUG],
    ] as Array<[string, string]>) {
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1,$2,NULL,'human',$3,$3,0,0)`,
        [DEV_TENANT_ID, id, slug],
      );
    }

    // Draft agent_instruction rows (the artifacts to promote).
    for (const [id, agent] of [
      [INSTR_OWNER, AGENT_OWNER],
      [INSTR_ESCAL, AGENT_ESCAL],
      [INSTR_DELEG, AGENT_DELEG],
    ] as Array<[string, string]>) {
      await c.query(
        `INSERT INTO choros.agent_instruction
           (tenant_id, id, employee_id, employee_kind, tier, instruction_text, instruction_meta, created_at, updated_at)
         VALUES ($1,$2,$3,'agent','draft','draft instruction','{}'::jsonb,0,0)`,
        [DEV_TENANT_ID, id, agent],
      );
    }

    // Roles.
    await c.query(
      `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1,$2,$3,'TP only',0,0),($1,$4,$5,'Agent update fin',0,0)`,
      [DEV_TENANT_ID, R_TP, `role-tp-only-${SFX}`, R_AU, `role-au-fin-${SFX}`],
    );

    // R_TP: ONLY generic tier_promote/transition (the escalation attacker's authority).
    await c.query(
      `INSERT INTO choros."grant"
         (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, "constraint", delegable, granted_by, valid_from, valid_until, created_at)
       VALUES ($1,$2,$3,'mgmt_object:tier_promote',NULL,'transition',$4::jsonb,NULL,true,'seed',NULL,NULL,0)`,
      [DEV_TENANT_ID, uuid(), R_TP, DEPT_SET_SCOPE],
    );

    // R_AU: mgmt_object:agent/update over the fin org-set (covers the fin agent).
    await c.query(
      `INSERT INTO choros."grant"
         (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, "constraint", delegable, granted_by, valid_from, valid_until, created_at)
       VALUES ($1,$2,$3,'mgmt_object:agent',NULL,'update',$4::jsonb,NULL,true,'seed',NULL,NULL,0)`,
      [DEV_TENANT_ID, uuid(), R_AU, DEPT_SET_SCOPE],
    );

    // Assignments (confirmed, open window).
    await c.query(
      `INSERT INTO choros.role_assignment
         (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NULL,NULL,'seed','seed',NULL,'seed',0,0),
              ($1,$6,$7,$8,$5::jsonb,NULL,NULL,'seed','seed',NULL,'seed',0,0)`,
      [DEV_TENANT_ID, uuid(), H_TP, R_TP, DEPT_SET_SCOPE, uuid(), H_AU, R_AU],
    );

    // Draft application (scenario C — non-agent_instruction promotion path).
    await c.query(
      `INSERT INTO choros.application (tenant_id, id, slug, display_name, tier, created_at, updated_at)
       VALUES ($1,$2,$3,'Scenario C App','draft',0,0)`,
      [DEV_TENANT_ID, APP_C, `app-c-${SFX}`],
    );

    await c.query('COMMIT');
  });
}

async function readTier(table: string, id: string): Promise<string | null> {
  return withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
    const quoted = table === 'grant' ? '"grant"' : table;
    const res = await c.query(
      `SELECT tier FROM choros.${quoted} WHERE tenant_id = $1 AND id = $2`,
      [DEV_TENANT_ID, id],
    );
    await c.query('COMMIT');
    return res.rows[0]?.tier ?? null;
  });
}

describe('T-0645 [SECURITY]: agent_instruction promote requires agent/update over the owning agent', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    await seedAll();
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function postPromote(
    id: string,
    actor: string,
    table: string,
  ): Promise<{ statusCode: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ artifact_table: table }));
      const url = new URL(`${baseUrl}/api/artifacts/${id}/promote`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: 'POST',
          headers: {
            'x-dev-user': actor,
            'content-type': 'application/json',
            'content-length': String(payload.length),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (ch: Buffer) => { body += ch.toString(); });
          res.on('end', () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(body); } catch { /* keep null */ }
            resolve({ statusCode: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // (b) THE ESCALATION — the RED→GREEN mutation-proof pivot.
  it('DENIES an actor holding ONLY generic tier_promote (no agent/update over X) → 403', async () => {
    const res = await postPromote(INSTR_ESCAL, H_TP_SLUG, 'agent_instruction');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'NO_PROMOTE_GRANT' } });
    // The instruction must remain a draft — the escalation did not land.
    expect(await readTier('agent_instruction', INSTR_ESCAL)).toBe('draft');
  });

  // (a) happy path — genesis owner.
  it('ALLOWS the genesis owner to publish an agent instruction → 200 published', async () => {
    const res = await postPromote(INSTR_OWNER, 'e-owner', 'agent_instruction');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ promoted: true, tier: 'published' });
    expect(await readTier('agent_instruction', INSTR_OWNER)).toBe('published');
  });

  // (a') happy path — a holder of mgmt_object:agent/update over the owning agent
  //      (the SAME authority saveDraft requires). Proves the fix is a REPLACE, not
  //      an AND: this holder has NO generic tier_promote and still succeeds.
  it('ALLOWS a holder of agent/update over the owning agent → 200 published', async () => {
    const res = await postPromote(INSTR_DELEG, H_AU_SLUG, 'agent_instruction');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ promoted: true, tier: 'published' });
    expect(await readTier('agent_instruction', INSTR_DELEG)).toBe('published');
  });

  // (c) grant/registry/app promotion is UNAFFECTED: the SAME tier_promote-only
  //     actor denied in (b) can still promote a plain application.
  it('LEAVES application promotion on the generic tier_promote gate → 200 published', async () => {
    const res = await postPromote(APP_C, H_TP_SLUG, 'application');
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ promoted: true, tier: 'published' });
    expect(await readTier('application', APP_C)).toBe('published');
  });
});
