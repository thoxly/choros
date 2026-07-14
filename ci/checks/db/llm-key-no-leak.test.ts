/**
 * ci/checks/db/llm-key-no-leak.test.ts — T-0574 (AC-2/AC-3/AC-7/AC-8, FF-1/FF-2)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * Drives the FULL BYO-LLM-key flow this task closes — create profile → bind a
 * known test key → assign the profile to the assistant → probe the connection
 * (both success and provider-error paths) — against LIVE Postgres, capturing
 * EVERY HTTP response body along the way, then asserts:
 *
 *   FF-1 (AC-2/AC-7, N1). The test key string NEVER appears in ANY captured
 *     response body across /api/llm-connections/*, /api/agents/:id/llm-connection.
 *   FF-2 (AC-8, N2). After the run, neither the sanitized provider-error text
 *     NOR the raw test key appears in any audit_event.payload row written
 *     during this run (set_agent_llm_connection audit carries only the FK +
 *     redacted connection summary — never the secret).
 *
 * The provider call itself is faked (an injected LlmPort stub) so this test
 * needs no real network / real Anthropic key — it proves the ROUTE's egress
 * discipline (the same boundary AC-3/AC-6 rely on), not third-party uptime.
 * The stub's injected "provider error" deliberately ECHOES the raw key in its
 * message (worst case) to prove sanitizeProviderError actually strips it
 * before the response — a stub that behaved politely would prove nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { appUrl, migratorUrl, withClient } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAgentRoutes } from '../../../src/http/agents.js';
import { registerAgentListRoutes } from '../../../src/http/agents-list.js';
import { registerLlmConnectionsRoutes } from '../../../src/http/llm-connections.js';
import { registerAppSecretRoutes } from '../../../src/http/app-secret.js';
import { registerLlmConnectionTestRoute, type LlmPortFactory } from '../../../src/http/llm-connection-test.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import type { KeycloakAdminPort } from '../../../src/core/agent-hire.js';
import type { LlmPort } from '../../../src/core/llm-port.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

// The known test key string — must NEVER appear in any response/log/audit.
const TEST_KEY = 'sk-ant-T0574-LIVE-TEST-KEY-must-never-leak-9182736450';

const noopKcPort: KeycloakAdminPort = {
  createServiceAccountClient: async () => ({ clientId: 'noop' }),
  deleteClient: async () => {},
};

interface Captured {
  method: string;
  path: string;
  status: number;
  body: string;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Captured> {
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
        res.on('end', () =>
          resolve({ method, path, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe.skipIf(!LIVE)('T-0574 — LLM key never leaks (live Postgres)', () => {
  let migPool: pg.Pool;
  let appPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';
  const captured: Captured[] = [];
  let tenantId = '';
  let ownerSlug = '';
  let providerErrorCall = false;

  beforeAll(async () => {
    if (!LIVE) return;
    // Route wiring mirrors src/server.ts: agents/agents-list/llm-connections
    // against the migrator (BYPASSRLS) pool + resolveActorTenant(getOrgPool());
    // app-secret (key bind, write-only) + llm-connection-test (probe) exercised
    // against the choros_app (NOBYPASSRLS) pool — same split as
    // ci/checks/db/app_secret_store.test.ts, which already proves this wiring
    // is production-faithful for those two routes.
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    appPool = new pg.Pool({ connectionString: appUrl() });

    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const resolveViaMigrator = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

    // Fake LlmPort: succeeds on the FIRST call, fails (echoing the raw key —
    // worst case) on subsequent calls, so both AC-3 outcomes are exercised.
    let callCount = 0;
    const makeLlmPort: LlmPortFactory = (): LlmPort => ({
      complete: async () => ({ text: 'pong', usage: undefined }) as never,
      chat: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: { role: 'assistant', content: 'pong' },
            usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
          } as never;
        }
        providerErrorCall = true;
        // Worst-case stub: the "provider" error ECHOES the raw key — proves
        // sanitizeProviderError strips it rather than relying on a polite stub.
        throw new Error(`Anthropic API error 401: invalid api key ${TEST_KEY}`);
      },
    });

    const router = new Router();
    registerAgentRoutes(router, migPool, noopKcPort);
    registerAgentListRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigrator });
    registerLlmConnectionsRoutes(router, { pool: appPool, resolveActorTenant: resolveViaMigrator });
    registerAppSecretRoutes(router, {
      pool: appPool,
      resolveActorTenant: resolveViaMigrator,
      getMasterKey: () => 't0574-no-leak-test-master-key-32bytes-min',
    });
    registerLlmConnectionTestRoute(router, { pool: appPool, resolveActorTenant: resolveViaMigrator, makeLlmPort });

    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      const orig = res.end.bind(res);
      // Intercept the OUTGOING body so we capture EXACTLY what the client saw,
      // regardless of which handler produced it (fitness for AC-7's "grep all
      // responses" requirement).
      (res as unknown as { end: typeof res.end }).end = ((...args: Parameters<typeof res.end>) => {
        const chunk = args[0];
        if (chunk && typeof chunk !== 'function') {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        captured.push({
          method: req.method ?? '',
          path: req.url ?? '',
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        });
        return orig(...args);
      }) as typeof res.end;
      await router.dispatch(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, {
      orgName: `T-0574 NoLeak ${stamp}`,
      email: `t0574-noleak-${stamp}@example.com`,
      password: 'no-leak-test-pw-1',
    });
    tenantId = res.tenantId;
    ownerSlug = res.userId;
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tenantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.app_secret WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
        // agent_card BEFORE llm_connection: kept for deterministic cleanup order.
        // (No longer load-bearing: migration 116 fixed the 094 composite-FK
        // defect where a bare ON DELETE SET NULL nulled tenant_id too — see
        // llm-connection-fk-set-null.test.ts.)
        await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros.llm_connection WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
        await c.query('COMMIT');
      });
    }
    if (appPool) await appPool.end();
    if (migPool) await migPool.end();
  });

  it('drives the full flow (create → bind key → assign to assistant → probe ok → probe fail) and leaks the key NOWHERE', async () => {
    const headers = { 'x-dev-user': ownerSlug };

    // 1. Create a connection profile (AC-1).
    const createRes = await request(baseUrl, 'POST', '/api/llm-connections', headers, {
      name: 'Anthropic (no-leak test)', provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet',
    });
    expect(createRes.status).toBe(201);
    const connId = (JSON.parse(createRes.body) as { id: string }).id;

    // 2. Bind the TEST KEY (write-only, AC-2).
    const keyRes = await request(baseUrl, 'POST', `/api/llm-connections/${connId}/key`, headers, {
      api_key: TEST_KEY,
    });
    expect(keyRes.status).toBe(200);
    expect((JSON.parse(keyRes.body) as { secret_bound: boolean }).secret_bound).toBe(true);

    // 3. List profiles — must show secret_bound:true, never the key (AC-2).
    const listRes = await request(baseUrl, 'GET', '/api/llm-connections', headers);
    expect(listRes.status).toBe(200);

    // 4. Assign the profile to the assistant (F4/AC-4) — resolve via GET /api/agents.
    const agentsRes = await request(baseUrl, 'GET', '/api/agents', headers);
    const assistantId = (JSON.parse(agentsRes.body) as { agents: Array<Record<string, unknown>> })
      .agents.find((a) => a.agent_type === 'assistant')!.id as string;
    const bindRes = await request(baseUrl, 'PUT', `/api/agents/${assistantId}/llm-connection`, headers, {
      llm_connection_id: connId,
    });
    expect(bindRes.status).toBe(200);

    // 5. Probe the connection — FIRST call succeeds (AC-3 ok:true).
    const test1 = await request(baseUrl, 'POST', `/api/llm-connections/${connId}/test`, headers);
    expect(test1.status).toBe(200);
    expect((JSON.parse(test1.body) as { ok: boolean }).ok).toBe(true);

    // 6. Probe AGAIN — the fake port now throws an error that ECHOES the raw
    //    key (worst case) — AC-3 ok:false, sanitized.
    const test2 = await request(baseUrl, 'POST', `/api/llm-connections/${connId}/test`, headers);
    expect(test2.status).toBe(200);
    const test2Body = JSON.parse(test2.body) as { ok: boolean; error: string };
    expect(test2Body.ok).toBe(false);
    expect(providerErrorCall, 'the fake provider-error path must have actually fired').toBe(true);
    expect(test2Body.error).not.toContain(TEST_KEY);

    // ── THE assertion (AC-7/FF-1/N1): the test key is in NONE of the captured
    //    response bodies, across every route touched in this flow. ──────────
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.body, `${c.method} ${c.path} (${c.status}) must not contain the raw key`).not.toContain(TEST_KEY);
    }
  });

  it('FF-2 (AC-8, N2): no audit_event row for this tenant carries the raw key', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const { rows } = await c.query<{ payload: unknown }>(
        `SELECT payload FROM choros.audit_event WHERE tenant_id = $1`,
        [tenantId],
      );
      await c.query('COMMIT');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const asString = JSON.stringify(row.payload);
        expect(asString).not.toContain(TEST_KEY);
      }
    });
  });

  it('FF-2: the app_secret ciphertext row itself never contains the plaintext key as a substring', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const { rows } = await c.query<{ ciphertext: Buffer }>(
        `SELECT ciphertext FROM choros.app_secret WHERE tenant_id = $1`,
        [tenantId],
      );
      await c.query('COMMIT');
      expect(rows.length).toBe(1);
      expect(rows[0]!.ciphertext.toString('latin1')).not.toContain(TEST_KEY);
    });
  });
});
