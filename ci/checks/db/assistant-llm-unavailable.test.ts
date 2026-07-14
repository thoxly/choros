/**
 * ci/checks/db/assistant-llm-unavailable.test.ts — T-0573
 * (ADR-T0573 §2.2, FF-5/FF-6/FF-UX-7), extended by T-0595
 * (ADR-T0595, UX_REVIEW T-0573 F-1/F-2, FF-1/FF-2)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * Proves, against LIVE Postgres and REAL HTTP routes (registerAssistantRoutes,
 * a real registerTenant() tenant/owner — not a mock):
 *
 *   FF-5 (AC-5, T-0573). When ctx.llm.chat() throws a NON-LlmDormantError
 *     adapter failure (modeled here as LlmUnavailableError — exactly the
 *     class src/adapters/openai-llm-port.ts now wraps its own throw points
 *     in), POST /api/assistant/threads/:id/messages does NOT answer with a
 *     raw HTTP 500 {"error":{"code":"INTERNAL"}} — it answers 503 with
 *     error.code==="LLM_UNAVAILABLE".
 *   FF-6 (AC-6, T-0573). The SAME route, for a tenant whose llmPortFactory
 *     returns the genuinely dormant port (no config at all —
 *     LlmDormantError path), answers with the SAME class of honest answer.
 *   Anti-mask check (ADR-T0573 §2.2 "do not mask real bugs"): when
 *     ctx.llm.chat() throws a PLAIN Error (not LlmDormantError, not
 *     LlmUnavailableError), the route still falls through to the ordinary
 *     500 INTERNAL path — the classifier does NOT swallow genuine bugs.
 *
 *   FF-1 (AC-1, T-0595). The tenant OWNER (always isGenesisOwner=true, hence
 *     admin) gets a structured error.deepLinks:[{path:"/llm-connections",
 *     label}] in the SAME honest-503 body — UX_REVIEW T-0573 F-2's
 *     click-through. (Supersedes the old `.toContain('/llm-connections')`
 *     text assertion — the admin PROSE no longer carries the bare path,
 *     F-2 — the contract moved from substring-in-text to a structural
 *     deep-link descriptor, asserted here instead.)
 *   FF-2 (AC-2, T-0595). A plain tenant member (no role_assignment at all —
 *     NOT admin, cannot reach /llm-connections via their own nav either,
 *     UX_REVIEW T-0573 F-1) gets the SAME honest 503 but WITHOUT
 *     error.deepLinks — no dead door to a screen they cannot reach.
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

  // T-0595 (AC-2, FF-2): a plain tenant member — NO role_assignment at all
  // (not tenant-owner, not role-configurator) — same pattern as
  // assistant-llm-binding.test.ts FF-7 (non-privileged-member fixture).
  // isGenesisOwner=false AND adminGrants=[] for this actor: NOT admin.
  async function createPlainMember(tenantId: string, label: string): Promise<string> {
    const plainSlug = `t0595-plain-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), $2, 'human', 'T-0595 plain member', NULL, 0, 0)`,
        [tenantId, plainSlug],
      );
      await c.query('COMMIT');
    });
    return plainSlug;
  }

  // -------------------------------------------------------------------------
  // FF-6 (AC-6, T-0573): dormant path (LlmDormantError, via the real
  // dormantLlmPort). T-0595/AC-1: the owner is ALWAYS isGenesisOwner=true
  // (tenant-owner role_assignment from registerTenant) — i.e. always admin —
  // so this scenario now asserts the structural error.deepLinks descriptor
  // (F-2 removed the bare path from the admin PROSE; the click-through
  // carries "where"/"how" instead — see ADR-T0595 §1.5).
  // -------------------------------------------------------------------------
  it('FF-6/FF-1: dormant LLM (no config at all), owner (admin) — 503 LLM_UNAVAILABLE with error.deepLinks to /llm-connections', async () => {
    const a = await registerOne('Dormant');
    try {
      currentFactoryResult = dormantLlmPort;
      const threadId = await createThread(baseUrl, a.ownerSlug);

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': a.ownerSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as {
        error: { code: string; message: string; deepLinks?: Array<{ path: string; label: string }> };
      };
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      // T-0595/F-2: admin prose no longer carries the bare path.
      expect(body.error.message).not.toContain('/llm-connections');
      // T-0595/AC-1: structural deep-link descriptor present instead.
      expect(body.error.deepLinks).toEqual([
        { path: '/llm-connections', label: expect.any(String) },
      ]);
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-5 (AC-5, T-0573): adapter-failure path (LlmUnavailableError — config
  // EXISTS, the call failed). Must NOT be a raw 500 INTERNAL. Same T-0595/AC-1
  // structural-deep-link contract as the dormant path (owner is always admin).
  // -------------------------------------------------------------------------
  it('FF-5/FF-1: a configured-but-failing LLM adapter, owner (admin) — 503 LLM_UNAVAILABLE with error.deepLinks, NOT 500 INTERNAL', async () => {
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
      const body = JSON.parse(res.body) as {
        error: { code: string; message: string; deepLinks?: Array<{ path: string; label: string }> };
      };
      expect(body.error.code).not.toBe('INTERNAL');
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      expect(body.error.message).not.toContain('/llm-connections');
      expect(body.error.deepLinks).toEqual([
        { path: '/llm-connections', label: expect.any(String) },
      ]);
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-2 (AC-2, T-0595): a plain tenant member (no admin capability at all)
  // gets the SAME honest 503 class, but WITHOUT error.deepLinks — the server
  // does not offer a path the caller cannot reach via their own nav
  // (UX_REVIEW T-0573 F-1 — admin zone is hidden from a non-admin builder).
  // -------------------------------------------------------------------------
  it('FF-2: dormant LLM, plain non-admin member — 503 LLM_UNAVAILABLE WITHOUT error.deepLinks (no dead door)', async () => {
    const a = await registerOne('NonAdmin');
    try {
      currentFactoryResult = dormantLlmPort;
      const plainSlug = await createPlainMember(a.tenantId, 'dormant');
      const threadId = await createThread(baseUrl, plainSlug);

      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': plainSlug },
        { text: 'привет, расскажи, сколько заявок обработано' },
      );
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as {
        error: { code: string; message: string; deepLinks?: unknown };
      };
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      // T-0595/AC-3: no path at all — nothing to navigate to.
      expect(body.error.message).not.toContain('/llm-connections');
      // T-0595/AC-3: honestly redirects to the tenant admin instead.
      expect(body.error.message.toLowerCase()).toMatch(/администратор/);
      // T-0595/AC-2: no deep-link descriptor — field absent, not an empty array.
      expect(body.error.deepLinks).toBeUndefined();
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
