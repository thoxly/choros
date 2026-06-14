/**
 * src/http/forms.ts
 *
 * T-0102 · E9: Form submission with SERVER-SIDE field validation.
 *
 * Registers:
 *   POST /api/forms/:formId/submit
 *     Body: the submitted field values (a JSON object).
 *     → 200 { ok: true, formId, value }   — value is the SANITIZED payload
 *                                            (only schema-declared fields).
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
 *     types) is echoed/persisted — a forged extra key never survives.
 *
 * Zero external dependencies beyond node:http types + router.ts + the pure core.
 * Auth via the x-dev-user convention (same as inbox.ts / binding.ts). The schema
 * lookup is in-process and pure, so no DB is required for validation.
 */
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import { validateFormSubmission, type FieldError } from "../core/form-validator.js";
import { getFormDef } from "../core/form-schema.js";

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
  router.register("POST", "/api/forms/:formId/submit", async (req, res, params) => {
    // Authn: dev auth mode requires x-dev-user (mirrors inbox claim write-path).
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) devUserId = devUserId[0];
    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
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

    // Success: echo ONLY the sanitized value (schema-declared, validated fields).
    // A real impl would complete the User Task / persist result.value here; the
    // contract (sanitized, server-validated payload) is identical.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, formId, value: result.value }));
  });
}
