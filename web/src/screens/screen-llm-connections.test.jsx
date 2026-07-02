/**
 * web/src/screens/screen-llm-connections.test.jsx  (T-0496, T-0574)
 *
 * Тесты кнопки «Проверить подключение» + «Назначить ассистенту» на экране
 * LLM-соединений.
 *
 * Подход (конвенция проекта, vitest "node" environment — без mount React):
 *   - Несущая логика кнопки = mapTestResponse(status, data): маппинг ответа сервера
 *     в состояние результата (✓ работает / ✗ ошибка). Экспортирована → unit-тест.
 *   - Состояния: успех (ok:true + модель/латентность/токены), ошибка (ok:false),
 *     401/403/404, не-200/битый JSON → честная ошибка.
 *   - T-0574: resolveAssistantBinding(agents) — чистая функция, резолвит адрес +
 *     текущую привязку ассистента из GET /api/agents. Экспортирована → unit-тест.
 *   - CSS-токены: только существующие --chs-* (success/danger-soft и т.п.).
 */

import { describe, it, expect } from 'vitest';
import { mapTestResponse, resolveAssistantBinding } from './screen-llm-connections.jsx';

// ---------------------------------------------------------------------------
// mapTestResponse — успех
// ---------------------------------------------------------------------------

describe('mapTestResponse — успех (ok:true)', () => {
  it('200 { ok:true, model, latency_ms, tokens } → результат «работает»', () => {
    const r = mapTestResponse(200, {
      ok: true,
      model: 'deepseek-chat',
      latency_ms: 421,
      tokens: { prompt: 1, completion: 1, total: 2 },
    });
    expect(r).toEqual({
      ok: true,
      model: 'deepseek-chat',
      latencyMs: 421,
      tokens: { prompt: 1, completion: 1, total: 2 },
    });
  });

  it('200 { ok:true } без токенов → tokens undefined, model null', () => {
    const r = mapTestResponse(200, { ok: true, latency_ms: 100 });
    expect(r.ok).toBe(true);
    expect(r.model).toBe(null);
    expect(r.tokens).toBeUndefined();
    expect(r.latencyMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// mapTestResponse — ошибка (ok:false)
// ---------------------------------------------------------------------------

describe('mapTestResponse — провайдер/ключ ошибка (ok:false)', () => {
  it('200 { ok:false, error } → передаёт серверное (санитизированное) сообщение', () => {
    const r = mapTestResponse(200, { ok: false, error: 'Провайдер отклонил ключ.' });
    expect(r).toEqual({ ok: false, error: 'Провайдер отклонил ключ.' });
  });

  it('200 { ok:false } без error → дефолтное «не работает»', () => {
    const r = mapTestResponse(200, { ok: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/не работает/i);
  });

  it('пустой handle → серверное «Ключ не задан» проходит как есть', () => {
    const r = mapTestResponse(200, { ok: false, error: 'Ключ не задан' });
    expect(r).toEqual({ ok: false, error: 'Ключ не задан' });
  });
});

// ---------------------------------------------------------------------------
// mapTestResponse — auth / not-found / битый ответ
// ---------------------------------------------------------------------------

describe('mapTestResponse — статусы auth/404/прочее', () => {
  it('401 → «войдите в систему»', () => {
    expect(mapTestResponse(401, null).error).toMatch(/войдите/i);
    expect(mapTestResponse(401, null).ok).toBe(false);
  });
  it('403 → «недостаточно прав»', () => {
    expect(mapTestResponse(403, null).error).toMatch(/недостаточно прав/i);
  });
  it('404 → «профиль не найден»', () => {
    expect(mapTestResponse(404, null).error).toMatch(/не найден/i);
  });
  it('500 → честная «HTTP 500»', () => {
    expect(mapTestResponse(500, null).error).toMatch(/HTTP 500/);
  });
  it('200 с null телом (битый JSON) → честная ошибка, не падает', () => {
    const r = mapTestResponse(200, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 200/);
  });
});

// ---------------------------------------------------------------------------
// CSS-токены — только существующие --chs-* (success/danger статусные)
// ---------------------------------------------------------------------------

describe('CSS-токены экрана — только существующие --chs-*', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('кнопка «Проверить подключение» присутствует', () => {
    expect(src).toContain('Проверить подключение');
  });
  it('состояние «Подключение работает» присутствует', () => {
    expect(src).toContain('Подключение работает');
  });
  it('использует статусные токены success/danger (soft)', () => {
    expect(src).toContain('--chs-color-success-soft');
    expect(src).toContain('--chs-color-danger-soft');
    expect(src).toContain('--chs-color-success');
    expect(src).toContain('--chs-color-danger');
  });
  it('НЕ содержит несуществующий --chs-color-primary', () => {
    expect(src).not.toMatch(/--chs-color-primary[^-]/);
  });
  it('НЕ содержит несуществующий --chs-weight-normal', () => {
    expect(src).not.toContain('--chs-weight-normal');
  });
});

// ---------------------------------------------------------------------------
// T-0574 · resolveAssistantBinding — pure GET /api/agents → binding resolver
// ---------------------------------------------------------------------------

describe('resolveAssistantBinding', () => {
  it('null / non-array input → null (loading / degrade)', () => {
    expect(resolveAssistantBinding(null)).toBeNull();
    expect(resolveAssistantBinding(undefined)).toBeNull();
    expect(resolveAssistantBinding('not-an-array')).toBeNull();
  });

  it('no agent_type==="assistant" element → null (pre-backfill tenant / anti-regression sentinel)', () => {
    const agents = [
      { id: 'emp-1', agent_type: 'workforce', llm_connection_id: null },
      { id: 'emp-2', agent_type: 'system', llm_connection_id: null },
    ];
    expect(resolveAssistantBinding(agents)).toBeNull();
  });

  it('finds the assistant element and reports its employee id + current connection (bound)', () => {
    const agents = [
      { id: 'emp-1', agent_type: 'workforce', llm_connection_id: null },
      { id: 'emp-9', agent_type: 'assistant', llm_connection_id: 'conn-5' },
    ];
    expect(resolveAssistantBinding(agents)).toEqual({
      assistantEmployeeId: 'emp-9',
      assistantConnectionId: 'conn-5',
    });
  });

  it('assistant present but unbound → assistantConnectionId is null (never undefined)', () => {
    const agents = [{ id: 'emp-9', agent_type: 'assistant', llm_connection_id: null }];
    expect(resolveAssistantBinding(agents)).toEqual({
      assistantEmployeeId: 'emp-9',
      assistantConnectionId: null,
    });
    // llm_connection_id absent entirely (undefined) also normalizes to null.
    const agents2 = [{ id: 'emp-9', agent_type: 'assistant' }];
    expect(resolveAssistantBinding(agents2).assistantConnectionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-0574 · «Назначить ассистенту» — grep-based presence checks (same convention
// as the "CSS-токены" block above: no DOM mount, source-text assertions).
// ---------------------------------------------------------------------------

describe('T-0574 — «Назначить ассистенту» UI present, no new endpoints', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('кнопка «Назначить ассистенту» присутствует', () => {
    expect(src).toContain('Назначить ассистенту');
  });
  it('чип «ассистент использует этот профиль» присутствует', () => {
    expect(src).toContain('ассистент использует этот профиль');
  });
  it('переиспользует существующий PUT /api/agents/:id/llm-connection — НЕТ нового эндпоинта', () => {
    expect(src).toMatch(/\/api\/agents\/\$\{[^}]+\}\/llm-connection/);
    expect(src).not.toContain('/api/assistant/llm-connection');
  });
  it('резолвит ассистента через существующий GET /api/agents (agent_type==="assistant")', () => {
    expect(src).toContain("agent_type === 'assistant'");
    expect(src).toContain("fetch('/api/agents'");
  });
  it('кнопка не мёртвый enabled-аффорданс: скрыта/заменена чипом на уже-назначенном профиле', () => {
    // isAssigned gates the ternary — chip renders instead of the Button when true.
    expect(src).toMatch(/isAssigned\s*\?/);
  });
});

// ---------------------------------------------------------------------------
// T-0574 (AC-11/F6) — static, non-dev-jargon instruction block present
// ---------------------------------------------------------------------------

describe('T-0574 — инструкция «где взять ключ Anthropic» (AC-11)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('упоминает console.anthropic.com и путь API Keys → Create Key', () => {
    expect(src).toContain('console.anthropic.com');
    expect(src).toContain('API Keys');
    expect(src).toContain('Create Key');
  });
  it('НЕ содержит дев-жаргона (endpoint/handle/resolve/UUID/HTTP-код) в тексте инструкции', () => {
    // Extract just the instruction block (between its marker comment and the
    // create-form heading) so we scope the check to VISIBLE product text, not
    // the whole file (which legitimately uses "endpoint"/"handle" elsewhere as
    // dev-facing field labels/JS identifiers, out of scope for AC-11).
    const start = src.indexOf('Откуда взять ключ и что с ним сделать');
    const end = src.indexOf('Новый профиль');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/endpoint/i);
    expect(block).not.toMatch(/handle/i);
    expect(block).not.toMatch(/resolve/i);
    expect(block).not.toMatch(/UUID/i);
    expect(block).not.toMatch(/HTTP\s*\d{3}/);
  });
});
