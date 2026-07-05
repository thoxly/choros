/**
 * src/http/floor1-editor.ts
 *
 * T-0073 E11.2: Floor-1 Form Editor HTTP routes.
 *
 * Registers:
 *   POST /tenants/:tenantId/processes/:processKey/forms/:formKey/edits
 *        Body: Floor1EditRequest (one of 6 button operations)
 *        → 200 { fields, uiSchema }
 *          400 VALIDATION    — invalid request shape
 *          409 WRONG_FLOOR   — kind classified as Floor-2
 *          422 UNKNOWN_FIELD — fieldKey not in binding
 *          401 UNAUTHENTICATED — missing x-dev-user
 *          403 FORBIDDEN     — role process_designer missing (keycloak mode)
 *          404 NOT_FOUND     — binding not found
 *
 * CONTRACT (ADR §4 / §9.1):
 *   - Stateless: request body carries current {fields, uiSchema}; response
 *     carries transformed {fields, uiSchema}. No separate form_def table (deferred
 *     T-0125). Persistence is the caller's responsibility.
 *   - classifyAuthoringFloor() gate: kind in FLOOR2_EDIT_KINDS → 409 WRONG_FLOOR.
 *   - checkBindingCompat() is intentionally NOT called here: Floor-1 ops never
 *     add/drop fields, so the key-set is preserved and the check would always be
 *     a trivially-ok no-op. Binding-compat enforcement is the responsibility of
 *     the persistence path (PATCH /tenants/.../binding, T-0072) — the caller
 *     persists the transformed result there.
 *   - Auth via x-dev-user convention (same as binding.ts / invoke.ts).
 *   - Authz (review R-1): role process_designer via checkRole from binding.ts —
 *     same semantics as the neighbour writing the same form_binding record:
 *     dev auth mode softens to «authenticated» (ADR §4 footnote, role not seeded
 *     in dev DB); keycloak mode does a real role_assignment lookup → 403.
 *   - Tenant isolation: tenantId validated as UUID; withTenantTx (reused from
 *     binding.ts) wraps only the keycloak-mode role lookup. In stateless-body
 *     mode no other DB access happens — the client supplies fields and uiSchema.
 *
 * HONEST NARROWING (form_def deferred):
 *   The route is split into two modes based on the request body:
 *
 *   Mode A — stateless (no DB): body carries { fields, uiSchema, edit }.
 *     Pure transform: applyFloor1Edit → return 200 { fields, uiSchema }.
 *     No DB read. Callers (UI, agents) must persist the result themselves via
 *     PATCH /tenants/.../binding (T-0072). This is the primary day-1 path.
 *
 *   (Mode B — read-from-DB would read form_binding, but is intentionally deferred
 *   until form_def / ui_schema table lands. Not implemented in T-0073.)
 *
 * DESIGN DISCIPLINE:
 *   - assertUuidShape for tenantId (SQL-injection guard, mirrors binding.ts R-4).
 *   - No second permission mechanism: authz reuses binding.ts checkRole verbatim.
 *   - No ambient DATABASE_URL required for npm test (dev-mode authz needs no DB;
 *     the transform itself is pure).
 *   - This route never persists form_binding (no INSERT/UPDATE/DELETE) — that
 *     stays the caller's job via PATCH /binding (fitness FE1-11).
 *   - Imports only: router, auth, binding (authz reuse), floor1-editor core,
 *     binding-compat core, pg (types only, for the authz pool parameter).
 */

import type { IncomingMessage } from "node:http";
import type pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, getAuthMode, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth, resolveAgentSlugFromAuth } from "../db/org.js";
import { checkRole, withTenantTx } from "./binding.js";
import {
  applyFloor1Edit,
  type Floor1EditRequest,
  type FieldUiMeta,
  type FormUiSchema,
} from "../core/floor1-editor.js";
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

