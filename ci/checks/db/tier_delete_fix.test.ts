// T-0185 · tier_delete_fix — regression test for 050_tier_delete_fix.sql
//
// Covers the bug where tier_published_locked BEFORE DELETE returned NEW (NULL),
// silently suppressing ALL deletes on config tier-bearing tables.
//
// Probes:
//   DEL-1  — DELETE draft row succeeds (rowCount = 1)
//   DEL-2  — DELETE published row raises (published-locked exception)
//   DEL-3  — DELETE published row with promoting GUC succeeds (rowCount = 1)
//   DEL-4  — UPDATE on published row still raises (regression guard for 049 semantics)

import { describe, it, expect, afterEach } from 'vitest';
import { appUrl, withClient, uuid, TENANT_A } from './_helpers.js';

const TENANT = TENANT_A;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a draft application and return its id. */
async function insertDraftApp(url: string): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, tier, created_at, updated_at)
       VALUES ($1, $2, $3, 'Delete Test App', 'draft', 0, 0)`,
      [TENANT, id, `del-app-${id.slice(0, 8)}`],
    );
    await c.query('COMMIT');
  });
  return id;
}

/** Promote an existing application row to published (uses promoting GUC). */
async function promoteApp(url: string, id: string): Promise<void> {
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query("SET LOCAL choros.promoting = '1'");
    await c.query(
      `UPDATE choros.application SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
      [TENANT, id],
    );
    await c.query('COMMIT');
  });
}

/** Return the row count for a given application id (0 means deleted). */
async function countApp(url: string, id: string): Promise<number> {
  let cnt = 0;
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const res = await c.query(
      `SELECT count(*) AS n FROM choros.application WHERE tenant_id = $1 AND id = $2`,
      [TENANT, id],
    );
    await c.query('COMMIT');
    cnt = Number(res.rows[0].n);
  });
  return cnt;
}

// ---------------------------------------------------------------------------
// Cleanup — remove any del-app-* rows left by DEL-2/DEL-4 (published rows
// require the promoting GUC to be deleted, per 049/050 trigger semantics).
// ---------------------------------------------------------------------------

afterEach(async () => {
  await withClient(appUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query("SET LOCAL choros.promoting = '1'");
    await c.query(
      `DELETE FROM choros.application WHERE tenant_id = $1 AND slug LIKE 'del-app-%'`,
      [TENANT],
    );
    await c.query('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-0185 DEL-1: DELETE draft application removes the row (rowCount = 1)', () => {
  it('deletes a draft row and confirms absence', async () => {
    const id = await insertDraftApp(appUrl());

    let rowCount = 0;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const res = await c.query(
        `DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      rowCount = res.rowCount ?? 0;
      await c.query('COMMIT');
    });

    expect(rowCount, 'DELETE draft must delete exactly 1 row').toBe(1);
    expect(await countApp(appUrl(), id), 'row must be absent after DELETE').toBe(0);
  });
});

describe('T-0185 DEL-1 (idempotency): re-run DELETE draft confirmation', () => {
  it('second pass: DELETE draft row succeeds (idempotency of fix)', async () => {
    const id = await insertDraftApp(appUrl());

    let rowCount = 0;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const res = await c.query(
        `DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      rowCount = res.rowCount ?? 0;
      await c.query('COMMIT');
    });

    expect(rowCount).toBe(1);
    expect(await countApp(appUrl(), id)).toBe(0);
  });
});

describe('T-0185 DEL-2: DELETE published application raises published-locked exception', () => {
  it('direct DELETE on published row is rejected by trigger', async () => {
    const id = await insertDraftApp(appUrl());
    await promoteApp(appUrl(), id);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        ),
      ).rejects.toThrow(/published rows are managed\/locked/);
      await c.query('ROLLBACK');
    });

    // Row must still exist after the rejected DELETE
    expect(await countApp(appUrl(), id), 'published row must survive rejected DELETE').toBe(1);
  });
});

describe('T-0185 DEL-3: DELETE published with promoting GUC succeeds', () => {
  it('sanctioned promoting transaction can delete a published row', async () => {
    const id = await insertDraftApp(appUrl());
    await promoteApp(appUrl(), id);

    let rowCount = 0;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      const res = await c.query(
        `DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      rowCount = res.rowCount ?? 0;
      await c.query('COMMIT');
    });

    expect(rowCount, 'promoting DELETE must delete exactly 1 row').toBe(1);
    expect(await countApp(appUrl(), id), 'row must be absent after promoting DELETE').toBe(0);
  });
});

describe('T-0185 DEL-4: UPDATE on published row still raises (049 semantics regression guard)', () => {
  it('direct UPDATE on published application still raises', async () => {
    const id = await insertDraftApp(appUrl());
    await promoteApp(appUrl(), id);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `UPDATE choros.application SET display_name = 'hacked' WHERE tenant_id = $1 AND id = $2`,
          [TENANT, id],
        ),
      ).rejects.toThrow(/published rows are managed\/locked/);
      await c.query('ROLLBACK');
    });
  });
});
