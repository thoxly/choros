# T-0575 · Вынос ТЭЛ-хардкодов из несущих путей (деТЭЛизация)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-07-02
**Task:** T-0575 [W1/деТЭЛ] — «Вынести ТЭЛ-хардкоды из несущих путей: роль из candidateGroups + настраиваемый fallback (BUG-015), целевой набор результата шага из binding (BUG-017), метки задач из BPMN, computed→переменные процесса (BUG-016)»
**Предшественник:** T-0571 (done, dev@080486c) — снял литерал `taskDefKey="task-approve"` с пути МАТЧИНГА завершения (resolve-by-instance). НЕ трогал роль/метки/target-набор/computed — эти 4 явно вынесены в out_of_scope T-0571 (§O1-O3) как принадлежащие T-0575.
**Преемник:** T-0576 — анти-кейс CI-гейт (грep-список запрещённых строк в `src/`). Этот таск ОБЯЗАН уменьшить baseline; §6 ниже перечисляет точный список строк, которым надлежит исчезнуть.
**Источник:** карта примитивов `demiurge/docs/choros-primitives-map-2026-07-02.md` §5 «ТЭЛ-осадок в ядре», §7 п.4 (решение фаундера: одобрить вынос 4 несущих хардкодов).

---

## 1. Проблема (L/C-факт, не гипотеза)

Разведка кода на актуальной базе dev@080486c (после T-0571) подтверждает: все 4 хардкода карты примитивов §5 живы, ни один не задет T-0571. Три независимых наблюдения демонстрируют их эффект на живом стенде:

- **BUG-015 (роль+метки):** для generic-процесса на живом стенде каждая БАЗОВАЯ (стартовая) задача проекции сегодня жёстко подписана `role: "role-approver"`, `step: "Согласование"`, `name: "Согласовать заявку"` — независимо от того, что реально написано в BPMN-модели автора процесса и кому реально адресован user-task по `candidateGroups`. Только НЕбазовые (post-gateway/escalation) задачи уже частично читают `candidateGroups[0]`/`name` из движка, используя эти же константы лишь как fallback (`process-projection.ts:1072,1440`) — то есть примитив «роль из candidateGroups» ЧАСТИЧНО существует, но не на стартовом (самом частом) пути.
- **BUG-017 (target-набор):** `step-applier.ts` пишет результат шага ТОЛЬКО в реестр с буквальным slug `"soglasovanie"`, резолвя его отдельно от основного (`resolveInstanceTargetOnClient`) target. Для приложения без реестра с этим именем `applyStepResult` кидает `Error` (правильно fail-closed по формулировке — см. §2 ниже), но сам факт требования буквального slug — хардкод, не примитив.
- **BUG-016 (computed→переменные):** LIVE_PROOF T-0571 (2026-07-02, сегодня) зафиксировал живой факт — заявка на 600000 (сумма — computed rollup-поле) ушла ДЕФОЛТНОЙ веткой шлюза вместо ветки согласования (`${amount>500000}` не увидел сумму). Корень найден в коде: `projectEngineVariables` (`records.ts:654-682`) проецирует переменные процесса ТОЛЬКО из `record.data` по `field_mapping`; `rollup`-поля по доктрине PD-20 (`derived-fields-dao.ts:1-9`) НЕ хранятся в `record.data` — они вычисляются отдельно, на READ, функцией `computeAllDerivedFields`, которую `createRecord`/on_create-путь никогда не вызывает перед стартом процесса. Итог: любое computed-поле, участвующее в шлюзовом условии, при старте через on_create всегда видно движку как `undefined`/отсутствующее.

Все три — это не потенциальный риск, а воспроизводимое поведение сегодняшнего кода на нейтральном (не-ТЭЛ) процессе.

## 2. Диагностическая разведка (актуальные места на dev@080486c)

