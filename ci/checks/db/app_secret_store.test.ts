// T-0476 · app:// encrypted secret store (migration 106) — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db
//
// THE L3 INVARIANTS (migration 106 app_secret + AEAD cipher + app:// handle +
// the /api/llm-connections/:id/key route), proven against the real choros_app
// (NOBYPASSRLS) role and the production RLS path — NOT a mock:
//   1. AEAD ROUND-TRIP: encrypt → store → decrypt recovers the plaintext;
//      ciphertext ≠ plaintext; nonce is unique per encryption; key_version stamped.
//   2. RLS TENANT ISOLATION (mandatory): an app_secret stored by tenant A is NEVER
//      readable by tenant B (proven via choros_app under each tenant GUC).
//   3. WRITE-ONLY UI: POST binds the key (200) → GET status returns only
//      secret_bound:true + redacted scheme — the raw key NEVER appears in any
//      response. The DB row stores only ciphertext (the raw key never lands).
//   4. NO-EGRESS resolveSecret: the decrypt path recovers the key for the immediate
//      caller, but the key string is never present in route responses/logs.
//   5. DORMANT: when APP_SECRET_MASTER_KEY is unset, POST returns 503 (honest) and
//      NO app_secret row is created (no plaintext stored, no crash).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerLlmConnectionsRoutes } from '../../../src/http/llm-connections.js';
import { registerAppSecretRoutes } from '../../../src/http/app-secret.js';
import {
  encryptSecret,
  decryptSecret,
  loadMasterKey,
} from '../../../src/core/app-secret-cipher.js';
import { insertAppSecret, getAppSecretSealed } from '../../../src/db/app-secret-dao.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

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

const TENANT_A = uuid();
const TENANT_B = uuid();
const TEST_MASTER_KEY = 'unit-test-master-key-for-T0476-aead-roundtrip';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'owner-a') return TENANT_A;
  if (slug === 'owner-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seedTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  const ownerEmpId = uuid();
  const ownerRoleId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [tenantId, ownerEmpId, ownerSlug, `Owner ${ownerSlug}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', 0, 0)`,
    [tenantId, ownerRoleId],
  );
  // T-0764: proposed_by MUST be NULL — direct/genesis grant, not a pending
  // dual-control proposal (T-0605 canonical shape, эталон
  // T-0750-inbox-detail-authority.db.test.ts). Harmless here (sole consumer
  // isGenesisOwnerForTenant ignores proposed_by/confirmed2_by) but non-canonical.
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, NULL, $6::text, 0, 0)`,
    [
      tenantId,
      uuid(),
      ownerEmpId,
      ownerRoleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
      ownerSlug,
    ],
  );
  await c.query('COMMIT');
}

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
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: h,
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
// Toggle the dormant state per-test by swapping what getMasterKey returns.
let masterKeyState: string | undefined = TEST_MASTER_KEY;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerLlmConnectionsRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  registerAppSecretRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    getMasterKey: () => masterKeyState,
  });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_A, 'owner-a');
    await seedTenant(c, TENANT_B, 'owner-b');
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
      await c.query(`DELETE FROM choros.app_secret WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.llm_connection WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// 1. AEAD round-trip (pure crypto — no DB needed, but proves the cipher contract).
