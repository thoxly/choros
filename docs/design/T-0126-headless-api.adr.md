# ADR · T-0126 — Программная поверхность (headless API): запрос из чужого приложения → ответ агента

**Status:** ready (no founder gate for the DESIGN scope — направление задано фаундером в gap-map §2/§5; единственные развилки уровня фаундера — внешняя экспозиция/упаковка/тарификация headless-доступа и rate-limit-бюджет — вынесены §10/§8 как deploy-time/продуктовые параметры, не блокируют impl)
**Phase:** DESIGN (architect) · **Date:** 2026-06-14
**Task:** T-0126 (product=choros, type=design, prio 55; deps: T-0123)
**Grounding consumed:**
- `playbooks/choros-reference-process-tel.md` §5 — банк-кейс: клиент банка в **своём** приложении спрашивает текстом «сколько я потратил за год на каршеринг» → запрос летит в нашу систему → ответ агента (одна цифра / сумма+декомпозиция, как настроено клиентом-владельцем агента). Примитивы: программная поверхность (headless API) + настраиваемая инструкция агента (компетентностный слой). Сдвиг позиционирования: Choros как **embedded-рантайм**.
- `playbooks/choros-product-gap-map.md` §2 (capability envelope, строка «Внешняя программная поверхность (headless API)» 🔴) + §2 несущий принцип «не модули по классам, а примитивы ядра» + §3а («один механизм прав: внешняя поверхность T-0122 и headless API T-0126 — тот же PDP»).

