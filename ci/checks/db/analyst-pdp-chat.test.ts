/**
 * ci/checks/db/analyst-pdp-chat.test.ts — T-0587 (ADR-T0587 §3/§4, FF-3/FF-4/
 * FF-5, AC-2/AC-3/AC-6) live Postgres, REAL HTTP routes.
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * THE GAP this test closes (ADR-T0587 §0/key_findings): every prior digest
 * test (registry-digest.test.ts) exercised loadReadableRegistryDigest at the
 * DAO level directly — never the FULL chat path (POST /api/assistant/threads/
 * :id/messages → intentDispatch → runAnalyst → buildDraftContext → LLM →
 * persisted reply). This test proves the SAME two-identity/subset guarantee
 * holds end-to-end through REAL registerAssistantRoutes(), with
 * setAnalystPorts wired to the REAL loadReadableRegistryDigest (not a stub) —
 * exactly the production wiring in src/server.ts.
 *
 * FF-3 (AC-2, FR-6): two identities (owner — full visibility; narrow-grant
 *   employee — record-scoped READ) send the IDENTICAL question text through
 *   the REAL route → the persisted assistant reply differs: the owner's
 *   reply cites the FULL sum (both records), the narrow employee's reply
 *   cites ONLY the visible record's value — never the invisible sibling's.
 * FF-4 (AC-3, FR-3/FR-5): a THIRD identity with ZERO covering grant on the
 *   registry gets the honest zone-of-visibility refusal
 *   (ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE) — not silence, not a
 *   technical error, not the same substantive reply as the other two.
 * FF-5 (AC-6): regression — the analyst path (not just the generic route)
 *   still answers with the honest LLM-unavailable message (not raw INTERNAL)
 *   when the LLM is dormant, reusing the SAME assistant-llm-unavailable.test.ts
 *   harness pattern (llmPortFactory swap).
 *
 * A deterministic StubChatLlmPort ECHOES the draft context verbatim into its
 * reply (not a real network call — $0 cost, no external LLM key needed here;
 * LIVE_PROOF with a REAL LLM key + browser is a separate, manual step per
 * ADR-T0587 §5 / AC-7). Echoing the context lets this test assert on the
 * NUMBERS THE SERVER COMPUTED (numericAggregates.sum) rather than on
 * LLM-authored prose, which is the honest thing to assert: the SERVER must
 * have computed the correct READ-PDP-scoped subset BEFORE it ever reaches
 * the LLM — this test proves that computation, end-to-end through the route.
 *
 * HERMETIC: fresh registered tenant per test; migrator-user cleanup after.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAssistantRoutes } from '../../../src/http/assistant.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { dormantLlmPort, type LlmPort, type ChatLlmRequest, type ChatLlmResult } from '../../../src/core/llm-port.js';
import { setAnalystPorts, resetAnalystPorts } from '../../../src/core/assistant-analyst.js';
import { loadReadableRegistryDigest } from '../../../src/db/registry-digest-dao.js';
import { ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE } from '../../../src/core/assistant-messages.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();
const QUESTION = 'сколько записей в разделе и на какую сумму';

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

/** A deterministic chat port that ECHOES the context it was given (no network). */
function makeEchoLlmPort(): LlmPort {
  return {
    complete: async () => ({ text: '' }),
    chat: async (req: ChatLlmRequest): Promise<ChatLlmResult> => {
      const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return { text: `[echo]\n${userMsg}` };
    },
  };
}

