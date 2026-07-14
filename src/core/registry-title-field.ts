/**
 * src/core/registry-title-field.ts — T-0613: title-field heuristic for the
 * assistant's registry digest (столп 6 — ассистент в контуре).
 *
 * THE DEFECT this closes (LIVE_PROOF T-0607): `loadReadableRegistryDigest`
 * (src/db/registry-digest-dao.ts) picked its per-record "sample" value as the
 * FIRST scalar property in `record.data`'s key-insertion order — with no
 * regard for what that field actually IS. For a registry whose schema
 * happened to list a code/number-shaped field before its name/title field,
 * the digest showed the assistant (and, through it, the user) a code value
 * as if it were the record's human-readable label. The record's actual name
 * could sit two keys later in the same object and never surface.
 *
 * NO EXISTING REUSABLE SIGNAL (researched before writing this module):
 *   - `registry_def` / `record_schema` has NO registry-level "title field"
 *     annotation anywhere in this codebase (no `title_field`, `x-title-field`,
 *     `display_field`, `primary_field` column or JSON-Schema keyword). Grepped
 *     the whole repo — zero hits.
 *   - The closest EXISTING convention is the frontend's `deriveRecordLabel`
 *     (web/src/screens/records-form.js, T-0447; reused by kanban's
 *     `resolveCardLabel`, T-0626): "first non-empty string/number in
 *     record.data, by key order". That function is SCHEMA-BLIND (it only
 *     ever sees `record.data`, never `record_schema`) — it has the EXACT SAME
 *     defect this task closes (a code/number-shaped field can win if it's
 *     first). It is therefore NOT a signal to reuse; copying it here would
 *     just relocate the bug from data-scan-order-only to a differently-broken
 *     data-scan-order-only. This module is deliberately schema-AWARE (the
 *     digest DAO already has `record_schema` in scope — see
 *     `pickNumericFieldKeys` in visible-aggregate.ts for the sibling
 *     precedent of a schema-aware, per-registry field pick), which is
 *     information `deriveRecordLabel` never had.
 *   - `x-relation`'s per-FORM-NODE `displayField` (form-document.js /
 *     floor-boundary.ts) is a DIFFERENT concept: an author's per-widget
 *     choice of which field of a RELATED registry to show in one relation
 *     picker instance. It is not a registry-level default and is not read
 *     here (this module walks `record_schema.properties`, not a form
 *     document).
 *   - FINDINGS (see PR handoff): an explicit registry-level title-field
 *     annotation (e.g. `x-title-field` on `record_schema`, settable from the
 *     registry editor UI) would let step (1) below fire before the
 *     name-shaped-key guess, and would let a tenant override the guess for a
 *     registry whose true title field isn't named/typed conventionally. Out
 *     of scope here — flagged as a follow-up, not invented as a silent
 *     side-effect of this fix.
 *
 * THE HEURISTIC (in order — first hit wins):
 *   1. An EXPLICIT registry-level title-field signal, if the schema carries
 *      one (`record_schema["x-title-field"]`, a string field key). No such
 *      annotation is written anywhere today, so this step is a no-op in
 *      practice — but the DAO passes whatever's on the schema, so a future
 *      registry editor can start setting it WITHOUT touching this module's
 *      call sites again (forward-compatible, not speculative code — this
 *      branch is exercised by a unit test using a synthetic schema).
 *   2. A property whose KEY resembles a title/name field — matched against a
 *      small, generic set of conventional key names (English + Russian
 *      "name"/"title"/"display_name" spellings; tenant-authored schemas are
 *      free to use any key, so this is a best-effort GUESS over the SHAPE of
 *      the key, never a business-domain literal — D-064 anti-case: no
 *      case-specific field name/value from any real registry appears here).
 *   3. The FIRST property (schema order) whose derived FieldType
 *      (`deriveFieldType`, field-type-dictionary.ts — the SAME canonical
 *      dictionary `pickNumericFieldKeys` and the form layer use) is a plain
 *      textual type (`"text"` or `"textarea"`) — i.e., explicitly NOT
 *      number/boolean/enum/date/url/email/person/multi-select. This is what
 *      keeps an ИНН-shaped code field (typically `type:number` or a
 *      `format`-tagged string) from ever winning by schema-order accident.
 *   4. `undefined` — no schema-derived candidate. THE CALLER (registry-digest
 *      -dao.ts) keeps its current data-only fallback (first non-empty string
 *      scalar, then any scalar) for this case — this module never guesses
 *      blindly over `data`; that responsibility stays exactly where it lives
 *      today (`pickSampleValue`).
 *
 * PURE, IO-FREE (D-064/NF-1): no pg, no http, no fs. Independently unit
 * tested — src/core/__tests__/registry-title-field.test.ts.
 */

