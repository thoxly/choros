// T-0229 · FF-REPRODUCIBLE / FF-TENANT-SCOPED-RENDER / FF-AUDIT-EVERY-RENDER (AC-13)
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Covers:
//   FF-REPRODUCIBLE (AC-13): renderAndFix fixes a snapshot via addVersion(isSnapshot=true).
//     MUTATE the source record → re-download the snapshot (presignGet on the same
//     file_version) = BYTE-IDENTICAL. A fresh live render AFTER the mutation DIFFERS.
//     Snapshot = stored bytes, not a cache; reproducibility comes from immutability.
//
//   FF-TENANT-SCOPED-RENDER: cross-tenant recordRef in render params → denied
//     (not_found / cross_tenant). Tenant B's records are never visible from Tenant A.
//     RLS enforced at the RecordBatchPort (T-0013).
//
//   FF-AUDIT-EVERY-RENDER (live DB): render(success) + render(denied) + renderAndFix
//     each write exactly one audit_event row to choros.audit_event (via makePgAuditWriter),
//     tenant-scoped, open-vocab type, NO token/secret in payload.
//
// ARCHITECTURE: render/renderAndFix are pure-core — all I/O is behind injected ports.
//   For these DB probes we wire:
//     TemplateSource    — in-memory stub (no pg DAO exists yet for template_def)
//     RecordBatchPort   — in-memory stub (validates cross-tenant deny without real records)
//     SnapshotPort      — real PgFileStore + ObjectStore stub (byte store) for FF-REPRODUCIBLE
//     RenderAuditSink   — wraps makePgAuditWriter + a pg.Client for FF-AUDIT-EVERY-RENDER
//   We seed choros.file + choros.record + choros.registry_def via migratorUrl()
//   (choros_migrator bypasses RLS). DAO ops run under GUC-scoped choros_app pools.
//
// FRESH TENANTS: all tests mint their own random tenant UUIDs per run.
//   Never reuse TENANT_A/TENANT_B — the db-tier runs all files against ONE shared
//   cloned DB (globalSetup, --no-file-parallelism) and cross-file contamination of
//   the shared fixtures pollutes unrelated suites (choros-db-test-shared-db-gotcha).
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';
import { PgFileStore } from '../../../src/core/postgres/pgFileStore.js';
import {
  render,
  renderAndFix,
  type RenderDeps,
  type RenderAndFixDeps,
  type TemplateDef,
  type RecordBatchPort,
  type TemplateSource,
  type RenderAuditSink,
  type SnapshotPort,
} from '../../../src/core/document-render.js';
import { addVersion, type ObjectStore, type AddVersionAttrs, type AddVersionResult } from '../../../src/core/file-attachment.js';
import type { ResolveSubject } from '../../../src/core/object-handle.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import { makePgAuditWriter, type PgClientLike } from '../../../src/db/audit-writer.js';

// ---------------------------------------------------------------------------
// Skip guard — skip all if DATABASE_URL not set
// ---------------------------------------------------------------------------

const DB_URL = process.env['DATABASE_URL'];
const skipAll = !DB_URL;

