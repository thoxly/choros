# T-0604 — Спека: авто-комплит on_create съедает РЕАЛЬНЫЙ шаг согласования (не task-submit)

**Status:** ready
**Phase:** SPEC
**Task:** T-0604 [приёмочный P0 2026-07-03] — целостность согласований
**Date:** 2026-07-03
**База:** dev @ `bd9b1a7` (ветка `task/T-0604-skip-submit-defkey`).
**Предшественники:** T-0368 (E16, авто-комплит «растворение двойной подачи»),
T-0571 (BUG-014, PUT→POST completeUserTask fix), T-0575 (BUG-015/BUG-017,
config-primitive fallback discipline + `process_app_binding.target_registry_slug`
прецедент, миграция 119), T-0443 (`getActiveUserTasks`).

---

## 1. Контекст (L-факты приёмки, проверено в коде и в движке)

**Живой факт приёмки (2026-07-03).** Авто-комплит T-0368 «растворение двойной
подачи» в on_create-пути (`src/http/records.ts`, блок после `startInstance`:
`getFirstActiveUserTask` → `completeUserTask`, `:954-974`) слепо завершает
ПЕРВЫЙ активный `userTask` инстанса, предполагая «это всегда task-submit
(Подача заявки)». Это предположение было БЕЗОПАСНО, пока `completeUserTask`
был no-op (BUG-014, PUT вместо POST — T-0571 §4). После T-0571 починил verb
(PUT→POST), `completeUserTask` стал ЖИВЫМ вызовом движка.

В процессе `purchaseApproval` (тенантский, живёт в данных — НЕ ТЭЛ) первый
`userTask` — «Проверка руководителем» (defKey `task-review`), не подача. Авто-
комплит СЪЕДАЕТ этот реальный шаг согласования за ~35мс без участия человека:

- инстансы `5cf10788` и `1aecce4e` (движковые факты, `act_hi_taskinst`):
  `task-review` start→end за 32-37мс, `assignee` пуст (никто не открывал,
  не мог одобрить/отклонить за 35мс).
- контрольный инстанс `dafc9b66` (ДО фикса T-0571, когда `completeUserTask`
  был no-op) — тот же `task-review` закрыт человеком через 6 минут (реальная
  работа: открыл, посмотрел, нажал).

Т.е. до T-0571 баг был замаскирован ДРУГИМ багом (мертвый auto-complete-вызов);
починка verb-бага (законная, изолированная) РАСКРЫЛА семантическую дыру
T-0368: «первый активный таск = task-submit» — предположение, верное только
для ТЭЛ (`tel-linear.bpmn20.xml`, где первый `userTask` дословно `id="task-submit"`),
и ЛОЖНОЕ для любого тенантского процесса, чей первый шаг после старта —
что угодно иное (проверка, согласование, ревью).

## 2. Разбор существующего кода

- `src/http/records.ts:935-974` (T-0368 doc-comment + реализация): после
  `startInstance`, `flowable.getFirstActiveUserTask(startResult.instanceId)`
  возвращает ТОЛЬКО `{ok, taskId}` (не `taskDefinitionKey`) —
  `src/core/flowable-client.ts:307` (`GetFirstUserTaskResult`). Если `taskId`
  не null — БЕЗУСЛОВНО `completeUserTask(taskId)`. Ни binding, ни BPMN, ни
  вызывающий код НЕ проверяют, что это действительно submit-таск.
- Тот же `records.ts` НИЖЕ (`:986-994`, T-0575 BUG-015) уже вызывает
  `flowable.getActiveUserTasks(startResult.instanceId)` — эта функция
  (`src/core/flowable-client.ts:900-`) возвращает ПОЛНЫЙ список
  `ActiveUserTask[]` С `taskDefinitionKey`/`name`/`candidateGroups` (T-0443,
  расширено идентити-линками в T-0575). Это ТОТ ЖЕ движковый вызов, что нужен
  для defKey-проверки — просто выполняется СЕЙЧАС уже ПОСЛЕ авто-комплита
  (чтобы отразить состояние «после подачи»).
- `src/db/binding-trigger-dao.ts::getOnCreateBinding` (`OnCreateBindingRow`)
  читает `process_app_binding` (миграция 075, колонки расширялись в 082/119)
  — но НЕТ колонки, объявляющей «какой defKey легитимно авто-завершать».
  Прецедент уже есть: миграция 119 добавила `target_registry_slug text NULL`
  с NULL-семантикой «default» + config-primitive fallback
  (`resolveDefaultStepResultSlug`, `src/db/step-applier.ts:93-96`).
