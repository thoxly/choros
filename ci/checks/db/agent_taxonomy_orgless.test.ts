// T-0473 · Agent taxonomy + decouple org-place — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db
//
// THE L1 INVARIANT (migration 093): an agent can exist in the registry WITHOUT an
// org-place (employee_id IS NULL). This proves end-to-end, against the real
// choros_app (NOBYPASSRLS) role and the production RLS path:
//   - an org-less 'assistant' agent (employee_id NULL, employee_kind NULL) inserts
//     fine — the composite employee FK is a PARTIAL discriminator (MATCH SIMPLE),
//     skipped when employee_id IS NULL.
//   - GET /api/agents lists it with agent_type='assistant', has_org_place=false,
//     and addresses it by its surrogate agent_card id (not employee_id).
//   - a workforce (org-attached) agent still appears with has_org_place=true.
//   - the partial discriminator STILL bites: an agent_card pointing employee_id at
//     a kind='human' employee is rejected by the FK (23503).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAgentListRoutes } from '../../../src/http/agents-list.js';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

const hasDb = Boolean(process.env['DATABASE_URL']);

const TENANT = uuid();
const WORKFORCE_EMP = uuid(); // org-attached agent (has employee row)
const ORGLESS_CARD = uuid();  // surrogate id of the org-less assistant agent

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

/** Org-attached agent: employee(kind='agent') + agent_card(agent_type='workforce'). */
async function seedWorkforceAgent(c: pg.Client, tenantId: string, empId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'agent', $3, $4, 0, 0)`,
    [tenantId, empId, 't0473-workforce', 'Workforce agent'],
  );
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, id, employee_id, employee_kind, kc_client_id, agent_type, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), $2, 'agent', 't0473-wf-kc', 'workforce', 0, 0)`,
    [tenantId, empId],
  );
  await c.query('COMMIT');
}

/** Org-less assistant agent: agent_card ONLY, employee_id NULL. */
async function seedOrglessAssistant(c: pg.Client, tenantId: string, cardId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, id, employee_id, employee_kind, kc_client_id, agent_type, created_at, updated_at)
     VALUES ($1, $2, NULL, NULL, 't0473-assistant-kc', 'assistant', 0, 0)`,
    [tenantId, cardId],
  );
  await c.query('COMMIT');
}

function makeRequest(
  baseUrl: string, method: string, path: string, extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: extraHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor') return TENANT;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerAgentListRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT);
    await seedWorkforceAgent(c, TENANT, WORKFORCE_EMP);
    await seedOrglessAssistant(c, TENANT, ORGLESS_CARD);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
    await c.query('COMMIT');
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0473 — org-less agents in the registry', () => {
  it('an org-less assistant (employee_id NULL) is permitted and listed with its type', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/agents', { 'x-dev-user': 'actor' });
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body) as { agents: Array<Record<string, unknown>> };

    const assistant = parsed.agents.find((a) => a.agent_type === 'assistant');
    expect(assistant, 'org-less assistant must appear in GET /api/agents').toBeDefined();
    expect(assistant!.has_org_place).toBe(false);
    // Addressed by the surrogate agent_card id (no employee_id to key on).
    expect(assistant!.id).toBe(ORGLESS_CARD);
    expect(assistant!.position).toBeNull();
    expect(assistant!.department).toBeNull();
  }));

  it('the workforce (org-attached) agent shows has_org_place=true', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/agents', { 'x-dev-user': 'actor' });
    const parsed = JSON.parse(r.body) as { agents: Array<Record<string, unknown>> };
    const wf = parsed.agents.find((a) => a.agent_type === 'workforce');
    expect(wf, 'workforce agent must appear').toBeDefined();
    expect(wf!.has_org_place).toBe(true);
    expect(wf!.id).toBe(WORKFORCE_EMP); // addressed by employee_id (unchanged)
  }));

  it('GET /api/agents/:id resolves an org-less agent by its surrogate id', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', `/api/agents/${ORGLESS_CARD}`, { 'x-dev-user': 'actor' });
    expect(r.statusCode).toBe(200);
    const a = JSON.parse(r.body) as Record<string, unknown>;
    expect(a.agent_type).toBe('assistant');
    expect(a.has_org_place).toBe(false);
  }));

  it('the partial FK discriminator STILL bites: employee_id → kind=human is rejected', requireDb(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const humanId = uuid();
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, 'human', 't0473-human', 'Human', 0, 0)`,
        [TENANT, humanId],
      );
      let rejected = false;
      try {
        await c.query(
          `INSERT INTO choros.agent_card
             (tenant_id, id, employee_id, employee_kind, kc_client_id, agent_type, created_at, updated_at)
           VALUES ($1, gen_random_uuid(), $2, 'agent', 't0473-badkind-kc', 'workforce', 0, 0)`,
          [TENANT, humanId],
        );
      } catch (err) {
        rejected = (err as { code?: string }).code === '23503'; // foreign_key_violation
      }
      await c.query('ROLLBACK');
      expect(rejected, 'pointing employee_id at a kind=human row must violate the agent FK').toBe(true);
    });
  }));
});