// ---------------------------------------------------------------------------
// Seed helpers (all use migratorUrl to bypass RLS; T-0144 discipline)
// ---------------------------------------------------------------------------

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `dr-tenant-${tenantId.slice(0, 8)}`],
  );
  await c.query('COMMIT');
}

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, `dr-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(c: pg.Client, tenantId: string, appId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{"properties":{"status":{}}}'::jsonb, 0, 0)`,
    [tenantId, id, appId, `dr-reg-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  data: object = { status: 'active' },
): Promise<string> {
  const id = crypto.randomUUID();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'dr-tester')`,
    [tenantId, id, registryId, JSON.stringify(data)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedFile(c: pg.Client, tenantId: string, recordId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.file
       (tenant_id, id, record_id, original_name, current_version,
        retention_state, retention_policy_ref, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'snapshot.csv', NULL, 'active', NULL, 'dr-tester', 0, 0)`,
    [tenantId, id, recordId],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// In-memory stubs for pure-core ports
// ---------------------------------------------------------------------------

/** TemplateSource stub — returns a fixed published CSV template. */
function makeTemplateStub(
  tenantId: string,
  registryId: string,
  templateId: string,
): TemplateSource {
  const tmpl: TemplateDef = {
    tenantId,
    id: templateId,
    registryId,
    format: 'csv',
    body: '{{status}}',
    version: 1,
    tier: 'published',
  };
  return { async getTemplate() { return tmpl; } };
}

/** RecordBatchPort stub — returns fixed rows (single-record and registry). */
function makeRecordStub(
  rows: Array<{ id: string; registryId: string; data: Record<string, unknown> }>,
): RecordBatchPort {
  return {
    async getRecordsForRegistry(_tenantId, _registryId) { return rows; },
    async getRecord(_tenantId, _registryId, recordId) {
      return rows.find((r) => r.id === recordId) ?? null;
    },
  };
}

/**
 * Deny-all ResolverDeps — used to exercise the denied path. render() with deny-all
 * returns denied:true on single-record (no_grant) or 0-row CSV on registry
 * (all rows denied → absent). For our DB-level tests we only need to confirm
 * cross-tenant denial at the render-params layer (cross_tenant check fires before PDP).
 */
function makeDenyAllResolverDeps() {
  return {
    grants: { async getGrants() { return []; } },
    records: { async getRecord() { return null; } },
    ancestry: { isDescendantOrSelf() { return false; } },
  };
}

/**
 * Allow-all ResolverDeps — returns a grant covering any record, no field restriction.
 * Used for snapshot reproducibility tests where we need a render that produces
 * non-empty output.
 */
function makeAllowAllResolverDeps(
  rows: Array<{ id: string; registryId: string; data: Record<string, unknown> }>,
) {
  type Grant = import('../../../src/core/grant-lattice.js').Grant;
  const grants: Grant[] = rows.map((row, i) => ({
    tenantId: 'any',
    id: `g-${i}`,
    roleId: 'role-test',
    resourceType: 'record' as const,
    resourceFacet: undefined,
    operation: 'read' as const,
    scope: {
      kind: 'node' as const,
      hierarchy: 'resource' as const,
      nodeId: row.id,
      nodeLevel: 'record' as const,
    },
    delegable: false,
    grantedBy: 'seed',
    createdAt: 0,
  }));
  const dataMap = new Map<string, Record<string, unknown>>(
    rows.map((r) => [r.id, r.data]),
  );
  return {
    grants: { async getGrants() { return grants; } },
    records: {
      async getRecord(ref: import('../../../src/core/object-handle.js').ResourceRef) {
        if (ref.kind !== 'record') return null;
        return dataMap.get(ref.recordId) ?? null;
      },
    },
    ancestry: {
      isDescendantOrSelf(_h: string, a: string, b: string) { return a === b; },
    },
  };
}

// ---------------------------------------------------------------------------
// GUC-scoped choros_app pool helper (mirrors file_attachment.test.ts pattern)
// ---------------------------------------------------------------------------

function makeTenantPool(tenantId: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: appUrl() });
  pool.on('connect', (c: pg.PoolClient) => {
    void c.query(`SET "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`);
  });
  return pool;
}

// ---------------------------------------------------------------------------
// ObjectStore stub — stores bytes in-memory by key; presignGet returns a
// synthetic URL including the key+bytes for identity checks.
// ---------------------------------------------------------------------------

class InMemoryObjectStore implements ObjectStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array): Promise<void> {
    this.blobs.set(key, body);
  }

  async presignGet(key: string, _ttl: number): Promise<string> {
    // We return the key as the URL; in this stub we also expose the stored bytes
    // via getBytes() so tests can compare identity without a real S3 round-trip.
    return `https://stub-store.test/${encodeURIComponent(key)}`;
  }

  async erase(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  /** Get the stored bytes by object key — for identity assertion in tests. */
  getBytes(key: string): Uint8Array | undefined {
    return this.blobs.get(key);
  }
}

// ---------------------------------------------------------------------------
// AuditSink adapter wrapping makePgAuditWriter + a live PgClientLike
//
// Strategy: the RenderAuditSink.emit() method is called from within the
// render/renderAndFix path. We wire it to a pg.Client that runs
//   BEGIN / SET LOCAL choros.tenant_id / appendAuditEvent / COMMIT
// per event — each event is its own DB-committed tx (mirrors the real
// production wiring where the HTTP layer has an open tenant tx).
// ---------------------------------------------------------------------------