Все номера строк ниже — АКТУАЛЬНЫЕ на HEAD этого worktree (080486c); карта примитивов ссылалась на более раннюю базу, часть строк сдвинулась после T-0571.

### 2.1 BUG-015 — роль + метки задачи (`src/http/process-projection.ts`)

```
226: export const APPROVER_ROLE = "role-approver";
228: export const APPROVE_STEP = "Согласование";
230: export const APPROVE_TASK_NAME = "Согласовать заявку";
```

- `appendProcessStarted` (строки 253-313) принимает `approverRole?`, `step?`, `taskName?` как ОПЦИОНАЛЬНЫЕ параметры, дефолтящиеся на константы (строки 284-286) — сама функция уже параметризуема.
- НО оба вызывающих места опускают эти параметры целиком:
  - `src/http/process-start.ts:386-394` — явный старт процесса.
  - `src/http/records.ts:881-891` — on_create-старт (create=start).
  - В ОБОИХ случаях движковый клиент (`flowable`) уже доступен в той же функции ДО вызова `appendProcessStarted` (`process-start.ts:404` вызывает `flowable.getActiveUserTasks(result.instanceId)` для ДРУГОЙ цели — task-submit auto-complete), то есть `candidateGroups`/`name` первого активного user-task ДОСТИЖИМЫ в момент вызова, просто не прокинуты.
- Дефолт-константы также используются как read-fallback в проекции чтения (`listInstanceProjections` строка 795-796, `listInstanceInboxTasks` строки 780, 868-870) — это ЧЕСТНЫЙ fallback-паттерн (для строк без `task_role`/`task_step` в payload, включая pre-миграционные записи), НЕ являющийся сам по себе багом — но он же остаётся единственным источником для базовой задачи, потому что payload туда пишется с константой (см. выше).
- Частичный примитив уже в коде (для сравнения, куда переносить недостающее): строки 1072 (`engineTask.candidateGroups[0] ?? APPROVER_ROLE`), 1440 (`nextTask.candidateGroups[0] ?? APPROVER_ROLE`), 1074/1448 (`engineTask.name || APPROVE_TASK_NAME` / `nextTask.name || APPROVE_TASK_NAME`).
- Агентский контур: `src/runtime/agent-dispatch/dispatch-outcome.ts:274` — `role: ctx.roleId !== "" ? ctx.roleId : "role-approver"` — тот же ТЭЛ-литерал как fallback при пустом `ctx.roleId` в defer-to-human ветке.

### 2.2 BUG-017 — target-набор результата шага (`src/db/step-applier.ts`, `src/http/form-record-persister.ts`)

```
step-applier.ts:78:   export const SOGLASOVANIE_SLUG = "soglasovanie" as const;
step-applier.ts:204:  [tenantId, applicationId, SOGLASOVANIE_SLUG]   (loadFormBindingForValidation, schema-drift, non-fatal)
step-applier.ts:408:  [tenantId, appRow.application_id, SOGLASOVANIE_SLUG]  (то же, non-fatal try/catch)
step-applier.ts:571-580: resolveApprovalsRegistry(...) → ищет registry_def по SOGLASOVANIE_SLUG под application_id →
                          если не находит: throw Error (fail-closed, FF-G3) — БЕЗ структурированного
                          кода ошибки, которую approve-хендлер мог бы превратить в человекочитаемый 4xx;
                          сегодня это голый Error, пойманный где-то выше как общий 500.
```

