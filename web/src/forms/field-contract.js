/**
 * web/src/forms/field-contract.js  (T-0399 · D7-K)
 *
 * Pure, React-free contract-resolution for the unified field renderer. Kept as a
 * plain .js module (like records-form.js / apps-schema.js) so the load-bearing
 * logic — "which binding contract + presentation does this field map to?" — is
 * unit-testable in isolation, without a React runtime. The JSX FieldControl
 * (field-renderer.jsx) imports resolveFieldContract from here and only adds the
 * markup.
 *
 * LAYER BOUNDARY: this module is intentionally self-contained (no cross-boundary
 * import from src/core/). The SERVER-SIDE source of truth for binding contracts
 * is src/core/binding-contract-catalog.ts (PD-18). This client module mirrors the
 * 9 contract kinds and their presentation rules from that catalog. The two MUST be
 * kept in sync: when a new contract kind is added to the server catalog, add it
 * here too. This is acceptable layer separation — ONE client render module + ONE
 * server catalog — not the old "4 client dictionaries" problem (spec §2).
 */

// ---------------------------------------------------------------------------
// Inlined contract catalog (mirrors src/core/binding-contract-catalog.ts PD-18)
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of binding-contract kinds — must stay in sync with
 * BindingContractKind in src/core/binding-contract-catalog.ts.
 *
 * scalar / enum / relation / collection / date-range / money / file /
 * rollup / matrix-lookup
 */
const BINDING_CONTRACT_CATALOG = Object.freeze({
  scalar: {
    kind: 'scalar',
    schemaSlot: 'property',
    presentations: ['text', 'textarea', 'number', 'checkbox', 'date'],
    defaultPresentation: 'text',
    editable: true,
    label: 'Значение',
    summary: 'Одно простое значение (текст, число, дата, да/нет).',
  },
  enum: {
    kind: 'enum',
    schemaSlot: 'property',
    presentations: ['select', 'radio'],
    defaultPresentation: 'select',
    editable: true,
    label: 'Список',
    summary: 'Значение из фиксированного набора вариантов.',
  },
  relation: {
    kind: 'relation',
    schemaSlot: 'foreign-key',
    presentations: ['reference'],
    defaultPresentation: 'reference',
    editable: true,
    label: 'Связь',
    summary: 'Ссылка на запись из другого приложения (cross_app_ref).',
  },
  collection: {
    kind: 'collection',
    schemaSlot: 'child-rows',
    presentations: ['table'],
    defaultPresentation: 'table',
    editable: true,
    label: 'Список строк',
    summary: 'Набор дочерних строк один-ко-многим (позиции).',
  },
  'date-range': {
    kind: 'date-range',
    schemaSlot: 'property-pair',
    presentations: ['range'],
    defaultPresentation: 'range',
    editable: true,
    label: 'Период',
    summary: 'Пара дат «начало–конец» как одно поле.',
  },
  money: {
    kind: 'money',
    schemaSlot: 'property',
    presentations: ['money'],
    defaultPresentation: 'money',
    editable: true,
    label: 'Сумма',
    summary: 'Денежная сумма (значение и валюта).',
  },
  file: {
    kind: 'file',
    schemaSlot: 'property',
    presentations: ['file'],
    defaultPresentation: 'file',
    editable: true,
    label: 'Файл',
    summary: 'Загружаемый файл / вложение.',
  },
  rollup: {
    kind: 'rollup',
    schemaSlot: 'derived',
    presentations: ['readout'],
    defaultPresentation: 'readout',
    editable: false,
    label: 'Итог',
    summary: 'Только чтение: агрегат по связанным записям (сумма/количество).',
  },
  'matrix-lookup': {
    kind: 'matrix-lookup',
    schemaSlot: 'derived',
    presentations: ['readout'],
    defaultPresentation: 'readout',
    editable: false,
    label: 'Норматив',
    summary: 'Только чтение: значение из таблицы 2×по осям (правило норматива).',
  },
});

/** True iff value is a known contract kind. */
function isBindingContractKind(value) {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(BINDING_CONTRACT_CATALOG, value)
  );
}

/**
 * Look up a contract descriptor by kind. Returns the descriptor, or the `scalar`
 * descriptor as a safe default when the kind is unknown.
 */
