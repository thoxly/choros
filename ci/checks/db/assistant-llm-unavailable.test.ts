/**
 * ci/checks/db/assistant-llm-unavailable.test.ts — T-0573
 * (ADR-T0573 §2.2, FF-5/FF-6/FF-UX-7)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * Proves, against LIVE Postgres and REAL HTTP routes (registerAssistantRoutes,
 * a real registerTenant() tenant/owner — not a mock):
 *
 *   FF-5 (AC-5). When ctx.llm.chat() throws a NON-LlmDormantError adapter
 *     failure (modeled here as LlmUnavailableError — exactly the class
 *     src/adapters/openai-llm-port.ts now wraps its own throw points in),
 *     POST /api/assistant/threads/:id/messages does NOT answer with a raw
 *     HTTP 500 {"error":{"code":"INTERNAL"}} — it answers 503 with
 *     error.code==="LLM_UNAVAILABLE" and a message containing "/llm-connections".
 *   FF-6 (AC-6). The SAME route, for a tenant whose llmPortFactory returns the
 *     genuinely dormant port (no config at all — LlmDormantError path),
 *     answers with a message containing "/llm-connections" too — the SAME
 *     class of honest answer, not just "not configured" with no pointer to
 *     where to fix it.
 *   Anti-mask check (ADR §2.2 "do not mask real bugs"): when ctx.llm.chat()
 *     throws a PLAIN Error (not LlmDormantError, not LlmUnavailableError),
 *     the route still falls through to the ordinary 500 INTERNAL path — the
 *     classifier does NOT swallow genuine bugs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAssistantRoutes } from '../../../src/http/assistant.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { dormantLlmPort, LlmUnavailableError, type LlmPort } from '../../../src/core/llm-port.js';
import type { ChatLlmRequest, ChatLlmResult, LlmRequest, LlmResult } from '../../../src/core/llm-port.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

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

/** A port whose chat()/complete() always throws the given error. */
function makeThrowingPort(err: unknown): LlmPort {
  return {
    complete(_req: LlmRequest): Promise<LlmResult> {
      return Promise.reject(err);
    },
    chat(_req: ChatLlmRequest): Promise<ChatLlmResult> {
      return Promise.reject(err);
    },
  };
}

interface Registered {
  tenantId: string;
  ownerSlug: string;
}

describe.skipIf(!LIVE)('T-0573 — assistant LLM-unavailable honest 503 (live Postgres)', () => {
  let migPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';
  // Mutable per-test factory result — swapped between tests via a wrapper so
  // ONE server/router setup serves every scenario (no restart needed).
  let currentFactoryResult: LlmPort | (() => never) = dormantLlmPort;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });

    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const resolveViaMigrator = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

    const router = new Router();
    registerAssistantRoutes(router, {
      pool: migPool,
      resolveActorTenant: resolveViaMigrator,
      llmPortFactory: async (_tenantId: string) => {
        if (typeof currentFactoryResult === 'function') {
          return currentFactoryResult();
        }
        return currentFactoryResult;
      },
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

  async function registerOne(label: string): Promise<Registered> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = {
      orgName: `T-0573 ${label} ${stamp}`,
      email: `t0573-${label}-${stamp}@example.com`,
      password: 'assistant-key-pw-1',
    };
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, req);
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  // NOTE: choros.audit_event is append-only (audit_append_only.sh fitness
  // gate) — DELETE on it is structurally forbidden (trigger-enforced), so
  // thread/message rows created by this test are intentionally left behind
  // (each test uses a freshly-registered tenant so there is no cross-test
  // pollution; only the tenant/role/employee/etc. rows are reclaimed here).
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

  async function createThread(baseUrlArg: string, ownerSlug: string): Promise<string> {
    const res = await request(baseUrlArg, 'POST', '/api/assistant/threads', { 'x-dev-user': ownerSlug }, { title: 'T-0573 test' });
    expect(res.statusCode).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  // -------------------------------------------------------------------------
  // FF-6 (AC-6): dormant path (LlmDormantError, via the real dormantLlmPort).
  // -------------------------------------------------------------------------
  it('FF-6: dormant LLM (no config at all) answers 503 LLM_UNAVAILABLE with a message containing /llm-connections', async () => {
    const a = await registerOne('Dormant');
    try {
      currentFactoryResult = dormantLlmPort;
      const threadId = await createThread(baseUrl, a.ownerSlug);

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': a.ownerSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      expect(body.error.message).toContain('/llm-connections');
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-5 (AC-5): adapter-failure path (LlmUnavailableError — config EXISTS,
  // the call failed). Must NOT be a raw 500 INTERNAL.
  // -------------------------------------------------------------------------
  it('FF-5: a configured-but-failing LLM adapter (LlmUnavailableError) answers 503 LLM_UNAVAILABLE, NOT 500 INTERNAL', async () => {
    const a = await registerOne('AdapterFail');
    try {
      currentFactoryResult = makeThrowingPort(
        new LlmUnavailableError('OpenAI API error 401: invalid api key'),
      );
      const threadId = await createThread(baseUrl, a.ownerSlug);

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': a.ownerSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );
      expect(res.statusCode).not.toBe(500);
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).not.toBe('INTERNAL');
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      expect(body.error.message).toContain('/llm-connections');
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // Anti-mask (ADR §2.2 "do not mask real bugs"): a plain Error (neither
  // LlmDormantError nor LlmUnavailableError) must NOT be swallowed into the
  // honest-503 path — it is a real bug and must still surface as INTERNAL.
  // -------------------------------------------------------------------------
  it('anti-mask: a plain (non-LLM-classified) error still falls through to 500 INTERNAL — not hidden as "no key"', async () => {
    const a = await registerOne('PlainBug');
    try {
      currentFactoryResult = makeThrowingPort(new Error('unexpected null pointer in test double'));
      const threadId = await createThread(baseUrl, a.ownerSlug);

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': a.ownerSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('INTERNAL');
    } finally {
      await cleanup(a.tenantId);
    }
  });
});
