/**
 * web/src/canvas/dmn-editor-api.test.js  (T-0435)
 *
 * Unit tests for dmn-editor-api.js — the API client that powers the branch-rules
 * editor screen (screen-dmn-editor.jsx).
 *
 * Verifies:
 *   1. listRuleTables — GET /api/dmn-rule-tables?processKey=…
 *   2. getRuleTable   — GET /api/dmn-rule-tables/:id
 *   3. saveRuleTable  — POST /api/dmn-rule-tables with CORRECT body shape:
 *        { name, hitPolicy: "FIRST", processKey, rules: [
 *            { conditions: [...], effects: [{ kind: "set_routing_outcome", name, value }] },
 *            ...
 *        ]}
 *      Backend returns 201 { id }.
 *   4. publishRuleTable — POST /api/dmn-rule-tables/:id/publish → 200 { id, status }
 *   5. Error paths: non-2xx responses throw with a Russian error message.
 *   6. (Fix 1) routing variable name comes from the editable field, default = 'approvalRequired'
 *      to match gateway-condition-panel.jsx readRoutingVar fallback.
 *   7. (Fix 2) second save carries existing id in the body so backend UPSERTs in-place.
 *
 * Pattern mirrors outcome-presets.test.js (pure vitest, no DOM, no RTL).
 * fetch and dev-auth are stubbed with globalThis overrides.
 *
 * Key acceptance invariant (T-0435 spec):
 *   Author 2 rules:
 *     Rule 1: сумма больше 5000000 → доп.согласование
 *     Rule 2 (default/иначе):        → стандарт
 *   Save → POST body has hitPolicy="FIRST", 2 rules, both have set_routing_outcome effects.
 *   Publish → calls /api/dmn-rule-tables/:id/publish with POST.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stubs — globalThis.fetch + dev-auth module
// ---------------------------------------------------------------------------

// dev-auth.js returns authHeaders(). We mock the whole module so the import
// inside dmn-editor-api.js resolves without the browser environment.
vi.mock('../app-shell/dev-auth.js', () => ({
  authHeaders: () => ({ 'x-dev-user': 'e-orlov' }),
}));

// Capture the last fetch call for assertion.
let lastFetchUrl = null;
let lastFetchOptions = null;
let _mockResponse = null;

function setMockResponse(status, body) {
  _mockResponse = { status, body };
}

beforeEach(() => {
  lastFetchUrl = null;
  lastFetchOptions = null;
  _mockResponse = { status: 200, body: {} };

  globalThis.fetch = vi.fn(async (url, options) => {
    lastFetchUrl = url;
    lastFetchOptions = options;
    const { status, body } = _mockResponse;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
});

afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import the module under test (after stubs are in place via vi.mock hoisting).
// ---------------------------------------------------------------------------

import {
  listRuleTables,
  getRuleTable,
  saveRuleTable,
  publishRuleTable,
} from './dmn-editor-api.js';

// ---------------------------------------------------------------------------
// listRuleTables
// ---------------------------------------------------------------------------

describe('listRuleTables', () => {
  it('calls GET /api/dmn-rule-tables?processKey=tel-linear', async () => {
    setMockResponse(200, [{ id: 'abc', name: 'Правила' }]);
    const result = await listRuleTables('tel-linear');

    expect(lastFetchUrl).toBe('/api/dmn-rule-tables?processKey=tel-linear');
    expect(lastFetchOptions.headers['x-dev-user']).toBe('e-orlov');
    expect(result).toEqual([{ id: 'abc', name: 'Правила' }]);
  });

  it('omits processKey param when not given', async () => {
    setMockResponse(200, []);
    await listRuleTables(undefined);
    expect(lastFetchUrl).toBe('/api/dmn-rule-tables');
  });

  it('throws a Russian error on non-2xx', async () => {
    setMockResponse(403, { message: 'FORBIDDEN' });
    await expect(listRuleTables('tel-linear')).rejects.toThrow(
      /Ошибка загрузки правил/,
    );
  });
});

// ---------------------------------------------------------------------------
// getRuleTable
// ---------------------------------------------------------------------------

describe('getRuleTable', () => {
  it('calls GET /api/dmn-rule-tables/:id', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    setMockResponse(200, { id, name: 'Правила', definition: { rules: [] } });
    const result = await getRuleTable(id);

    expect(lastFetchUrl).toBe(`/api/dmn-rule-tables/${id}`);
    expect(result.id).toBe(id);
  });

  it('throws on 404', async () => {
    setMockResponse(404, { message: 'NOT_FOUND' });
    await expect(
      getRuleTable('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/Ошибка загрузки правила/);
  });
});

// ---------------------------------------------------------------------------
// saveRuleTable — the critical body-shape test (T-0435 acceptance)
// ---------------------------------------------------------------------------

describe('saveRuleTable — body shape', () => {
  it('sends correct FIRST body with two rules and set_routing_outcome effects', async () => {
    setMockResponse(201, { id: 'new-draft-id' });

    // These are the two rules from the acceptance scenario:
    //   Rule 1: сумма больше 5000000 → доп.согласование
    //   Rule 2 (иначе — no conditions): → стандарт
    // Fix 1: routing name is 'approvalRequired' (matches gateway-condition-panel default),
    //        not the old hardcoded 'маршрут'.
    const draft = {
      name: 'Правила ветвления',
      processKey: 'tel-linear',
      hitPolicy: 'FIRST',
      rules: [
        {
          conditions: [{ field: 'сумма', operator: 'gt', value: '5000000' }],
          effects: [
            {
              kind: 'set_routing_outcome',
              name: 'approvalRequired',
              value: 'доп.согласование',
            },
          ],
        },
        {
          conditions: [],
          effects: [
            {
              kind: 'set_routing_outcome',
              name: 'approvalRequired',
              value: 'стандарт',
            },
          ],
        },
      ],
    };

    const result = await saveRuleTable(draft);

    // Response
    expect(result).toEqual({ id: 'new-draft-id' });

    // HTTP method + URL
    expect(lastFetchUrl).toBe('/api/dmn-rule-tables');
    expect(lastFetchOptions.method).toBe('POST');
    expect(lastFetchOptions.headers['content-type']).toBe('application/json');

    // Parse the body that was actually sent to the API
    const sentBody = JSON.parse(lastFetchOptions.body);

    // hitPolicy must be FIRST (T-0433 validator requirement)
    expect(sentBody.hitPolicy).toBe('FIRST');

    // Two rules
    expect(sentBody.rules).toHaveLength(2);

    // Rule 1: сумма больше 5000000
    const rule1 = sentBody.rules[0];
    expect(rule1.conditions).toHaveLength(1);
    expect(rule1.conditions[0]).toMatchObject({
      field: 'сумма',
      operator: 'gt',
      value: '5000000',
    });
    const effect1 = rule1.effects.find((e) => e.kind === 'set_routing_outcome');
    expect(effect1).toBeDefined();
    // Fix 1: routing name must be the editable field value (default 'approvalRequired'),
    // matching gateway-condition-panel.jsx readRoutingVar fallback.
    expect(effect1.name).toBe('approvalRequired');
    expect(effect1.value).toBe('доп.согласование');

    // Rule 2: иначе (no conditions) → стандарт
    const rule2 = sentBody.rules[1];
    expect(rule2.conditions).toHaveLength(0);
    const effect2 = rule2.effects.find((e) => e.kind === 'set_routing_outcome');
    expect(effect2).toBeDefined();
    expect(effect2.name).toBe('approvalRequired');
    expect(effect2.value).toBe('стандарт');

    // All routing effects share the same name (T-0433 INCONSISTENT_ROUTING_NAME invariant)
    const allRoutingNames = sentBody.rules.flatMap((r) =>
      r.effects
        .filter((e) => e.kind === 'set_routing_outcome')
        .map((e) => e.name),
    );
    const uniqueNames = new Set(allRoutingNames);
    expect(uniqueNames.size).toBe(1);
  });

  it('(Fix 2) second save includes id in body so backend updates in place', async () => {
    // First save: no id in body → backend allocates new row
    setMockResponse(201, { id: 'existing-table-id' });
    const draftFirst = {
      name: 'Правила ветвления',
      processKey: 'tel-linear',
      hitPolicy: 'FIRST',
      rules: [
        {
          conditions: [],
          effects: [{ kind: 'set_routing_outcome', name: 'approvalRequired', value: 'стандарт' }],
        },
      ],
    };
    const first = await saveRuleTable(draftFirst);
    expect(first.id).toBe('existing-table-id');
    const firstBody = JSON.parse(lastFetchOptions.body);
    expect(firstBody.id).toBeUndefined(); // no id on first save

    // Second save: caller includes id → body carries it → backend UPSERTs
    setMockResponse(201, { id: 'existing-table-id' });
    const draftSecond = { ...draftFirst, id: 'existing-table-id' };
    const second = await saveRuleTable(draftSecond);
    expect(second.id).toBe('existing-table-id');
    const secondBody = JSON.parse(lastFetchOptions.body);
    expect(secondBody.id).toBe('existing-table-id');
    // Verify same URL (POST /api/dmn-rule-tables in both cases — backend handles upsert)
    expect(lastFetchUrl).toBe('/api/dmn-rule-tables');
  });

  it('returns { id } on 201', async () => {
    setMockResponse(201, { id: 'some-uuid' });
    const r = await saveRuleTable({ name: 'x', hitPolicy: 'FIRST', rules: [] });
    expect(r.id).toBe('some-uuid');
  });

  it('throws on 400 validation error, surfacing the violation message', async () => {
    setMockResponse(400, {
      error: 'VALIDATION',
      violations: [{ code: 'RULES_EMPTY', message: 'rules must be a non-empty array' }],
    });
    await expect(
      saveRuleTable({ name: 'x', hitPolicy: 'FIRST', rules: [] }),
    ).rejects.toThrow(/rules must be a non-empty array/);
  });
});

// ---------------------------------------------------------------------------
// publishRuleTable
// ---------------------------------------------------------------------------

describe('publishRuleTable', () => {
  it('calls POST /api/dmn-rule-tables/:id/publish', async () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    setMockResponse(200, { id, status: 'published' });

    const result = await publishRuleTable(id);

    expect(lastFetchUrl).toBe(`/api/dmn-rule-tables/${id}/publish`);
    expect(lastFetchOptions.method).toBe('POST');
    expect(result).toEqual({ id, status: 'published' });
  });

  it('throws on 404 (id not found)', async () => {
    setMockResponse(404, { message: 'NOT_FOUND' });
    await expect(
      publishRuleTable('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/Ошибка публикации правил/);
  });

  it('throws on 403 (not process_designer)', async () => {
    setMockResponse(403, { message: 'FORBIDDEN' });
    await expect(publishRuleTable('some-id')).rejects.toThrow(
      /Ошибка публикации правил/,
    );
  });
});