function getBindingContract(kind) {
  if (kind !== undefined && isBindingContractKind(kind)) {
    return BINDING_CONTRACT_CATALOG[kind];
  }
  return BINDING_CONTRACT_CATALOG.scalar;
}

/**
 * Resolve the presentation mode a renderer should use for a field, given its
 * contract kind and an optional explicit presentation override. If the override
 * is a mode the contract supports, it wins; otherwise the contract's
 * defaultPresentation is used.
 */
function resolvePresentation(kind, presentation) {
  const contract = getBindingContract(kind);
  if (
    presentation !== undefined &&
    contract.presentations.includes(presentation)
  ) {
    return presentation;
  }
  return contract.defaultPresentation;
}

/**
 * Map a scalar FieldType to the contract kind + presentation it implies.
 * Mirrors deriveContractFromFieldType in src/core/binding-contract-catalog.ts.
 * Exported for FormBuilder.jsx which uses it to stamp contract+presentation onto
 * form_binding.fields at save time (the fix for the snapshot enum bug, spec §2).
 *
 *   text / textarea / number / date / boolean → scalar (presentation per type)
 *   enum                                      → enum   (select)
 */
export function deriveContractFromFieldType(type) {
  switch (type) {
    case 'enum':
      return { kind: 'enum', presentation: 'select' };
    case 'boolean':
      return { kind: 'scalar', presentation: 'checkbox' };
    case 'number':
      return { kind: 'scalar', presentation: 'number' };
    case 'date':
      return { kind: 'scalar', presentation: 'date' };
    case 'textarea':
      return { kind: 'scalar', presentation: 'textarea' };
    case 'text':
    default:
      return { kind: 'scalar', presentation: 'text' };
  }
}

// Legacy scalar field "type" strings (record_schema / form_binding vocabulary)
// → canonical FieldType the catalog's deriveContractFromFieldType expects.
// Mirrors field-type-dictionary.normaliseBindingType for the set the
// schema-driven forms actually produce. Unknown → "text" (safe degradation).
export function normaliseTypeToFieldType(type) {
  switch (type) {
    case 'select':
    case 'enum':
      return 'enum';
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
      return 'number';
    case 'date':
      return 'date';
    case 'textarea':
      return 'textarea';
    case 'string':
    case 'text':
    default:
      return 'text';
  }
}

/**
 * Resolve the binding contract + presentation for a renderable field. The
 * explicit `contract` wins; otherwise it's derived from the legacy scalar
 * `type`. A non-empty `options` array forces the `enum` contract even when the
 * legacy type is a bare "string" — this is the fix for the snapshot bug, where
 * an enum's options survived but its type read back as "string" (spec §2).
 *
 * Pure — no React, no I/O.
 *
 * @param {{ type?: string, contract?: string, presentation?: string, options?: string[] }} field
 * @returns {{ contractKind: string, presentation: string, descriptor: object, editable: boolean }}
 */
export function resolveFieldContract(field) {
  const hasOptions = Array.isArray(field?.options) && field.options.length > 0;

  let contractKind;
  // When the contract is derived from the field type (not given explicitly), we
  // also capture the type-specific presentation so that e.g. type="date" renders
  // as "date" and not as the scalar contract's generic default ("text").
  let typePresentation;
  if (typeof field?.contract === 'string') {
    contractKind = field.contract;
  } else if (hasOptions) {
    // Options present but no explicit contract → it's an enum (the snapshot bug fix).
    contractKind = 'enum';
  } else {
    const derived = deriveContractFromFieldType(
      normaliseTypeToFieldType(field?.type),
    );
    contractKind = derived.kind;
    typePresentation = derived.presentation;
  }

  const descriptor = getBindingContract(contractKind);
  // Explicit presentation override wins; when deriving from type, use the
  // type-specific presentation (e.g. "date", "number", "checkbox") rather than
  // the contract's generic default ("text"); for explicit contracts fall back to
  // the contract's defaultPresentation.
  const presentation = resolvePresentation(
    contractKind,
    field?.presentation ?? typePresentation,
  );
  return {
    contractKind: descriptor.kind,
    presentation,
    descriptor,
    editable: descriptor.editable,
  };
}
