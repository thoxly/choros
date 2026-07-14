/**
 * web/src/screens/process-catalog.test.js — T-0270, updated T-0351 E16
 *
 * Unit tests for the process-catalog pure logic (process-catalog.js):
 *   - validateBindingForm / buildBindingPayload — exact POST body + required fields;
 *   - T-0351: trigger_type validation + field_mapping_raw parsing + serializeFieldMapping;
 *   - definitionSourceLabel / definitionStatusLabel — honest source/status labels;
 *   - applicationOptions / definitionOptions — defensive option mapping;
 *   - bindingApplicationLabel — honest fallback when the app was deleted (null join);
 *   - triggerTypeLabel — Russian label for trigger_type;
 *   - mapBindingError — surfaces the 404/401/400 contract.
 */

import { describe, it, expect } from 'vitest';
import {
  validateBindingForm,
  buildBindingPayload,
  parseFieldMapping,
  serializeFieldMapping,
  definitionSourceLabel,
  definitionStatusLabel,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  bindingProcessLabel,
  triggerTypeLabel,
  mapBindingError,
  registryTargetOptions,
  findExistingBinding,
  prefillFieldsFromBinding,
  TRIGGER_TYPES,
  // T-0742 (T-0654-c) — catalog card helpers
  bindingsForDefinition,
  processGridDeepLink,
  definitionVersionLabel,
  pluralizeRu,
  instanceCountLabel,
} from './process-catalog.js';

const APP_UUID = 'a0000000-0000-0000-0000-000000000099';