// T-0420 [SECURITY] P1: mode-aware caller identity (mirrors binding.ts::extractActorSlug
// and the T-0418 P0 process-defs::extractActor). floor1-editor is a process-authoring
// surface (UI + agents) gated by the process_designer role via checkRole. The route is now
// withAuth-wrapped (Bearer validated + getAuthContext populated BEFORE this runs), so the
// identity feeding authorizeEditor is the VALIDATED token in keycloak mode, not an
// unauthenticated x-dev-user header.
//   - keycloak: identity from the validated token; branch on the VALIDATED actor_type claim:
//     - actor_type === 'agent' → resolveAgentSlugFromAuth (T-0425 [SECURITY]): this surface
//       is explicitly agent-callable per T-0328 §2.5 ("callers are UI, agents") and the
//       summary table §3.1 (floor1-editor: "keycloak-SSO (human + agent token)"). Agents
//       authoring forms (e.g. a config-agent editing field labels via a programmatic call)
//       present a service-account JWT with actor_type=agent. The SEPARATE agent resolver
//       maps service-account-<clientId> → agent_card.kc_client_id → kind='agent' employee
//       slug. It can ONLY ever return an agent slug (disjoint from human path, ADR §3).
//     - else (human) → resolveActorSlugFromAuth, UNTOUCHED, with its kind='human'
//       T-0372 anti-impersonation guard intact.
//     null → 401 fail-closed. x-dev-user is NOT consulted once a token authenticated.
//   - dev: getAuthContext is undefined (withAuth no-op) → x-dev-user, unchanged.
async function extractActor(req: IncomingMessage, pool: pg.Pool | null): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    // A token authenticated (keycloak). Resolve the slug from it — never fall
    // through to x-dev-user once an identity was validated. Without a pool we
    // cannot resolve and must fail closed (503), matching authorizeEditor.
    if (!pool) {
      throw new HttpError(
        503,
        "NO_DATABASE",
        "identity resolution requires a database connection in keycloak auth mode",
      );
    }
    // T-0425 [SECURITY]: branch on the VALIDATED actor_type claim → disjoint
    // agent vs human bridge. floor1-editor is agent-callable (T-0328 §2.5).
    const slug =
      ctx.actorType === "agent"
        ? await resolveAgentSlugFromAuth(pool, ctx)
        : await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
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
// authorizeEditor — process_designer role check (review R-1, mirrors binding.ts)
//
// Same semantics as binding.ts checkRole (reused directly — no second
// permission mechanism):
//   - dev auth mode: authenticated = sufficient (ADR §4 footnote, role not
//     seeded in dev DB). No DB access at all — Mode A stays DATABASE_URL-free
//     in dev/test.
//   - keycloak mode: real role_assignment lookup → 403 FORBIDDEN when the
//     actor lacks process_designer. Requires a pool; if the server was wired
//     without one, fail closed (503) rather than skipping authz.
// ---------------------------------------------------------------------------

async function authorizeEditor(
  pool: pg.Pool | null,
  tenantId: string,
  actorId: string,
): Promise<void> {
  if (getAuthMode() === "dev") {
    // dev mode: authenticated = sufficient (same softening as binding.ts)
    return;
  }
  if (!pool) {
    // fail-closed: keycloak mode demands a real role lookup
    throw new HttpError(
      503,
      "NO_DATABASE",
      "role check requires a database connection in keycloak auth mode",
    );
  }
  await withTenantTx(pool, tenantId, (client) =>
    checkRole(client, pool, tenantId, actorId),
  );
}

// ---------------------------------------------------------------------------
// URL parser — mirrors binding.ts extractBindingUrlParts pattern
// Pattern: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/edits
// ---------------------------------------------------------------------------

interface Floor1EditorUrlParts {
  tenantId: string;
  processKey: string;
  formKey: string;
}