describe.skipIf(!LIVE)('T-0587 — analyst READ-PDP two-identity chat proof (live Postgres, real routes)', () => {
  let migPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';
  let currentFactoryResult: LlmPort | (() => never) = makeEchoLlmPort();

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });

    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const resolveViaMigrator = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

    // T-0587: wire the REAL loadReadableRegistryDigest — the SAME wiring
    // src/server.ts::setAnalystPorts uses in production (not a stub port).
    setAnalystPorts({
      loadRegistryDigest: (tenantId: string, actorSlug: string) =>
        loadReadableRegistryDigest(migPool, tenantId, actorSlug, NOW()),
    });

    const router = new Router();
    registerAssistantRoutes(router, {
      pool: migPool,
      resolveActorTenant: resolveViaMigrator,
      llmPortFactory: async (_tenantId: string) => {
        if (typeof currentFactoryResult === 'function') return currentFactoryResult();
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
    resetAnalystPorts();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (migPool) await migPool.end();
  });

  async function registerOne(label: string): Promise<{ tenantId: string; ownerSlug: string }> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0587 ${label} ${stamp}`, email: `t0587-${label}-${stamp}@example.com`, password: 'analyst-pdp-pw-1' },
    );
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  async function seedRegistryWithTwoNumericRecords(
    tenantId: string,
    createdBy: string,
  ): Promise<{ regId: string; regSlug: string; rec1Id: string; rec2Id: string }> {
    const appId = uuid();
    const regId = uuid();
    const rec1Id = uuid();
    const rec2Id = uuid();
    const regSlug = `reg-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Раздел (тест чата)', NULL, 'published', 0, 0)`,
        [tenantId, appId, `app-${regSlug}`],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Записи с суммой (тест чата)', NULL, $5::jsonb, 0, 0)`,
        [
          tenantId, regId, appId, regSlug,
          JSON.stringify({
            type: 'object',
            properties: { title: { type: 'string' }, amount: { type: 'number', title: 'Сумма' } },
          }),
        ],
      );
      await c.query(
        `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
        [tenantId, rec1Id, regId, JSON.stringify({ title: 'Запись-1', amount: 100000 }), createdBy],
      );
      await c.query(
        `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
        [tenantId, rec2Id, regId, JSON.stringify({ title: 'Запись-2', amount: 250000 }), createdBy],
      );
      await c.query('COMMIT');
    });
    return { regId, regSlug, rec1Id, rec2Id };
  }

  function recordScope(recordId: string): unknown {
    return { kind: 'node', hierarchy: 'resource', nodeLevel: 'record', nodeId: recordId };
  }

  /** Employee with READ scoped to exactly ONE record (strictly narrower than owner). */
  async function addNarrowGrantEmployee(tenantId: string, visibleRecordId: string): Promise<string> {
    const empId = uuid();
    const slug = `chat-narrow-${Math.random().toString(36).slice(2, 8)}`;
    const roleId = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', 'Сотрудник с суженным доступом', NULL, 0, 0)`,
        [tenantId, empId, slug],
      );
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $3, 0, 0)`,
        [tenantId, roleId, `chat-narrow-role-${roleId.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
        [tenantId, uuid(), empId, roleId, JSON.stringify({ kind: 'set', members: [] })],
      );
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, proposed_by, confirmed_by,
            valid_from, valid_until, created_at)
         VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb,
                 NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
        [tenantId, uuid(), roleId, JSON.stringify(recordScope(visibleRecordId))],
      );
      await c.query('COMMIT');
    });
    return slug;
  }

  /** Employee with NO role_assignment at all — zero covering grant (FF-4/FR-5). */
  async function addNoGrantEmployee(tenantId: string): Promise<string> {
    const empId = uuid();
    const slug = `chat-nogrant-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', 'Сотрудник без доступа', NULL, 0, 0)`,
        [tenantId, empId, slug],
      );
      await c.query('COMMIT');
    });
    return slug;
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      // Bypass the tier-published write-lock (T-0087 FR-4) for cleanup only.
      await c.query(`SET LOCAL choros.promoting = '1'`);
      await c.query(`DELETE FROM choros.record WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
      await c.query('COMMIT');
    });
  }

  async function createThread(ownerSlug: string): Promise<string> {
    const res = await request(baseUrl, 'POST', '/api/assistant/threads', { 'x-dev-user': ownerSlug }, { title: 'T-0587 test' });
    expect(res.statusCode).toBe(201);
    return (JSON.parse(res.body) as { id: string }).id;
  }

  async function askQuestion(actorSlug: string): Promise<{ statusCode: number; text?: string; raw: string }> {
    const threadId = await createThread(actorSlug);
    const res = await request(
      baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': actorSlug },
      { text: QUESTION },
    );
    if (res.statusCode !== 200) return { statusCode: res.statusCode, raw: res.body };
    const body = JSON.parse(res.body) as { text: string };
    return { statusCode: res.statusCode, text: body.text, raw: res.body };
  }

  // ---------------------------------------------------------------------------
  // FF-3 (AC-2/FR-6): two identities, IDENTICAL question, DIFFERENT numbers —
  // through the REAL route, not the DAO directly.
  // ---------------------------------------------------------------------------
  it('FF-3/AC-2: owner sees the FULL sum; narrow-grant employee sees STRICTLY the visible subset — same question, different replies', async () => {
    const { tenantId, ownerSlug } = await registerOne('ChatSubset');
    try {
      currentFactoryResult = makeEchoLlmPort();
      const { rec1Id } = await seedRegistryWithTwoNumericRecords(tenantId, ownerSlug);

      const ownerReply = await askQuestion(ownerSlug);
      expect(ownerReply.statusCode).toBe(200);
      expect(ownerReply.text).toBeDefined();
      // Owner sees BOTH records' sum (350000) — never just one record's value.
      expect(ownerReply.text!).toContain('350000');
      expect(ownerReply.text!).toContain('записей — 2');

      const narrowSlug = await addNarrowGrantEmployee(tenantId, rec1Id);
      const narrowReply = await askQuestion(narrowSlug);
      expect(narrowReply.statusCode).toBe(200);
      expect(narrowReply.text).toBeDefined();
      // Narrow employee sees ONLY the visible record's value (100000) — NEVER
      // the sibling's value (250000) and NEVER the owner's full sum (350000).
      expect(narrowReply.text!).toContain('100000');
      expect(narrowReply.text!).not.toContain('250000');
      expect(narrowReply.text!).not.toContain('350000');
      expect(narrowReply.text!).toContain('записей — 1');

      // The two replies to the SAME question text are DETERMINISTICALLY different.
      expect(narrowReply.text).not.toBe(ownerReply.text);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // FF-4 (AC-3, FR-3/FR-5): zero-grant identity → honest zone-of-visibility
  // refusal — not silence, not a technical error, not the owner's substantive
  // reply.
  // ---------------------------------------------------------------------------
  it('FF-4/AC-3: zero-grant employee gets the honest FR-5 refusal, NOT the substantive answer and NOT a technical error', async () => {
    const { tenantId, ownerSlug } = await registerOne('ChatZeroGrant');
    try {
      currentFactoryResult = makeEchoLlmPort();
      await seedRegistryWithTwoNumericRecords(tenantId, ownerSlug);

      const noGrantSlug = await addNoGrantEmployee(tenantId);
      const reply = await askQuestion(noGrantSlug);

      expect(reply.statusCode).toBe(200);
      expect(reply.text).toBeDefined();
      // FR-5: the honest refusal constant is present in what reaches the LLM
      // (echoed verbatim by the stub) — the server-built instruction, not an
      // LLM improvisation.
      expect(reply.text!).toContain(ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE);
      // Never leaks the numbers a grant-holder would see.
      expect(reply.text!).not.toContain('100000');
      expect(reply.text!).not.toContain('250000');
      expect(reply.text!).not.toContain('350000');
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // FF-5 (AC-6): honest-503 regression on the ANALYST path specifically (not
  // just the generic route) — dormant LLM → 503 LLM_UNAVAILABLE, never raw
  // INTERNAL/500 without a thread reply.
  // ---------------------------------------------------------------------------
  it('FF-5/AC-6: dormant LLM on the analyst path — 503 LLM_UNAVAILABLE, NOT 500 INTERNAL', async () => {
    const { tenantId, ownerSlug } = await registerOne('ChatDormant');
    try {
      currentFactoryResult = dormantLlmPort;
      await seedRegistryWithTwoNumericRecords(tenantId, ownerSlug);

      const threadId = await createThread(ownerSlug);
      const res = await request(
        baseUrl, 'POST', `/api/assistant/threads/${threadId}/messages`, { 'x-dev-user': ownerSlug },
        { text: QUESTION },
      );
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('LLM_UNAVAILABLE');
      expect(body.error.code).not.toBe('INTERNAL');
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