- `resolveApprovalsRegistry` (строки 192-209) — единственное место, где slug реально используется как SQL-параметр (не просто комментарий): `WHERE ... AND slug = $3` с `$3 = SOGLASOVANIE_SLUG`.
- `process_app_binding` (миграция 075) — таблица, которая УЖЕ связывает `(process_key, application_id, form_key?)`, но НЕ содержит поля, куда записать «в какой реестр писать результат шага» — того самого «целевого набора из binding», который требует задача. Сегодня этот набор не конфигурируем НИ через какую таблицу — он захардкожен в константу.
- `form-record-persister.ts:100-106`:
  ```
  const FORM_TO_REGISTRY_SLUG = { purchase: "purchases", approval: "soglasovanie" };
  const TEL_APPLICATION_SLUG = "tel-approval" as const;
  ```
  Тот же паттерн для ФОРМ (не для step-applier результата): маппинг formId→registry-slug и slug хозяйского приложения — оба буквальные ТЭЛ-строки, используются как SQL-параметры на строках 201, 363 (`WHERE ... slug = $2` с `$2 = TEL_APPLICATION_SLUG`).
- Важно (не разрушить намеренный fail-closed): `applyStepResult` УЖЕ реализует правильную СЕМАНТИКУ (нет target + маркер обязателен → throw, ROLLBACK) — проблема НЕ в том, что она fail-closed, а в том, что «правильный набор» задан константой вместо конфигурации per-binding, и throw сегодня — обычный `Error` без структурированного кода/сообщения, различимого HTTP-слоем (симптом «500 без лога», упомянутый в задаче).

### 2.3 BUG-016 — computed (rollup) не попадает в переменные процесса

```
records.ts:654-682   projectEngineVariables(data, fieldMapping) — читает ТОЛЬКО record.data (raw scalars),
                      derived (rollup) поля НЕ в data по определению доктрины.
records.ts:769       let variables = projectEngineVariables(data, binding.field_mapping);  ← BUG-016 здесь:
                      `data` — это то, что только что вставлено в record.data (сырые поля формы),
                      rollup-значение сюда не попадает НИКОГДА, поскольку доктрина PD-20 хранит его
                      отдельно и вычисляет по требованию.
derived-fields-dao.ts:1-9  доктрина: "Derived values are NEVER stored in record.data; they are
                      appended to the GET /api/records/:id response as a `derived` map by the
                      HTTP handler" — то есть намеренная архитектура, но её следствие для on_create
                      старта процесса не было замкнуто.
derived-fields-dao.ts:238  export async function computeAllDerivedFields(client, tenantId,
                      parentRecordId, recordData, derivedSpecs) — уже существующая, переиспользуемая
                      функция batch-вычисления всех rollup/matrix-lookup полей одного реестра;
                      сегодня вызывается ТОЛЬКО из GET-обработчика чтения записи (records.ts,
                      import на строке 99), НИ РАЗУ — из пути создания записи / on_create-старта.
rollup-contract.ts:353 extractDerivedFields(schema) — извлекает derivedSpecs из record_schema
                      (уже есть, переиспользуемо для получения списка rollup-полей реестра).
```

Наблюдение: сама вычислительная машинерия (`computeAllDerivedFields` + `extractDerivedFields`) уже существует и уже проверена (используется на read-пути) — разрыв ТОЛЬКО в том, что on_create/`createRecord`-путь (`records.ts` ~754-834) не вызывает её ПЕРЕД проекцией переменных для движка.

## 3. Требуемые примитивы (карта §5, дословно)

