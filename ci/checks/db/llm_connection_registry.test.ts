// T-0474 · LLM connection registry (migration 094) — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db
//
// THE L2 INVARIANTS (migration 094 + the /api/llm-connections route), proven
// end-to-end against the real choros_app (NOBYPASSRLS) role and the production RLS
// path — NOT a mock:
//   1. RLS TENANT ISOLATION (mandatory): a connection created by tenant A is NEVER
//      visible to tenant B. Proven two ways — via choros_app under each tenant GUC
//      AND via the GET /api/llm-connections route resolving each actor's tenant.
//   2. CREATE via POST persists a named profile and returns secret_bound (boolean),
//      never the raw handle.
//   3. SECRET CUSTODY: a raw key (sk-…) is REJECTED (400), never stored. An opaque
//      reference (env://…) is accepted and surfaces only as secret_bound + a
//      redacted scheme (env://...), never the full value.
//   4. agent_card readers resolve THROUGH the profile: pointing an agent_card at a
//      connection profile makes readConfiguredAgentLlmConfig return the profile's
//      endpoint/model/handle (not the inline columns).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerLlmConnectionsRoutes } from '../../../src/http/llm-connections.js';
import { readConfiguredAgentLlmConfig } from '../../../src/db/agent-provision.js';

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

const TENANT_A = uuid();
const TENANT_B = uuid();

