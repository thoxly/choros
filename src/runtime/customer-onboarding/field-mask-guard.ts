/**
 * src/runtime/customer-onboarding/field-mask-guard.ts — T-0244 AC-9 / §3.5
 *
 * Field-mask enforcement for customer-subscription record updates.
 *
 * CONTEXT (ADR §3.5):
 *   `circuit_id` and `activation_key_issued_at` are written ONLY by the
 *   "Выпустить ключ" (Issue Key) process step (system actor). A `vendor-admin`
 *   attempting to set these fields via a direct record-update MUST be denied.
 *
 *   Mechanism: the vendor-admin grant carries a `resourceFacet` with a write-mask
 *   that EXCLUDES these two fields. When the caller supplies a requestedFields set
 *   that includes a field absent from the grant's write-facet → DENIED.
 *
 *   This module provides:
 *     1. `SYSTEM_ONLY_FIELDS` — the frozen set of fields that only a system process
 *        actor may write.
 *     2. `checkWriteMask(grantWriteFacet, requestedFields)` — the pure predicate:
 *        returns `{ denied: false }` when all requested fields are within the
 *        grant's write facet, or `{ denied: true, reason, blockedFields }` when
 *        any requested field is system-only and absent from the write facet.
 *     3. This file is NOT in src/core/ — it sits beside the consumer (issue-key.ts)
 *        in src/runtime/customer-onboarding/ per the F-1/F-2 review fix.
 *
 * Integration with B-11 record-write-path:
 *   When the record-CRUD stack lands (B-11), the call-site (PUT /records/:id) MUST:
 *     (a) resolve the vendor-admin grant's resourceFacet (the write-mask);
 *     (b) call checkWriteMask(grantWriteFacet, requestedFields);
 *     (c) on denied → return HTTP 403 + audit_event(card_action.denied).
 *
 * PURE: no pg / http / fetch / process.env / SDK.
 */

// ---------------------------------------------------------------------------
// SYSTEM_ONLY_FIELDS — frozen set (ADR §3.5)
// ---------------------------------------------------------------------------

/**
 * Fields that may ONLY be written by the system process actor (Issue Key step).
 * A vendor-admin write request including any of these fields MUST be denied by PDP.
 */
export const SYSTEM_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "circuit_id",
  "activation_key_issued_at",
]);

// ---------------------------------------------------------------------------
// CheckWriteMaskResult
// ---------------------------------------------------------------------------

export type CheckWriteMaskResult =
  | { denied: false }
  | { denied: true; reason: "system_field_write_blocked"; blockedFields: string[] };

// ---------------------------------------------------------------------------
// checkWriteMask — pure field-mask enforcement predicate (AC-9)
// ---------------------------------------------------------------------------

/**
 * Pure predicate: returns `denied=true` when the caller's `requestedFields`
 * include a system-only field that is NOT present in the grant's `writeFacet`.
 *
 * @param writeFacet    - the field names the caller's grant allows writing.
 *                        `undefined` = whole-resource write (system-actor path):
 *                        ALL fields are writable → never denied.
 *                        An explicit `string[]` (vendor-admin path) restricts
 *                        the writable surface — system-only fields absent from
 *                        this set are blocked.
 * @param requestedFields - the field names the caller wants to write.
 */
export function checkWriteMask(
  writeFacet: string[] | undefined,
  requestedFields: readonly string[],
): CheckWriteMaskResult {
  // System actor: whole-resource write (no facet restriction) → always allowed.
  if (writeFacet === undefined) {
    return { denied: false };
  }

  const allowedSet = new Set(writeFacet);
  const blocked: string[] = [];

  for (const field of requestedFields) {
    // If the field is system-only AND not in the grant's write facet → blocked.
    if (SYSTEM_ONLY_FIELDS.has(field) && !allowedSet.has(field)) {
      blocked.push(field);
    }
  }

  if (blocked.length > 0) {
    return { denied: true, reason: "system_field_write_blocked", blockedFields: blocked };
  }

  return { denied: false };
}
