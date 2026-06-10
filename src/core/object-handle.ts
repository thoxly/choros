/**
 * T-0015: Opaque Object Handles — pure TS, no DB/IO/LLM.
 *
 * Implements the handle reference type, variable-map guard, and resolution
 * port (with a deny-all stub) for E2.4 of the Choros RBAC spine.
 *
 * Core invariant: a process variable / connector I/O / EL operand may hold
 * a handle (an opaque, branded, tenant-scoped reference to a T-0014
 * ResourceRef) or an inert literal, but NEVER a record payload. Opacity is
 * two-edged:
 *  1. The handle type is branded (nominal) — a plain record object is NOT
 *     assignable to ObjectHandle and the handle exposes no field accessor.
 *  2. assertVariableValue() is a runtime structural guard at the variable-write
 *     boundary that rejects record-shaped payloads from untyped/unknown sources.
 *
 * The single edge from handle → record fields is resolveHandle() (the
 * HandleResolver port). T-0015 ships a deny-all default stub; T-0021 (E2.5
 * PDP) swaps it for the real resolver without changing the contract.
 *
 * Semantic contract: §4.2–4.5 of docs/design/T-0015-object-handles.adr.md.
 */

// ---------------------------------------------------------------------------
// Brand symbol — un-forgeable outside this module
// ---------------------------------------------------------------------------

// Using `declare const` means the symbol only exists in the type system.
// The runtime value is emitted via Object.assign in makeHandle / parseHandle.
declare const HANDLE_BRAND: unique symbol;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * T-0014 §5 ResourceRef — re-declared structurally here (T-0014 is design-only,
 * no code yet). When T-0014's ResourceRef ships as code, reconcile to one
 * declaration (T-0053 seam). Identity-only; every component is an immutable UUID.
 */
export type ResourceRef =
  | { kind: "application"; tenantId: string; applicationId: string }
  | {
      kind: "registry";
      tenantId: string;
      applicationId: string;
      registryId: string;
    }
  | {
      kind: "record";
      tenantId: string;
      registryId: string;
      recordId: string;
    };

/**
 * An opaque narrowing token: names a slice/fields of the resource, carries NO
 * record value. Richer facet algebra is deferred to E4.3/T-0033.
 */
export type Facet = { fields: string[] };

/**
 * Branded, structurally-opaque, tenant-scoped reference type.
 *
 * The [HANDLE_BRAND] member makes this a NOMINAL type: a plain record object is
 * NOT assignable to ObjectHandle. The brand is un-forgeable outside this module
 * (the symbol is declared locally; makeHandle/parseHandle are the only minters).
 *
 * There is intentionally NO `data` / `fields` / `payload` / `view` / `snapshot`
 * member. Addressed record fields are accessible ONLY via resolveHandle().
 */
export interface ObjectHandle {
  readonly [HANDLE_BRAND]: true; // nominal brand — un-forgeable opacity
  readonly tenantId: string; // T-0013 key; equals every ref component's tenant
  readonly ref: ResourceRef; // immutable UUID identity (T-0014); never a slug
  readonly handleId: string; // opaque addressing id (== object_handle.id)
  readonly facet?: Facet; // optional opaque narrowing token; names fields only
  // NOTE: there is intentionally NO `data`/`fields`/`payload`/`view` member.
}

/**
 * The subject on whose behalf a handle is resolved. Identity only; grants are
 * looked up live from T-0018 inside the resolver — NOT carried on the handle.
 */
export interface ResolveSubject {
  tenantId: string;
  subjectId: string;
}

/**
 * The grant-filtered record view the gateway returns.
 * denied:true is the fail-closed default (denyAllResolver always returns it).
 */
export type ResolvedView =
  | { denied: true; reason: "no_grant" | "cross_tenant" | "not_found" }
  | { denied: false; ref: ResourceRef; fields: Record<string, unknown> };

/**
 * THE single edge from handle → record fields. T-0021 (E2.5 PDP) implements this.
 * Fail-closed: any subject without a satisfying grant => { denied: true }.
 */
export interface HandleResolver {
  resolveHandle(
    handle: ObjectHandle,
    subject: ResolveSubject,
  ): Promise<ResolvedView>;
}

/**
 * The verdict returned by the variable-map write-boundary guard.
 * ok:false means a record-shaped payload was rejected before storage.
 */
export type VariableValueResult =
  | { ok: true }
  | { ok: false; reason: "record_payload" | "raw_object_with_data" };

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by makeHandle when any tenant-scoped ref component does not match
 * the supplied tenantId (cross-tenant reference rejected at construction).
 */
