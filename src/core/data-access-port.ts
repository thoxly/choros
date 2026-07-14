/**
 * src/core/data-access-port.ts — T-0401 [D7-3] Data-access mediator: rights + size limits
 *
 * PD-19: widgets (including Floor-2) do NOT talk to the DB directly — they request
 * data from the platform. The platform ALWAYS:
 *   (1) Narrows by actor + tenant (RLS + WHERE), applying field-visibility redaction.
 *   (2) Limits size: page/cursor/limit, max-rows budget, payload cap, hop-cap on
 *       relation traversal (existing HOP_CAP from cross-app-ref.ts).
 *   (3) Routes writes through write-mask validation (checkWriteMask).
 *
 * This module is the PURE type/contract surface:
 *   - ReadRequest / ReadPage / ReadBudget (read API contracts)
 *   - WriteRequest / WriteResult (write API contracts)
 *   - applyFieldVisibilityRedaction — pure helper to apply field-visibility to a
 *     flat JSONB data record (reuses roleFieldVisibility from field-visibility.ts).
 *   - applyWriteMask — pure helper wrapping checkWriteMask
 *   - parsePaginationParams — parse + clamp cursor/limit from URL query params
 *
 * PURITY: no pg, no node:http, no node:fs, no node:net, no node:crypto, no
 * process.env. Edge (HTTP) callers import this; the port itself has no IO.
 *
 * Authority argument:
 *   - Field-visibility redaction: delegates entirely to roleFieldVisibility
 *     (field-visibility.ts T-0081). No second authority path.
 *   - Write-mask: delegates entirely to checkWriteMask (field-mask-guard.ts T-0255).
 *   - Tenant isolation: caller is responsible for running the query inside
 *     withTenantTx (RLS + SET LOCAL choros.tenant_id). This module enforces the
 *     contract shape; physical RLS is the DB layer.
 *   - Hop-cap: reuses HOP_CAP from cross-app-ref.ts (ADR §6); not re-declared here.
 */

// ---------------------------------------------------------------------------
// Imports — ONLY pure core modules (field-visibility + write-mask)
// ---------------------------------------------------------------------------
import {
  roleFieldVisibility,
  type FieldVisibilityPolicy,
  type FieldProjection,
} from "./field-visibility.js";
import {
  checkWriteMask,
  type CheckWriteMaskResult,
} from "../runtime/customer-onboarding/field-mask-guard.js";
import type { Grant } from "./grant-lattice.js";

// ---------------------------------------------------------------------------
// Size limits — query budget (PD-19 §3.3)
// ---------------------------------------------------------------------------

/**
 * Default and ceiling values for paginated list reads.
 *
 * MAX_PAGE_SIZE: the absolute ceiling per page (no single page may exceed this).
 * DEFAULT_PAGE_SIZE: returned when caller omits ?limit=.
 * MAX_ROWS_BUDGET: across all pages in a session (advisory; enforced at read time).
 *
 * These align with PD-20 "оперативная аналитика": teams of ~300 with ~250 processes
 * will rarely see more than a few hundred records per list. 200 rows = 1 dense page.
 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Maximum total rows the port will serve in a single read (across hops is handled
 * by HOP_CAP from cross-app-ref.ts). This is a local page-level guard.
 */
export const MAX_ROWS_BUDGET = MAX_PAGE_SIZE;

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

/**
 * Opaque cursor for keyset pagination on records LIST.
 *
 * Encodes the last row's (created_at, id) pair as base64-JSON so the
 * HTTP layer can pass it opaquely without parsing internals.
 * The records list is ordered by (created_at DESC, id ASC) — matching the
 * existing query ORDER BY in listRecords.
 */
export interface RecordsCursor {
  readonly createdAt: number; // epoch ms
  readonly id: string;        // UUID
}

/**
 * Encode a RecordsCursor to an opaque base64-JSON string.
 * Pure — no IO.
 */
export function encodeRecordsCursor(cursor: RecordsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Decode a base64-JSON cursor string back to a RecordsCursor.
 * Returns null if the string is malformed or missing required fields.
 * Pure — no IO.
 */
export function decodeRecordsCursor(raw: string): RecordsCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as unknown;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as Record<string, unknown>)["createdAt"] !== "number" ||
      typeof (decoded as Record<string, unknown>)["id"] !== "string"
    ) {
      return null;
    }
    const obj = decoded as Record<string, unknown>;
    return {
      createdAt: obj["createdAt"] as number,
      id: obj["id"] as string,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pagination param parsing (shared by both inbox and records)
// ---------------------------------------------------------------------------

/**
 * Parsed pagination params from URL query string.
 *
 * Records: cursor-based (keyset on created_at, id).
 * Inbox: page/limit based (real-time ordered list; no stable keyset).
 */
export interface PaginationParams {
  readonly limit: number;
  /** For records LIST: decoded cursor (null = first page). */
  readonly cursor: RecordsCursor | null;
  /** For inbox LIST: zero-based page number. */
  readonly page: number;
}

/**
 * Parse + clamp pagination params from URLSearchParams.
 *
 * limit: clamped to [1, MAX_PAGE_SIZE], default DEFAULT_PAGE_SIZE.
 * after: decoded as RecordsCursor (ignored if malformed).
 * page: zero-based integer (default 0).
 *
 * Pure — no IO.
 */
export function parsePaginationParams(params: URLSearchParams): PaginationParams {
  // limit
  const rawLimit = params.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) {
      limit = Math.min(Math.max(1, parsed), MAX_PAGE_SIZE);
    }
  }

  // cursor (keyset for records)
  const rawCursor = params.get("after");
  const cursor = rawCursor !== null ? decodeRecordsCursor(rawCursor) : null;

  // page (numeric offset for inbox)
  const rawPage = params.get("page");
  let page = 0;
  if (rawPage !== null) {
    const parsed = parseInt(rawPage, 10);
    if (!isNaN(parsed) && parsed > 0) {
      page = parsed;
    }
  }

  return { limit, cursor, page };
}

