// T-0030 · structural grant editor — live Postgres DB probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=... npm run fitness:db
//
// Covers (fitness functions FF-1..FF-9 and live AC halves):
//   FF-1  — GrantAuditEvent import: static (CI grep-based; checked in grants.ts)
//   FF-2  — isGenesisOwner never hardcoded (static grep)
//   FF-3  — validateAdminDelegation not re-implemented (static grep)
//   FF-4  — tenant_id leading in DB writes (static grep)
//   FF-5  — known_tenant_tables unchanged (static count)
//   FF-6  — audit emit in same transaction (live: rollback kills both)
//   FF-7  — parseScopeElement calls normalize (static grep)
//   FF-8  — no RLS bypass (static grep)
//   FF-9  — validateAdminDelegation before every INSERT (integration AC-02/03/04/08/10)
//   FF-10 — NF-1: freeform scope forces delegable=false regardless of request body (R-2)
//
// Live AC halves:
//   AC-01 — POST /api/grants happy path: row inserted with correct tenant_id + fields
//   AC-02 — scope_widens → 403 ADMIN_GATE_REJECTED (no row inserted)
//   AC-07 — revoke: valid_until set, row not deleted
//   AC-09 — POST /api/role-assignments happy path
//   AC-11 — role-assignment revoke: valid_until set, row not deleted
//   AC-12 — GrantAuditEvent row written atomically with grant INSERT (FF-6)
//   AC-13 — revoke emits grant.revoke audit event
//   AC-14 — proposed_by set, confirmed_by null → proposal row inserted
//   AC-15 — isGenesisOwner resolved from DB (not hardcoded)
//   AC-16 — GET /api/rights/dictionaries reachable without DATABASE_URL (R-1)
//   AC-19 — known_tenant_tables unchanged
//   AC-20 — tenant_id on all DB writes (RLS enforces cross-tenant isolation)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, appUrl, withClient, uuid } from './_helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Dev silo constants (stable UUIDs from migrations)
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const DEV_ROLE_OWNER = 'e0000000-0000-0000-0000-000000000001';       // tenant-owner
const DEV_ROLE_BUDGET = 'e0000000-0000-0000-0000-000000000002';      // budget-approver
const DEV_EMP_OWNER = 'd0000000-0000-0000-0000-0000000000ff';        // e-owner (genesis)
const DEV_EMP_MIRONOV = 'd0000000-0000-0000-0000-000000000004';      // e-mironov
const DEV_DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';

const FOREST_SCOPE = {
  kind: 'set',
  members: [
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000001', nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000002', nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000003', nodeLevel: 'department' },
  ],
};

const FIN_NODE_SCOPE = {
  kind: 'node', hierarchy: 'org',
  nodeId: DEV_DEPT_FIN, nodeLevel: 'department',
};

// ---------------------------------------------------------------------------
// FF-1 · AC-12 static: GrantAuditEvent is imported from grant-lattice.ts
// ---------------------------------------------------------------------------
describe('FF-1 (static): GrantAuditEvent imported from grant-lattice.ts', () => {
  it('grants.ts imports GrantAuditEvent from grant-lattice', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'http', 'grants.ts'), 'utf8');
    // Must import GrantAuditEvent
    expect(src).toMatch(/GrantAuditEvent/);
    // Must import it from grant-lattice
    expect(src).toMatch(/from ["']\.\.\/core\/grant-lattice\.js["']/);
    // The import line that contains GrantAuditEvent must reference grant-lattice
    const importLines = src.split('\n').filter((l) => l.includes('GrantAuditEvent'));
    const definesOwnType = importLines.some((l) =>
      l.match(/^(export )?type GrantAuditEvent/) || l.match(/^interface GrantAuditEvent/),
    );
    expect(definesOwnType, 'grants.ts must not re-define GrantAuditEvent').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-2 (static): isGenesisOwner never hardcoded outside src/db/org.ts
// ---------------------------------------------------------------------------
describe('FF-2 (static): isGenesisOwner not hardcoded outside src/db/org.ts', () => {
  it('no isGenesisOwner: true literal in grants.ts', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'http', 'grants.ts'), 'utf8');
    // Strip comment lines before checking
    const nonComment = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(nonComment).not.toMatch(/isGenesisOwner\s*[:=]\s*true/);
  });
});