1. **«Роль исполнителя из candidateGroups + настраиваемый fallback»** — базовая (стартовая) задача проекции обязана пытаться прочитать реальную роль первого активного user-task движка (`candidateGroups[0]`) в момент старта инстанса (движковый клиент уже доступен в обоих call site — §2.1); константа `APPROVER_ROLE` остаётся ТОЛЬКО как fallback для случая, когда движок недоступен/не сконфигурирован ИЛИ у задачи нет `candidateGroups` вовсе — и этот fallback обязан быть настраиваемым (не зашитым в код заново другой строкой), например через переменную окружения/конфиг с дефолтом на сегодняшнюю константу ради обратной совместимости.
2. **«Метки задачи из BPMN user-task name»** — та же логика для `step`/`taskName`: базовая задача обязана нести реальное имя узла BPMN (`engineTask.name`), а не литерал `"Согласование"`/`"Согласовать заявку"`, когда движок доступен и имя присутствует.
3. **«Целевой набор результата шага из binding»** — `step-applier.ts` обязан резолвить реестр для записи результата шага ИЗ КОНФИГУРАЦИИ (естественный кандидат — расширение `process_app_binding`, миграция 075, добавлением поля вроде «результат-шага-реестр»/эквивалента, ЛИБО из `form_binding` — решение способа за BUILD), а не из константы `SOGLASOVANIE_SLUG`. Отсутствие настроенного набора при обязательном шаге (marker present) обязано остаться fail-closed, но с человекочитаемым сообщением/кодом ошибки (не голый necaught `Error`, симптом BUG-017 «500 без лога»).
4. **«Computed→переменные процесса»** — путь старта процесса (явный `process-start.ts` и on_create `records.ts`) обязан вычислить derived (rollup/matrix-lookup) поля реестра ДО построения переменных для движка и включить их в набор, доступный `field_mapping`/`projectEngineVariables`, так чтобы `field_mapping`, ссылающийся на rollup-поле по его ключу, реально получал вычисленное значение, а не `undefined`.

## 4. Совместимость (frozen ТЭЛ-путь)

ТЭЛ перестаёт быть кодом и становится ДАННЫМИ (seed/конфиг), не переставая работать:

- ТЭЛ-процесс (`tel-linear.bpmn20.xml`) продолжает иметь BPMN user-task с `candidateGroups="role-approver"` и именем узла, которое СОВПАДАЕТ с сегодняшним `"Согласование"`/`"Согласовать заявку"` (как оно и названо в BPMN сегодня, если проверка покажет расхождение — это диагностическая находка, не решение) → примитив 1/2, читая РЕАЛЬНЫЙ `candidateGroups`/`name` из движка, для ТЭЛ-процесса выдаёт РОВНО ТЕ ЖЕ значения, что и сегодняшняя константа. Frozen ТЭЛ-джорнеи (T-0571 AC-6..AC-8 и смежные) обязаны остаться зелёными без правки самих тестов.
- Реестр `soglasovanie` (миграция 076) и `process_app_binding` seed-строка для ТЭЛ (миграция 085) обязаны нести конфигурацию, которая для ТЭЛ РЕЗОЛВИТСЯ в тот же самый `soglasovanie`-реестр, что и сегодня — константа `SOGLASOVANIE_SLUG` может остаться как ДЕФОЛТ/seed-значение данных миграции, но не как единственный код-путь резолюции.
- Форма-персистер (`form-record-persister.ts`) продолжает резолвить `tel-approval`/`purchases`/`soglasovanie` для ТЭЛ через ту же таблицу-конфигурацию — маппинг остаётся данными миграции 076, а не единственно возможной строкой в `FORM_TO_REGISTRY_SLUG`.

## 5. LIVE_PROOF-путь (D-064) — как это доказывается на живом стенде

Обязательное доказательство — глазами через UI на живом стенде (100.121.76.86:3000 или эквивалентном), НЕ через unit-тест в изоляции:

