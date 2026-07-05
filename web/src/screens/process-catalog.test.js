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
  TRIGGER_TYPES,
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