export class CrossTenantHandleError extends Error {
  constructor(message?: string) {
    super(message ?? "cross-tenant handle: ref component tenant does not match");
    this.name = "CrossTenantHandleError";
    // Fix prototype chain for instanceof checks in down-compiled targets
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by parseHandle when the deserialized ref carries unexpected/extra keys
 * or a record-payload (data/fields/payload/view), i.e. the wire string does not
 * represent a well-formed, identity-only ResourceRef.
 */
export class MalformedHandleError extends Error {
  constructor(message?: string) {
    super(message ?? "malformed handle: ref fails identity-only shape validation");
    this.name = "MalformedHandleError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract all tenant IDs that are present as components of a ResourceRef.
 * Each variant carries exactly the fields described in T-0014 §5.
 */
function refTenantIds(ref: ResourceRef): string[] {
  // All three kinds have tenantId directly
  return [ref.tenantId];
}

/**
 * Deterministic handleId derived from (tenantId, ref, facet) identity.
 * Pure function — no DB, no record read. Equal identity => equal handleId.
 * We use a stable JSON-serialisation + a djb2-style hash to keep it short
 * while being collision-resistant enough for a static-now reference type.
 *
 * The exact algorithm is an implementation detail; the contract is:
 *   makeHandle(ref, t, f).handleId === makeHandle(ref, t, f).handleId  (equal inputs)
 */
function deriveHandleId(
  ref: ResourceRef,
  tenantId: string,
  facet: Facet | undefined,
): string {
  const key = JSON.stringify({
    tenantId,
    ref,
    facet: facet ?? null,
  });
  // djb2 hash over the UTF-16 code units of `key`, hex-encoded (32 hex digits)
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (Math.imul(31, h1) + c) >>> 0;
    h2 = (Math.imul(29, h2) + c) >>> 0;
  }
  // Combine into a 16-hex (8-byte) string — sufficient for a deterministic id
  const part1 = h1.toString(16).padStart(8, "0");
  const part2 = h2.toString(16).padStart(8, "0");
  return `${part1}${part2}`;
}

/**
 * Runtime brand key stored on handle instances.
 * We cannot use the `HANDLE_BRAND` symbol at runtime (it's a `declare const`),
 * so we use a dedicated module-local runtime symbol for the brand check.
 */
const _RUNTIME_BRAND: unique symbol = Symbol("ObjectHandle.brand");

// ---------------------------------------------------------------------------
// Construction & (de)serialization
// ---------------------------------------------------------------------------

/**
 * Reference-only handle constructor.
 *
 * Builds an ObjectHandle from a persisted ResourceRef + tenantId.
 * - NO record read, NO authorization call, NO field reveal.
 * - Rejects cross-tenant refs: if any tenant-scoped ref component !== tenantId,
 *   throws CrossTenantHandleError.
 * - handleId is deterministic over (tenantId, ref, facet) identity.
 */
export function makeHandle(
  ref: ResourceRef,
  tenantId: string,
  facet?: Facet,
): ObjectHandle {
  // Validate tenant binding
  const componentTenants = refTenantIds(ref);
  for (const ct of componentTenants) {
    if (ct !== tenantId) {
      throw new CrossTenantHandleError(
        `cross-tenant handle: ref.tenantId "${ct}" !== supplied tenantId "${tenantId}"`,
      );
    }
  }

  const handleId = deriveHandleId(ref, tenantId, facet);

  // Build the handle. We assign the runtime brand key explicitly so
  // isObjectHandle() can check it, and mark [HANDLE_BRAND] as the typed brand.
  const h = Object.freeze(
    Object.assign(Object.create(null) as object, {
      [_RUNTIME_BRAND]: true,
      tenantId,
      ref,
      handleId,
      ...(facet !== undefined ? { facet } : {}),
    }),
  ) as unknown as ObjectHandle;
  return h;
}

/**
 * Serializes a handle to an identity-only JSON string.
 * The wire form contains ONLY identity (tenantId, ref, handleId, facet).
 * No record field is included; opacity survives the wire.
 */
export function serializeHandle(h: ObjectHandle): string {
  const payload: Record<string, unknown> = {
    tenantId: h.tenantId,
    ref: h.ref,
    handleId: h.handleId,
  };
  if (h.facet !== undefined) {
    payload["facet"] = h.facet;
  }
  return JSON.stringify(payload);
}

/**
 * Validates a raw (deserialized) ref object and reconstructs it from ONLY the
 * known identity fields for its kind. This is fail-closed: any unknown key,
 * any payload-carrying key (data/fields/payload/view), or an unknown kind causes
 * a MalformedHandleError. The reconstructed ref contains exactly the same fields
 * that makeHandle would accept — no more, no less.
 *
 * This guarantees parseHandle cannot smuggle a record payload past the brand.
 */
function validateAndReconstructRef(raw: Record<string, unknown>): ResourceRef {
  // Reject any ref that carries record-payload keys (the smuggling vector)
  const payloadKeys = ["data", "fields", "payload", "view", "snapshot"] as const;
  for (const k of payloadKeys) {
    if (k in raw) {
      throw new MalformedHandleError(
        `malformed handle: ref carries forbidden payload key "${k}"`,
      );
    }
  }

  const kind = raw["kind"];

  if (kind === "application") {
    const tenantId = raw["tenantId"];
    const applicationId = raw["applicationId"];
    if (typeof tenantId !== "string" || typeof applicationId !== "string") {
      throw new MalformedHandleError(
        "malformed handle: application ref missing required identity fields",
      );
    }
    // Reject extra keys beyond the known set
    const knownKeys = new Set(["kind", "tenantId", "applicationId"]);
    for (const k of Object.keys(raw)) {
      if (!knownKeys.has(k)) {
        throw new MalformedHandleError(
          `malformed handle: application ref has unexpected key "${k}"`,
        );
      }
    }
    return { kind: "application", tenantId, applicationId };
  }

  if (kind === "registry") {
    const tenantId = raw["tenantId"];
    const applicationId = raw["applicationId"];
    const registryId = raw["registryId"];
    if (
      typeof tenantId !== "string" ||
      typeof applicationId !== "string" ||
      typeof registryId !== "string"
    ) {
      throw new MalformedHandleError(
        "malformed handle: registry ref missing required identity fields",
      );
    }
    const knownKeys = new Set(["kind", "tenantId", "applicationId", "registryId"]);
    for (const k of Object.keys(raw)) {
      if (!knownKeys.has(k)) {
        throw new MalformedHandleError(
          `malformed handle: registry ref has unexpected key "${k}"`,
        );
      }
    }
    return { kind: "registry", tenantId, applicationId, registryId };
  }

  if (kind === "record") {
    const tenantId = raw["tenantId"];
    const registryId = raw["registryId"];
    const recordId = raw["recordId"];
    if (
      typeof tenantId !== "string" ||
      typeof registryId !== "string" ||
      typeof recordId !== "string"
    ) {
      throw new MalformedHandleError(
        "malformed handle: record ref missing required identity fields",
      );
    }
    const knownKeys = new Set(["kind", "tenantId", "registryId", "recordId"]);
    for (const k of Object.keys(raw)) {
      if (!knownKeys.has(k)) {
        throw new MalformedHandleError(
          `malformed handle: record ref has unexpected key "${k}"`,
        );
      }
    }
    return { kind: "record", tenantId, registryId, recordId };
  }

  throw new MalformedHandleError(
    `malformed handle: unknown ref kind "${String(kind)}"`,
  );
}

/**
 * Parses a serialized handle string back to an ObjectHandle.
 * Re-brands the parsed object; parseHandle(serializeHandle(h)) deep-equals h.
 *
 * Fail-closed: the ref is validated and reconstructed from identity-only fields.
 * Any unknown/extra key or payload-carrying key (data/fields/payload/view) on
 * the ref throws MalformedHandleError. A handle produced by
 * serializeHandle(makeHandle(...)) always round-trips correctly (AC-7).
 */
export function parseHandle(s: string): ObjectHandle {
  const parsed = JSON.parse(s) as Record<string, unknown>;

  const tenantId = parsed["tenantId"];
  const ref = parsed["ref"];
  const handleId = parsed["handleId"];
  const facet = parsed["facet"];

  if (typeof tenantId !== "string") {
    throw new Error("parseHandle: missing or invalid tenantId");
  }
  if (typeof handleId !== "string") {
    throw new Error("parseHandle: missing or invalid handleId");
  }
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error("parseHandle: missing or invalid ref");
  }

  // Validate and reconstruct ref from identity fields only — fail-closed.
  // This is the fix for the payload-smuggling vulnerability (R-1).
  const validatedRef = validateAndReconstructRef(ref as Record<string, unknown>);

  const typedFacet: Facet | undefined =
    facet !== undefined && facet !== null ? (facet as Facet) : undefined;

  const h = Object.freeze(
    Object.assign(Object.create(null) as object, {
      [_RUNTIME_BRAND]: true,
      tenantId,
      ref: validatedRef,
      handleId,
      ...(typedFacet !== undefined ? { facet: typedFacet } : {}),
    }),
  ) as unknown as ObjectHandle;
  return h;
}

// ---------------------------------------------------------------------------
// Type-guard
// ---------------------------------------------------------------------------

/**
 * Nominal type-guard backed by the runtime brand.
 * isObjectHandle(makeHandle(...)) === true
 * isObjectHandle(plainRecordObject) === false
 */
export function isObjectHandle(value: unknown): value is ObjectHandle {
  if (value === null || typeof value !== "object") return false;
  return (value as Record<symbol, unknown>)[_RUNTIME_BRAND] === true;
}

// ---------------------------------------------------------------------------
// Variable-map write-boundary guard
// ---------------------------------------------------------------------------

/**
 * Determines whether `value` looks like a T-0014 record-ref component.
 * A "record-shaped ResourceRef" has kind "record" plus the UUID components.
 */
function isRecordRef(value: Record<string, unknown>): boolean {
  return value["kind"] === "record" && "registryId" in value && "recordId" in value;
}

/**
 * Determines whether `value` looks like a raw registry-record object
 * (an object that carries explicit `data` or `fields` or `payload` alongside
 * a registry/record identity — the kind of raw domain object that must NEVER
 * enter a process variable).
 */
function isRawObjectWithData(value: Record<string, unknown>): boolean {
  return "data" in value || "fields" in value || "payload" in value || "view" in value;
}

/**
 * Structural variable-map write-boundary guard.
 *
 * Accepts:
 *   - an ObjectHandle (isObjectHandle returns true)
 *   - a primitive (string / number / boolean / null / undefined)
 *   - a plain array or plain object whose every member is itself acceptable
 *     AND which is NOT record-shaped
 *
 * Rejects with typed reason:
 *   - "record_payload" — an object carrying a `record`-kind ResourceRef identity
 *     together with a `data`/payload field, OR any object with `data`/`fields`/
 *     `payload`/`view` sibling to a registry+record identity
 *   - "raw_object_with_data" — an object that carries addressed record fields
 *     (has a `data` / `fields` / `payload` / `view` key) even without a full
 *     ResourceRef shape (covers raw registry-record objects)
 *
 * Pure, total, side-effect-free. NEVER stores; only classifies.
 */
export function assertVariableValue(value: unknown): VariableValueResult {
  // Primitives are always ok
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { ok: true };
  }

  // An ObjectHandle is always ok
  if (isObjectHandle(value)) {
    return { ok: true };
  }

  if (Array.isArray(value)) {
    // Arrays are ok as long as every element is ok (no record payloads inside)
    for (const item of value) {
      const r = assertVariableValue(item);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // A record-ref + any payload → record_payload
    if (isRecordRef(obj) && isRawObjectWithData(obj)) {
      return { ok: false, reason: "record_payload" };
    }

    // A record-ref itself (without separate payload key) is suspicious — it IS
    // the identity part of a record-shaped payload even without the data field.
    // A record-kind ResourceRef in a variable is a disallowed raw identity.
    if (isRecordRef(obj)) {
      return { ok: false, reason: "record_payload" };
    }

    // An object with data/fields/payload/view keys is a raw record object
    if (isRawObjectWithData(obj)) {
      return { ok: false, reason: "raw_object_with_data" };
    }

    // Plain structural object — recurse into values
    for (const v of Object.values(obj)) {
      const r = assertVariableValue(v);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  // function, symbol, bigint — not an expected variable type; treat as ok
  // (they are not record-shaped payloads)
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resolution seam (T-0021 implements; deny-all default)
// ---------------------------------------------------------------------------

/**
 * Default HandleResolver that DENIES everything — the fail-closed default.
 * T-0021 (E2.5 PDP) replaces this with the real resolver without changing the
 * HandleResolver contract.
 *
 * resolveHandle(_, _) => { denied: true, reason: "no_grant" }
 */
export const denyAllResolver: HandleResolver = {
  resolveHandle(
    _handle: ObjectHandle,
    _subject: ResolveSubject,
  ): Promise<ResolvedView> {
    return Promise.resolve({ denied: true, reason: "no_grant" });
  },
};