1. Взять НЕ-ТЭЛ процесс — «Закупки»/acceptance-demo (приёмка 2026-07-01/02) либо новый мини-процесс, залитый XML через API, с BPMN user-task, чьи `candidateGroups` И имя узла ОТЛИЧАЮТСЯ от `"role-approver"`/`"Согласование"`.
2. Приложение этого процесса имеет reistry-поле с `x-rollup` (computed-суммой), участвующей в шлюзовом условии (аналог `${amount>500000}`).
3. Создать запись со значениями дочерних записей такими, что rollup-сумма превышает порог шлюза → создание должно СТАРТОВАТЬ процесс (on_create).
4. Наблюдать глазами: (а) задача в инбоксе адресована РОЛИ из СВОЕГО BPMN candidateGroups (не `role-approver`, если BPMN этого процесса её не использует); (б) метка/имя задачи в инбоксе — имя СВОЕГО BPMN user-task (не «Согласовать заявку»); (в) шлюз увёл инстанс по ВЕТКЕ СОГЛАСОВАНИЯ (сумма реально была видна условию), а не дефолтной веткой — прямая инверсия сегодняшнего наблюдения LIVE_PROOF T-0571 (600000 ушли дефолтной).
5. Параллельно (для доказательства): подтвердить, что результат шага (approve) записался в реестр, СВЯЗАННЫЙ с этим приложением через binding-конфигурацию (не обязательно называющийся `soglasovanie`) — не 500, не тихий no-op.
6. Анти-кейс: повторить на ВТОРОМ non-TEL процессе с иными именами узлов/ролей — то же поведение без правки продукта между прогонами.
7. Регрессия: ТЭЛ-джорнея (линейный ТЭЛ-процесс) на том же стенде продолжает вести себя как сегодня (роль `role-approver`, метки «Согласование»/«Согласовать заявку», запись в `soglasovanie`) — теперь потому что так сконфигурированы ДАННЫЕ ТЭЛ-сида, не потому что так зашит код.

## 6. Точный список строк, которые обязаны исчезнуть из `src/` (вход для T-0576 baseline)

Следующие строковые литералы/константы (за пределами seed-миграций и test-фикстур, которые остаются данными) сегодня существуют в `src/` и ОБЯЗАНЫ уйти из production-путей проекции/резолюции/персиста как жёстко закодированные значения (их МЕСТО — конфигурация/данные, не код):

| Файл | Строка (сегодня, dev@080486c) | Литерал |
|---|---|---|
| `src/http/process-projection.ts:226` | `export const APPROVER_ROLE = "role-approver";` | `"role-approver"` как ЕДИНСТВЕННОЕ значение (может остаться как ИМЯ дефолт-константы для fallback, но код обязан сначала пытаться прочитать candidateGroups) |
| `src/http/process-projection.ts:228` | `export const APPROVE_STEP = "Согласование";` | `"Согласование"` как безусловный дефолт базовой задачи |
| `src/http/process-projection.ts:230` | `export const APPROVE_TASK_NAME = "Согласовать заявку";` | `"Согласовать заявку"` как безусловный дефолт базовой задачи |
| `src/http/process-projection.ts:284-286` | `appendProcessStarted` дефолтит `role`/`step`/`taskName` без попытки прочитать движок | сам паттерн «дефолт без попытки resolve» |
| `src/http/process-start.ts:386-394` | вызов `appendProcessStarted` БЕЗ `approverRole`/`step`/`taskName` | отсутствие прокидывания резолвленных из движка значений |
| `src/http/records.ts:881-891` | вызов `appendProcessStarted` БЕЗ `approverRole`/`step`/`taskName` (on_create путь) | то же |
| `src/runtime/agent-dispatch/dispatch-outcome.ts:274` | `ctx.roleId !== "" ? ctx.roleId : "role-approver"` | `"role-approver"` как fallback-литерал (обязан стать настраиваемым, не второй копией строки) |
| `src/db/step-applier.ts:78` | `export const SOGLASOVANIE_SLUG = "soglasovanie" as const;` | `"soglasovanie"` как ЕДИНСТВЕННЫЙ код-путь резолюции target-набора |
| `src/db/step-applier.ts:571-580` (`resolveApprovalsRegistry`) | `WHERE ... AND slug = $3` с `SOGLASOVANIE_SLUG` | резолюция по литералу вместо по binding-конфигурации |
| `src/http/form-record-persister.ts:100-103` | `FORM_TO_REGISTRY_SLUG = { purchase: "purchases", approval: "soglasovanie" }` | оба значения-литерала как единственный маппинг (ТЭЛ обязан остаться ДАННЫМИ, не единственно возможным кодом) |
| `src/http/form-record-persister.ts:106` | `const TEL_APPLICATION_SLUG = "tel-approval" as const;` | `"tel-approval"` как единственный код-путь резолюции хозяйского приложения формы |

