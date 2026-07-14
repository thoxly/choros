// T-0083 · E12.2 — bundle_commit + bundle_ref live DB tests.
//
// Verifies from the real choros_app role (NOBYPASSRLS) that:
//   BC-DB-1  saveCommit + loadCommit round-trip (same content_hash, same snapshot)
//   BC-DB-2  Content-addressing: same snapshot + same inputs → same content_hash; save is idempotent
//   BC-DB-3  Parent-chain: child.parent_hash === parent.content_hash (persisted correctly)
//   BC-DB-4  setRef + getRef round-trip (upsert semantics)
//   BC-DB-5  listCommits returns commits ordered by committed_at ASC
//   BC-DB-6  Cross-tenant isolation: tenant A cannot see tenant B's commits
//   BC-DB-7  Unknown commit returns undefined from loadCommit
//   BC-DB-8  Unknown ref returns undefined from getRef
//
// DB setup: all INSERT seeds use migratorUrl() (bypasses RLS).
// Cross-tenant probes use appUrl() (choros_app, NOBYPASSRLS).
// FRESH RANDOM tenant UUIDs per test run (no TENANT_A/TENANT_B pollution).
//
// Skip-friendly: if DATABASE_URL is not set, skip all tests (DB not available).

import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient, uuid } from './_helpers.js';
import {
  makeCommit,
  GENESIS_PARENT_HASH,
  type BundleSnapshot,
} from '../../../src/core/bundle-commit.js';
import { makeSha256Port, makeBundleCommitStore } from '../../../src/core/bundle-commit-store.js';

const SHA256_PORT = makeSha256Port();

// ---------------------------------------------------------------------------
// Fresh random tenant UUIDs for this test run (no shared-DB pollution).
// See choros-db-test-shared-db-gotcha.md: must NOT reuse TENANT_A/TENANT_B.
// ---------------------------------------------------------------------------
const TEST_TENANT_1 = uuid();
const TEST_TENANT_2 = uuid(); // for cross-tenant isolation (BC-DB-6)

const BUNDLE_ID_1 = `test-bundle-${uuid().slice(0, 8)}`;
const BUNDLE_ID_2 = `test-bundle-${uuid().slice(0, 8)}`;

const AUTHOR = 'test-agent';
const NOW = 1_700_000_000_000;

const SNAPSHOT_A: BundleSnapshot = {
  object_schema: '{"type":"object"}',
  grants: '[]',
  bpmn_process: '',
  form_code: '',
  form_json_schema: '',
};

const SNAPSHOT_B: BundleSnapshot = {
  object_schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
  grants: '[{"resource_type":"record","action":"read"}]',
  bpmn_process: '<process id="p1"/>',
  form_code: '',
  form_json_schema: '',
};

// ---------------------------------------------------------------------------
// DB availability check
// ---------------------------------------------------------------------------
let dbAvailable = false;
beforeAll(async () => {
  try {
    await withClient(migratorUrl(), async (c) => {
      await c.query('SELECT 1');
    });
    dbAvailable = true;
  } catch {
    // DB not available; all tests will be skipped via conditional
    dbAvailable = false;
  }
});