// ---------------------------------------------------------------------------
// Read API contracts
// ---------------------------------------------------------------------------

/**
 * Shape returned by the paginated records list endpoint.
 *
 * items: the current page of (field-visibility-redacted) record data.
 * nextCursor: opaque string to pass as ?after= for the next page.
 *             Null when this is the last page.
 * total: total rows matching the filter in this tenant (may be expensive to
 *        compute; optional — pass null when not computed).
 */
export interface RecordsPage<T = unknown> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly limit: number;
}

/**
 * Shape returned by the paginated inbox list endpoint.
 *
 * items: the current page of inbox items.
 * total: total items in the filtered set (for badge counts).
 * page: current zero-based page.
 * totalPages: total pages available.
 */
export interface InboxPage<T = unknown> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Field-visibility redaction (pure helper — reuses T-0081)
// ---------------------------------------------------------------------------

/**
 * Apply field-visibility redaction to a flat JSONB data record.
 *
 * Reuses roleFieldVisibility (field-visibility.ts T-0081) directly.
 * Returns a new object with only the effectiveVisible fields.
 * Redacted fields are PHYSICALLY ABSENT (not null) per ADR §6.1 F-3.
 *
 * @param data            Raw record JSONB data (from DB).
 * @param coveringGrants  The actor's already-resolved covering grants.
 * @param unionVisible    The union-visible field set from grant resolution.
 * @param policy          Which fields are role-scoped.
 * @returns { redacted: object, redactedKeys: string[] }
 */
export function applyFieldVisibilityRedaction(
  data: Record<string, unknown>,
  coveringGrants: Grant[],
  unionVisible: ReadonlySet<string>,
  policy: FieldVisibilityPolicy,
): { redacted: Record<string, unknown>; redactedKeys: string[] } {
  const { effectiveVisible, redactedFields } = roleFieldVisibility(
    coveringGrants,
    unionVisible,
    policy,
  );

  // Build the redacted object: only include keys that are in effectiveVisible.
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (effectiveVisible.has(key)) {
      redacted[key] = value;
    }
  }

  return { redacted, redactedKeys: redactedFields };
}

/**
 * Build a FieldProjection array for a record's data, given the effective field set.
 * Thin wrapper that formats the output for the single-form / widget surface.
 * Reuses serverProjectForm shape (FieldProjection from field-visibility.ts).
 *
 * @param data              Redacted record data (output of applyFieldVisibilityRedaction).
 * @param redactedKeys      Keys that were physically removed.
 * @param fieldLabels       Map of key → display label.
 */
export function buildFieldProjections(
  data: Record<string, unknown>,
  redactedKeys: string[],
  fieldLabels: Record<string, string> = {},
): FieldProjection[] {
  const redactedSet = new Set(redactedKeys);
  const result: FieldProjection[] = [];

  // Surface present (visible) fields
  for (const [key, value] of Object.entries(data)) {
    result.push({ key, visible: true, value });
  }

  // Surface redacted fields (label only, no value)
  for (const key of redactedSet) {
    const label = fieldLabels[key] ?? key;
    result.push({ key, visible: false, redacted: true, label });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Write API contracts — write-mask enforcement
// ---------------------------------------------------------------------------

/**
 * Apply write-mask validation to an incoming record data write.
 * Thin wrapper around checkWriteMask from field-mask-guard.ts.
 *
 * @param writeFacet     The caller's field write-mask allow-list (undefined = whole-resource).
 * @param data           The incoming record data (keys = requested field names).
 * @returns CheckWriteMaskResult — { denied: false } or { denied: true, blockedFields }.
 */
export function applyWriteMask(
  writeFacet: string[] | undefined,
  data: Record<string, unknown>,
): CheckWriteMaskResult {
  const requestedFields = Object.keys(data);
  return checkWriteMask(writeFacet, requestedFields);
}

// ---------------------------------------------------------------------------
// Pagination helpers — slice an in-memory list into a page
// ---------------------------------------------------------------------------

/**
 * Slice an array into a page using page/limit parameters (for inbox).
 * Pure — no IO.
 *
 * @param items  The full (filtered) array of items.
 * @param page   Zero-based page number.
 * @param limit  Items per page.
 * @returns InboxPage<T>
 */
export function paginateInMemory<T>(
  items: T[],
  page: number,
  limit: number,
): InboxPage<T> {
  const total = items.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit);
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const start = safePage * limit;
  const pageItems = items.slice(start, start + limit);

  return {
    items: pageItems,
    total,
    page: safePage,
    totalPages,
    limit,
  };
}