Строки в `process-projection.ts` на позициях 780, 795-796, 868-870, 1072, 1074, 1440, 1448, 1450, 1756-1758, 1824, использующие `APPROVER_ROLE`/`APPROVE_STEP`/`APPROVE_TASK_NAME` КАК ИМЕНА fallback-констант (`?? APPROVER_ROLE`, `|| APPROVE_TASK_NAME`) — это ЧЕСТНЫЙ read-fallback паттерн для строк без `task_role`/`task_step` в payload; они МОГУТ остаться, если сами константы становятся настраиваемым конфигом (переименовать/сделать значение читаемым из окружения/конфига с тем же именем-символом) — что именно останется/уйдёт из T-0576 baseline, зависит от способа реализации (BUILD), но КОЛИЧЕСТВО мест, где строка **`"role-approver"` возникает как единственно возможное ЗНАЧЕНИЕ** (а не имя переменной), обязано уменьшиться минимум с текущих значений (role-approver: 1 определение + 1 dispatch-fallback; soglasovanie: 1 определение + FORM_TO_REGISTRY_SLUG + 2 non-fatal SQL-параметра + resolveApprovalsRegistry; tel-approval: 1 определение + 2 SQL-параметра) до конфигурации.

**Не входит в baseline-уменьшение (остаётся как ДАННЫЕ, легитимно):** миграции `076_soglasovanie_registry_seed.sql`, `077_tel_roles_seed.sql`, `084_tel_approver_assignment_seed.sql`, `085_tel_process_app_binding_seed.sql`, `086_tel_purchases_user_registry.sql`, `087_tel_binding_on_create_field_mapping.sql`, `089_tel_cross_app_ref_seed.sql`, `config/flowable/processes/tel-linear.bpmn20.xml`, `migrations/080_tel_dmn_seed.sql` (порог 5000000 и outcomes — бизнес-константа сида, вне скоупа этой задачи по явному указанию карты §5 «Параметризовать» отдельно от «Уже изолировано»).

## 7. Fail-honest (BUG-017 симптом)

Отсутствие сконфигурированного target-набора (binding) для шага, который его требует (marker present), ОБЯЗАНО приводить к:
- ошибке, различимой HTTP-слоем как отдельный код/статус (не общий 500 без указания причины),
- человекочитаемому сообщению, называющему ЧТО отсутствует (например: «для процесса X не сконфигурирован реестр результата шага — свяжите через [механизм]»),
- логу на сервере с достаточным контекстом для диагностики (tenantId, applicationId/processKey, отсутствующий параметр) — НЕ тихому проглатыванию.

Это НЕ смягчение сегодняшнего fail-closed (`applyStepResult` throw остаётся) — это требование к КАЧЕСТВУ сообщения об ошибке.

## 8. Out of scope

