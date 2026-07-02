# ADR T-0575 — Вынос ТЭЛ-хардкодов из несущих путей (деТЭЛизация): роль/метки из движка, target-набор шага из binding, computed→переменные

- **Status:** READY — design-only (никакого продуктового кода в этом изменении; edits — отдельный BUILD-таск).
- **Date:** 2026-07-02
- **Task:** T-0575 [W1/деТЭЛ] BUG-015/016/017 — «роль из candidateGroups + настраиваемый fallback, target-набор результата шага из binding, метки задач из BPMN, computed→переменные процесса».
- **Предшественник:** T-0571 (done, dev@080486c) — снял литерал `taskDefKey="task-approve"` с пути МАТЧИНГА завершения. Явно оставил роль/метки/target/computed этому таску (ADR-T0571 §2.2, §7).
- **Преемник:** T-0576 — анти-кейс CI-гейт (постоянный греп-список). Этот таск обязан УМЕНЬШИТЬ baseline; §6 фиксирует точный входной список для T-0576.
- **Родительские ADR:** `ADR-T0432-engine-backed-inbox.md` (inbox = проекция живого Flowable — движок источник правды об активной задаче), `ADR-T0571-engine-drive-seam.md` (резолв-по-инстансу; envelope `{error:{code}}`), доктрина data-ownership (`choros-data-ownership-doctrine`), PD-20 (derived не в `record.data`).
- **Автор:** ARCHITECT (design only).
- **runtime_target:** `src/http/process-projection.ts` (`APPROVER_ROLE`/`APPROVE_STEP`/`APPROVE_TASK_NAME` 226-230, `appendProcessStarted` 253-313), `src/http/process-start.ts` (386-394 call site), `src/http/records.ts` (`projectEngineVariables` 654-682, on_create-старт 754-897, вызов `appendProcessStarted` 881-891), `src/db/step-applier.ts` (`SOGLASOVANIE_SLUG` 78, `resolveApprovalsRegistry` 192-209, `applyStepResult` 526-615), `src/http/inbox.ts` (approve error-mapping ~1385/1622), `src/http/form-record-persister.ts` (100-106), `src/runtime/agent-dispatch/dispatch-outcome.ts` (274), `src/db/derived-fields-dao.ts` (`computeAllDerivedFields` 238), `src/core/rollup-contract.ts` (`extractDerivedFields` 353). Одна additive-миграция: **119** (target-набор в `process_app_binding`) + один config-примитив fallback-роли. Модель событий не меняется.

---

## 1. Контекст — четыре хардкода на несущих путях (C↔L, проверено построчно на 080486c)

Спека (§1-2) и карта примитивов §5 подтверждены построчно в этом worktree. Четыре независимых ТЭЛ-осадка сидят на путях, общих для ЛЮБОГО процесса:

1. **BUG-015 (роль+метки, `process-projection.ts:226-230`).** `appendProcessStarted` УЖЕ параметризуема (`approverRole?`/`step?`/`taskName?`, дефолт на константы, 284-286), но ОБА вызывающих (`process-start.ts:386-394`, `records.ts:881-891`) опускают эти параметры → базовая (стартовая) задача ЛЮБОГО процесса пишет в `process.started` payload `task_role:"role-approver"`, `task_step:"Согласование"`, `task_name:"Согласовать заявку"`. Read-fallback в проекции (795-796, 868-870) честен, но единственным источником базовой строки остаётся эта константа. Частичный примитив уже живёт на post-gateway путях: `engineTask.candidateGroups[0] ?? APPROVER_ROLE` (1072), `nextTask.candidateGroups[0] ?? APPROVER_ROLE` (1440) — но НЕ на стартовом (самом частом) пути.
2. **BUG-017 (target-набор, `step-applier.ts:78`).** `applyStepResult` резолвит реестр результата шага буквальным `SOGLASOVANIE_SLUG` (`resolveApprovalsRegistry` 192-209, `WHERE slug=$3`). `process_app_binding` (миграция 075, расширена 082 полями `trigger_type`/`field_mapping`) УЖЕ связывает `(process_key, application_id)`, но НЕ несёт «в какой реестр писать результат шага». Отсутствие → `throw new Error(...)` (573-580) — правильный fail-closed по СЕМАНТИКЕ, но голый `Error`, ловится в inbox.ts как общий 500 без структурированного кода/лога (симптом «500 без лога»).
3. **BUG-016 (computed→переменные, `records.ts:654-682`).** `projectEngineVariables` читает ТОЛЬКО `record.data`. По доктрине PD-20 rollup НЕ хранится в `record.data` — вычисляется `computeAllDerivedFields` (`derived-fields-dao.ts:238`) на READ. on_create-путь (`records.ts` ~754-834) НЕ зовёт её перед `startInstance` → любое computed-поле в шлюзовом условии движок видит как `undefined`. LIVE_PROOF T-0571: 600000 (rollup) ушли ДЕФОЛТНОЙ веткой.
4. **BUG-015-агент (`dispatch-outcome.ts:274`).** `role: ctx.roleId !== "" ? ctx.roleId : "role-approver"` — та же строка, вторая независимая копия как defer-fallback.

