/* ============================================================================
   CHOROS — screen-dmn-editor.jsx
   T-0435: Экран редактора правил ветвления для процесса.

   Назначение: позволяет авторам (process_designer) задавать условия ветвления
   вида «[поле] [условие] [значение] → [исход]» без SQL.

   Маршрут: /processes/:processKey/branch-rules  (wired in shell.jsx)

   API (T-0433):
     GET  /api/forms/binding?processKey=…         — поля процесса для дропдауна
     GET  /api/dmn-rule-tables?processKey=…       — загрузка сохранённых правил
     POST /api/dmn-rule-tables                    — сохранение черновика (201)
     POST /api/dmn-rule-tables/:id/publish        — публикация (200)

   UX-принципы (D-062 OBLIK):
     - Нет технического жаргона: «DMN», «hit-policy», «EL», «conditionExpression»,
       «routing-outcome» пользователю не показываются. Используется продуктовый язык.
     - Операторы называются по-русски: «равно», «не равно», «больше», «больше или
       равно», «меньше», «меньше или равно», «в списке», «не в списке», «заполнено»,
       «не заполнено».
     - Только kit-компоненты (Button, Field, LoadingState, ErrorState, EmptyState),
       только токены --chs-*.
     - Honest Empty / Loading / Error состояния.

   Внутренне: hitPolicy всегда «FIRST» (первое сработавшее правило применяется).
   Имя переменной исхода фиксировано — «маршрут» (routing_outcome); значения —
   свободный текст, заполняемый автором.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Field, LoadingState, ErrorState, EmptyState, KitIcon } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { listRuleTables, saveRuleTable, publishRuleTable } from '../canvas/dmn-editor-api.js';

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/** Имя переменной маршрутизации (routing-outcome), используется во всех правилах. */
const ROUTING_NAME = 'маршрут';

/**
 * Операторы в продуктовом языке.
 * Маппинг: product-label → DMN operator (T-0433 validator: eq/neq/gt/gte/lt/lte/in/nin/present/absent).
 */
const OPERATORS = [
  { value: 'eq',      label: 'равно' },
  { value: 'neq',     label: 'не равно' },
  { value: 'gt',      label: 'больше' },
  { value: 'gte',     label: 'больше или равно' },
  { value: 'lt',      label: 'меньше' },
  { value: 'lte',     label: 'меньше или равно' },
  { value: 'in',      label: 'в списке' },
  { value: 'nin',     label: 'не в списке' },
  { value: 'present', label: 'заполнено' },
  { value: 'absent',  label: 'не заполнено' },
];

/** Операторы, для которых не нужно поле «Значение». */
const NO_VALUE_OPS = new Set(['present', 'absent']);

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Создаёт пустую строку условия. */
function emptyCondition(field = '') {
  return { field, operator: 'eq', value: '' };
}

/** Создаёт пустое правило. */
function emptyRule(field = '') {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    conditions: [emptyCondition(field)],
    outcome: '',
  };
}

/**
 * Создаёт «иначе» (default) правило — без условий, только исход.
 * Кодируется как правило с пустым массивом условий.
 */
function defaultRule() {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random() + 1),
    conditions: [],
    outcome: '',
    isDefault: true,
  };
}

/**
 * Конвертирует правила экрана (UI state) в тело запроса T-0433.
 *
 * UI-правило: { id, conditions: [{ field, operator, value }], outcome, isDefault? }
 * API-правило: { conditions: [...], effects: [{ kind: 'set_routing_outcome', name, value }] }
 *
 * Условия для «иначе»-строки (isDefault=true, пустой массив) → пустой conditions в API.
 * Это допустимо: при FIRST-политике правило без условий всегда срабатывает (fallthrough).
 */
