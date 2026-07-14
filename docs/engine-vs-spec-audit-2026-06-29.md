# Аудит: движок процессов vs спека — карта генеральности (2026-06-29)

> READ-ONLY аудит. Источник истины: `docs/specs/process-element-runtime.spec.md` (§3.1 набор v1, §3.7 настройка элементов).
> Сопутствующие: `process-execution-model.spec.md` (D4 agentTask), `forms-data-contract-foundation.spec.md`.
> Ветка кода: `dev` @ `7acfbc3` (T-0524 смержен).
>
> **ВАЖНЫЙ дисклеймер о «доказано»**: всё ниже — code-review, НЕ live-прогон. Юнит с замоканным Flowable
> НЕ доказывает движковое поведение. Полное доказательство = deploy-acceptance на живом Flowable (сейчас
> server-gated, недоступно). Колонка «доказано e2e» оценена консервативно: «частично» означает «код есть,
> но на живом стенде не доказано».

## Скоркард

| Элемент | Авторинг (UI→BPMN) | Линтер/публикация | Исполнение движком | Доказано e2e | Класс |
|---|---|---|---|---|---|
| start / end | seam (триггер не настраивается из UI) | проходит | generic (Flowable native, проекция `process.started`/`done`) | частично (не на live) | **generic-работает** |
| userTask → инбокс | да (роль+форма+поля) | да | generic: approve→step-applier→outbox→completeTask | частично (s9 field-accept зелёный) | **generic-работает** |
| exclusiveGateway + условие | да (`gateway-condition-panel.jsx`, `choros:routingVar`) | да (`gateway_rule_mismatch`) | **generic** (T-0524: `evaluateGatewayAtTriage`, ТЭЛ-константы `@deprecated`/не читаются) | НЕ на live | **generic-работает** |
| sequenceFlow + условие | да (через gateway-panel, native `conditionExpression`) | да (в gateway-check) | generic (Flowable EL eval + инъекция переменной на triage-шве) | НЕ на live | **generic-работает** |
| parallelGateway (AND) | нет (структурный) | да (`parallel_gateway_imbalance`) | проекция конкурентных токенов есть (`concurrentSteps`); сам split/join — Flowable native | НЕ на live | **частично (проекция on-read, не доказана)** |
| lane → роль | да (swimlane → `lane-role-mapper`→`candidateGroups`) | candidategroups-slug-линтер | generic: инбокс резолвит холдеров роли + fallback→owner (`resolveExecutorFallbackBatch`) | частично | **generic-работает** |
| timer/boundary + эскалация | да (`timer-deadline-panel.jsx`→`timer-escalation-mapper`) | да (`timer_malformed`) | **reconcile-on-read**: таймер у Flowable, эскалация всплывает в инбоксе ТОЛЬКО при чтении; нет фонового воркера | нет | **частично (нет фонового firing)** |
| agentTask | да (`agent-task-panel.jsx`→`agent-task-external-mapper`) | да (`agent_task_incoherent`) | петля ЖИВАЯ (`startAgentDispatchLoop` в `main.ts`), но `liveEnabled:false`+`dormantLlmPort` → **день-1 каждый job → defer человеку** | нет (LLM dormant) | **частично (петля жива, мотор dormant)** |
| message/signal catch | контракт read/write есть (`element-config-contract.js`), отдельной jsx-панели нет | да (`message_event_incoherent`, требует таймаут) | ожидание проецируется on-read (`getMessageCatchWaits`); **доставка `deliverMessageEnvelope` — library-only, НЕТ HTTP-роута** | нет | **частично (catch on-read; доставка не вызвана)** |
| message/signal throw | контракт есть | — | grant-модель (`authorizeThrowMessage`/T-0034); **реальной отправки нет** (connector-driver = Stage-2) | нет | **dormant / Stage-2 seam** |
| subprocess / цикл / инклюзивный | — | отлетает на publish | — | — | **не-в-v1 (осознанно)** |

---

## По элементам

### start / end — generic-работает
- **Есть**: `process-start.ts` стартует любой ключ процесса, atomic `process.started`-проекция; end — Flowable native, инстанс→`done` в проекции; auto-drive `task-submit` (T-0443).
- **Чего нет**: настройка триггера start из UI (on_create/launcher/manual) — seam, не реализована (§3.7 строка start).
- **Офлайн**: контракт триггера start (типизированный конфиг + запись в BPMN) — pure.
- **Server-gated**: подтверждение полного шва на live.

### userTask — generic-работает
- **Есть**: инбокс generic, approve→`step-applier` пишет result-entity, `task_completed` в outbox, `completeTask` через bridge-dispatcher (живой loop). Роль/форма/поля настраиваются.
- **Чего нет**: ничего критичного для генеральности (s9 приёмка зелёная по полям).
- **Server-gated**: полный шов approve→запись доказывается только на live (урок s38).