- **Критическое отличие от прецедента 119:** для `target_registry_slug` NULL
  означает «используй ИМЕНОВАННЫЙ ДЕФОЛТ» (`"soglasovanie"`) — это безопасно,
  т.к. дефолт лишь указывает КУДА писать результат существующего шага, не
  решает, пропускать ли человека. Для «какой таск авто-завершать» именованный
  литеральный дефолт (например `"task-submit"`) был бы РОВНО ТЕМ ЖЕ ТЭЛ-запахом
  (`engine-drive-no-literal-defkey.sh`, `detel-literal-baseline.sh` — см. §3.2
  ниже), только на один уровень конфигурации глубже: любой тенантский процесс,
  чей submit-таск называется иначе (или которого вовсе нет), либо получил бы
  ложный дефолт-комплит чужого шага, либо тихо не совпал бы с "task-submit" —
  оба исхода не лучше текущего бага. **Безопасный дефолт для АВТО-ЗАВЕРШЕНИЯ
  ЧЕЛОВЕЧЕСКОГО ШАГА — это ОТСУТСТВИЕ авто-завершения**, не второй угаданный
  литерал.

## 3. Функциональные требования

- **F1.** `process_app_binding` получает новую NULLABLE колонку
  `submit_task_key text` (миграция, следующий свободный слот в `migrations/`).
  Семантика:
  - `NULL` (дефолт для ВСЕХ существующих и будущих строк, пока не задано
    явно) → **авто-комплит НЕ включён** для этого binding. Первый активный
    таск инстанса остаётся живым и ждёт человека. Это safe-default: молчаливое
    поведение при отсутствии конфигурации — «ничего не трогать», а не «угадать
    и потенциально съесть чужой шаг».
  - non-NULL строка `<key>` → авто-комплит включён, но **СТРОГО УСЛОВНО**: он
    срабатывает, только если `taskDefinitionKey` первого активного
    `userTask`-а инстанса РАВЕН этому `<key>`. Если первый активный таск имеет
    ЛЮБОЙ другой defKey — авто-комплит НЕ срабатывает (таск остаётся живым),
    и это НЕ ошибка (просто «это не submit-шаг, не трогаем»).
- **F2.** `getOnCreateBinding` (`binding-trigger-dao.ts`) возвращает
  `submit_task_key: string | null` как часть `OnCreateBindingRow`.
- **F3.** `src/http/records.ts` on_create-блок: авто-комплит-решение
  ПЕРЕЕЗЖАЕТ с «есть ли активный userTask» на «есть ли активный userTask
  РОВНО с задекларированным defKey». Технически: вместо раздельных вызовов
  `getFirstActiveUserTask` (только для комплита) + `getActiveUserTasks`
  (только для BUG-015 projection) — ОДИН вызов `getActiveUserTasks` (уже
  существующий чуть ниже), чьё `tasks[0]` используется И для defKey-гейта
  комплита, И для BUG-015 projection (без изменения BUG-015 логики/порядка
  наблюдаемого состояния — просто устраняет вторую отдельную loookup).
  `getFirstActiveUserTask` остаётся в клиенте (не удаляется — другие вызывающие
  либо не существуют, либо это публичный контракт), но on_create-блок больше
  его не использует.
- **F4.** Идемпотентность/resume: если инстанс уже прошёл submit-таск (второй
  POST /api/records на том же instanceId невозможен по конструкции — каждый
  create порождает НОВЫЙ instanceId), либо если движковый вызов упал —
  best-effort деградация СОХРАНЯЕТСЯ (лог + не блокирует уже закоммиченную
  запись), как и было в T-0368/T-0575.