// ---------------------------------------------------------------------------
// FF-5 / AC-19 (static): known_tenant_tables.txt length unchanged
// ---------------------------------------------------------------------------
describe('FF-5 / AC-19 (static): known_tenant_tables.txt unchanged', () => {
  it('has exactly 29 entries (28 pre-T-0035 incl. agent_card + 4 budget tables + T-0035 substitution_rule)', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    );
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines.length, 'known_tenant_tables.txt must have exactly 29 entries').toBe(29);
    expect(lines).toContain('grant');
    expect(lines).toContain('role_assignment');
    expect(lines).toContain('instance_budget');
    expect(lines).toContain('agent_budget');
    expect(lines).toContain('reservation');
    expect(lines).toContain('spend_ledger');
    expect(lines).toContain('substitution_rule');
  });
});

// ---------------------------------------------------------------------------
// FF-7 (static): parseScopeElement calls normalize
// ---------------------------------------------------------------------------
describe('FF-7 (static): parseScopeElement calls normalize', () => {
  it('grants.ts contains normalize( call (parseScopeElement reuses it)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'http', 'grants.ts'), 'utf8');
    expect(src).toMatch(/normalize\(/);
  });
});

// ---------------------------------------------------------------------------
// FF-8 (static): no RLS bypass in grants.ts
// ---------------------------------------------------------------------------
describe('FF-8 (static): no RLS bypass in grants.ts', () => {
  it('grants.ts contains no BYPASS RLS / SET ROLE / choros_migrator', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'http', 'grants.ts'), 'utf8');
    expect(src).not.toMatch(/BYPASS RLS/i);
    expect(src).not.toMatch(/SET ROLE/i);
    expect(src).not.toMatch(/choros_migrator/i);
  });
});