Форма-персистер (`form-record-persister.ts:100-106`) — `FORM_TO_REGISTRY_SLUG={purchase:"purchases",approval:"soglasovanie"}` + `TEL_APPLICATION_SLUG="tel-approval"` — тот же паттерн для форм.

**Опорные факты кода (не гипотеза), делающие фикс соразмерным:**
- `ActiveUserTask` (`flowable-client.ts:180-189`) уже несёт `name` + `candidateGroups`. `getActiveUserTasks(instanceId)` возвращает их.
- В ОБОИХ call site движковый клиент доступен И инстанс уже стартован ДО `appendProcessStarted`: `process-start.ts` вызывает `getActiveUserTasks` на 404 (для task-submit); `records.ts` — `startInstance` (823) → `getFirstActiveUserTask` (855) → `appendProcessStarted` (881). Активная user-task существует в движке в момент проекции.
- `computeAllDerivedFields` + `extractDerivedFields` УЖЕ импортированы в `records.ts` (98-99) и проверены на read-пути. `reg` (GoverningRegistryDef) несёт `record_schema` (records.ts:421); record `id` заминчен на 697 и вставлен ДО старта. Всё для BUG-016 уже под рукой — разрыв только в отсутствии ВЫЗОВА перед проекцией.
- `process_app_binding` — уже расширяемая (082 добавила колонки additive). Естественный дом target-набора.

---

## 2. Решение

Общий принцип (тот же, что T-0571): **движок/конфигурация — источник правды, литерал — только именованный fallback.** Четыре примитива, каждый — «сначала resolve, потом настраиваемый дефолт».

### 2.1 Примитив 1+2 — роль и метки базовой задачи из активной user-task движка (BUG-015)

**Принцип: базовая (`process.started`) задача несёт РЕАЛЬНЫЕ `candidateGroups[0]`/`name` первого активного user-task ЭТОГО инстанса, прочитанные из движка в момент старта; константа — только именованный настраиваемый fallback.**

Механически (за BUILD, здесь контракт): в обоих call site ПОСЛЕ успешного старта инстанса и ДО (или в момент) `appendProcessStarted` вызвать `flowable.getActiveUserTasks(instanceId)` (уже вызывается в `process-start.ts:404`; в `records.ts` уже есть `getFirstActiveUserTask` на 855 — расширить до чтения `candidateGroups`/`name` либо добавить один `getActiveUserTasks`), взять первый активный user-task и прокинуть `approverRole = task.candidateGroups[0]`, `taskName = task.name`, `step = task.name` (BPMN-имя узла) в `appendProcessStarted`.

