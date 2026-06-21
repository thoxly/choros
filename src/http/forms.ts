/**
 * src/http/forms.ts
 *
 * T-0102 · E9: Form submission with SERVER-SIDE field validation.
 * T-0251 · E9: PERSIST submitted record on success (in-memory mode — now with
 *              real-DB path wired in T-0337 [E15-S4]).
 * T-0336 · E15-S2: In-memory RECORDS Map REMOVED (doctrine §3.3 fix — state
 *              lost on restart must not be treated as source of truth).
 * T-0337 · E15-S4: Forms-from-schema.
 *   - FormPersistPort / FormStoreDeps injected at registration time.
 *   - When a pool is present (DATABASE_URL), server.ts wires the real DB
 *     persister (makeFormRecordPersister → choros.record in a tenant-scoped tx).
 *   - When no deps are injected (memory mode / tests without a live DB), the
 *     memoryPersist no-op is used: it mints a UUID for the response contract
 *     but does NOT build an authoritative in-memory Map (T-0336 doctrine §3.3).
 *   - The submit response contract is UNCHANGED: { ok, formId, value, recordId }.
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
 * Zero external dependencies beyond node:http types + router.ts + the pure core.
 * Auth via the x-dev-user convention (same as inbox.ts / binding.ts). The schema
 * lookup is in-process and pure, so no DB is required for validation or storage.
 */
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  validateFormSubmissionAgainst,
  type FieldError,
} from "../core/form-validator.js";
import { getFormDef, type FormDef } from "../core/form-schema.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// FormPersistPort — the minimal persistence contract (T-0337 E15-S4)
//
// Injected at registration time. The composition root wires either:
//   - the real DB path: makeFormRecordPersister (pool + resolveActorTenant),
//     which persists to choros.record in a tenant-scoped tx.
//   - the no-op memory fallback (memoryPersist below): used when no pool is
//     available. Mints a recordId for the response contract but does NOT store
//     it in an authoritative in-process Map (T-0336 doctrine §3.3 — lost-on-
//     restart state must not be treated as source of truth).
//
// This port is intentionally minimal — it only needs to:
//   1. Persist the validated record data under the actor's tenant (DB path)
//      OR acknowledge with a synthetic id (no-DB path).
//   2. Return a stable recordId.
//   3. Not touch the HTTP request/response (that stays in the route handler).
// ---------------------------------------------------------------------------

/**
 * Persist a validated form submission as a record in the data store.
 *
 * @param actorSlug  - the authenticated actor (dev-user slug or OIDC sub)
 * @param formId     - the form id ("purchase" | "approval")
 * @param data       - the SANITIZED form payload (validated by form-validator.ts)
 * @returns recordId - the server-minted UUID of the persisted record
 *
 * Throws on any persistence error (the route handler propagates it as 500).
 */
export type FormPersistPort = (
  actorSlug: string,
  formId: string,
  data: Record<string, unknown>,
) => Promise<string>;

/**
 * Resolve the authoritative FormDef for a given formId by deriving it from
 * the registry's record_schema (T-0345 — single source of truth).
 *
 * @param formId    - the form id to resolve ("purchase" | "approval" | dynamic)
 * @param actorSlug - the authenticated actor slug (needed to resolve the tenant
 *                    and then look up the registry_def in that tenant's scope)
 *
 * Returning null means the formId is not in the registry (404 path).
 * Returning a FormDef means the registry schema governs validation.
 *
 * When this port is wired (DB mode), validation in the route handler uses the
 * derived FormDef instead of the hardcoded form-schema.ts definition, making
 * the registry's record_schema the live source of truth for field acceptance.
 */
export type FormDefResolver = (formId: string, actorSlug: string) => Promise<FormDef | null>;

/**
 * Optional deps injected by the composition root (server.ts) when a DB pool
 * is available. When absent, the route uses the no-op memory fallback.
 */
export interface FormStoreDeps {
  /** Real DB persistence — wired when DATABASE_URL is present. */
  readonly persist: FormPersistPort;
  /**
   * T-0345: optional resolver that derives FormDef from the registry's
   * record_schema. When present, the route handler uses the derived FormDef
   * for validation (single source of truth). When absent, falls back to the
   * hardcoded getFormDef from form-schema.ts.
   */
  readonly resolveFormDef?: FormDefResolver;
}

