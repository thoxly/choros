/**
 * ci/checks/db/inbox-sandbox-gate.test.ts — T-0558 live-DB fitness for the inbox
 * sandbox gate's load-bearing classification helper (draftOnlyProcessKeys).
 *
 * The inbox task-list projection (findInboxItems in src/http/inbox.ts) must NOT
 * surface, to a NON-privileged caller, tasks whose originating process_definition is
 * draft/unpublished. The decision is made by draftOnlyProcessKeys, which classifies a
 * set of process keys against process_definition.status, tenant-scoped under RLS:
 *
 *   - PUBLISHED key (a published row exists) → NOT draft-only → task stays visible.
 *   - DRAFT-ONLY key (a row exists but none is published) → draft-only → task hidden.
 *   - LEGACY key (NO process_definition row at all — directly-deployed engine process)
 *     → NOT draft-only → task stays visible (absence of a draft record ≠ draft).
 *
 * Reads go through a choros_app (NOBYPASSRLS) Pool — the exact production path — so
 * tenant isolation is exercised for real. Fresh per-run tenant UUIDs avoid shared-DB
 * pollution (memory: choros-ci-db-gotchas).
 *
 * Run: DATABASE_URL=<migrator-url> npm run fitness:db
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl, uuid } from "./_helpers.js";
import { draftOnlyProcessKeys } from "../../../src/http/inbox.js";

function freshTenant(): string {
  return crypto.randomUUID();
}

/** Seed a process_definition row with an explicit status (published | draft). */
async function seedProcessDef(
  tenantId: string,
  processKey: string,
  status: "draft" | "published",
  version = 1,
): Promise<void> {
  const c = new pg.Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    await c.query(
      `INSERT INTO choros.process_definition
         (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '<definitions/>', $5, $6, NULL, 0, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, uuid(), processKey, `Def ${processKey}`, version, status],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

describe("T-0558 — inbox sandbox gate: draftOnlyProcessKeys classification", () => {
  it("classifies published / draft-only / legacy keys correctly", async () => {
    const tenantId = freshTenant();
    const PUBLISHED = `proc-pub-${uuid().slice(0, 8)}`;
    const DRAFT_ONLY = `proc-draft-${uuid().slice(0, 8)}`;
    const LEGACY = `proc-legacy-${uuid().slice(0, 8)}`; // no process_definition row

    await seedProcessDef(tenantId, PUBLISHED, "published");
    await seedProcessDef(tenantId, DRAFT_ONLY, "draft");
    // LEGACY: intentionally NOT seeded.

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const draftOnly = await draftOnlyProcessKeys(pool, tenantId, [
        PUBLISHED,
        DRAFT_ONLY,
        LEGACY,
      ]);
      // Only the draft-only key is flagged for hiding.
      expect(draftOnly.has(DRAFT_ONLY)).toBe(true);
      expect(draftOnly.has(PUBLISHED)).toBe(false);
      expect(draftOnly.has(LEGACY)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("a key with BOTH a draft and a published version is NOT draft-only (published wins)", async () => {
    const tenantId = freshTenant();
    const KEY = `proc-mixed-${uuid().slice(0, 8)}`;

    await seedProcessDef(tenantId, KEY, "draft", 1);
    await seedProcessDef(tenantId, KEY, "published", 2);

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const draftOnly = await draftOnlyProcessKeys(pool, tenantId, [KEY]);
      expect(draftOnly.has(KEY)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("tenant isolation: a draft def in tenant B does not affect tenant A's classification", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const KEY = `proc-shared-${uuid().slice(0, 8)}`;

    // Same key is DRAFT in tenant B, PUBLISHED in tenant A.
    await seedProcessDef(tenantB, KEY, "draft");
    await seedProcessDef(tenantA, KEY, "published");

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // Tenant A reads: KEY is published in A → not draft-only (tenant B's draft is invisible).
      const draftOnlyA = await draftOnlyProcessKeys(pool, tenantA, [KEY]);
      expect(draftOnlyA.has(KEY)).toBe(false);

      // Tenant B reads: KEY is draft-only in B (tenant A's published row is invisible).
      const draftOnlyB = await draftOnlyProcessKeys(pool, tenantB, [KEY]);
      expect(draftOnlyB.has(KEY)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("empty input returns an empty set (no DB round-trip needed)", async () => {
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const draftOnly = await draftOnlyProcessKeys(pool, freshTenant(), []);
      expect(draftOnly.size).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
