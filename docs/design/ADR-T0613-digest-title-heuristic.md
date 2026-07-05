# ADR-T0613 — Registry digest: schema-aware title-field heuristic

Status: ACCEPTED
Task: T-0613 (bug, столп 6 — ассистент в контуре)
Stems from: LIVE_PROOF T-0607 (assistant registry digest)
Spec: T-0613.spec.md

## Context

`loadReadableRegistryDigest` (src/db/registry-digest-dao.ts, T-0607) gives the
assistant an honest, READ-PDP-scoped digest of the registries an actor may
read: per registry, a display name, slug, readable-record count, and up to
`sampleLimit` short "sample" values meant to answer «как называется хотя бы
одна запись?».

`pickSampleValue` picked the sample as the first non-empty string (else any
scalar) in a record's `data`, in `Object.keys` insertion order — i.e. whatever
order the record's JSON happened to serialize its properties in, with **no
regard for what that field is**. LIVE_PROOF T-0607 surfaced the live defect: a
registry whose schema lists a code/number-shaped field before its actual name
field shows the code to the LLM (and, through the assistant's answer, to the
user) as if it were the record's human-readable title.

## Was there already a reusable "title field" signal?

Researched before writing any new code (per task instruction — reuse, don't
invent):

- **`registry_def`/`record_schema` has no title-field concept at all.**
  Grepped the whole repo for `title_field`, `titleField`, `display_field`,
  `displayField`, `primary_field`, `primaryField`, `label_field`,
  `labelField`, `x-title`, `x-primary`, `x-display` — zero hits, live or dead
  code. There is no DB column, no JSON-Schema keyword, no authoring-UI
  concept of "the title field of this registry".
- **The closest adjacent convention is the frontend's `deriveRecordLabel`**
  (`web/src/screens/records-form.js:1079`, T-0447), reused by three
  independent consumers (relation cell/picker, record list, record detail)
  and, since T-0626, by kanban's `resolveCardLabel` as its empty-`card_fields`
  fallback. Its logic: first non-empty string/number value in `record.data`,
  by key order. This is **schema-blind** — it only ever receives
  `record.data`, never `record_schema` — so it has the **exact same defect**
  this task closes: a code-shaped field can still win purely by data-key
  order. It was therefore **not reused as-is**; doing so would have just
  relocated the bug, not fixed it. (If `deriveRecordLabel` itself needs a
  schema-aware fix, that's a separate frontend task — out of scope here per
  spec.)
- **`displayField`** (`form-document.js` / `floor-boundary.ts`) is a
  different concept entirely: a per-relation-widget author choice of which
  field of a *related* registry to render in one specific relation-picker
  instance in one form document. Not a registry-level default, not consulted
  here.
- **The genuinely reusable piece of infrastructure is `deriveFieldType`**
  (`src/core/field-type-dictionary.ts`, T-0337) — the platform's single
  canonical JSON-Schema-property → FieldType resolver, already reused by
  `pickNumericFieldKeys` (`src/core/visible-aggregate.ts`, T-0587) inside this
  SAME DAO, in this SAME per-registry pass, for the sibling numeric-aggregate
  feature. This ADR's fix follows that exact precedent.

Conclusion: no existing title-field *selector* to reuse, but an existing
field-*type* resolver to build the selector on top of — which is what makes
step (3) below robust (a genuinely textual field, not a same-order accident).

## Decision

New pure, IO-free module `src/core/registry-title-field.ts`, exporting
`pickTitleFieldKey(recordSchema): string | null`. Order (first hit wins):

1. **Explicit registry-level annotation** — `record_schema['x-title-field']`,
   if it is a string naming an existing property. Not written anywhere in the
   platform today (no authoring UI sets it) — this step is a no-op in
   practice, but it means a future registry editor can start setting it
   without any change to this module's call site. Read defensively, unit
   tested against a synthetic schema so the branch isn't dead code.
2. **Name/title-shaped key** — the first property whose *key* (normalized,
   case-insensitive) matches a small generic set of conventional spellings:
   `title`, `name`, `display_name`, `displayname`, `label`, and the Russian
   equivalents `наименование`, `название`, `имя`, `заголовок`. This is a
   shape guess over key *names*, never a business-domain literal — it names
   no entity, no field of any specific registry (D-064 anti-case holds).
3. **First plain-textual field by schema order** — the first property whose
   `deriveFieldType` resolves to `"text"` or `"textarea"` (explicitly *not*
   `"number"`/`"boolean"`/`"enum"`/`"date"`/`"url"`/`"email"`/`"person"`/
   `"multi-select"`). This is what stops a code/number-shaped field (typically
   `type:number`, or a `format`-tagged string) from winning purely because it
   sits earlier in the schema.
4. **`null`** — no schema-derived candidate. The caller (`pickSampleValue`)
   keeps its pre-existing data-only fallback unchanged for this case.

`registry-digest-dao.ts` derives `titleFieldKey` ONCE per registry (same pass
that already derives `numericFields` via `pickNumericFieldKeys`), and
`pickSampleValue(data, titleFieldKey)` tries that key first: if the row's own
`data[titleFieldKey]` is a non-empty string/number/boolean, that's the
sample; otherwise (key absent, or blank/missing for that specific row) it
falls through to the ORIGINAL generic scan, byte-for-byte as before.

## Consequences

- **Backward compatible.** A registry whose schema has no title-field
  candidate at all (no name-shaped key, no plain-textual property — e.g. an
  all-numeric/all-enum schema) produces output identical to pre-T-0613
  behaviour. A row whose data happens to be blank under the resolved title
  key also degrades to the old behaviour for that one row, rather than
  showing an empty sample.
- **No new SQL, no new PDP path.** `record_schema` was already fetched by the
  existing per-registry query; the heuristic runs in memory alongside the
  existing numeric-field derivation.
- **Follow-up, not built here:** an authoring-UI-settable `x-title-field`
  annotation would let a tenant override the guess for a registry whose true
  title field isn't named/typed conventionally (e.g. the only textual field
  is itself a code, and the real "name" is a computed/relation field).
  Flagged in the spec's `key_findings`, not invented as a silent side effect
  of this bug fix.
