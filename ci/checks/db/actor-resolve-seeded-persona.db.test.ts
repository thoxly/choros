// T-0633 · actor-resolve-seeded-persona — live Postgres regression for the
// T-0371 recurrence: 9 route modules + /api/org resolved the caller's identity
// as the RAW keycloak JWT `sub` instead of the REAL employee slug (via
// resolveActorSlugFromAuth, sub-first / preferred_username-fallback). A seeded
// persona (e.g. a genesis-owner whose employee.slug is human-readable but
// whose KC `sub` is a random UUID) therefore failed resolveActorTenant with
// 403 ACTOR_TENANT_UNRESOLVED even when it legitimately owns the tenant.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Strategy (mirrors ci/checks/db/agents_list.test.ts + app_secret_store.test.ts
// + src/__tests__/floor1-editor.test.ts's JWKS harness):
//   - One FRESH random tenant, seeded via the migrator (BYPASSRLS) role:
//       * OWNER_SLUG   — human employee + confirmed tenant-owner role_assignment.
//         Its KC `sub` (in the signed Bearer) is a RANDOM UUID that does NOT
//         equal OWNER_SLUG — the exact seeded-persona shape (T-0371).
//       * MEMBER_SLUG  — a second human employee with NO role/grant at all —
//         proves the fix does not widen authority: a resolvable-but-unprivileged
//         identity still gets an honest 403-by-right, not a free pass.
//   - CHOROS_AUTH_MODE=keycloak + a REAL signed Bearer JWT (local JWKS server,
//     no live Keycloak) drives withAuth exactly as production keycloak mode does.
//   - Each of the 9 fixed route modules + /api/org is hit as OWNER (expect 200 /
//     a graceful-empty payload, NEVER 403 ACTOR_TENANT_UNRESOLVED) and, where the
//     route has its own authz gate stricter than "any tenant member", as MEMBER
//     (expect an honest 403 BY RIGHT — a specific authz code, not a resolution
//     failure and not a silent 200).
//
// PUT /api/agents/:id/llm-connection is NOT covered here — investigation
// (code-truth, not the task brief's initial guess) confirmed src/http/agents.ts
// already uses the correct resolver; it is intentionally out of scope (T-0633
// spec, out_of_scope).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { resolveActorTenant } from '../../../src/db/org.js';
import { _resetJwksCache } from '../../../src/http/auth.js';
import { registerAgentListRoutes } from '../../../src/http/agents-list.js';
import { registerLlmConnectionsRoutes } from '../../../src/http/llm-connections.js';
import { registerLlmConfigRoutes } from '../../../src/http/llm-config.js';
import { registerLlmConnectionTestRoute, type LlmPortFactory } from '../../../src/http/llm-connection-test.js';
import { registerSpendRoutes } from '../../../src/http/spend.js';
import { registerGrantTrailRoutes } from '../../../src/http/grant-trail.js';
import { registerProcessCatalogRoutes } from '../../../src/http/process-catalog.js';
import { registerAppSecretRoutes } from '../../../src/http/app-secret.js';
import { registerOrgRoutes } from '../../../src/http/org.js';
import type { LlmPort } from '../../../src/core/llm-port.js';

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

// ---------------------------------------------------------------------------
// Fixture identities — the T-0371/T-0633 seeded-persona shape.
// ---------------------------------------------------------------------------

const TENANT = uuid();
const OWNER_SLUG = `owner-t0633-${TENANT.slice(0, 8)}`;
const OWNER_SUB = uuid(); // random KC UUID — deliberately != OWNER_SLUG
const MEMBER_SLUG = `member-t0633-${TENANT.slice(0, 8)}`;
const MEMBER_SUB = uuid(); // random KC UUID — deliberately != MEMBER_SLUG
const AGENT_EMPLOYEE_ID = uuid();

