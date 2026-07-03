/**
 * ci/checks/db/configurator-owner-gate.test.ts — T-0607 (б, AC-5) live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db`.
 *
 * The live defect: a tenant OWNER holding role-configurator was refused
 * «У вас нет прав настраивать систему … в пространстве нет администратора» in one
 * turn and executed in another — the rights decision was non-deterministic
 * because the OLD gate looked only at the agent∩user grant intersection (which
 * could be empty for an owner whose authority flows from ownership, and flap by
 * the seeded agent's grant scope). This test proves the DETERMINISTIC server-side
 * gate:
 *
 *   AC-5a: isGenesisOwnerForTenant(pool, tenant, ownerSlug, now) === true for the
 *          registered owner → handleConfigurator with the real owner predicate
 *          does NOT return AUTHORING_ACCESS_DENIED_MESSAGE (deterministic admit).
 *   AC-5b: a non-owner employee with NO authoring capability → the predicate is
 *          false AND the intersection is empty → handleConfigurator returns the
 *          deterministic server refusal.
 *
 * HERMETIC: fresh registered tenant per run; migrator-user cleanup after.
 * The LLM is a StubChatLlmPort (no network) — the admit/refuse decision is made
 * by the server gate BEFORE any LLM call, exactly as the fix requires.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { isGenesisOwnerForTenant } from '../../../src/db/org.js';
import { makeDbGrantSource } from '../../../src/db/grants-dao.js';
import { makeIntersectionGrantSource } from '../../../src/core/agent-on-behalf.js';
import {
  handleConfigurator,
  AUTHORING_ACCESS_DENIED_MESSAGE,
} from '../../../src/core/assistant-configurator.js';
import { StubChatLlmPort } from '../../../src/core/__tests__/stub-chat-llm-port.js';
import type { HandlerContext } from '../../../src/core/assistant-intent.js';
import type { AncestryOracle } from '../../../src/core/grant-lattice.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();
const flatOracle: AncestryOracle = { isDescendantOrSelf(_h, d, a) { return d === a; } };

describe.skipIf(!LIVE)('T-0607 (AC-5) — deterministic configurator owner gate (live Postgres)', () => {
  let migPool: pg.Pool;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (migPool) await migPool.end();
  });

  async function registerOne(label: string): Promise<{ tenantId: string; ownerSlug: string }> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0607 ${label} ${stamp}`, email: `t0607-${label}-${stamp}@example.com`, password: 'owner-gate-pw-1' },
    );
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  /** A plain employee with no role assignments → no authoring capability, not owner. */
  async function addPlainEmployee(tenantId: string): Promise<string> {
    const empId = uuid();
    const slug = `plain-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', 'Обычный сотрудник', NULL, 0, 0)`,
        [tenantId, empId, slug],
      );
      await c.query('COMMIT');
    });
    return slug;
  }

  function makeCtx(tenantId: string, actorSlug: string): HandlerContext {
    const base = makeDbGrantSource(migPool);
    const agentSubject = { tenantId, subjectId: 'assistant-agent' };
    const userSubject = { tenantId, subjectId: actorSlug };
    const intersection = makeIntersectionGrantSource(base, agentSubject, userSubject, flatOracle);
    return {
      tenantId,
      userSubject,
      agentSubject,
      intersectionGrants: intersection,
      ancestry: flatOracle,
      llm: new StubChatLlmPort(),
      threadId: 't-1',
      messageId: 'm-1',
      isTenantOwner: () => isGenesisOwnerForTenant(migPool, tenantId, actorSlug, NOW()),
    };
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

  it('AC-5a: owner is admitted deterministically; AC-5b: non-owner without capability is refused', async () => {
    const { tenantId, ownerSlug } = await registerOne('OwnerGate');
    try {
      // AC-5a — the registered owner resolves as genesis owner.
      const ownerFlag = await isGenesisOwnerForTenant(migPool, tenantId, ownerSlug, NOW());
      expect(ownerFlag).toBe(true);

      const ownerResult = await handleConfigurator('создай приложение Клиенты', makeCtx(tenantId, ownerSlug));
      expect(ownerResult.text).not.toContain(AUTHORING_ACCESS_DENIED_MESSAGE);

      // AC-5b — a plain employee is neither owner nor capability holder → refused.
      const plainSlug = await addPlainEmployee(tenantId);
      const plainFlag = await isGenesisOwnerForTenant(migPool, tenantId, plainSlug, NOW());
      expect(plainFlag).toBe(false);

      const plainResult = await handleConfigurator('создай приложение Клиенты', makeCtx(tenantId, plainSlug));
      expect(plainResult.text).toContain(AUTHORING_ACCESS_DENIED_MESSAGE);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
