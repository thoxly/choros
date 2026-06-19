/**
 * src/http/forms.ts
 *
 * T-0102 · E9: Form submission with SERVER-SIDE field validation.
 * T-0251 · E9: PERSIST submitted record on success (in-memory mode — now with
 *              real-DB path wired in T-0337 [E15-S4]).
 * T-0337 · E15-S4: Forms-from-schema.
 *   - The in-memory RECORDS Map is the fallback store (used when no DB pool
 *     is injected, i.e. "memory" mode for tests). When a FormStoreDeps is
 *     provided at registration (composition root: DATABASE_URL present), submit
 *     persists the record via the real DB record store (records.ts createRecord /
 *     the S1 applier path) in a tenant-scoped tx.
 *   - FormStoreDeps carries the FormPersistPort — a minimal port the form submit
 *     route calls to persist. The composition root (server.ts) wires the real
 *     createRecord function here; the in-memory fallback wires a RECORDS Map shim.
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
import { validateFormSubmission, type FieldError } from "../core/form-validator.js";
import { getFormDef } from "../core/form-schema.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// FormPersistPort — the minimal persistence contract (T-0337 E15-S4)
//
// Injected at registration time. The composition root wires either:
//   - the real DB path: createRecord from records.ts (pool + resolveActorTenant)
//   - the in-memory fallback (RECORDS Map): used when no pool is available
//
// This port is intentionally minimal — it only needs to:
//   1. Persist the validated record data under the actor's tenant
//   2. Return a stable recordId
//   3. Not touch the HTTP request/response (that stays in the route handler)
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
 * Optional deps injected by the composition root (server.ts) when a DB pool
 * is available. When absent, the route uses the in-memory RECORDS Map fallback.
 */
export interface FormStoreDeps {
  /** Real DB persistence — wired when DATABASE_URL is present. */
  readonly persist: FormPersistPort;
}

// ---------------------------------------------------------------------------
// In-memory record store (T-0251 / T-0337 fallback)
// Maps recordId → stored form record. Process-lifetime only — survives across
// requests in a running server. Used when no FormStoreDeps is injected (memory
// mode or tests without a live DB). The real DB path (FormStoreDeps.persist)
// bypasses this map entirely.
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

// In-memory persist implementation (fallback when no pool is available).
function memoryPersist(
  actorSlug: string,
  formId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const recordId = randomUUID();
  const record: FormRecord = {
    recordId,
    formId,
    submittedBy: actorSlug,
    submittedAt: Date.now(),
    schema_version: CURRENT_SCHEMA_VERSION,
    data,
  };
  RECORDS.set(recordId, record);
  return Promise.resolve(recordId);
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
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the form submit endpoint.
 *
 * @param router  - the HTTP router
 * @param deps    - optional: when present, the real DB persist port is used;
 *                  when absent (undefined), falls back to the in-memory RECORDS Map.
 *                  Tests call `createServer(undefined, undefined, "memory")` which
 *                  omits deps → in-memory fallback → tests stay green without DB.
 */
export function registerFormsRoutes(router: Router, deps?: FormStoreDeps): void {
  // Resolve the persist function: real DB or in-memory fallback.
  const persist: FormPersistPort = deps?.persist ?? memoryPersist;

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

    // Persist the sanitized value (T-0251 / T-0337).
    // When deps.persist is the real DB path (T-0337), this writes to the entity
    // store in a tenant-scoped tx with audit event (records.ts createRecord pattern).
    // When no deps are injected (memory mode), the in-memory RECORDS Map is used.
    const sanitizedData = result.value as Record<string, unknown>;
    const recordId = await persist(devUserId, formId, sanitizedData);

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
// These operate on the in-memory RECORDS Map (the fallback used in tests).
// When the real DB persist is wired, these seams see no entries (the DB has them).
// ---------------------------------------------------------------------------

/**
 * Retrieve a stored record by id. Returns undefined if not found.
 * Used by e2e tests to assert persistence without a real DB.
 * Only covers in-memory store entries (memory mode / fallback).
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
