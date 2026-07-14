# ADR-T0607 — Честность контура ассистента: пять точечных дельт

Статус: accepted (build одним заходом). Спека: `docs/specs/T-0607-assistant-truth.spec.md`.

Принцип: ассистент не утверждает того, чего сервер не проверил, и не показывает того,
чего проверять нельзя. Пять минимально-инвазивных дельт, каждая закрывает свой дефект,
не переписывая ассистента.

## §1.1 — Дельта (а): read-порт реестров аналитика в правах актёра

**Новый DAO** `src/db/registry-digest-dao.ts::loadReadableRegistryDigest(pool, tenantId,
actorSlug, nowMs, opts)`:
- резолвит гранты актёра тем же `getGrantsForSubject` + composite ancestry
  (`loadTenantOrgAncestry` + `makeResourceAncestryOracle`), что и READ-PDP T-0570
  (single-resolver, FR-7);
- перечисляет `registry_def` тенанта (published-tier, RLS-scoped), для каждого считает
  видимые записи и берёт до `sampleLimit` примеров, фильтруя каждую строку через
  `isRecordReadable(rowAncestry, grants, ancestry, nowMs)` — тот же предикат, что LIST
  records. Ничего шире прав актёра;
- `cap`: не более `registryLimit` реестров, `sampleLimit` примеров на реестр; поля примера
  усечены до скалярных значений (без вложенных объектов) — bounded контекст.
- Возвращает `ReadableRegistryDigest { degraded: boolean; registries: [{slug, displayName,
  visibleCount, samples: string[]}] }`. Любой сбой чтения → `{ degraded: true, registries: [] }`
  (honest-degrade, не throw).

**Новый порт-тип** в `assistant-analyst.ts::AnalystPorts.loadRegistryDigest?:
(tenantId, actorSlug) => Promise<ReadableRegistryDigest | null>` (default: `null`).
`runAnalyst` вызывает его (когда задан) и кладёт результат в `ReportDraft.registryDigest`.
`buildDraftContext` рендерит секцию «Разделы и записи (в ваших правах)» из дайджеста.

**F-a2 честность пустоты**: текст «записей нет» появляется ТОЛЬКО когда дайджест не
`degraded` И все `visibleCount===0`. Когда `registryDigest===null` (порт не задан) или
`degraded===true`, секция реестров либо отсутствует, либо говорит «не удалось прочитать
разделы» — НЕ «записей нет». Старая безусловная строка `buildDraftContext` про «Записей
нет (либо доступ ограничен правами)» переносится за флаг «дайджест известен и пуст».

**Wiring** (`src/server.ts::setAnalystPorts`): `loadRegistryDigest` подключён к
`loadReadableRegistryDigest(grantsPool, …)`. Прежний комментарий «listRecords not wired»
заменён на реальный дайджест-порт (мы НЕ поднимаем полный record-lister — MVP-шаг по O1;
дайджест = счёт + примеры, достаточно для честного ответа).

## §1.2 — Дельта (б): owner-short-circuit в серверном PDP-гейте конфигуратора

`hasAuthoringDraftGrant(ctx)` расширяется: право = `isOwner(ctx) ||
canOperateSystemAgent(userGrants)`. Где:
- `userGrants` резолвятся напрямую по `ctx.userSubject` (не через мигающее пересечение —
  для ЦЕЛЕЙ ДОПУСКА право пользователя достаточно; agent∩user-инвариант остаётся на уровне
  ИСПОЛНЕНИЯ ops, executor уже tenant-scoped и draft-only);
- `isOwner` — новый опциональный инъектируемый предикат `ctx.isTenantOwner?: () =>
  Promise<boolean>` в `HandlerContext`. Composition root (`assistant.ts`) заполняет его
  через существующий `isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs)` (тот же
  резолвер, что честный-503 путь). Когда предикат не задан (тесты/стаб) → owner-ветка не
  срабатывает (fail-closed к прежнему поведению).

Гейт вызывается ДО `runConfiguratorLoop`/LLM (уже так структурно) — теперь он ещё и
считает владельца владельцем. Отказ при отсутствии права остаётся детерминированным
серверным `AUTHORING_ACCESS_DENIED_MESSAGE` (уже честный, называет администратора).