### exclusiveGateway + sequenceFlow + условие — generic-работает (ПОДТВЕРЖДЕНО T-0524)
- **Есть**: панель `gateway-condition-panel.jsx` пишет `choros:routingVar` + `conditionExpression` для любого процесса. Исполнение: `makeExternalTaskDeliver` на triage-шве зовёт `evaluateGatewayAtTriage` (`dmn-gateway.ts`), мёржит ВСЕ авторские routing-outcomes под их авторскими именами из `dmn_rule_table`. ТЭЛ-константы (`TEL_GATEWAY_VAR`/`TEL_APPROVAL_THRESHOLD`) помечены `@deprecated` и **не читаются** движком (подтверждено grep). Unscoped name-collision = fail-CLOSED (`dropAmbiguousOutcomes`, commit 9e8f183) → BPMN default flow, никогда не «неверный маршрут».
- **Чего нет**: pre-compute и late-compute опираются на authored `dmn_rule_table`; без авторской таблицы → default flow (честно).
- **Server-gated**: фактическое исполнение токенов/EL Flowable — только на live.

### parallelGateway — частично
- **Есть**: линтер `parallel_gateway_imbalance` (balanced split/join, no-dangling). Проекция конкурентных веток: `InstanceProjection.concurrentSteps` (несколько `process.next_task` строк = ветви AND-split). Сам split/join — Flowable native.
- **Чего нет**: проекция конкурентных шагов наполняется из audit-событий on-read; не доказана на живом многотокенном инстансе. Per-gateway balance ≠ whole-graph reachability (осознанно вне v1).
- **Server-gated**: доказательство, что N токенов реально активны одновременно — live.

### lane → роль — generic-работает
- **Есть**: swimlane на канвасе → `mapLanesToCandidateGroups` стампит `flowable:candidateGroups="<role-slug>"` (в publish-конвейере `process-defs.ts`). Рантайм: инбокс резолвит холдеров роли из живой оргструктуры (`getHoldersForRole`) + fallback→owner (`resolveExecutorFallbackBatch`, F7). Явный author-set candidateGroups сохраняется (lane только заполняет пробел).
- **Чего нет**: substitution-порт DORMANT (код-ветка в `executor-resolver` есть, в проде порт undefined; T-0053). Канонический `resolveExecutor()` напрямую не вызывается — прод использует батч-вариант (та же логика).
- **Офлайн**: вайринг substitution-порта (slug↔employee.id).

### timer/boundary + эскалация — частично (НЕТ фонового firing)
- **Есть**: панель `timer-deadline-panel.jsx`, `timer-escalation-mapper` стампит `<timeDuration>`/`<timeDate>` + `candidateGroups` эскалации; линтер `timer_malformed`. Проекция: `reconcileInstanceTimers` (`process-projection.ts`) спрашивает Flowable `getActiveUserTasks` и всплывает эскалацию.
- **Чего нет (КРИТИЧНО)**: реконсиляция вызывается **ТОЛЬКО при чтении инбокса** (`inbox.ts:822`). Нет фонового таймер-воркера. `AppTimer` (`timerTypes.ts`)/`slaState` (`sla.ts`) = типы + чистый расчёт визуального состояния, **firing-петли нет**. Срок истёк → эскалация всплывёт, лишь когда кто-то откроет инбокс.
- **Офлайн**: ничего из этого не делает таймер «активным» без рантайма; firing требует фонового цикла (как agent-dispatch-loop / lifecycle-bridge).
- **Server-gated**: что Flowable реально маршрутизирует токен по таймеру — live.

### agentTask — частично (петля жива, мотор dormant день-1)
- **Есть**: панель `agent-task-panel.jsx` (агент+порог+промт+r/w поля+fallback); `mapAgentTaskToExternal` стампит `flowable:type=external` + `flowable:topic=agent-step` в publish; линтер `agent_task_incoherent` + DB-гейт неразрешённого `agentRef`→422. **Петля ЖИВАЯ**: `startAgentDispatchLoop` поднят в `main.ts` рядом с lifecycle-bridge; `PostgresAgentJobFetcher` лочит agent-step jobs пер-тенант (явный `tenant_id=$N` под BYPASSRLS); `runAgentDispatchOnce`: assemble→motor→apply (proceed/defer/fail-closed) атомарно.
- **Чего нет (КРИТИЧНО)**: прод-конфиг `runDeps: { llm: dormantLlmPort, liveEnabled: false }` → мотор **дефёрит КАЖДЫЙ job человеку** (нет живого LLM). То есть петля крутится и закрывает шаг как defer→инбокс, но автономного «закрыл сам в пределах autonomy_threshold» НЕ происходит день-1. Включается флипом конфига (BYO LLM key + liveEnabled), без кода.
- **B/T-0328**: worker-auth для диспетчера — отложен (не блокер исполнения, петля лочит jobs инъекционно).
- **Server-gated**: автономное закрытие шага агентом — требует live LLM + Flowable.

