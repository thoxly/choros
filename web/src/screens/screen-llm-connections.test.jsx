/**
 * web/src/screens/screen-llm-connections.test.jsx  (T-0496, T-0574, T-0602)
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
 *   - T-0602: humanizeSecretHandleScheme(redacted) — чистая функция, карточка
 *     профиля показывает человеческую подпись вместо сырого "app://…"/"env://…".
 *   - CSS-токены: только существующие --chs-* (success/danger-soft и т.п.).
 */

import { describe, it, expect } from 'vitest';
import { mapTestResponse, resolveAssistantBinding, humanizeSecretHandleScheme } from './screen-llm-connections.jsx';

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
// T-0602 (было T-0574 AC-11/F6) — динамическая, non-dev-jargon инструкция
// ---------------------------------------------------------------------------

describe('T-0602 — инструкция «Откуда взять ключ» — провайдер-динамическая (AC-5/AC-6)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('PROVIDER_PRESETS carries consoleHint for deepseek/openai/anthropic, null for self-hosted/other', () => {
    const presetsBlock = src.slice(src.indexOf('const PROVIDER_PRESETS'), src.indexOf('const PROVIDER_PRESETS') + 1600);
    expect(presetsBlock).toContain('platform.deepseek.com');
    expect(presetsBlock).toContain('platform.openai.com/api-keys');
    expect(presetsBlock).toContain('console.anthropic.com');
    expect(presetsBlock).toMatch(/consoleHint:\s*null/);
  });

  it('instruction block derives its text from selectedPreset (reactive to the chosen provider), not a hardcoded provider', () => {
    // selectedPreset is derived from PROVIDER_PRESETS.find on the `provider` state —
    // the SAME state the Select controls — so switching providers changes the hint.
    expect(src).toMatch(/const selectedPreset = PROVIDER_PRESETS\.find\(\(p\) => p\.value === provider\)/);
    const start = src.indexOf('Откуда взять ключ и что с ним сделать');
    const end = src.indexOf('Новый профиль');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/selectedPreset\.consoleHint/);
  });

  it('honest neutral fallback text present for providers without a consoleHint (self-hosted/other)', () => {
    expect(src).toContain('У вашего провайдера должен быть раздел с API-ключами в личном кабинете');
  });

  it('НЕ содержит дев-жаргона (endpoint/handle/resolve/UUID/HTTP-код) в тексте инструкции', () => {
    // Extract just the instruction block (between its marker comment and the
    // create-form heading) so we scope the check to VISIBLE product text, not
    // the whole file (which legitimately uses "endpoint"/"handle" elsewhere as
    // dev-facing field labels/JS identifiers, out of scope for this AC).
    const start = src.indexOf('Откуда взять ключ и что с ним сделать');
    const end = src.indexOf('Новый профиль');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/endpoint/i);
    expect(block).not.toMatch(/\bhandle\b/i);
    expect(block).not.toMatch(/resolve/i);
    expect(block).not.toMatch(/UUID/i);
    expect(block).not.toMatch(/HTTP\s*\d{3}/);
    expect(block).not.toMatch(/env:\/\//);
    expect(block).not.toMatch(/vault:\/\//);
  });
});

// ---------------------------------------------------------------------------
// T-0597 (находка №3) — reveal-toggle on the API-key field (AC-3)
// ---------------------------------------------------------------------------

describe('T-0597 — reveal-toggle на поле API-ключа (AC-3)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('ConnectionKeyBinder holds a showKey state', () => {
    expect(src).toMatch(/const \[showKey, setShowKey\] = useState\(false\)/);
  });
  it('the key Field type toggles password↔text based on showKey', () => {
    expect(src).toContain("type={showKey ? 'text' : 'password'}");
  });
  it('the toggle button has aria-label synced with state (Показать/Скрыть ключ)', () => {
    expect(src).toContain("aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}");
  });
  it('the toggle button carries aria-pressed synced with showKey', () => {
    expect(src).toContain('aria-pressed={showKey}');
  });
  it('the toggle is a real <button type="button"> (keyboard reachable, not a submit trigger)', () => {
    const idx = src.indexOf('setShowKey((s) => !s)');
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 200), idx);
    expect(before).toMatch(/type="button"/);
  });
  it('uses the new eye/eye-off KitIcon names', () => {
    expect(src).toContain("KitIcon name={showKey ? 'eye-off' : 'eye'}");
  });
  it('imports KitIcon from the kit', () => {
    expect(src).toMatch(/import \{[^}]*KitIcon[^}]*\} from '\.\.\/components\/components\.jsx'/);
  });
  it('key state resets on cancel and after a successful bind (write-only hygiene preserved)', () => {
    // Cancel button resets showKey alongside apiKey.
    expect(src).toMatch(/setApiKey\(''\); setShowKey\(false\); setOpen\(false\)/);
    // Successful submit clears apiKey AND showKey immediately (before the 200/error branches).
    expect(src).toMatch(/setApiKey\(''\);\s*\n\s*setShowKey\(false\);/);
  });
});

