# ADR-T0604 — Авто-комплит on_create гейтится по задекларированному submit_task_key, NULL = не трогать

**Status:** ready
**Phase:** DESIGN
**Task:** T-0604 [приёмочный P0 2026-07-03]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0604-skip-submit-defkey.spec.md` + `docs/specs/T-0604.spec.contract.json` (AC-1..AC-9)
**База:** dev @ `bd9b1a7` (ветка `task/T-0604-skip-submit-defkey`, содержит T-0603)
**Предшественники:** T-0368 (E16 skip-submit), T-0571 (BUG-014 completeUserTask
verb-fix), T-0575 (BUG-015/BUG-017 config-primitive fallback discipline,
`target_registry_slug` — миграция 119), T-0443 (`getActiveUserTasks`).

---

## 1. Решение

**`process_app_binding` получает NULLABLE колонку `submit_task_key`. NULL —
единственный safe-default (нет авто-комплита); non-NULL включает
авто-комплит СТРОГО УСЛОВНО — только когда первый активный `userTask`
инстанса имеет РОВНО этот `taskDefinitionKey`.** Механизм читает
`getActiveUserTasks` (уже вызывается чуть ниже в `records.ts` для BUG-015),
не добавляет второй движковый вызов и не расширяет `getFirstActiveUserTask`.

### 1.1 Миграция (Дельта A) — `process_app_binding.submit_task_key`

Следующий свободный слот в `migrations/` (121 на момент разработки — проверить
`ls migrations/` перед коммитом на случай параллельного мержа). Мирроит
миграцию 119 (`target_registry_slug`) буквально по форме:

```sql
ALTER TABLE choros.process_app_binding
  ADD COLUMN IF NOT EXISTS submit_task_key text NULL;
```

Плюс DATA-обновление (не DDL) telLinear seed-ряда (085/087), делая явным
данными то, что раньше подразумевалось безусловной логикой:

```sql
UPDATE choros.process_app_binding
   SET submit_task_key = 'task-submit'
 WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
   AND process_key = 'telLinear'
   AND application_id = 'a7000000-0000-0000-0000-000000000001'
   AND submit_task_key IS NULL;
```

**NULL-семантика (в отличие от 119/BUG-017):** для `target_registry_slug`
NULL означает «используй ИМЕНОВАННЫЙ ДЕФОЛТ» (config-primitive
`resolveDefaultStepResultSlug()` → `"soglasovanie"`) — безопасно, потому что
дефолт лишь адресует, КУДА записать результат УЖЕ решённого человеком шага.
Здесь ставка другая: дефолт решал бы, ПРОПУСКАТЬ ЛИ человека вообще. Второй
угаданный литерал (`"task-submit"` как код-дефолт) был бы тем же классом
ошибки, что и баг T-0604 сам — просто на уровень конфигурации глубже: любой
тенантский процесс без объявленного submit-таска либо ложно совпал бы с
угаданным именем, либо (что не лучше) получил бы молчаливый unconditional
default. Поэтому здесь: **NULL = никакого авто-комплита, точка.** Никакой
`resolveDefaultSubmitTaskKey()` не вводится.

### 1.2 `binding-trigger-dao.ts` (Дельта B) — прокинуть колонку

`OnCreateBindingRow` получает `submit_task_key: string | null`;
`getOnCreateBinding`'s SELECT добавляет колонку в список; coercion зеркалит
существующий `field_mapping` null-handling (просто пробрасывает `string | null`,
без объектной коэрсии — колонка скалярна).

### 1.3 `records.ts` (Дельта C) — гейт по defKey, переиспользование getActiveUserTasks

Текущий блок (`:954-974`, T-0368) вызывает `getFirstActiveUserTask` (только
`taskId`) для решения о комплите, а НИЖЕ (`:986-994`, T-0575 BUG-015) отдельно
вызывает `getActiveUserTasks` (полный список с `taskDefinitionKey`) для
projection-полей. Оба вызова читают ОДИН И ТОТ ЖЕ движковый эндпоинт
(`GET /runtime/tasks?processInstanceId=...`) на одном и том же инстансе в
одном и том же месте выполнения (сразу после `startInstance`, до какого-либо
изменения состояния инстанса кодом продукта). Объединяем их: один вызов
`getActiveUserTasks(startResult.instanceId)`, результат (`tasks[0]`,
если есть) используется:

1. **Гейт комплита:** `binding.submit_task_key !== null && tasks[0]?.taskDefinitionKey === binding.submit_task_key` → `completeUserTask(tasks[0].id)`. Иначе — не трогаем (не ошибка, лог не нужен — это ожидаемое «не совпало»).
2. **BUG-015 projection:** РОВНО как сейчас — `tasks[0].candidateGroups[0]`/`tasks[0].name`, если непусто, иначе config-primitive fallback.

Порядок вызова СОХРАНЯЕТСЯ на прежнем месте (сразу после `startInstance`,
ПЕРЕД тем, что раньше было безусловным комплитом) — т.е. `getActiveUserTasks`
теперь читает состояние инстанса ДО авто-комплита (не после, как в текущем
BUG-015-коде, где `getActiveUserTasks` шёл ПОСЛЕ комплита и видел
пост-комплитное состояние). Это фактически ТОЧНЕЕ для BUG-015: если
`tasks[0]` — реально submit-таск и он ниже авто-завершается, projection
теперь видит его candidateGroups/name (submit-таска), тогда как раньше видела
СЛЕДУЮЩИЙ активный таск (уже после комплита) — расхождение существовало и
раньше молчаливо; консолидация делает семантику ЯВНОЙ и единообразной (одно
чтение engine-state, используемое дважды), а не меняет чей-то законтрактованный
результат (BUG-015 сам по себе — best-effort fallback-driven, не имеет
жёсткого контракта «после» vs «до»).

```ts
let firstActiveTask: ActiveUserTask | undefined;
try {
  const tasksResult = await flowable.getActiveUserTasks(startResult.instanceId);
  if (tasksResult.ok && tasksResult.tasks.length > 0) {
    firstActiveTask = tasksResult.tasks[0];
  }
} catch {
  // best-effort degrade — unchanged
}

