/**
 * src/http/process-defs.ts
 *
 * T-0252 E8 C2: Process-definition CRUD + publish routes.
 *
 * Routes:
 *   POST   /api/process-defs            — upsert draft from XML (auth-gated write)
 *   GET    /api/process-defs            — list all definitions for the tenant
 *   GET    /api/process-defs/:key       — get latest version for a process key
 *   POST   /api/process-defs/:key/publish — lint → deployBpmn → persist deployment_id
 *
 * Design invariants:
 *   - Auth via x-dev-user convention (same as binding.ts).
 *   - Tenant isolation via withTenantTx + FORCE RLS (same as binding.ts / invoke.ts).
 *   - FlowableClient injected via composition root (NO env reads in core — NF-1).
 *   - lintBpmn called before any deploy attempt; ok:false → HTTP 422 with violations.
 *   - Publish is the ONLY path that calls deployBpmn; CRUD never touches the engine.
 *   - Upsert semantics: same (tenant_id, process_key) → new version row (version+1).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import { lintBpmn } from "../core/bpmn-linter.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessDefRow {
  tenant_id: string;
  id: string;
  process_key: string;
  name: string;
  bpmn_xml: string;
  version: number;
  status: string;
  deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// withTenantTx — same RLS pattern as binding.ts
async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Extract tenantId from /api/tenants/:tenantId/... prefix OR from x-tenant-id header.
// Routes are mounted under /api/process-defs and tenant comes from header x-tenant-id.
function extractTenantId(req: IncomingMessage): string {
  let tenantId = req.headers["x-tenant-id"];
  if (Array.isArray(tenantId)) tenantId = tenantId[0];
  if (!tenantId || typeof tenantId !== "string") {
    throw new HttpError(400, "VALIDATION", "missing x-tenant-id header");
  }
  return tenantId;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

async function getLatestVersion(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
): Promise<ProcessDefRow | null> {
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1 AND process_key = $2
      ORDER BY version DESC
      LIMIT 1`,
    [tenantId, processKey],
  );
  return rows[0] ?? null;
}

async function listAll(
  client: pg.PoolClient,
  tenantId: string,
): Promise<ProcessDefRow[]> {
  // Return only the latest version per process_key using DISTINCT ON
  const { rows } = await client.query<ProcessDefRow>(
    `SELECT DISTINCT ON (process_key)
            tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at
       FROM choros.process_definition
      WHERE tenant_id = $1
      ORDER BY process_key, version DESC`,
    [tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProcessDefsRoutes(
  router: Router,
  pool: pg.Pool,
  flowable: FlowableClient,
): void {

  // -------------------------------------------------------------------------
  // POST /api/process-defs — upsert draft
  // Body: { processKey: string, name: string, bpmnXml: string }
  // -------------------------------------------------------------------------
  router.register("POST", "/api/process-defs", async (req, res) => {
    // Auth gate
    extractActor(req);
    const tenantId = extractTenantId(req);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const processKey = body["processKey"];
    const name = body["name"];
    const bpmnXml = body["bpmnXml"];

    if (typeof processKey !== "string" || !processKey.trim()) {
      throw new HttpError(400, "VALIDATION", "processKey must be a non-empty string");
    }
    if (typeof name !== "string" || !name.trim()) {
      throw new HttpError(400, "VALIDATION", "name must be a non-empty string");
    }
    if (typeof bpmnXml !== "string" || !bpmnXml.trim()) {
      throw new HttpError(400, "VALIDATION", "bpmnXml must be a non-empty string");
    }

    const nowMs = Date.now();

    const result = await withTenantTx(pool, tenantId, async (client) => {
      const existing = await getLatestVersion(client, tenantId, processKey);
      const newVersion = existing ? existing.version + 1 : 1;
      const newId = randomUUID();

      await client.query(
        `INSERT INTO choros.process_definition
           (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', NULL, $7, $7)`,
        [tenantId, newId, processKey, name, bpmnXml, newVersion, nowMs],
      );
      return { id: newId, processKey, version: newVersion, status: "draft" };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });

  // -------------------------------------------------------------------------
  // GET /api/process-defs — list latest version per process key
  // -------------------------------------------------------------------------
  router.register("GET", "/api/process-defs", async (req, res) => {
    const tenantId = extractTenantId(req);

    const rows = await withTenantTx(pool, tenantId, async (client) => {
      return listAll(client, tenantId);
    });

    const items = rows.map((r) => ({
      id: r.id,
      processKey: r.process_key,
      name: r.name,
      version: r.version,
      status: r.status,
      deploymentId: r.deployment_id ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items }));
  });

  // -------------------------------------------------------------------------
  // GET /api/process-defs/:key — get latest version for a process key
  // -------------------------------------------------------------------------
  router.register("GET", "/api/process-defs/:key", async (req, res, params) => {
    const tenantId = extractTenantId(req);
    const processKey = decodeURIComponent(params["key"] ?? "");
    if (!processKey) {
      throw new HttpError(400, "VALIDATION", "process key must be non-empty");
    }

    const row = await withTenantTx(pool, tenantId, async (client) => {
      return getLatestVersion(client, tenantId, processKey);
    });

    if (!row) {
      throw new HttpError(404, "NOT_FOUND", `process definition '${processKey}' not found`);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: row.id,
      processKey: row.process_key,
      name: row.name,
      bpmnXml: row.bpmn_xml,
      version: row.version,
      status: row.status,
      deploymentId: row.deployment_id ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  });

  // -------------------------------------------------------------------------
  // POST /api/process-defs/:key/publish — lint → deploy → persist
  //
  // Steps:
  //   1. Load latest version from DB (404 if not found)
  //   2. lintBpmn(bpmnXml) — ok:false → 422 with violations
  //   3. flowable.deployBpmn(bpmnXml) — failure → 502
  //   4. UPDATE status='published', deployment_id=deploymentId, updated_at=now
  //   5. Return { id, processKey, version, status, deploymentId }
  // -------------------------------------------------------------------------
  router.register("POST", "/api/process-defs/:key/publish", async (req, res, params) => {
    // Auth gate — write operation
    extractActor(req);
    const tenantId = extractTenantId(req);
    const processKey = decodeURIComponent(params["key"] ?? "");
    if (!processKey) {
      throw new HttpError(400, "VALIDATION", "process key must be non-empty");
    }

    // Step 1: Load latest version
    const row = await withTenantTx(pool, tenantId, async (client) => {
      return getLatestVersion(client, tenantId, processKey);
    });

    if (!row) {
      throw new HttpError(404, "NOT_FOUND", `process definition '${processKey}' not found`);
    }

    // Step 2: Lint — fail-closed gate (T-0027 deploy-gate-contract)
    const lintResult = lintBpmn(row.bpmn_xml);
    if (!lintResult.ok) {
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: { code: "BPMN_LINT_FAILED", violations: lintResult.violations },
      }));
      return;
    }

    // Step 3: Deploy to Flowable
    const deployResult = await flowable.deployBpmn(row.bpmn_xml);
    if (!deployResult.ok) {
      throw new HttpError(502, "ENGINE_ERROR", `deployBpmn failed: ${deployResult.code}`);
    }

    const deploymentId = deployResult.deploymentId;
    const nowMs = Date.now();

    // Step 4: Persist publication
    await withTenantTx(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE choros.process_definition
            SET status = 'published',
                deployment_id = $1,
                updated_at = $2
          WHERE tenant_id = $3
            AND id = $4`,
        [deploymentId, nowMs, tenantId, row.id],
      );
    });

    // Step 5: Respond
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: row.id,
      processKey: row.process_key,
      version: row.version,
      status: "published",
      deploymentId,
    }));
  });
}