Почему не менять `canOperateSystemAgent`: его контракт — чистый предикат над `Grant[]`,
owner-short-circuit по дизайну — обязанность caller'а (его doc это фиксирует). Мы
исправляем именно caller (`hasAuthoringDraftGrant`), а не размываем предикат.

## §1.3 — Дельта (в1): slug→UUID резолв в исполнителе ops

Новый helper `assistant.ts::resolveRegistryDefId(pool, tenantId, idOrSlug)` и
`resolveApplicationId(pool, tenantId, idOrSlug)`: если аргумент — валидный UUID, вернуть
как есть; иначе — SELECT id по slug в правах тенанта (RLS). Не найдено → `null`.

`executeApprovedOpAsDraft` для kinds, принимающих идентификатор реестра/приложения
(`edit_jsonschema_non_destructive.registryDefId`, `relate_application.sourceRegistryDefId`
+ `cascade.targetRegistryId`, `author_binding.applicationId`, `emit_form.applicationId`,
`generate_process.applicationId`), сначала резолвит идентификатор; не-резолвящийся →
honest op-error строкой (существующий механизм возврата `string` = ошибка), НЕ бросает.
UUID_RE уже есть в файле. Резолв делается ОДНИМ SELECT перед основной записью, внутри той
же tenant-tx где возможно, иначе отдельным connect (как fetchRegistryDefCandidates).

## §1.4 — Дельта (в2): честный рапорт исходов ops