**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant-таблица: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)`, DML только `choros_app`, занесение в `known_tenant_tables.txt`.
- `docs/design/T-0014-registry-model.adr.md` / `docs/design/T-0015-object-handles.adr.md` — `record (tenant_id, id)` = grant-target; непрозрачные ручки: ответ/контекст несут handle, не сырые данные объекта.
- `docs/design/T-0018-grant-authority.adr.md` §2 — единая grant-алгебра; «нет второго permission-механизма». Право чужого приложения вызвать агента и право самого агента — grant-строки, не новый ACL.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чокпойнт `grant-resolver` (`resolveFor`/`makeGrantResolver`), action-time, fail-closed; reason-union `"no_grant"|"cross_tenant"|"not_found"|"no_effect_grant"|"sod_violation"`. **Единственный резолвер** — `ci/checks/single-resolver.sh` запрещает второй PDP-edge.
- `docs/design/T-0016-audit-floor.adr.md` — append-only per-tenant hash-chained `audit_event`; новые события = строки (open vocab `type`), не таблицы; единственный canonical `appendAuditEvent`.
- `docs/design/T-0019-actor-event-ledger.adr.md` — typed `actor_event` с `object_ref`; ledger исполнения агента.
- `docs/design/T-0060-worker-endpoint-auth.adr.md` — `CHOROS_AUTH_MODE` seam (`dev` x-dev-user / `keycloak` Bearer JWT), `withAuth(handler)`-декоратор, `AuthContext {sub, preferredUsername, actorType: 'human'|'agent'}`; единственная точка ветвления `authenticate(req)` (`src/http/auth.ts`). Service-account (agent) токен Keycloak несёт `actor_type='agent'`.
- `docs/design/T-0024` invoke-grant + `src/http/invoke.ts` — `POST /api/invoke/request|command`: `coversInvoke()` композирует T-0018 примитивы (`isNarrowerOrEqual`+`isEffective`); INSERT `invoke_proposal` + `invoke.*` audit в одной `withTenantTx`; fail-closed 403; **dispatch = stub day-1**.
- `docs/design/T-0025-byo-llm-secret-custody.adr.md` — RL-3: платформа хранит **handle**, не сырой секрет; `validateSecretHandleShape`/`redactHandle`/`SecretResolverPort` (`src/core/secret-handle-validator.ts`).
- `docs/design/T-0123-agent-competency-layer.adr.md` + `src/core/agent-instruction.ts` — `agent_instruction` (миграция 057, tenant-таблица): `instructionText`, `answerForm` (короткий машинный код формы ответа — **именно «сумма» vs «сумма+декомпозиция» банк-кейса**), `instructionMeta`; tier `draft`|`published` (REUSE T-0087), published-locked, **runtime-dormant** (хранится, ядром ещё не исполняется до разморозки рантайма E5.6+).
- `docs/design/T-0122-external-participant.adr.md` — **родственный, но другой** примитив «внешняя поверхность»: анонимный токенизированный доступ человека-посетителя к узкому срезу записи (download/verify/upload); токен → производный ограниченный грант на синтетическую `is_external`-роль; tenant детерминируется токеном. T-0126 переиспользует **тот же** PDP/audit/tenant-вывод-из-секрета паттерн, но принципал — **аутентифицированное чужое приложение как агент/сервис-аккаунт**, а действие — **вызов агента** (не чтение среза записи).
- `docs/design/T-0033-data-classification.adr.md` — `DataClass = "public"|"internal"|"confidential"|"restricted"` (закрытая ось, импорт из `src/core/data-classification.ts`).
- `docs/design/T-0041-egress-policy.adr.md` — egress-allowlist по DataClass; тело ответа уходит наружу (в чужое приложение) → egress-граница.
- `docs/design/T-0139-reasoning-trace.adr.md` — reasoning-trace агента = red-line объяснимости (D-139): рассуждение пишется в `audit_event` под отдельным `data_class`/маскированием; **наружу (в ответ чужому приложению) сырой reasoning не утекает**.
- `docs/design/T-0053-postgres-compose.adr.md` — single-Postgres substrate (нет внешней очереди).

**Связанные задачи (инварианты):**
- **T-0024 invoke** — headless-вызов = **тот же** invoke-механизм (caller → agent), но точка входа — внешний HTTP-запрос с machine-identity, а не внутренний UI с x-dev-user. ADR **extends, не дублирует**: новый endpoint `POST /api/headless/agent-query` маппится на тот же `coversInvoke`/invoke-grant.
- **T-0123 agent-instruction** — компетентностный слой определяет **форму ответа** агента (`answer_form`); headless-ответ обязан её уважать (банк-кейс). Рантайм агента **dormant** (T-0123) ⇒ **сам генеративный ответ — Stage-2 за разморозкой**; day-1 контракт+аудит+авторизация поверхности, response-тело = детерминированный stub/echo по контракту (как T-0024 dispatch-stub).
- **T-0060 worker-auth** — headless caller аутентифицируется **тем же** Keycloak service-account/JWT seam (`CHOROS_AUTH_MODE`), не новым credential-механизмом.
- **T-0122 external-surface** — анонимный человеческий канал; headless API — машинный аутентифицированный канал. Один envelope, два принципала; ADR §2.7 проводит границу.

> Это ADR **design-only**. Choros имеет Postgres-в-compose (T-0053/T-0114), живой invoke-surface (T-0024, `src/http/invoke.ts`), auth-seam (T-0060, `src/http/auth.ts`), компетентностный слой (T-0123, `src/core/agent-instruction.ts`, миграция 057). Сами TS-роуты headless-поверхности, DDL новой tenant-таблицы маппинга, service-account-резолв в `actor_type='agent'`-принципал ядра и реальный agent-runtime, генерирующий ответ — **последующие impl-задачи Stage-2**, не здесь. **IMPL — Stage-2** (за разморозкой agent-runtime E5.6+, D-139-санкцией на reasoning, продуктовым решением об экспозиции §10). Каждая fitness-функция несёт конкретный `ci_check` + `gating`-ноту (**static-now** = лайнт/тип-чек/юнит в `npm run ci` после impl; **live-impl** = проба, авторённая позже, активируемая при Postgres). Этот ADR — единый источник полей/типов/контрактов для `coder` и `tester`.

---

## 1. Context

Фаундер зафиксировал (gap-map §5, банк-кейс) **класс задач** вне маршрутного процесса: чужое
приложение (банковский мобильный клиент) шлёт **текстовый запрос** в Choros, агент-сотрудник tenant
(настроенный **клиентом-владельцем**: что и в какой форме отвечать — «просто сумма» vs «сумма +
декомпозиция по кварталам») возвращает **ответ**, который чужое приложение показывает своему
пользователю. Это сдвигает позиционирование: Choros — не только UI-продукт, но и **embedded-рантайм**,
вызываемый из чужого кода. Тот же примитив покрывает «продукт настраиваем чужими агентами» (MCP-слой
доков, gap-map §3а) и QR-валидацию на сайте клиента (последняя — частично T-0122).

Несущий принцип (gap-map §2): **не новый «класс», а композиция примитивов ядра**. Headless API
обязан собраться из УЖЕ существующих: auth-seam (T-0060), invoke (T-0024), единого PDP (T-0021),
компетентностного слоя (T-0123), tenancy/audit/egress (T-0013/16/41). Дизайн **негативен** не меньше,
чем позитивен (как T-0021/T-0122): сделать неправильное **структурно невозможным** —
- нет второго credential-механизма (auth через T-0060 Keycloak seam);
- нет второго PDP (авторизация и поверхности, и агента — через `resolveFor`/`coversInvoke`, T-0021/T-0018 — `single-resolver.sh`);
- нет второго custody (если headless-вход несёт client-secret — RL-3 handle, T-0025);
- tenant не выбирается извне (детерминируется принципалом/токеном — tenancy §9 п.7 fail-closed);
- каждый headless-вызов (успех И отказ) аудитируется (T-0016);
- сырой reasoning агента не покидает периметр (D-139/T-0139) — наружу идёт только ответ-форма, заданная `answer_form`.

Внутри-DESIGN развилки (зона архитектора), которые этот ADR обязан решить с rejected-alternatives:
**(а)** принципал чужого приложения — service-account-агент vs scoped API-token vs OAuth-client;
**(б)** где сидит headless-вход относительно существующего invoke-surface (extend `/api/invoke` vs новый `/api/headless/*` endpoint);
**(в)** как scope вызова привязан к запросу и проходит через единый PDP (без bypass);
**(г)** граница embedded-runtime: что исполняется client-side vs в Choros, как изолируется tenant, как ответ проходит egress;
**(д)** как `answer_form` (T-0123) управляет формой ответа, не давая утечь reasoning (D-139).

---

## 2. Decision

**Headless API моделируется ОДНОЙ tenant-таблицей маппинга `headless_endpoint` + переиспользованием
существующих invoke-механики (T-0024), auth-seam (T-0060), единого PDP (T-0021/T-0018) и
компетентностного слоя (T-0123). Принципал чужого приложения = аутентифицированный Keycloak
service-account с `actor_type='agent'` (T-0060), проецируемый ядром в обычный grant-субъект; запрос
маппится на invoke-вызов целевого агента; авторизация — `coversInvoke`/`resolveFor` (тот же PDP, без
bypass); ответ агента ограничен формой `answer_form` (T-0123) и проходит egress-границу по DataClass
(T-0041); сырой reasoning наружу не уходит (D-139). Ни одного нового механизма прав, credential-store
или PDP-edge.**

### 2.1 Принципал чужого приложения — Keycloak service-account как `actor_type='agent'` (РЕШЕНИЕ §3-а, FR-1)

Чужое приложение аутентифицируется **существующим** auth-seam T-0060 — **не новым credential-механизмом**:

- **Идентичность.** Чужое приложение держит **Keycloak service-account client** (client-credentials
  grant), выпускающий JWT с `actor_type='agent'` (T-0060 `AuthContext.actorType`). `withAuth(handler)`
  (T-0060) валидирует Bearer-JWT против Keycloak JWKS; `CHOROS_AUTH_MODE=keycloak` — единственная точка
  ветвления (`auth.ts`/AC-17 T-0060). В `dev`-режиме — `x-dev-user`-стаб, как у всего ядра. **Нет
  собственного API-key-store, нет своего HMAC-подписания, нет параллельного OAuth-сервера** — Keycloak
  есть identity-provider и для людей, и для агентов, и для чужих приложений (один realm, разные clients).
- **Проекция в субъект ядра.** Аутентифицированный principal (`AuthContext.sub`) проецируется в
  `ResolveSubject {tenantId, subjectId}` (T-0015 identity-only opaque string) **точно как** внутренний
  invoke-caller (`src/http/invoke.ts:extractActor`→`loadCallerInvokeGrants`). Service-account чужого
  приложения = носитель invoke-грантов на целевого агента (как любой caller). **Нет ветки «это чужое
  приложение?»** в PDP — субъект непрозрачен (T-0021 FF-R5/R6, как T-0122 §2.3 для external-роли).
- **Tenant детерминируется принципалом, не запросом (NF-2, non-negotiable).** `tenant_id` берётся из
  привязки service-account-клиента к tenant (Keycloak realm/client→tenant mapping), а **не** из тела/
  параметра запроса. Headless-endpoint **не принимает** tenant-параметр. `SET LOCAL choros.tenant_id`
  ставится ДО любого прикладного доступа (tenancy §9 п.7 fail-closed). Cross-tenant неконструируем
  (как T-0122 §2.4 для токена — здесь tenant из аутентифицированного клиента, не из открытого поля).

**Опциональный client-secret в запросе (если чужое приложение проксирует секрет конечного
пользователя):** хранится/резолвится как **RL-3 handle** (T-0025 `validateSecretHandleShape`/
`redactHandle`/`SecretResolverPort`) — сырой секрет в столбец/лог/audit/ответ структурно непроходим.
Day-1 этого не требуется (client-credentials достаточно); seam зафиксирован §8.

### 2.2 Точка входа — НОВЫЙ endpoint `POST /api/headless/agent-query`, переиспользующий invoke-механику (РЕШЕНИЕ §3-б, FR-2)

**Развилка (б) решена: новый endpoint, общая внутренняя механика — НЕ перегрузка `/api/invoke/*`.**

- **`POST /api/headless/agent-query`** — внешняя точка входа для чужого приложения. Обёрнута
  `withAuth` (T-0060). Тело: `{ endpoint_key: string, query: string, context?: object }`.
  `endpoint_key` — стабильный публичный идентификатор настроенной headless-точки (см. §2.3), **не**
  сырой `agent_id` (чужое приложение не знает внутренних UUID агентов; endpoint_key — публичный
  контракт, разворачивается в `agent_id` внутри tenant-контекста).
- **Внутри** — маппинг на **тот же** invoke-путь T-0024: разворот `endpoint_key`→`target_agent_id`,
  загрузка role-assignment целевого агента, проверка покрывающего invoke-гранта через
  **`coversInvoke()`** (`src/http/invoke.ts`, композиция T-0018 `isNarrowerOrEqual`+`isEffective`),
  fail-closed 403 без строки/частичного аудита. **Нет второй authority-логики** — headless-роут зовёт
  ту же covering-предикат-функцию, что и `/api/invoke/command`.
- **Почему не перегрузка `/api/invoke`:** invoke-surface T-0024 — **внутренний** (x-dev-user/UI,
  принимает сырой `target_agent_id`, возвращает `invoke_proposal`/`invocation_id`). Headless —
  **внешний** (machine-JWT, публичный `endpoint_key`, возвращает **ответ агента** конечному
  приложению, не proposal-id). Разные контракты ответа, разные аудиторы (`headless.*` vs `invoke.*`),
  разная egress-семантика (наружу). Слить их = спутать внутренний invoke и внешний embedded-вызов
  (§3 rejected). Общая **механика** (covering-grant, tenant-tx, audit-seam) переиспользуется; различны
  только адаптер-вход и формирование ответа.

### 2.3 Конфигурация headless-точки — tenant-таблица `headless_endpoint` (FR-3, T-0013-контракт verbatim)

Клиент-владелец заранее **настраивает** headless-точку (как настраивает агента — gap-map §5 «клиент
сам настраивает, как агент отвечает»). Одна tenant-таблица:

**`headless_endpoint`** (T-0013 tenant-таблица): `(tenant_id, id)` PK; `endpoint_key text NOT NULL`
(публичный стабильный ключ, UNIQUE `(tenant_id, endpoint_key)`); `target_agent_id uuid NOT NULL`
(FK `(tenant_id, target_agent_id)→agent_card(tenant_id, employee_id)` — целевой агент-сотрудник);
`call_scope jsonb NOT NULL` (**срез прав вызова** — `ScopeElement`/`ResourceFacet` T-0018, против
которого проверяется и сужается каждый headless-запрос, см. §2.4); `max_input_class text NOT NULL
DEFAULT 'public'` (потолок DataClass входного `query`/`context` — что чужому приложению позволено
прислать); `response_class text NOT NULL DEFAULT 'public'` (декларированный DataClass ответа для
egress, §2.6); `is_enabled boolean NOT NULL DEFAULT false` (точку можно выключить, не стирая конфиг);
`created_by/at`, `updated_by/at`. **Управление** — REST `GET/PUT /api/headless-endpoints` с grant
`mgmt_object:headless_endpoint`/`operation:update` через тот же PDP T-0021 (**нет нового механизма прав**).

Обычная T-0013 tenant-таблица (FORCE RLS, default-DENY, `tenant_id`-leading, `choros_app` DML-only),
заносится в `known_tenant_tables.txt` (anti-decorative strict-чек упадёт на таблице без записи).
**Endpoint — конфигурация (кто/какой агент/какой scope/какая форма), не код per-кейс:** банк-кейс и
любой будущий headless-кейс — наборы `call_scope`/`response_class` над одним примитивом.

### 2.4 Call-scope rights — через ЕДИНЫЙ PDP, без bypass (РЕШЕНИЕ §3-в, несущий инвариант NF-1, FR-4)

**Авторитет headless-вызова течёт через тот же PDP `resolveFor`/`coversInvoke` (T-0021/T-0018) — без
второго резолвера, без обхода.** Два уровня, оба — существующий PDP:

1. **Право чужого приложения вызвать агента** (invoke-уровень): covering invoke-grant принципала
   service-account на роль целевого агента — `coversInvoke(grant, targetRoleId, targetOrgScope, now,
   oracle)` (`src/http/invoke.ts`), композиция T-0018. Нет гранта → 403 fail-closed, ноль строк/аудита
   (как T-0024 NF-4).
2. **Что сам агент может сделать, отвечая** (data-access-уровень): агент при формировании ответа
   читает данные **только** через `resolveFor(handle, agentSubject, op)` (T-0021), action-time,
   fail-closed, с `projectFields`-проекцией (агент видит ровно свой срез — human≡agent≡external, один
   путь). `headless_endpoint.call_scope` — **аргумент сужения** (как `external_surface.facet` в T-0122
   §2.3): запрос исполняется в `call_scope ⊓ (гранты агента)`, не шире. **`call_scope` — не
   параллельный authority-store**, а сужающий вход в тот же PDP (FF-NOACL — нет `headless_acl`/
   `endpoint_rights`-полей в обход grant-таблицы; «что можно» по-прежнему вычисляет только PDP из
   grant-строк).

Scope привязан к запросу так: headless-роут резолвит `endpoint_key`→`{target_agent_id, call_scope}`,
формирует `InvokeContext`/`GuardContext` (T-0021 опциональные args резолвера) с сужением `call_scope`,
и **весь** доступ агента к данным проходит `resolveFor` под tenant-контекстом этого вызова. Нет пути
данных мимо PDP (FF-HEADLESS-SINGLE-PDP, охраняется `single-resolver.sh` + grep).

### 2.5 Pipeline запрос → ответ агента (FR-5)

Один поток, без второй authority/очереди:

1. **Вход.** Чужое приложение → `POST /api/headless/agent-query` с Bearer-JWT (service-account) +
   `{endpoint_key, query, context}`. `withAuth` валидирует JWT (T-0060), извлекает principal+tenant.
2. **Tenant-контекст fail-closed.** `SET LOCAL choros.tenant_id = <tenant принципала>` ДО доступа
   (NF-2). Всё дальше — под RLS этого tenant в одной `withTenantTx` (как `invoke.ts`).
3. **Разворот точки.** `endpoint_key`→`headless_endpoint`-строка; `is_enabled=false` → 403/404
   (выключена). Валидация `query`/`context` DataClass ≤ `max_input_class` (вход не выше потолка).
4. **Авторизация вызова.** `coversInvoke` (invoke-grant принципала на роль агента). Нет → 403
   fail-closed (ноль аудита успеха, **один** `headless.denied`-audit, §2.8).
5. **Исполнение агента (Stage-2 за разморозкой рантайма T-0123/E5.6).** Целевой агент с его
   `agent_instruction` (T-0123: `instruction_text` + **`answer_form`**) формирует ответ; весь
   data-access — через `resolveFor` под `call_scope`-сужением (§2.4). **Форма ответа** определяется
   `answer_form` (банк-кейс: `sum` → одна цифра; `sum_by_quarter` → сумма+декомпозиция). **Day-1
   (рантайм dormant):** ответ-тело = детерминированный stub по контракту (как T-0024 dispatch-stub) —
   поверхность/авторизация/аудит/egress тестируемы без живого LLM.
6. **Egress-граница.** Ответ-тело фильтруется/проверяется против `response_class` (≤ декларированного)
   под политику T-0041; сырой reasoning агента **не** в теле ответа (D-139, §2.6). Ответ возвращается
   чужому приложению (200 `{ answer, answer_form, ... }`).
7. **Аудит.** `headless.request` (успех) / `headless.denied` (отказ) — строки `audit_event` (T-0016),
   §2.8. Если исполнение агента породило data-access — это **обычные** `actor_event` агента (T-0019),
   не дублируются внутри headless-слоя.

### 2.6 Ответ: `answer_form` управляет формой, reasoning не утекает (РЕШЕНИЕ §3-д, FR-6, D-139 red-line)

- **Форма ответа = `agent_instruction.answer_form` (T-0123).** Клиент-владелец настраивает форму
  (банк-кейс: `sum` vs `sum_by_quarter`) через компетентностный слой — **тот же** примитив, не новый.
  Headless-ответ обязан её уважать: тело ответа структурируется по `answer_form`, агент не вольничает
  сверх настроенной формы. (T-0123 runtime-dormant ⇒ применение формы — Stage-2 вместе с рантаймом;
  контракт зафиксирован day-1.)
- **Reasoning red-line (D-139/T-0139).** Если исполнение агента порождает reasoning-trace, он пишется
  в `audit_event` под отдельным `data_class`/маскированием (T-0139) — **наружу, в ответ чужому
  приложению, сырой reasoning НЕ уходит**. Тело ответа несёт только `answer` (форма `answer_form`) +
  безопасные метаданные; «почему» остаётся во внутреннем аудите. FF-HEADLESS-NO-REASONING-EGRESS.
- **Egress по DataClass (T-0041).** Тело ответа ≤ `headless_endpoint.response_class`; отправка наружу
  (в чужое приложение) = egress-событие под политику T-0041 по DataClass. `restricted`/`confidential`
  в headless-ответ не попадают, если `response_class` не объявлен соответствующим (и тогда это явное
  решение владельца, аудируемое). Граница зафиксирована схемой; runtime-гейт egress = Stage-2 (как T-0041).

### 2.7 Embedded-runtime: граница client-side vs Choros (банк-кейс §5, РЕШЕНИЕ §3-г, FR-7)

«Choros как embedded-рантайм» (gap-map §5) **не означает**, что код агента/ядро исполняется внутри
чужого приложения. Граница:

- **Client-side (в приложении банка):** только (i) сбор пользовательского текста (`query`), (ii)
  удержание Keycloak service-account-credentials (как любой OAuth-клиент), (iii) HTTP-вызов
  `/api/headless/agent-query`, (iv) рендер `answer` своему пользователю. Чужое приложение —
  **тонкий клиент headless-поверхности**, не носитель ядра/данных Choros.
- **В Choros (server-side, tenant-периметр):** аутентификация, tenant-вывод, PDP, исполнение агента,
  доступ к данным под RLS, формирование ответа, egress-фильтр, аудит. Данные tenant **никогда не
  покидают** периметр кроме как готовым ответом ≤ `response_class` (T-0041). Tenant-изоляция —
  обычная T-0013 (чужое приложение видит только свой tenant через привязку принципала; cross-tenant
  неконструируем).
- **Граница с T-0122 (другой принципал).** T-0122 = анонимный человек-посетитель, токенизированный
  срез **записи** (download/verify/upload). T-0126 = аутентифицированное **приложение** как
  service-account, **вызов агента** → ответ. Общий envelope (PDP/audit/tenant-из-секрета/egress),
  разные принципалы и действия. Headless API **не** заводит анонимный доступ (это T-0122) и **не**
  выдаёт realm-пользователя/JWT-сессию ядра конечному пользователю банка — конечный пользователь
  остаётся в **чужом** приложении; Choros знает только service-account чужого приложения. Identity-
  модель tenancy §6 на конечных пользователей чужого приложения **не расширяется**.

### 2.8 Аудит — каждый headless-вызов, без дублирования (FR-8, AC, T-0016)

**Аудитируется** (строки `audit_event` T-0016, open vocab `type`, **новых таблиц нет**):
- `headless.request` — успешный headless-вызов: actor = service-account-principal, `endpoint_key`,
  `target_agent_id`, `answer_form`, `response_class`; **никогда** сырой `query`-контент выше
  `internal`, **никогда** reasoning, **никогда** сырой client-secret (если §2.1-опция использована —
  только `redactHandle`).
- `headless.denied` — отказ (нет invoke-гранта / точка выключена / класс входа превышен): actor,
  `endpoint_key`, reason. Fail-closed-отказ **тоже** оставляет ровно одну audit-строку (T-0024-паттерн).
- `headless.endpoint.set`/`.revoke` — изменение `headless_endpoint`-конфига (кто/когда/что).

**НЕ дублируется:** data-access агента при исполнении = обычные `actor_event` (T-0019) самого агента
(headless-слой их не повторяет); reasoning = `audit_event` T-0139-семантики (не headless-специфичный
sink). Единственный `appendAuditEvent` (T-0016) — нет второго audit-канала.

### 2.9 Tenant-изоляция + egress (FR-9, T-0013/T-0041)

`headless_endpoint` — обычная T-0013 tenant-таблица (FORCE RLS, default-DENY на `choros.tenant_id`
GUC, `tenant_id`-leading PK/FK, `choros_app` DML-only), в `known_tenant_tables.txt`. Headless-роут
fail-closed по tenant-контексту: нет принципал-привязанного tenant → отказ, не глобальный доступ.
Egress тела ответа — §2.6 (≤ `response_class`, T-0041). Никаких новых isolation-кодпутей: те же FF
T-0013/T-0115 покрывают новую таблицу; принципал-проекция переиспользует invoke-путь.

Тонкое ядро, логика на границах: новый код — одна миграция (`headless_endpoint`), headless-роут-
адаптер (разворот endpoint_key, маппинг на `coversInvoke`, egress-фильтр), endpoint-CRUD через PDP.
Авторизация **переиспользует** PDP T-0021/T-0018 и `coversInvoke` T-0024; auth — T-0060; форма ответа —
T-0123; custody (опц.) — T-0025; egress — T-0041; reasoning-guard — T-0139. Ни одной новой
permission-строки, credential-store, очереди или PDP-edge.

---

## 3. Rejected alternatives

| Развилка | Option | Why not |
|---|---|---|
| **(а) принципал** | **Собственный API-key-store для чужих приложений** (свои ключи, своя проверка, свой rotation) | Второй credential-механизм мимо Keycloak (T-0060): дублирует identity/rotation/revocation, второй секрет-стор, дрейф auth-семантики; против «нет нового credential-механизма». **Keycloak service-account client (client-credentials, `actor_type='agent'`)** даёт identity/rotation/revoke **бесплатно** через существующий realm и `withAuth`-seam (T-0060); чужое приложение = ещё один OAuth-клиент. |
| **(а) принципал** | **Чужое приложение проксирует конечного пользователя как realm-юзера Choros** (выдать пользователю банка JWT ядра) | Раздувает identity-модель tenancy §6 на чужих конечных пользователей (миллионы анонимов банка стали бы principals ядра), ломает «внешний ≠ tenant-пользователь» (T-0122 §2.1). **Принципал = service-account чужого приложения**; конечный пользователь остаётся в чужом приложении, Choros его не знает (§2.7). |
| **(б) точка входа** | **Перегрузить существующий `/api/invoke/*` (T-0024) внешним режимом** | Слил бы внутренний invoke (UI/x-dev-user, сырой agent_id, proposal-id-ответ) и внешний embedded-вызов (machine-JWT, публичный endpoint_key, ответ-агента-наружу, egress) — разные контракты/аудиторы/egress в одном роуте → спутанная семантика и риск утечки внутренних UUID наружу. **Новый `/api/headless/agent-query`** с публичным `endpoint_key`, переиспользующий внутреннюю механику (`coversInvoke`/tenant-tx/audit-seam): общая authority-логика, разделённые контракты. |
| **(в) call-scope** | **Свой `headless_acl`/`endpoint_rights`-стор прав вызова** | Второй authority-store мимо grant-алгебры (T-0018) и PDP (T-0021): «что можно» считалось бы двумя источниками → дрейф, обход; против «нет второго permission-механизма» / `single-resolver.sh`. **`call_scope` = сужающий аргумент того же PDP** (`resolveFor`/`coversInvoke`): запрос исполняется в `call_scope ⊓ грантов агента`; «кто что может» по-прежнему вычисляет только PDP из grant-строк (как `external_surface.facet` в T-0122). |
| **(в) PDP-edge** | **Отдельный headless-резолвер прав вызова** (быстрый путь мимо resolveFor) | Второй PDP-edge — ровно то, что `single-resolver.sh` (T-0021 FF-R6) запрещает; рассинхрон семантики/fail-closed. **Один PDP `resolveFor` + `coversInvoke`** на обоих уровнях (право вызова + data-access агента); headless-роут только готовит контекст-сужение, решение принимает существующий резолвер. |
| **(г) embedded-runtime** | **Исполнять код агента/ядро внутри чужого приложения (real embedded SDK)** | Вынос ядра/данных/PDP в неподконтрольный чужой процесс ломает tenant-изоляцию (T-0013) и egress-контроль (T-0041): данные tenant покинули бы периметр до фильтра, PDP-решение оказалось бы вне доверенной зоны. **«Embedded» = тонкий клиент headless-поверхности** (§2.7): чужое приложение шлёт `query` и рендерит `answer`; всё исполнение/данные/PDP/egress — server-side в Choros. |
| **(г) tenant-вход** | **Tenant как параметр headless-запроса** (чужое приложение указывает tenant) | Cross-tenant-инъекция: чужое приложение запросило бы чужой tenant; против tenancy §9 п.7 (NF-2). **Tenant детерминируется принципалом** (Keycloak client→tenant mapping), endpoint не принимает tenant-параметр; `SET LOCAL` до доступа, RLS отрезает (как T-0122 §2.4 для токена). |
| **(д) форма ответа** | **Headless-слой сам решает форму/объём ответа** (своя конфигурация форматирования) | Дублировал бы компетентностный слой T-0123 (`answer_form`) — два места настройки «как агент отвечает», дрейф с банк-кейсом («клиент сам настраивает ответ»). **`answer_form` (T-0123)** — единственный источник формы; headless-ответ её уважает, не вводит свой формат-стор. |
| **(д) reasoning** | **Возвращать reasoning-trace агента в теле ответа** (для «прозрачности» чужому приложению) | Прямое нарушение red-line D-139/T-0139: сырой reasoning наружу — утечка внутренней логики/данных, не подлежит экспозиции в чужое приложение. **Reasoning → внутренний `audit_event` (T-0139, маскирование); наружу — только `answer` формы `answer_form`** (§2.6); FF-HEADLESS-NO-REASONING-EGRESS. |
| **аудит** | **Не аудитировать headless-вызовы** ИЛИ **отдельный headless-audit-sink** | Без аудита — слепая зона на внешней поверхности (против T-0016 floor); отдельный sink — второй audit-канал (дрейф append-only-гарантий). **`audit_event` через единственный `appendAuditEvent`** (T-0016, open vocab `headless.*`); каждый вызов (успех/отказ) = строка; data-access = обычные `actor_event` (T-0019), не дублируется. |

---

## 4. Object model & contracts

> Postgres-типы авторитетны; TS-зеркало следует конвенции T-0014. `headless_endpoint` — обычная
> T-0013 tenant-таблица (FORCE RLS, default-DENY, `tenant_id`-leading PK/FK, `choros_app` DML-only),
> заносится в `ci/checks/known_tenant_tables.txt`. **Никаких новых isolation-кодпутей** — те же FF
> T-0013/T-0115 покрывают. `HeadlessQuery`/`HeadlessResponse` — transient-структуры (вход/выход
> поверхности), НЕ таблицы. Invoke-проверка — существующий `coversInvoke` (T-0024), новой
> authority-функции нет.

### 4.1 `headless_endpoint` — конфигурация headless-точки (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity |
| `endpoint_key` | `text NOT NULL` | публичный стабильный ключ; UNIQUE `(tenant_id, endpoint_key)`; чужое приложение шлёт его, не сырой agent_id |
| `target_agent_id` | `uuid NOT NULL` | FK `(tenant_id, target_agent_id) → agent_card(tenant_id, employee_id)`; целевой агент-сотрудник |
| `call_scope` | `jsonb NOT NULL` | срез прав вызова (`ScopeElement`/`ResourceFacet` T-0018) — сужающий аргумент PDP, НЕ параллельный ACL |
| `max_input_class` | `text NOT NULL DEFAULT 'public'` | потолок DataClass входного `query`/`context` (T-0033) |
| `response_class` | `text NOT NULL DEFAULT 'public'` | декларированный DataClass ответа для egress (T-0041) |
| `is_enabled` | `boolean NOT NULL DEFAULT false` | точку можно выключить без стирания конфига; routing отказывает при false |
| `created_by` | `text NOT NULL` | актор создания |
| `created_at` | `bigint NOT NULL` | epoch ms |
| `updated_by` | `text NOT NULL` | актор последнего изменения |
| `updated_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; UNIQUE `(tenant_id, endpoint_key)`; FK `(tenant_id, target_agent_id) → agent_card` |

### 4.2 Transient-контракты (вход/выход поверхности — НЕ таблицы)

```ts
// --- Вход чужого приложения (тело POST /api/headless/agent-query) ---
export interface HeadlessQuery {
  endpointKey: string;            // публичный ключ настроенной точки (НЕ agent_id)
  query: string;                  // пользовательский текст из чужого приложения
  context?: Record<string, unknown>; // опц. метаданные; DataClass ≤ headless_endpoint.max_input_class
}

// --- Выход (тело ответа чужому приложению) ---
export interface HeadlessResponse {
  answer: string;                 // ответ агента в форме answer_form (T-0123)
  answerForm: string;            // эхо применённой формы (sum | sum_by_quarter | …) — машинный код T-0123
  // НЕТ поля reasoning / trace / raw — D-139 red-line: сырой reasoning наружу не уходит (§2.6)
}
```

### 4.3 Contracts (signatures — impl-задача реализует; ADR фиксирует форму)

```ts
// Principal-проекция: аутентифицированный service-account → grant-субъект ядра.
// REUSE T-0060 AuthContext + T-0015 ResolveSubject. Tenant из привязки клиента, НЕ из запроса.
export interface HeadlessPrincipal {
  subjectId: string;              // AuthContext.sub (opaque, T-0015) — носитель invoke-грантов
  tenantId: string;              // из Keycloak client→tenant mapping (NF-2), не из тела запроса
  actorType: "agent";           // service-account чужого приложения = agent (T-0060)
}

// Авторизация вызова — ПЕРЕИСПОЛЬЗУЕТ coversInvoke (src/http/invoke.ts), НЕ новая функция.
// import { coversInvoke } from "../http/invoke.js";  // композиция T-0018 isNarrowerOrEqual+isEffective

// Разворот endpoint_key → конфигурация точки (под tenant-контекстом).
export function resolveHeadlessEndpoint(
  deps: { endpointStore }, tenantId: string, endpointKey: string,
): Promise<{ targetAgentId: string; callScope: unknown; maxInputClass: string; responseClass: string; isEnabled: boolean } | null>;

// Исполнение headless-запроса. Day-1 (рантайм T-0123 dormant): answer = детерминированный stub
// по контракту (как T-0024 dispatch-stub). Stage-2: реальный agent-runtime, форма = answer_form.
// Весь data-access агента — через resolveFor (T-0021) под callScope-сужением (§2.4). Fail-closed.
export function executeHeadlessQuery(
  deps: { resolver /* makeGrantResolver T-0021 */; instructionStore /* T-0123 */; clock },
  principal: HeadlessPrincipal, q: HeadlessQuery, ctx: TenantCtx,
): Promise<HeadlessResponse>;