describe('validateBindingForm', () => {
  it('requires process_key and application_id', () => {
    const { valid, errors } = validateBindingForm({});
    expect(valid).toBe(false);
    expect(errors.process_key).toBeTruthy();
    expect(errors.application_id).toBeTruthy();
  });

  it('rejects a non-UUID application_id', () => {
    const { valid, errors } = validateBindingForm({ process_key: 'telLinear', application_id: 'nope' });
    expect(valid).toBe(false);
    expect(errors.application_id).toBeTruthy();
    expect(errors.process_key).toBeUndefined();
  });

  it('accepts a well-formed binding form (form_key optional)', () => {
    const { valid, errors } = validateBindingForm({ process_key: 'telLinear', application_id: APP_UUID });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  // T-0351 E16 trigger_type validation
  it('rejects an unknown trigger_type', () => {
    const { valid, errors } = validateBindingForm({
      process_key: 'p', application_id: APP_UUID, trigger_type: 'invalid_type',
    });
    expect(valid).toBe(false);
    expect(errors.trigger_type).toBeTruthy();
  });

  it('accepts all 4 valid trigger_type values', () => {
    for (const tt of TRIGGER_TYPES) {
      const { valid, errors } = validateBindingForm({ process_key: 'p', application_id: APP_UUID, trigger_type: tt });
      expect(valid).toBe(true);
      expect(errors.trigger_type).toBeUndefined();
    }
  });

  it('accepts empty trigger_type (omitted — backend defaults to launcher)', () => {
    const { valid } = validateBindingForm({ process_key: 'p', application_id: APP_UUID, trigger_type: '' });
    expect(valid).toBe(true);
  });

  // T-0351: field_mapping_raw format validation
  it('rejects field_mapping_raw lines without =', () => {
    const { valid, errors } = validateBindingForm({
      process_key: 'p', application_id: APP_UUID,
      field_mapping_raw: 'amount=summa\nbadline',
    });
    expect(valid).toBe(false);
    expect(errors.field_mapping_raw).toBeTruthy();
  });

  it('accepts well-formed field_mapping_raw', () => {
    const { valid } = validateBindingForm({
      process_key: 'p', application_id: APP_UUID,
      field_mapping_raw: 'amount=summa\napprover=user',
    });
    expect(valid).toBe(true);
  });
});

describe('buildBindingPayload — T-0351 E16 extended contract', () => {
  it('builds the base body, trimming and coercing empty form_key to null', () => {
    const body = buildBindingPayload({ process_key: '  telLinear ', application_id: `  ${APP_UUID} `, form_key: '   ' });
    expect(body.process_key).toBe('telLinear');
    expect(body.application_id).toBe(APP_UUID);
    expect(body.form_key).toBeNull();
  });

  it('keeps a non-empty form_key', () => {
    const body = buildBindingPayload({ process_key: 'p', application_id: APP_UUID, form_key: 'purchase-form' });
    expect(body.form_key).toBe('purchase-form');
  });

  it('includes trigger_type when provided, omits when empty', () => {
    const withTrigger = buildBindingPayload({ process_key: 'p', application_id: APP_UUID, trigger_type: 'on_create' });
    expect(withTrigger.trigger_type).toBe('on_create');

    const withoutTrigger = buildBindingPayload({ process_key: 'p', application_id: APP_UUID, trigger_type: '' });
    expect('trigger_type' in withoutTrigger).toBe(false);
  });

  it('parses field_mapping_raw into a field_mapping object', () => {
    const body = buildBindingPayload({
      process_key: 'p', application_id: APP_UUID,
      field_mapping_raw: 'amount=summa\napprover=responsible',
    });
    expect(body.field_mapping).toEqual({ amount: 'summa', approver: 'responsible' });
  });

  it('produces empty field_mapping for empty field_mapping_raw', () => {
    const body = buildBindingPayload({ process_key: 'p', application_id: APP_UUID });
    expect(body.field_mapping).toEqual({});
  });

  // T-0681 (migration 119): target_registry_slug in the payload.
  it('includes a non-empty target_registry_slug (trimmed)', () => {
    const body = buildBindingPayload({
      process_key: 'p', application_id: APP_UUID, target_registry_slug: '  results-registry  ',
    });
    expect(body.target_registry_slug).toBe('results-registry');
  });

  it('sends target_registry_slug=null when omitted or empty (default-slug path)', () => {
    expect(buildBindingPayload({ process_key: 'p', application_id: APP_UUID }).target_registry_slug).toBeNull();
    expect(
      buildBindingPayload({ process_key: 'p', application_id: APP_UUID, target_registry_slug: '   ' }).target_registry_slug,
    ).toBeNull();
  });
});

// T-0681: registryTargetOptions — options are DATA (this app's real registries).
describe('registryTargetOptions', () => {
  it('maps registry rows to { value: slug, label }', () => {
    const opts = registryTargetOptions([
      { slug: 'results-registry', display_name: 'Результаты' },
      { slug: 'plain-slug' },
    ]);
    expect(opts).toEqual([
      { value: 'results-registry', label: 'Результаты (results-registry)' },
      { value: 'plain-slug', label: 'plain-slug' },
    ]);
  });

  it('is defensive against non-arrays and rows without a slug', () => {
    expect(registryTargetOptions(null)).toEqual([]);
    expect(registryTargetOptions([{ display_name: 'no slug' }, {}])).toEqual([]);
  });
});

// T-0351: parseFieldMapping + serializeFieldMapping round-trip
describe('parseFieldMapping / serializeFieldMapping', () => {
  it('parses one-per-line varName=fieldPath format', () => {
    const m = parseFieldMapping('amount=summa\n  label = name  \nbad');
    // 'bad' has no '=', skipped
    expect(m).toEqual({ amount: 'summa', label: 'name' });
  });

  it('round-trips mapping through serialize → parse', () => {
    const original = { amount: 'summa', approver: 'responsible_user' };
    const serialized = serializeFieldMapping(original);
    const parsed = parseFieldMapping(serialized);
    expect(parsed).toEqual(original);
  });

  it('handles null/undefined gracefully', () => {
    expect(parseFieldMapping('')).toEqual({});
    expect(serializeFieldMapping(null)).toBe('');
    expect(serializeFieldMapping(undefined)).toBe('');
  });
});

describe('definition labels (honest — never "mock")', () => {
  it('maps source modeler/engine to Russian; both are real sources', () => {
    expect(definitionSourceLabel('modeler')).toBe('Конструктор');
    expect(definitionSourceLabel('engine')).toBe('Движок');
  });

  it('maps status draft/published/deployed', () => {
    expect(definitionStatusLabel('draft')).toBe('Черновик');
    expect(definitionStatusLabel('published')).toBe('Опубликован');
    expect(definitionStatusLabel('deployed')).toBe('Развёрнут');
  });
});

describe('applicationOptions / definitionOptions', () => {
  it('maps applications defensively, skipping rows without an id', () => {
    const opts = applicationOptions([
      { id: APP_UUID, display_name: 'CRM' },
      { id: '', display_name: 'broken' },
      null,
      { id: 'b0000000-0000-0000-0000-000000000001', slug: 'only-slug' },
    ]);
    expect(opts).toEqual([
      { value: APP_UUID, label: 'CRM' },
      { value: 'b0000000-0000-0000-0000-000000000001', label: 'only-slug' },
    ]);
  });

  it('maps definitions to key-valued options with name + key label', () => {
    const opts = definitionOptions([
      { process_key: 'telLinear', name: 'Канонический линейный ТЭЛ' },
      { process_key: 'bare' },
      { name: 'no key' },
    ]);
    expect(opts).toEqual([
      { value: 'telLinear', label: 'Канонический линейный ТЭЛ (telLinear)' },
      { value: 'bare', label: 'bare' },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(applicationOptions(null)).toEqual([]);
    expect(definitionOptions(undefined)).toEqual([]);
  });
});

describe('bindingApplicationLabel — honest fallback on deleted app', () => {
  it('prefers application_name, then slug, then an honest "deleted" marker', () => {
    expect(bindingApplicationLabel({ application_name: 'CRM', application_slug: 'crm' })).toBe('CRM');
    expect(bindingApplicationLabel({ application_name: null, application_slug: 'crm' })).toBe('crm');
    expect(bindingApplicationLabel({ application_name: null, application_slug: null })).toBe('(приложение удалено)');
  });
});

// T-0351: triggerTypeLabel
describe('triggerTypeLabel', () => {
  it('returns Russian label for all 4 trigger types', () => {
    expect(triggerTypeLabel('on_create')).toMatch(/создани/i);
    expect(triggerTypeLabel('record_action')).toMatch(/записи/i);
    expect(triggerTypeLabel('launcher')).toMatch(/[Лл]аунчер/i);
    expect(triggerTypeLabel('auto')).toMatch(/[Аа]вто/i);
  });

  it('falls back to a default for unknown types', () => {
    expect(triggerTypeLabel('unknown')).toBeTruthy();
  });
});

describe('mapBindingError', () => {
  it('maps 404 to an application-not-in-tenant field error', () => {
    const m = mapBindingError(404, { error: { message: 'application not found in this tenant' } });
    expect(m.field).toBe('application_id');
    expect(m.message).toMatch(/тенант/i);
  });

  it('maps 401 to a session message', () => {
    expect(mapBindingError(401, null).message).toMatch(/авторизован/i);
  });

  it('maps 400 to the server validation message when present', () => {
    const m = mapBindingError(400, { error: { message: 'process_key must be a non-empty string' } });
    expect(m.message).toBe('process_key must be a non-empty string');
  });

  // T-0681: an unresolvable target registry anchors on the registry field.
  it('maps 400 REGISTRY_NOT_FOUND to the target_registry_slug field', () => {
    const m = mapBindingError(400, {
      error: { code: 'REGISTRY_NOT_FOUND', message: 'target_registry_slug does not name a registry in this application' },
    });
    expect(m.field).toBe('target_registry_slug');
    expect(m.message).toMatch(/registry/i);
  });

  it('falls back generically for unexpected status', () => {
    expect(mapBindingError(500, null).message).toMatch(/HTTP 500/);
  });
});

describe('definition labels (honest — never "mock")', () => {
  it('maps source modeler/engine to Russian; both are real sources', () => {
    expect(definitionSourceLabel('modeler')).toBe('Конструктор');
    expect(definitionSourceLabel('engine')).toBe('Движок');
  });

  it('maps status draft/published/deployed', () => {
    expect(definitionStatusLabel('draft')).toBe('Черновик');
    expect(definitionStatusLabel('published')).toBe('Опубликован');
    expect(definitionStatusLabel('deployed')).toBe('Развёрнут');
  });
});

describe('applicationOptions / definitionOptions', () => {
  it('maps applications defensively, skipping rows without an id', () => {
    const opts = applicationOptions([
      { id: APP_UUID, display_name: 'CRM' },
      { id: '', display_name: 'broken' },
      null,
      { id: 'b0000000-0000-0000-0000-000000000001', slug: 'only-slug' },
    ]);
    expect(opts).toEqual([
      { value: APP_UUID, label: 'CRM' },
      { value: 'b0000000-0000-0000-0000-000000000001', label: 'only-slug' },
    ]);
  });

  it('maps definitions to key-valued options with name + key label', () => {
    const opts = definitionOptions([
      { process_key: 'telLinear', name: 'Канонический линейный ТЭЛ' },
      { process_key: 'bare' },
      { name: 'no key' },
    ]);
    expect(opts).toEqual([
      { value: 'telLinear', label: 'Канонический линейный ТЭЛ (telLinear)' },
      { value: 'bare', label: 'bare' },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(applicationOptions(null)).toEqual([]);
    expect(definitionOptions(undefined)).toEqual([]);
  });
});

describe('bindingApplicationLabel — honest fallback on deleted app', () => {
  it('prefers application_name, then slug, then an honest "deleted" marker', () => {
    expect(bindingApplicationLabel({ application_name: 'CRM', application_slug: 'crm' })).toBe('CRM');
    expect(bindingApplicationLabel({ application_name: null, application_slug: 'crm' })).toBe('crm');
    expect(bindingApplicationLabel({ application_name: null, application_slug: null })).toBe('(приложение удалено)');
  });
});

describe('mapBindingError', () => {
  it('maps 404 to an application-not-in-tenant field error', () => {
    const m = mapBindingError(404, { error: { message: 'application not found in this tenant' } });
    expect(m.field).toBe('application_id');
    expect(m.message).toMatch(/тенант/i);
  });

  it('maps 401 to a session message', () => {
    expect(mapBindingError(401, null).message).toMatch(/авторизован/i);
  });

  it('maps 400 to the server validation message when present', () => {
    const m = mapBindingError(400, { error: { message: 'process_key must be a non-empty string' } });
    expect(m.message).toBe('process_key must be a non-empty string');
  });

  it('falls back generically for unexpected status', () => {
    expect(mapBindingError(500, null).message).toMatch(/HTTP 500/);
  });
});

// T-0684 [capstone T-0647 P1]: the «Связи процессов с приложениями» ПРОЦЕСС column
// resolves the human definition NAME (from the loaded definitions), slug demoted.
// Live capstone finding: the column showed the raw slug (a machine key) as primary.
describe('bindingProcessLabel — human process name primary, slug demoted', () => {
  const defs = [
    { process_key: 'widget-intake-3', name: 'Widget Intake Review' },
    { process_key: 'no-name-key', name: '' },
  ];

  it('resolves the human name as primary and keeps the slug secondary', () => {
    const out = bindingProcessLabel({ process_key: 'widget-intake-3' }, defs);
    expect(out.name).toBe('Widget Intake Review'); // the human name, NOT the slug
    expect(out.name).not.toBe('widget-intake-3');
    expect(out.key).toBe('widget-intake-3');
    expect(out.hasName).toBe(true);
  });

  it('falls back to the raw key ONLY when no matching definition carries a name', () => {
    const missing = bindingProcessLabel({ process_key: 'orphan-key' }, defs);
    expect(missing.name).toBe('orphan-key');
    expect(missing.hasName).toBe(false);
    const noName = bindingProcessLabel({ process_key: 'no-name-key' }, defs);
    expect(noName.name).toBe('no-name-key');
    expect(noName.hasName).toBe(false);
  });

  it('is defensive against missing definitions / fields', () => {
    expect(bindingProcessLabel({ process_key: 'k' }, undefined).hasName).toBe(false);
    expect(bindingProcessLabel({}, defs).name).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// T-0669 (NB-2 fix, T-0681 judge non-blocking finding): findExistingBinding /
// prefillFieldsFromBinding. POST /api/process-app-bindings upserts on
// (process_key, application_id) with ON CONFLICT DO UPDATE SET ... = EXCLUDED —
// re-submitting the bind form for an ALREADY-BOUND pair while it still sits at
// fresh-open defaults silently clears target_registry_slug/trigger_type/etc.
// back to NULL/'launcher'. These two helpers let BindProcessModal detect the
// existing row and pre-fill instead of blind-reset.
// ---------------------------------------------------------------------------
describe('findExistingBinding — resolve an existing row for a (process, app) pair', () => {
  const bindings = [
    { id: 'b1', process_key: 'purchaseApproval', application_id: APP_UUID, target_registry_slug: 'custom-registry' },
    { id: 'b2', process_key: 'otherProcess', application_id: 'a0000000-0000-0000-0000-000000000077' },
  ];

  it('finds the row matching BOTH process_key and application_id', () => {
    const found = findExistingBinding(bindings, 'purchaseApproval', APP_UUID);
    expect(found).not.toBeNull();
    expect(found.id).toBe('b1');
  });

  it('returns null when the pair has no existing binding (fresh bind)', () => {
    expect(findExistingBinding(bindings, 'purchaseApproval', 'a0000000-0000-0000-0000-000000000077')).toBeNull();
    expect(findExistingBinding(bindings, 'brandNewProcess', APP_UUID)).toBeNull();
  });

  it('returns null when either key is empty (nothing picked yet)', () => {
    expect(findExistingBinding(bindings, '', APP_UUID)).toBeNull();
    expect(findExistingBinding(bindings, 'purchaseApproval', '')).toBeNull();
    expect(findExistingBinding(bindings, '', '')).toBeNull();
  });

  it('is defensive against a missing/non-array bindings list', () => {
    expect(findExistingBinding(undefined, 'purchaseApproval', APP_UUID)).toBeNull();
    expect(findExistingBinding(null, 'purchaseApproval', APP_UUID)).toBeNull();
  });
});

describe('prefillFieldsFromBinding — pure projection for the bind-form pre-fill', () => {
  it('projects every upserted column from an existing binding row', () => {
    const binding = {
      form_key: 'purchase-form',
      trigger_type: 'record_action',
      start_form_key: 'purchase-create',
      field_mapping: { amount: 'summa' },
      target_registry_slug: 'custom-registry',
    };
    expect(prefillFieldsFromBinding(binding)).toEqual({
      formKey: 'purchase-form',
      triggerType: 'record_action',
      startFormKey: 'purchase-create',
      fieldMappingRaw: 'amount=summa',
      targetRegistrySlug: 'custom-registry',
    });
  });

  it('a re-submit of the pre-filled values round-trips through buildBindingPayload unchanged (the NB-2 no-op guarantee)', () => {
    const binding = {
      process_key: 'purchaseApproval',
      application_id: APP_UUID,
      form_key: 'purchase-form',
      trigger_type: 'record_action',
      start_form_key: 'purchase-create',
      field_mapping: { amount: 'summa' },
      target_registry_slug: 'custom-registry',
    };
    const prefill = prefillFieldsFromBinding(binding);
    const payload = buildBindingPayload({
      process_key: binding.process_key,
      application_id: binding.application_id,
      form_key: prefill.formKey,
      trigger_type: prefill.triggerType,
      start_form_key: prefill.startFormKey,
      field_mapping_raw: prefill.fieldMappingRaw,
      target_registry_slug: prefill.targetRegistrySlug,
    });
    expect(payload.target_registry_slug).toBe('custom-registry'); // NOT null — the NB-2 bug would send null here
    expect(payload.trigger_type).toBe('record_action');
    expect(payload.start_form_key).toBe('purchase-create');
    expect(payload.field_mapping).toEqual({ amount: 'summa' });
  });

  it('is null-safe: no existing binding (fresh pair) yields the same defaults the form already starts at', () => {
    expect(prefillFieldsFromBinding(null)).toEqual({
      formKey: '',
      triggerType: 'launcher',
      startFormKey: '',
      fieldMappingRaw: '',
      targetRegistrySlug: '',
    });
    expect(prefillFieldsFromBinding(undefined)).toEqual(prefillFieldsFromBinding(null));
  });

  it('a NULL target_registry_slug (default, never set) pre-fills to the empty-string "default" option, not the literal "null"', () => {
    const binding = { process_key: 'p', application_id: APP_UUID, target_registry_slug: null };
    expect(prefillFieldsFromBinding(binding).targetRegistrySlug).toBe('');
  });
});

// ===========================================================================
// T-0742 (T-0654-c) — «Каталог процессов» card helpers
// ===========================================================================

describe('bindingsForDefinition (AC-C4 — collapse the «Связи» table into the card)', () => {
  const bindings = [
    { id: 'b1', process_key: 'alpha', application_id: APP_UUID },
    { id: 'b2', process_key: 'beta', application_id: APP_UUID },
    { id: 'b3', process_key: 'alpha', application_id: APP_UUID },
  ];

  it('returns only the bindings whose process_key matches the definition', () => {
    const rows = bindingsForDefinition(bindings, 'alpha');
    expect(rows.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('returns [] for a definition with no bindings, an empty key, or a non-array', () => {
    expect(bindingsForDefinition(bindings, 'gamma')).toEqual([]);
    expect(bindingsForDefinition(bindings, '')).toEqual([]);
    expect(bindingsForDefinition(null, 'alpha')).toEqual([]);
  });
});

describe('processGridDeepLink (AC-C3 — deep-link into the operator grid)', () => {
  it('builds /processes?definition=<procKey> matching the grid query param', () => {
    expect(processGridDeepLink('purchase-approval')).toBe('/processes?definition=purchase-approval');
  });

  it('URL-encodes a key with unsafe characters', () => {
    expect(processGridDeepLink('a b/c')).toBe('/processes?definition=a%20b%2Fc');
  });
});

describe('definitionVersionLabel (AC-C2 — version badge)', () => {
  it('labels a numeric modeler version', () => {
    expect(definitionVersionLabel({ version: 3 })).toBe('Версия 3');
  });

  it('returns null for an engine-derived def (version null) so the badge is omitted', () => {
    expect(definitionVersionLabel({ version: null })).toBeNull();
    expect(definitionVersionLabel({})).toBeNull();
    expect(definitionVersionLabel(null)).toBeNull();
  });
});

describe('pluralizeRu + instanceCountLabel (AC-C2 — instance count)', () => {
  it('picks the correct Russian plural form', () => {
    const forms = ['инстанс', 'инстанса', 'инстансов'];
    expect(pluralizeRu(1, forms)).toBe('инстанс');
    expect(pluralizeRu(2, forms)).toBe('инстанса');
    expect(pluralizeRu(4, forms)).toBe('инстанса');
    expect(pluralizeRu(5, forms)).toBe('инстансов');
    expect(pluralizeRu(11, forms)).toBe('инстансов'); // 11 is an exception → many
    expect(pluralizeRu(21, forms)).toBe('инстанс');
    expect(pluralizeRu(0, forms)).toBe('инстансов');
  });

  it('instanceCountLabel renders a count + its plural form (0 is honest)', () => {
    expect(instanceCountLabel(0)).toBe('0 инстансов');
    expect(instanceCountLabel(1)).toBe('1 инстанс');
    expect(instanceCountLabel(3)).toBe('3 инстанса');
    expect(instanceCountLabel(25)).toBe('25 инстансов');
  });
});