function rulesToApiBody(rules, name, processKey) {
  return {
    name,
    processKey: processKey || undefined,
    hitPolicy: 'FIRST',
    rules: rules.map((r) => ({
      conditions: r.conditions
        .filter((c) => c.field && c.operator)
        .map((c) => {
          const cond = { field: c.field, operator: c.operator };
          if (!NO_VALUE_OPS.has(c.operator)) {
            cond.value = c.value;
          }
          return cond;
        }),
      effects: [
        {
          kind: 'set_routing_outcome',
          name: ROUTING_NAME,
          value: r.outcome,
        },
      ],
    })),
  };
}

/**
 * Конвертирует ответ API в UI-состояние.
 * Если rules пустые или нет данных — возвращает null (покажем EmptyState).
 */
function apiRulesToUiState(tableRow) {
  if (!tableRow?.definition?.rules?.length) return null;
  return tableRow.definition.rules.map((r, i) => {
    const routingEffect = (r.effects || []).find(
      (e) => e.kind === 'set_routing_outcome',
    );
    const isDefault = !r.conditions || r.conditions.length === 0;
    return {
      id: String(i),
      conditions: isDefault
        ? []
        : (r.conditions || []).map((c) => ({
            field: c.field || '',
            operator: c.operator || 'eq',
            value: c.value !== undefined ? String(c.value) : '',
          })),
      outcome: routingEffect?.value ?? '',
      isDefault,
    };
  });
}

// ---------------------------------------------------------------------------
// Компонент строки правила
// ---------------------------------------------------------------------------

