/**
 * src/core/binding-contract-catalog.ts — T-0399 [D7-K]
 *
 * THE FINITE CATALOG OF TYPED BINDING CONTRACTS (PD-18).
 *
 * The system owns a CLOSED set of typed *binding contracts* — not a catalog of
 * visuals. A binding contract describes HOW a form/widget field binds to the
 * data/process layer: which schema slot it occupies and which presentation
 * modes it supports. Visual widgets (Gantt, kanban, calendar) are Floor-2 agent
 * code rendered OVER these contracts, never beside them (PD-18 §Следствие).
 *
 * This module is the SINGLE SOURCE OF TRUTH consumed by:
 *   1. the unified field renderer (web/src/forms/field-renderer.jsx) — picks the
 *      control + presentation for a BindingField from its contract;
 *   2. the form-binding authoring side (form_binding.fields carries the contract
 *      + presentation + options — see binding-compat.ts BindingField);
 *   3. (later) Floor-2 widgets — consume the catalog, do not invent a vocabulary.
 *
 * Relationship to the EXISTING field-type-dictionary.ts:
 *   field-type-dictionary.ts owns the SCALAR-level FieldType vocabulary
 *   ("text" | "textarea" | "number" | "date" | "enum" | "boolean") that the
 *   JSON-Schema validation layer speaks. A BindingContract is a HIGHER-LEVEL
 *   classification: the scalar field types all map to the `scalar`/`enum`
 *   contracts, while the structural contracts (`relation`, `collection`,
 *   `date-range`, `money`, `file`, `rollup`, `matrix-lookup`) describe shapes the
 *   flat JSON-Schema scalar vocabulary cannot express on its own. The catalog
 *   does NOT replace field-type-dictionary.ts — it sits above it and references
 *   it (deriveContractFromFieldType).
 *
 * SCOPE (D7-K): this module DEFINES the catalog and the mapping from the existing
 * FieldType vocabulary to a contract. It does NOT implement runtime submit-time
 * validation (D7-2) nor the data-access mediator (D7-3); those consume this
 * catalog later. The structural contracts beyond scalar/enum are declared here so
 * the renderer + Floor-2 have a stable target, but their authoring UI / DDL is
 * delivered by D7-6/D7-7/D7-8.
 *
 * Pure data + pure functions — no I/O, no DB, no network, no env reads.
 * Mirrors the purity discipline of field-type-dictionary.ts / binding-compat.ts.
 */

import type { FieldType } from "./field-type-dictionary.js";

// ---------------------------------------------------------------------------
// The finite contract vocabulary (PD-18 — frozen, closed set)
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of binding-contract kinds. New kinds are added here (and only
 * here); a widget/renderer that needs a kind not in this union is a design error
 * that must be resolved by extending the catalog, not by inventing a local type.
 *
 *   scalar        — a single primitive value (text / number / boolean / date /
 *                   textarea). The default contract for a flat JSON-Schema field.
 *   enum          — a single value constrained to a fixed option list.
 *   multi-select  — an array of values chosen from a fixed option list.
 *   relation      — a reference to a record in another application (cross_app_ref).
 *   collection     — a one-to-many set of child rows (line-items).
 *   date-range    — a pair of dates (start / end), bound as one logical field.
 *   money         — a currency amount (value + currency code).
 *   file          — an uploaded file / attachment handle.
 *   rollup        — a read-only aggregate derived from related records (sum/count/…).
 *   matrix-lookup — a value looked up from a 2-axis table (a normative rule).
 *   person        — a reference to an employee (stores the employee id as a string).
 */
export type BindingContractKind =
  | "scalar"
  | "enum"
  | "multi-select"
  | "relation"
  | "collection"
  | "date-range"
  | "money"
  | "file"
  | "rollup"
  | "matrix-lookup"
  | "person";

/** All contract kinds, in catalog order. */
export const BINDING_CONTRACT_KINDS: readonly BindingContractKind[] = [
  "scalar",
  "enum",
  "multi-select",
  "relation",
  "collection",
  "date-range",
  "money",
  "file",
  "rollup",
  "matrix-lookup",
  "person",
];

// ---------------------------------------------------------------------------
// Presentation modes
// ---------------------------------------------------------------------------

/**
 * A presentation mode is how a contract is rendered. A given contract declares
 * which modes it supports; the renderer (and Floor-2) MUST pick one of the
 * declared modes — it cannot present a contract in an unsupported mode.
 *
 * Scalar/enum modes are the editable form controls today; the structural
 * contracts also declare read/widget modes that Floor-2 consumes.
 */
