# T-0532 — Shared Label/Format Layer

> DESIGN-спека · статус: ready · автор: architect · дата: 2026-06-29

## Проблема

В русскоязычном no-code B2B интерфейсе Choros операторам показываются сырые машинные детали:
- UUID сущностей (`3fa2c1d4-…`) — вместо имён записей / сотрудников / ролей
- JSON-дампы (`JSON.stringify(v)`) — вместо читаемого значения поля
- Сырые HTTP-коды (`HTTP 500`, `HTTP 401`) — вместо понятного сообщения с шагом
- Английские enum-значения (`draft`, `published`, `running`, `failed`, `human`, `agent`) — вместо русских подписей
- ISO-таймстемпы (`2026-06-29T14:32:08.000Z`) — вместо локализованного формата (`29 июн 2026, 14:32`)
- Internal-жаргон (`Tier-1`, `Floor-2`, `control-plane`, `validateNarrowing`, `PT24H`, `mcp://`) — вместо user-facing формулировок

Это прямо нарушает обещание «no-code» и не проходит UX-гейт G5 (ux-g5-jargon-denylist).

## Решение: модуль `web/src/lib/format.js`

Один тонкий React-free модуль (нет зависимостей, только stdlib). Экспортирует чистые функции — все компоненты-потребители импортируют отсюда.

### Почему `web/src/lib/` а не `components/`

`components/` — визуальные примитивы (JSX). `lib/` — чистая логика без рендера (уже используется: `field-contract.js`, `records-form.js`). Форматтеры — логика, не JSX; это конвенция codebase.

---

## A. API слоя

```js
// web/src/lib/format.js

// 1. Дата/время — локаль ru-RU, без мс, без Z
// value: Date | ISO-string | epoch-ms | null/undefined
// mode: 'datetime' | 'date' | 'time' (default: 'datetime')
formatDate(value, mode = 'datetime') → string
// Примеры:
//   formatDate('2026-06-29T14:32:08.123Z') → '29 июн 2026, 14:32'
//   formatDate('2026-06-29T14:32:08.123Z', 'date') → '29 июн 2026'
//   formatDate(null) → '—'

// 2. Enum → человеческая подпись (из builtin-каталога + опционально schema-options)
// value: string (машинное значение), labelMap?: Record<string,string>
formatEnum(value, labelMap) → string
// Встроенный каталог (ENUM_LABELS ниже) покрывает системные enum.
// Поля-приложения передают свои options через labelMap (см. §D).
// Если нет в каталоге — value возвращается as-is (не бросать).

// 3. HTTP/Server error → дружелюбный текст с шагом
// statusOrCode: number (HTTP status) | string (server error code)
formatError(statusOrCode) → string
// 401 → 'Сессия истекла — войдите снова'
// 403 → 'Недостаточно прав для этого действия'
// 404 → 'Запись не найдена'
// 409 → 'Конфликт — запись уже существует'
// 422 → 'Данные не прошли проверку — исправьте поля'
// 500, 502, 503, 504 → 'Ошибка сервера — попробуйте позже'
// ENGINE_UNAVAILABLE → 'Движок процессов недоступен — попробуйте позже'
// SUBSTITUTION_WIDENS → 'Подмена не может расширять права — измените область'
// неизвестное → 'Что-то пошло не так (${code}) — попробуйте ещё раз'

// 4. Ref (UUID/id/slug) → имя сущности
// Синхронный: из уже загруженного кэша (Map<id, label>).
// value: string (uuid | slug), cache: Map<string,string>
// options: { fallback?: string } (default: '—')
formatRef(value, cache, options) → string
// Если value в кэше → возвращает cache.get(value)
// Если не в кэше → возвращает options.fallback ?? '—'
// UUID-паттерн: [0-9a-f]{8}-... → всегда проходит через formatRef (не показывать raw)

// 5. JSON-объект → строка для read-only отображения (не <pre>!)
formatJsonReadable(value) → string
// Если value === null/undefined → '—'
// Если примитив → String(value)
// Если объект/массив → JSON.stringify(value, null, 0) обрезается до 120 символов + '…'
// Никогда не рендерить как JSX-пре.
```