**Fallback-политика (когда движок недоступен / задача ещё не materialized / `candidateGroups` пуст):**
- **Настраиваемый tenant-level fallback (примитив, НЕ вторая литеральная строка).** Дефолт fallback-роли читается из единого config-источника `resolveDefaultApproverRole()` (env `CHOROS_DEFAULT_APPROVER_ROLE`, дефолт значения = сегодняшняя `"role-approver"` ради обратной совместимости). Литерал `"role-approver"` остаётся РОВНО в одном месте — как значение этого дефолта, привязанное к настраиваемому символу; `APPROVER_ROLE` становится синонимом `resolveDefaultApproverRole()`, а не hardcoded const.
- **Метки** (`step`/`taskName`): когда движок недоступен ИЛИ имя узла пусто → честный generic-плейсхолдер из того же config-источника (дефолт значения = сегодняшние `"Согласование"`/`"Согласовать заявку"` для ТЭЛ-совместимости). НЕ угадывать бизнес-имя.
- **Роль-approver как ЛИТЕРАЛ на пути ПРОЕКЦИИ базовой задачи умирает**: код обязан сначала попытаться `candidateGroups[0]`; строка возникает ТОЛЬКО как значение настраиваемого дефолта.

**Порядок вызова (BUILD-нота, критично):** `getActiveUserTasks` best-effort — сбой чтения движка НЕ роняет старт (проекция additive, как сегодня 395-397/893-895). При сбое → fallback-роль/метки, инстанс всё равно стартован. Это НЕ регрессия: сегодня всегда пишется константа; после — реальное значение когда доступно, тот же дефолт когда нет.

