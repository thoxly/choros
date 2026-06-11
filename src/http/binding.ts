/**
 * src/http/binding.ts
 *
 * T-0072 E11.1: Named-Binding Contract — HTTP routes.
 *
 * Routes:
 *   GET  /tenants/:tenantId/processes/:processKey/forms/:formKey/binding
 *        → 200 {fields, version} | 404
 *   POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding
 *        → 201 (created) | 200 (updated, version+=1) | 400 | 401 | 403
 *
 * DESIGN INVARIANTS (ADR §4):
 *  - Auth via existing withAuth + x-dev-user convention (no new auth system).
 *  - Role check: process_designer — conventional, not PDP-grant (ADR §4 / spec FR-6).
 *  - Tenant isolation via withTenantTx + FORCE RLS (same pattern as invoke.ts).
 *  - No cross-table FK; tenantId validated as UUID, processKey/formKey as non-empty text.
 *  - Fields validated by validateBindingFields (KEY_RE, MAX_KEY_LEN, uniqueness).
 *  - Dev-mode (CHOROS_AUTH_MODE=dev): role check is softened to «authenticated» per
 *    ADR §4 footnote (process_designer role not yet seeded in dev DB).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import {
  validateBindingFields,
  type BindingField,
} from "../core/binding-compat.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

function assertNonEmptyText(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", `${label} must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors invoke.ts pattern
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
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

// ---------------------------------------------------------------------------
// extractActor — reads caller identity (mirrors invoke.ts)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// checkRole — conventional process_designer check (ADR §4)
//
// In dev mode (CHOROS_AUTH_MODE=dev), role check is softened to «authenticated»
// per ADR §4 footnote: process_designer not yet seeded in the dev DB.
// In keycloak mode this would enforce a real role lookup — T-0072 wires only
// the dev path; keycloak tightening is a later task.
// ---------------------------------------------------------------------------

async function checkRole(
  client: pg.PoolClient,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const authMode = process.env["CHOROS_AUTH_MODE"] ?? "dev";
  if (authMode !== "dev") {
    // keycloak mode: check role_assignment for process_designer
    const { rows } = await client.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt
         FROM choros.role_assignment ra
         JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = $2
          AND r.slug = 'process_designer'`,
      [tenantId, actorId],
    );
    if (!rows[0] || rows[0].cnt === 0) {
      throw new HttpError(403, "FORBIDDEN", "role process_designer required");
    }
  }
  // dev mode: authenticated = sufficient (ADR §4 footnote)
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

interface FormBindingRow {
  id: string;
  process_key: string;
  form_key: string;
  fields: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

async function getBinding(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  formKey: string,
): Promise<FormBindingRow | null> {
  const { rows } = await client.query<FormBindingRow>(
    `SELECT id, process_key, form_key, fields, version, created_at, updated_at
       FROM choros.form_binding
      WHERE tenant_id = $1
        AND process_key = $2
        AND form_key = $3`,
    [tenantId, processKey, formKey],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerBindingRoutes(router: Router, pool: pg.Pool): void {

  // ---------- GET /tenants/:tenantId/processes/:processKey/forms/:formKey/binding ------
  // The router supports one param segment. We work around this by building a custom
  // dispatcher that matches the full path pattern manually via a middleware-style handler.
  // Pattern: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/binding
  // We register a prefix-aware route by using a fixed-enough path and reading params
  // from the URL manually in the handler.

  // Use the router's register with a path that captures tenantId only (single :param
  // constraint of the existing Router). For multi-param paths we extract remaining
  // segments from req.url directly.

  router.register("GET", "/tenants/:tenantId/processes/:processKey/forms/:formKey/binding", async (req, res, _params) => {
    // Extract all path params from the URL directly (multi-param extraction).
    const urlParts = extractBindingUrlParts(req.url ?? "");
    if (!urlParts) {
      throw new HttpError(404, "NOT_FOUND", "route not found");
    }

    assertUuidShape(urlParts.tenantId, "tenantId");
    assertNonEmptyText(urlParts.processKey, "processKey");
    assertNonEmptyText(urlParts.formKey, "formKey");

    const row = await withTenantTx(pool, urlParts.tenantId, async (client) => {
      return getBinding(client, urlParts.tenantId, urlParts.processKey, urlParts.formKey);
    });

    if (!row) {
      throw new HttpError(404, "NOT_FOUND", "binding not found");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      fields: row.fields,
      version: row.version,
    }));
  });

  // ---------- POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding -----

  router.register("POST", "/tenants/:tenantId/processes/:processKey/forms/:formKey/binding", async (req, res, _params) => {
    // Extract actor identity (→ 401 if absent)
    const actorId = extractActor(req);

    const urlParts = extractBindingUrlParts(req.url ?? "");
    if (!urlParts) {
      throw new HttpError(404, "NOT_FOUND", "route not found");
    }

    assertUuidShape(urlParts.tenantId, "tenantId");
    assertNonEmptyText(urlParts.processKey, "processKey");
    assertNonEmptyText(urlParts.formKey, "formKey");

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    // Validate fields
    const validation = validateBindingFields(body["fields"]);
    if (!validation.ok) {
      throw new HttpError(400, "VALIDATION",
        `invalid fields: ${validation.errors.map((e) => `[${e.index}] ${e.reason}`).join("; ")}`
      );
    }
    const fields: BindingField[] = validation.fields;

    const { tenantId, processKey, formKey } = urlParts;
    const nowMs = Date.now();

    const { statusCode, body: responseBody } = await withTenantTx(pool, tenantId, async (client) => {
      // Role check (→ 403 if insufficient)
      await checkRole(client, tenantId, actorId);

      // Upsert: INSERT ... ON CONFLICT (tenant_id, process_key, form_key) DO UPDATE
      const existing = await getBinding(client, tenantId, processKey, formKey);

      if (!existing) {
        // INSERT — 201
        const newId = randomUUID();
        await client.query(
          `INSERT INTO choros.form_binding
             (tenant_id, id, process_key, form_key, fields, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6, $6)`,
          [tenantId, newId, processKey, formKey, JSON.stringify(fields), nowMs],
        );
        return { statusCode: 201, body: { id: newId, version: 1 } };
      } else {
        // UPDATE — 200, version+1
        const newVersion = existing.version + 1;
        await client.query(
          `UPDATE choros.form_binding
              SET fields = $1::jsonb,
                  version = $2,
                  updated_at = $3
            WHERE tenant_id = $4
              AND process_key = $5
              AND form_key = $6`,
          [JSON.stringify(fields), newVersion, nowMs, tenantId, processKey, formKey],
        );
        return { statusCode: 200, body: { id: existing.id, version: newVersion } };
      }
    });

    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(responseBody));
  });
}

// ---------------------------------------------------------------------------
// URL parser for multi-param binding path
// Pattern: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/binding
// ---------------------------------------------------------------------------

interface BindingUrlParts {
  tenantId: string;
  processKey: string;
  formKey: string;
}

/**
 * Extracts tenantId, processKey, formKey from the binding URL path.
 * Returns null if the URL does not match the expected pattern.
 */
function extractBindingUrlParts(rawUrl: string): BindingUrlParts | null {
  const questionIdx = rawUrl.indexOf("?");
  const pathname = questionIdx === -1 ? rawUrl : rawUrl.slice(0, questionIdx);
  // Expected: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/binding
  const parts = pathname.split("/");
  // parts: ["", "tenants", tenantId, "processes", processKey, "forms", formKey, "binding"]
  if (
    parts.length === 8 &&
    parts[0] === "" &&
    parts[1] === "tenants" &&
    parts[3] === "processes" &&
    parts[5] === "forms" &&
    parts[7] === "binding"
  ) {
    const tenantId = parts[2] ?? "";
    const processKey = decodeURIComponent(parts[4] ?? "");
    const formKey = decodeURIComponent(parts[6] ?? "");
    return { tenantId, processKey, formKey };
  }
  return null;
}