// ---------------------------------------------------------------------------
// T-0336 (E15-S2): In-memory RECORDS Map REMOVED.
//
// Record reads/writes go through the real DB record store (src/http/records.ts)
// or the S1 applier (T-0335), NOT an in-process mirror.
//
// The form submit handler produces a `recordId` (UUID) for the response contract.
// In DB mode (pool present), persistence goes through FormPersistPort → choros.record.
// In no-DB / memory mode, the no-op memoryPersist below mints a UUID for the
// response shape without building a persistent authoritative Map.
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

/**
 * No-op memory-mode persist (T-0337 / T-0336 doctrine reconciliation).
 *
 * Used when no DB pool is injected (tests, no DATABASE_URL). Mints a UUID so
 * the response contract { ok, formId, value, recordId } is satisfied, but does
 * NOT insert into any authoritative in-process Map — consistent with T-0336's
 * doctrine §3.3 (lost-on-restart state must not be treated as source of truth).
 *
 * Tests that need to assert record persistence after a form submit should use
 * DB-backed fitness tests (ci/checks/db/records_crud.test.ts).
 */
function memoryPersist(
  _actorSlug: string,
  _formId: string,
  _data: Record<string, unknown>,
): Promise<string> {
  // No authoritative Map — T-0336 doctrine §3.3.
  // Mint a recordId for the response contract only.
  void (CURRENT_SCHEMA_VERSION satisfies number); // keep const referenced
  return Promise.resolve(randomUUID());
}

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
// T-0369: HTML form string coercion (pre-validation pass)
//
// HTML forms (including sandbox-iframe FormViewer) submit ALL values as strings
// because <input type="number"> serialises its value as a string in the body.
// The form-validator.ts remains strict (a number field MUST receive a JS number).
// This coercion pass bridges the gap: it converts incoming string values to their
// declared types BEFORE validation, while preserving the validator's strict
// semantics for already-typed values and non-coercible strings.
//
// Rules:
//   "number" field : string → Number() if result is finite; empty/non-numeric →
//                    leave as-is (validator will reject with WRONG_TYPE).
//                    Already a number → unchanged.
//   "boolean" field: "true"/"false" (case-insensitive) → boolean literal.
//                    Anything else → unchanged (validator rejects).
//   All other types: untouched (string stays string, etc.).
//
// The coerced payload is what gets VALIDATED and PERSISTED, so DMN routing on
// numeric fields (e.g. amount > threshold) works correctly.
// ---------------------------------------------------------------------------

/**
 * Strict numeric string test: only accepts finite-number representations.
 * Uses Number() (not parseFloat) so "6m" or " " do NOT coerce.
 * Empty string, whitespace-only, and non-numeric strings return false.
 */
function isFiniteNumberString(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed === "") return false;
  const n = Number(trimmed);
  return Number.isFinite(n);
}

/**
 * Pre-validation coercion pass (T-0369).
 *
 * Iterates over DECLARED FormDef fields only and coerces incoming string values
 * to the field's declared JS type. Unknown/extra keys (forged fields) are left
 * untouched — the validator's UNKNOWN_FIELD check handles them downstream.
 *
 * @param formDef - the resolved FormDef (declares field types)
 * @param payload - the raw JSON object from readJsonBody
 * @returns a new object with coerced values for declared fields; other keys
 *          are preserved unchanged so the validator can reject them.
 */
