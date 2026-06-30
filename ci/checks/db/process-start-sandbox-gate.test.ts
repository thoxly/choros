// T-0558 · process-start sandbox-state resolver — live Postgres probes.
//
// Run: DATABASE_URL=<migrator-url> npm run fitness:db
//
// Proves resolveProcessSandboxStateDb (the load-bearing DB lookup behind the
// process-start sandbox gate) classifies a process key against the REAL
// process_definition.status + process_app_binding → application.tier, tenant-scoped
// under the choros_app (NOBYPASSRLS) role:
//
//   - published definition, no draft binding → runnable (NOT refused).
//   - draft-only definition → definition-draft (refused for unprivileged).
//   - published definition bound to a DRAFT application → bound-app-draft (refused).
//   - no definition row (legacy/directly-deployed) → not definition-draft.
//
// Tenant isolation: a draft definition in tenant B does not leak into tenant A's state.

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl, uuid } from "./_helpers.js";
import { resolveProcessSandboxStateDb } from "../../../src/http/process-start.js";

function freshTenant(): string {
  return crypto.randomUUID();
}

async function seedDef(tenantId: string, key: string, status: "draft" | "published", version = 1): Promise<void> {
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
      [tenantId, uuid(), key, `Def ${key}`, version, status],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}

async function seedApp(tenantId: string, tier: "draft" | "published"): Promise<string> {
  const id = uuid();
  const c = new pg.Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NULL, $4, 0, 0)`,
      [tenantId, id, `app-${id.slice(0, 8)}`, tier],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
  return id;
}

async function bind(tenantId: string, key: string, appId: string): Promise<void> {
  const c = new pg.Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.process_app_binding
         (tenant_id, id, process_key, application_id, form_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 0, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, uuid(), key, appId],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}

describe("T-0558 — resolveProcessSandboxStateDb (live)", () => {
  it("published definition, no draft binding → runnable", async () => {
    const t = freshTenant();
    const key = `proc-${uuid().slice(0, 8)}`;
    await seedDef(t, key, "published");
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const s = await resolveProcessSandboxStateDb(pool, t, key);
      expect(s.hasDefinitionRow).toBe(true);
      expect(s.definitionPublished).toBe(true);
      expect(s.boundAppDraft).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("draft-only definition → definition not published", async () => {
    const t = freshTenant();
    const key = `proc-${uuid().slice(0, 8)}`;
    await seedDef(t, key, "draft");
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const s = await resolveProcessSandboxStateDb(pool, t, key);
      expect(s.hasDefinitionRow).toBe(true);
      expect(s.definitionPublished).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("published definition bound to a DRAFT application → boundAppDraft true", async () => {
    const t = freshTenant();
    const key = `proc-${uuid().slice(0, 8)}`;
    await seedDef(t, key, "published");
    const draftApp = await seedApp(t, "draft");
    await bind(t, key, draftApp);
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const s = await resolveProcessSandboxStateDb(pool, t, key);
      expect(s.definitionPublished).toBe(true);
      expect(s.boundAppDraft).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("published definition bound only to a PUBLISHED app → boundAppDraft false", async () => {
    const t = freshTenant();
    const key = `proc-${uuid().slice(0, 8)}`;
    await seedDef(t, key, "published");
    const pubApp = await seedApp(t, "published");
    await bind(t, key, pubApp);
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const s = await resolveProcessSandboxStateDb(pool, t, key);
      expect(s.boundAppDraft).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("no definition row (legacy) → hasDefinitionRow false, definitionPublished false", async () => {
    const t = freshTenant();
    const key = `proc-legacy-${uuid().slice(0, 8)}`;
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const s = await resolveProcessSandboxStateDb(pool, t, key);
      expect(s.hasDefinitionRow).toBe(false);
      expect(s.definitionPublished).toBe(false);
      expect(s.boundAppDraft).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("tenant isolation: a draft def in tenant B does not leak into tenant A's state", async () => {
    const tA = freshTenant();
    const tB = freshTenant();
    const key = `proc-${uuid().slice(0, 8)}`;
    await seedDef(tB, key, "draft"); // only in B
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const sA = await resolveProcessSandboxStateDb(pool, tA, key);
      expect(sA.hasDefinitionRow).toBe(false); // tenant A sees no row for this key
      const sB = await resolveProcessSandboxStateDb(pool, tB, key);
      expect(sB.hasDefinitionRow).toBe(true);
      expect(sB.definitionPublished).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
