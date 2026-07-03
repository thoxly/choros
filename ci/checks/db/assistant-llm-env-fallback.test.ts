/**
 * ci/checks/db/assistant-llm-env-fallback.test.ts — T-0600 (ADR-T0600 §1.1, AC-2).
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * A live acceptance run showed a tenant WITHOUT its own assigned LLM profile
 * silently answering via the server's GLOBAL DEEPSEEK_API_KEY env key instead
 * of the honest dormant 503 — a BYO-doctrine violation. src/__tests__/
 * server-llm-factory.test.ts proves this at the unit level (grantsPool=null,
 * no DB touched). THIS file proves the SAME contract end-to-end against a
 * REAL registered tenant and the REAL src/server.ts::makeLlmPortFactory
 * composition (not a caller-injected stub, unlike
 * ci/checks/db/assistant-llm-unavailable.test.ts's FF-5/FF-6, which inject
 * their own llmPortFactory to test the DOWNSTREAM honest-503 mechanism):
 *
 *   AC-2. A freshly-registered tenant (assistant-agent dormant,
 *     llm_connection_id NULL — same starting state as
 *     assistant-llm-binding.test.ts's "3f-bis") with DEEPSEEK_API_KEY set in
 *     the TEST PROCESS's own environment: POST a message to the assistant
 *     through registerAssistantRoutes wired with the REAL
 *     makeLlmPortFactory(tenantId, grantsPool) — the answer must be the
 *     honest 503 LLM_UNAVAILABLE (T-0573/T-0595 canonical text), never a
 *     real network call reaching DeepSeek/OpenAI (which would either hang on
 *     a fake key, return a real 401, or — worse — silently succeed against a
 *     real key an operator happened to have set for local/dev use; the
 *     dormant path structurally prevents any of those by never constructing
 *     a live OpenAILlmPort in the first place).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAssistantRoutes } from '../../../src/http/assistant.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { makeLlmPortFactory } from '../../../src/server.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();
const ENV_KEY = 'DEEPSEEK_API_KEY';

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
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: h },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface Registered {
  tenantId: string;
  ownerSlug: string;
}

describe.skipIf(!LIVE)('T-0600 (AC-2) — no env-fallback for a real tenant (live Postgres, real makeLlmPortFactory)', () => {
  let migPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';
  const originalEnvValue = process.env[ENV_KEY];

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });

    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const resolveViaMigrator = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

    const router = new Router();
    // THE REAL composition-root factory — not a test stub — is what proves
    // this end-to-end (mirrors src/server.ts:buildRouter's own wiring).
    registerAssistantRoutes(router, {
      pool: migPool,
      resolveActorTenant: resolveViaMigrator,
      llmPortFactory: (tenantId: string) => makeLlmPortFactory(tenantId, migPool),
    });
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (migPool) await migPool.end();
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnvValue;
    }
  });

  async function registerOne(label: string): Promise<Registered> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = {
      orgName: `T-0600 ${label} ${stamp}`,
      email: `t0600-${label}-${stamp}@example.com`,
      password: 'assistant-key-pw-1',
    };
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, req);
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
      await c.query('COMMIT');
    });
  }

  it('AC-2: a freshly-registered tenant (no llm_connection bound) + DEEPSEEK_API_KEY set in env → honest 503, NOT a live provider call', async () => {
    // Set a syntactically-plausible but definitely-fake key so that IF the
    // (removed) env-fallback ever reappeared, this test would either hang/
    // timeout against the real DeepSeek endpoint or get a definite non-503
    // response — either way failing loudly, never silently passing.
    process.env[ENV_KEY] = 'sk-t0600-fallback-must-not-be-used-0000000000';

    const a = await registerOne('EnvFallback');
    try {
      const threadRes = await request(
        baseUrl, 'POST', '/api/assistant/threads', { 'x-dev-user': a.ownerSlug }, { title: 'T-0600 env-fallback test' },
      );
      expect(threadRes.statusCode).toBe(201);
      const threadId = (JSON.parse(threadRes.body) as { id: string }).id;

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': a.ownerSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );

      // THE anti-case this task exists to close: must be the honest dormant
      // 503, never a real network call outcome (200 success, or a raw
      // upstream error surfaced some other way).
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      // Canonical T-0573/T-0595 text — never the fake key or any DeepSeek/
      // OpenAI-specific detail (proves the honest path fired, not a network
      // error being separately caught and reported).
      expect(body.error.message).not.toContain('sk-t0600-fallback');
      expect(body.error.message).not.toContain('DeepSeek');
      expect(body.error.message.toLowerCase()).toMatch(/ключ/);
    } finally {
      await cleanup(a.tenantId);
    }
  }, 20_000);
});
