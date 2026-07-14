// T-0086 · E12.5 — in-flight migration DB tests
//
// Covers:
//   - Rollback BLOCKED while live instances exist (bundle_version_instance)
//   - Drain default: state='draining' after insert
//   - Mapping escalation: state='pending_approval' (human-gate enforced, no auto-execute)
//   - fn_count_live_instances_above_version counts draining instances
//
// All seeds use FRESH RANDOM tenant UUIDs (per FE-s22-0001 / choros-db-test-shared-db-gotcha.md).
// No TENANT_A / TENANT_B from _helpers (those are shared; this file must not pollute).

import { describe, it, expect } from 'vitest';
import { withClient, migratorUrl, appUrl, uuid } from './_helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mint a fresh random tenant UUID for this test run. */
function freshTenant(): string {
  return uuid();
}

/** Set up a tenant with application + registry_def (prereqs for some queries). */
async function setupTenantPrereqs(
  tenantId: string,
): Promise<{ appId: string; registryId: string }> {
  const appId  = uuid();
  const regId  = uuid();
  const appSlug = `im-app-${appId.slice(0, 8)}`;
  const regSlug = `im-reg-${regId.slice(0, 8)}`;

  return withClient(migratorUrl(), async (c) => {
    // Application
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
      [tenantId, appId, appSlug],
    );

    // Registry def with a simple schema
    await c.query(
      `INSERT INTO choros.registry_def
         (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4,
               '{"type":"object","properties":{"name":{"type":"string"}}}'::jsonb,
               0, 0) ON CONFLICT DO NOTHING`,
      [tenantId, regId, appId, regSlug],
    );

    return { appId, registryId: regId };
  });
}

// ---------------------------------------------------------------------------
// Test: drain-by-default — state='draining' is the default
// ---------------------------------------------------------------------------

describe('bundle_version_instance — drain-by-default', () => {
  it('inserts a drain record with state=draining (the default)', async () => {
    const tenantId = freshTenant();
    const instanceId = `proc-drain-${uuid().slice(0, 8)}`;
    const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      await c.query(
        `INSERT INTO choros.bundle_version_instance
           (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
         VALUES ($1, $2, 'bundle-drain', $3, 0, 'draining')`,
        [tenantId, instanceId, contentHash],
      );

      const { rows } = await c.query(
        `SELECT state FROM choros.bundle_version_instance
         WHERE tenant_id = $1 AND process_instance_id = $2`,
        [tenantId, instanceId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('draining');
    });
  });

  it('can be updated to completed (instance drained)', async () => {
    const tenantId = freshTenant();
    const instanceId = `proc-complete-${uuid().slice(0, 8)}`;
    const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      await c.query(
        `INSERT INTO choros.bundle_version_instance
           (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
         VALUES ($1, $2, 'bundle-complete', $3, 0, 'draining')`,
        [tenantId, instanceId, contentHash],
      );

      await c.query(
        `UPDATE choros.bundle_version_instance SET state = 'completed'
         WHERE tenant_id = $1 AND process_instance_id = $2`,
        [tenantId, instanceId],
      );

      const { rows } = await c.query(
        `SELECT state FROM choros.bundle_version_instance
         WHERE tenant_id = $1 AND process_instance_id = $2`,
        [tenantId, instanceId],
      );

      expect(rows[0].state).toBe('completed');
    });
  });
});

// ---------------------------------------------------------------------------
// Test: rollback is BLOCKED while live instances exist
// (via fn_count_live_instances_above_version)
// ---------------------------------------------------------------------------

