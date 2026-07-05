/**
 * web/src/screens/org-crud.js — T-0269
 *
 * Pure, framework-free form-validation + payload-assembly + error-mapping for the
 * org-structure CRUD screen (screen-org.jsx). Kept JSX-free so it is unit-testable
 * in isolation (mirrors apps-validate.js / records-form.js).
 *
 * The slug regex is the EXACT mirror of the backend contract — the seed-write
 * endpoints store `slug` columns under UNIQUE(tenant_id, slug) constraints and the
 * applications route enforces /^[a-z0-9][a-z0-9-]{0,63}$/. The org seed-write
 * endpoints (src/http/seed-write.ts) only assert `typeof slug === "string" &&
 * slug.length > 0`, so they are STRICTLY MORE permissive than this client check;
 * we therefore never reject a slug the server would accept by accident — but to
 * stay consistent with the rest of the constructor (one slug grammar across apps,
 * registries, org) we hold org slugs to the same shape. Client validation is a UX
 * convenience only — the server re-validates and remains the source of truth
 * (400 VALIDATION / 409 CONFLICT).
 *
 * WIRED CONTRACTS (exact, read from src/http/seed-write.ts + src/http/grants.ts):
 *   POST /api/departments       { tenant_id, slug, display_name, parent_id? }      → 201 { id, slug }
 *   POST /api/positions         { tenant_id, department_id, slug, title }          → 201 { id, slug }
 *   POST /api/employees         { tenant_id, position_id?, kind, slug, display_name } → 201 { id, slug }
 *   POST /api/roles             { tenant_id, slug, display_name, description? }     → 201 { id, slug }
 *   POST /api/role-assignments  { employee_id, role_id, org_scope, source, granted_by } → 201 { id, state }
 *   DELETE /api/{departments|positions|employees|roles}/:id  body { tenant_id }     → 200 { id }
 * All write routes require X-Dev-User of the genesis owner (403 NOT_OWNER otherwise).
 */

// EXACT mirror of the constructor slug grammar (src/http/applications.ts SLUG_RE).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DISPLAY_NAME_MAX = 256;

// Employee kinds the backend accepts (src/http/seed-write.ts POST /api/employees).
export const EMPLOYEE_KINDS = ["human", "agent"];

/** Trim helper that tolerates non-strings. */
function str(v) {
  return typeof v === "string" ? v : "";
}

// T-0650 [UX-study §7]: slug is now OPTIONAL — an EMPTY slug means "let the
// server auto-generate one from the entity's name" (SlugField). Only a
// NON-EMPTY slug is grammar-checked; mirrors the server contract
// (src/http/seed-write.ts: blank/absent slug → auto-generate).
function requireSlug(errors, slug) {
  if (slug.length > 0 && !SLUG_RE.test(slug)) {
    errors.slug = "Слаг: строчные латинские буквы, цифры и дефис (1–64 символа)";
  }
}

function requireText(errors, key, value, label) {
  if (value.trim().length === 0) {
    errors[key] = `Укажите: ${label}`;
  } else if (value.length > DISPLAY_NAME_MAX) {
    errors[key] = `${label}: не длиннее ${DISPLAY_NAME_MAX} символов`;
  }
}

// ---------------------------------------------------------------------------
// Per-entity validation. Each returns { valid, errors }.
// ---------------------------------------------------------------------------

/** @param {{slug?,display_name?}} f */
export function validateDepartment(f) {
  const errors = {};
  requireSlug(errors, str(f?.slug));
  requireText(errors, "display_name", str(f?.display_name), "название");
  return { valid: Object.keys(errors).length === 0, errors };
}

/** @param {{department_id?,slug?,title?}} f */
export function validatePosition(f) {
  const errors = {};
  if (str(f?.department_id).length === 0) errors.department_id = "Выберите подразделение";
  requireSlug(errors, str(f?.slug));
  requireText(errors, "title", str(f?.title), "должность");
  return { valid: Object.keys(errors).length === 0, errors };
}

/** @param {{kind?,slug?,display_name?,position_id?}} f — position_id optional. */
export function validateEmployee(f) {
  const errors = {};
  const kind = str(f?.kind);
  if (!EMPLOYEE_KINDS.includes(kind)) errors.kind = "Тип: человек или агент";
  requireSlug(errors, str(f?.slug));
  requireText(errors, "display_name", str(f?.display_name), "имя");
  return { valid: Object.keys(errors).length === 0, errors };
}

/** @param {{slug?,display_name?,description?}} f — description optional. */
export function validateRole(f) {
  const errors = {};
  requireSlug(errors, str(f?.slug));
  requireText(errors, "display_name", str(f?.display_name), "название роли");
  return { valid: Object.keys(errors).length === 0, errors };
}

/** @param {{employee_id?,role_id?,department_id?}} f — department_id scopes the assignment. */
export function validateAssignment(f) {
  const errors = {};
  if (str(f?.employee_id).length === 0) errors.employee_id = "Выберите сотрудника";
  if (str(f?.role_id).length === 0) errors.role_id = "Выберите роль";
  if (str(f?.department_id).length === 0) errors.department_id = "Выберите орг-охват (подразделение)";
  return { valid: Object.keys(errors).length === 0, errors };
}

// ---------------------------------------------------------------------------
// Payload assembly — produces the EXACT body each endpoint expects. Optional
// fields are omitted (not sent as empty strings) so the server's typeof guards
// fall through to their `?? null` defaults.
// ---------------------------------------------------------------------------