function extractEditorUrlParts(rawUrl: string): Floor1EditorUrlParts | null {
  const questionIdx = rawUrl.indexOf("?");
  const pathname = questionIdx === -1 ? rawUrl : rawUrl.slice(0, questionIdx);
  // Expected: /tenants/{tenantId}/processes/{processKey}/forms/{formKey}/edits
  const parts = pathname.split("/");
  // parts: ["", "tenants", tenantId, "processes", processKey, "forms", formKey, "edits"]
  if (
    parts.length === 8 &&
    parts[0] === "" &&
    parts[1] === "tenants" &&
    parts[3] === "processes" &&
    parts[5] === "forms" &&
    parts[7] === "edits"
  ) {
    const tenantId = parts[2] ?? "";
    const processKey = decodeURIComponent(parts[4] ?? "");
    const formKey = decodeURIComponent(parts[6] ?? "");
    return { tenantId, processKey, formKey };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

/**
 * Parses the uiSchema from body (raw). Accepts {} or a map of fieldKey → FieldUiMeta.
 * Returns FormUiSchema (possibly empty) or throws HttpError(400).
 */
function parseUiSchema(raw: unknown, fieldKeys: ReadonlySet<string>): FormUiSchema {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "VALIDATION", "uiSchema must be a plain object");
  }
  const result: FormUiSchema = {};
  for (const [key, metaRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!fieldKeys.has(key)) {
      throw new HttpError(
        400,
        "VALIDATION",
        `uiSchema key "${key}" is not a field key in the provided fields array`,
      );
    }
    if (metaRaw === null || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
      throw new HttpError(
        400,
        "VALIDATION",
        `uiSchema["${key}"] must be a plain object`,
      );
    }
    const meta = metaRaw as Record<string, unknown>;
    const fieldMeta: FieldUiMeta = {};
    if ("label" in meta) {
      if (typeof meta["label"] !== "string") {
        throw new HttpError(400, "VALIDATION", `uiSchema["${key}"].label must be a string`);
      }
      fieldMeta.label = meta["label"] as string;
    }
    if ("placeholder" in meta) {
      if (typeof meta["placeholder"] !== "string") {
        throw new HttpError(400, "VALIDATION", `uiSchema["${key}"].placeholder must be a string`);
      }
      fieldMeta.placeholder = meta["placeholder"] as string;
    }
    if ("help_text" in meta) {
      if (typeof meta["help_text"] !== "string") {
        throw new HttpError(400, "VALIDATION", `uiSchema["${key}"].help_text must be a string`);
      }
      fieldMeta.help_text = meta["help_text"] as string;
    }
    if ("hidden" in meta) {
      if (typeof meta["hidden"] !== "boolean") {
        throw new HttpError(400, "VALIDATION", `uiSchema["${key}"].hidden must be a boolean`);
      }
      fieldMeta.hidden = meta["hidden"] as boolean;
    }
    if ("display_order" in meta) {
      if (typeof meta["display_order"] !== "number") {
        throw new HttpError(400, "VALIDATION", `uiSchema["${key}"].display_order must be a number`);
      }
      fieldMeta.display_order = meta["display_order"] as number;
    }
    result[key] = fieldMeta;
  }
  return result;
}

/**
 * Parses a Floor1EditRequest from a raw body value.
 * Returns Floor1EditRequest or throws HttpError(400).
 */
