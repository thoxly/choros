# T-0606 — Спека: guard над реестром согласований (два бага — фантомные процессы + фантомные/удаляемые акты)

**Status:** ready
**Phase:** SPEC
**Task:** T-0606 [approval-registry-guard]
**Date:** 2026-07-03
**База:** dev @ `da28079` (ветка `task/T-0606-approval-registry-guard`, содержит T-0603 embedded-rollup + T-0604 submit_task_key/миграция 121).
**Предшественники:** T-0335 (E15-S1b, step-applier «Согласование»-registry), T-0575 (BUG-017, `target_registry_slug`, миграция 119), T-0604 (`submit_task_key`, миграция 121), T-0351 (E16, on_create).

---

## 1. Контекст (два независимых живых бага, обе точки — `choros.process_app_binding` + `choros.registry_def`)

### Bug #2 — фантомные запуски процесса

`getOnCreateBinding` (`src/db/binding-trigger-dao.ts`) до этой задачи matчил
on_create-биндинг ТОЛЬКО по `(tenant_id, application_id, trigger_type='on_create')`.
Его вызывающий, `createRecord` (`src/http/records.ts` ~813), передаёт
`reg.application_id` — application_id реестра, в который пишет ВЫЗЫВАЮЩИЙ.
Любой `registry_def` того же приложения — включая «Согласование»
(step-result-проекцию, посеянную migration 076 РЯДОМ с primary «Заявки») —
поэтому запускает ОДИН И ТОТ ЖЕ биндинг. Ручное создание записи в
«Согласование» порождает НОВЫЙ инстанс telLinear — это никогда не было
намерением: биндинг должен срабатывать ТОЛЬКО когда запись создаётся в
PRIMARY (бизнес-данные) реестре приложения.

### Bug #1 — фантомные/удаляемые акты согласования

Реестры-проекции решений (реестр, в который `step-applier.ts`'s
`applyStepResult` пишет акты согласования — migration 076 «Согласование»)
принимают ОБЫЧНЫЙ CRUD create/update/delete через POST/PUT/DELETE
`/api/records` наравне с любым пользовательским реестром. Пользователь может
вручную сфабриковать или удалить «акт согласования», который никогда не был
реальным исходом шага BPMN.

## 2. Разбор существующего кода

- `src/db/binding-trigger-dao.ts::getOnCreateBinding` — SQL:
  `WHERE tenant_id = $1 AND application_id = $2 AND trigger_type = 'on_create'`
  — НЕТ фильтра по конкретному `registry_def`.
- `src/http/records.ts::createRecord` (~813): `getOnCreateBinding(client,
  tenantId, reg.application_id)` — `reg` уже разрешён (governing registry_def
  вызывающего create), но его `id`/`slug` НЕ передаются в лукап биндинга.
- **Инвестигация `target_registry_slug` (migration 119) — ПОДТВЕРЖДЕНО НЕ
  РЕИСПОЛЬЗУЕТСЯ:** эта колонка — ИСКЛЮЧИТЕЛЬНО таргет ЗАПИСИ РЕЗУЛЬТАТА шага
  (`step-applier.ts::applyStepResult` резолвит её через
  `resolveDefaultStepResultSlug()`-фоллбек, когда NULL) — решает, В КАКОЙ
  реестр писать акт УЖЕ ЗАВЕРШЁННОГО шага (outbound, после решения). Это
  ПОЛНОСТЬЮ ОТДЕЛЬНАЯ забота от «какой реестр создание-события запускает
  СТАРТ процесса» (inbound, до решения). Сидовые данные migration 119
  (`UPDATE ... SET target_registry_slug = 'soglasovanie' WHERE
  process_key='telLinear'`) настраивают КУДА писать РЕЗУЛЬТАТ шага telLinear
  — это НЕ имеет отношения к тому, какой реестр запускает telLinear на
  create. Реиспользование одной колонки для двух конфликтующих NULL-семантик
  было бы категориальной ошибкой — новая, отдельная колонка обязательна.
- `registry_def` (migration 004) уже несёт `is_system boolean NOT NULL
  DEFAULT false` — точка расширения для «этот реестр движковый».
- `process-instance-resolver.ts`'s Step 3 (`resolveInstanceTargetReads`) уже
  вычисляет «PRIMARY registry» как первый `is_system = false` реестр
  application-а по `created_at ASC` — существующий примитив «примари
  реестр», который эта задача переиспользует один-в-один для NULL-фоллбека
  нового `trigger_registry_id` (а не изобретает новое определение).

## 3. Функциональные требования