### Встроенный ENUM_LABELS (системные enum)

```js
// Статусы процессов и задач
draft:      'Черновик'
published:  'Опубликован'
running:    'Выполняется'
pending:    'Ожидает'
waiting:    'Ожидает'
completed:  'Завершён'
done:       'Завершён'
failed:     'Ошибка'
paused:     'Приостановлен'
cancelled:  'Отменён'
active:     'Активен'
inactive:   'Неактивен'

// Типы исполнителей (уже в EXEC_META components.jsx, дублировать не нужно)
human:      'Человек'
agent:      'Агент'
service:    'Сервис'

// Типы полей (field types в каталоге)
string:     'Текст'
text:       'Текст (длинный)'
number:     'Число'
integer:    'Целое число'
boolean:    'Флаг (да/нет)'
date:       'Дата'
money:      'Сумма (₽)'
select:     'Выбор из списка'
multi-select: 'Мульти-выбор'
url:        'Ссылка'
email:      'E-mail'
person:     'Сотрудник'
relation:   'Связь с записью'
collection: 'Таблица (строки)'
date-range: 'Период'
rollup:     'Вычисляемое'
computed:   'Вычисляемое'
file:       'Файл'

// Типы actions / операций
grant:      'Выдача прав'
revoke:     'Отзыв прав'
narrow:     'Сужение прав'
```

---

## B. Где живёт и как экранам зовут

**Файл:** `web/src/lib/format.js`
- Нет JSX, нет React, нет внешних зависимостей
- Экспортирует `formatDate`, `formatEnum`, `formatError`, `formatRef`, `formatJsonReadable`

**Паттерн использования в компоненте:**
```jsx
import { formatDate, formatEnum, formatError, formatRef } from '../lib/format.js';

// Было: new Date(r.occurred_at).toISOString().replace("T", " ").replace("Z", "")
// Стало:
<span>{formatDate(r.occurred_at)}</span>

// Было: <li>{typeof v === 'string' ? v : JSON.stringify(v)}</li>
// Стало:
<li>{typeof v === 'string' ? v : formatJsonReadable(v)}</li>

// Было: `Подмена объявлена (Tier-${r.data.tier})`
// Стало: 'Подмена объявлена'  (Tier-X — внутренний термин, убрать из сообщения)

// Было: {record.id}
// Стало: {formatRef(record.id, recordCache)}
```

**Async-вариант для UUID:** когда кэш ещё не заполнен — рендерим `'—'` и догружаем асинхронно. Компонент хранит `Map<id, label>` в `useState`, обновляет через `useEffect`. Форматтер остаётся синхронным.

---

## C. Источник человеческих подписей enum

### Системные enum
Хранятся в `ENUM_LABELS` внутри `format.js`. Это единственная правда для `draft/published/running/failed/human/agent/service/grant/revoke` и т.д. Никаких дублей в компонентах.

### Пользовательские enum (options в schema)
Поля-приложения определяются через `registry_def` → `record_schema` → `properties[key].enum` + `x-options-labels`. Сейчас `field-renderer.jsx` получает `field.options` как массив строк (machine values) без labels.

**Расширение (не меняет формат прямо сейчас, добавляется при impl):**
- `field.options` уже может быть `string[]` (старый формат) ИЛИ `Array<{value:string, label:string}>` (новый).
- `formatEnum(value, labelMap)` принимает `labelMap` — если поле уже несёт `options = [{value, label}]`, caller строит `labelMap = Object.fromEntries(options.map(o => [o.value, o.label]))` и передаёт.
- `binding-contract-catalog.ts` может расширить тип `FieldOption = string | {value: string, label: string}` — это impl-решение (вне scope T-0532 DESIGN).