- **O1.** Полная деТЭЛизация ВСЕХ хардкодов карты примитивов §5 сверх этих четырёх: порог `5000000` и DMN outcomes в `migrations/080_tel_dmn_seed.sql` (бизнес-константа сида — карта §5 явно называет её «параметризовать» отдельно), персоны `e-larina`/`e-orlov` в `inbox.ts:221-236` (уже изолированы как no-DB фикстура), `TEL_GATEWAY_VAR`/`TEL_GATEWAY_ID` (уже `@deprecated`, карта §5 «Мёртвое») — не предмет этой задачи.
- **O2.** Сам механизм T-0571 (approve→Flowable resolve-by-instance матчинг) — done, не пересматривается.
- **O3.** Построение постоянно действующего анти-кейс CI-гейта (грep-список запрещённых строк как инфраструктура) — это T-0576, не эта задача. Эта задача обязана лишь УМЕНЬШИТЬ baseline (§6), не строить сам гейт.
- **O4.** Дизайн конкретной схемы расширения `process_app_binding` (имя нового столбца, тип, миграция №) — это решение BUILD/DESIGN, аналитик не проектирует. Спека фиксирует ТРЕБОВАНИЕ («целевой набор из binding», §3 п.3), не конкретную DDL.
- **O5.** B-branch (`stepClass === "B"`, инлайн-обновление 1:1 записи) — остаётся `deferred` (T-0344), не активируется этой задачей.
- **O6.** Расширение `derived-fields-dao.ts` НОВЫМИ типами derived-полей (matrix-lookup уже поддержан, используется как есть) — только вызов существующей `computeAllDerivedFields` из пути старта, не новая derived-логика.
- **O7.** Timer-воркер, message-catch/throw доставка, dual-control/замещение — известные отдельные дыры карты примитивов, не пересекаются с этим швом.

## 9. Открытые вопросы

Нет blocking-вопросов. Способ реализации примитива 3 (§3 п.3 — конкретное поле/таблица для target-набора) оставлен BUILD как решение уровня DESIGN/BUILD, не аналитика — спека фиксирует наблюдаемое требование (задача должна уметь резолвить target-набор ИЗ КОНФИГУРАЦИИ per-(process/app), а не из константы), а не конкретную DDL-форму.

---

## 10. Acceptance Criteria

