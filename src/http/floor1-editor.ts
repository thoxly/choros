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
 *          404 NOT_FOUND     — binding not found
 *
 * CONTRACT (ADR §4 / §9.1):
 *   - Stateless: request body carries current {fields, uiSchema}; response
 *     carries transformed {fields, uiSchema}. No separate form_def table (deferred
 *     T-0125). Persistence is the caller's responsibility.
 *   - classifyAuthoringFloor() gate: kind in FLOOR2_EDIT_KINDS → 409 WRONG_FLOOR.
 *   - checkBindingCompat() is called after transformation to assert fields ↔ bpmnVars
 *     are still aligned (only relevant when fields[] is mutated, i.e. relabel_field /
 *     toggle_required). For hide/show/help/reorder (ui-schema only), checkBindingCompat
 *     is a no-op pass-through (fields unchanged — keys ≡ original → ok:true).
 *   - Auth via x-dev-user convention (same as binding.ts / invoke.ts).
 *   - Tenant isolation: tenantId validated as UUID; withTenantTx only when reading
 *     the binding from DB (optional read-through path). In stateless-body mode,
 *     no DB read is needed — the client supplies both fields and uiSchema.
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
 *   - No second permission mechanism.
 *   - No ambient DATABASE_URL required for npm test (Mode A is pure).
 *   - Imports only: router, auth, floor1-editor core, binding-compat core.
 */

import type { IncomingMessage } from "node:http";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import {
  validateFloor1Request,
  applyFloor1Edit,
  type Floor1EditRequest,
  type FieldUiMeta,
  type FormUiSchema,
} from "../core/floor1-editor.js";
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

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
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
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the Floor-1 editor route on the given router.
 *
 * No pg.Pool required: Mode A (stateless body) is purely functional.
 * The route can be wired unconditionally in server.ts (no grantsPool dependency).
 */
export function registerFloor1EditorRoutes(router: Router): void {
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
  router.register(
    "POST",
    "/tenants/:tenantId/processes/:processKey/forms/:formKey/edits",
    async (req, res, _params) => {
      // Auth check
      const _actorId = extractActor(req);

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
    },
  );
}
