/**
 * ci/checks/db/assistant-llm-binding.test.ts — T-0574 (ADR-T0574 §2.1/§2.3)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * Proves the keystone of this task, end-to-end, against LIVE Postgres (RLS,
 * real registerTenant, real HTTP routes) — NOT a mock:
 *
 *   FF-3 (AC-4). A freshly-registered tenant's assistant-agent is ADDRESSABLE:
 *     GET /api/agents lists an element with agent_type==='assistant', and
 *     PUT /api/agents/<its id>/llm-connection with a valid llm_connection_id
 *     returns 200 (NOT 404 AGENT_NOT_FOUND — the anti-case this whole task
 *     exists to close, ADR §1).
 *   FF-4 (AC-5). After that bind, the server's own LLM-config resolver
 *     (readConfiguredAgentLlmConfig / loadTenantLlmConfig — the composition
 *     root's actual dependency, src/db/agent-card-llm.ts) returns a non-null
 *     config carrying THAT profile's endpoint/model — in the SAME process,
 *     no restart between bind and resolve (C3: assistant-first ORDER BY +
 *     fresh-read-per-call).
 *   FF-7 (AC-10, N6). The same PUT under a non-privileged tenant member (no
 *     owner role, no delegable mgmt_object:agent grant) → 403
 *     ADMIN_GATE_REJECTED — not 500, not a silent pass.
 *   C4 (env-fallback preserved). Before any bind, the assistant's agent_card
 *     row is genuinely dormant (llm_connection_id NULL, all llm_* NULL) — the
 *     COALESCE/env-fallback path is not pre-empted by this task's INSERT.
 *
 * registerTenant (src/core/register.ts) is exercised for REAL — this is what
 * proves the 3f-bis INSERT (this task's core delta) actually fires in the
 * genesis onboarding transaction, not just in isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerAgentRoutes } from '../../../src/http/agents.js';
import { registerAgentListRoutes } from '../../../src/http/agents-list.js';
import { registerLlmConnectionsRoutes } from '../../../src/http/llm-connections.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { loadTenantLlmConfig } from '../../../src/db/agent-card-llm.js';
import type { KeycloakAdminPort } from '../../../src/core/agent-hire.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

// A no-op KeycloakAdminPort — the llm-connection / agents-list routes under
// test never touch the workforce-hire path that needs it.
const noopKcPort: KeycloakAdminPort = {
  createServiceAccountClient: async () => ({ clientId: 'noop' }),
  deleteClient: async () => {},
};

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
  ownerSlug: string; // = KC sub = employee.slug (genesis owner, x-dev-user value)
}

describe.skipIf(!LIVE)('T-0574 — assistant-agent LLM binding (live Postgres)', () => {
  // ONE pool for everything, mirroring PRODUCTION WIRING EXACTLY (src/server.ts):
  // registerAgentRoutes / registerAgentListRoutes / registerLlmConnectionsRoutes
  // and resolveActorTenant ALL run against `grantsPool` (DATABASE_URL →
  // choros_migrator, BYPASSRLS) — NOT the NOBYPASSRLS choros_app pool. This is a
  // pre-existing, deliberate choice in this codebase (server.ts:399,537-538,
  // 710-717,1062-1063) and out of scope for this task to revisit; resolveActorTenant
  // in particular is a documented cross-tenant BYPASSRLS lookup (src/db/org.ts) that
  // must run BEFORE any tenant GUC exists, so it cannot work under FORCE RLS with no
  // GUC set (confirmed empirically while authoring this file: pointed at the
  // choros_app pool it 403s ACTOR_TENANT_UNRESOLVED — zero employee rows visible).
  let migPool: pg.Pool;
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });

    const { resolveActorTenant } = await import('../../../src/db/org.js');
    const resolveViaMigrator = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

    const router = new Router();
    registerAgentRoutes(router, migPool, noopKcPort);
    registerAgentListRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigrator });
    registerLlmConnectionsRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigrator });
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
      orgName: `T-0574 ${label} ${stamp}`,
      email: `t0574-${label}-${stamp}@example.com`,
      password: 'assistant-key-pw-1',
    };
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, req);
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  /** Best-effort deep delete of a registered tenant (FK-safe order). */
  async function cleanup(tenantId: string): Promise<void> {
    const c = await migPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query('SET LOCAL search_path TO choros');
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
    } catch {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    } finally {
      c.release();
    }
  }

  // -------------------------------------------------------------------------
  // register.ts 3f-bis — the agent_card row exists, dormant, right after
  // registration (BEFORE any binding). Proves C4 (env-fallback path untouched)
  // and that the INSERT actually ran inside the onboarding transaction.
  // -------------------------------------------------------------------------
  it('3f-bis: registerTenant creates a DORMANT agent_card row for assistant-agent (llm_* all NULL)', async () => {
    const a = await registerOne('Dormant');
    try {
      const row = await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${a.tenantId}'`);
        const { rows } = await c.query(
          `SELECT ac.agent_type, ac.kc_client_id, ac.llm_endpoint, ac.llm_model,
                  ac.llm_secret_handle, ac.llm_connection_id, e.slug
             FROM choros.agent_card ac
             JOIN choros.employee e
                  ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
            WHERE ac.tenant_id = $1 AND e.slug = 'assistant-agent'`,
          [a.tenantId],
        );
        await c.query('COMMIT');
        return rows[0] as Record<string, unknown> | undefined;
      });
      expect(row, 'assistant-agent must have an agent_card row right after registration').toBeDefined();
      expect(row!.agent_type).toBe('assistant');
      expect(row!.kc_client_id).toBe(`assistant-agent-${a.tenantId}`);
      expect(row!.llm_endpoint).toBeNull();
      expect(row!.llm_model).toBeNull();
      expect(row!.llm_secret_handle).toBeNull();
      expect(row!.llm_connection_id).toBeNull();
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-3 (AC-4) — GET /api/agents lists it; PUT .../llm-connection → 200, NOT 404.
  // -------------------------------------------------------------------------
  it('FF-3: GET /api/agents lists the assistant; PUT .../llm-connection binds it (200, not 404 AGENT_NOT_FOUND)', async () => {
    const a = await registerOne('Addressable');
    try {
      const listRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      expect(listRes.statusCode).toBe(200);
      const agents = (JSON.parse(listRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const assistant = agents.find((ag) => ag.agent_type === 'assistant');
      expect(assistant, 'assistant must appear in GET /api/agents').toBeDefined();
      expect(assistant!.has_org_place).toBe(true); // employee_id set (3f-bis addresses like workforce)
      const assistantId = assistant!.id as string;

      // Create a connection profile to bind.
      const connRes = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': a.ownerSlug }, {
        name: 'Anthropic (T-0574 test)',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet',
      });
      expect(connRes.statusCode).toBe(201);
      const connId = (JSON.parse(connRes.body) as { id: string }).id;

      const bindRes = await request(
        baseUrl, 'PUT', `/api/agents/${assistantId}/llm-connection`, { 'x-dev-user': a.ownerSlug },
        { llm_connection_id: connId },
      );
      // THE anti-case this task exists to close: this must NOT be 404.
      expect(bindRes.statusCode).toBe(200);
      const bindBody = JSON.parse(bindRes.body) as Record<string, unknown>;
      expect(bindBody.ok).toBe(true);
      expect(bindBody.llm_connection_id).toBe(connId);
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-4 (AC-5) — after binding, the server's OWN resolver sees it, same process.
  // -------------------------------------------------------------------------
  it('FF-4: loadTenantLlmConfig resolves the bound profile in the SAME process (no restart)', async () => {
    const a = await registerOne('Resolve');
    try {
      const listRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      const agents = (JSON.parse(listRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const assistantId = agents.find((ag) => ag.agent_type === 'assistant')!.id as string;

      const connRes = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': a.ownerSlug }, {
        name: 'Anthropic resolve-test',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-resolve-test',
      });
      const connId = (JSON.parse(connRes.body) as { id: string }).id;

      // Bind a WORKING secret handle directly (bypassing the app:// key-store —
      // FF-4 only needs to prove the RESOLVER sees the profile; the app:// path
      // is already proved by app_secret_store.test.ts).
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${a.tenantId}'`);
        await c.query(
          `UPDATE choros.llm_connection SET secret_handle = $2 WHERE tenant_id = $1 AND id = $3`,
          [a.tenantId, 'vault://secret/t0574-resolve-test', connId],
        );
        await c.query('COMMIT');
      });

      const bindRes = await request(
        baseUrl, 'PUT', `/api/agents/${assistantId}/llm-connection`, { 'x-dev-user': a.ownerSlug },
        { llm_connection_id: connId },
      );
      expect(bindRes.statusCode).toBe(200);

      // THE resolver the composition root actually calls (src/server.ts:
      // makeLlmPortFactory → loadTenantLlmConfig) — same pool, no restart.
      const cfg = await loadTenantLlmConfig(migPool, a.tenantId);
      expect(cfg, 'resolver must see the bound profile without a restart').not.toBeNull();
      expect(cfg!.llmEndpoint).toBe('https://api.anthropic.com/v1');
      expect(cfg!.llmModel).toBe('claude-3-5-sonnet-resolve-test');
      expect(cfg!.secretHandle).toBe('vault://secret/t0574-resolve-test');
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // T-0599 FF-1/FF-2 (AC-1/AC-2) — GET /api/agents reports the assistant's
  // llm_bound honestly for the CURRENT (named-connection) binding path.
  //
  // Before T-0599, listAgentsTx read ONLY the deprecated inline
  // agent_card.llm_secret_handle column — which register.ts's 3f-bis seed
  // (see the DORMANT test above) and the bind flow above BOTH leave NULL even
  // after a successful llm_connection bind (the secret lives on
  // llm_connection.secret_handle, not on agent_card). llm_bound would falsely
  // report false even though the SAME resolver FF-4 just proved
  // (loadTenantLlmConfig) sees a fully-configured LLM. This is the exact
  // ground-truth signal the proactive assistant-screen banner (T-0599) relies
  // on — it must match the REAL runtime resolution, not the stale column.
  // -------------------------------------------------------------------------
  it('T-0599 FF-2 (AC-2): before any bind, GET /api/agents reports llm_bound:false for the assistant', async () => {
    const a = await registerOne('BannerUnbound');
    try {
      const listRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      expect(listRes.statusCode).toBe(200);
      const agents = (JSON.parse(listRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const assistant = agents.find((ag) => ag.slug === 'assistant-agent');
      expect(assistant, 'assistant-agent must be addressable by slug').toBeDefined();
      expect(assistant!.llm_bound).toBe(false);
    } finally {
      await cleanup(a.tenantId);
    }
  });

  it('T-0599 FF-1 (AC-1): after binding to a connection WITH a secret_handle, GET /api/agents reports llm_bound:true (not the stale inline column)', async () => {
    const a = await registerOne('BannerBound');
    try {
      const listRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      const agents = (JSON.parse(listRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const assistantId = agents.find((ag) => ag.slug === 'assistant-agent')!.id as string;

      const connRes = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': a.ownerSlug }, {
        name: 'T-0599 banner-honesty profile',
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-t0599',
      });
      const connId = (JSON.parse(connRes.body) as { id: string }).id;

      // Bind the secret directly on the CONNECTION (not agent_card) — the
      // actual /llm-connections key-bind path, same as FF-4 above.
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${a.tenantId}'`);
        await c.query(
          `UPDATE choros.llm_connection SET secret_handle = $2 WHERE tenant_id = $1 AND id = $3`,
          [a.tenantId, 'vault://secret/t0599-banner-honesty', connId],
        );
        await c.query('COMMIT');
      });

      const bindRes = await request(
        baseUrl, 'PUT', `/api/agents/${assistantId}/llm-connection`, { 'x-dev-user': a.ownerSlug },
        { llm_connection_id: connId },
      );
      expect(bindRes.statusCode).toBe(200);

      // Re-fetch the list: llm_bound must now be true, AND the underlying
      // agent_card.llm_secret_handle column must STILL be NULL (proving the
      // signal comes from the connection JOIN, not a side-effect write to the
      // deprecated column).
      const rawRow = await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${a.tenantId}'`);
        const { rows } = await c.query(
          `SELECT llm_secret_handle FROM choros.agent_card WHERE tenant_id = $1 AND employee_id = $2`,
          [a.tenantId, assistantId],
        );
        await c.query('COMMIT');
        return rows[0] as { llm_secret_handle: string | null } | undefined;
      });
      expect(rawRow!.llm_secret_handle, 'inline column must remain untouched (NULL) — signal comes from the connection JOIN').toBeNull();

      const afterRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      const afterAgents = (JSON.parse(afterRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const afterAssistant = afterAgents.find((ag) => ag.slug === 'assistant-agent');
      expect(afterAssistant!.llm_bound).toBe(true);
    } finally {
      await cleanup(a.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // FF-7 (AC-10, N6) — fail-closed authz: a non-privileged member gets 403.
  // -------------------------------------------------------------------------
  it('FF-7: a non-privileged tenant member gets 403 ADMIN_GATE_REJECTED, not 500 / silent success', async () => {
    const a = await registerOne('Authz');
    try {
      const listRes = await request(baseUrl, 'GET', '/api/agents', { 'x-dev-user': a.ownerSlug });
      const agents = (JSON.parse(listRes.body) as { agents: Array<Record<string, unknown>> }).agents;
      const assistantId = agents.find((ag) => ag.agent_type === 'assistant')!.id as string;

      const connRes = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': a.ownerSlug }, {
        name: 'Authz-test profile', provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet',
      });
      const connId = (JSON.parse(connRes.body) as { id: string }).id;

      // Plain, unprivileged employee in the SAME tenant — no role_assignment at all.
      const plainSlug = `plain-member-${Date.now()}`;
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${a.tenantId}'`);
        await c.query(
          `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
           VALUES ($1, gen_random_uuid(), $2, 'human', 'Plain member', NULL, 0, 0)`,
          [a.tenantId, plainSlug],
        );
        await c.query('COMMIT');
      });

      const bindRes = await request(
        baseUrl, 'PUT', `/api/agents/${assistantId}/llm-connection`, { 'x-dev-user': plainSlug },
        { llm_connection_id: connId },
      );
      expect(bindRes.statusCode).toBe(403);
      const body = JSON.parse(bindRes.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('ADMIN_GATE_REJECTED');
    } finally {
      await cleanup(a.tenantId);
    }
  });
});
