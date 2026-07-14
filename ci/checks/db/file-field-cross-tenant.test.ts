// T-0579 (AC-13 gap-fill) — file-field VALUE cross-tenant poisoning is inert.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// A file-typed field's VALUE (fileVersionId string) is an opaque string in
// record.data — same as a relation field's uuid — and the record write-path
// (updateRecord/createRecord → assertDataValid) validates SHAPE only (AJV:
// type:'string'), never cross-tenant EXISTENCE of the referenced file_version.
// This mirrors the established relation-field precedent (no FK from JSONB
// content to another tenant's row is checked at write time either — see
// records_crud.test.ts, which has no such check for relation values).
//
// The actual security boundary is downstream, at read/download time
// (GET /api/files/:fileVersionId/download → getFileContentUrl → PgFileStore.
// getVersion(actorTenantId, fileVersionId)), already covered at the unit level
// by src/__tests__/files-http.test.ts (AC-download-3/AC-12/AC-13 — a fake
// store keyed purely on tenant). This file proves the FULL chain end-to-end
// against LIVE Postgres: a tenant-A record is allowed to carry tenant-B's
// fileVersionId as a plain string value (POST/PUT succeed — no second
// permission system invented at write time, per NF-2), but that value is
// completely INERT — PgFileStore.getVersion under tenant A's context sees
// nothing (RLS + the explicit tenant_id predicate both agree), so no
// cross-tenant content is ever reachable through it.
//
// NOTE (FF-T147-2): this is a NEW file, not a modification of an existing
// ci/checks/db/*.test.ts — db-isolation-no-test-change.sh forbids touching
// existing db test files (T-0147 AC-4); the sanctioned path for new coverage
// is a new file (established precedent: T-0191's schema_change_api_ac7b.test.ts).
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import { PgFileStore } from '../../../src/core/postgres/pgFileStore.js';

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