export type PresentationMode =
  | "text"          // single-line text input
  | "textarea"      // multi-line text input
  | "number"        // numeric input
  | "checkbox"      // boolean checkbox
  | "date"          // date picker
  | "select"        // dropdown (enum)
  | "radio"         // radio group (enum)
  | "multi-select"  // multi-checkbox group (multi-select — array of enum values)
  | "reference"     // record-picker (relation)
  | "table"         // editable child-row table (collection)
  | "range"         // two-date range picker (date-range)
  | "money"         // amount + currency (money)
  | "file"          // file upload control (file)
  | "readout"       // read-only computed value (rollup / matrix-lookup)
  | "person"        // employee picker from org (person — stores employee id)
  | "url"           // URL input (<input type="url">)
  | "email";        // email input (<input type="email">)

// ---------------------------------------------------------------------------
// The schema slot a contract binds to
// ---------------------------------------------------------------------------

/**
 * Which slot of the data schema a contract occupies. This tells the data layer
 * (and D7-2/D7-3) how to read/write the value.
 *
 *   property     — a single record_schema property (scalar / enum / money / file).
 *   foreign-key  — a reference stored as a property holding another record's id
 *                  (relation / matrix-lookup axis).
 *   child-rows   — a one-to-many set stored in a related registry (collection).
 *   derived      — a read-only value computed from related rows; not stored
 *                  directly on the record (rollup / matrix-lookup result).
 *   property-pair — two record_schema properties bound as one logical field
 *                  (date-range = start + end).
 */
export type SchemaSlot =
  | "property"
  | "foreign-key"
  | "child-rows"
  | "derived"
  | "property-pair";

// ---------------------------------------------------------------------------
// The contract descriptor
// ---------------------------------------------------------------------------

/**
 * One entry in the catalog: a fully-described binding contract.
 *
 *   kind          — the contract kind (the key into the catalog).
 *   schemaSlot    — which schema slot it binds to.
 *   presentations — the presentation modes it supports (non-empty).
 *   defaultPresentation — the mode the renderer picks if a BindingField does not
 *                   override it; always a member of `presentations`.
 *   editable      — whether the contract produces an editable form control
 *                   (false for read-only computed contracts → renderer shows a
 *                   readout, never an input that would silently discard edits).
 *   label         — human-readable label (Russian product copy).
 *   summary       — one-line description of what the contract binds.
 */
export interface BindingContractDescriptor {
  readonly kind: BindingContractKind;
  readonly schemaSlot: SchemaSlot;
  readonly presentations: readonly PresentationMode[];
  readonly defaultPresentation: PresentationMode;
  readonly editable: boolean;
  readonly label: string;
  readonly summary: string;
}

/**
 * THE CATALOG. A frozen map kind → descriptor. This is the single source of
 * truth: the renderer and Floor-2 read from here, never from a local copy.
 */
export const BINDING_CONTRACT_CATALOG: Readonly<
  Record<BindingContractKind, BindingContractDescriptor>
> = Object.freeze({
  scalar: {
    kind: "scalar",
    schemaSlot: "property",
    presentations: ["text", "textarea", "number", "checkbox", "date", "url", "email"],
    defaultPresentation: "text",
    editable: true,
    label: "Значение",
    summary: "Одно простое значение (текст, число, дата, да/нет, URL, email).",
  },
  enum: {
    kind: "enum",
    schemaSlot: "property",
    presentations: ["select", "radio"],
    defaultPresentation: "select",
    editable: true,
    label: "Список",
    summary: "Значение из фиксированного набора вариантов.",
  },
  relation: {
    kind: "relation",
    schemaSlot: "foreign-key",
    presentations: ["reference"],
    defaultPresentation: "reference",
    editable: true,
    label: "Связь",
    summary: "Ссылка на запись из другого приложения (cross_app_ref).",
  },
  collection: {
    kind: "collection",
    schemaSlot: "child-rows",
    presentations: ["table"],
    defaultPresentation: "table",
    editable: true,
    label: "Список строк",
    summary: "Набор дочерних строк один-ко-многим (позиции).",
  },
  "date-range": {
    kind: "date-range",
    schemaSlot: "property-pair",
    presentations: ["range"],
    defaultPresentation: "range",
    editable: true,
    label: "Период",
    summary: "Пара дат «начало–конец» как одно поле.",
  },
  money: {
    kind: "money",
    schemaSlot: "property",
    presentations: ["money"],
    defaultPresentation: "money",
    editable: true,
    label: "Сумма",
    summary: "Денежная сумма (значение и валюта).",
  },
  // T-0512: multi-select — array of enum values chosen from a fixed option set.
  "multi-select": {
    kind: "multi-select",
    schemaSlot: "property",
    presentations: ["multi-select"],
    defaultPresentation: "multi-select",
    editable: true,
    label: "Мультивыбор",
    summary: "Несколько значений из фиксированного набора вариантов.",
  },
  // T-0512: person — selects an employee from the org; stores the employee id as a string.
  person: {
    kind: "person",
    schemaSlot: "property",
    presentations: ["person"],
    defaultPresentation: "person",
    editable: true,
    label: "Сотрудник",
    summary: "Ссылка на сотрудника организации (хранит id сотрудника).",
  },
  file: {
    kind: "file",
    schemaSlot: "property",
    presentations: ["file"],
    defaultPresentation: "file",
    editable: true,
    label: "Файл",
    summary: "Загружаемый файл / вложение.",
  },
  rollup: {
    kind: "rollup",
    schemaSlot: "derived",
    presentations: ["readout"],
    defaultPresentation: "readout",
    editable: false,
    label: "Итог",
    summary: "Только чтение: агрегат по связанным записям (сумма/количество).",
  },
  "matrix-lookup": {
    kind: "matrix-lookup",
    schemaSlot: "derived",
    presentations: ["readout"],
    defaultPresentation: "readout",
    editable: false,
    label: "Норматив",
    summary: "Только чтение: значение из таблицы 2×по осям (правило норматива).",
  },
});

