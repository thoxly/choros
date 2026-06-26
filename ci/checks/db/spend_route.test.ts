// Regression — GET /api/spend must return 200 (never 500), including on a
// tenant with an empty spend_ledger. Live Postgres probe (db CI job / local).
//
// Root cause this guards against: `window` is a RESERVED keyword in PostgreSQL.
// getSpendWindows aliased `'total' AS window` (and `ORDER BY window`) unquoted,
// which raised "syntax error at or near window" — so /api/spend ALWAYS 500'd,
// regardless of whether the tenant had any spend rows. The fix quotes the
// identifier ("window"); this test pins the route to 200 + valid aggregates.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerSpendRoutes } from '../../../src/http/spend.js';

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

// EMPTY = tenant with zero spend rows (the 500-trigger). FULL = tenant with rows.
const TENANT_EMPTY = uuid();
const TENANT_FULL = uuid();

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'owner-empty') return TENANT_EMPTY;
  if (slug === 'owner-full') return TENANT_FULL;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedSpendRow(
  c: pg.Client,
  tenantId: string,
  amount: number,
  totalTokens: number,
): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.spend_ledger
       (tenant_id, id, reservation_id, tool_call_id, employee_id,
        instance_budget_id, agent_budget_id,
        amount, currency, description, recorded_at,
        llm_connection_id, prompt_tokens, completion_tokens, total_tokens)
     VALUES ($1, gen_random_uuid(), NULL, gen_random_uuid(), NULL, NULL, NULL,
             $2, 'USD', 'regression seed', $3, NULL, 0, 0, $4)`,
    [tenantId, amount, Date.now(), totalTokens],
  );
  await c.query('COMMIT');
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
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
  registerSpendRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_EMPTY);
    await seedTenant(c, TENANT_FULL);
    // Two priced rows for the FULL tenant → non-empty aggregates.
    await seedSpendRow(c, TENANT_FULL, 1.25, 150);
    await seedSpendRow(c, TENANT_FULL, 0.75, 50);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  // spend_ledger is append-only (no DELETE allowed) — leave its rows; drop the
  // tenant rows we own. TENANT_FULL keeps its ledger rows (harmless, isolated).
  await withClient(migratorUrl(), async (c) => {
    await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT_EMPTY]);
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/spend — never 500 (reserved-keyword regression)', () => {
  it('empty spend_ledger → 200 with empty aggregates (not 500)', requireDb(async () => {
    const r = await request(baseUrl, 'GET', '/api/spend', { 'x-dev-user': 'owner-empty' });
    expect(r.statusCode).toBe(200);
    const v = JSON.parse(r.body) as { windows: unknown[]; byConnection: unknown[] };
    expect(Array.isArray(v.windows)).toBe(true);
    expect(Array.isArray(v.byConnection)).toBe(true);
    expect(v.windows).toHaveLength(0);
    expect(v.byConnection).toHaveLength(0);
  }));

  it('populated spend_ledger → 200 with day/month/total windows aggregated', requireDb(async () => {
    const r = await request(baseUrl, 'GET', '/api/spend', { 'x-dev-user': 'owner-full' });
    expect(r.statusCode).toBe(200);
    const v = JSON.parse(r.body) as {
      windows: Array<{ window: string; total_amount: number; total_tokens: number; row_count: number }>;
      byConnection: Array<{ total_amount: number }>;
    };
    // All three windows present and (because both rows are recent) equal.
    const byWindow = new Map(v.windows.map((w) => [w.window, w]));
    expect(byWindow.has('day')).toBe(true);
    expect(byWindow.has('month')).toBe(true);
    expect(byWindow.has('total')).toBe(true);
    expect(byWindow.get('total')!.total_amount).toBeCloseTo(2.0, 6);
    expect(byWindow.get('total')!.total_tokens).toBe(200);
    expect(byWindow.get('total')!.row_count).toBe(2);
    expect(v.byConnection.length).toBeGreaterThanOrEqual(1);
  }));

  it('GET /api/spend/recent → 200 with rows array (empty tenant)', requireDb(async () => {
    const r = await request(baseUrl, 'GET', '/api/spend/recent', { 'x-dev-user': 'owner-empty' });
    expect(r.statusCode).toBe(200);
    const v = JSON.parse(r.body) as { rows: unknown[] };
    expect(Array.isArray(v.rows)).toBe(true);
    expect(v.rows).toHaveLength(0);
  }));
});
