/**
 * ci/checks/db/assistant-dispatch-failure.test.ts — T-0607 (г) live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db`.
 *
 * The live defect: user messages («тест», a question about заявки) got NO
 * assistant reply and NO error in the chat — the thread stayed silent. A plain
 * (non-LLM-classified) dispatch failure fell through to a bare 500 that persisted
 * NO assistant message, so re-opening the thread showed the user message alone.
 *
 * This test proves the route seam guarantees BOTH invariants at once:
 *   AC-9a (г):  after a plain dispatch failure, the thread CONTAINS an assistant
 *               message (canonical, jargon-free) — the thread is never mute.
 *   AC-9b (anti-mask, T-0573 §2.2): the HTTP response is STILL 500 INTERNAL — the
 *               real bug is visible, not masked as a friendly 200.
 *
 * HERMETIC: fresh registered tenant; the LLM port throws a plain Error (a real
 * bug), not an LlmUnavailableError (which has its own honest-503 path).
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
import { DISPATCH_FAILURE_REPLY } from '../../../src/core/assistant-report.js';
import type { LlmPort, ChatLlmRequest, ChatLlmResult, LlmRequest, LlmResult } from '../../../src/core/llm-port.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

function request(
  baseUrl: string, method: string, path: string,
  headers: Record<string, string> = {}, body?: unknown,
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

/** A port that throws a PLAIN Error (a real bug), not an LLM-classified error. */
function throwingBugPort(): LlmPort {
  const err = new Error('T-0607 simulated non-LLM dispatch bug');
  return {
    complete(_r: LlmRequest): Promise<LlmResult> { return Promise.reject(err); },
    chat(_r: ChatLlmRequest): Promise<ChatLlmResult> { return Promise.reject(err); },
  };
}

describe.skipIf(!LIVE)('T-0607 (AC-9) — dispatch failure: reply in thread + visible 500 (live Postgres)', () => {
  let migPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const router = new Router();
    registerAssistantRoutes(router, {
      pool: migPool,
      resolveActorTenant: (actorSlug: string) => resolveActorTenant(migPool, actorSlug),
      // The port throws a PLAIN Error → exercises the (г) route seam.
      llmPortFactory: async () => throwingBugPort(),
    });
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (migPool) await migPool.end();
  });

  async function registerOne(): Promise<{ tenantId: string; ownerSlug: string }> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0607 Dispatch ${stamp}`, email: `t0607-dispatch-${stamp}@example.com`, password: 'dispatch-pw-1' },
    );
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

  it('AC-9: plain dispatch bug → thread gets a canonical reply AND response is 500 INTERNAL', async () => {
    const { tenantId, ownerSlug } = await registerOne();
    try {
      const threadRes = await request(baseUrl, 'POST', '/api/assistant/threads', { 'x-dev-user': ownerSlug }, { title: 'T-0607 dispatch' });
      expect(threadRes.statusCode).toBe(201);
      const threadId = (JSON.parse(threadRes.body) as { id: string }).id;

      // A plain data question (routes to analyst → LLM chat throws a plain Error).
      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': ownerSlug },
        { text: 'сколько заявок обработано' },
      );

      // AC-9b (anti-mask): the real bug is still surfaced as INTERNAL 500.
      expect(res.statusCode).toBe(500);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('INTERNAL');

      // AC-9a (г): the thread is NOT mute — it now holds an assistant reply.
      const msgsRes = await request(baseUrl, 'GET', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': ownerSlug });
      expect(msgsRes.statusCode).toBe(200);
      const msgs = (JSON.parse(msgsRes.body) as { messages: { role: string; text: string }[] }).messages;
      const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
      // The canonical, jargon-free dispatch-failure reply — no raw error text.
      expect(assistantMsgs.some((m) => m.text === DISPATCH_FAILURE_REPLY)).toBe(true);
      expect(msgsRes.body).not.toContain('simulated non-LLM dispatch bug');
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