// Gate: only auto-complete when the binding DECLARES a submit key AND the
// first active task's defKey matches it EXACTLY (never a code literal).
if (
  binding.submit_task_key !== null &&
  firstActiveTask !== undefined &&
  firstActiveTask.taskDefinitionKey === binding.submit_task_key
) {
  const completeResult = await flowable.completeUserTask(firstActiveTask.id);
  // ... same non-fatal warn-on-failure as today
}

// BUG-015 projection reads the SAME firstActiveTask (unchanged fallback logic).
```

`getFirstActiveUserTask` НЕ удаляется из клиента (публичный контракт метода,
может иметь другие вызывающие в будущем/тестах) — просто больше не вызывается
из этого блока `records.ts`.

### 1.4 Закон границы (D-064 §5, N1)

Ноль литеральных defKey-сравнений в `src/`: сравнение
`firstActiveTask.taskDefinitionKey === binding.submit_task_key` сравнивает
ДВЕ ПЕРЕМЕННЫЕ (движковое значение и значение из строки binding) — ни одна
сторона не является литеральной строкой в коде. Это ТОЧНО тот паттерн,
который `engine-drive-no-literal-defkey.sh`'s self-test явно признаёт
"known-good" (`t.taskDefinitionKey === args.approvedTaskDefKey` — сравнение
с caller-supplied значением, не с литералом). Строка `'task-submit'`
появляется ТОЛЬКО в SQL-миграции (данные тенанта/seed), не в `src/` — вне
периметра `detel-literal-baseline.sh` (сканирует только `src/**/*.ts`) и вне
периметра `engine-drive-no-literal-defkey.sh` (сканирует только
`process-projection.ts`, но даже если бы сканировал шире — наш код не вводит
такое сравнение).

## 2. Отклонённые альтернативы

(в contract-JSON)

## 3. Почему это правильный уровень

Баг T-0368 был структурным допущением («первый таск = submit»), которое
ошибочно предполагает единственный BPMN-топология (ТЭЛ-линейный процесс) как
универсальную. Правильный уровень фикса — сделать «что легитимно
авто-завершать» ЯВНОЙ КОНФИГУРАЦИЕЙ per-binding (данные), а не изменить
угадывание на другое угадывание (код-дефолт). Прецедент 119/BUG-017 показал
правильную ФОРМУ (nullable колонка на существующей tenant-таблице, additive),
но НЕ правильную семантику NULL для этого конкретного случая — данная задача
адаптирует форму, меняя семантику NULL там, где ставки другие (необратимое
движковое действие над человеческим шагом, не адресация уже свершившегося
результата).

## 4. План тестов (AC → FF)

1. `src/__tests__/binding-trigger.unit.test.ts` (расширение и
   ПЕРЕОСМЫСЛЕНИЕ существующих стабов, AC-3/AC-4/AC-5/AC-6): стаб-flowable
   `getActiveUserTasks` конфигурируется per-test (по умолчанию пустой список —
   зеркалит прежнее поведение "нет активных тасков"); стаб-binding-row несёт
   `submit_task_key`. Три новых кейса:
   - AC-3: binding `submit_task_key: null`, `getActiveUserTasks` возвращает
     таск с ЛЮБЫМ defKey → `completeUserTask` НЕ вызван.
   - AC-4: binding `submit_task_key: 'task-review'`, первый таск
     `taskDefinitionKey: 'task-review'` → `completeUserTask` вызван С ЭТИМ
     taskId.
   - AC-5: binding `submit_task_key: 'task-submit'`, первый таск
     `taskDefinitionKey: 'task-review'` (не совпадает) → `completeUserTask`
     НЕ вызван.
   Существующие тесты (проверяющие `startInstance`-вызов/rollback/savepoint/
   T-0603-роллап) сохраняют поведение (стаб `getActiveUserTasks` по умолчанию
   пуст → авто-комплит никогда не срабатывает в них, что уже было фактическим
   поведением ДО этой задачи в большинстве этих тестов — они не проверяли
   комплит вовсе).
2. Db/типовые (AC-1/AC-2): миграция применяется идемпотентно (`npm run
   fitness:db` гоняет полный набор миграций на чистой БД — миграция сама себя
   валидирует через существующий runner; отдельный юнит-тест на
   `getOnCreateBinding` можно добавить, если требуется явная проверка
   `submit_task_key` в возвращаемой строке — покрывается интеграционными
   тестами §1, где binding row конструируется в стабе с этим полем).
3. Гейты (AC-8/AC-9): `npm test`, `npm run build`, `npm run fitness:db`,
   `bash ci/checks/detel-literal-baseline.sh`, `bash
   ci/checks/engine-drive-no-literal-defkey.sh`, `bash
   ci/checks/anti-case-lock.sh`.
4. AC-7 (manual/data): миграция телинейный UPDATE проверяется чтением SQL —
   идемпотентный UPDATE, WHERE-скоуп совпадает с 119 буквально (тот же
   binding id), no-op если seed отсутствует (`CHOROS_SEED_DEMO=off`).

---

*Файл: `docs/adr/ADR-T0604-skip-submit-defkey.md`.*