**`>1 активной user-task на старте:** базовый `process.started` в модели событий = ровно один ожидающий человеческий шаг (ADR-T0571 §2.1). Берём первый активный user-task (тот же, что T-0443/T-0368 skip-submit уже берут как «первый»); AND-split приходит как `process.next_task` с истинным ключом — не базовый путь. Согласовано с T-0571.

### 2.2 Примитив 1 в агентском контуре (BUG-015-агент, `dispatch-outcome.ts:274`)

`planDeferTask` получает `role` из того же `resolveDefaultApproverRole()` fallback-примитива при пустом `ctx.roleId` — НЕ из заново зашитой строки `"role-approver"`, дублирующей `process-projection.ts:226`. Одна config-точка на обе копии. (AC-11.)

### 2.3 Примитив 3 — target-набор результата шага из binding (BUG-017)

**DDL (миграция 119, additive):** добавить в `choros.process_app_binding` колонку
```
target_registry_slug text NULL
```
NULL-семантика: `NULL` = «использовать дефолтный slug результата шага» (совместимость — резолвится в сегодняшний `"soglasovanie"` через config-дефолт `resolveDefaultStepResultSlug()`, env `CHOROS_DEFAULT_STEP_RESULT_SLUG`, значение по умолчанию `"soglasovanie"`); non-NULL = буквальный slug реестра результата ЭТОГО (process,app).

**Почему `process_app_binding`, а не `form_binding`:** `process_app_binding` уже связывает `(process_key, application_id)` и `resolveInstanceTargetOnClient` уже резолвит инстанс→app через неё (085 seed). Target-набор результата шага — свойство пары (процесс, приложение), не (процесс, форма-поле-контракт). `form_binding` (045) несёт field-контракт формы — конфляция сломала бы его natural key. Спека §3 п.3 и карта §5 обе называют `process_app_binding`/`form_binding.target_registry_id` кандидатами; выбираем `process_app_binding` по владению связью.

**Механически:** `resolveApprovalsRegistry` (step-applier.ts:192-209) перестаёт получать `SOGLASOVANIE_SLUG` литералом. Вместо этого `applyStepResult` резолвит target-slug из `process_app_binding` строки инстанса (JOIN уже делается в `resolveInstanceTargetOnClient`; расширить его результат полем `targetRegistrySlug`) и передаёт в `resolveApprovalsRegistry(client, tenantId, appId, slug)`. `slug = binding.target_registry_slug ?? resolveDefaultStepResultSlug()`. `SOGLASOVANIE_SLUG` в step-applier.ts исчезает как SQL-параметр; может остаться как ИМЯ дефолт-значения config (или уходит совсем, если дефолт живёт в одном месте). Дубли live-form-schema.ts:41 / form-record-persister.ts:102 — см. §2.5.

**Fail-honest (§7 спеки, AC-7):** `applyStepResult`, когда target ТРЕБУЕТСЯ (marker present) но реестр не резолвится, перестаёт бросать голый `Error`. Бросает **типизированную** `StepTargetUnresolvedError` (или эквивалент с полем `code:"STEP_TARGET_UNRESOLVED"` + `detail:{tenantId, processKey, applicationId, expectedSlug}`). Approve-хендлер (`inbox.ts`, catch на ~1385 / вокруг 1622) маппит её в структурированный envelope `{error:{code:"STEP_TARGET_UNRESOLVED", message, ...}}` со статусом **422** (конфигурация неполна — не транзиентный 5xx, не «server crashed»), и логирует с контекстом (`tenantId`, `processKey`/`applicationId`, `expectedSlug`) — НЕ тихий 500. Envelope — та же codebase-wide форма `{error:{code}}`, что ADR-T0571 узаконил (`router.ts sendErrorEnvelope`). Транзакция всё так же ROLLBACK (fail-closed СЕМАНТИКА сохранена — меняется только КАЧЕСТВО ошибки). `no_app_binding` (нет binding вовсе) остаётся санкционированным no-op skip (step-applier.ts:543-547) — не ошибка.

### 2.4 Примитив 4 — computed (rollup) в переменные процесса (BUG-016)

**Принцип: путь старта процесса вычисляет derived-поля реестра ДО проекции переменных и кладёт их в набор, доступный `field_mapping`.**

Механически (on_create, `records.ts` перед строкой 769):
1. `const derivedSpecs = extractDerivedFields(reg.record_schema);` (уже импортирован; `reg.record_schema` доступен).
2. Если `derivedSpecs.length > 0`: `const derived = await computeAllDerivedFields(client, tenantId, id, data as Record<string,unknown>, derivedSpecs);` (record `id` заминчен на 697, дочерние записи уже существуют на момент on_create; вызов на том же tenant-tx client). Обернуть в SAVEPOINT (как dmn_precompute 785) — сбой вычисления НЕ роняет старт (derived → пропущены, дефолт-ветка, честная деградация).
3. `const projectionSource = { ...(data as object), ...derived };` — derived-значения оверлеят raw-scalar набор (rollup-ключ теперь имеет значение).
4. `let variables = projectEngineVariables(projectionSource, binding.field_mapping);` — `field_mapping`, ссылающийся на rollup-ключ, теперь получает вычисленное число, не `undefined`.

`projectEngineVariables` НЕ меняет сигнатуру/семантику (по-прежнему принимает только скаляры; derived-значения — числа/null, проходят RECORD_IN_PAYLOAD guard естественно). Явный старт (`process-start.ts`) не имеет record-контекста (стартует без записи) → derived-overlay применяется ТОЛЬКО на on_create-пути, где record существует; explicit-путь не регрессирует.

**Контракт типов переменных (money/number → Flowable):** rollup-результат — numeric (`computeRollupValue` возвращает число или null). В Flowable-переменную идёт как есть через существующий `projectEngineVariables` (number → number). `money`-поля в rollup — числовые скаляры (копейки/минимальные единицы по T-0509), передаются как number; никакой строковой сериализации. **null-семантика ЧЕСТНАЯ:** rollup без дочерних записей → `computeAllDerivedFields` кладёт `null` (не 0) → в переменную идёт `null` (RECORD_IN_PAYLOAD guard пропускает null как `?? null`). Шлюз `${amount>500000}` на null → false (нет суммы = не превышает) — детерминировано, не throw. НЕ подменять null нулём: «нет дочерних» ≠ «сумма ноль».

**Живое следствие (AC-3, LIVE_PROOF):** заявка с rollup-суммой >порога уходит веткой условия — прямая инверсия наблюдения T-0571.

### 2.5 Дубли константы (live-form-schema.ts:41, form-record-persister.ts:100-106)

- `live-form-schema.ts:41` — своя копия `SOGLASOVANIE_SLUG`. Схлопнуть в единый config-источник `resolveDefaultStepResultSlug()` (или импорт одной константы), чтобы значение жило в одном месте.
- `form-record-persister.ts` — `FORM_TO_REGISTRY_SLUG` + `TEL_APPLICATION_SLUG` резолвят формы через SQL slug-параметры (201, 363). Примитив: маппинг form→registry и приложение-хозяин формы обязаны стать ДАННЫМИ (миграция 076 их уже сидит как реестры/приложение). BUILD выносит резолюцию в data-lookup (по tenant/form), оставляя ТЭЛ-значения сидом. Сокращение baseline §6 засчитывает уход этих литералов как единственного код-пути. (Соразмерность: если полный вынос form-persister превышает бюджет — минимум обязан уйти `approval:"soglasovanie"` и `TEL_APPLICATION_SLUG` как единственный путь; порядок BUILD, критерий AC-9/AC-10.)

---

## 3. Совместимость (frozen ТЭЛ-путь работает через ДАННЫЕ)

ТЭЛ перестаёт быть кодом, становится данными сида — не переставая работать:

- **Роль/метки (§2.1):** `tel-linear.bpmn20.xml` user-task несёт `candidateGroups="role-approver"` и имя узла, совпадающее с сегодняшними `"Согласование"`/`"Согласовать заявку"`. Чтение РЕАЛЬНЫХ `candidateGroups`/`name` из движка для ТЭЛ выдаёт РОВНО те же значения → frozen ТЭЛ-джорнеи (T-0571 AC-6..AC-8, tel-linear-smoke) зелёные без правки тестов. **BUILD-верификация (диагностическая, не решение):** сверить, что `<userTask name=...>` в BPMN действительно `"Согласование"`/`"Согласовать заявку"`; расхождение — находка, требующая либо data-fix сида, либо явного плейсхолдера, но не ломающая контракт.
- **Target-набор (§2.3):** ТЭЛ-binding (085 seed) получает `target_registry_slug='soglasovanie'` (миграция 119 UPDATE строки 085 ИЛИ 085-seed правится добавлением колонки-значения — BUILD выбирает; ТЭЛ-кейс переезжает в ДАННЫЕ). Резолюция ТЭЛ → тот же `soglasovanie`-реестр, что сегодня. Config-дефолт `resolveDefaultStepResultSlug()='soglasovanie'` страхует binding без явного slug.
- **Форма-персистер (§2.5):** `tel-approval`/`purchases`/`soglasovanie` резолвятся через таблицу-сид (076), а не единственную строку в коде.
- **computed (§2.4):** explicit-старт без записи не задет; on_create для ТЭЛ (если применяется) только ДОБАВЛЯет derived — раньше их не было, дефолт-поведение при отсутствии rollup-полей идентично.

Задетые тесты/импортёры (перечень для BUILD/REVIEW):
- **Импортёры констант:** `inbox.ts:49,1170` (`APPROVE_TASK_NAME`), `process-projection.ts` read-fallback (780,795-796,868-870,904-906,1072,1074,1440,1448,1450,1756-1758,1824 — остаются как имена настраиваемых дефолтов), `step-applier` тесты (`step-applier.test.ts:28,227,330`, `inbox-form-values.test.ts:35`, `inbox-form-submit-validation.test.ts:27`, `inbox-form-submit.adversarial.test.ts:35` — мокают по `SOGLASOVANIE_SLUG`, обновляются под config-slug).
- **Frozen (обязаны остаться зелёными без правки логики теста):** `e2e/journeys/tel-linear.journey.ts`, `tel-gateway-routing.journey.ts`, `ci/checks/flowable/tel-linear-smoke.sh`, T-0571 `inbox-engine-drive` + `engine-drive-generic.db.test.ts`.
- **T-0571 engine-drive:** не регрессирует — этот таск не трогает путь ЗАВЕРШЕНИЯ движковой задачи (только payload проекции роли/меток + переменные старта + резолюцию target). resolve-by-instance (T-0571) ортогонален.

---

## 4. Отвергнутые альтернативы

| Опция | Почему нет |
|---|---|
| **A1. Читать candidateGroups/name из BPMN-модели (парсер) при старте** | Второй источник правды о задаче (дрейф «две машины», отвергнут в ADR-T0432 Option B и ADR-T0571 B2). Движок УЖЕ знает активную user-task инстанса — `getActiveUserTasks` уже вызывается. Соразмерность: лишний BPMN-парсер vs один уже-делаемый вызов. |
| **A2. Оставить `APPROVER_ROLE` литералом, просто прокинуть в call sites** | Не устраняет класс: строка остаётся единственным значением на пути проекции. Config-примитив (`resolveDefaultApproverRole`) убирает литерал как значение, оставляя один настраиваемый дефолт (AC-10/AC-11 требуют уменьшения именно ЗНАЧЕНИЙ-литералов). |
| **B1. target-набор в `form_binding` (045)** | `form_binding` = field-контракт (process_key, form_key); target-реестр результата — свойство (процесс, приложение), не формы. Конфляция ломает natural key 045 (D-056 additive-дисциплина). `process_app_binding` уже владеет связью инстанс→app. |
| **B2. Новая таблица `step_result_target`** | Несоразмерно: одна колонка на существующей owning-таблице покрывает требование. Новая таблица = новый RLS-контур, миграция, DAO — оверинжиниринг для 1:1 атрибута binding. |
| **B3. Оставить голый `Error` в applyStepResult, маппить по тексту сообщения** | Матчинг ошибки по строке сообщения — хрупко, тот же класс «резолюция по литералу». Типизированный код (`STEP_TARGET_UNRESOLVED`) — контрактная поверхность для HTTP-слоя (AC-7). |
| **C1. Хранить rollup в `record.data` при создании (нарушить PD-20)** | Ломает доктрину (derived НИКОГДА не в `record.data`; no-rollup-of-rollup держится именно на этом). computed-overlay в МОМЕНТ проекции переменных (§2.4) не меняет хранение — вычисляет транзиентно для движка. |
| **C2. Подменять rollup-null нулём для «безопасного» шлюза** | Скрывает «нет дочерних записей» под «сумма 0» — нечестная null-семантика, может увести не туда на условиях `${x<порог}`. null → false на `>`, честно и детерминировано. |
| **D1. Одна миграция №118** | dev ушёл вперёд базы этого worktree: origin/dev уже несёт **117** (T-0570); **118** вероятно в полёте (T-0573). Использовать **119** и велеть кодеру ребейзнуться на origin/dev ПЕРВЫМ шагом (иначе коллизия номера при мерже). |

---

## 5. Fitness-функции (исполнимые CI-правила против дрейфа)

| id | rule | ci_check |
|---|---|---|
| **FF-1** | Базовая (`process.started`) задача НЕ пишет `task_role`/`task_step`/`task_name` из безусловной константы: оба call site `appendProcessStarted` (process-start.ts, records.ts) прокидывают значения, прочитанные из `getActiveUserTasks`; проекция сначала пытается движок, литерал — только именованный fallback. | `bash ci/checks/detel-base-task-from-engine.sh` — grep: вызовы `appendProcessStarted(` в `process-start.ts`/`records.ts` содержат `approverRole`/`taskName`/`step` (не голый вызов без них) И `resolveDefaultApproverRole` определена как единственный источник дефолта; наличие голого вызова = exit 1. Плюс `--self-test`. |
| **FF-2** | Живой интеграционный тест (Flowable+Postgres): старт NON-TEL процесса с user-task, чьи `candidateGroups`/`name` ≠ `role-approver`/`Согласование`/`Согласовать заявку` → `process.started` audit payload несёт `task_role`==`candidateGroups[0]`, `task_name`==`name`. Красный до фикса (пишет константы), зелёный после. | `vitest run --dir ci/checks/db ci/checks/db/detel-base-task-role.db.test.ts` (lane `fitness:db`; AC-4). |
| **FF-3** | rollup-поле (`x-rollup`), объявленное в on_create `field_mapping`, присутствует в наборе переменных, переданном `startInstance`, когда дочерние записи существуют (не `undefined`). Красный до фикса. | `vitest run --dir ci/checks/db ci/checks/db/detel-rollup-to-variables.db.test.ts` (lane `fitness:db`; AC-5). |
| **FF-4** | `applyStepResult` резолвит target-реестр из `process_app_binding.target_registry_slug` (per process,app), НЕ по буквальному `"soglasovanie"`: тест с реестром под ПРОИЗВОЛЬНЫМ slug пишет результат туда. | `vitest run src/__tests__/step-applier.test.ts -t "target from binding, arbitrary slug"` (AC-6). Красный до фикса (сравнивает с литералом), зелёный после. |
| **FF-5** | Отсутствие сконфигурированного target при обязательном шаге (marker present) → структурированная ошибка `{error:{code:"STEP_TARGET_UNRESOLVED"}}` статус 422 + лог с контекстом; НЕ голый 500. | `vitest run src/__tests__/inbox-engine-drive.test.ts -t "step-target-unresolved-visible"` (AC-7). Красный до фикса (общий 500), зелёный после. |
| **FF-6** | Frozen ТЭЛ не регрессирует: линейный ТЭЛ + gateway-routing проходят как раньше — роль `role-approver`, метки/`soglasovanie` воспроизводятся как ДАННЫЕ сида/binding, не как код. | `bash ci/checks/flowable/tel-linear-smoke.sh && vitest run e2e/journeys/loader.test.ts` (journeys tel-linear, tel-gateway-routing; AC-8). Регрессия = exit 1. |
| **FF-7 (анти-кейс baseline, D-064 / вход T-0576)** | Число вхождений литерала-ЗНАЧЕНИЯ `"role-approver"`, `"soglasovanie"`, `"tel-approval"` в `src/**/*.ts` (искл. `__tests__`/`.test.ts`, комментарии, имена настраиваемых дефолт-констант) СТРОГО МЕНЬШЕ baseline 080486c (role-approver:7, soglasovanie:5, tel-approval:6). | `bash ci/checks/detel-literal-baseline.sh` — считает `grep -c` каждого литерала в `src` минус test/comment, сравнивает с записанным baseline; не-меньше = exit 1 (AC-10). Плюс `--self-test`. |

---

## 6. Точный список строк — вход для T-0576 baseline (AC-10)

Baseline на **080486c** (замерено грепом `src/**/*.ts` минус `__tests__`/`.test.ts`):

| Литерал | baseline | обязано стать после T-0575 |
|---|---|---|
| `"role-approver"` | **7** (из них ЗНАЧЕНИЯ-хардкоды: `process-projection.ts:226` определение, `dispatch-outcome.ts:274` defer-fallback; остальные 5 — комментарии/сид-маппинги/транслитерация) | оба ЗНАЧЕНИЯ-хардкода схлопываются в один `resolveDefaultApproverRole()` config-дефолт → минус 1 независимая копия (`dispatch-outcome.ts:274` перестаёт быть второй строкой); `process-projection.ts:226` остаётся как значение единого дефолта, привязанное к настраиваемому символу. |
| `"soglasovanie"` | **5** (`step-applier.ts:78` определение+SQL-параметр, `form-record-persister.ts:102` маппинг, `live-form-schema.ts:41` вторая копия; +комментарии `form-record-persister.ts:20`, `process-defs.ts:371` транслитерация) | `step-applier.ts:78` перестаёт быть SQL-параметром резолюции (резолвит из binding); `live-form-schema.ts:41` схлопывается в единый config-источник; `form-record-persister.ts:102` уходит в data-lookup. Значение остаётся как config-дефолт в одном месте. |
| `"tel-approval"` | **6** (`form-record-persister.ts:106` определение + SQL-параметры 201/363; +комментарии 21/39/90/196/319) | `TEL_APPLICATION_SLUG` перестаёт быть единственным код-путём резолюции хозяйского приложения формы (data-lookup); значение — сид 076. |

**Остаётся как ДАННЫЕ (легитимно, вне baseline-уменьшения):** миграции 076/077/084/085/086/087/089, `080_tel_dmn_seed.sql` (порог 5000000 — O1), `config/flowable/processes/tel-linear.bpmn20.xml`, test-фикстуры, комментарии, транслитерация `process-defs.ts:371`, `timer-escalation-mapper.ts:109` (комментарий-пример). Миграция **119** добавляет `target_registry_slug` + ТЭЛ-data-значение — это ДАННЫЕ, не код-путь.

---

## 7. Совместимость public-поверхности / схемы

- **Миграция 119** — additive-only: `ALTER TABLE choros.process_app_binding ADD COLUMN IF NOT EXISTS target_registry_slug text NULL`. Nullable, дефолт NULL → все существующие строки валидны (резолвятся через config-дефолт). Idempotent (`IF NOT EXISTS`). `process_app_binding` уже в `ci/checks/known_tenant_tables.txt:56` — RLS-контур не меняется (колонка на существующей tenant-таблице). **Кодер ребейзится на origin/dev ПЕРВЫМ шагом** (dev несёт 117; 118 вероятно в полёте — 119 свободен).
- **ТЭЛ-data-seed:** миграция 119 (или правка 085) проставляет ТЭЛ-binding'у `target_registry_slug='soglasovanie'` — @demo-seed, скипается при `CHOROS_SEED_DEMO=off`.
- **Config-примитивы:** `resolveDefaultApproverRole()` (env `CHOROS_DEFAULT_APPROVER_ROLE`, дефолт `"role-approver"`), `resolveDefaultStepResultSlug()` (env `CHOROS_DEFAULT_STEP_RESULT_SLUG`, дефолт `"soglasovanie"`) — читаются из окружения с обратно-совместимым дефолтом. Отсутствие env = сегодняшнее поведение.
- **Типы:** `StepTargetUnresolvedError` (или `code` на существующем error-типе) — новая, additive. `ActiveUserTask`, `OnCreateBindingRow`, `GoverningRegistryDef` не меняют форму (`target_registry_slug` добавляется в binding-DAO row additive). `appendProcessStarted` сигнатура уже несёт опциональные `approverRole?`/`step?`/`taskName?` — не меняется (call sites начинают их передавать).
- **Модель событий** (`process.started`, `task.approved`, `process.next_task`, `instance.ended`) НЕ меняется — payload `process.started` уже несёт `task_role`/`task_step`/`task_name` (меняются ЗНАЧЕНИЯ, не форма).

---

## 8. Трассировка AC → покрытие

| AC | covered_by |
|---|---|
| AC-1 (базовая задача адресована роли из candidateGroups) | §2.1; FF-2 (db); LIVE_PROOF §5 спеки |
| AC-2 (метка = BPMN user-task name) | §2.1; FF-2 |
| AC-3 (rollup>порог уводит веткой условия) | §2.4; FF-3; LIVE_PROOF manual |
| AC-4 (audit payload task_role/step/name == candidateGroups[0]/name) | §2.1; FF-2 |
| AC-5 (rollup в переменных startInstance, не undefined) | §2.4; FF-3 |
| AC-6 (target из конфигурации, произвольный slug) | §2.3; FF-4 |
| AC-7 (структурированная ошибка при отсутствии target + лог) | §2.3; FF-5 |
| AC-8 (frozen ТЭЛ зелёные без правки тестов) | §3; FF-6 |
| AC-9 (form-persister резолвит purchase/approval для ТЭЛ как данные) | §2.5; §3; FF-6 |
| AC-10 (grep-baseline строго меньше 080486c) | §6; FF-7 |
| AC-11 (dispatch-outcome fallback из config, не дубль-строки) | §2.2; FF-1 |

---

## 9. Границы

Design-only: продуктовый код НЕ меняется здесь — отдельный BUILD-таск. Вне скоупа (спека §8): порог 5000000 и DMN outcomes (O1); механизм T-0571 (O2); построение постоянного анти-кейс CI-гейта как инфраструктуры (O3 → T-0576; FF-7 фиксирует baseline diff, но не строит общий гейт); НОВЫЕ типы derived-полей (O6 — только вызов существующей `computeAllDerivedFields`); B-branch (O5, T-0344 deferred); timer/message/dual-control (O7).

**Escalation:** нет. Направление подтверждено GO фаундера (карта §7 п.4 «одобрить вынос 4 несущих хардкодов»); открытых продуктовых/денежных/секретных развилок нет; blocking-вопросов в спеке нет (§9). Единственная операционная нота кодеру — ребейз на origin/dev перед миграцией 119 (§7).