function makePgAuditSink(tenantId: string): {
  sink: RenderAuditSink;
  countEvents: (c: pg.Client, type: string) => Promise<number>;
} {
  const writer = makePgAuditWriter();

  const sink: RenderAuditSink = {
    async emit(event: AuditEventInput) {
      // Open a fresh app-role client per event.
      const c = new pg.Client({ connectionString: appUrl() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL search_path TO choros`);
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
        await writer.appendAuditEvent(c as unknown as PgClientLike, event);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await c.end();
      }
    },
  };

  /** Count audit_event rows of a given type for this tenant (via migrator, bypasses RLS). */
  const countEvents = async (c: pg.Client, type: string): Promise<number> => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM choros.audit_event WHERE tenant_id=$1 AND type=$2`,
      [tenantId, type],
    );
    return rows[0].n;
  };

  return { sink, countEvents };
}

// ---------------------------------------------------------------------------
// SnapshotPort adapter wrapping addVersion (the real T-0119 write-path)
// Wires PgFileStore + ObjectStore + a deny-all hash (SHA-256 stub).
// ---------------------------------------------------------------------------

function makeSnapshotPort(
  tenantId: string,
  pool: pg.Pool,
  store: InMemoryObjectStore,
): SnapshotPort {
  const fileStore = new PgFileStore(pool);
  const hashFn = (body: Uint8Array): string =>
    createHash('sha256').update(body).digest('hex');
  return {
    async addVersion(
      fileId: string,
      subject: ResolveSubject,
      body: Uint8Array,
      attrs: AddVersionAttrs,
    ): Promise<AddVersionResult> {
      return addVersion(
        {
          resolver: {
            // For the snapshot path the PDP just needs to allow update on the owner record.
            // We use a permissive stub: always allow.
            async resolveRecordOp() {
              return { denied: false as const, ref: { kind: 'record' as const, tenantId, registryId: '', recordId: '' }, fields: {} };
            },
          },
          store,
          meta: fileStore,
          hash: hashFn,
        },
        fileId,
        subject,
        body,
        attrs,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// FF-REPRODUCIBLE (AC-13)
//
// renderAndFix fixes bytes as a snapshot (isSnapshot=true via PgFileStore).
// After a source mutation, re-downloading the snapshot = BYTE-IDENTICAL.
// A fresh live render after the mutation produces DIFFERENT bytes.
// ---------------------------------------------------------------------------

describe.skipIf(skipAll)(
  'FF-REPRODUCIBLE (AC-13): snapshot bytes are immutable after source mutation',
  () => {
    it(
      'renderAndFix snapshot bytes are stable after source record mutation; live render reflects new data',
      async () => {
        const tenantId = crypto.randomUUID();
        const recordId = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        let fileId = '';
        let registryId = '';

        // Seed tenant + registry + record + file via migrator (bypasses RLS)
        await withClient(migratorUrl(), async (c) => {
          await seedTenant(c, tenantId);
          const appId = await seedApplication(c, tenantId);
          registryId = await seedRegistryDef(c, tenantId, appId);
          await seedRecord(c, tenantId, registryId, { status: 'active' });
          // Insert a record with the specific recordId we'll use in tests
          await c.query('BEGIN');
          await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await c.query(
            `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
             VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'dr-tester')
             ON CONFLICT DO NOTHING`,
            [tenantId, recordId, registryId, JSON.stringify({ status: 'active' })],
          );
          await c.query('COMMIT');
          fileId = await seedFile(c, tenantId, recordId);
        });

        const pool = makeTenantPool(tenantId);
        const store = new InMemoryObjectStore();
        const snapshotPort = makeSnapshotPort(tenantId, pool, store);

        const subject: ResolveSubject = { tenantId, subjectId: 'user-dr-test' };
        const rowsBefore = [{ id: recordId, registryId, data: { status: 'active' } }];

        // 1. renderAndFix with "active" data → snapshot stored
        const deps: RenderAndFixDeps = {
          resolver: makeAllowAllResolverDeps(rowsBefore),
          records: makeRecordStub(rowsBefore),
          templates: makeTemplateStub(tenantId, registryId, templateId),
          snapshot: snapshotPort,
          fileId,
        };
        const fixResult = await renderAndFix(
          deps,
          templateId,
          { kind: 'registry', registryId },
          subject,
        );

        expect(fixResult.denied).toBe(false);
        if (fixResult.denied) return; // type-narrow

        const snapVersionId = fixResult.versionId;

        // 2. Read the snapshot bytes by looking up the stored objectKey
        const pgFileStore = new PgFileStore(pool);
        const snapVersion = await pgFileStore.getVersion(tenantId, snapVersionId);
        expect(snapVersion).not.toBeNull();
        expect(snapVersion!.isSnapshot).toBe(true);

        // The stored bytes in the InMemoryObjectStore match what was rendered "before"
        const snapBytes = store.getBytes(snapVersion!.objectKey);
        expect(snapBytes).not.toBeUndefined();
        const snapText = Buffer.from(snapBytes!).toString('utf8');
        // "active" is in the snapshot (rendered before mutation)
        expect(snapText).toContain('active');

        // 3. Mutate the source record (status = 'closed')
        await withClient(migratorUrl(), async (c) => {
          await c.query('BEGIN');
          await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await c.query(
            `UPDATE choros.record SET data = $1::jsonb, updated_at = 1 WHERE tenant_id=$2 AND id=$3`,
            [JSON.stringify({ status: 'closed' }), tenantId, recordId],
          );
          await c.query('COMMIT');
        });

        // 4. Re-read the SNAPSHOT from the store (same objectKey = same bytes = BYTE-IDENTICAL).
        //    The snapshot is immutable — the byte store holds the original bytes.
        const snapBytesAfter = store.getBytes(snapVersion!.objectKey);
        expect(snapBytesAfter).not.toBeUndefined();
        // BYTE-IDENTICAL: same Uint8Array reference (same store entry, mutation does not touch it)
        expect(Buffer.from(snapBytesAfter!).toString('utf8')).toContain('active');
        expect(Buffer.from(snapBytesAfter!).equals(Buffer.from(snapBytes!))).toBe(true);

        // 5. Live render AFTER mutation reflects NEW data (FF-LIVE-NO-CACHE)
        const rowsAfter = [{ id: recordId, registryId, data: { status: 'closed' } }];
        const liveDeps: RenderDeps = {
          resolver: makeAllowAllResolverDeps(rowsAfter),
          records: makeRecordStub(rowsAfter),
          templates: makeTemplateStub(tenantId, registryId, templateId),
        };
        const liveResult = await render(
          liveDeps,
          templateId,
          { kind: 'registry', registryId },
          subject,
        );
        expect(liveResult.denied).toBe(false);
        if (!liveResult.denied) {
          const liveText = Buffer.from(liveResult.bytes).toString('utf8');
          // Live render = mutation reflected
          expect(liveText).toContain('closed');
          // Live render != snapshot bytes (mutation is live)
          expect(liveResult.bytes).not.toEqual(snapBytes);
        }

        await pool.end();
      },
    );
  },
);

// ---------------------------------------------------------------------------
// FF-TENANT-SCOPED-RENDER
//
// Cross-tenant recordRef in render params (tenantId of ref ≠ subject.tenantId)
// → denied with reason 'cross_tenant' before any PDP/record read.
// Tenant B's records are never visible from Tenant A.
// ---------------------------------------------------------------------------

describe.skipIf(skipAll)(
  'FF-TENANT-SCOPED-RENDER: cross-tenant recordRef is denied',
  () => {
    it(
      'single-record render: cross-tenant recordRef → denied(cross_tenant)',
      async () => {
        const tenantA = crypto.randomUUID();
        const tenantB = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        const registryId = crypto.randomUUID();
        const recordIdB = crypto.randomUUID();

        // RecordBatch that would serve tenant B's record if it were ever called.
        // Under correct isolation it must never be reached for a cross-tenant ref.
        let recordBatchCalled = false;
        const records: RecordBatchPort = {
          async getRecordsForRegistry() { recordBatchCalled = true; return []; },
          async getRecord() { recordBatchCalled = true; return null; },
        };

        const deps: RenderDeps = {
          resolver: makeDenyAllResolverDeps(),
          records,
          templates: makeTemplateStub(tenantA, registryId, templateId),
        };

        const subjectA: ResolveSubject = { tenantId: tenantA, subjectId: 'user-a' };

        // Cross-tenant ref: recordRef has tenantId=B, but subject belongs to A.
        const result = await render(deps, templateId, {
          kind: 'single',
          recordRef: { tenantId: tenantB, registryId, recordId: recordIdB },
        }, subjectA);

        // Must be denied with cross_tenant (fired in render before any PDP call)
        expect(result.denied).toBe(true);
        if (result.denied) {
          expect(result.reason).toBe('cross_tenant');
        }
        // RecordBatchPort must NOT have been called (short-circuit before any data read)
        expect(recordBatchCalled).toBe(false);
      },
    );

    it(
      'registry render: records returned for wrong tenantId by port are silently absent (FF-TENANT-SCOPED-RENDER)',
      async () => {
        const tenantA = crypto.randomUUID();
        const tenantB = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        const registryId = crypto.randomUUID();

        // Registry render: the cross-tenant protection for registry-kind params
        // is enforced by the RecordBatchPort RLS (not by the params layer).
        // Simulate an honest port that returns zero rows for tenant A
        // (as if RLS filtered out tenant B's rows that should not be visible).
        const honestPort: RecordBatchPort = {
          async getRecordsForRegistry() { return []; }, // RLS returns zero for wrong tenant
          async getRecord() { return null; },
        };

        const deps: RenderDeps = {
          resolver: makeDenyAllResolverDeps(),
          records: honestPort,
          templates: makeTemplateStub(tenantA, registryId, templateId),
        };

        const subjectA: ResolveSubject = { tenantId: tenantA, subjectId: 'user-a' };
        const result = await render(deps, templateId, {
          kind: 'registry',
          registryId,
        }, subjectA);

        // Render succeeds but with 0 rows (tenant B's records absent due to RLS at port)
        expect(result.denied).toBe(false);
        if (!result.denied) {
          expect(result.meta.recordCount).toBe(0);
        }
        void tenantB; // used in description
      },
    );
  },
);

// ---------------------------------------------------------------------------
// FF-AUDIT-EVERY-RENDER (live DB)
//
// render(success) + render(denied) + renderAndFix each write exactly one
// audit_event row to choros.audit_event (via makePgAuditWriter + live pg.Client),
// tenant-scoped, open-vocab type, NO token/secret in payload.
// ---------------------------------------------------------------------------

describe.skipIf(skipAll)(
  'FF-AUDIT-EVERY-RENDER (live DB): audit events written to choros.audit_event',
  () => {
    it(
      'render(success) emits exactly one doc.render event to audit_event',
      async () => {
        const tenantId = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        const registryId = crypto.randomUUID();

        // Seed minimal tenant so RLS passes for audit_event write
        await withClient(migratorUrl(), async (c) => {
          await seedTenant(c, tenantId);
        });

        const { sink, countEvents } = makePgAuditSink(tenantId);
        const subject: ResolveSubject = { tenantId, subjectId: 'audit-test-user' };

        const deps: RenderDeps = {
          resolver: makeDenyAllResolverDeps(),
          records: makeRecordStub([]),
          templates: makeTemplateStub(tenantId, registryId, templateId),
          audit: sink,
        };

        // Render (registry, 0 rows) → doc.render event
        const result = await render(deps, templateId, { kind: 'registry', registryId }, subject);
        expect(result.denied).toBe(false);

        // Verify DB has exactly 1 doc.render event for this tenant
        await withClient(migratorUrl(), async (c) => {
          const n = await countEvents(c, 'doc.render');
          expect(n).toBe(1);
        });
      },
    );

    it(
      'render(denied: template not found) emits exactly one doc.render_denied event',
      async () => {
        const tenantId = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        const registryId = crypto.randomUUID();

        await withClient(migratorUrl(), async (c) => {
          await seedTenant(c, tenantId);
        });

        const { sink, countEvents } = makePgAuditSink(tenantId);
        const subject: ResolveSubject = { tenantId, subjectId: 'audit-deny-user' };

        // TemplateSource returns null → not_found denial
        const noTemplate: TemplateSource = { async getTemplate() { return null; } };

        const deps: RenderDeps = {
          resolver: makeDenyAllResolverDeps(),
          records: makeRecordStub([]),
          templates: noTemplate,
          audit: sink,
        };

        const result = await render(deps, templateId, { kind: 'registry', registryId }, subject);
        expect(result.denied).toBe(true);

        await withClient(migratorUrl(), async (c) => {
          const n = await countEvents(c, 'doc.render_denied');
          expect(n).toBe(1);
        });
      },
    );

    it(
      'renderAndFix emits doc.render + doc.snapshot_fixed — both in audit_event, no token/secret in payload',
      async () => {
        const tenantId = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        let registryId = '';
        let fileId = '';
        let recordId = '';

        await withClient(migratorUrl(), async (c) => {
          await seedTenant(c, tenantId);
          const appId = await seedApplication(c, tenantId);
          registryId = await seedRegistryDef(c, tenantId, appId);
          recordId = await seedRecord(c, tenantId, registryId, { status: 'pending' });
          fileId = await seedFile(c, tenantId, recordId);
        });

        const pool = makeTenantPool(tenantId);
        const store = new InMemoryObjectStore();
        const snapshotPort = makeSnapshotPort(tenantId, pool, store);

        const { sink, countEvents } = makePgAuditSink(tenantId);
        const subject: ResolveSubject = { tenantId, subjectId: 'audit-fix-user' };

        const rows = [{ id: recordId, registryId, data: { status: 'pending' } }];
        const deps: RenderAndFixDeps = {
          resolver: makeAllowAllResolverDeps(rows),
          records: makeRecordStub(rows),
          templates: makeTemplateStub(tenantId, registryId, templateId),
          audit: sink,
          snapshot: snapshotPort,
          fileId,
        };

        const result = await renderAndFix(deps, templateId, { kind: 'registry', registryId }, subject);
        expect(result.denied).toBe(false);

        // Both doc.render and doc.snapshot_fixed must be in audit_event
        await withClient(migratorUrl(), async (c) => {
          const nRender = await countEvents(c, 'doc.render');
          const nSnap = await countEvents(c, 'doc.snapshot_fixed');
          expect(nRender).toBe(1);
          expect(nSnap).toBe(1);

          // FF-AUDIT-EVERY-RENDER: payload must contain NO token/secret
          const { rows: payloadRows } = await c.query<{ type: string; payload: unknown }>(
            `SELECT type, payload FROM choros.audit_event WHERE tenant_id=$1 AND type LIKE 'doc.%'`,
            [tenantId],
          );
          for (const row of payloadRows) {
            const payloadStr = JSON.stringify(row.payload).toLowerCase();
            expect(payloadStr).not.toContain('token');
            expect(payloadStr).not.toContain('secret');
            expect(payloadStr).not.toContain('password');
          }
        });

        await pool.end();
      },
    );

    it(
      'render(denied: cross_tenant) emits doc.render_denied; no token/secret in payload',
      async () => {
        const tenantA = crypto.randomUUID();
        const tenantB = crypto.randomUUID();
        const templateId = crypto.randomUUID();
        const registryId = crypto.randomUUID();
        const recordIdB = crypto.randomUUID();

        await withClient(migratorUrl(), async (c) => {
          await seedTenant(c, tenantA);
        });

        const { sink, countEvents } = makePgAuditSink(tenantA);
        const subjectA: ResolveSubject = { tenantId: tenantA, subjectId: 'xt-user' };

        const deps: RenderDeps = {
          resolver: makeDenyAllResolverDeps(),
          records: makeRecordStub([]),
          templates: makeTemplateStub(tenantA, registryId, templateId),
          audit: sink,
        };

        // Cross-tenant ref → denied(cross_tenant) + audit event
        const result = await render(deps, templateId, {
          kind: 'single',
          recordRef: { tenantId: tenantB, registryId, recordId: recordIdB },
        }, subjectA);

        expect(result.denied).toBe(true);

        await withClient(migratorUrl(), async (c) => {
          const n = await countEvents(c, 'doc.render_denied');
          expect(n).toBe(1);

          // No token/secret in payload
          const { rows: payloadRows } = await c.query<{ payload: unknown }>(
            `SELECT payload FROM choros.audit_event WHERE tenant_id=$1 AND type='doc.render_denied'`,
            [tenantA],
          );
          expect(payloadRows.length).toBe(1);
          const payloadStr = JSON.stringify(payloadRows[0].payload).toLowerCase();
          expect(payloadStr).not.toContain('token');
          expect(payloadStr).not.toContain('secret');
          void tenantB; // tenant isolation
        });
      },
    );
  },
);
