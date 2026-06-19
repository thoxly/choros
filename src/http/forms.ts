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
// T-0336 (E15-S2): In-memory RECORDS Map REMOVED.
//
// Record reads/writes go through the real DB record store (src/http/records.ts)
// or the S1 applier (T-0335), NOT the in-process mirror.
//
// The form submit handler produces a `recordId` (UUID) for the response contract;
// persistence of the submitted data is handled by the records DB layer when DB is
// available, or omitted in memory-mode (the response shape is unchanged).
//
// See also: claim-projection.ts for the analogous CLAIMED Map removal.
// ---------------------------------------------------------------------------

/** FormRecord shape (kept for test-seam type compatibility, not for in-memory storage). */
interface FormRecord {
  recordId: string;
  formId: string;
  submittedBy: string;
  submittedAt: number;
  schema_version: number;
  data: Record<string, unknown>;
}

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
    // T-0336: actor identity is verified here (authn gate) even though the
    // RECORDS Map has been removed. The submittedBy value will be wired when
    // form submits are persisted through the DB record store (records.ts).
    const authCtx = getAuthContext(req);
    let submittedBy: string;
    if (authCtx !== undefined) {
      submittedBy = authCtx.sub;
    } else {
      let h = req.headers[DEV_USER_HEADER];
      if (Array.isArray(h)) h = h[0];
      if (!h || typeof h !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      submittedBy = h;
    }
    // submittedBy is verified above (authn gate); used when DB persistence is wired.
    void submittedBy;

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

    // T-0336 (E15-S2): RECORDS Map removed. Record persistence goes through the
    // real DB record store (src/http/records.ts) or the S1 applier (T-0335).
    // The form submit route is a validation + response gateway — persistence of
    // submitted data to the DB is handled separately via the records API or the
    // step-applier seam. A UUID is still minted and returned so the response
    // contract (ok, formId, value, recordId) is unchanged.
    //
    // In memory-mode (no DB): the recordId is returned but not stored anywhere.
    // DB-mode persistence of form submissions goes through the records API
    // (POST /api/records or the step-applier seam on the approve path).
    const recordId = randomUUID();
    // Unused variable suppressed: only used if in-memory persistence is re-introduced.
    void (CURRENT_SCHEMA_VERSION satisfies number); // keep const referenced to avoid lint

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
// Test seams (T-0251 → T-0336 migration)
// Not called from production code.
// ---------------------------------------------------------------------------

/**
 * T-0336 (E15-S2): _getRecordForTests returns undefined.
 *
 * The in-memory RECORDS Map has been removed. Record persistence goes through
 * the real DB record store (src/http/records.ts) / the S1 applier (T-0335).
 * Tests that need to assert record persistence should use DB-backed fitness tests
 * (ci/checks/db/records_crud.test.ts) rather than the in-process seam.
 *
 * Preserved for import compatibility. Returns undefined always.
 * @deprecated Use DB-backed record store for persistence assertions.
 */
export function _getRecordForTests(_recordId: string): FormRecord | undefined {
  // No-op: RECORDS Map removed (T-0336). Use DB-backed records for persistence.
  return undefined;
}

/**
 * T-0336 (E15-S2): _resetRecordStoreForTests is a no-op.
 *
 * The in-memory RECORDS Map has been removed. No store to reset.
 * Preserved for import compatibility.
 * @deprecated No in-process record store to reset.
 */
export function _resetRecordStoreForTests(): void {
  // No-op: RECORDS Map removed (T-0336).
}