// ---------------------------------------------------------------------------
// FieldType → contract mapping
// ---------------------------------------------------------------------------

/**
 * Map a scalar FieldType (from field-type-dictionary.ts) to the contract kind +
 * presentation it implies. The flat JSON-Schema vocabulary only ever produces
 * the `scalar` and `enum` contracts; the structural contracts are authored
 * explicitly via the contract field on BindingField (D7-6/7/8), not derived from
 * a scalar type.
 *
 *   text / textarea / number / date / boolean → scalar (presentation per type)
 *   enum                                      → enum   (select)
 *
 * @returns the contract kind and the presentation the FieldType maps to.
 */
export function deriveContractFromFieldType(
  type: FieldType,
): { kind: BindingContractKind; presentation: PresentationMode } {
  switch (type) {
    case "enum":
      return { kind: "enum", presentation: "select" };
    case "boolean":
      return { kind: "scalar", presentation: "checkbox" };
    case "number":
      return { kind: "scalar", presentation: "number" };
    case "date":
      return { kind: "scalar", presentation: "date" };
    case "textarea":
      return { kind: "scalar", presentation: "textarea" };
    case "text":
      return { kind: "scalar", presentation: "text" };
    case "url":
      return { kind: "scalar", presentation: "url" };
    case "email":
      return { kind: "scalar", presentation: "email" };
    case "person":
      return { kind: "person", presentation: "person" };
    case "multi-select":
      return { kind: "multi-select", presentation: "multi-select" };
    default: {
      // Exhaustiveness guard: every FieldType is handled above.
      void (type as never);
      return { kind: "scalar", presentation: "text" };
    }
  }
}

// ---------------------------------------------------------------------------
// Lookups / guards
// ---------------------------------------------------------------------------

/** True iff `value` is a known contract kind. */
export function isBindingContractKind(
  value: unknown,
): value is BindingContractKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(BINDING_CONTRACT_CATALOG, value)
  );
}

/**
 * Look up a contract descriptor by kind. Returns the descriptor, or the `scalar`
 * descriptor as a safe default when the kind is unknown (so the renderer always
 * has a control to fall back to rather than crashing on a stray value).
 */
export function getBindingContract(
  kind: string | undefined,
): BindingContractDescriptor {
  if (kind !== undefined && isBindingContractKind(kind)) {
    return BINDING_CONTRACT_CATALOG[kind];
  }
  return BINDING_CONTRACT_CATALOG.scalar;
}

/**
 * Resolve the presentation mode a renderer should use for a field, given its
 * contract kind and an optional explicit presentation override. If the override
 * is a mode the contract supports, it wins; otherwise the contract's
 * defaultPresentation is used. Never returns a mode the contract does not
 * declare (PD-18: a contract cannot be presented in an unsupported mode).
 *
 * @param kind          contract kind (unknown → treated as `scalar`).
 * @param presentation  the BindingField's presentation override (optional).
 */
export function resolvePresentation(
  kind: string | undefined,
  presentation: string | undefined,
): PresentationMode {
  const contract = getBindingContract(kind);
  if (
    presentation !== undefined &&
    (contract.presentations as readonly string[]).includes(presentation)
  ) {
    return presentation as PresentationMode;
  }
  return contract.defaultPresentation;
}