// ---------------------------------------------------------------------------
// T-0597 (находка №8) — форма «Новый профиль» по умолчанию = Anthropic (AC-6/AC-7)
// ---------------------------------------------------------------------------

describe('T-0597 — дефолт формы = Anthropic, синхрон с инструкцией (AC-6/AC-7)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('derives the initial state from PROVIDER_PRESETS anthropic entry (single source of numbers)', () => {
    expect(src).toContain("PROVIDER_PRESETS.find((p) => p.value === 'anthropic')");
  });
  it('provider/endpoint/model/prices/currency initial state reference ANTHROPIC_PRESET', () => {
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.value\)/);
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.endpoint\)/);
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.model\)/);
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.priceIn\)/);
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.priceOut\)/);
    expect(src).toMatch(/useState\(ANTHROPIC_PRESET\.currency\)/);
  });
  it('DeepSeek remains the first PROVIDER_PRESETS entry and fully selectable', () => {
    const presetsBlock = src.slice(src.indexOf('const PROVIDER_PRESETS'), src.indexOf('const PROVIDER_PRESETS') + 800);
    const deepseekIdx = presetsBlock.indexOf("value: 'deepseek'");
    const anthropicIdx = presetsBlock.indexOf("value: 'anthropic'");
    expect(deepseekIdx).toBeGreaterThan(-1);
    expect(anthropicIdx).toBeGreaterThan(deepseekIdx);
  });
  it('onProviderChange logic is untouched (still auto-fills from the preset array)', () => {
    expect(src).toContain('const onProviderChange = (e) => {');
    expect(src).toContain('PROVIDER_PRESETS.find((p) => p.value === val)');
  });
});

// ---------------------------------------------------------------------------
// T-0597 (находка №9) — честный статус «ключ не привязан» (AC-8/AC-9/AC-10)
// ---------------------------------------------------------------------------

describe('T-0597 — честный статус готовности профиля (AC-8/AC-9/AC-10)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('T-0602: success banner unconditionally includes the honest next-step line (the form can no longer submit a key at all)', () => {
    expect(src).toContain('Теперь вставьте API-ключ, чтобы он заработал.');
    // The old conditional (createOkNoKey &&) is gone — the form structurally
    // cannot pass a key anymore (secret-handle field removed, ADR-T0602 §1),
    // so the banner text is unconditional plain text, not a ternary/&&.
    expect(src).not.toContain('createOkNoKey');
    expect(src).toContain('Профиль создан. Теперь вставьте API-ключ, чтобы он заработал.');
  });
  it('chipStyle uses warning tokens (not neutral) when the key is unbound', () => {
    const idx = src.indexOf('const chipStyle');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 500);
    expect(block).toContain('--chs-color-warning-soft');
    expect(block).toContain('--chs-color-warning');
    expect(block).not.toContain('--chs-color-surface-raised');
    expect(block).not.toContain('--chs-color-text-muted');
  });
  it('the «Вставить API-ключ» button is primary only while unbound', () => {
    expect(src).toContain("variant={secretBound ? 'ghost' : 'primary'}");
  });
});

// ---------------------------------------------------------------------------
// T-0602 — секрет-хэндл-поле убрано из формы создания (AC-1/AC-2/AC-4)
// ---------------------------------------------------------------------------