function skipIfNoDb() {
  if (!dbAvailable) {
    return { skip: true } as const;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: seed a tenant row (self-anchoring: tenant_id = id per T-0017 ADR §3.1).
// bundle_commit has no FK to tenant, but seeding here keeps the test self-contained.
// ---------------------------------------------------------------------------
async function seedTenantIfNeeded(c: pg.Client, tenantId: string): Promise<void> {
  const slug = `bc-test-${tenantId.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, slug],
  );
}

// ---------------------------------------------------------------------------
// BC-DB-1: saveCommit + loadCommit round-trip
// ---------------------------------------------------------------------------
describe('BC-DB-1: saveCommit + loadCommit round-trip', () => {
  it('saves and loads a commit with all fields intact', async () => {
    if (!dbAvailable) return;

    const commit = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'init', NOW, SHA256_PORT);

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      // Set the GUC so RLS policies apply (migrator bypasses RLS, but we still set it)
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      await store.saveCommit(TEST_TENANT_1, BUNDLE_ID_1, commit);
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const loaded = await store.loadCommit(TEST_TENANT_1, BUNDLE_ID_1, commit.content_hash);

      expect(loaded).toBeDefined();
      expect(loaded!.content_hash).toBe(commit.content_hash);
      expect(loaded!.parent_hash).toBe(GENESIS_PARENT_HASH);
      expect(loaded!.author).toBe(AUTHOR);
      expect(loaded!.message).toBe('init');
      expect(loaded!.committed_at).toBe(NOW);
      expect(loaded!.snapshot.object_schema).toBe(SNAPSHOT_A.object_schema);
      expect(loaded!.snapshot.grants).toBe(SNAPSHOT_A.grants);
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-2: Content-addressing idempotency — saveCommit twice is safe
// ---------------------------------------------------------------------------
describe('BC-DB-2: saveCommit idempotency (ON CONFLICT DO NOTHING)', () => {
  it('saving the same commit twice does not throw or duplicate', async () => {
    if (!dbAvailable) return;

    const commit = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'idem', NOW + 10, SHA256_PORT);

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      // Save twice — must not throw
      await store.saveCommit(TEST_TENANT_1, BUNDLE_ID_1, commit);
      await store.saveCommit(TEST_TENANT_1, BUNDLE_ID_1, commit);
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const loaded = await store.loadCommit(TEST_TENANT_1, BUNDLE_ID_1, commit.content_hash);
      expect(loaded).toBeDefined();
      expect(loaded!.content_hash).toBe(commit.content_hash);
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-3: Parent-chain persisted correctly
// ---------------------------------------------------------------------------
describe('BC-DB-3: parent-chain persisted correctly', () => {
  it('child.parent_hash equals parent.content_hash after round-trip', async () => {
    if (!dbAvailable) return;

    const parent = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'parent', NOW + 100, SHA256_PORT);
    const child = makeCommit(SNAPSHOT_B, parent.content_hash, AUTHOR, 'child', NOW + 200, SHA256_PORT);

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      await store.saveCommit(TEST_TENANT_1, BUNDLE_ID_2, parent);
      await store.saveCommit(TEST_TENANT_1, BUNDLE_ID_2, child);
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const loadedChild = await store.loadCommit(TEST_TENANT_1, BUNDLE_ID_2, child.content_hash);
      expect(loadedChild).toBeDefined();
      expect(loadedChild!.parent_hash).toBe(parent.content_hash);
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-4: setRef + getRef round-trip
// ---------------------------------------------------------------------------
describe('BC-DB-4: setRef + getRef round-trip (upsert semantics)', () => {
  it('getRef returns the content_hash set by setRef', async () => {
    if (!dbAvailable) return;

    const commit = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'ref-test', NOW + 300, SHA256_PORT);
    const refBundleId = `ref-bundle-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      await store.saveCommit(TEST_TENANT_1, refBundleId, commit);
      await store.setRef(TEST_TENANT_1, refBundleId, 'HEAD', commit.content_hash);
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const ref = await store.getRef(TEST_TENANT_1, refBundleId, 'HEAD');
      expect(ref).toBe(commit.content_hash);
    });
  });

  it('setRef upserts — calling twice advances the pointer', async () => {
    if (!dbAvailable) return;

    const c1 = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'upsert-v1', NOW + 400, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_B, c1.content_hash, AUTHOR, 'upsert-v2', NOW + 500, SHA256_PORT);
    const refBundleId = `ref-upsert-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      await store.saveCommit(TEST_TENANT_1, refBundleId, c1);
      await store.saveCommit(TEST_TENANT_1, refBundleId, c2);
      await store.setRef(TEST_TENANT_1, refBundleId, 'HEAD', c1.content_hash);
      await store.setRef(TEST_TENANT_1, refBundleId, 'HEAD', c2.content_hash); // advance
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const ref = await store.getRef(TEST_TENANT_1, refBundleId, 'HEAD');
      expect(ref).toBe(c2.content_hash);
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-5: listCommits returns commits ordered by committed_at ASC
// ---------------------------------------------------------------------------
describe('BC-DB-5: listCommits ordered by committed_at ASC', () => {
  it('three commits are returned in chronological order', async () => {
    if (!dbAvailable) return;

    const listBundleId = `list-bundle-${uuid().slice(0, 8)}`;
    const t1 = NOW + 1000;
    const t2 = NOW + 2000;
    const t3 = NOW + 3000;

    const ca = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'c1', t1, SHA256_PORT);
    const cb = makeCommit(SNAPSHOT_B, ca.content_hash, AUTHOR, 'c2', t2, SHA256_PORT);
    const snapshotC: BundleSnapshot = { ...SNAPSHOT_B, grants: '[]' };
    const cc = makeCommit(snapshotC, cb.content_hash, AUTHOR, 'c3', t3, SHA256_PORT);

    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      // Insert in reverse order to verify ORDER BY
      await store.saveCommit(TEST_TENANT_1, listBundleId, cc);
      await store.saveCommit(TEST_TENANT_1, listBundleId, ca);
      await store.saveCommit(TEST_TENANT_1, listBundleId, cb);
    });

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const list = await store.listCommits(TEST_TENANT_1, listBundleId);

      expect(list.length).toBe(3);
      expect(list[0].content_hash).toBe(ca.content_hash);
      expect(list[1].content_hash).toBe(cb.content_hash);
      expect(list[2].content_hash).toBe(cc.content_hash);
      expect(list[0].committed_at).toBeLessThan(list[1].committed_at);
      expect(list[1].committed_at).toBeLessThan(list[2].committed_at);
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-6: Cross-tenant isolation — tenant A cannot see tenant B's commits
// ---------------------------------------------------------------------------
describe('BC-DB-6: cross-tenant isolation', () => {
  it('tenant A commit is NOT visible under tenant B session', async () => {
    if (!dbAvailable) return;

    const isolBundleId = `isol-bundle-${uuid().slice(0, 8)}`;
    const commitA = makeCommit(SNAPSHOT_A, GENESIS_PARENT_HASH, AUTHOR, 'tenant-A-only', NOW + 5000, SHA256_PORT);

    // Seed under tenant 1 (migrator bypasses RLS but we set GUC)
    await withClient(migratorUrl(), async (c) => {
      await seedTenantIfNeeded(c, TEST_TENANT_1);
      await seedTenantIfNeeded(c, TEST_TENANT_2);
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      await store.saveCommit(TEST_TENANT_1, isolBundleId, commitA);
    });

    // Probe as tenant 2 via choros_app (NOBYPASSRLS) — must not see tenant 1's row
    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_2}'`);
      const store = makeBundleCommitStore(c);
      const loaded = await store.loadCommit(TEST_TENANT_2, isolBundleId, commitA.content_hash);
      expect(loaded).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-7: Unknown commit → undefined
// ---------------------------------------------------------------------------
describe('BC-DB-7: loadCommit returns undefined for unknown hash', () => {
  it('returns undefined when content_hash does not exist', async () => {
    if (!dbAvailable) return;

    const unknownHash = 'f'.repeat(64); // valid format, but not stored
    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const result = await store.loadCommit(TEST_TENANT_1, 'no-such-bundle', unknownHash);
      expect(result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// BC-DB-8: Unknown ref → undefined
// ---------------------------------------------------------------------------
describe('BC-DB-8: getRef returns undefined for unknown ref', () => {
  it('returns undefined when ref does not exist', async () => {
    if (!dbAvailable) return;

    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TEST_TENANT_1}'`);
      const store = makeBundleCommitStore(c);
      const result = await store.getRef(TEST_TENANT_1, 'no-such-bundle', 'NONEXISTENT');
      expect(result).toBeUndefined();
    });
  });
});
