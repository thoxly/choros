# Spec · T-0078 — E11.7 · Авторинг Red-Lines Guard

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0078 · E11.7 · build · parent = T-0070 (E11)
**ADR consumed:** `docs/design/extensibility-and-authoring.md`
  §4 (RED-LINES раздел — категорический human-confirm, default-DENY на необратимость),
  §5 (системные справочники: core-owned, extend-not-replace),
  §9 гард 7 (default-DENY на необратимость — любая необратимая операция по умолчанию
  требует human-confirm, не enumerated-allowlist)
**Прецедент:** T-0177 `classifySchemaChange` (src/core/schema-change-classifier.ts) —
  drop/rename/lossy → 409 default-DENY + force escape-hatch для `registry_def.record_schema`.
  T-0078 = обобщение этой же дисциплины на **авторинг-операции** (форм и объектных схем).
**Сёстры:** T-0073 (Floor-1 редактор), T-0074 (floor-классификатор) — параллельны.

---

## 1. Summary

T-0078 строит **авторинг-red-line гард** — чистую функцию классификации необратимости
авторинг-операций над полями форм (`form_def`) и объектных схем (`object_schema`).

**Охват (§9 гард 7 + §4 RED-LINES):**

| Операция | Тип | Класс |
|---|---|---|
| drop field_key из form_def | поле формы | destructive |
| rename field_key в form_def | поле формы | destructive (= drop старого + add нового) |
| lossy type-change core-поля form_def (number→integer, string→enum-сужение) | поле формы | destructive |
| drop field_key из object_schema | поле объектной схемы | destructive |
| rename field_key в object_schema | поле объектной схемы | destructive |
| lossy type-change object_schema (number→integer, string→enum-сужение) | поле объектной схемы | destructive |
| delete/rename core/system-directory-поля (core-owned) | системный справочник | destructive (всегда, без core-check) |
| add field, relabel (title/description), toggle required, enum-widening | любой | soft (non-destructive) |

Классификатор **не знает** о конкретном DB-сопровождении `form_def` (таблица ещё не
существует) — реализован как **чистая функция от параметров**: `AuthoringOp` (описание
операции), `AuthoringContext` (контекст поля: core-owned flag). Это честно: HTTP-слой
будущего T-0073 будет конвертировать DB-запись в `AuthoringContext` и передавать сюда.

**Механика default-DENY:**

ADR §9 гард 7: «default-DENY на необратимость — не enumerated-allowlist». Это СТРОЖЕ,
чем T-0177, который использует 409+force escape-hatch. Per §4 (RED-LINES раздел):
подтверждение должно быть **семантическим** — человек ПИШЕТ последствие словами,
не нажимает «OK». Для core/system-directory-полей escape-hatch запрещён вообще.

**Confirm-контракт (semantic human-confirm, §4):**

```ts
interface AuthoringRedLineConfirm {
  // Человек ПИШЕТ последствие — свободный текст, содержащий слово последствия.
  // Пример: "поле amount будет удалено и данные будут потеряны"
  // Минимальное требование: не пустой, не автозаполненный флаг.
  consequenceStatement: string;  // ≥ 10 символов, не дефолтный шаблон
  // Опционально: force разрешён ТОЛЬКО для non-core полей
  force?: boolean;               // только если context.isCorePinned === false
}
```

Гард принимает `confirm` в качестве аргумента и проверяет:
1. `consequenceStatement.length >= 10` — не пустой.
2. Подтверждение не является одним из запрещённых шаблонов (автозаполнение).
3. `force === true` только если `context.isCorePinned === false`.

Если подтверждение отсутствует → `deny` (default-DENY). Если core-pinned + force → `deny`.

---

## 2. Functional Requirements

- **FR-1** `classifyAuthoringOp(op: AuthoringOp, context: AuthoringContext): AuthoringChangeClass`
  — чистая функция в `src/core/authoring-redlines.ts`. No I/O, no DB, no env.

- **FR-2** Классифицирует операцию как `'non_destructive'` | `'destructive'` | `'core_pinned'`.
  - `'non_destructive'` — add field, relabel, toggle required, enum widening.
  - `'destructive'` — drop, rename, lossy type-change на non-core поле.
  - `'core_pinned'` — drop/rename/lossy на core-owned/system-directory поле.

- **FR-3** Импортирует `isLossyNarrowing` (private helper) из T-0177 через переиспользование
  логики — но НЕ копирует: должен импортировать `FieldSchemaEntry` из
  `schema-change-classifier.js` и реализовать аналогичную проверку через экспортируемую
  вспомогательную функцию (если экспортирована) или переиспользовать тип. Если
  `isLossyNarrowing` не экспортируется T-0177 — реализовать собственный `isLossyFieldChange`
  со ссылкой на прецедент T-0177 в комментарии ADR (не копировать алгоритм — он идентичен).

- **FR-4** `evaluateAuthoringRedLine(op, context, confirm?): AuthoringRedLineDecision` — 
  gate function: принимает op + context + опциональный confirm и возвращает решение:
  - `{ verdict: 'allow' }` — non_destructive операция, confirm не нужен.
  - `{ verdict: 'deny', reason: ..., requiresConfirm: true }` — destructive, confirm отсутствует
    или невалиден.
  - `{ verdict: 'deny', reason: 'core_pinned', requiresConfirm: false }` — core-locked поле,
    escape-hatch запрещён.
  - `{ verdict: 'allow', classification: 'destructive', confirmedConsequence: string }` — 
    destructive + валидный semantic confirm.