// Map dev-user actor → tenant. 'owner-a'/'owner-b' are genesis owners of A/B.
async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'owner-a') return TENANT_A;
  if (slug === 'owner-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seedTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  // tenant row.
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  const ownerEmpId = uuid();
  const ownerRoleId = uuid();
  // Genesis-owner wiring: an employee (kind='human') whose slug == the dev-user
  // actor, a tenant-owner role, and a CONFIRMED genesis role_assignment. This is
  // what loadAdminContext checks to set isGenesisOwner=true (the connection-config
  // mgmt gate). org_scope content is irrelevant to the owner boolean.
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [tenantId, ownerEmpId, ownerSlug, `Owner ${ownerSlug}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', 0, 0)`,
    [tenantId, ownerRoleId],
  );
  // T-0764: proposed_by MUST be NULL — direct/genesis grant, not a pending
  // dual-control proposal (T-0605 canonical shape, эталон
  // T-0750-inbox-detail-authority.db.test.ts). Harmless here (sole consumer
  // isGenesisOwnerForTenant ignores proposed_by/confirmed2_by) but non-canonical.
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, NULL, $6::text, 0, 0)`,
    [
      tenantId,
      uuid(),
      ownerEmpId,
      ownerRoleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
      ownerSlug,
    ],
  );
  await c.query('COMMIT');
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h: Record<string, string> = { ...headers };
    if (payload !== undefined) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: h,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerLlmConnectionsRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_A, 'owner-a');
    await seedTenant(c, TENANT_B, 'owner-b');
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
      await c.query(`UPDATE choros.agent_card SET llm_connection_id = NULL WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.llm_connection WHERE tenant_id = $1`, [t]);
      // role_assignment FK → employee: delete assignments + role before employee.
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0474 — llm_connection registry: CRUD + secret custody', () => {
  let createdIdA = '';

  it('owner creates a named connection profile (201); raw handle never echoed', requireDb(async () => {
    const r = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': 'owner-a' }, {
      name: 'DeepSeek (prod)',
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      secret_handle: 'env://DEEPSEEK_API_KEY',
      price_input_per_1k: 0.14,
      price_output_per_1k: 0.28,
      currency: 'usd',
      is_default: true,
    });
    expect(r.statusCode).toBe(201);
    const v = JSON.parse(r.body) as Record<string, unknown>;
    createdIdA = v.id as string;
    expect(v.name).toBe('DeepSeek (prod)');
    expect(v.provider).toBe('deepseek');
    expect(v.is_default).toBe(true);
    expect(v.secret_bound).toBe(true);
    // The raw handle is NEVER in the response — only the redacted scheme.
    expect(v.secret_handle_redacted).toBe('env://...');
    expect(JSON.stringify(v)).not.toContain('DEEPSEEK_API_KEY');
    expect(JSON.stringify(v)).not.toContain('secretHandle');
  }));

  it('REJECTS a raw API key as secret_handle (400) — never stored', requireDb(async () => {
    const r = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': 'owner-a' }, {
      name: 'Bad raw key',
      provider: 'openai',
      secret_handle: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(r.statusCode).toBe(400);
    // The rejected raw key must NOT be echoed back in the error.
    expect(r.body).not.toContain('sk-proj-aaaa');
    // And no "Bad raw key" profile must have been persisted.
    const list = await request(baseUrl, 'GET', '/api/llm-connections', { 'x-dev-user': 'owner-a' });
    const conns = (JSON.parse(list.body) as { connections: Array<{ name: string }> }).connections;
    expect(conns.find((c) => c.name === 'Bad raw key')).toBeUndefined();
  }));

  it('list returns the profile with secret_bound, never the raw handle', requireDb(async () => {
    const r = await request(baseUrl, 'GET', '/api/llm-connections', { 'x-dev-user': 'owner-a' });
    expect(r.statusCode).toBe(200);
    const conns = (JSON.parse(r.body) as { connections: Array<Record<string, unknown>> }).connections;
    const ds = conns.find((c) => c.id === createdIdA);
    expect(ds, 'created profile must be listed').toBeDefined();
    expect(ds!.secret_bound).toBe(true);
    expect(JSON.stringify(conns)).not.toContain('DEEPSEEK_API_KEY');
  }));

  it('RLS TENANT ISOLATION: tenant B never sees tenant A’s connection (route)', requireDb(async () => {
    const r = await request(baseUrl, 'GET', '/api/llm-connections', { 'x-dev-user': 'owner-b' });
    expect(r.statusCode).toBe(200);
    const conns = (JSON.parse(r.body) as { connections: Array<{ id: string }> }).connections;
    expect(conns.find((c) => c.id === createdIdA), 'A’s profile must be invisible to B').toBeUndefined();
  }));

  it('RLS TENANT ISOLATION: choros_app under tenant B GUC sees zero of A’s rows', requireDb(async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT id FROM choros.llm_connection WHERE id = $1`,
        [createdIdA],
      );
      await c.query('COMMIT');
      expect(rows.length, 'RLS must hide A’s connection from B’s session').toBe(0);
    } finally {
      c.release();
    }
  }));

  it('agent_card readers resolve THROUGH the connection profile', requireDb(async () => {
    // Attach tenant A's assistant agent_card to the created profile, then read.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      // Org-less assistant card (employee_id NULL, migration 093) pointing at the profile.
      await c.query(
        `INSERT INTO choros.agent_card
           (tenant_id, id, employee_id, employee_kind, kc_client_id, agent_type,
            llm_connection_id, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), NULL, NULL, 't0474-assistant-kc', 'assistant', $2, 0, 0)`,
        [TENANT_A, createdIdA],
      );
      await c.query('COMMIT');
    });

    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query('SET LOCAL search_path TO choros');
      const row = await readConfiguredAgentLlmConfig(c as unknown as import('../../../src/db/audit-writer.js').PgClientLike);
      await c.query('COMMIT');
      expect(row, 'a profile-configured agent must be fully-configured').not.toBeNull();
      expect(row!.llm_endpoint).toBe('https://api.deepseek.com/v1');
      expect(row!.llm_model).toBe('deepseek-chat');
      // The opaque handle flows through from the profile (custody reader returns it
      // to the composition root only; never to a client).
      expect(row!.secret_handle_ref).toBe('env://DEEPSEEK_API_KEY');
    } finally {
      c.release();
    }
  }));
});