**Вывод:** разветки нет, `formatEnum` универсален. Источник labels — либо встроенный каталог, либо `labelMap` из schema options.

---

## D. Правило «никогда не показывать raw»

**Инвариант (enforcement через grep-гард в CI):**

> Ни один JSX-файл в `web/src/` не должен рендерить:
> 1. `JSON.stringify(` в JSX-возврате (кроме API-body и тестов)
> 2. UUID-паттерн `[0-9a-f]{8}-[0-9a-f]{4}` напрямую в JSX-тексте
> 3. `toISOString()` в JSX (кроме `type="datetime-local"` value props)
> 4. `HTTP [0-9]{3}` в пользовательском тексте
> 5. Английские статус-enum в рендере: `'draft'|'published'|'running'|'pending'|'failed'` в JSX (не в условиях/сравнениях)

Исключения документируются инлайн: `// format-layer-exempt: <reason>`

---

## E. Таблица типов утечки → форматтер

| Тип утечки | Пример сейчас | Форматтер | Пример после |
|---|---|---|---|
| ISO-таймстемп | `2026-06-29T14:32:08.123Z` | `formatDate(v)` | `29 июн 2026, 14:32` |
| ISO без мс (ручная правка) | `.toISOString().replace("T"," ").replace("Z","")` | `formatDate(v)` | `29 июн 2026, 14:32` |
| JSON-дамп объекта | `JSON.stringify(val)` в JSX | `formatJsonReadable(val)` | `{name: "Иванов", …}` (≤120 символов) |
| UUID запись/id | `{record.id}` | `formatRef(record.id, cache)` + `<MonoId chip>` если нужен кликабельный | `Закупка #2024-01` или `—` |
| UUID в подписях прав | `fallbackPlaceholder="UUID роли"` | `formatRef(id, roleCache)` | `Сотрудник / Руководитель отдела` |
| HTTP-код в тексте | `throw new Error('HTTP 500')` → показан юзеру | `formatError(res.status)` | `Ошибка сервера — попробуйте позже` |
| Server error code | `ENGINE_UNAVAILABLE` | `formatError('ENGINE_UNAVAILABLE')` | `Движок процессов недоступен — попробуйте позже` |
| Английский enum | `status: "draft"` в тексте | `formatEnum(status)` | `Черновик` |
| Internal-жаргон | `Tier-1`, `Floor-2`, `validateNarrowing` | удалить из UI-текстов, оставить только в console/telemetry | `Подмена объявлена` |
| ISO-duration | `PT24H` | Отдельный helper `formatDuration('PT24H')` → `24 часа` (impl в T-0532 или followup) |

---

## F. Граница с T-0528 (глобальный ToastProvider)

T-0528 строит **инфраструктуру** доставки сообщений (ToastProvider, ToastViewport, useToast()).
T-0532 строит **содержимое** сообщений — тексты ошибок, читаемые labels.

Взаимодействие:
```js
// T-0528 даёт:
const { error: showError } = useToast();

// T-0532 даёт:
import { formatError } from '../lib/format.js';

// Вместе:
showError(formatError(res.status));
```

T-0532 не зависит от T-0528 (format.js — чистый модуль без JSX). T-0528 может начать использовать formatError сразу после impl T-0532.

---

## G. Нераскрытые вопросы (status: ready, не needs_founder)

Вопросов к фаундеру нет — все технические развилки закрыты:
1. Синхронный vs async `formatRef` → синхронный с кэшем в useState (стандарт SPA).
2. Enum-labels из registry_def → `labelMap`-параметр в `formatEnum`, buildLabelMap в caller.
3. Граница с T-0528 → ясна (см. §F выше).
4. ISO-duration (`PT24H`) → helper `formatDuration` добавляется в тот же `format.js` при impl, не блокирует DESIGN.