function parseEditRequest(raw: unknown): Floor1EditRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "VALIDATION", "edit must be a plain object");
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "edit.kind must be a non-empty string");
  }

  switch (kind) {
    case "relabel_field": {
      const fieldKey = obj["fieldKey"];
      const label = obj["label"];
      const placeholder = obj["placeholder"];
      if (typeof fieldKey !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.fieldKey must be a string for relabel_field");
      }
      if (typeof label !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.label must be a string for relabel_field");
      }
      return {
        kind: "relabel_field",
        fieldKey,
        label,
        ...(typeof placeholder === "string" ? { placeholder } : {}),
      };
    }

    case "toggle_required": {
      const fieldKey = obj["fieldKey"];
      const required = obj["required"];
      if (typeof fieldKey !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.fieldKey must be a string for toggle_required");
      }
      if (typeof required !== "boolean") {
        throw new HttpError(400, "VALIDATION", "edit.required must be a boolean for toggle_required");
      }
      return { kind: "toggle_required", fieldKey, required };
    }

    case "hide_field": {
      const fieldKey = obj["fieldKey"];
      if (typeof fieldKey !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.fieldKey must be a string for hide_field");
      }
      return { kind: "hide_field", fieldKey };
    }

    case "show_field": {
      const fieldKey = obj["fieldKey"];
      if (typeof fieldKey !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.fieldKey must be a string for show_field");
      }
      return { kind: "show_field", fieldKey };
    }

    case "reorder_fields": {
      const orders = obj["orders"];
      if (!Array.isArray(orders)) {
        throw new HttpError(400, "VALIDATION", "edit.orders must be an array for reorder_fields");
      }
      const parsedOrders: Array<{ fieldKey: string; displayOrder: number }> = [];
      for (let i = 0; i < orders.length; i++) {
        const item = orders[i];
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new HttpError(400, "VALIDATION", `edit.orders[${i}] must be a plain object`);
        }
        const o = item as Record<string, unknown>;
        if (typeof o["fieldKey"] !== "string") {
          throw new HttpError(400, "VALIDATION", `edit.orders[${i}].fieldKey must be a string`);
        }
        if (typeof o["displayOrder"] !== "number") {
          throw new HttpError(400, "VALIDATION", `edit.orders[${i}].displayOrder must be a number`);
        }
        parsedOrders.push({
          fieldKey: o["fieldKey"] as string,
          displayOrder: o["displayOrder"] as number,
        });
      }
      return { kind: "reorder_fields", orders: parsedOrders };
    }

    case "set_help_text": {
      const fieldKey = obj["fieldKey"];
      const helpText = obj["helpText"];
      if (typeof fieldKey !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.fieldKey must be a string for set_help_text");
      }
      if (typeof helpText !== "string") {
        throw new HttpError(400, "VALIDATION", "edit.helpText must be a string for set_help_text");
      }
      return { kind: "set_help_text", fieldKey, helpText };
    }

    default: {
      // Unknown kind: still parse, let validateFloor1Request classify → WRONG_FLOOR
      // We return a minimal object that will fail Floor-2 guard in the core.
      throw new HttpError(
        400,
        "VALIDATION",
        `edit.kind "${kind}" is not a recognized Floor-1 edit kind. ` +
          `Supported: relabel_field, toggle_required, hide_field, show_field, reorder_fields, set_help_text`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// deriveChangedKeys — R-2 whitelist helper (T-0520)
//
// Maps a parsed Floor1EditRequest to the set of named-binding / ui-schema
// slots it modifies (for FLOOR1_DECLARATIVE_WHITELIST check in classifyFloorBoundary).
// All returned keys must be present in FLOOR1_DECLARATIVE_WHITELIST for the
// operation to clear R-2. Unknown kinds resolve to an empty array (fail-closed:
// the lexical R-1 will already catch them).
// ---------------------------------------------------------------------------

function deriveChangedKeys(req: Floor1EditRequest): string[] {
  switch (req.kind) {
    case "relabel_field":
      // Modifies label (+ optionally placeholder) in both BindingField and FieldUiMeta.
      return req.placeholder !== undefined ? ["label", "placeholder"] : ["label"];
    case "toggle_required":
      return ["required"];
    case "hide_field":
    case "show_field":
      return ["hidden"];
    case "reorder_fields":
      return ["display_order"];
    case "set_help_text":
      return ["help_text"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the Floor-1 editor route on the given router.
 *
 * `pool` is used exclusively for the keycloak-mode authz role lookup
 * (authorizeEditor → checkRole, review R-1). The transform itself stays
 * stateless/pure (Mode A). In dev auth mode the route works without a pool —
 * server.ts passes grantsPool when DATABASE_URL is configured, null otherwise.
 */
export function registerFloor1EditorRoutes(
  router: Router,
  pool: pg.Pool | null = null,
): void {
  //
  // POST /tenants/:tenantId/processes/:processKey/forms/:formKey/edits
  //
  // Body: {
  //   fields:   BindingField[]   (current form_binding.fields)
  //   uiSchema: FormUiSchema     (optional; {} if none)
  //   edit:     Floor1EditRequest
  // }
  //
  // Response 200: { fields: BindingField[], uiSchema: FormUiSchema }
  //
  // T-0420 [SECURITY] P1: withAuth-wrapped — keycloak mode REQUIRES a valid Bearer
  // (401 otherwise; no x-dev-user bypass); dev mode is a no-op pass-through.
  router.register(
    "POST",
    "/tenants/:tenantId/processes/:processKey/forms/:formKey/edits",
    withAuth(async (req, res, _params) => {
      // Auth check — actor derived from the validated token (keycloak) or x-dev-user (dev).
      const actorId = await extractActor(req, pool);

      // URL parsing
      const urlParts = extractEditorUrlParts(req.url ?? "");
      if (!urlParts) {
        throw new HttpError(404, "NOT_FOUND", "route not found");
      }

      assertUuidShape(urlParts.tenantId, "tenantId");
      assertNonEmptyText(urlParts.processKey, "processKey");
      assertNonEmptyText(urlParts.formKey, "formKey");

      // Body parsing
      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      // Parse and validate fields[]
      const fieldsValidation = validateBindingFields(body["fields"]);
      if (!fieldsValidation.ok) {
        throw new HttpError(
          400,
          "VALIDATION",
          `invalid fields: ${fieldsValidation.errors
            .map((e) => `[${e.index}] ${e.reason}`)
            .join("; ")}`,
        );
      }
      const fields: BindingField[] = fieldsValidation.fields;

      // Parse uiSchema (optional, defaults to {})
      const fieldKeys = new Set(fields.map((f) => f.key));
      const uiSchema = parseUiSchema(body["uiSchema"], fieldKeys);

      // Parse edit request
      const editRequest = parseEditRequest(body["edit"]);

      // Authz check (→ 403 if role process_designer missing, review R-1).
      // Same ordering as binding.ts: 401 → 400 (validation) → 403 → operation.
      await authorizeEditor(pool, urlParts.tenantId, actorId);

      // T-0520 [D7-5]: classifyFloorBoundary — content gate (R-1..R-4) BEFORE applying.
      // Extends the lexical WRONG_FLOOR guard in validateFloor1Request with a content-aware
      // check: even if kind is Floor-1 lexically, the actual diff / doc might carry a
      // code-signal or dangling fieldKey → Floor-2 (fail-up, spec §3.2).
      //
      // op.doc comes from body.doc (optional FormDocument from FormDesigner / agent).
      // changedKeys is derived from the edit request's own key(s) (R-2 whitelist check).
      const rawDoc = (body as Record<string, unknown>)["doc"];
      const opDoc: FormDocument | undefined =
        rawDoc !== undefined && rawDoc !== null && typeof rawDoc === "object" && !Array.isArray(rawDoc)
          ? (rawDoc as FormDocument)
          : undefined;

      // Derive changedKeys from the edit request for R-2 (whitelist of declarative slots).
      const changedKeys = deriveChangedKeys(editRequest);

      // BLOCKING #1 fix (adversarial review): R-4 (named-binding integrity) MUST validate
      // the document's KEY_SET against the AUTHORITATIVE live registry_def.record_schema
      // (DB), NOT against body.fields[] — the same untrusted request that carries `doc`.
      // Sourcing fieldKeys from body.fields[] would let an attacker who controls both
      // whitelist a dangling key (spec §3 R-4 lines 92-103 / §4.1 lines 164-166).
      //
      // When a `doc` IS present, resolve the live schema from DB inside a tenant-tx and
      // build LiveSchemaView from it. Fail-closed when the live schema is unresolvable.
      // When NO `doc` is present, R-4 is vacuous (empty KEY_SET) — the edit's own fieldKey
      // is validated by applyFloor1Edit's UNKNOWN_FIELD check against the stateless body.fields
      // (Mode A contract). No DB read is needed in that case.
      let liveFieldKeys: string[];
      if (opDoc !== undefined) {
        // A document is being validated → R-4 needs the authoritative live schema.
        if (!pool) {
          // No DB wired → cannot resolve the authoritative schema → fail-closed.
          throw new HttpError(
            409,
            "WRONG_FLOOR",
            `Document validation requires a live record_schema but no database is wired; ` +
              `fail-closed → Floor-2 path required (T-0520).`,
          );
        }
        const resolved = await withTenantTx(pool, urlParts.tenantId, (client) =>
          resolveLiveSchemaFieldKeys(client, urlParts.tenantId, urlParts.processKey),
        );
        if (resolved === null) {
          // Live schema unresolvable (no registry_def for this process) → fail-closed.
          throw new HttpError(
            409,
            "WRONG_FLOOR",
            `Document cannot be validated against a live record_schema for process ` +
              `"${urlParts.processKey}" (no registry binding). Fail-closed → Floor-2 path required (T-0520).`,
          );
        }
        liveFieldKeys = [...resolved];
      } else {
        // No doc → R-4 KEY_SET is empty → live schema irrelevant; pass an empty projection.
        liveFieldKeys = [];
      }

      const schemaView: LiveSchemaView = {
        fieldKeys: liveFieldKeys,
      };
      const floorOp: FloorEditOp = {
        kind: editRequest.kind,
        changedKeys,
        doc: opDoc,
      };
      const floorResult = classifyFloorBoundary(floorOp, schemaView);
      if (floorResult.floor === "2") {
        // Fail-up: content gate detected Floor-2 signal (code / dangling binding / unknown key).
        // If the route is 'sandbox', the operation should go through the Floor-2 authoring path
        // (validateFloor2Descriptor / T-0076). This endpoint is Floor-1 only → 409.
        throw new HttpError(
          409,
          "WRONG_FLOOR",
          `Edit classified as Floor-2 (content gate, T-0520). Reasons: ${floorResult.reasons.join("; ")}. ` +
            `Use the Floor-2 authoring path (route: ${floorResult.route}).`,
        );
      }

      // Apply transformation (pure core — includes validateFloor1Request)
      const result = applyFloor1Edit(editRequest, fields, uiSchema);

      if (!result.ok) {
        // Map Floor1ValidationError codes to HTTP status codes
        const firstError = result.errors[0];
        if (firstError === undefined) {
          throw new HttpError(400, "VALIDATION", "edit validation failed");
        }

        if (firstError.code === "WRONG_FLOOR") {
          throw new HttpError(409, "WRONG_FLOOR", firstError.message);
        }

        if (firstError.code === "UNKNOWN_FIELD") {
          throw new HttpError(
            422,
            "UNKNOWN_FIELD",
            result.errors.map((e) => e.message).join("; "),
          );
        }

        throw new HttpError(
          400,
          "VALIDATION",
          result.errors.map((e) => e.message).join("; "),
        );
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          fields: result.fields,
          uiSchema: result.uiSchema,
        }),
      );
    }),
  );
}