// A record schema with a file-shaped field (type:string — the same wire shape
// a real x-file field emits per AC-2; the validator only cares about shape).
const FILE_FIELD_SCHEMA = {
  type: 'object',
  properties: {
    doc: { type: 'string', title: 'Файл' },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Seed helpers — direct INSERT under the migrator role (bypass RLS).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplicationDirect(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDefDirect(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
  recordSchema: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, JSON.stringify(recordSchema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecordDirect(c: pg.Client, tenantId: string, registryId: string, data: object): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify(data)],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server + fixtures
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

let TENANT_A: string;
let TENANT_B: string;
let appAId = '';
let regFileFieldId = ''; // tenant A, registry_def with a file-shaped field
let regBId = ''; // tenant B, plain registry_def (owner of the poisoned file)

const recordCleanup: Array<{ tenantId: string; id: string }> = [];
const regDefCleanup: Array<{ tenantId: string; id: string }> = [];
const appCleanup: Array<{ tenantId: string; id: string }> = [];

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;

  TENANT_A = uuid();
  TENANT_B = uuid();

  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerRecordRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
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
    await seedTenantRow(c, TENANT_A);
    await seedTenantRow(c, TENANT_B);

    appAId = await seedApplicationDirect(c, TENANT_A, `ff-app-a-${uuid().slice(0, 8)}`);
    regFileFieldId = await seedRegistryDefDirect(
      c,
      TENANT_A,
      appAId,
      `ff-reg-file-${uuid().slice(0, 8)}`,
      FILE_FIELD_SCHEMA,
    );

    const appBId = await seedApplicationDirect(c, TENANT_B, `ff-app-b-${uuid().slice(0, 8)}`);
    regBId = await seedRegistryDefDirect(c, TENANT_B, appBId, `ff-reg-b-${uuid().slice(0, 8)}`, FILE_FIELD_SCHEMA);
    appCleanup.push({ tenantId: TENANT_B, id: appBId });
  });

  regDefCleanup.push({ tenantId: TENANT_A, id: regFileFieldId });
  regDefCleanup.push({ tenantId: TENANT_B, id: regBId });
  appCleanup.push({ tenantId: TENANT_A, id: appAId });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const { tenantId, id } of [...recordCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.record WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...regDefCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...appCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`SET LOCAL choros.promoting = '1'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('T-0579: file-field value cross-tenant poisoning is inert', () => {
  it(
    "PUT record (tenant A) with data.doc = tenant B's fileVersionId succeeds (opaque string, shape-only validation), but that fileVersionId resolves to NOTHING under tenant A (PgFileStore.getVersion — the exact lookup the download route performs)",
    requireDb(async () => {
      // 1. Seed a REAL file + file_version row that lives entirely in TENANT_B,
      //    owned by a TENANT_B record (composite tenant-leading FK, migration 058).
      let bOwnerRecordId = '';
      let bFileId = '';
      let bVersionId = '';
      await withClient(migratorUrl(), async (c) => {
        bOwnerRecordId = await seedRecordDirect(c, TENANT_B, regBId, { doc: '' });

        bFileId = uuid();
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
        await c.query(
          `INSERT INTO choros.file
             (tenant_id, id, record_id, original_name, current_version, retention_state, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, 'active', 'seed', 0, 0)`,
          [TENANT_B, bFileId, bOwnerRecordId, 'tenant-b-secret.pdf'],
        );

        bVersionId = uuid();
        await c.query(
          `INSERT INTO choros.file_version
             (tenant_id, id, file_id, version_no, object_key, mime_type, size_bytes, content_hash, uploaded_by, uploaded_at)
           VALUES ($1, $2, $3, 1, $4, 'application/pdf', 123, 'deadbeef', 'seed', 0)`,
          [TENANT_B, bVersionId, bFileId, `${TENANT_B}/${bFileId}/${bVersionId}`],
        );

        await c.query(`UPDATE choros.file SET current_version = $1 WHERE tenant_id = $2 AND id = $3`, [
          bVersionId,
          TENANT_B,
          bFileId,
        ]);
        await c.query('COMMIT');
      });
      recordCleanup.push({ tenantId: TENANT_B, id: bOwnerRecordId });

      // 2. Actor A creates a record under the file-shaped schema with a
      //    harmless placeholder, then PUTs tenant B's real fileVersionId into
      //    it. Per NF-2 (no second permission system), this write is NOT
      //    expected to be rejected — the value is opaque at this layer,
      //    exactly like a relation field's uuid (records_crud.test.ts has no
      //    write-time existence check for relation values either).
      const created = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: appAId, registry_def_id: regFileFieldId, data: { doc: 'placeholder' } },
        { 'x-dev-user': 'actor-a' },
      );
      expect(created.statusCode).toBe(201);
      const aRecordId = (JSON.parse(created.body) as { id: string }).id;
      recordCleanup.push({ tenantId: TENANT_A, id: aRecordId });

      const updated = await makeRequest(
        baseUrl,
        'PUT',
        `/api/records/${aRecordId}`,
        { data: { doc: bVersionId } },
        { 'x-dev-user': 'actor-a' },
      );
      expect(updated.statusCode).toBe(200);
      expect((JSON.parse(updated.body) as { data: { doc: string } }).data.doc).toBe(bVersionId);

      // 3. Prove the value is INERT: PgFileStore.getVersion — the EXACT
      //    lookup src/http/files.ts performs on
      //    GET /api/files/:fileVersionId/download, keyed on the actor's OWN
      //    tenant (never the value's origin tenant) — returns null for
      //    TENANT_A even though the row physically exists (in TENANT_B).
      //
      //    Production wires PgFileStore with `grantsPool` — a BYPASSRLS
      //    (choros_migrator-class) connection sourced straight from
      //    DATABASE_URL (src/server.ts) — because PgFileStore.getVersion
      //    issues raw `pool.query` with NO `SET LOCAL choros.tenant_id` /
      //    transaction wrapper; its `WHERE tenant_id = $1` predicate IS the
      //    tenant boundary for that call (RLS is not in play for a BYPASSRLS
      //    role). Mirror that exact wiring here.
      const migratorPool = new pg.Pool({ connectionString: migratorUrl() });
      try {
        const fileStore = new PgFileStore(migratorPool);
        const seenFromTenantA = await fileStore.getVersion(TENANT_A, bVersionId);
        expect(seenFromTenantA).toBeNull();

        // Sanity: the row IS visible from its true owner tenant (proves the
        // seed worked and getVersion is not simply broken/always-null).
        const seenFromTenantB = await fileStore.getVersion(TENANT_B, bVersionId);
        expect(seenFromTenantB).not.toBeNull();
      } finally {
        await migratorPool.end();
      }

      // Cleanup the B-side file/file_version rows (child of record; delete
      // before the shared afterAll's record cleanup runs).
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
        await c.query(`DELETE FROM choros.file_version WHERE tenant_id = $1 AND id = $2`, [TENANT_B, bVersionId]);
        await c.query(`DELETE FROM choros.file WHERE tenant_id = $1 AND id = $2`, [TENANT_B, bFileId]);
        await c.query('COMMIT');
      });
    }),
  );
});
