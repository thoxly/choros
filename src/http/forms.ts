/**
 * src/http/forms.ts
 *
 * T-0102 · E9: Form submission with SERVER-SIDE field validation.
 * T-0251 · E9: PERSIST submitted record on success (in-memory mode).
 *
 * Registers:
 *   POST /api/forms/:formId/submit
 *     Body: the submitted field values (a JSON object).
 *     → 200 { ok: true, formId, value, recordId }
 *                                            value = SANITIZED payload
 *                                            (only schema-declared fields).
 *                                            recordId = the persisted record's id.
 *       400 VALIDATION                     — envelope carries field-level errors
 *                                            in `error.fields` (FieldError[]).
 *       401 UNAUTHENTICATED                — missing x-dev-user (dev auth mode).
 *       404 UNKNOWN_FORM                   — :formId is not a registered form.
 *       400 INVALID_JSON / 413 …           — from readJsonBody (router.ts).
 *
 * CONTRACT — "форма не доверяет клиенту" (claude-design-prompts.md Промпт 3,
 * «бэкенд-валидация»). The form-js UI renders inside an isolated sandbox-iframe;
 * the server NEVER trusts that the client applied the form constraints. It
 * re-validates every field against the canonical schema (src/core/form-schema.ts)
 * via the pure validator (src/core/form-validator.ts):
 *   - missing required, wrong type, over-length, out-of-range, disallowed enum,
 *     and unknown/extra forged fields are all rejected here;
 *   - on success only the SANITIZED value (schema-declared fields, validated
 *     types) is persisted — a forged extra key never reaches storage.
 *
 * Record store design (T-0251):
 *   In-process in-memory store (mirrors the CLAIMED map in inbox.ts). Each
 *   successful form submit creates a NEW record — including approval-step submits
 *   (approval decision is a separate immutable record; it does NOT mutate the
 *   original purchase record). This keeps the linear ТЭЛ demo simple: every
 *   submit is an append, the records are never updated by this path.
 *
 * Zero external dependencies beyond node:http types + router.ts + the pure core.
 * Auth via the x-dev-user convention (same as inbox.ts / binding.ts). The schema
 * lookup is in-process and pure, so no DB is required for validation or storage.
 */
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { validateFormSubmission, type FieldError } from "../core/form-validator.js";
import { getFormDef } from "../core/form-schema.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// In-memory record store (T-0251)
// Maps recordId → stored form record. Process-lifetime only — survives across
// requests in a running server (mirrors the CLAIMED map in inbox.ts pattern).
// A real implementation would write to a DB records table; the in-process
// contract is identical (same HTTP shape, same error codes).
// ---------------------------------------------------------------------------

interface FormRecord {
  recordId: string;
  formId: string;
  submittedBy: string;
  submittedAt: number;
  schema_version: number;
  data: Record<string, unknown>;
}

const RECORDS: Map<string, FormRecord> = new Map();

/**
 * Current schema version for new records.
 * Version 1 = initial record shape (all form fields as validated by form-validator).
 * Increment when the stored shape changes incompatibly (T-0085 ADR §3.5).
 */
const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Error envelope (extends the router's {error:{code,message}} with field errors)
// ---------------------------------------------------------------------------

function sendValidationErrors(res: import("node:http").ServerResponse, fields: FieldError[]): void {
  const body = JSON.stringify({
    error: {
      code: "VALIDATION",
      message: "form validation failed",
      fields,
    },
  });
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFormsRoutes(router: Router): void {
  // POST /api/forms/:formId/submit
  router.register("POST", "/api/forms/:formId/submit", withAuth(async (req, res, params) => {
    // Authn: mode-aware (T-0327) — keycloak → JWT sub; dev → x-dev-user.
    const authCtx = getAuthContext(req);
    let devUserId: string;
    if (authCtx !== undefined) {
      devUserId = authCtx.sub;
    } else {
      let h = req.headers[DEV_USER_HEADER];
      if (Array.isArray(h)) h = h[0];
      if (!h || typeof h !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      devUserId = h;
    }

    const formId = params["formId"] as string;

    // Unknown form → 404 (distinct from a malformed body for a known form).
    if (!getFormDef(formId)) {
      throw new HttpError(404, "UNKNOWN_FORM", `unknown form '${formId}'`);
    }

    // readJsonBody enforces size limits + JSON syntax (400 INVALID_JSON / 413).
    const payload = await readJsonBody(req);

    // The server is the source of truth: re-validate every field against the
    // canonical schema, independent of any client-side constraints.
    const result = validateFormSubmission(formId, payload);
    if (!result.ok) {
      sendValidationErrors(res, result.errors);
      return;
    }

    // Persist the sanitized value as a new record (T-0251).
    // Each submit is an append — approval-step submits create a NEW record rather
    // than mutating the purchase record (simplest model for the linear ТЭЛ demo).
    const recordId = randomUUID();
    const record: FormRecord = {
      recordId,
      formId,
      submittedBy: devUserId,
      submittedAt: Date.now(),
      schema_version: CURRENT_SCHEMA_VERSION,
      data: result.value as Record<string, unknown>,
    };
    RECORDS.set(recordId, record);

    // Response contract (frozen): { ok, formId, value, recordId }
    // value = sanitized payload (schema-declared, validated fields only).
    // recordId = the id of the persisted record (additive — clients that ignore
    // it remain compatible).
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, formId, value: result.value, recordId }));
  }));
}

// ---------------------------------------------------------------------------
// Test seams (T-0251)
// Not called from production code. Mirror the inbox.ts pattern.
// ---------------------------------------------------------------------------

/**
 * Retrieve a stored record by id. Returns undefined if not found.
 * Used by e2e tests to assert persistence without a real DB.
 */
export function _getRecordForTests(recordId: string): FormRecord | undefined {
  return RECORDS.get(recordId);
}

/**
 * Reset in-memory record store between tests.
 * Not called from production code.
 */
export function _resetRecordStoreForTests(): void {
  RECORDS.clear();
}