async function seedTenantWithOwnerAndMember(c: pg.Client): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [TENANT, `t-actor-resolve-${TENANT.slice(0, 8)}`],
  );

  const ownerEmpId = uuid();
  const memberEmpId = uuid();
  const ownerRoleId = uuid();

  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);

  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [TENANT, ownerEmpId, OWNER_SLUG, `Owner ${OWNER_SLUG}`],
  );
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [TENANT, memberEmpId, MEMBER_SLUG, `Member ${MEMBER_SLUG}`],
  );

  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Владелец', 0, 0)`,
    [TENANT, ownerRoleId],
  );
  // T-0764: proposed_by MUST be NULL — a direct/genesis grant, not a pending
  // dual-control proposal (T-0605 canonical shape, эталон
  // T-0750-inbox-detail-authority.db.test.ts). The prior proposed_by=OWNER_SLUG
  // (no confirmed2_by) read as "awaiting 2nd signature" under the canonical
  // getRoleSlugsForActor/getGrantsForSubject predicate — harmless HERE only
  // because this seed's sole consumer is isGenesisOwnerForTenant (org.ts),
  // which keys off confirmed_by alone and ignores proposed_by/confirmed2_by.
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, NULL, $6::text, 0, 0)`,
    [
      TENANT,
      uuid(),
      ownerEmpId,
      ownerRoleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
      OWNER_SLUG,
    ],
  );

  // One agent_card row (+ its employee row FIRST — agent_card_employee_fk) so
  // GET /api/llm-config's admin gate actually fires (an empty tenant
  // short-circuits to a graceful-empty 200 before the gate).
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'agent', $3, $4, 0, 0)`,
    [TENANT, AGENT_EMPLOYEE_ID, `agent-slug-t0633-${TENANT.slice(0, 8)}`, 'Agent T-0633'],
  );
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, employee_id, employee_kind, kc_client_id,
        llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
        budget_policy_id, escalation_rule_id, created_at, updated_at)
     VALUES ($1, $2, 'agent', $3, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0)`,
    [TENANT, AGENT_EMPLOYEE_ID, `agent-t0633-${TENANT.slice(0, 8)}`],
  );

  await c.query('COMMIT');
}

async function cleanupTenant(c: pg.Client): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
  await c.query('COMMIT');
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// JWKS / keycloak-mode harness (mirrors src/__tests__/floor1-editor.test.ts).
// A REAL signed Bearer JWT, verified against a local JWKS server — no live
// Keycloak, no shortcuts in the code under test.
// ---------------------------------------------------------------------------

const KID = 't0633-actor-resolve-key-1';
let kcPrivateKey: crypto.KeyObject;
let kcPublicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };
let jwksServer: http.Server;
let jwksPort: number;
const savedAuthEnv: Record<string, string | undefined> = {};

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Sign a Bearer JWT whose sub/preferred_username can differ (seeded-persona shape). */
function bearerToken(sub: string, preferredUsername: string): string {
  const claims = {
    iss: `http://127.0.0.1:${jwksPort}/realms/choros`,
    aud: 'choros-api',
    exp: Math.floor(Date.now() / 1000) + 300,
    sub,
    preferred_username: preferredUsername,
    actor_type: 'human',
  };
  const header = base64urlJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = base64urlJson(claims);
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), kcPrivateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `${signingInput}.${sig}`;
}

async function withKeycloakMode<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['CHOROS_AUTH_MODE'];
  process.env['CHOROS_AUTH_MODE'] = 'keycloak';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['CHOROS_AUTH_MODE'];
    else process.env['CHOROS_AUTH_MODE'] = prev;
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle — one Router with ALL 9 fixed modules + /api/org wired
// exactly as src/server.ts wires them (pool + resolveActorTenant).
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
// migrator (BYPASSRLS) role — mirrors production wiring: server.ts's DATABASE_URL
// resolves to choros_migrator (docker-compose.yml), NOT choros_app. Both
// resolveActorSlugFromAuth and resolveActorTenant are documented BYPASSRLS
// cross-tenant lookups (src/db/org.ts comments) — they require this role; a
// NOBYPASSRLS (choros_app) connection would see zero employee rows for the
// identity-existence check (FORCE ROW LEVEL SECURITY, migration 016) since
// neither helper sets the tenant GUC before that query.
let migPool: pg.Pool;