// ---------------------------------------------------------------------------
describe('T-0476 — AES-256-GCM envelope cipher', () => {
  it('encrypt → decrypt recovers plaintext; ciphertext ≠ plaintext', () => {
    const key = loadMasterKey(TEST_MASTER_KEY);
    const plaintext = 'sk-proj-SUPER-SECRET-DEEPSEEK-KEY-123456';
    const sealed = encryptSecret(plaintext, key);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(sealed.ciphertext.length).toBeGreaterThan(16); // includes 16B GCM tag
    expect(sealed.nonce.length).toBe(12);
    expect(sealed.keyVersion).toBe(1);
    const recovered = decryptSecret(sealed, key);
    expect(recovered).toBe(plaintext);
  });

  it('nonce is unique per encryption (no nonce reuse)', () => {
    const key = loadMasterKey(TEST_MASTER_KEY);
    const a = encryptSecret('same-plaintext', key);
    const b = encryptSecret('same-plaintext', key);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    // Same plaintext + different nonce → different ciphertext (semantic security).
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('tampered ciphertext fails the GCM auth tag (no silent garbage)', () => {
    const key = loadMasterKey(TEST_MASTER_KEY);
    const sealed = encryptSecret('plaintext-x', key);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff; // flip a bit
    expect(() => decryptSecret({ ...sealed, ciphertext: tampered }, key)).toThrow();
  });

  it('decrypt with the WRONG key fails (authentication)', () => {
    const sealed = encryptSecret('plaintext-y', loadMasterKey('key-one'));
    expect(() => decryptSecret(sealed, loadMasterKey('key-two'))).toThrow();
  });

  it('dormant: loadMasterKey(undefined/empty) throws the unconfigured error', () => {
    expect(() => loadMasterKey(undefined)).toThrow(/not configured/);
    expect(() => loadMasterKey('')).toThrow(/not configured/);
    expect(() => loadMasterKey('   ')).toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------------------
// 2-5. DB + route: store, RLS isolation, write-only, dormant.
// ---------------------------------------------------------------------------
describe('T-0476 — app_secret store: RLS + write-only key route', () => {
  let connIdA = '';

  it('owner-a creates a connection profile to bind the key onto', requireDb(async () => {
    const r = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': 'owner-a' }, {
      name: 'DeepSeek BYO', provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    });
    expect(r.statusCode).toBe(201);
    connIdA = (JSON.parse(r.body) as { id: string }).id;
    expect(connIdA).toBeTruthy();
  }));

  it('POST key (write-only) → 200, secret_bound, app:// handle; raw key NEVER echoed', requireDb(async () => {
    masterKeyState = TEST_MASTER_KEY; // store ACTIVE
    const RAW = 'sk-proj-AAAA-the-actual-deepseek-key-do-not-leak-9999';
    const r = await request(baseUrl, 'POST', `/api/llm-connections/${connIdA}/key`, { 'x-dev-user': 'owner-a' }, {
      api_key: RAW,
    });
    expect(r.statusCode).toBe(200);
    const v = JSON.parse(r.body) as Record<string, unknown>;
    expect(v.secret_bound).toBe(true);
    expect(v.secret_handle_redacted).toBe('app://...');
    // THE no-egress assertion: the raw key is NOWHERE in the response.
    expect(r.body).not.toContain(RAW);
    expect(r.body).not.toContain('sk-proj-AAAA');
  }));

  it('the DB row stores ONLY ciphertext — the raw key never lands in app_secret', requireDb(async () => {
    const RAW = 'sk-proj-AAAA-the-actual-deepseek-key-do-not-leak-9999';
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query<{ ciphertext: Buffer; nonce: Buffer; key_version: number }>(
        `SELECT ciphertext, nonce, key_version FROM choros.app_secret WHERE tenant_id = $1`,
        [TENANT_A],
      );
      await c.query('COMMIT');
      expect(rows.length).toBe(1);
      // The stored ciphertext must NOT contain the raw key as a substring.
      expect(rows[0]!.ciphertext.toString('utf8')).not.toContain(RAW);
      expect(rows[0]!.ciphertext.toString('latin1')).not.toContain('sk-proj');
      expect(rows[0]!.nonce.length).toBe(12);
      expect(rows[0]!.key_version).toBe(1);
    });
  }));

  it('GET key/status returns secret_bound + redacted scheme — never the key', requireDb(async () => {
    const r = await request(baseUrl, 'GET', `/api/llm-connections/${connIdA}/key/status`, { 'x-dev-user': 'owner-a' });
    expect(r.statusCode).toBe(200);
    const v = JSON.parse(r.body) as Record<string, unknown>;
    expect(v.secret_bound).toBe(true);
    expect(v.secret_handle_redacted).toBe('app://...');
    expect(v.scheme).toBe('app');
    expect(r.body).not.toContain('sk-proj');
  }));

  it('the stored secret DECRYPTS back to the original (resolveSecret path)', requireDb(async () => {
    const RAW = 'sk-proj-AAAA-the-actual-deepseek-key-do-not-leak-9999';
    const key = loadMasterKey(TEST_MASTER_KEY);
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query('SET LOCAL search_path TO choros');
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.app_secret WHERE tenant_id = $1`, [TENANT_A]);
      const sealed = await getAppSecretSealed(
        c as unknown as PgClientLike, TENANT_A, rows[0]!.id);
      await c.query('COMMIT');
      expect(sealed).not.toBeNull();
      const recovered = decryptSecret(
        { ciphertext: sealed!.ciphertext, nonce: sealed!.nonce, keyVersion: sealed!.keyVersion },
        key,
      );
      expect(recovered).toBe(RAW);
    });
  }));

  it('RLS TENANT ISOLATION: tenant B cannot read A’s app_secret (choros_app GUC)', requireDb(async () => {
    // Get A's secret id (as migrator), then attempt to read it under B's GUC.
    let secretIdA = '';
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.app_secret WHERE tenant_id = $1`, [TENANT_A]);
      await c.query('COMMIT');
      secretIdA = rows[0]!.id;
    });
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT id FROM choros.app_secret WHERE id = $1`, [secretIdA]);
      await c.query('COMMIT');
      expect(rows.length, 'RLS must hide A’s app_secret from B’s session').toBe(0);
    } finally {
      c.release();
    }
  }));

  it('RLS: getAppSecretSealed under tenant B returns null for A’s secret', requireDb(async () => {
    let secretIdA = '';
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.app_secret WHERE tenant_id = $1`, [TENANT_A]);
      await c.query('COMMIT');
      secretIdA = rows[0]!.id;
    });
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      await c.query('SET LOCAL search_path TO choros');
      const sealed = await getAppSecretSealed(c as unknown as PgClientLike, TENANT_B, secretIdA);
      await c.query('COMMIT');
      expect(sealed, 'B must not resolve A’s sealed secret').toBeNull();
    });
  }));

  it('DORMANT: with master key UNSET, POST key → 503 and stores NO plaintext', requireDb(async () => {
    masterKeyState = undefined; // store DORMANT
    // Fresh connection in tenant B so we can count its app_secret rows cleanly.
    const cr = await request(baseUrl, 'POST', '/api/llm-connections', { 'x-dev-user': 'owner-b' }, {
      name: 'B conn', provider: 'openai',
    });
    expect(cr.statusCode).toBe(201);
    const connIdB = (JSON.parse(cr.body) as { id: string }).id;

    const r = await request(baseUrl, 'POST', `/api/llm-connections/${connIdB}/key`, { 'x-dev-user': 'owner-b' }, {
      api_key: 'sk-proj-BBBB-should-never-be-stored',
    });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('sk-proj-BBBB'); // honest error, no plaintext echo

    // No app_secret row for tenant B was created (no plaintext stored, no crash).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM choros.app_secret WHERE tenant_id = $1`, [TENANT_B]);
      await c.query('COMMIT');
      expect(Number(rows[0]!.n)).toBe(0);
    });
    masterKeyState = TEST_MASTER_KEY; // restore for any later tests
  }));

  it('non-owner (no grant) cannot bind a key (403)', requireDb(async () => {
    // owner-b is not owner of tenant A, and has no llm_connection:configure there.
    // But the route resolves tenant from the actor — owner-b resolves to TENANT_B,
    // so target A's connection id is not in B's tenant → 404 (RLS) OR 403 (authz).
    // To assert pure authz, use a member with no owner/grant against their own tenant.
    // Here we assert owner-b CANNOT touch A's connection: tenant mismatch → not 200.
    const r = await request(baseUrl, 'POST', `/api/llm-connections/${connIdA}/key`, { 'x-dev-user': 'owner-b' }, {
      api_key: 'sk-proj-CCCC',
    });
    expect([403, 404]).toContain(r.statusCode);
    expect(r.body).not.toContain('sk-proj-CCCC');
  }));
});