import { deriveFieldType, type JsonSchemaProperty } from "./field-type-dictionary.js";

// ---------------------------------------------------------------------------
// Conventional title-ish key names (GENERIC shapes, not tenant data — D-064).
// ---------------------------------------------------------------------------

/**
 * Key names conventionally used for a record's human-readable title, across
 * both English- and Russian-authored schemas. This is a SHAPE guess (which
 * key names commonly denote "the name of this thing"), not a business-domain
 * literal — it names no entity, no field belonging to any specific registry.
 */
const TITLE_LIKE_KEYS = [
  "title",
  "name",
  "display_name",
  "displayname",
  "label",
  "наименование",
  "название",
  "имя",
  "заголовок",
];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function isTitleLikeKey(key: string): boolean {
  const norm = normalizeKey(key);
  return TITLE_LIKE_KEYS.includes(norm);
}

// ---------------------------------------------------------------------------
// Shape of record_schema as far as this module cares.
// ---------------------------------------------------------------------------

interface RecordSchemaLike {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  /**
   * Step (1): an explicit registry-level title-field annotation, if present.
   * Not written anywhere today (see module header) — read defensively.
   */
  readonly "x-title-field"?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// pickTitleFieldKey
// ---------------------------------------------------------------------------

/**
 * Pick the registry's title-field KEY from its `record_schema`, per the
 * heuristic above (steps 1-3). Returns `null` when no schema-derived
 * candidate exists (malformed/absent schema, no properties, no textual
 * field at all) — the caller then falls back to its existing data-only pick.
 *
 * Never throws.
 */
export function pickTitleFieldKey(recordSchema: unknown): string | null {
  if (!isPlainObject(recordSchema)) return null;
  const schema = recordSchema as RecordSchemaLike;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return null;
  const propKeys = Object.keys(properties);
  if (propKeys.length === 0) return null;

  // --- Step 1: explicit registry-level title-field annotation -------------
  const explicit = schema["x-title-field"];
  if (typeof explicit === "string" && explicit.length > 0 && propKeys.includes(explicit)) {
    return explicit;
  }

  // --- Step 2: a property whose key resembles a title/name field ----------
  for (const key of propKeys) {
    if (isTitleLikeKey(key)) return key;
  }

  // --- Step 3: first plain-textual property (schema order) ----------------
  for (const key of propKeys) {
    const prop = properties[key];
    if (!isPlainObject(prop)) continue;
    const fieldType = deriveFieldType(prop as JsonSchemaProperty);
    if (fieldType === "text" || fieldType === "textarea") return key;
  }

  // --- Step 4: no schema-derived candidate ---------------------------------
  return null;
}

// ---------------------------------------------------------------------------
// deriveSafeRecordTitle / GENERIC_RECORD_TYPE_LABEL — T-0756 [E16 §6], reused
// verbatim by T-0769.
//
// Extracted from process-projection.ts (T-0756's original home) so this IS the
// single authority for "what is this record's human title" — every reader that
// needs a record's SAFE display title (never an arbitrary data-order scan)
// calls THIS function, built on the SAME `pickTitleFieldKey` heuristic above.
// T-0769 (столп 4 анти-UUID) reuses it unchanged for the audit journal's
// record-resolver.ts batch (a SECOND caller, not a second heuristic) —
// process-projection.ts's resolveSourceRecordProjection (per-record, PDP-aware)
// remains the FIRST caller, now importing from here instead of holding its own
// private copy.
// ---------------------------------------------------------------------------

/** Generic fallback type label — a domain-neutral noun, not a case literal (D-064). */
export const GENERIC_RECORD_TYPE_LABEL = "Запись";

/**
 * Derive the SAFE human title of a record: the schema-designated title field's
 * value (via pickTitleFieldKey), else a neutral `«{typeLabel} · <id8>»`. NEVER
 * scans data in key order for an arbitrary first field (that could surface a
 * non-title/sensitive value) — only the deliberately designated field.
 */
export function deriveSafeRecordTitle(
  data: unknown,
  recordSchema: unknown,
  recordId: string,
  typeLabel: string,
): string {
  const obj = isPlainObject(data) ? data : {};
  const key = pickTitleFieldKey(recordSchema);
  if (key !== null) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  const short = recordId.length >= 8 ? recordId.slice(0, 8) : recordId;
  return typeLabel.length > 0 ? `${typeLabel} · ${short}` : short;
}