Проблема: changelog (`processToolCall`) и `finalText` (LLM) оптимистичны и пишутся ДО
исполнения. Решение — **пост-исполнительная сверка** в `assistant.ts` после цикла
`executeApprovedOpAsDraft`:
- собираем `opResults: { op, ok, error }[]` (уже есть `opErrors`, расширяем до
  per-op-результата с привязкой к описанию op'а);
- если есть хоть один провал → новая чистая функция
  `assistant-report.ts::buildHonestOpsReport(finalTextFromLlm, opResults)`:
  - НЕ echo-ит оптимистичный `finalText` как «✅» когда были провалы: при наличии
    провалов заголовок «Выполнено частично» и explicit список «✓ …» / «✗ … — <причина
    honest>»;
  - для дубль-op (executor вернул «slug already exists» / поле уже присутствует) помечает
    «уже было — изменений не потребовалось» (отличаем от «не создано»);
  - когда провалов нет — прежний текст сохраняется без изменений.
- Функция чистая (тестируема $0), не знает про кейс-строки (D-064). Строка причины —
  op-error из executor'а (наша, не сырое provider-тело).

## §1.5 — Дельта (г): гарант «ответ или честная ошибка в тред»

Два уровня:
1. **Аналитик**: `runAnalyst` оборачивает `ctx.llm.chat()` в try/catch → при ошибке
   `console.error(String(err))` + `text = canonicalizeLlmError(err)` (тот же helper и
   дисциплина, что у configurator, T-0600), `intent: "analyst"`. Больше не пробрасывает.
2. **Роут**: catch вокруг диспатча в `assistant.ts` (шаг 5) уже ловит
   classifyLlmUnavailability→503. Добавляем: для ЛЮБОЙ иной неперехваченной ошибки —
   вместо голого `throw err` (который даёт 500-конверт без сообщения в треде) — пишем
   assistant-сообщение с честным текстом в тред ЧЕРЕЗ новую чистую функцию
   `buildDispatchFailureReply()` (канонический русский текст без жаргона и без сырого
   err), затем всё равно `throw err` НЕ делаем — отвечаем 200 с этим сообщением ИЛИ
   (безопаснее для контракта) пишем сообщение в тред и потом отдаём тот же честный текст
   в ответе. Сырой err — только `console.error`. Так тред никогда не остаётся без реплики.

   Тонкость: LLM-unavailable путь (`respondLlmUnavailable`) уже пишет сообщение в тред и
   отдаёт 503 — его не трогаем (F6 T-0573). Новый путь — для НЕ-unavailable ошибок,
   которые раньше давали немой 500.

## §1.6 — Дельта (д): не вклеивать S3-телеметрию в user-facing контекст по умолчанию

`buildDraftContext` больше НЕ рендерит секции «Цикловое время»/«Разбивка по типу актора»
безусловно. Вводим `isProcessAnalyticsQuery(userText): boolean` (keyword-детектор:
цикл/время/узкое место/этап/процесс/bottleneck/cycle) в `assistant-analyst.ts`. Секции
телеметрии добавляются в контекст ТОЛЬКО когда детектор true. По общему запросу о данных
(«сколько поставщиков…») телеметрия не попадает в LLM и не предлагается пользователю.
Дайджест реестров (а) остаётся всегда — это данные пользователя, не внутренняя телеметрия.

## §2 — Отвергнутые альтернативы

- **Полный record-lister для (а) с пагинацией/tool-use**: раздувает задачу в отдельного
  агента (O1). Дайджест (счёт + примеры в правах) — минимальный честный шаг, покрывает
  живой факт «сколько заведено и как называется хотя бы один».
- **Owner-short-circuit внутри `canOperateSystemAgent`**: размывает чистый предикат над
  Grant[]; его контракт явно оставляет owner на caller'а. Чиним caller.
- **Гейт (б) через пересечение agent∩user для допуска**: именно оно «мигает». Для ДОПУСКА
  достаточно права пользователя (+ owner); agent∩user остаётся инвариантом ИСПОЛНЕНИЯ
  (executor draft-only, tenant-scoped). Иначе владелец зависит от scope seeded-агента —
  источник недетерминизма.
- **(в1) заставить LLM знать UUID (класть каталог в промпт)**: хрупко (токены, дрейф);
  резолв slug→UUID на стороне исполнителя надёжнее и уже в правах тенанта. Каталог в
  промпт — возможный FU для UX, но не обязателен для честности.
- **(в2) чинить changelog внутри `processToolCall`**: он ПУРЕ-планировщик, не знает
  исхода DB. Честный рапорт возможен только ПОСЛЕ исполнения — отсюда пост-сверка.
- **(г) просто добавить catch в analyst**: закрывает analyst-путь, но не путь роутера при
  иных сбоях. Нужны оба уровня, чтобы тред НИКОГДА не оставался немым.
- **(д) полностью убрать S3-загрузку**: теряем процессную аналитику для тех, кто её
  просит. Гейтим по интенту, а не удаляем.

## §3 — Контракты (файлы)

- `src/db/registry-digest-dao.ts` — новый: `loadReadableRegistryDigest`, тип
  `ReadableRegistryDigest`.
- `src/core/assistant-analyst.ts` — `AnalystPorts.loadRegistryDigest?`; `ReportDraft.registryDigest`;
  `buildDraftContext` (секция реестров + честная пустота + телеметрия за интент-флагом);
  `isProcessAnalyticsQuery`; try/catch вокруг `ctx.llm.chat()` + `canonicalizeLlmError`.
- `src/core/assistant-intent.ts` — `HandlerContext.isTenantOwner?: () => Promise<boolean>`.
- `src/core/assistant-configurator.ts` — `hasAuthoringDraftGrant` owner-short-circuit +
  резолв на userGrants.
- `src/core/assistant-report.ts` — новый чистый модуль: `buildHonestOpsReport`,
  `buildDispatchFailureReply` (+ типы `OpResult`).
- `src/http/assistant.ts` — `resolveRegistryDefId`/`resolveApplicationId`; slug-резолв в
  `executeApprovedOpAsDraft`; пост-исполнительная сверка через `buildHonestOpsReport`;
  диспатч-catch пишет честную ошибку в тред; заполняет `ctx.isTenantOwner`.
- `src/server.ts` — `setAnalystPorts({ loadRegistryDigest })`.
- Тесты: `src/__tests__/assistant-analyst-digest.test.ts` (AC-1/2/10),
  `src/__tests__/assistant-configurator-owner.test.ts` (AC-4),
  `src/__tests__/assistant-report.test.ts` (AC-7/9),
  расширение `assistant-analyst`/`assistant-configurator` unit (AC-8),
  `ci/checks/db/registry-digest.test.ts` (AC-3),
  `ci/checks/db/configurator-owner-gate.test.ts` (AC-5),
  `ci/checks/db/edit-jsonschema-slug-resolve.test.ts` (AC-6).

## §4 — Fitness-функции

см. contract JSON (FF-1..FF-13).

## §5 — Эскалация

Нет. Все пять — коррекция дефектов честности в существующих контрактах (READ-PDP,
owner-резолвер, draft-executor, T-0573 honest-путь), не новая архитектура и не
необратимое/денежное/секретное решение. Owner-short-circuit — применение уже
задокументированного контракта `canOperateSystemAgent`, не расширение прав.