function RuleRow({ rule, index, fields, onChange, onRemove, total }) {
  const isDefault = rule.isDefault;

  function updateCondition(ci, key, val) {
    const newConds = rule.conditions.map((c, j) =>
      j === ci ? { ...c, [key]: val } : c,
    );
    onChange({ ...rule, conditions: newConds });
  }

  function addCondition() {
    onChange({
      ...rule,
      conditions: [
        ...rule.conditions,
        emptyCondition(fields[0]?.key || ''),
      ],
    });
  }

  function removeCondition(ci) {
    onChange({
      ...rule,
      conditions: rule.conditions.filter((_, j) => j !== ci),
    });
  }

  return (
    <div
      role="group"
      aria-label={isDefault ? 'Правило по умолчанию' : `Правило ${index + 1}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--chs-space-2)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        border: '1px solid var(--chs-border)',
        borderRadius: 'var(--chs-radius-3)',
        background: isDefault
          ? 'var(--chs-color-surface-alt, var(--chs-surface-alt, #f8f8f8))'
          : 'var(--chs-color-surface)',
      }}
    >
      {/* Метка строки */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: 'var(--chs-text-xs)',
            fontWeight: 600,
            color: 'var(--chs-color-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {isDefault ? 'Иначе' : `Если`}
        </span>
        {!isDefault && (
          <button
            type="button"
            aria-label={`Удалить правило ${index + 1}`}
            onClick={() => onRemove(rule.id)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--chs-color-text-muted)',
              padding: 'var(--chs-space-1)',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Удалить это правило"
          >
            <KitIcon name="close" size="0.85em" />
          </button>
        )}
      </div>

      {/* Условия */}
      {!isDefault && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--chs-space-2)',
          }}
        >
          {rule.conditions.map((cond, ci) => (
            <div
              key={ci}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr auto',
                gap: 'var(--chs-space-2)',
                alignItems: 'end',
              }}
            >
              {/* Поле */}
              <div className="chs-field">
                <label
                  className="chs-label"
                  htmlFor={`dmn-field-${rule.id}-${ci}`}
                >
                  Поле
                </label>
                <select
                  id={`dmn-field-${rule.id}-${ci}`}
                  className="chs-input"
                  value={cond.field}
                  onChange={(e) => updateCondition(ci, 'field', e.target.value)}
                >
                  <option value="">— выберите поле —</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label || f.key}
                    </option>
                  ))}
                </select>
              </div>

              {/* Условие */}
              <div className="chs-field">
                <label
                  className="chs-label"
                  htmlFor={`dmn-op-${rule.id}-${ci}`}
                >
                  Условие
                </label>
                <select
                  id={`dmn-op-${rule.id}-${ci}`}
                  className="chs-input"
                  value={cond.operator}
                  onChange={(e) => updateCondition(ci, 'operator', e.target.value)}
                >
                  {OPERATORS.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Значение */}
              {NO_VALUE_OPS.has(cond.operator) ? (
                <div className="chs-field" aria-hidden="true" />
              ) : (
                <Field
                  label="Значение"
                  id={`dmn-val-${rule.id}-${ci}`}
                  type="text"
                  value={cond.value}
                  placeholder="например: 5000000"
                  onChange={(e) => updateCondition(ci, 'value', e.target.value)}
                />
              )}

              {/* Кнопка удаления условия */}
              <div style={{ paddingBottom: 'var(--chs-space-1)' }}>
                {rule.conditions.length > 1 && (
                  <button
                    type="button"
                    aria-label="Убрать условие"
                    onClick={() => removeCondition(ci)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--chs-color-text-muted)',
                      padding: 'var(--chs-space-1)',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <KitIcon name="close" size="0.75em" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* Добавить условие «И» */}
          <div>
            <button
              type="button"
              onClick={addCondition}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 'var(--chs-text-sm)',
                color: 'var(--chs-color-primary)',
                padding: '0',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--chs-space-1)',
              }}
            >
              <KitIcon name="plus" size="0.8em" />
              Добавить условие «И»
            </button>
          </div>
        </div>
      )}

      {/* Стрелка → и исход */}
      <div style={{ display: 'flex', alignItems: 'end', gap: 'var(--chs-space-3)' }}>
        <span
          style={{
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text-muted)',
            paddingBottom: 'var(--chs-space-2)',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          →
        </span>
        <Field
          label="Исход"
          id={`dmn-outcome-${rule.id}`}
          type="text"
          value={rule.outcome}
          placeholder={isDefault ? 'например: стандарт' : 'например: доп.согласование'}
          onChange={(e) => onChange({ ...rule, outcome: e.target.value })}
          style={{ flex: 1 }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Главный компонент экрана
// ---------------------------------------------------------------------------

function DmnEditorScreen() {
  const { processKey } = useParams();
  const navigate = useNavigate();

  // Состояние загрузки
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Состояние полей процесса (из named binding)
  const [bindingFields, setBindingFields] = useState([]);

  // Состояние таблицы правил
  const [tableId, setTableId] = useState(null);           // id последнего сохранённого
  const [tableStatus, setTableStatus] = useState(null);   // 'draft' | 'published'
  const [tableName, setTableName] = useState('');          // название таблицы
  const [rules, setRules] = useState(null);               // null = не загружено / never created

  // Состояние действий
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Загрузка полей и существующих правил
  const load = useCallback(async () => {
    if (!processKey) return;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setSuccessMsg(null);

    try {
      // Параллельно: поля процесса + сохранённые таблицы правил
      const [fieldsRes, tables] = await Promise.all([
        fetch(
          `/api/forms/binding?processKey=${encodeURIComponent(processKey)}&stepKey=start`,
          { headers: authHeaders() },
        ),
        listRuleTables(processKey).catch(() => []),
      ]);

      // Поля (binding)
      if (fieldsRes.ok) {
        const data = await fieldsRes.json();
        setBindingFields(
          (data.fields || []).map((f) => ({
            key: f.key || f.name,
            label: f.label || f.title || f.key || f.name,
          })),
        );
      } else {
        setBindingFields([]);
      }

      // Правила: берём первую опубликованную, иначе последнюю черновик
      const arr = Array.isArray(tables) ? tables : [];
      const published = arr.find((t) => t.status === 'published');
      const draft = arr.find((t) => t.status === 'draft');
      const best = published || draft || null;

      if (best) {
        setTableId(best.id);
        setTableStatus(best.status);
        setTableName(best.name || 'Правила ветвления');
        // Загружаем полную запись (definition)
        const { getRuleTable } = await import('../canvas/dmn-editor-api.js');
        const full = await getRuleTable(best.id);
        const uiRules = apiRulesToUiState(full);
        setRules(uiRules || []);
      } else {
        // Ещё нет правил → пустой редактор
        setTableId(null);
        setTableStatus(null);
        setTableName('Правила ветвления');
        setRules(null); // null = never created (EmptyState)
      }
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [processKey]);

  useEffect(() => {
    load();
  }, [load]);

  // Начать создание правил с нуля
  function startEditing() {
    const firstField = bindingFields[0]?.key || '';
    setRules([emptyRule(firstField), defaultRule()]);
    setSuccessMsg(null);
    setActionError(null);
  }

  // Добавить новое правило (перед «иначе»)
  function addRule() {
    const firstField = bindingFields[0]?.key || '';
    setRules((prev) => {
      const arr = prev || [];
      const defIdx = arr.findIndex((r) => r.isDefault);
      const newRule = emptyRule(firstField);
      if (defIdx >= 0) {
        return [...arr.slice(0, defIdx), newRule, ...arr.slice(defIdx)];
      }
      return [...arr, newRule];
    });
  }

  // Удалить правило
  function removeRule(id) {
    setRules((prev) => (prev || []).filter((r) => r.id !== id));
  }

  // Обновить правило
  function updateRule(updated) {
    setRules((prev) => (prev || []).map((r) => (r.id === updated.id ? updated : r)));
  }

  // Сохранить черновик
  const handleSave = useCallback(async () => {
    if (!rules || rules.length === 0) return;
    setSaving(true);
    setActionError(null);
    setSuccessMsg(null);
    try {
      const body = rulesToApiBody(rules, tableName || 'Правила ветвления', processKey);
      const result = await saveRuleTable(body);
      setTableId(result.id);
      setTableStatus('draft');
      setSuccessMsg('Черновик сохранён');
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSaving(false);
    }
  }, [rules, tableName, processKey]);

  // Опубликовать
  const handlePublish = useCallback(async () => {
    if (!tableId) {
      setActionError('Сначала сохраните правила как черновик');
      return;
    }
    setPublishing(true);
    setActionError(null);
    setSuccessMsg(null);
    try {
      await publishRuleTable(tableId);
      setTableStatus('published');
      setSuccessMsg('Правила опубликованы и применяются в процессе');
    } catch (e) {
      setActionError(e.message);
    } finally {
      setPublishing(false);
    }
  }, [tableId]);

  // Возврат к каталогу процессов
  function handleBack() {
    navigate('/processes');
  }

  // ---------------------------------------------------------------------------
  // Рендер
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="chs-inbox">
        <div className="chs-inbox__scroll">
          <LoadingState label="Загрузка правил ветвления…" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="chs-inbox">
        <div className="chs-inbox__scroll">
          <ErrorState
            title="Не удалось загрузить правила"
            message={loadError}
            onRetry={load}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="chs-inbox">
      <div className="chs-inbox__scroll">
        {/* Заголовок + кнопки действий */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: 'var(--chs-space-4)',
            borderBottom: '1px solid var(--chs-border)',
            gap: 'var(--chs-space-4)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
              <button
                type="button"
                onClick={handleBack}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--chs-color-primary)',
                  padding: '0',
                  fontSize: 'var(--chs-text-sm)',
                }}
                aria-label="Вернуться к процессам"
              >
                ← Процессы
              </button>
              <span style={{ color: 'var(--chs-color-text-muted)' }}>/</span>
              <span
                style={{
                  fontSize: 'var(--chs-text-sm)',
                  color: 'var(--chs-color-text-muted)',
                }}
              >
                {processKey}
              </span>
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 'var(--chs-text-lg)',
                fontWeight: 600,
              }}
            >
              Правила ветвления
            </h1>
            {tableStatus && (
              <span
                style={{
                  fontSize: 'var(--chs-text-xs)',
                  color:
                    tableStatus === 'published'
                      ? 'var(--chs-color-success)'
                      : 'var(--chs-color-text-muted)',
                }}
              >
                {tableStatus === 'published' ? 'Опубликовано' : 'Черновик'}
              </span>
            )}
          </div>

          {rules !== null && (
            <div style={{ display: 'flex', gap: 'var(--chs-space-2)', flexShrink: 0 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSave}
                disabled={saving || publishing}
                loading={saving}
              >
                Сохранить черновик
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handlePublish}
                disabled={!tableId || saving || publishing}
                loading={publishing}
                title={!tableId ? 'Сначала сохраните черновик' : undefined}
              >
                Опубликовать
              </Button>
            </div>
          )}
        </div>

        {/* Сообщения об ошибках и успехе */}
        {actionError && (
          <div
            role="alert"
            style={{
              margin: 'var(--chs-space-3) var(--chs-space-4) 0',
              padding: 'var(--chs-space-3) var(--chs-space-4)',
              background: 'var(--chs-color-danger-soft)',
              border: '1px solid var(--chs-color-danger)',
              borderRadius: 'var(--chs-radius-3)',
              fontSize: 'var(--chs-text-sm)',
              color: 'var(--chs-color-text)',
            }}
          >
            {actionError}
          </div>
        )}
        {successMsg && (
          <div
            role="status"
            aria-live="polite"
            style={{
              margin: 'var(--chs-space-3) var(--chs-space-4) 0',
              padding: 'var(--chs-space-3) var(--chs-space-4)',
              background: 'var(--chs-color-success-soft)',
              border: '1px solid var(--chs-color-success)',
              borderRadius: 'var(--chs-radius-3)',
              fontSize: 'var(--chs-text-sm)',
              color: 'var(--chs-color-text)',
            }}
          >
            {successMsg}
          </div>
        )}

        {/* Основной контент */}
        <div style={{ padding: 'var(--chs-space-4)' }}>
          {/* Пустое состояние — правил ещё нет */}
          {rules === null && (
            <EmptyState
              title="Правила ветвления не заданы"
              description="Создайте правила, чтобы процесс автоматически направлял заявки по нужному маршруту — в зависимости от значений полей формы."
              action={
                <Button variant="primary" size="sm" onClick={startEditing}>
                  Создать правила
                </Button>
              }
            />
          )}

          {/* Редактор правил */}
          {rules !== null && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--chs-space-4)',
                maxWidth: '760px',
              }}
            >
              {/* Название набора правил */}
              <Field
                label="Название набора правил"
                id="dmn-table-name"
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder="Правила ветвления"
              />

              {/* Пояснение */}
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--chs-text-sm)',
                  color: 'var(--chs-color-text-muted)',
                }}
              >
                Правила проверяются по порядку. Первое сработавшее правило определяет
                маршрут заявки. Если ни одно условие не выполнено — применяется строка
                «Иначе».
              </p>

              {/* Список правил */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--chs-space-3)',
                }}
              >
                {rules.length === 0 && (
                  <p
                    style={{
                      color: 'var(--chs-color-text-muted)',
                      fontSize: 'var(--chs-text-sm)',
                    }}
                  >
                    Нет правил. Добавьте хотя бы одно условие и строку «Иначе».
                  </p>
                )}
                {rules.map((rule, idx) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    index={idx}
                    fields={bindingFields}
                    onChange={updateRule}
                    onRemove={removeRule}
                    total={rules.length}
                  />
                ))}
              </div>

              {/* Кнопка «Добавить правило» */}
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  glyph={<KitIcon name="plus" className="chs-btn__glyph" />}
                  onClick={addRule}
                  disabled={saving || publishing}
                >
                  Добавить правило
                </Button>
              </div>

              {/* Повтор кнопок в низу при длинном списке */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--chs-space-2)',
                  borderTop: '1px solid var(--chs-border)',
                  paddingTop: 'var(--chs-space-3)',
                }}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || publishing}
                  loading={saving}
                >
                  Сохранить черновик
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handlePublish}
                  disabled={!tableId || saving || publishing}
                  loading={publishing}
                  title={!tableId ? 'Сначала сохраните черновик' : undefined}
                >
                  Опубликовать
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DmnEditorScreen;