### message/signal — частично (catch on-read) + dormant (throw)
- **Есть (catch)**: чистый коррелятор `message-correlation.ts` (envelope-валидация, tenant-fail-closed, broadcast vs point); линтер требует таймаут (R3). Ожидание проецируется on-read: `getMessageCatchWaits`→`process.next_task(messageCatch)` «Ожидает сообщения».
- **Чего нет (КРИТИЧНО)**: `deliverMessageEnvelope` существует, но **НЕТ HTTP-роута**, который его зовёт — доставка входящего сообщения в прод не подключена (нет `/api/message`). Внешний участник (T-0122, токен-поверхность) и внутренний сигнал — источники по спеке, но не сведены к доставке. Throw: только grant-модель (`authorizeThrowMessage`), **реальной отправки нет** — connector-driver Stage-2 (`connector.ts` — CRUD-only, `ConnectorDriverPort` без имплементации).
- **Офлайн**: HTTP-роут ingest сообщения (`POST /api/message` → `deliverMessageEnvelope`) — pure-вайринг + auth-гейт, доказывается юнитом частично; внутренний сигнал (смена статуса записи → envelope) — pure.
- **Server-gated**: что Flowable реально снимает токен с парковки по `correlateMessage` — live.

### subprocess / цикл / инклюзивный — не-в-v1
- Осознанно отложены (§3.1). Палитра занулена (T-0098/T-0375). Линтер отбивает на publish.

---

## Блокеры сквозного прогона (из спеки §3.8)

- **B19 (ключ процесса) — ЗАКРЫТ**: `generateUniqueProcessKey` (`slugify-process-key.ts`), `processKey` опционален в `POST /api/process-defs`, автоген из имени (T-0377, кириллица-aware).
- **B16 (process-start auth) — ЧАСТИЧНО**: `process-start.ts` всё ещё читает `x-dev-user` header (не mode-aware KC-резолвер как s39-роуты). Тенант резолвится из актора (cross-tenant отбит), но аутентификация — старая dev-поверхность. Для прод-логина нужен mode-aware резолвер.

---

## Приоритет: ОФЛАЙН-buildable (двигают генеральность БЕЗ сервера)

Ранжировано по тому, насколько закрывает «движок исполняет ЛЮБОЙ собранный процесс»:

1. **Таймер-firing воркер (фоновый цикл)** — самый большой разрыв «авторинг vs исполнение». Сейчас эскалация всплывает лишь on-read. Построить фоновую петлю (образец `agent-dispatch-loop`/`lifecycle-bridge`): опрос Flowable на сработавшие таймеры/новые эскалац-задачи → проекция в инбокс без чтения. Pure-логику (`AppTimer`/`slaState`) уже есть — нужен dispatcher + юнит. **Без live-стенда строится и юнит-доказывается; firing против Flowable добивается на сервере.**
2. **HTTP-роут ingest сообщения** (`POST /api/message` → `deliverMessageEnvelope`) + внутренний сигнал (смена статуса записи → envelope через `correlateEnvelope`). Сейчас catch ждёт, но доставлять нечем. Коррелятор pure и готов — нужен роут + auth-гейт. Закрывает половину message/signal генерально, офлайн-юнитом.
3. **B16 mode-aware actor-резолвер на process-start** (по образцу s39-роутов) — снимает старую x-dev-user поверхность; pure-вайринг резолвера, доказывается без Flowable.
4. **Subscription-вайринг substitution-порта в `executor-resolver`** (T-0053) — оживляет ветку замещения (сейчас порт undefined в проде). Pure-DAO + юнит.
5. **Триггер start из UI** (on_create/launcher/manual) — типизированный конфиг элемента start + запись в BPMN (§3.7 seam). Pure-контракт + панель, без сервера.

## Требует СЕРВЕРА для доказательства/доводки

- **agentTask автономное закрытие** — нужен live LLM (BYO key) + Flowable; код-петля готова, мотор dormant по конфигу. Доводка = флип `liveEnabled` + проверка автономного proceed на live.
- **Любое реальное исполнение токенов**: exclusiveGateway-маршрутизация, parallelGateway конкурентность, таймер-firing, `correlateMessage` снятие парковки — всё подтверждается ТОЛЬКО deploy-acceptance на живом Flowable. Сейчас код generic, но e2e НЕ доказано.
- **message throw реальная отправка** — connector-driver Stage-2 (per-first-client), требует внешней системы.
- **B16 полный логин-шов** — Keycloak на стенде.

---

## Итог (честно)

Движок **архитектурно generic** и **де-хардкоден от ТЭЛ** (T-0524 подтверждён в коде: ТЭЛ-константы deprecated/не читаются). Publish-конвейер прогоняет lane/timer/agent-трансформы для любого процесса, линтер покрывает весь набор v1 семью always-on проверками.

Но «исполняет ЛЮБОЙ процесс» имеет **два честных провала генеральности, строимых офлайн**: (1) **таймер/эскалация** — только reconcile-on-read, нет фонового firing; (2) **message доставка** — catch проецируется, но `deliverMessageEnvelope` без HTTP-роута (входящего сообщения нечем доставить). agentTask — петля жива, но мотор **dormant день-1** (defer-всё, нет живого LLM). И **ни один элемент не доказан e2e на живом Flowable** — это server-gated и сейчас недоступно.