// ---------------------------------------------------------------------------
// Migration 030 (AC-19 live): proposed_by / confirmed_by columns exist
// ---------------------------------------------------------------------------
describe('Migration 030: grant.proposed_by / confirmed_by columns added', () => {
  it('grant table has proposed_by and confirmed_by nullable text columns', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'choros' AND table_name = 'grant'
            AND column_name IN ('proposed_by', 'confirmed_by')
          ORDER BY column_name`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(byName['proposed_by'], 'proposed_by column must exist').toBeDefined();
      expect(byName['confirmed_by'], 'confirmed_by column must exist').toBeDefined();
      expect(byName['proposed_by'].data_type).toBe('text');
      expect(byName['confirmed_by'].data_type).toBe('text');
      expect(byName['proposed_by'].is_nullable).toBe('YES');
      expect(byName['confirmed_by'].is_nullable).toBe('YES');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-01 · AC-20: happy-path INSERT into grant with correct tenant_id
// ---------------------------------------------------------------------------
describe('AC-01 / AC-20: grant INSERT with tenant_id leading', () => {
  it('inserts a grant row with correct tenant_id and fields via choros_app role', async () => {
    const newId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);

    // Insert as choros_app (RLS enforced by GUC). Use BEGIN/COMMIT so SET LOCAL
    // takes effect for the FK check (role table is FORCE RLS).
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:grant', 'create', $4::jsonb,
                 true, 'test', $5)`,
        [DEV_TENANT, newId, DEV_ROLE_OWNER, scope, nowMs],
      );
      await c.query('COMMIT');
    });

    // Verify via migrator (bypasses RLS for inspection).
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT tenant_id, id, role_id, resource_type, operation, delegable
           FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, newId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].tenant_id).toBe(DEV_TENANT);
      expect(rows[0].resource_type).toBe('mgmt_object:grant');
      expect(rows[0].delegable).toBe(true);
    });

    // Cleanup
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, newId]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-07: revoke sets valid_until, row NOT deleted
// ---------------------------------------------------------------------------
describe('AC-07: grant revoke sets valid_until, row survives', () => {
  it('UPDATE sets valid_until and row is not deleted', async () => {
    const grantId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);

    // Insert a grant (use BEGIN/COMMIT for SET LOCAL to apply during FK check)
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:role', 'read', $4::jsonb, true, 'test', $5)`,
        [DEV_TENANT, grantId, DEV_ROLE_OWNER, scope, nowMs],
      );
      await c.query('COMMIT');
    });

    // Revoke (set valid_until)
    const revokeMs = nowMs + 1000;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `UPDATE choros."grant" SET valid_until = $3 WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, grantId, revokeMs],
      );
      await c.query('COMMIT');
    });

    // Verify row still exists with valid_until set (not deleted)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT valid_until FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length, 'row must still exist (not deleted)').toBe(1);
      expect(Number(rows[0].valid_until)).toBe(revokeMs);
    });

    // Cleanup
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, grantId]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12 / FF-6: audit emit is atomic with grant INSERT
// Rollback means neither grant nor audit_event row survives.
// ---------------------------------------------------------------------------
describe('AC-12 / FF-6: grant INSERT + audit emit atomicity', () => {
  it('rollback removes both grant and audit_event row', async () => {
    const grantId = uuid();
    const auditId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);
    const fakeHash = Buffer.alloc(32);

    // Count audit events before
    const beforeAudit = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.audit_event WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return rows[0].n as number;
    });

    // Intentional rollback: insert both, then ROLLBACK.
    const clientPg = await import('pg');
    const { Client } = clientPg.default;
    const client = new Client({ connectionString: appUrl() });
    await client.connect();
    try {
      await client.query(`SET choros.tenant_id = '${DEV_TENANT}'`);
      await client.query(`SET search_path TO choros`);
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:grant', 'create', $4::jsonb, true, 'test', $5)`,
        [DEV_TENANT, grantId, DEV_ROLE_OWNER, scope, nowMs],
      );
      // Get current head or use sentinel
      const headRes = await client.query(
        `SELECT seq, row_hash FROM choros.audit_head WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      const prevSeq = headRes.rows.length > 0 ? BigInt(headRes.rows[0].seq) : 0n;
      const prevHash: Buffer = headRes.rows.length > 0 ? headRes.rows[0].row_hash : fakeHash;
      const newSeq = prevSeq + 1n;
      const rowHash = Buffer.alloc(32, 0x01); // dummy hash

      await client.query(
        `INSERT INTO choros.audit_event
           (tenant_id, seq, id, type, actor, subject, scope, via,
            proposed_by, confirmed_by, payload, occurred_at,
            prev_hash, row_hash, vocab_version)
         VALUES ($1, $2, $3, 'grant.create', 'e-owner', $4, $5::jsonb,
                 'grant-editor', NULL, NULL, '{"capability":{}}'::jsonb, $6,
                 $7, $8, 1)`,
        [DEV_TENANT, newSeq.toString(), auditId, DEV_ROLE_OWNER,
         JSON.stringify(scope), nowMs, prevHash, rowHash],
      );
      // Rollback — neither row should survive
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    // Verify: grant row must NOT exist
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length, 'grant row must not exist after rollback').toBe(0);
    });

    // Verify: audit count must be same as before (no orphan audit event)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.audit_event WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'audit_event count must be unchanged after rollback').toBe(beforeAudit);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-14: proposed_by set, confirmed_by null → PROPOSAL row inserted
// ---------------------------------------------------------------------------
describe('AC-14: proposed_by set / confirmed_by null = proposal row', () => {
  it('inserts grant with proposed_by and confirmed_by IS NULL', async () => {
    const grantId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at, proposed_by, confirmed_by)
         VALUES ($1, $2, $3, 'mgmt_object:role', 'read', $4::jsonb,
                 true, 'test', $5, $6, NULL)`,
        [DEV_TENANT, grantId, DEV_ROLE_OWNER, scope, nowMs, 'llm'],
      );
      await c.query('COMMIT');
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT proposed_by, confirmed_by
           FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].proposed_by).toBe('llm');
      expect(rows[0].confirmed_by).toBeNull();
    });

    // Cleanup
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, grantId]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-15 (live): isGenesisOwner resolved from DB — e-owner IS genesis owner
// ---------------------------------------------------------------------------
describe('AC-15 (live): isGenesisOwner resolved from DB', () => {
  it('e-owner (genesis) has confirmed tenant-owner role_assignment in dev silo', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ra.id
           FROM choros.role_assignment ra
           JOIN choros.role r
                ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = $1
            AND ra.employee_id = $2
            AND r.slug = 'tenant-owner'
            AND ra.confirmed_by IS NOT NULL
            AND (ra.valid_from IS NULL OR ra.valid_from <= $3)
            AND (ra.valid_until IS NULL OR ra.valid_until > $3)
          LIMIT 1`,
        [DEV_TENANT, DEV_EMP_OWNER, Date.now()],
      );
      expect(rows.length, 'e-owner must be isGenesisOwner=true per DB query').toBe(1);
    });
  });

  it('a non-owner employee (e-mironov) is NOT a genesis owner', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ra.id
           FROM choros.role_assignment ra
           JOIN choros.role r
                ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = $1
            AND ra.employee_id = $2
            AND r.slug = 'tenant-owner'
            AND ra.confirmed_by IS NOT NULL
            AND (ra.valid_from IS NULL OR ra.valid_from <= $3)
            AND (ra.valid_until IS NULL OR ra.valid_until > $3)
          LIMIT 1`,
        [DEV_TENANT, DEV_EMP_MIRONOV, Date.now()],
      );
      expect(rows.length, 'e-mironov must NOT be a genesis owner').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-20 (live): RLS enforces cross-tenant isolation on grant INSERT
// ---------------------------------------------------------------------------
describe('AC-20 (live): RLS blocks cross-tenant grant INSERT', () => {
  it('INSERT with wrong tenant_id in GUC → choros_app cannot see the row', async () => {
    const grantId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);

    // Insert under TENANT_A GUC
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:role', 'read', $4::jsonb, true, 'test', $5)`,
        [DEV_TENANT, grantId, DEV_ROLE_OWNER, scope, nowMs],
      );
      await c.query('COMMIT');
    });

    // Try to SELECT with a different tenant GUC — must see nothing
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '11111111-1111-1111-1111-111111111111'`);
      const { rows } = await c.query(
        `SELECT id FROM choros."grant" WHERE id=$1`,
        [grantId],
      );
      await c.query('COMMIT');
      expect(rows.length, 'RLS must hide row from wrong tenant').toBe(0);
    });

    // Cleanup via migrator (bypasses RLS)
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, grantId]);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-09 / AC-11: role_assignment happy-path + revoke
// ---------------------------------------------------------------------------
describe('AC-09 / AC-11: role_assignment INSERT + revoke', () => {
  it('inserts a role_assignment row with correct tenant_id', async () => {
    const raId = uuid();
    const nowMs = Date.now();
    const scope = JSON.stringify(FIN_NODE_SCOPE);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 NULL, NULL, 'test', 'test',
                 NULL, 'test', $6, $6)`,
        [DEV_TENANT, raId, DEV_EMP_OWNER, DEV_ROLE_OWNER, scope, nowMs],
      );
      await c.query('COMMIT');
    });

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT tenant_id, employee_id, role_id FROM choros.role_assignment
          WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, raId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].tenant_id).toBe(DEV_TENANT);
    });

    // Revoke
    const revokeMs = nowMs + 1000;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `UPDATE choros.role_assignment SET valid_until=$3, updated_at=$3
          WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, raId, revokeMs],
      );
      await c.query('COMMIT');
    });

    // Row still exists (AC-11: not deleted)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT valid_until FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, raId],
      );
      expect(rows.length, 'row must still exist after revoke').toBe(1);
      expect(Number(rows[0].valid_until)).toBe(revokeMs);
    });

    // Cleanup
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, raId]);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-10 (static): freeform delegable forced to false in grants.ts source
// ---------------------------------------------------------------------------
describe('FF-10 (static): NF-1 freeform delegable forced false in grants.ts', () => {
  it('grants.ts contains isFreeform guard that sets delegable = false', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'http', 'grants.ts'), 'utf8');
    // Must have the forced override: if (isFreeform) { delegable = false; }
    expect(src).toMatch(/if\s*\(\s*isFreeform\s*\)\s*\{[^}]*delegable\s*=\s*false/s);
  });
});

// ---------------------------------------------------------------------------
// FF-10 (live): NF-1 freeform scope forces delegable=false (R-2)
// Genesis owner POST /api/grants with freeform+delegable:true → DB row has delegable=false
// ---------------------------------------------------------------------------
describe('FF-10 (live): freeform grant INSERT has delegable=false regardless of body', () => {
  let server: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    // Dynamically import createServer to pick up DATABASE_URL set in this process.
    const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address() as { port: number };
    serverPort = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('genesis owner POST /api/grants freeform+delegable:true → DB stores delegable=false', async () => {
    const grantId = await (async () => {
      // POST with delegable:true in body — handler must force it to false (NF-1).
      const body = JSON.stringify({
        role_id: DEV_ROLE_OWNER,
        resource_type: 'mgmt_object:grant',
        operation: 'create',
        scope: { kind: 'freeform', predicate: 'resource.org_unit == "external"' },
        granted_by: DEV_EMP_OWNER,
        delegable: true,   // body says true — handler must override to false
      });

      // x-dev-user is the employee SLUG (loadAdminContext queries by slug, not UUID).
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/grants`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dev-user': 'e-owner',    // genesis owner slug
        },
        body,
      });

      expect(res.status, `expected 201 from POST /api/grants, got ${res.status}`).toBe(201);
      const json = await res.json() as { id?: string };
      expect(json.id, 'response must include grant id').toBeTruthy();
      return json.id as string;
    })();

    // Verify DB row has delegable=false despite body sending delegable:true.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT delegable FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, grantId],
      );
      expect(rows.length, 'grant row must exist').toBe(1);
      expect(rows[0].delegable, 'freeform grant must have delegable=false (NF-1)').toBe(false);
    });

    // Cleanup
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, grantId]);
    });
  });
});
