/**
 * web/src/screens/screen-spend.test.jsx  (T-0592)
 *
 * Тесты экрана учёта расхода LLM (spend).
 *
 * Подход (конвенция проекта, vitest "node" environment — без mount React):
 *   - Presence checks через grep по исходному коду.
 *   - T-0592: EmptyState компоненты используют правильный проп description=,
 *     а НЕ несуществующий message=.
 */

import { describe, it, expect } from 'vitest';

describe('T-0592 — EmptyState propName: description (не message)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-spend.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('НЕ содержит message= на EmptyState', () => {
    // Проверяем, что в исходнике нет строк типа:
    //   <EmptyState ... message="..."
    // Это может быть многострочное выражение, так что ищем pattern.
    expect(src).not.toMatch(/<EmptyState[^>]*message=/);
  });

  it('содержит description= на EmptyState', () => {
    // Должны быть оба EmptyState с description=
    const matches = src.match(/<EmptyState[^>]*description=/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('первый EmptyState (нет данных по соединениям) имеет description', () => {
    expect(src).toContain('Нет данных о расходах');
    expect(src).toContain('Расходы появятся после LLM-вызовов с настроенными ценами.');
    // Проверяем, что вместе они идут в одном EmptyState с правильным пропом
    const idx = src.indexOf('Нет данных о расходах');
    const chunk = src.slice(Math.max(0, idx - 100), idx + 300);
    expect(chunk).toContain('description=');
    expect(chunk).not.toContain('message=');
  });

  it('второй EmptyState (нет записей о расходах) имеет description', () => {
    expect(src).toContain('Нет записей о расходах');
    expect(src).toContain('Записи появятся после LLM-вызовов с настроенными ценами.');
    // Проверяем, что вместе они идут в одном EmptyState с правильным пропом
    const idx = src.indexOf('Нет записей о расходах');
    const chunk = src.slice(Math.max(0, idx - 100), idx + 300);
    expect(chunk).toContain('description=');
    expect(chunk).not.toContain('message=');
  });
});

describe('screen-spend.jsx — базовая целостность', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.default.resolve(
    new URL(import.meta.url).pathname,
    '../screen-spend.jsx',
  );
  const src = fs.default.readFileSync(filePath, 'utf-8');

  it('экспортирует SpendScreen по default', () => {
    expect(src).toContain('export default function SpendScreen');
  });

  it('импортирует EmptyState из components', () => {
    expect(src).toContain("import { Button, LoadingState, ErrorState, EmptyState }");
  });

  it('использует LoadingState для состояния загрузки', () => {
    expect(src).toContain('<LoadingState');
  });

  it('использует ErrorState для состояния ошибки', () => {
    expect(src).toContain('<ErrorState');
  });
});