- **F5. Данные для существующих тенантских записей:**
  - `purchaseApproval` binding (создан ЖИВЬЁМ через UI, НЕ в `migrations/`)
    НЕ получает `submit_task_key` этой задачей (это ДАННЫЕ тенанта — не в
    зоне `src/`/`migrations/` кода этой задачи по D-064 §5, закон границы).
    После фикса `submit_task_key IS NULL` для него → авто-комплит НЕ
    срабатывает → «Проверка руководителем» остаётся человеку. Ровно
    желаемое поведение — БЕЗ отдельного изменения данных, просто NULL-default.
  - `telLinear` seed-binding (`085_tel_process_app_binding_seed.sql` +
    `087_tel_binding_on_create_field_mapping.sql`, `trigger_type='on_create'`)
    РЕАЛЬНО имеет submit-таск: `tel-linear.bpmn20.xml:52` —
    `<userTask id="task-submit" .../>`, первый узел после `startEvent`
    (`sf-start-submit`). Это ТЭЛ-фикстура (legacy) — её текущий сценарий
    (двойная подача растворяется) — ЖЕЛАЕМОЕ поведение, воспроизводимое
    T-0368 изначально. Новая миграция ДОПОЛНЯЕТ этот seed-ряд (данные, не код)
    явным `submit_task_key = 'task-submit'`, мирроря паттерн миграции 119
    (`target_registry_slug` UPDATE на тот же seed-ряд). Без этого дополнения
    telLinear РЕГРЕССИРОВАЛ бы (auto-complete перестал бы срабатывать для
    легитимного ТЭЛ-сценария) — ЭТОГО быть не должно (F5 требует сохранить
    существующий ТЭЛ-сценарий).

## 4. Нефункциональные требования

- **N1 (закон границы, D-064 §5 / анти-ТЭЛ гейты).** Ноль литеральных defKey-
  сравнений в `src/`. `submit_task_key` читается ИЗ binding (данные), никогда
  не сравнивается с зашитой строкой типа `"task-submit"` в коде. Должно пройти
  `ci/checks/engine-drive-no-literal-defkey.sh` (запрещает
  `taskDefinitionKey === "task-approve"` и `taskDefKey: "task-approve"` —
  наш код не вводит НИКАКОГО литерального сравнения дефолт-ключа вообще) и
  `ci/checks/detel-literal-baseline.sh` (агрегат `role-approver`/
  `soglasovanie`/`tel-approval` не растёт — наш код не добавляет вхождений
  этих литералов; строка `"task-submit"` в SQL-миграции — ДАННЫЕ, не код
  `src/`, вне периметра этого чека, как и `085`/`119` до нас).
- **N2 (safe default).** Отсутствие конфигурации (`NULL`) означает «не трогай
  человеческий шаг» — НЕ «угадай литеральный дефолт». Это единственный
  безопасный выбор для действия, необратимо продвигающего чужой BPMN-токен.
- **N3 (без новых таблиц/RLS-периметров).** `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` на СУЩЕСТВУЮЩЕЙ tenant-таблице `process_app_binding` (уже в
  `known_tenant_tables.txt`) — ноль новых DDL-объектов, ноль новых policy.
  Мирроит миграцию 119 буквально (`defer-no-new-table.sh` Check-2 не
  применяется — нет CREATE TABLE; `dual-control-isolation.sh` FF-DC7 —
  additive-relief по прецеденту 082/109/115/116/117/119, если сработает).
- **N4 (не удвоить движковый вызов).** F3 переиспользует `getActiveUserTasks`
  вместо добавления НОВОГО метода клиента / нового HTTP round-trip —
  `getFirstActiveUserTask` не расширяется defKey-полем (не нужно: единственный
  вызывающий код это F3 больше не использует для решения о комплите).
- **N5 (регрессия T-0368 остаётся зафиксирована, но переосмыслена).**
  Существующий тест `binding-trigger.unit.test.ts` неявно предполагал
  «getFirstActiveUserTask возвращает null → комплит не вызывается» (стаб
  ВСЕГДА возвращал `taskId: null` — ни один существующий тест не проверял
  «комплит ДЕЙСТВИТЕЛЬНО вызван» путём). Новые тесты ДОБАВЛЯЮТ этот прежде
  непокрытый путь (binding с `submit_task_key`, совпадающий/несовпадающий
  defKey) — старые тесты не удаляются, они остаются валидны (binding без
  `submit_task_key` → auto-complete по-прежнему не вызывается, просто теперь
  по ДРУГОЙ, явной причине).

## 5. Out of scope

- **O1.** Изменение семантики `target_registry_slug` (T-0575/119) — отдельная,
  не связанная конфигурация того же binding-ряда.
- **O2.** UI для редактирования `submit_task_key` (конструктор биндингов) —
  колонка задаётся данными/SQL сейчас; UI-поле — отдельная задача при нужде.
