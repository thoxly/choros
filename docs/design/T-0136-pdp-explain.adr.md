# T-0136 — Explain-эндпоинт PDP

**Статус:** SPEC · **Дата:** 2026-06-12 · **Задача:** T-0136 (impl, prio 45)

## 1. Контекст

gap-map §4, инвариант 4: «Explain-PDP — админская поверхность за mgmt-грантом:
`почему не вижу` не раскрывает пользователю существование скрытого поля (не
конфликтовать с fail-closed маскингом T-0033)».

Без этого эндпоинта администратор не может диагностировать «почему Вася не видит
документ» без чтения SQL. Объяснение чужих прав — чувствительная поверхность:
субъект может не знать о существовании ресурса (fail-closed маскинг T-0033).

## 2. Дизайн-выборы

### 2.1 Trace-режим vs обёртка

**Выбор: trace-режим внутри `resolveFor` (режим `trace`).**

Два варианта:

| Вариант | Плюс | Минус |
|---|---|---|
| Копия логики | Независимость | Расхождение вердиктов — критическая ошибка |
| Обёртка (вызвать resolveFor, отдельно собрать шаги) | Не дублирует логику | Шаги не наблюдаемы снаружи (фильтрация, scope-check) |
| **Trace-режим** (передать `TraceCollector?` в resolveFor) | Единая логика, шаги видны | Чуть сложнее интерфейс |

Trace-режим: `resolveFor` принимает необязательный `traceOut?: TraceCollector`.
Когда передан — коллектор накапливает шаги внутри той же функции. Вердикт
`explain.verdict === resolveFor.verdict` гарантирован структурно (не тестом).

### 2.2 Кто вправе вызывать explain?

**Правило:** explain доступен двум классам запрашивающих:

1. **Сам актор о себе** — `subject.subjectId === callerSubjectId`. Актор может
   спрашивать только о своих правах на ресурс.

2. **Администратор с mgmt-грантом** — caller держит подтверждённый,
   действующий, delegable grant на `mgmt_object:grant` с `operation="read"` и
   scope, покрывающим ресурс. Проверяется через `validateAdminDelegation` /
   `loadAdminContext` (тот же механизм, что grant write-API).

Обоснование: `explain` читает цепочку прав другого субъекта (аналог
`mgmt_object:grant` + `read`). Читать чужие права = иметь право на
`mgmt_object:grant`. Сам актор о себе не является разведкой.

**Анти-oracle (для не-админа о чужом субъекте):** 403 без уточнения причины.
Ответ для админа: трасса с шагами. Ответ для самоопроса: те же шаги, но
сообщения в нечувствительных формулировках (без имён полей маскинга — инвариант 4).

### 2.3 Трасса шагов

Шаги в порядке пайплайна `resolveFor`:

| # | Имя шага | Источник | Красный при |
|---|---|---|---|
| 1 | `tenant` | cross_tenant check | handle.tenantId ≠ subject.tenantId |
| 2 | `grants_resolved` | GrantSource.getGrants | — (информационный) |
| 3 | `effective_filter` | isEffective per grant | ни один грант не прошёл окно |
| 4 | `scope_filter` | isLatticeScope + isNarrowerOrEqual | ни один грант не покрывает scope |
| 5 | `covering` | итог фильтрации | covering.length === 0 → `no_grant` |
| 6 | `effect_grants` | verifyEffectGrants (invoke) | no_effect_grant |
| 7 | `sod` | evaluateSod (approve/transition) | sod_violation |
| 8 | `record_fetch` | records.getRecord | not_found |
| 9 | `masking` | buildMaskContext / maskFields | — (информационный) |

Первый красный шаг = `first_denial`. После него шаги не останавливаются
(в trace-режиме они не выполняются, если логика уже вернула denied — см. §3.2).

### 2.4 Анти-oracle для маскинга (инвариант 4)

Шаг `masking` в ответе:
- **Для самоопроса:** `"masking": { "governed": true/false }` — без имён полей.
- **Для admin-explain:** `"masking": { "governed": true/false, "maskedFields": [...] }` —
  поля, получившие трансформ `≠ raw`. Это разрешено: admin с mgmt_object:grant
  имеет право видеть структуру прав.

Имена полей с `drop`-маской не раскрываются даже при самоопросе (они не видны
субъекту, раскрыть существование = oracle).

## 3. API

### 3.1 Эндпоинт

```
POST /api/pdp/explain
```

Тело запроса:
```json
{
  "subject": { "tenantId": "...", "subjectId": "..." },
  "handle": {
    "ref": { "kind": "record", "tenantId": "...", "registryId": "...", "recordId": "..." },
    "tenantId": "...",
    "facet": { "fields": ["f1", "f2"] }   // опционально
  },
  "operation": "read"
}
```

Ответ 200:
```json
{
  "verdict": "allow" | "deny",
  "reason": "no_grant" | "cross_tenant" | "not_found" | "sod_violation" | "no_effect_grant" | null,
  "steps": [
    { "step": "tenant",         "ok": true },
    { "step": "grants_resolved","ok": true, "count": 3 },
    { "step": "effective_filter","ok": true, "passed": 2 },
    { "step": "scope_filter",   "ok": false, "passed": 0 },
    { "step": "covering",       "ok": false, "reason": "no_grant" }
  ],
  "masking": { "governed": false }
}
```

### 3.2 Поведение trace

`TraceCollector` — интерфейс с методом `push(step)`. Передаётся в `resolveFor`
как необязательный 7-й параметр. `resolveFor` вызывает `trace?.push(...)` в
каждой ключевой точке и возвращает стандартный результат. Если trace не передан —
поведение побайтово совпадает с предыдущим (аддитивно, NF-2 / backward-compatible).

### 3.3 Authz самого explain-а

1. Извлечь `caller` из `X-Dev-User`.
2. Проверить: `caller === body.subject.subjectId` (самоопрос) или
   `loadAdminContext` + `validateAdminDelegation({ kind: "grant" })` с `mgmt_object:grant`.
3. При отказе: 403 `EXPLAIN_FORBIDDEN`.

### 3.4 Режим без DB

Если `DATABASE_URL` не задан — эндпоинт недоступен (503 `NO_DATABASE`).
Логика explain требует реальных грантов из БД.

## 4. Acceptance criteria

| ID | Условие |
|---|---|
| AC-1 | `explain.verdict == resolveFor.verdict` для матрицы кейсов (property-test) |
| AC-2 | Шаг `tenant` красный при cross_tenant |
| AC-3 | Шаг `covering` красный с reason=`no_grant` при пустых грантах |
| AC-4 | Шаг `scope_filter` красный при грантах вне scope |
| AC-5 | Шаг `effective_filter` красный при грантах вне временного окна |
| AC-6 | Шаг `record_fetch` красный с reason=`not_found` |
| AC-7 | Шаг `masking` присутствует при resolved=allow |
| AC-8 | Самоопрос: masking не раскрывает имена drop-полей |
| AC-9 | Не-admin запрос о чужом субъекте: 403 |
| AC-10 | Admin с mgmt_object:grant: 200 с трассой |
| AC-11 | Без DB: 503 |

## 5. Нефункциональные требования

- **NF-1**: `TraceCollector` — необязательный параметр; `resolveFor` без него
  компилируется и работает побайтово идентично.
- **NF-2**: Trace не выполняет IO (пишет только в переданный коллектор).
- **NF-3**: Explain не читает запись, если `no_grant` на шаге 5 (не обходит
  fail-closed).
- **NF-4**: Анти-oracle: explain 403 без причины для не-admin запроса о чужих
  правах.