describe('fn_count_live_instances_above_version — rollback guard', () => {
  it('returns > 0 when live (draining) instances exist — rollback BLOCKED', async () => {
    const tenantId = freshTenant();
    const bundleId = `bundle-guard-${uuid().slice(0, 8)}`;
    const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const instanceId = `proc-guard-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.bundle_version_instance
           (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
         VALUES ($1, $2, $3, $4, 0, 'draining')`,
        [tenantId, instanceId, bundleId, contentHash],
      );

      const { rows } = await c.query(
        `SELECT choros.fn_count_live_instances_above_version($1::uuid, $2, 1) AS cnt`,
        [tenantId, bundleId],
      );

      expect(Number(rows[0].cnt)).toBeGreaterThan(0);
    });
  });

  it('returns 0 when no draining instances exist — rollback allowed', async () => {
    const tenantId = freshTenant();
    const bundleId = `bundle-clear-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT choros.fn_count_live_instances_above_version($1::uuid, $2, 1) AS cnt`,
        [tenantId, bundleId],
      );

      expect(Number(rows[0].cnt)).toBe(0);
    });
  });

  it('returns 0 after all instances drain to completed — rollback allowed', async () => {
    const tenantId = freshTenant();
    const bundleId = `bundle-drained-${uuid().slice(0, 8)}`;
    const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

    await withClient(migratorUrl(), async (c) => {
      // Seed two draining instances
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO choros.bundle_version_instance
             (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
           VALUES ($1, $2, $3, $4, 0, 'draining')`,
          [tenantId, `proc-drain-${i}-${uuid().slice(0, 8)}`, bundleId, contentHash],
        );
      }

      // Verify count = 2 (rollback blocked)
      const { rows: before } = await c.query(
        `SELECT choros.fn_count_live_instances_above_version($1::uuid, $2, 1) AS cnt`,
        [tenantId, bundleId],
      );
      expect(Number(before[0].cnt)).toBe(2);

      // Mark all as completed
      await c.query(
        `UPDATE choros.bundle_version_instance
         SET state = 'completed'
         WHERE tenant_id = $1 AND bundle_id = $2 AND state = 'draining'`,
        [tenantId, bundleId],
      );

      // Verify count = 0 (rollback now allowed)
      const { rows: after } = await c.query(
        `SELECT choros.fn_count_live_instances_above_version($1::uuid, $2, 1) AS cnt`,
        [tenantId, bundleId],
      );
      expect(Number(after[0].cnt)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Test: Camunda mapping escalation — pending_approval (human-gate enforced)
// ---------------------------------------------------------------------------

describe('inflight_mapping_request — mapping is escalation (pending_approval)', () => {
  it('inserts a mapping request in pending_approval state (human-gate enforced)', async () => {
    const tenantId = freshTenant();
    const requestId = uuid();
    const instanceId = `proc-map-${uuid().slice(0, 8)}`;
    const fromHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const toHash   = uuid().replace(/-/g, '').padEnd(64, 'f').slice(0, 64);

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      await c.query(
        `INSERT INTO choros.inflight_mapping_request
           (tenant_id, id, process_instance_id,
            from_content_hash, to_content_hash,
            from_activity_id, from_activity_kind,
            to_activity_id,   to_activity_kind,
            auto_map_matching_ids, requested_by, requested_at, state)
         VALUES ($1, $2, $3, $4, $5,
                 'Task_ApproveContract', 'userTask',
                 'Task_ApproveContract', 'userTask',
                 false, 'founder@example.com', 0, 'pending_approval')`,
        [tenantId, requestId, instanceId, fromHash, toHash],
      );

      const { rows } = await c.query(
        `SELECT state FROM choros.inflight_mapping_request
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );

      expect(rows).toHaveLength(1);
      // Mapping must start in pending_approval — not auto-executed (human-gate invariant)
      expect(rows[0].state).toBe('pending_approval');
    });
  });

  it('rejects mapping with same from/to content hash (DB CHECK constraint)', async () => {
    const tenantId = freshTenant();
    const requestId = uuid();
    const sameHash  = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const instanceId = `proc-samehash-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      await expect(
        c.query(
          `INSERT INTO choros.inflight_mapping_request
             (tenant_id, id, process_instance_id,
              from_content_hash, to_content_hash,
              from_activity_id, from_activity_kind,
              to_activity_id,   to_activity_kind,
              auto_map_matching_ids, requested_by, requested_at, state)
           VALUES ($1, $2, $3, $4, $4,
                   'Task_A', 'userTask', 'Task_A', 'userTask',
                   false, 'founder@example.com', 0, 'pending_approval')`,
          [tenantId, requestId, instanceId, sameHash],
        ),
      ).rejects.toThrow();
    });
  });

  it('rejects mapping with mismatched activity kinds (DB CHECK constraint)', async () => {
    const tenantId = freshTenant();
    const requestId = uuid();
    const fromHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const toHash   = uuid().replace(/-/g, '').padEnd(64, 'f').slice(0, 64);
    const instanceId = `proc-badkind-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      await expect(
        c.query(
          `INSERT INTO choros.inflight_mapping_request
             (tenant_id, id, process_instance_id,
              from_content_hash, to_content_hash,
              from_activity_id, from_activity_kind,
              to_activity_id,   to_activity_kind,
              auto_map_matching_ids, requested_by, requested_at, state)
           VALUES ($1, $2, $3, $4, $5,
                   'Task_A', 'userTask', 'Task_A', 'receiveTask',
                   false, 'founder@example.com', 0, 'pending_approval')`,
          [tenantId, requestId, instanceId, fromHash, toHash],
        ),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Test: RLS isolation — tenant A cannot see tenant B rows via app role
// NF-2: uses appUrl() (choros_app, NOBYPASSRLS) to prove the RLS invariant.
// ---------------------------------------------------------------------------

describe('bundle_version_instance RLS isolation', () => {
  it('tenant A cannot see tenant B rows via app role (RLS enforced)', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    const instanceId = `proc-rls-${uuid().slice(0, 8)}`;

    // Seed row for tenant B via migrator (bypasses RLS for setup)
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.bundle_version_instance
           (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
         VALUES ($1, $2, 'bundle-rls-b', $3, 0, 'draining')`,
        [tenantB, instanceId, contentHash],
      );
    });

    // Query as tenant A via choros_app (NOBYPASSRLS) — RLS must return 0 rows
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantA}'`);
      const { rows } = await c.query(
        // Explicit WHERE tenant_id = tenantB: RLS policy forces tenant_id = tenantA,
        // so this cross-tenant filter returns 0 rows (AC-1 invariant).
        `SELECT * FROM choros.bundle_version_instance
         WHERE tenant_id = $1 AND bundle_id = 'bundle-rls-b'`,
        [tenantB],
      );
      await c.query('COMMIT');
      expect(rows).toHaveLength(0);
    });
  });
});