- **O3.** Изменение BPMN-файлов (`tel-linear.bpmn20.xml` и др.) — только
  SQL-данные (seed) и код чтения/гейта.
- **O4.** Расширение `getFirstActiveUserTask` дополнительным полем
  `taskDefinitionKey` — F3 показывает, что это не нужно (переиспользуем
  `getActiveUserTasks`).
- **O5.** Ретроактивная простановка `submit_task_key` для ЛЮБОГО другого
  живого тенантского binding, кроме telLinear (данные тенанта — вне
  `src/`/`migrations/`; если понадобится для `purchaseApproval`, это отдельное
  решение продукта/оператора, не этой задачи — а до тех пор NULL-safe-default
  и есть желаемое поведение согласно живому факту приёмки §1).

## 6. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | Миграция добавляет `process_app_binding.submit_task_key text NULL` (ADD COLUMN IF NOT EXISTS), не трогая существующие строки (все получают NULL). | test |
| AC-2 | `getOnCreateBinding` возвращает `submit_task_key: string \| null` как часть `OnCreateBindingRow`. | test |
| AC-3 | binding БЕЗ `submit_task_key` (NULL) → авто-комплит НЕ вызывается: первый активный таск инстанса остаётся живым (completeUserTask не вызван) — даже если у инстанса ЕСТЬ активный userTask. | test |
| AC-4 | binding С `submit_task_key='X'`, первый активный таск инстанса имеет `taskDefinitionKey==='X'` → авто-комплит ВЫЗЫВАЕТСЯ (completeUserTask вызван с этим taskId). | test |
| AC-5 | binding С `submit_task_key='X'`, первый активный таск инстанса имеет ДРУГОЙ defKey (`!=='X'`) → авто-комплит НЕ вызывается (задача не совпала — не ошибка, таск остаётся живым). | test |
| AC-6 | Регрессия T-0368: существующие тесты `binding-trigger.unit.test.ts`, полагавшиеся на `getFirstActiveUserTask`, приведены к новой семантике (используют `getActiveUserTasks` стаб) БЕЗ удаления покрытия; явно НОВЫЙ тест проверяет положительный путь (AC-4), которого раньше не было ни у одного теста в файле. | test |
| AC-7 | telLinear seed-binding (085/087) дополнен `submit_task_key='task-submit'` (данные, миграция) — существующий ТЭЛ-сценарий (двойная подача растворяется) НЕ регрессирует. | manual |
| AC-8 | Ноль литеральных defKey-сравнений в новом коде `src/`: `bash ci/checks/engine-drive-no-literal-defkey.sh` и `bash ci/checks/detel-literal-baseline.sh` — exit 0, без роста агрегата. | fitness |
| AC-9 | `npm test`, `npm run build`, `npm run fitness:db`, `bash ci/checks/anti-case-lock.sh` — зелёные; счётчики зафиксированы в handoff. | fitness |

## 7. Открытые вопросы

Нет блокирующих. Единственная содержательная развилка (именованный
config-primitive-дефолт вроде `resolveDefaultSubmitTaskKey()` "task-submit" —
по прецеденту 119/BUG-017 — vs. NULL="нет авто-комплита") разрешена в §2/§3
в пользу NULL-safe-default: разница с прецедентом 119 в том, что там дефолт
касается КУДА писать результат УЖЕ решённого человеком шага (безопасно
угадать), а здесь дефолт решал бы, ПРОПУСКАТЬ ЛИ человека — категориально
разные ставки. `status: ready`.

---

*Файл: `docs/specs/T-0604-skip-submit-defkey.spec.md`. Разведка:
`src/http/records.ts` (:935-994 skip-submit блок + BUG-015 getActiveUserTasks),
`src/core/flowable-client.ts` (:307 GetFirstUserTaskResult, :900- getActiveUserTasks),
`src/db/binding-trigger-dao.ts` (OnCreateBindingRow), `migrations/075/082/085/087/119`
(process_app_binding эволюция + telLinear seed + BUG-017 NULL-default прецедент),
`config/flowable/processes/tel-linear.bpmn20.xml` (:52 task-submit — реальный
первый userTask ТЭЛ), `ci/checks/engine-drive-no-literal-defkey.sh` +
`ci/checks/detel-literal-baseline.sh` (анти-ТЭЛ гейты).*