const noopLlmPortFactory: LlmPortFactory = (): LlmPort | null => null;

beforeAll(async () => {
  if (!hasDb) return;

  // --- JWKS server (RSA keypair, self-signed test tokens) ---
  const { generateKeyPairSync } = crypto;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  kcPrivateKey = privateKey;
  kcPublicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

  await new Promise<void>((resolve) => {
    jwksServer = http.createServer((req, res) => {
      if (req.url === '/realms/choros/.well-known/openid-configuration') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          issuer: `http://127.0.0.1:${jwksPort}/realms/choros`,
          jwks_uri: `http://127.0.0.1:${jwksPort}/realms/choros/protocol/openid-connect/certs`,
        }));
      } else if (req.url === '/realms/choros/protocol/openid-connect/certs') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [kcPublicJwk] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    jwksServer.listen(0, '127.0.0.1', () => {
      jwksPort = (jwksServer.address() as AddressInfo).port;
      resolve();
    });
  });

  for (const k of ['KEYCLOAK_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_AUDIENCE', 'KC_ISSUER']) {
    savedAuthEnv[k] = process.env[k];
  }
  process.env['KEYCLOAK_URL'] = `http://127.0.0.1:${jwksPort}`;
  process.env['KEYCLOAK_REALM'] = 'choros';
  process.env['KEYCLOAK_AUDIENCE'] = 'choros-api';
  delete process.env['KC_ISSUER'];
  _resetJwksCache();

  // --- DB seed ---
  migPool = new pg.Pool({ connectionString: migratorUrl() });
  await withClient(migratorUrl(), async (c) => {
    await seedTenantWithOwnerAndMember(c);
  });

  // --- Route wiring (mirrors src/server.ts) ---
  const resolveViaMigPool = (actorSlug: string) => resolveActorTenant(migPool, actorSlug);

  const router = new Router();
  registerAgentListRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerLlmConnectionsRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerLlmConfigRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerLlmConnectionTestRoute(router, {
    pool: migPool,
    resolveActorTenant: resolveViaMigPool,
    makeLlmPort: noopLlmPortFactory,
  });
  registerSpendRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerGrantTrailRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerProcessCatalogRoutes(router, { pool: migPool, resolveActorTenant: resolveViaMigPool });
  registerAppSecretRoutes(router, {
    pool: migPool,
    resolveActorTenant: resolveViaMigPool,
    getMasterKey: () => undefined, // DORMANT store — fine, we only touch metadata reads here
  });
  registerOrgRoutes(router);

  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await cleanupTenant(c);
  });
  if (migPool) await migPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of Object.entries(savedAuthEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetJwksCache();
  if (jwksServer) await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests — one describe per route, owner (200 / graceful, never
// ACTOR_TENANT_UNRESOLVED) + member (honest 403-by-right, where applicable).
// ---------------------------------------------------------------------------

function ownerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${bearerToken(OWNER_SUB, OWNER_SLUG)}` };
}
function memberHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${bearerToken(MEMBER_SUB, MEMBER_SLUG)}` };
}

describe('T-0633: GET /api/agents (agents-list.ts)', () => {
  it('owner (sub != slug) → 200, not ACTOR_TENANT_UNRESOLVED', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/agents', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));
});

describe('T-0633: GET /api/llm-connections (llm-connections.ts)', () => {
  it('owner → 200 (config-read gate passes)', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/llm-connections', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
    });
  }));

  it('plain member (resolvable, no grant) → honest 403 LLM_CONNECTION_CONFIGURE_REQUIRED, not identity failure', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/llm-connections', memberHeaders());
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).toContain('LLM_CONNECTION_CONFIGURE_REQUIRED');
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));
});