- **FR-5** Типы `AuthoringOp`, `AuthoringContext`, `AuthoringChangeClass`, `AuthoringRedLineDecision`,
  `AuthoringRedLineConfirm`, `AuthoringOpKind` экспортируются из модуля.

- **FR-6** ADR-reference комментарий ссылается на `classifySchemaChange` (T-0177) как прецедент
  и на `checkBindingCompat` (T-0072) — единый control plane согласованности.

---

## 3. Types / Interfaces

```ts
// Вид авторинг-операции
type AuthoringOpKind =
  | 'add_field'
  | 'drop_field'
  | 'rename_field'
  | 'change_type'
  | 'relabel'
  | 'toggle_required'
  | 'enum_change';

// Описание конкретной авторинг-операции
interface AuthoringOp {
  kind: AuthoringOpKind;
  fieldKey: string;
  // Для change_type / enum_change — старые и новые значения
  oldSchema?: FieldSchemaEntry;  // из schema-change-classifier.js
  newSchema?: FieldSchemaEntry;
}

// Контекст поля: знает о core-pinned статусе
interface AuthoringContext {
  // true = поле принадлежит core/system-directory (контрагенты, оргструктура, пользователи)
  // Такие поля блокированы от drop/rename/overwrite — §5 ADR.
  isCorePinned: boolean;
}

// Класс изменения (результат classifyAuthoringOp)
type AuthoringChangeClass = 'non_destructive' | 'destructive' | 'core_pinned';

// Semantic confirm (§4 RED-LINES)
interface AuthoringRedLineConfirm {
  consequenceStatement: string;  // ≥ 10 символов, не пустой
  force?: boolean;               // только для non-core; игнорируется для core_pinned
}

// Решение гарда (результат evaluateAuthoringRedLine)
type AuthoringRedLineDecision =
  | { verdict: 'allow'; classification: 'non_destructive' }
  | { verdict: 'allow'; classification: 'destructive'; confirmedConsequence: string }
  | { verdict: 'deny'; reason: 'requires_confirm'; classification: 'destructive'; requiresConfirm: true }
  | { verdict: 'deny'; reason: 'invalid_confirm'; classification: 'destructive'; requiresConfirm: true }
  | { verdict: 'deny'; reason: 'core_pinned'; classification: 'core_pinned'; requiresConfirm: false };
```

---

## 4. Acceptance Criteria

| ID | Текст | Verifiable |
|---|---|---|
| AC-1 | `src/core/authoring-redlines.ts` существует; tsc exit 0. | fitness |
| AC-2 | `add_field` → `non_destructive`; `evaluateAuthoringRedLine` → `allow`. | test |
| AC-3 | `drop_field` non-core → `destructive`; без confirm → `deny`. | test |
| AC-4 | `drop_field` non-core + валидный confirm (≥10 символов, force=true) → `allow`. | test |
| AC-5 | `rename_field` non-core без confirm → `deny`. | test |
| AC-6 | `change_type` number→integer non-core, aggregate-контекст без confirm → `deny`. | test |
| AC-7 | `change_type` number→integer + confirm → `allow (destructive + confirmedConsequence)`. | test |
| AC-8 | `drop_field` core-pinned → `core_pinned`; `evaluateAuthoringRedLine` → `deny` reason=`core_pinned` даже при force=true. | test |
| AC-9 | `rename_field` core-pinned → `deny` reason=`core_pinned`. | test |
| AC-10 | `relabel` core-pinned → `non_destructive` (core pin не блокирует soft ops). | test |
| AC-11 | `enum_change` widening (больше значений) → `non_destructive`. | test |
| AC-12 | `enum_change` narrowing (меньше значений) non-core без confirm → `deny`. | test |
| AC-13 | confirm с `consequenceStatement` < 10 символов → `deny` reason=`invalid_confirm`. | test |
| AC-14 | Модуль pure: нет pg, node:fs, node:http, node:net, import.meta, process.env, process.exit. | fitness |
| AC-15 | ADR-ссылки на T-0177 `classifySchemaChange` + T-0072 `checkBindingCompat` в комментарии. | fitness |
| AC-16 | Экспорты `AuthoringOp`, `AuthoringContext`, `AuthoringChangeClass`, `AuthoringRedLineDecision`, `AuthoringRedLineConfirm`, `AuthoringOpKind`, `classifyAuthoringOp`, `evaluateAuthoringRedLine` все присутствуют. | fitness |
| AC-17 | `npm run fitness` exit 0 после добавления `authoring-redlines-isolation.sh`. | fitness |
| AC-18 | Нет дублирования алгоритма isLossyNarrowing — либо импорт, либо явная ссылка в комментарии на T-0177 прецедент. | fitness |

---

## 5. Out of Scope

- HTTP-слой гарда (будет в T-0073 Floor-1 редакторе)
- DB-хранение `form_def` (таблица не существует)
- Changelog-эмиссия (T-0084)
- bundle-coherence enforcement (T-0082/T-0179)
- Конкретная форма UI-представления consequenceStatement
