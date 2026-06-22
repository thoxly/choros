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
 * It reads the single source of truth — the binding-contract catalog
 * (src/core/binding-contract-catalog.ts, PD-18) — so there is ONE place that
 * decides field→control, shared across every schema-driven form path.
 */

import {
  resolvePresentation,
  getBindingContract,
  deriveContractFromFieldType,
} from '../../../src/core/binding-contract-catalog.js';

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
  if (typeof field?.contract === 'string') {
    contractKind = field.contract;
  } else if (hasOptions) {
    // Options present but no explicit contract → it's an enum (the snapshot bug fix).
    contractKind = 'enum';
  } else {
    contractKind = deriveContractFromFieldType(
      normaliseTypeToFieldType(field?.type),
    ).kind;
  }

  const descriptor = getBindingContract(contractKind);
  const presentation = resolvePresentation(contractKind, field?.presentation);
  return {
    contractKind: descriptor.kind,
    presentation,
    descriptor,
    editable: descriptor.editable,
  };
}
