/**
 * web/src/screens/screen-llm-connections.test.jsx  (T-0496)
 *
 * Тесты кнопки «Проверить подключение» на экране LLM-соединений.
 *
 * Подход (конвенция проекта, vitest "node" environment — без mount React):
 *   - Несущая логика кнопки = mapTestResponse(status, data): маппинг ответа сервера
 *     в состояние результата (✓ работает / ✗ ошибка). Экспортирована → unit-тест.
 *   - Состояния: успех (ok:true + модель/латентность/токены), ошибка (ok:false),
 *     401/403/404, не-200/битый JSON → честная ошибка.
 *   - CSS-токены: только существующие --chs-* (success/danger-soft и т.п.).
 */

import { describe, it, expect } from 'vitest';
import { mapTestResponse } from './screen-llm-connections.jsx';

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
