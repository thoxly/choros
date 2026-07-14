// T-0271 · GET /api/agents (list) + GET /api/agents/:id — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers (behavioral, requires live Postgres):
//   - dev-mode works: GET /api/agents with x-dev-user → 200, lists the tenant's agents.
//   - NO-SECRET-LEAK: an agent with a llm_secret_handle set in the DB appears in the
//     list with llm_bound:true and a provider/model, but the response body NEVER
//     contains the raw handle value (the central security invariant of T-0271).
//   - TENANT ISOLATION (the Враг target): an actor in tenant A cannot see tenant B's
//     agents — RLS-enforced through the real choros_app (NOBYPASSRLS) role.
//   - 401 when x-dev-user absent (dev mode).
//   - keycloak mode: GET without a Bearer token → 401 (withAuth wrapper), and the
//     handler is never reached (no leak).
//   - GET /api/agents/:id → metadata for one agent; cross-tenant id → 404.
//
// Pattern mirrors registry_defs_crud.test.ts: self-contained Router +
// registerAgentListRoutes with a stub resolveActorTenant (actor-a→A, actor-b→B),
// choros_app pool so cross-tenant denial is the production DB policy. FRESH random
// tenants (avoid shared-clone pollution).

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

// FRESH random tenants (no shared-clone pollution).
const TENANT_A = uuid();
const TENANT_B = uuid();

// A well-formed opaque handle (passes validateSecretHandleShape) — the value that
// must NEVER appear in any GET /api/agents response body.
const SECRET_HANDLE = 'vault://secret/choros/test/t0271-agent-key';

// Stable agent ids per tenant.
const AGENT_A1 = uuid(); // tenant A — has an LLM handle bound
const AGENT_A2 = uuid(); // tenant A — no handle
const AGENT_B1 = uuid(); // tenant B — must be invisible to actor-a

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; explicit SET LOCAL for the agent_card insert).
// ---------------------------------------------------------------------------

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

/** Insert an employee(kind='agent') + agent_card row in one tenant-scoped tx. */
async function seedAgent(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  slug: string,
  opts: { handle?: string | null; endpoint?: string | null; model?: string | null } = {},
): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'agent', $3, $4, 0, 0)`,
    [tenantId, employeeId, slug, `Agent ${slug}`],
  );
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, employee_id, employee_kind, kc_client_id,
        llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
        budget_policy_id, escalation_rule_id, created_at, updated_at)
     VALUES ($1, $2, 'agent', $3, $4, $5, $6, NULL, NULL, NULL, 0, 0)`,
    [
      tenantId, employeeId, `agent-${slug}`,
      opts.endpoint ?? null, opts.model ?? null, opts.handle ?? null,
    ],
  );
  await c.query('COMMIT');
}

async function cleanupAgent(c: pg.Client, tenantId: string, employeeId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1 AND employee_id = $2`, [tenantId, employeeId]);
  await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1 AND id = $2`, [tenantId, employeeId]);
  await c.query('COMMIT');
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
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
    await seedTenant(c, TENANT_A);
    await seedTenant(c, TENANT_B);
    await seedAgent(c, TENANT_A, AGENT_A1, 't0271-a1', {
      handle: SECRET_HANDLE, endpoint: 'https://api.openai.com/v1', model: 'gpt-4o',
    });
    await seedAgent(c, TENANT_A, AGENT_A2, 't0271-a2', {});
    await seedAgent(c, TENANT_B, AGENT_B1, 't0271-b1', { handle: SECRET_HANDLE });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await cleanupAgent(c, TENANT_A, AGENT_A1);
    await cleanupAgent(c, TENANT_A, AGENT_A2);
    await cleanupAgent(c, TENANT_B, AGENT_B1);
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/agents — list (T-0271)', () => {
  it('dev mode: lists the tenant agents and NEVER leaks the secret handle', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/agents', { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(200);

    // The raw handle must NOT appear anywhere in the serialized body.
    expect(r.body, 'no-secret-leak: raw handle must not appear in GET /api/agents body').not.toContain(SECRET_HANDLE);
    expect(r.body, 'no llm_secret_handle key in response').not.toContain('secret_handle');

    const parsed = JSON.parse(r.body) as { agents: Array<Record<string, unknown>> };
    const slugs = parsed.agents.map((a) => a.slug).sort();
    expect(slugs, 'actor-a sees only tenant-A agents').toEqual(['t0271-a1', 't0271-a2']);

    const a1 = parsed.agents.find((a) => a.slug === 't0271-a1')!;
    expect(a1.llm_bound, 'a1 has a handle bound → llm_bound:true').toBe(true);
    expect(a1.status).toBe('configured');
    expect(a1.llm_provider, 'provider derived from endpoint host, not the key').toBe('api.openai.com');
    expect(a1.llm_model).toBe('gpt-4o');
    // The object must not carry any secret-bearing field.
    expect(Object.keys(a1)).not.toContain('llm_secret_handle');

    const a2 = parsed.agents.find((a) => a.slug === 't0271-a2')!;
    expect(a2.llm_bound, 'a2 has no handle → llm_bound:false').toBe(false);
    expect(a2.status).toBe('needs_llm');
  }));

  it('tenant isolation: actor-b never sees tenant-A agents (RLS)', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/agents', { 'x-dev-user': 'actor-b' });
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body) as { agents: Array<{ slug: string }> };
    const slugs = parsed.agents.map((a) => a.slug);
    expect(slugs, 'actor-b sees only its own agent').toEqual(['t0271-b1']);
    expect(slugs).not.toContain('t0271-a1');
  }));

  it('401 when x-dev-user absent (dev mode)', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/agents');
    expect(r.statusCode).toBe(401);
  }));

  it('keycloak mode: GET without Bearer → 401, handler never reached (no leak)', requireDb(async () => {
    const prev = process.env['CHOROS_AUTH_MODE'];
    process.env['CHOROS_AUTH_MODE'] = 'keycloak';
    try {
      // No Authorization header → withAuth rejects before the handler runs.
      const r = await makeRequest(baseUrl, 'GET', '/api/agents', { 'x-dev-user': 'actor-a' });
      expect(r.statusCode, 'keycloak mode requires a Bearer token').toBe(401);
      expect(r.body, 'no secret can leak on a 401').not.toContain(SECRET_HANDLE);
    } finally {
      if (prev === undefined) delete process.env['CHOROS_AUTH_MODE'];
      else process.env['CHOROS_AUTH_MODE'] = prev;
    }
  }));
});

describe('GET /api/agents/:id — get one (T-0271)', () => {
  it('returns metadata for an in-tenant agent, no secret', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', `/api/agents/${AGENT_A1}`, { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(SECRET_HANDLE);
    const a = JSON.parse(r.body) as { id: string; slug: string; llm_bound: boolean };
    expect(a.id).toBe(AGENT_A1);
    expect(a.slug).toBe('t0271-a1');
    expect(a.llm_bound).toBe(true);
  }));

  it('cross-tenant id → 404', requireDb(async () => {
    // actor-a asking for tenant-B's agent id → RLS yields 0 rows → 404.
    const r = await makeRequest(baseUrl, 'GET', `/api/agents/${AGENT_B1}`, { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(404);
  }));
});