- **F1 (Part A).** `process_app_binding` получает новую NULLABLE колонку
  `trigger_registry_id uuid` (миграция 122, additive). NULL (дефолт для всех
  существующих строк) → биндинг срабатывает на create в PRIMARY реестре
  приложения (первый `is_system=false` по `created_at ASC` — та же формула,
  что уже использует `process-instance-resolver.ts`). Non-NULL → биндинг
  срабатывает ТОЛЬКО для ЭТОГО конкретного `registry_def.id`, игнорируя
  PRIMARY-фоллбек.
- **F2.** `getOnCreateBinding` принимает `registryId` (доп. параметр) и
  фильтрует по нему в SQL (сравнение, не JS-постфильтр — фильтрация должна
  происходить в самом запросе, поддерживая единственность/детерминизм строки).
  JSDoc обновлён (старый комментарий «binding is on the APPLICATION, not the
  individual registry_def» становится НЕВЕРНЫМ — заменён описанием новой
  per-registry области видимости + NULL-фоллбека).
- **F3.** Вызывающий код в `src/http/records.ts` (~813) передаёт `reg.id`
  как `registryId`.
- **F4 (Part B).** `registry_def` получает новую колонку `engine_managed
  boolean NOT NULL DEFAULT false` (миграция 122, additive; зеркалит форму
  `is_system`, migration 004). `true` помечает реестр как движковый /
  write-protected.
- **F5.** `createRecord`/`updateRecord`/`deleteRecord` в `src/http/records.ts`
  проверяют `engine_managed` реестра ПЕРЕД любой мутацией; если `true` —
  403 с кодом `REGISTRY_ENGINE_MANAGED` и честным сообщением («Записи этого
  раздела создаёт процесс — согласуйте через задачу в Моих задачах»),
  следуя конверту `{error:{code,message}}`.
- **F6.** `step-applier.ts::applyStepResult` НЕ затронут этой задачей: его
  прямой `INSERT INTO choros.record` внутри `applyStepResult` — ОТДЕЛЬНЫЙ
  DAO-путь, который НЕ вызывает ни одну функцию `src/http/records.ts` и
  никогда не проверяет `engine_managed`. Гейт F5 живёт ИСКЛЮЧИТЕЛЬНО внутри
  HTTP-хендлеров records.ts — не в общей DAO, которую использует и
  step-applier.