describe('T-0602 — форма «Новый профиль» не содержит секрет-хэндл-поле (AC-1/AC-2/AC-4)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-llm-connections.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('AC-1: no "Секрет-хэндл" field label anywhere in the file', () => {
    expect(src).not.toMatch(/Секрет-хэндл/);
  });

  it('AC-1: no secretHandle/setSecretHandle state left in the component', () => {
    expect(src).not.toMatch(/const \[secretHandle, setSecretHandle\]/);
    expect(src).not.toMatch(/\bsetSecretHandle\(/);
  });

  it('AC-1: no leftover env://DEEPSEEK_API_KEY placeholder (the dead tenant-handle example)', () => {
    expect(src).not.toContain('env://DEEPSEEK_API_KEY');
  });

  it('AC-2: onCreate never builds a secret_handle POST field from form state', () => {
    const start = src.indexOf('const onCreate = useCallback');
    const end = src.indexOf('\n  }, [name, provider, endpoint, model, priceIn, priceOut, currency, isDefault, loadConnections]);');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const onCreateBody = src.slice(start, end);
    expect(onCreateBody).not.toMatch(/body\.secret_handle/);
    expect(onCreateBody).not.toMatch(/secretHandle/);
  });

  it('AC-4: create-form description does not mention секрет-хэндл/ссылку/env:\\/\\//vault:\\/\\/', () => {
    const start = src.indexOf('<h2 style={headingStyle}>Новый профиль</h2>');
    const end = src.indexOf('<div style={fieldGap}>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/секрет-хэндл/i);
    expect(block).not.toMatch(/env:\/\//);
    expect(block).not.toMatch(/vault:\/\//);
    // Honest replacement: points at the card-level key-insertion step instead.
    expect(block).toMatch(/вставьте API-ключ[\s\S]{0,20}на карточке/i);
  });

  it('server contract (secret_handle as an optional POST field) is untouched — this is a client-only removal (OOS-1)', () => {
    // The route file itself is out of scope for this task; this is a documentation
    // assertion that we did not touch it (grep sanity, not a behavioural test).
    const fsSync = fs.default;
    const serverFile = path.default.resolve(
      new URL(import.meta.url).pathname,
      '../../../../src/http/llm-connections.ts',
    );
    expect(fsSync.existsSync(serverFile)).toBe(true);
    const serverSrc = fsSync.readFileSync(serverFile, 'utf-8');
    expect(serverSrc).toContain('secret_handle');
  });
});

// ---------------------------------------------------------------------------
// T-0602 — humanizeSecretHandleScheme (AC-7): человеческая подпись на карточке
// ---------------------------------------------------------------------------

describe('humanizeSecretHandleScheme', () => {
  it('app:// → "Ключ зашифрован и привязан"', () => {
    expect(humanizeSecretHandleScheme('app://a1b2c3...')).toBe('Ключ зашифрован и привязан');
  });
  it('env:// → "Ключ сервера (настроен оператором)"', () => {
    expect(humanizeSecretHandleScheme('env://...')).toBe('Ключ сервера (настроен оператором)');
  });
  it('vault:// → "Ключ из внешнего хранилища (настроено оператором)"', () => {
    expect(humanizeSecretHandleScheme('vault://...')).toBe('Ключ из внешнего хранилища (настроено оператором)');
  });
  it('unknown scheme → null (caller renders nothing extra)', () => {
    expect(humanizeSecretHandleScheme('mystery://...')).toBeNull();
  });
  it('null / undefined / empty string → null', () => {
    expect(humanizeSecretHandleScheme(null)).toBeNull();
    expect(humanizeSecretHandleScheme(undefined)).toBeNull();
    expect(humanizeSecretHandleScheme('')).toBeNull();
  });

  it('the screen renders the humanized label ahead of the raw redacted string on the card (secondary line)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.default.resolve(
      new URL(import.meta.url).pathname,
      '../screen-llm-connections.jsx',
    );
    const src = fs.default.readFileSync(filePath, 'utf-8');
    const humanIdx = src.indexOf('humanizeSecretHandleScheme(c.secret_handle_redacted)');
    const rawIdx = src.indexOf('<span style={monoStyle}>{c.secret_handle_redacted}</span>');
    expect(humanIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeGreaterThan(-1);
    expect(humanIdx).toBeLessThan(rawIdx);
  });
});