describe('T-0633: GET /api/llm-config (llm-config.ts)', () => {
  it('owner → 200, not ACTOR_TENANT_UNRESOLVED', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/llm-config', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
    });
  }));

  it('plain member → honest 403 ADMIN_GATE_REJECTED (agent_card row exists → gate fires)', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/llm-config', memberHeaders());
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).toContain('ADMIN_GATE_REJECTED');
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));
});

describe('T-0633: POST /api/llm-connections/:id/test (llm-connection-test.ts)', () => {
  it('owner, unknown connection id → 404 CONNECTION_NOT_FOUND (past the authz+identity gate)', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'POST', `/api/llm-connections/${uuid()}/test`, ownerHeaders());
      expect(r.statusCode, r.body).toBe(404);
      expect(r.body).toContain('CONNECTION_NOT_FOUND');
    });
  }));

  it('plain member → honest 403 LLM_CONNECTION_CONFIGURE_REQUIRED, not identity failure', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'POST', `/api/llm-connections/${uuid()}/test`, memberHeaders());
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).toContain('LLM_CONNECTION_CONFIGURE_REQUIRED');
    });
  }));
});

describe('T-0633: GET /api/spend (spend.ts)', () => {
  it('owner → 200', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/spend', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
    });
  }));

  it('plain member → 200 too (any tenant member may view spend, per spec) — proves identity resolved, not a free pass on a route with NO stricter gate', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/spend', memberHeaders());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));
});

describe('T-0633: GET /api/grant-trail (grant-trail.ts)', () => {
  it('owner → 200, not ACTOR_TENANT_UNRESOLVED', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/grant-trail', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
    });
  }));
});

describe('T-0633: GET /api/process-catalog (process-catalog.ts)', () => {
  it('owner → 200 graceful-empty, not ACTOR_TENANT_UNRESOLVED', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/process-catalog', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
      const parsed = JSON.parse(r.body) as { definitions: unknown[]; instances: unknown[]; bindings: unknown[] };
      expect(parsed.definitions).toEqual([]);
      expect(parsed.instances).toEqual([]);
      expect(parsed.bindings).toEqual([]);
    });
  }));

  it('plain member → 200 too (read-only catalog, no stricter gate) — proves identity resolved', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/process-app-bindings', memberHeaders());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));
});

describe('T-0633: GET /api/llm-connections/:id/key/status (app-secret.ts)', () => {
  it('owner, unknown connection id → 404 CONNECTION_NOT_FOUND (past the authz+identity gate)', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', `/api/llm-connections/${uuid()}/key/status`, ownerHeaders());
      expect(r.statusCode, r.body).toBe(404);
      expect(r.body).toContain('CONNECTION_NOT_FOUND');
    });
  }));

  it('plain member → honest 403 LLM_CONNECTION_CONFIGURE_REQUIRED, not identity failure', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', `/api/llm-connections/${uuid()}/key/status`, memberHeaders());
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).toContain('LLM_CONNECTION_CONFIGURE_REQUIRED');
    });
  }));
});

describe('T-0633: GET /api/org (org.ts, inline actor resolution)', () => {
  it('owner (sub != slug) → 200 org tree, not ACTOR_TENANT_UNRESOLVED', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/org', ownerHeaders());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
      const parsed = JSON.parse(r.body) as { departments: unknown[] };
      expect(Array.isArray(parsed.departments)).toBe(true);
    });
  }));

  it('plain member → 200 too (org tree is a general-read view, no stricter gate) — proves identity resolved', requireDb(async () => {
    await withKeycloakMode(async () => {
      const r = await request(baseUrl, 'GET', '/api/org', memberHeaders());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('ACTOR_TENANT_UNRESOLVED');
    });
  }));

  it('unknown identity (neither sub nor preferred_username resolves) → 401, not a silent Dev-Silo leak', requireDb(async () => {
    await withKeycloakMode(async () => {
      const token = bearerToken(uuid(), `ghost-${uuid()}`);
      const r = await request(baseUrl, 'GET', '/api/org', { Authorization: `Bearer ${token}` });
      expect(r.statusCode, r.body).toBe(401);
    });
  }));
});
