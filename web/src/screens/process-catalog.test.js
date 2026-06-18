/**
 * web/src/screens/process-catalog.test.js — T-0270
 *
 * Unit tests for the process-catalog pure logic (process-catalog.js):
 *   - validateBindingForm / buildBindingPayload — exact POST body + required fields;
 *   - definitionSourceLabel / definitionStatusLabel — honest source/status labels;
 *   - applicationOptions / definitionOptions — defensive option mapping;
 *   - bindingApplicationLabel — honest fallback when the app was deleted (null join);
 *   - mapBindingError — surfaces the 404/401/400 contract.
 */

import { describe, it, expect } from 'vitest';
import {
  validateBindingForm,
  buildBindingPayload,
  definitionSourceLabel,
  definitionStatusLabel,
  applicationOptions,
  definitionOptions,
  bindingApplicationLabel,
  mapBindingError,
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
});

describe('buildBindingPayload', () => {
  it('builds the exact POST body, trimming and coercing empty form_key to null', () => {
    const body = buildBindingPayload({ process_key: '  telLinear ', application_id: `  ${APP_UUID} `, form_key: '   ' });
    expect(body).toEqual({ process_key: 'telLinear', application_id: APP_UUID, form_key: null });
  });

  it('keeps a non-empty form_key', () => {
    const body = buildBindingPayload({ process_key: 'p', application_id: APP_UUID, form_key: 'purchase-form' });
    expect(body.form_key).toBe('purchase-form');
  });

  it('never carries extra fields beyond the contract', () => {
    const body = buildBindingPayload({ process_key: 'p', application_id: APP_UUID, extra: 'x' });
    expect(Object.keys(body).sort()).toEqual(['application_id', 'form_key', 'process_key']);
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
