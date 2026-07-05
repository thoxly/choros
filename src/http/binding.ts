/**
 * src/http/binding.ts
 *
 * T-0072 E11.1: Named-Binding Contract — HTTP routes.
 * T-0376: actor-scoped form-binding lookup API.
 *
 * Routes:
 *   GET  /tenants/:tenantId/processes/:processKey/forms/:formKey/binding
 *        → 200 {fields, version} | 404
 *   POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding
 *        → 201 (created) | 200 (updated, version+=1) | 400 | 401 | 403
 *
 *   GET  /api/forms/binding?processKey=...&stepKey=...
 *        → 200 {fields, version, processKey, stepKey} | 404
 *        Actor-scoped shortcut: resolves tenantId from the authenticated actor,
 *        fetches the form_binding row for (processKey, stepKey). Used by the
 *        inbox task card to render the bound form. stepKey maps to form_binding.form_key.
 *
 *   POST /api/forms/binding
 *        body { processKey, stepKey, fields }
 *        → 201 (created) | 200 (updated) | 400 | 401 | 403
 *        Actor-scoped form-binding upsert: resolves tenantId from actor, persists
 *        the form binding for (processKey, stepKey). Used by the form builder UI.
 *
 * DESIGN INVARIANTS (ADR §4):
 *  - Auth via existing withAuth + x-dev-user convention (no new auth system).
 *  - Role check: process_designer — conventional, not PDP-grant (ADR §4 / spec FR-6).
 *  - Tenant isolation via withTenantTx + FORCE RLS (same pattern as invoke.ts).
 *  - No cross-table FK; tenantId validated as UUID, processKey/formKey as non-empty text.
 *  - Fields validated by validateBindingFields (KEY_RE, MAX_KEY_LEN, uniqueness).
 *  - Dev-mode (dev auth mode): role check is softened to «authenticated» per
 *    ADR §4 footnote (process_designer role not yet seeded in dev DB).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthMode, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  validateBindingFields,
  type BindingField,
} from "../core/binding-compat.js";
import {
  classifyFloorBoundary,
  type FloorEditOp,
  type LiveSchemaView,
  type FormDocument,
} from "../core/floor-boundary.js";
import { resolveLiveSchemaFieldKeys } from "../db/live-form-schema.js";

// ---------------------------------------------------------------------------
// Injected deps for actor-scoped routes (T-0376)
// ---------------------------------------------------------------------------

/** Resolve the tenant the actor belongs to (same type as ActorTenantResolver). */
export type BindingActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface BindingRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: BindingActorTenantResolver;
}

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