// Egress-фильтр ответа: тело ≤ responseClass (T-0041); reasoning не в теле (D-139).
export function enforceHeadlessEgress(
  resp: HeadlessResponse, responseClass: DataClass,
): HeadlessResponse;  // отбрасывает/отклоняет всё выше responseClass; нет reasoning-поля

// Опциональный custody проксированного client-secret (если §2.1-опция) — RL-3 паттерн T-0025.
// import { validateSecretHandleShape, redactHandle, SecretResolverPort } from "../core/secret-handle-validator.js";

// Импорт (НЕ редекларация): coversInvoke (T-0024 invoke.ts), resolveFor/makeGrantResolver/InvokeContext/
// GuardContext (T-0021 grant-resolver), AuthContext/withAuth/getAuthContext (T-0060 auth.ts),
// AgentInstruction/answerForm (T-0123 agent-instruction), DataClass (T-0033 data-classification),
// ResolveSubject/ObjectRef/TenantCtx (T-0015/T-0013), appendAuditEvent (T-0016),
// validateSecretHandleShape/redactHandle/SecretResolverPort (T-0025). Новой permission-функции,
// второго PDP-edge, нового credential-store и нового custody НЕ вводится.
```

### 4.4 Несущие последовательности

**Headless-вызов (`executeHeadlessQuery` под `withAuth`):** (1) `withAuth` валидирует Bearer-JWT
(T-0060) → principal+tenant; (2) `SET LOCAL choros.tenant_id` из принципала (NF-2 fail-closed),
`withTenantTx`; (3) `resolveHeadlessEndpoint(endpointKey)` → конфиг; `is_enabled=false` → 403 +
`headless.denied`; (4) валидация `query`/`context` DataClass ≤ `max_input_class`; (5) `coversInvoke`
(invoke-grant принципала на роль агента); нет → 403 + `headless.denied`, ноль success-аудита; (6)
исполнение агента (Stage-2; day-1 stub), data-access через `resolveFor` под `call_scope`-сужением,
форма = `answer_form` (T-0123); (7) `enforceHeadlessEgress` (≤ `response_class`, без reasoning); (8)
`headless.request`-audit (T-0016); (9) 200 `HeadlessResponse`. Reasoning (если был) → внутренний
`audit_event` T-0139, не в теле.

**Endpoint-CRUD (`GET/PUT /api/headless-endpoints`):** grant `mgmt_object:headless_endpoint`/`update`
через PDP T-0021 (нет второго ACL); изменение → `headless.endpoint.set`/`.revoke`-audit (T-0016).

---

## 5. Build plan & декомпозиция на build-задачи (IMPL = Stage-2)

ADR-декомпозиция (точные T-номера присвоит материализация бэклога; зависимости и несомые fitness
указаны). **Все impl-задачи — Stage-2**: за разморозкой agent-runtime (E5.6+, T-0123 dormant),
D-139-санкцией на reasoning-обработку и продуктовым решением об экспозиции (§10). Day-1 контракт —
поверхность/авторизация/аудит/egress со stub-ответом (как T-0024 dispatch-stub).

| Build-задача (предлагаемая) | Что создаёт | Зависит от | Несёт fitness |
|---|---|---|---|
| **E-H.1 `[impl] headless_endpoint: миграция + tenant-изоляция`** | Миграция `0NN_headless_endpoint.sql` по §4.1 (FORCE RLS + default-DENY + `choros_app` DML + UNIQUE endpoint_key + FK→agent_card); **+1 имя в `known_tenant_tables.txt`**. | T-0013, T-0014, T-0032 (agent_card) | FF-HEADLESS-T13, FF-HEADLESS-NB-AUTHORITY |
| **E-H.2 `[impl] headless-роут + principal-проекция + coversInvoke`** | `src/http/headless.ts` (`POST /api/headless/agent-query`, `withAuth`, principal→subject, `resolveHeadlessEndpoint`, маппинг на `coversInvoke`); **импортирует** `coversInvoke` (T-0024), `withAuth`/`AuthContext` (T-0060). | E-H.1, T-0024 (invoke), T-0060 (auth), T-0021 (PDP) | FF-HEADLESS-KC-AUTH, FF-HEADLESS-TENANT-FROM-PRINCIPAL, FF-HEADLESS-SINGLE-PDP, FF-HEADLESS-NEW-ENDPOINT |
| **E-H.3 `[impl] call-scope через PDP + data-access агента`** | сужение `call_scope` в `InvokeContext`/`GuardContext`, весь data-access через `resolveFor` (T-0021); **нет** `headless_acl`. | E-H.2, T-0021/T-0018 | FF-HEADLESS-CALLSCOPE-PDP, FF-HEADLESS-NOACL, FF-HEADLESS-FAILCLOSED |
| **E-H.4 `[impl] ответ: answer_form + egress + no-reasoning`** | `executeHeadlessQuery` (day-1 stub), `enforceHeadlessEgress` (≤ response_class, T-0041), форма из `answer_form` (T-0123); **нет** reasoning-поля в `HeadlessResponse`. | E-H.2, T-0123, T-0041, T-0139 | FF-HEADLESS-ANSWER-FORM, FF-HEADLESS-EGRESS-CLASS, FF-HEADLESS-NO-REASONING-EGRESS |
| **E-H.5 `[impl] endpoint-CRUD через PDP + аудит`** | `GET/PUT /api/headless-endpoints` (grant `mgmt_object:headless_endpoint` через PDP T-0021); `headless.request`/`headless.denied`/`headless.endpoint.*` через `appendAuditEvent` (T-0016). | E-H.1..H.4, T-0016, T-0021 | FF-HEADLESS-PREF-AUTHZ, FF-HEADLESS-AUDIT-EVERY-CALL, FF-HEADLESS-NO-RAW-SECRET |

**Defers (НЕ здесь / Stage-2):**
- **Реальный agent-runtime**, генерирующий ответ — за разморозкой E5.6+ (T-0123 dormant); day-1 = stub.
- **Применение `answer_form`** к реальному ответу — вместе с рантаймом (контракт зафиксирован day-1).
- **Реальная reasoning-trace-обработка** (D-139) — за санкцией; day-1 = структурный запрет reasoning в теле.
- **Опциональный проксированный client-secret custody** (реальный `SecretResolverPort`) — Stage-2 за §8-seam.
- **Rate-limit/анти-DoS-бюджет** внешней поверхности — deploy-time параметр (§8, как T-0122 §8/§10).
- **MCP-слой доков** («продукт настраиваем чужими агентами», gap-map §3а) — родственно, отдельная задача (T-0134).

---

## 6. Fitness functions (CI gating — impl acceptance contract)

`gating`: **static-now** = лайнт/тип-чек/юнит, runnable в `npm run ci` после impl; **live-impl** =
проба, авторённая в impl-задаче, активируемая при Postgres. Предлагаемый shared-чек:
`ci/checks/headless-api-isolation.sh`.

| FF | Rule | ci_check / gating |
|---|---|---|
| **FF-HEADLESS-KC-AUTH** | Чужое приложение аутентифицируется через существующий T-0060 Keycloak seam (`withAuth`/`CHOROS_AUTH_MODE`), НЕ новым credential-механизмом: нет собственного api-key-store/HMAC-подписания/OAuth-сервера в headless-коде. | `bash ci/checks/headless-api-isolation.sh`: assert `headless.ts` импортирует `withAuth` из `auth.js`; grep отсутствие `apiKey`/`api_key`-стора, `createHmac`-подписи токена, второго JWT-валидатора вне `auth.ts`. gating=static-now. |
| **FF-HEADLESS-NEW-ENDPOINT** | Точка входа — НОВЫЙ `/api/headless/agent-query`, не перегрузка `/api/invoke/*`: внутренняя invoke-механика переиспользована (`coversInvoke`), но контракт ответа отдельный. | grep: маршрут `'/api/headless/agent-query'` зарегистрирован; `coversInvoke` импортирован (не редекларирован); `/api/invoke/*`-роуты не изменены. gating=static-now. |
| **FF-HEADLESS-TENANT-FROM-PRINCIPAL** | Tenant из аутентифицированного принципала, НЕ из запроса (NF-2): headless-роут не читает tenant из тела/query; `SET LOCAL choros.tenant_id` ставится из principal до доступа. | unit + live-impl: запрос с tenant-полем в теле игнорируется/отклоняется; cross-tenant probe (приложение tenant A не достаёт tenant B). grep отсутствие `body.tenant`/`req.query.tenant`-чтения. gating=static-now + live-impl. |
| **FF-HEADLESS-SINGLE-PDP** | Один PDP-edge: авторизация вызова и data-access агента — через `resolveFor`/`coversInvoke` (T-0021/T-0018); нет второго резолвера/authority-функции в headless-коде. | `bash ci/checks/single-resolver.sh` (существующий T-0021 FF-R6) + `headless-api-isolation.sh`: assert вызов `resolveFor`/`coversInvoke`; grep отсутствие нового `resolveHeadless*Authority`/второго covering-предиката. gating=static-now. |
| **FF-HEADLESS-CALLSCOPE-PDP** | `call_scope` — сужающий аргумент PDP, не параллельный стор: запрос исполняется в `call_scope ⊓ грантов агента` через `resolveFor` (InvokeContext/GuardContext-сужение). | unit: запрос с `call_scope` уже грантов агента → доступ сужен; запрос шире грантов → не расширяет (PDP-решение). `vitest … -t 'headless-callscope'`. gating=static-now + live-impl. |
| **FF-HEADLESS-NOACL** | Нет второго механизма прав: нет `headless_acl`/`endpoint_rights`/`endpoint.visibility`-полей в обход grant-таблицы; «кто что может» считает только PDP из grant-строк. | grep отсутствие `headless_acl`/`endpoint_rights`-таблицы/поля в миграции и коде; assert `call_scope` подаётся в `resolveFor`, не сравнивается локально как ACL. gating=static-now. |
| **FF-HEADLESS-FAILCLOSED** | Fail-closed: нет invoke-гранта / точка выключена / класс входа превышен / нет tenant-контекста → отказ (403/404), ноль success-аудита, ноль data-access. | unit + live-impl: каждый отказ-сценарий ⇒ 4xx, ноль `headless.request`-audit, ровно один `headless.denied`. `vitest … -t 'headless-fail-closed'`. gating=static-now + live-impl. |
| **FF-HEADLESS-ANSWER-FORM** | Форма ответа = `agent_instruction.answer_form` (T-0123), не собственный формат-стор: `HeadlessResponse.answerForm` эхо-ит применённую форму; нет второй конфигурации формы в headless-коде. | unit: ответ несёт `answerForm` из `agent_instruction`; assert импорт `answerForm`-поля (T-0123), не редекларация; grep отсутствие локального `responseFormat`-стора. gating=static-now. |
| **FF-HEADLESS-NO-REASONING-EGRESS** | D-139 red-line: `HeadlessResponse` структурно НЕ несёт reasoning/trace/raw-поля; сырой reasoning не попадает в тело ответа наружу. | `tsc` на `HeadlessResponse` (нет `reasoning`/`trace`/`rawTrace`-поля); grep отсутствие записи reasoning в `res.json`/тело; reasoning только в `appendAuditEvent` (T-0139). gating=static-now. |
| **FF-HEADLESS-EGRESS-CLASS** | Egress-граница (T-0041): тело ответа ≤ `headless_endpoint.response_class`; `confidential`/`restricted` не утекают сверх объявленного. | `tsc` на DataClass-контракте; unit: `enforceHeadlessEgress` отбрасывает поля выше `response_class`; assert импорт `DataClass` (T-0033). gating=static-now + live-impl (egress-гейт Stage-2 как T-0041). |
| **FF-HEADLESS-AUDIT-EVERY-CALL** | Каждый headless-вызов аудируется (T-0016): успех → `headless.request`, отказ → `headless.denied`, config → `headless.endpoint.*`; через единственный `appendAuditEvent`; нет второго audit-sink. | unit + live-impl: success/deny/config-пути эмитят ожидаемый `audit_event`; grep `appendAuditEvent` (не свой writer); `query`-контент/secret/reasoning не в payload. gating=static-now + live-impl. |
| **FF-HEADLESS-NO-RAW-SECRET** | Если §2.1-опция (проксированный client-secret) — RL-3 (T-0025): handle проходит `validateSecretHandleShape`; сырой секрет не в лог/audit/ответ/exception (`redactHandle`). | `headless-api-isolation.sh`: если secret-путь присутствует — assert `validateSecretHandleShape`/`redactHandle` импорт (T-0025); grep отсутствие сырого secret в `console.*`/`appendAuditEvent`/`res.json`. gating=static-now. |
| **FF-HEADLESS-PREF-AUTHZ** | Endpoint-CRUD через PDP (T-0021): `PUT /api/headless-endpoints` требует grant `mgmt_object:headless_endpoint`/`update`; нет второго ACL. | unit + live-impl: без grant ⇒ denied; assert вызов `resolveFor`; grep отсутствие нового `endpoint_acl`. gating=static-now + live-impl. |
| **FF-HEADLESS-EMBEDDED-BOUNDARY** | Embedded = тонкий клиент (§2.7): ядро/данные/PDP/egress — server-side; headless-код не экспортирует исполняемый агент-рантайм/ядро для client-side-запуска; конечный пользователь чужого приложения не становится realm-юзером ядра. | grep: headless-код не создаёт `employee`/realm-user для конечного пользователя чужого приложения; нет client-side-runtime-экспорта; принципал = service-account. gating=static-now. |
| **FF-HEADLESS-NB-AUTHORITY** | Нет нового authority/credential/queue-стора (NF-1): миграция не создаёт `headless_acl`/`api_key`/`token`-таблицы прав; авторизация через grant+PDP, auth через Keycloak. | grep что миграция не содержит `CREATE TABLE …(acl|api_key|credential|rights)`; единственная новая таблица = `headless_endpoint` (конфиг-маппинг, не authority-стор). gating=static-now. |
| **FF-HEADLESS-T13** | T-0013-контракт `headless_endpoint`: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id` GUC, `choros_app` DML-only, занесена в `known_tenant_tables.txt`. | существующие T-0013/T-0115 пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) применяются к новой таблице после внесения в фикстуру. gating=live-impl (T-0013 apparatus). |

---

## 7. Traceability (FR/AC → design)

| FR / AC | covered_by |
|---|---|
| FR-1 (принципал чужого приложения) | §2.1 (Keycloak service-account, `actor_type='agent'`, principal-проекция, tenant из клиента) + §4.3 `HeadlessPrincipal` + FF-HEADLESS-KC-AUTH/FF-HEADLESS-TENANT-FROM-PRINCIPAL; §3 rejected(свой api-key-store; realm-юзер конечного пользователя) |
| FR-2 (точка входа) | §2.2 (новый `/api/headless/agent-query`, переиспользует invoke-механику) + §5 E-H.2 + FF-HEADLESS-NEW-ENDPOINT; §3 rejected(перегрузка `/api/invoke`) |
| FR-3 (конфигурация точки) | §2.3 + §4.1 `headless_endpoint` (T-0013) + FF-HEADLESS-T13/FF-HEADLESS-NB-AUTHORITY |
| FR-4 (call-scope через PDP) | §2.4 (два уровня PDP, `call_scope`-сужение) + §4.3 (`coversInvoke`/`resolveFor` import) + FF-HEADLESS-SINGLE-PDP/FF-HEADLESS-CALLSCOPE-PDP/FF-HEADLESS-NOACL; §3 rejected(`headless_acl`; второй резолвер) |
| FR-5 (pipeline запрос→ответ) | §2.5 (7 звеньев, fail-closed, stub day-1) + §4.4 + FF-HEADLESS-FAILCLOSED |
| FR-6 (форма ответа + reasoning) | §2.6 (`answer_form` T-0123, reasoning не наружу) + §4.2 `HeadlessResponse` + FF-HEADLESS-ANSWER-FORM/FF-HEADLESS-NO-REASONING-EGRESS; §3 rejected(свой формат-стор; reasoning в теле) |
| FR-7 (embedded-runtime граница) | §2.7 (client-side тонкий клиент vs Choros server-side; граница с T-0122) + FF-HEADLESS-EMBEDDED-BOUNDARY; §3 rejected(real embedded SDK в чужом процессе) |
| FR-8 (аудит) | §2.8 (`headless.*` через единственный `appendAuditEvent`, не дублирует actor_event) + §5 E-H.5 + FF-HEADLESS-AUDIT-EVERY-CALL; §3 rejected(нет аудита/отдельный sink) |
| FR-9 (tenant-изоляция + egress) | §2.9 (T-0013 таблица, fail-closed; egress ≤ response_class T-0041) + §2.6 + FF-HEADLESS-T13/FF-HEADLESS-EGRESS-CLASS |
| Red-line: нет второго permission/credential | §2.1/§2.4 + FF-HEADLESS-KC-AUTH/FF-HEADLESS-SINGLE-PDP/FF-HEADLESS-NOACL/FF-HEADLESS-NB-AUTHORITY; §3 rejected(api-key-store; headless_acl; второй резолвер) |
| Red-line: tenant-изоляция (T-0013) | §2.1/§2.9 + FF-HEADLESS-TENANT-FROM-PRINCIPAL/FF-HEADLESS-T13; §3 rejected(tenant как параметр) |
| Red-line: аудит каждого вызова (T-0016) | §2.8 + FF-HEADLESS-AUDIT-EVERY-CALL |
| Red-line: reasoning-trace (D-139) | §2.6 + FF-HEADLESS-NO-REASONING-EGRESS; §3 rejected(reasoning в теле) |
| Red-line: custody (T-0025, опц.) | §2.1/§8 + FF-HEADLESS-NO-RAW-SECRET |

---

## 8. Custody-seam опционального client-secret (аналог T-0025 §8 / T-0120 §8)

Если чужое приложение проксирует секрет конечного пользователя (не нужно для client-credentials
day-1, но контракт фиксируется): headless-слой хранит **handle**, не сырой секрет — RL-3 паттерн
T-0025 verbatim.
1. **Day-1** — секрет-путь не требуется (Keycloak client-credentials аутентифицирует приложение);
   если присутствует — `validateSecretHandleShape` (T-0025) на set, `redactHandle` на статус/лог.
2. **Stage-2** — реальный `SecretResolverPort` (vault/env клиента) за тем же портом, без изменения
   ядра (как T-0025 §8 / T-0120 §8).
3. Платформа **не SMTP/LLM-relay** для секрета; резолв локально, не покидает периметр.

**Deploy-time параметры (НЕ блок дизайна):** rate-limit/анти-DoS-бюджет headless-поверхности и
дефолтные классы (`max_input_class`/`response_class`) — конфигурируемы при деплое (как T-0122 §8),
day-1 дефолт = `public`/консервативно.

---

## 9. Compatibility notes (architect rule 7)

- **Implements, does not change, T-0024 invoke.** Headless-роут переиспользует `coversInvoke`
  (`src/http/invoke.ts`, композиция T-0018) и invoke-tx/audit-паттерн; `/api/invoke/*`-роуты не
  трогаются. Новый endpoint — параллельный адаптер, общая authority-механика (FF-HEADLESS-NEW-ENDPOINT/
  FF-HEADLESS-SINGLE-PDP).
- **Implements, does not change, T-0060 worker-auth.** Аутентификация чужого приложения = тот же
  `withAuth`/`CHOROS_AUTH_MODE`/Keycloak service-account (`actor_type='agent'`); нового credential-
  механизма/JWT-валидатора нет (FF-HEADLESS-KC-AUTH).
- **Honors T-0018 §2 / T-0021.** Право вызова и data-access агента = grant-строки через тот же PDP
  (`coversInvoke`/`resolveFor`); `call_scope` — сужающий аргумент, не ACL; нет `headless_acl`/второго
  PDP-edge (`single-resolver.sh`, FF-HEADLESS-NOACL/FF-HEADLESS-CALLSCOPE-PDP).
- **Honors T-0013/T-0115.** `headless_endpoint` — обычная tenant-таблица; внесение в
  `known_tenant_tables.txt` — единственное (ожидаемое) изменение фикстуры impl-миграцией (FF-HEADLESS-T13).
- **Honors T-0016.** Headless-аудит = строки `audit_event` (open vocab `headless.*`); новых
  audit-таблиц нет; data-access агента = обычные `actor_event` (T-0019), не дублируется
  (FF-HEADLESS-AUDIT-EVERY-CALL).
- **Honors T-0123 agent-instruction.** Форма ответа = `answer_form` компетентностного слоя (банк-кейс);
  headless не вводит второй формат-стор; рантайм T-0123 dormant ⇒ применение формы = Stage-2,
  контракт day-1 (FF-HEADLESS-ANSWER-FORM).
- **Honors T-0033/T-0041.** Тело ответа ≤ `response_class` (`DataClass` импорт, не редекларация);
  egress-граница помечена, runtime-гейт = Stage-2 (как T-0041) (FF-HEADLESS-EGRESS-CLASS).
- **Honors D-139/T-0139.** Сырой reasoning наружу не уходит — только в `audit_event` под T-0139-
  маскированием; `HeadlessResponse` структурно без reasoning-поля (FF-HEADLESS-NO-REASONING-EGRESS).
- **Honors T-0025 (опц.).** Проксированный client-secret = RL-3 handle, не сырой; нового custody нет
  (FF-HEADLESS-NO-RAW-SECRET).
- **Distinct from, composes with, T-0122 external-surface.** Разные принципалы (анонимный человек vs
  аутентифицированное приложение) и действия (срез записи vs вызов агента); общий envelope (PDP/audit/
  tenant-из-секрета/egress). Headless API не заводит анонимный доступ и не выдаёт realm-сессию
  конечному пользователю чужого приложения (§2.7, FF-HEADLESS-EMBEDDED-BOUNDARY).

---

## 10. Escalation

**None для DESIGN-объёма.** Пять внутри-DESIGN развилок (§1: принципал; точка входа; call-scope через
PDP; embedded-граница; форма ответа + reasoning-guard) решены §3 с rejected-alternatives, все
композируют существующие примитивы без нового механизма.

**Развилки уровня фаундера (НЕ решаются здесь — продуктовые/деплой, вынесены, не блокируют impl):**
1. **Внешняя экспозиция и упаковка/тарификация headless-доступа** — открывать ли headless API как
   платный продуктовый канал, на каких тарифах/квотах, кому (gap-map §3 «экономика»/позиционирование
   embedded-рантайма). Это GTM/pricing-решение фаундера, не дизайн-инвариант; ADR фиксирует **механику**
   (как это безопасно сделать), не **политику** (делать ли и за сколько). **→ open_question.**
2. **Момент разморозки agent-runtime** (E5.6+, gap-map §3 п.6) — реальный генеративный ответ headless
   API требует живого рантайма агента (T-0123 dormant). Это та же разморозка, что и для всего
   «агент-сотрудник»; headless API готов day-1 на уровне поверхности/контракта/stub, реальный ответ —
   за разморозкой. **→ open_question (общая, не headless-специфичная).**
3. **Rate-limit/анти-DoS-бюджет** внешней поверхности и дефолтные классы — deploy-time параметр
   (§8, как T-0122 §8/§10), day-1 консервативный дефолт; не блок дизайна.

Этих развилок ADR **не гадает** — механика+стаб+seam day-1, продуктовое/деплой-решение = за фаундером
за тем же контрактом.