- **F7 (данные).** Миграция 122 идемпотентным `UPDATE` помечает существующую
  ТЭЛ «Согласование» строку (migration 076, id `a7000000-…-0003`)
  `engine_managed = true`. `trigger_registry_id` для существующего
  telLinear-биндинга (085) НЕ меняется (остаётся NULL) — NULL уже корректно
  резолвится в «Заявки» (единственный `is_system=false` реестр под
  tel-approval после migration 086's flip).

## 4. Нефункциональные требования

- **N1 (закон границы, D-064 §5).** Ноль слаг-литералов `soglasovanie`/
  `tel-approval` в НОВОМ коде `src/`. Механизм — колоночный/data-driven
  (`engine_managed`, `trigger_registry_id`), не завязан ни на один слаг.
  Литерал `'soglasovanie'`-registry id встречается ТОЛЬКО в SQL
  data-completion UPDATE миграции 122 (тот же прецедентный класс, что 119
  `WHERE process_key = 'telLinear'` / 121 `submit_task_key = 'task-submit'`)
  — вне периметра `detel-literal-baseline.sh` (сканирует только `src/`).
  Агрегат anti-case-baseline (`soglasovanie: 2`) не растёт — эта задача не
  добавляет НИ ОДНОГО нового кодового упоминания слага.
- **N2 (safe NULL-фоллбек, Part A).** NULL `trigger_registry_id` резолвится
  в PRIMARY реестр — используя УЖЕ СУЩЕСТВУЮЩЕЕ определение примари
  (`process-instance-resolver.ts`), а не изобретая новое. Это гарантирует:
  движковый (`engine_managed`) реестр НИКОГДА не может быть PRIMARY (в
  сидовых данных `engine_managed` всегда сопутствует `is_system=true`,
  который сам по себе исключён из фоллбека), так что фоллбек структурно не
  может выбрать write-protected реестр как триггер-источник.
- **N3 (без новых таблиц/RLS-периметров).** `ALTER TABLE ... ADD COLUMN IF
  NOT EXISTS` на ДВУХ существующих tenant-таблицах
  (`process_app_binding`, `registry_def`) — ноль DDL сверх этого, ноль
  новых policy. Мирроит форму 004/075/119/121.
- **N4 (изоляция step-applier, Part B).** Гейт `engine_managed` реализован
  строго внутри `src/http/records.ts`'s create/update/delete — НЕ в
  какой-либо общей DAO-функции, которую вызывает `step-applier.ts`. Явный
  тест проверяет: `applyStepResult` продолжает писать в `engine_managed`
  реестр без изменений (и структурно НЕ МОЖЕТ быть заблокирован — его
  собственный SQL-запрос `resolveApprovalsRegistry` никогда не выбирает
  колонку `engine_managed`).
- **N5 (честное сообщение).** 403-текст на русском, без жаргона, в тоне
  существующих сообщений (`FIELD_WRITE_FORBIDDEN` — прецедент того же файла).

## 5. Out of scope

- **O1.** UI для редактирования `trigger_registry_id`/`engine_managed`
  (конструктор биндингов/реестров) — колонки задаются данными/SQL сейчас.
- **O2.** Ретроактивная маркировка ЛЮБОГО другого реестра (кроме ТЭЛ
  «Согласование») как `engine_managed` — данные тенанта вне периметра этой
  задачи; если понадобится для другого тенантского процесса, это решение
  оператора/продукта, не этой задачи.
- **O3.** Изменение семантики `target_registry_slug` (T-0575/119) или
  `submit_task_key` (T-0604/121) — независимые конфигурации того же
  binding-ряда (за исключением Part C — см. §6 AC-P).
- **O4.** GET-чтение `engine_managed`-реестров — эта задача НЕ вводит
  read-side ограничений; write-protection касается только create/update/
  delete через `/api/records`.

## 6. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | Миграция 122 добавляет `process_app_binding.trigger_registry_id uuid NULL` и `registry_def.engine_managed boolean NOT NULL DEFAULT false` (оба ADD COLUMN IF NOT EXISTS), не трогая существующие строки семантически (все существующие получают NULL/false). | test |
| AC-2 | `getOnCreateBinding` принимает `registryId` и возвращает биндинг ТОЛЬКО когда `trigger_registry_id` совпадает с ним ИЛИ (`trigger_registry_id IS NULL` И `registryId` == PRIMARY реестр приложения). | test |
| AC-3 | Create в НЕ-primary реестре того же приложения → процесс НЕ стартует (bug #2 исправлен). | test |
| AC-4 | Create в primary/единственном реестре приложения → процесс СТАРТУЕТ (регрессия ТЭЛ/purchaseApproval не сломана). | test |
| AC-5 | Create/update/delete через HTTP-роут против `engine_managed=true` реестра → 403 `REGISTRY_ENGINE_MANAGED` с честным русским сообщением; строка не изменена/не создана/не удалена. | test |
| AC-6 | `applyStepResult` (прямой DAO-путь step-applier.ts) продолжает успешно писать в `engine_managed=true` реестр — доказано и структурно (его SQL никогда не селектит `engine_managed`), и через живой Postgres-тест. | test |
| AC-7 | Миграция 122 идемпотентным data-UPDATE помечает существующую ТЭЛ «Согласование» строку `engine_managed=true`; `trigger_registry_id` существующего telLinear-биндинга остаётся NULL и по-прежнему резолвится в «Заявки» (verified against seed 076/086). | manual |
| AC-8 | Ноль новых слаг-литералов в `src/`: `bash ci/checks/detel-literal-baseline.sh` — exit 0, агрегат `soglasovanie` не растёт (baseline 2 не увеличен этой задачей). | fitness |
| AC-9 | `npm test`, `npm run build`, `npm run fitness:db`, `bash ci/checks/dual-control-isolation.sh`, `bash ci/checks/anti-case-lock.sh` — зелёные; счётчики зафиксированы в handoff. | fitness |
| AC-10 (T-0604 reviewer AC-3b, Part C) | `submit_task_key = NULL` + первый живой активный user-task с `taskDefinitionKey='task-submit'` (совпадающий с гипотетическим фоллбек-литералом) → auto-complete НЕ срабатывает (пин инварианта "NULL = выключено, без фоллбек-угадывания"). | test |

## 7. Открытые вопросы

Нет блокирующих. Единственная содержательная развилка (колонка vs jsonb-
convention для `engine_managed`) разрешена в ADR §3 в пользу колонки —
консистентно с существующим прецедентом `is_system`. `status: ready`.

---

*Файл: `docs/specs/T-0606-approval-registry-guard.spec.md`. Разведка:
`src/http/records.ts` (createRecord/updateRecord/deleteRecord, ~732-1436),
`src/db/binding-trigger-dao.ts` (getOnCreateBinding), `src/db/step-applier.ts`
(applyStepResult, resolveApprovalsRegistry), `src/db/process-instance-resolver.ts`
(Step 3 primary-registry формула), `migrations/004/075/076/086/119/121`
(registry_def/process_app_binding эволюция + ТЭЛ seed).*