function coerceFormPayload(
  formDef: FormDef,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...payload };

  for (const field of formDef.fields) {
    const raw = payload[field.key];
    if (typeof raw !== "string") continue; // already typed or absent — skip

    switch (field.type) {
      case "number": {
        if (isFiniteNumberString(raw)) {
          coerced[field.key] = Number(raw.trim());
        }
        // Non-numeric / empty strings: leave as-is → WRONG_TYPE from validator.
        break;
      }
      case "boolean": {
        const lower = raw.toLowerCase();
        if (lower === "true") {
          coerced[field.key] = true;
        } else if (lower === "false") {
          coerced[field.key] = false;
        }
        // Other strings: leave as-is → WRONG_TYPE from validator.
        break;
      }
      default:
        // text / textarea / date / enum: no coercion needed (already strings).
        break;
    }
  }

  return coerced;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the form submit endpoint.
 *
 * @param router  - the HTTP router
 * @param deps    - optional: when present, the real DB persist port is used
 *                  (form submit writes to choros.record in a tenant-scoped tx).
 *                  When absent (undefined), falls back to the no-op memoryPersist
 *                  (mints a UUID, no authoritative in-process store — T-0336 §3.3).
 *                  Tests call createServer without deps → memory fallback → green
 *                  without DB.
 */
export function registerFormsRoutes(router: Router, deps?: FormStoreDeps): void {
  // Resolve the persist function: real DB or no-op memory fallback.
  const persist: FormPersistPort = deps?.persist ?? memoryPersist;
  // T-0345: optional resolver that derives FormDef from the registry's record_schema.
  const resolveFormDef: FormDefResolver | undefined = deps?.resolveFormDef;

  // POST /api/forms/:formId/submit
  router.register("POST", "/api/forms/:formId/submit", withAuth(async (req, res, params) => {
    // Authn: mode-aware (T-0327) — keycloak → JWT sub; dev → x-dev-user.
    const authCtx = getAuthContext(req);
    let actorSlug: string;
    if (authCtx !== undefined) {
      actorSlug = authCtx.sub;
    } else {
      let h = req.headers[DEV_USER_HEADER];
      if (Array.isArray(h)) h = h[0];
      if (!h || typeof h !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
      actorSlug = h;
    }

    const formId = params["formId"] as string;

    // Unknown form → 404 (distinct from a malformed body for a known form).
    // In DB mode: try resolveFormDef first (derives from registry record_schema).
    // In memory mode: fall back to hardcoded getFormDef from form-schema.ts.
    let activeFormDef: FormDef | null;
    if (resolveFormDef !== undefined) {
      // T-0345: DB-mode path — form schema derived from registry_def.record_schema.
      // This is the single source of truth: registry governs what fields are valid.
      activeFormDef = await resolveFormDef(formId, actorSlug);
    } else {
      // Memory-mode fallback: hardcoded form-schema.ts (ТЭЛ demo / tests).
      activeFormDef = getFormDef(formId);
    }

    if (!activeFormDef) {
      throw new HttpError(404, "UNKNOWN_FORM", `unknown form '${formId}'`);
    }

    // readJsonBody enforces size limits + JSON syntax (400 INVALID_JSON / 413).
    const rawPayload = await readJsonBody(req);

    // T-0369: coerce string values from HTML form submission (sandbox iframe)
    // to their declared field types BEFORE validation. form-validator.ts remains
    // strict; this pass only converts numeric/boolean strings for declared fields.
    // Non-coercible strings (e.g. "abc" for a number field) are left unchanged
    // so the validator still returns WRONG_TYPE.
    const payload =
      rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? coerceFormPayload(activeFormDef, rawPayload as Record<string, unknown>)
        : rawPayload;

    // The server is the source of truth: re-validate every field against the
    // canonical schema, independent of any client-side constraints.
    // T-0345: in DB mode, `activeFormDef` is derived from registry_def.record_schema
    // (the authoritative schema); in memory mode it is the hardcoded bootstrap.
    const result = validateFormSubmissionAgainst(activeFormDef, payload);
    if (!result.ok) {
      sendValidationErrors(res, result.errors);
      return;
    }

    // Persist the sanitized value (T-0251 / T-0337).
    // DB mode (deps.persist wired): writes to choros.record in a tenant-scoped tx
    //   with audit event (makeFormRecordPersister in server.ts).
    //   The persister also re-validates against record_schema via validateFormSubmissionAgainst
    //   (T-0345 doctrine §3 enforcement — second layer inside the tx).
    // No-DB mode (no deps): memoryPersist mints a UUID for the response contract
    //   without an authoritative in-process Map (T-0336 doctrine §3.3).
    const sanitizedData = result.value as Record<string, unknown>;
    const recordId = await persist(actorSlug, formId, sanitizedData);

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