| ID | Текст | verifiable_as |
|---|---|---|
| AC-1 | На живом стенде для NON-TEL процесса (BPMN user-task с `candidateGroups`, отличным от `role-approver`) СТАРТОВАЯ (базовая) задача в инбоксе продукта адресована РОЛИ, реально прочитанной из `candidateGroups` этого user-task в движке — не литералу `role-approver` — подтверждено просмотром инбокса под пользователем этой роли (задача видна) И отсутствием видимости у пользователя с ролью `role-approver`, если она не входит в `candidateGroups` этого узла. | manual |
| AC-2 | На том же прогоне AC-1, метка/имя задачи в инбоксе — реальное имя BPMN user-task этого процесса (`engineTask.name`), не литерал `"Согласование"`/`"Согласовать заявку"`, когда BPMN-имя отличается от них. | manual |
| AC-3 | LIVE_PROOF: приложение с полем-rollup (computed, `x-rollup`), участвующим в шлюзовом условии (`${поле>порог}`), при создании записи через on_create-триггер, где дочерние записи делают rollup-сумму БОЛЬШЕ порога, реально уводит инстанс ПО ВЕТКЕ условия (не дефолтной) — проверено просмотром UI (следующая задача процесса соответствует ветке condition=true) — прямая инверсия сегодняшнего наблюдения LIVE_PROOF T-0571 (600000 ушли дефолтной). | manual |
| AC-4 | Автоматизированный тест (живой Flowable+Postgres, не мок): старт NON-TEL процесса с BPMN user-task, чьи `candidateGroups`/`name` ОТЛИЧАЮТСЯ от `role-approver`/`Согласование`/`Согласовать заявку` → assert, что `process.started` audit_event payload несёт `task_role`/`task_step`/`task_name`, СОВПАДАЮЩИЕ с реальными `candidateGroups[0]`/`name` движка, а не с константами процесс-агностичного дефолта. Тест красный на коде до фикса (сегодня всегда пишет константы), зелёный после. | test |
| AC-5 | Автоматизированный тест: rollup-поле реестра (`x-rollup`, вычисляемое через `computeAllDerivedFields`), объявленное в `field_mapping` on_create-binding, реально присутствует (не `undefined`/`null` из-за отсутствия) в наборе переменных, переданных `flowable.startInstance(...)`, когда его дочерние записи существуют на момент создания родительской записи. Тест красный на коде до фикса (сегодня `projectEngineVariables` не видит rollup-значения), зелёный после. | test |
| AC-6 | Автоматизированный тест: `step-applier.applyStepResult` резолвит целевой реестр результата шага ИЗ конфигурации, привязанной к (`process_key`, `application_id`) — НЕ по буквальному сравнению с `"soglasovanie"` — подтверждено тестом, где сконфигурированный реестр называется ИНАЧЕ (произвольный slug) и результат шага корректно записывается именно туда. | test |
| AC-7 | Автоматизированный тест: при отсутствии сконфигурированного target-набора для шага, который его требует (marker present), approve-путь возвращает СТРУКТУРИРОВАННУЮ ошибку (не общий 500 без деталей) с сообщением, называющим отсутствующую конфигурацию, и это залогировано с контекстом (tenantId, processKey/applicationId) — не тихий 500 (BUG-017 симптом). | test |
| AC-8 | Регрессия: существующие ТЭЛ-frozen интеграционные/acceptance-тесты (T-0571 AC-6..AC-8 и смежные, включая линейный ТЭЛ-процесс на живом стенде) продолжают проходить БЕЗ изменения самих тестов — ТЭЛ-роль (`role-approver`), метки (`«Согласование»`/`«Согласовать заявку»`) и целевой набор (`soglasovanie`) воспроизводятся как результат ДАННЫХ сида/binding-конфигурации, идентичный сегодняшнему поведению. | test |
| AC-9 | Регрессия: `form-record-persister.ts` продолжает резолвить формы `purchase`/`approval` под приложением `tel-approval` в реестры `purchases`/`soglasovanie` ДЛЯ ТЭЛ-тенанта КАК ДАННЫЕ (миграция 076/маппинг), не переставая работать; тест подтверждает эквивалентность поведения до/после. | test |
| AC-10 | Grep-проверка (fitness, входной baseline для T-0576): подсчёт вхождений литерала-ЗНАЧЕНИЯ `"role-approver"` и `"soglasovanie"` и `"tel-approval"` в `src/**/*.ts` (исключая test-фикстуры, документирующие комментарии и сами имена seed-констант, если они остаются как имена, привязанные к настраиваемому значению) СТРОГО МЕНЬШЕ, чем на коммите 080486c (baseline этой задачи) — количество мест, где строка возникает как единственно возможное жёстко закодированное значение резолюции, уменьшилось. | fitness |
| AC-11 | Диспетчер агентского контура (`dispatch-outcome.ts:274`): fallback-роль при пустом `ctx.roleId` читается из настраиваемого источника (конфиг/константа-с-именем, документированная как fallback), а не заново зашитой строки `"role-approver"`, дублирующей `process-projection.ts:226` независимо. | manual |

---

*Файл: `docs/specs/T-0575-detel-primitives.spec.md`. Разведка: `src/http/process-projection.ts` (константы 226-230, `appendProcessStarted` 253-313, read-fallback 780/795-796/868-870/1072/1074/1440/1448/1450/1756-1758/1824), `src/http/process-start.ts` (386-394), `src/http/records.ts` (634-834, `projectEngineVariables` 654-682, on_create-старт 754-897), `src/db/step-applier.ts` (константа 78, `resolveApprovalsRegistry` 192-209, `applyStepResult` 526-605), `src/http/form-record-persister.ts` (100-106), `src/runtime/agent-dispatch/dispatch-outcome.ts` (274), `src/db/derived-fields-dao.ts` (1-9, `computeAllDerivedFields` 238-266), `src/core/rollup-contract.ts` (`extractDerivedFields` 353), `src/db/binding-trigger-dao.ts` (весь файл, `process_app_binding.field_mapping` контракт), `migrations/075_process_app_binding.sql`, `migrations/045_form_binding.sql`, `migrations/076_soglasovanie_registry_seed.sql`. Карта примитивов: `demiurge/docs/choros-primitives-map-2026-07-02.md` §5, §7 п.4.*