// Exported for reuse by floor1-editor.ts (T-0073 authz path) — same RLS semantics.
export async function withTenantTx<T>(
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
// extractActorSlug — mode-aware: keycloak → resolve slug; dev → x-dev-user
// Mirrors inbox.ts extractActorSlug (T-0372).
// ---------------------------------------------------------------------------

// Exported for reuse by forms-document-ops.ts (T-0656 agent seam) — one identity
// resolution path (keycloak → slug; dev → x-dev-user), no second auth mechanism.
export async function extractActorSlug(
  req: IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
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
// In dev auth mode, role check is softened to «authenticated»
// per ADR §4 footnote: process_designer not yet seeded in the dev DB.
// In keycloak mode this would enforce a real role lookup — T-0072 wires only
// the dev path; keycloak tightening is a later task.
// ---------------------------------------------------------------------------

// Exported for reuse by floor1-editor.ts (T-0073 review R-1) — single source of
// truth for the process_designer authz convention; no second permission mechanism.
export async function checkRole(
  client: pg.PoolClient,
  tenantId: string,
  actorSlug: string,
): Promise<void> {
  const authMode = getAuthMode();
  if (authMode !== "dev") {
    // keycloak mode: check role_assignment for process_designer.
    // role_assignment.employee_id is a UUID FK; actorSlug is the employee slug.
    // Join through employee to resolve slug → UUID so the check works correctly.
    // Without the join, passing a slug directly against a UUID column returns 0
    // rows and silently yields a spurious 403 for all actors.
    const { rows } = await client.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt
         FROM choros.role_assignment ra
         JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
         JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
        WHERE ra.tenant_id = $1
          AND e.slug = $2
          AND r.slug = 'process_designer'`,
      [tenantId, actorSlug],
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
// T-0656: layout-aware binding fetch + the shared floor-boundary gate.
// The agent machine seam (POST /api/forms/document-ops, src/http/forms-document-ops.ts)
// reads the current layout, applies ONE pure op, then re-runs THE SAME gate below
// before persisting — no second copy of the Floor-1/2 decision.
// ---------------------------------------------------------------------------

interface FormBindingLayoutRow {
  id: string;
  process_key: string;
  form_key: string;
  layout: unknown;
  version: number;
}

/** Fetch the current layout document (+ id/version) for (processKey, formKey). */
export async function getBindingLayout(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  formKey: string,
): Promise<FormBindingLayoutRow | null> {
  const { rows } = await client.query<FormBindingLayoutRow>(
    `SELECT id, process_key, form_key, layout, version
       FROM choros.form_binding
      WHERE tenant_id = $1
        AND process_key = $2
        AND form_key = $3`,
    [tenantId, processKey, formKey],
  );
  return rows[0] ?? null;
}

/**
 * Run the T-0520 content gate on a layout document about to be persisted. This
 * is the ONE Floor-1/Floor-2 judge for any layout save — extracted verbatim from
 * the POST /api/forms/binding handler so the human save AND the agent op-apply
 * seam share it exactly (no divergent second check).
 *
 * Throws HttpError(409, "WRONG_FLOOR") on a Floor-2 classification or an
 * unresolvable live schema (fail-closed). Returns void on Floor-1 (safe to save).
 */
export async function classifyLayoutSave(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  layout: Record<string, unknown>,
): Promise<void> {
  const liveKeys = await resolveLiveSchemaFieldKeys(client, tenantId, processKey);
  if (liveKeys === null) {
    // FAIL-CLOSED: live schema unresolvable (no registry_def) → reject as Floor-2.
    throw new HttpError(
      409,
      "WRONG_FLOOR",
      `Form layout cannot be validated against a live record_schema for process ` +
        `"${processKey}" (no registry binding). Fail-closed → Floor-2 path required (T-0520).`,
    );
  }
  const schemaView: LiveSchemaView = { fieldKeys: [...liveKeys] };
  // Normalize the form-document shape for the classifier. The FormDesigner /
  // form-document.js document is { schemaVersion, source, root: {type:"section",
  // children:[…]} } — the tree hangs off `.root`. classifyFloorBoundary walks a
  // node's `.children`/`.tabs` and treats the passed object AS the root node, so
  // a `{root:…}` wrapper (no top-level `type`) would be seen as an empty,
  // typeless node → false Floor-2. Wrap the real root under the classifier's
  // own `{type:"root", children:[…]}` contract (form-document-format §3) so the
  // whole declarative tree is inspected. If the caller already passed that
  // shape (type:"root"/children present), use it as-is.
  const layoutObj = layout as Record<string, unknown>;
  const classifierDoc: FormDocument =
    layoutObj && typeof layoutObj["root"] === "object" && layoutObj["root"] !== null
      ? ({ type: "root", children: [layoutObj["root"]] } as unknown as FormDocument)
      : (layout as FormDocument);
  const layoutFloorOp: FloorEditOp = {
    kind: "relabel_field", // Floor-1 lexical anchor — content checks decide floor
    changedKeys: [
      "label", "display_order", "hidden", "placeholder", "help_text",
      "mode", "widget", "title", "collapsible", "count", "content", "tabs",
    ],
    doc: classifierDoc,
  };
  const layoutFloorResult = classifyFloorBoundary(layoutFloorOp, schemaView);
  if (layoutFloorResult.floor === "2") {
    throw new HttpError(
      409,
      "WRONG_FLOOR",
      `Form layout classified as Floor-2 (content gate, T-0520). ` +
        `Reasons: ${layoutFloorResult.reasons.join("; ")}. ` +
        `Use the Floor-2 authoring path (route: ${layoutFloorResult.route}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerBindingRoutes(router: Router, pool: pg.Pool, deps?: BindingRoutesDeps): void {

  // ---------- GET /tenants/:tenantId/processes/:processKey/forms/:formKey/binding ------
  // The router supports one param segment. We work around this by building a custom
  // dispatcher that matches the full path pattern manually via a middleware-style handler.
  // Pattern: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/binding
  // We register a prefix-aware route by using a fixed-enough path and reading params
  // from the URL manually in the handler.

  // Use the router's register with a path that captures tenantId only (single :param
  // constraint of the existing Router). For multi-param paths we extract remaining
  // segments from req.url directly.

  // T-0418 [SECURITY] P0: all binding routes are withAuth-wrapped. keycloak mode
  // REQUIRES a valid Bearer (401 otherwise; x-dev-user no longer bypasses); dev mode
  // is a no-op pass-through (existing x-dev-user convention unchanged).
  router.register("GET", "/tenants/:tenantId/processes/:processKey/forms/:formKey/binding", withAuth(async (req, res, _params) => {
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
  }));

  // ---------- POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding -----

  router.register("POST", "/tenants/:tenantId/processes/:processKey/forms/:formKey/binding", withAuth(async (req, res, _params) => {
    // T-0418 [SECURITY] P0: promote the legacy POST to the mode-aware extractActorSlug
    // (was the dev-only extractActor). Identity now comes from the validated token in
    // keycloak mode (→ 401 if no employee matches) and x-dev-user in dev mode.
    const actorId = await extractActorSlug(req, pool);

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
  }));

  // ---------------------------------------------------------------------------
  // T-0376 actor-scoped routes — only registered when deps (resolveActorTenant) provided
  // ---------------------------------------------------------------------------

  if (deps) {
    const { resolveActorTenant } = deps;

    // GET /api/forms/binding?processKey=...&stepKey=...
    // Actor-scoped lookup: resolves tenantId from actor, returns the form_binding for
    // (processKey, stepKey). stepKey maps directly to form_binding.form_key.
    // Used by inbox task card to render the assignee's form. → 200 | 404
    // T-0418 [SECURITY] P0: withAuth-wrapped (keycloak REQUIRES a valid Bearer).
    router.register("GET", "/api/forms/binding", withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);
      const url = req.url ?? "";
      const qIdx = url.indexOf("?");
      const qs = qIdx === -1 ? "" : url.slice(qIdx + 1);
      const params = new URLSearchParams(qs);
      const processKey = params.get("processKey") ?? "";
      const stepKey = params.get("stepKey") ?? "";

      if (!processKey || !stepKey) {
        throw new HttpError(400, "VALIDATION", "processKey and stepKey are required query parameters");
      }

      const tenantId = await resolveActorTenant(actor);
      assertUuidShape(tenantId, "tenantId");

      const row = await withTenantTx(pool, tenantId, async (client) => {
        return getBinding(client, tenantId, processKey, stepKey);
      });

      if (!row) {
        throw new HttpError(404, "NOT_FOUND", "no form bound to this process step");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        fields: row.fields,
        version: row.version,
        processKey,
        stepKey,
      }));
    }));

    // POST /api/forms/binding
    // Actor-scoped upsert: saves a form binding for (processKey, stepKey).
    // Body (FormBuilder):   { processKey: string, stepKey: string, fields: BindingField[] }
    // Body (FormDesigner):  { process_key: string, form_key: string, layout: object }
    // Both casings are accepted; `fields` is optional when `layout` is provided.
    // → 201 (created) | 200 (updated) | 400 | 401 | 403
    // T-0418 [SECURITY] P0: withAuth-wrapped (keycloak REQUIRES a valid Bearer).
    // T-0506: accept snake_case keys + optional layout column + optional fields.
    router.register("POST", "/api/forms/binding", withAuth(async (req, res, _params) => {
      const actor = await extractActorSlug(req, pool);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      // Accept camelCase (FormBuilder) OR snake_case (FormDesigner).
      // form_key sent by FormDesigner is treated as stepKey (maps to form_binding.form_key).
      const processKey = (
        typeof body["processKey"] === "string" ? body["processKey"] :
        typeof body["process_key"] === "string" ? body["process_key"] : ""
      ).trim();
      const stepKey = (
        typeof body["stepKey"] === "string" ? body["stepKey"] :
        typeof body["form_key"] === "string" ? body["form_key"] : ""
      ).trim();

      if (!processKey) {
        throw new HttpError(400, "VALIDATION", "processKey must be a non-empty string");
      }
      if (!stepKey) {
        throw new HttpError(400, "VALIDATION", "stepKey must be a non-empty string");
      }

      // Optional layout document (FormDesigner path). When present it must be a JSON object.
      const rawLayout = body["layout"];
      let layout: Record<string, unknown> | null = null;
      if (rawLayout !== undefined && rawLayout !== null) {
        if (typeof rawLayout !== "object" || Array.isArray(rawLayout)) {
          throw new HttpError(400, "VALIDATION", "layout must be a JSON object");
        }
        layout = rawLayout as Record<string, unknown>;
      }

      // fields is optional when layout is provided; required otherwise (FormBuilder path).
      let fields: BindingField[];
      if (body["fields"] !== undefined) {
        const validation = validateBindingFields(body["fields"]);
        if (!validation.ok) {
          throw new HttpError(400, "VALIDATION",
            `invalid fields: ${validation.errors.map((e) => `[${e.index}] ${e.reason}`).join("; ")}`
          );
        }
        fields = validation.fields;
      } else if (layout !== null) {
        // FormDesigner sends layout but not fields; store an empty array (column is NOT NULL).
        fields = [];
      } else {
        throw new HttpError(400, "VALIDATION", "fields is required when layout is not provided");
      }

      const tenantId = await resolveActorTenant(actor);
      assertUuidShape(tenantId, "tenantId");
      const nowMs = Date.now();

      const { statusCode: sc, body: responseBody } = await withTenantTx(pool, tenantId, async (client) => {
        await checkRole(client, tenantId, actor);

        // T-0520 [D7-5]: classifyFloorBoundary gate — FormDesigner / agent layout-emit path.
        // When a layout (form-document) is provided, run the content gate BEFORE persisting.
        // This intercepts agents and UI emitting a layout doc that carries code-signals or
        // dangling fieldKey references. spec §4.2: «та же проверка на эмиссии форма-документа».
        //
        // T-0656: the gate body lives in classifyLayoutSave() (exported above) so the agent
        // op-apply seam (POST /api/forms/document-ops) runs the IDENTICAL check — one judge.
        if (layout !== null) {
          await classifyLayoutSave(client, tenantId, processKey, layout);
        }

        const existing = await getBinding(client, tenantId, processKey, stepKey);
        if (!existing) {
          const newId = randomUUID();
          await client.query(
            `INSERT INTO choros.form_binding
               (tenant_id, id, process_key, form_key, fields, layout, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1, $7, $7)`,
            [tenantId, newId, processKey, stepKey, JSON.stringify(fields),
             layout !== null ? JSON.stringify(layout) : null, nowMs],
          );
          return { statusCode: 201, body: { id: newId, version: 1 } };
        } else {
          const newVersion = existing.version + 1;
          await client.query(
            `UPDATE choros.form_binding
                SET fields = $1::jsonb,
                    layout = COALESCE($2::jsonb, form_binding.layout),
                    version = $3,
                    updated_at = $4
              WHERE tenant_id = $5
                AND process_key = $6
                AND form_key = $7`,
            [JSON.stringify(fields), layout !== null ? JSON.stringify(layout) : null,
             newVersion, nowMs, tenantId, processKey, stepKey],
          );
          return { statusCode: 200, body: { id: existing.id, version: newVersion } };
        }
      });

      res.statusCode = sc;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
    }));
  }
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