/**
 * T-0650 [UX-study §7]: slug is OPTIONAL on every org create payload — an empty
 * slug is OMITTED (not sent as ""), so the server's "blank/absent → auto-generate"
 * branch fires (src/http/seed-write.ts). A non-empty slug is sent as-is
 * (explicit path, validated server-side exactly as before).
 */

/** @returns body for POST /api/departments */
export function buildDepartmentPayload(tenantId, f) {
  const body = {
    tenant_id: tenantId,
    display_name: str(f.display_name).trim(),
  };
  const slug = str(f.slug);
  if (slug.length > 0) body.slug = slug;
  const parent = str(f.parent_id);
  if (parent.length > 0) body.parent_id = parent;
  return body;
}

/** @returns body for POST /api/positions */
export function buildPositionPayload(tenantId, f) {
  const body = {
    tenant_id: tenantId,
    department_id: str(f.department_id),
    title: str(f.title).trim(),
  };
  const slug = str(f.slug);
  if (slug.length > 0) body.slug = slug;
  return body;
}

/** @returns body for POST /api/employees */
export function buildEmployeePayload(tenantId, f) {
  const body = {
    tenant_id: tenantId,
    kind: str(f.kind),
    display_name: str(f.display_name).trim(),
  };
  const slug = str(f.slug);
  if (slug.length > 0) body.slug = slug;
  const pos = str(f.position_id);
  if (pos.length > 0) body.position_id = pos;
  return body;
}

/** @returns body for POST /api/roles */
export function buildRolePayload(tenantId, f) {
  const body = {
    tenant_id: tenantId,
    display_name: str(f.display_name).trim(),
  };
  const slug = str(f.slug);
  if (slug.length > 0) body.slug = slug;
  const desc = str(f.description).trim();
  if (desc.length > 0) body.description = desc;
  return body;
}

/**
 * Build a node-scoped org_scope ScopeElement for a role-assignment, scoped to a
 * department UUID. Matches the exact shape parseScopeElement (src/http/grants.ts)
 * accepts: { kind:"node", hierarchy:"org", nodeId:<deptUuid>, nodeLevel:"department" }.
 */
export function buildOrgScope(departmentId) {
  return {
    kind: "node",
    hierarchy: "org",
    nodeId: departmentId,
    nodeLevel: "department",
  };
}

/**
 * @returns body for POST /api/role-assignments
 * @param {string} grantedBy — the actor's id (sent as granted_by; the server
 *   derives confirmed_by/proposed_by from the authenticated actor, NOT this field).
 */
export function buildAssignmentPayload(f, grantedBy) {
  return {
    employee_id: str(f.employee_id),
    role_id: str(f.role_id),
    org_scope: buildOrgScope(str(f.department_id)),
    source: "manual",
    granted_by: grantedBy,
  };
}

// ---------------------------------------------------------------------------
// Error mapping — honest surfacing of the shared write-route contract.
// 409 → conflict on slug (create flows); 403 → not the genesis owner;
// 404 → entity gone; 401 → re-login; 400 → server VALIDATION message verbatim.
// `field` is set so the screen can attach the message to the right input.
// ---------------------------------------------------------------------------

/**
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @param {string} [entity] human label for the generic fallback ("подразделение", …)
 * @returns {{ field?: string, message: string }}
 */
export function mapOrgError(status, body, entity = "запись") {
  const serverMsg =
    body && typeof body === "object"
      ? (body.error?.message || body.message)
      : undefined;
  const errorCode =
    body && typeof body === "object" ? (body.error?.code || body.code) : undefined;
  if (status === 409) {
    // FK_IN_USE: backend mapped pg 23503 → honest 409 (T-0292).
    // Distinct from CONFLICT (slug duplicate on create).
    if (errorCode === "FK_IN_USE") {
      return {
        message:
          `Не удалось удалить ${entity} — есть связанные записи ` +
          `(должности, сотрудники или назначения ролей). Удалите их сначала.`,
      };
    }
    return { field: "slug", message: "Слаг уже занят в этом тенанте" };
  }
  if (status === 403) {
    return {
      message:
        "Недостаточно прав: создавать/удалять оргструктуру может только владелец тенанта (genesis owner). Войдите как владелец.",
    };
  }
  if (status === 404) {
    return { message: serverMsg || "Запись не найдена (уже удалена?)" };
  }
  if (status === 401) {
    return { message: "Сессия не авторизована — войдите заново" };
  }
  if (status === 400) {
    return { message: serverMsg || "Проверьте корректность полей" };
  }
  // T-0292: backend now maps pg 23503 FK violations → 409 FK_IN_USE (handled above).
  // The 500 branch below is a fallback for unexpected server errors unrelated to FK.
  return { message: serverMsg || `Не удалось сохранить ${entity} (HTTP ${status})` };
}

// ---------------------------------------------------------------------------
// tenant-state indexers — GET /api/org/tenant-state returns UUID rows; the org
// tree (GET /api/org) only exposes slugs. These helpers turn tenant-state rows
// into slug→uuid maps so the screen can resolve the UUIDs the write endpoints need.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{id:string,slug:string}>} rows
 * @returns {Record<string,string>} slug → uuid
 */
export function indexBySlug(rows) {
  const map = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r.slug === "string" && typeof r.id === "string") map[r.slug] = r.id;
    }
  }
  return map;
}
