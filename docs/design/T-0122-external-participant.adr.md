# ADR · T-0122 — Внешний участник: справочник + примитив «внешняя поверхность»

**Status:** ready (no founder escalation — направление задано фаундером в gap-map §3а; единственная развилка уровня фаундера — анти-DoS/rate-limit-бюджет и срок-дефолт TTL внешней ссылки — вынесена как **deploy-time параметр** за конфигурацию, §8/§10)
**Phase:** DESIGN · **Date:** 2026-06-11
**Task:** T-0122 (product=choros, type=design, prio 55)
**Spec consumed:** `docs/specs/T-0122-external-participant.spec.md` (status: ready, AC-1..AC-15) · `docs/specs/T-0122.spec.contract.json`
**Решение фаундера (данность, НЕ развилка):** внешний участник как ДАННЫЕ = запись справочника (record, T-0014), НЕ учётка Keycloak; канал = примитив «внешняя поверхность» = токенизированный доступ без учётки к узкому срезу {скачать, проверить, загрузить} с аудитом; один механизм прав (производный грант внутри T-0018); снапшот vs живой документ — недвусмысленно (gap-map §4б инвариант 1).

**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant-таблица: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)`, DML только `choros_app`, занесение в `known_tenant_tables.txt`; **fail-closed tenant-контекст в async/фоне/external** (§9 п.7).
- `docs/design/T-0014-registry-model.adr.md` §5 — `ResourceRef` (`application | registry | record`); запись = grant-target; внешний участник = обычная `record`-запись.
- `docs/design/T-0015-object-handles.adr.md` — непрозрачные ручки; внешняя ссылка несёт handle/токен, не данные; `resolveHandle(handle, subject): Promise<ResolvedView>` порт + `denyAllResolver`.
- `docs/design/T-0018-grant-authority.adr.md` — единая grant-алгебра (closed scope-lattice); `Grant`-кортеж; write-time subset gate (`validateNarrowing`); `valid_from`/`valid_until` (TTL=снятие capability); `delegable`; «нет второго permission-подсистемы» (§2/NF-1); грант привязан к **роли-принципалу**; `isEffective(grant, now)`; `GrantAuditEvent` obligation.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чокпойнт `makeGrantResolver` / `resolveFor(handle, subject, op)`; action-time, fail-closed; reason-union `"no_grant" | "cross_tenant" | "not_found"`; `ResolveSubject = {tenantId, subjectId}` (identity-only, без human/agent-флага); `projectFields` (скрытые поля **физически отсутствуют**); `refToScope`.
- `docs/design/T-0016-audit-floor.adr.md` — append-only per-tenant hash-chained `audit_event`; `type/actor/subject/scope/via/payload` (open-vocab `type` — новые события = строки, не таблицы); tenant-scoped; секрет в payload не пишется.
- `docs/design/T-0119-files-attachments.adr.md` — **presign-after-allow**: контент отдаётся ТОЛЬКО после allow-решения PDP по записи-владельцу; `authorizeFileOp` / `getFileContentUrl` / `addVersion`; `is_snapshot` (document-on-demand); declared-лимиты загрузки; «тот же путь — для внешнего принципала (T-0122/T-0126): производный ограниченный грант → presign, не второй механизм» (T-0119 §2.5).
- `docs/design/T-0033-data-classification.adr.md` — `DataClass`; клиренс = max DataClass покрывающих грантов.

**Связанные задачи (инварианты):**
- **T-0124 (document-on-demand) зависит от T-0122** — QR-кейс: внешний видит «валидно/невалидно» + скачивает; live-рендер фиксируется снапшотом-файлом (T-0119), ссылка указывает на снапшот ЛИБО явно помечена «живой документ». T-0122 проектирует **поверхность доступа** + контракт, который T-0124 потребляет, **не рендер**.
- **T-0126 (headless API) — отдельная задача:** программная поверхность (запрос из чужого приложения → ответ агента); агентский headless-ответ design-only до Stage-2. T-0122 — поверхность для **человека-внешнего** (скачать/проверить/загрузить), не агентский ответ. Оба вводят «внешнего принципала» одним механизмом (производный грант) — T-0126 переиспользует §4 этого ADR.

> Это ADR **design-only**. Choros имеет Postgres-в-compose (T-0053/T-0114) и S3-совместимый
> MinIO в дев-стеке (T-0119); сам токен-сервис, эндпоинты внешней поверхности, миграция
> таблиц и live-DB-пробы — **последующие impl-задачи**, не здесь. Следующая миграция —
> после `044_config_agent_seed.sql` (свободный номер ≥ 045 по run-seam дисциплине; точный
> слот выбирает coder на момент impl). Каждая fitness-функция несёт конкретный `ci_check` +
> `gating`-ноту (**static-now** = лайнт/тип-чек/юнит в сегодняшнем `npm run ci`;
> **live-impl** = проба, авторённая позже, активируемая при Postgres+MinIO). Этот ADR — единый
> источник полей/типов/контрактов для `coder` и `tester`.

---

## 1. Context

Референс ТЭЛ (§1/§2/§5) даёт два кейса одной формы: (а) **контрагент** по договору — внешняя
сторона, которая скачивает проект договора, видит статус согласования, загружает протокол
разногласий/подписанный скан; (б) **QR-валидация** — анонимный посетитель сайта сканирует QR,
видит «валидно/невалидно» и скачивает документ. Сегодня в модели внешней стороны нет вовсе
(gap-map: 🔴 «контрагент как внешний участник», 🔴 «файлы»). Спека закрыла все продуктовые
развилки решением фаундера и зафиксировала несущий инвариант: **один механизм прав** — внешний
вводится как **производный ограниченный грант** ВНУТРИ grant-модели (T-0018), резолвится тем же
PDP (T-0021); никакого `external_acl`/`public_share`/поля-видимости.

Несущий принцип дизайна, как в T-0021/T-0119: дизайн **негативен** не меньше, чем позитивен —
сделать неправильное **невозможным**, а не только покрытым тестом. Конкретно для публичной
неаутентифицированной поверхности это значит: (1) у внешнего **нет идентичности, кроме токена** —
проекция полей и решение о праве идут тем же `resolveFor`, без второго код-пути; (2) tenant
**детерминируется токеном**, внешний его не выбирает — cross-tenant предъявление структурно
отклоняется до любого чтения; (3) сравнение токена **константно по времени** и токен хранится
**только хэшем** — перебор/тайминг-оракул вычислительно неосуществим; (4) отказы **единообразны** —
наружу не различимы «истёк» / «отозван» / «не существует», поверхность не служит оракулом
разведки; (5) контент — **только presign-after-allow** (T-0119), ни байта мимо PDP.

Остаются **пять внутри-DESIGN развилок**, которые этот ADR решает с rejected-alternatives:
(а) **где живёт производный грант** — материализованная `grant`-строка на синтетическую внешнюю
роль mint-time vs грант, выводимый из конфигурации поверхности resolve-time; (б) **на какой
принципал** ссылается грант, раз у внешнего нет роли; (в) **представление трёх действий** в
операциях T-0018; (г) **актор аудита без учётки**; (д) **одноразовость** (лимит использований)
как атрибут поверхности.

---

## 2. Decision

**Внешний участник моделируется ДВУМЯ tenant-таблицами ядра поверх существующего grant/PDP, при
этом авторизация полностью делегирована PDP T-0021 и алгебре T-0018 — нового механизма прав НЕ
вводится; токен — высокоэнтропийный секрет, хранимый ТОЛЬКО SHA-256-хэшем, который при
предъявлении детерминирует tenant и резолвится в производный ограниченный грант на синтетическую
external-роль; скачивание/загрузка — через presign-after-allow T-0119; verify — через
`projectFields` T-0021; каждое действие (успех И отказ) — строка `audit_event` T-0016 с актором,
производным от поверхности.**

### 2.1 Внешний как ДАННЫЕ: обычная `record`-запись (FR-1)

Внешний участник (контрагент, посетитель) — **обычная tenant-запись** `record` (T-0014) в
реестре контрагентов того же tenant; он **grant-target и/или субъект данных**, но **НЕ**
Keycloak-realm-пользователь, **НЕ** tenant-пользователь, **НЕ** роль. Связь «договор ↔ контрагент» —
кросс-реестровая ссылка (поле `record.data`), не новая сущность. Identity-модель tenancy §6 **не
расширяется** на внешних: внешняя поверхность **не создаёт** realm-пользователя и **не выдаёт**
JWT-сессию ядра. (Для QR-кейса даже запись-контрагент необязательна — посетитель анонимен;
«внешний как данные» относится к контрагент-кейсу, где сторона известна и хранится записью.)

### 2.2 Внешняя поверхность — ДВЕ tenant-таблицы (FR-2, T-0013-контракт verbatim)

- **`external_surface`** — декларативная конфигурация доступа без учётки: `(tenant_id, id)` PK;
  `target_ref jsonb` (`ResourceRef` записи-цели T-0014 §5 — `record`-kind day-1); `actions text[]`
  (закрытый набор ⊆ `{download, verify, upload}`); `facet jsonb NULL` (опубликованный срез полей
  для verify — пусто ⇒ deny-by-default, не «всё»); `valid_from`/`valid_until bigint`; `max_uses
  integer NULL` (NULL ⇒ многоразовый; ≥1 ⇒ лимит использований); `use_count integer DEFAULT 0`;
  `revoked_at bigint NULL`; `created_by/at`. Поверхность — **конфигурация (кто/что/срок выдал)**, не
  код per-кейс: QR-кейс и контрагент-кейс — два набора `actions`/`facet` над одним примитивом.
- **`external_token`** — секрет-носитель, **только хэш**: `(tenant_id, id)` PK; FK `(tenant_id,
  surface_id) → external_surface(tenant_id, id)`; `token_hash bytea NOT NULL` (SHA-256 секрета —
  **plaintext не хранится никогда**); UNIQUE `(tenant_id, token_hash)` И глобально достаточный
  lookup-индекс по `token_hash` (см. §2.4 про tenant-вывод); `created_by/at`. Одна поверхность ↔
  1…N токенов (ротация без переиздания поверхности).
- Обе — обычные T-0013 tenant-таблицы (FORCE RLS, default-DENY, `tenant_id`-leading, `choros_app`
  DML-only), заносятся в `known_tenant_tables.txt`. **Никаких новых isolation-кодпутей** — те же
  FF T-0013/T-0115 покрывают их.

### 2.3 Токен → производный ОГРАНИЧЕННЫЙ грант (FR-3, несущий инвариант NF-1)

**Развилка (а)+(б), решённая:** грант внешней поверхности — **материализованная `grant`-строка**
(T-0018) на **синтетическую external-роль**, выпускаемая **mint-time** при создании поверхности,
а НЕ выводимая ad-hoc resolve-time. Обоснование — §3 (rejected: ad-hoc-грант-resolve-time).

- **Принципал.** Каждая `external_surface` владеет ровно одной **синтетической ролью**
  `role` (T-0022) с `is_external = true` (флаг как `is_system` у `registry_def`): эта роль — никому
  не назначаемый principal, существующий только как держатель грантов поверхности.
  `ResolveSubject.subjectId` для внешнего = id этой роли; никакого `assignment` на человека нет
  (внешний не tenant-пользователь). Грант привязан к **роли**, как требует T-0018 (грант не
  цепляется к личности) — поверхность и есть «личность» в смысле принципала.
- **Сужение (subset gate, T-0018 §4.3).** Грант(ы) поверхности проходят `validateNarrowing` против
  гранта **выдавшего принципала** при создании: `surface.scope ⊑ target_ref-scope` (≤ scope
  записи-цели), `operation ∈ {read, create, update}`-отображение (§2.5), `resource_facet ⊑`
  опубликованного среза, `delegable = false` (внешний не переделегирует). Поверхность **структурно
  не может** дать шире, чем выдавший имел право (write-time, до персиста).
- **Резолв.** Решение «что видит/может внешний» принимает **тот же** `resolveFor(handle, subject,
  op)` (T-0021), action-time, fail-closed. Внешний субъект `{tenantId, subjectId: externalRoleId}`
  предъявляется резолверу как любой субъект; `projectFields` применяется к нему **идентично**
  внутреннему (human≡agent≡external — один путь проекции, нет ветки «это внешний?»).
- **Запрет второго механизма.** НЕТ `external_acl` / `public_share_rights` / `surface.visibility`-
  поля в обход grant-таблицы. `external_surface.facet` — это **аргумент** `resource_facet`
  выпускаемого гранта (сужающий токен), **не** параллельный authority-store; «кто видит» по-прежнему
  вычисляет только PDP из grant-строк (FF-NOACL, соответствует T-0018 §2 / T-0021 FF-R6).

### 2.4 Tenant-вывод из токена + fail-closed (FR-7, NF-2 — non-negotiable)

Tenant **детерминируется токеном, внешний его не выбирает.** Эндпоинт внешней поверхности
**не принимает** tenant-параметр. Последовательность на входящем запросе с секретом `s`:

1. `h = sha256(s)`. Lookup `external_token` по `token_hash = h`. Этот единственный lookup —
   **системная операция вне RLS-tenant-контекста** (специальная роль `choros_token_lookup` с
   доступом ТОЛЬКО к `(tenant_id, surface_id)` по `token_hash`, **не** к контенту/данным) — он
   возвращает **только** `tenant_id` поверхности (и `surface_id`). Это единственное место, где
   читается до установки tenant-контекста, и оно по построению не отдаёт ни байта прикладных
   данных (§3, rejected: tenant в открытом токене).
2. **Установить tenant-контекст** (`SET LOCAL choros.tenant_id = <tenant из шага 1>`) ДО любого
   прикладного доступа (tenancy §9 п.7 fail-closed). Дальше всё под RLS этого tenant.
3. Только теперь — валидация поверхности (валидна/не отозвана/в окне/лимит), резолв гранта,
   действие. Cross-tenant неконструируем: даже зная `surface_id` чужого tenant, внешний не может
   подставить tenant (его нет в запросе) — он выводится исключительно из хэша его собственного
   токена; токен tenant B в любом эндпоинте резолвится в контекст tenant B и не достаёт запись A.
4. Отсутствие/неоднозначность tenant (нет токена / хэш не найден) ⇒ **единообразный fail-closed
   отказ** (§2.7), не глобальное действие.

> Структурный замок (как cross-tenant ключ в T-0119): tenant — **производное от секрета,
> известного только держателю токена**, а не вход запроса. Подделать чужой tenant = подделать
> чужой высокоэнтропийный секрет (вычислительно неосуществимо, §2.7).

### 2.5 Три действия = три отдельные операции под PDP (FR-5, набор day-1 ЗАКРЫТ)

Отображение `{download, verify, upload}` на операции T-0018 (`Operation`):

| Внешнее действие | T-0018 op на записи-цели | Путь | Что отдаёт |
|---|---|---|---|
| **download** | `read` | **presign-after-allow** (T-0119 `getFileContentUrl`): PDP allow `read` записи-владельца → presign короткого TTL → байты из S3 | presigned-URL; **ни байта без allow** |
| **verify** | `read` (facet-срез) | `resolveFor(handle, subject, "read")` → `projectFields(raw, vis)`; `vis` = facet поверхности ∩ facet гранта | узкий публичный срез (статус/валидность); **скрытые поля физически отсутствуют** (не маскируются строкой), verify **не раскрывает их существование** |
| **upload** | `create` / `update` | T-0119 `addVersion` производным грантом на запись-цель; declared-лимиты (размер, MIME-allowlist) | versionId ответного файла |

Набор **закрыт** day-1 (только эти три); расширение — той же механикой (новое значение в
`actions[]` + соответствующее op-отображение), **не** новый примитив. `download`/`verify`
требуют `read`-гранта; `upload` — `create`/`update`-гранта; каждое — отдельное PDP-решение.

### 2.6 TTL, отзыв, одноразовость (FR-4)

- **TTL** — `external_surface.valid_from/valid_until` материализуются в `valid_from/valid_until`
  выпущенного `grant` (T-0018): out-of-window ⇒ `isEffective` false ⇒ ноль capability на read-path,
  **action-time** (T-0021 step 3). Истёкший токен ⇒ отказ, не «работает-но-логируется».
- **Отзыв** — `external_surface.revoked_at` (или revoke выпущенного гранта тем же путём, что обычный
  grant-revoke). Действует **немедленно на следующем resolve** (action-time, не mint-time кэш):
  отзыв = инвалидация гранта/поверхности; `resolveFor` перестаёт находить покрывающий effective
  грант ⇒ `no_grant`. Revoke токена (а не всей поверхности) = удаление/инвалидация строки
  `external_token` (хэш перестаёт находиться).
- **Одноразовость (развилка (д), решена):** `max_uses` — **декларативный атрибут** поверхности
  (NULL ⇒ многоразовый; N ⇒ лимит). `use_count` инкрементируется атомарно при успешном действии;
  `use_count ≥ max_uses` ⇒ поверхность исчерпана ⇒ тот же fail-closed отказ. Day-1 поддержаны оба
  режима; счётчик — атрибут поверхности, не отдельный механизм.

### 2.7 Анти-абьюз + анти-оракул (FR-8, NF-6)

- **Энтропия + хэш-хранение.** Секрет токена — ≥ 256 бит CSPRNG (`crypto.randomBytes(32)`,
  base64url); хранится **только** `sha256(secret)` (как пароль, без соли — секрет сам
  высокоэнтропийный, rainbow-неуязвим). Plaintext не хранится и не логируется нигде (FF-TOKEN-HASH).
- **Константное сравнение.** Lookup по `token_hash` — равенство хэшей (БД-индекс), **не**
  сравнение plaintext; никакого early-return по префиксу (тайминг-оракул закрыт хэш-равенством).
- **Rate-limit / throttle.** Гейт на внешнем эндпоинте per-`token_hash` + per-IP + per-tenant;
  превышение ⇒ отказ + **строка аудита** (`external.throttle`). Параметры (порог, окно, бюджет)
  — deploy-time (§8).
- **Анти-оракул (единообразный отказ).** Все неуспехи — **один** ответ-форма (HTTP 404 +
  пустое тело, или единый `{denied:true}`), **не различимый** наружу: «нет токена» / «истёк» /
  «отозван» / «исчерпан» / «cross-tenant» / «запись отсутствует» дают **байт-идентичный** внешний
  ответ. Поверхность **не раскрывает** существование записи-цели и не различает причины наружу
  (внутренний reason пишется в аудит, наружу не уходит). (FF-UNIFORM-DENY.)
- **Declared-лимиты загрузки** (FR-5) — часть анти-абьюза: внешний `upload` ограничен размером и
  MIME-allowlist (T-0119), не unbounded.

### 2.8 Аудит без учётки (FR-6, развилка (г) решена)

Каждое действие внешнего (download/verify/upload, **успех И отказ**) — строка `audit_event`
(T-0016), tenant-scoped, **open-vocab `type`** (`external.download` / `external.verify` /
`external.upload` / `external.deny` / `external.throttle`) — **строки, не новая таблица**:
- `actor` = **производный от поверхности/токена** идентификатор без секрета: `external-surface:<surface_id>`
  (`actor` в T-0016 — свободный `text`, open-vocab — уже вмещает); **секрет токена НЕ пишется**
  (только `surface_id`, опц. `token_id` — не хэш, не plaintext).
- `subject` = `ResourceRef` записи-цели; `via` = канал (`external-surface`); `payload` = результат
  (allow/deny + reason) + (для download/upload) `{file_id, version_id, content_hash, mime, size}`.
- **Трассируемость** «кто выдал ↔ что сделал»: `external_surface.created_by` (выдавший) +
  `GrantAuditEvent grant.create` гранта поверхности (T-0018 §4.6) ↔ `external.*`-события действий.
  По аудиту восстановимо: какой принципал выпустил какую поверхность и что внешний по ней сделал.

### 2.9 QR-кейс и контрагент-кейс из одного примитива (FR-9, AC-15 — см. §5 прогон)

QR-кейс: `external_surface{ actions:["verify","download"], facet:<публичный срез>, max_uses:null }`
+ токен в QR/handle (T-0015) → verify («валидно/невалидно») + download. Скачиваемое = **снапшот**
(T-0119 `is_snapshot=true`, иммутабельный/воспроизводимый) **либо** запись явно помечена «живой
документ» — поверхность фиксирует, на что указывает ссылка, **недвусмысленно** (gap-map §4б
инвариант 1). Рендер живого документа — **T-0124** (deps); T-0122 даёт поверхность доступа +
контракт. Контрагент-кейс: `external_surface{ actions:["download","verify","upload"], facet:<статус
согласования>, valid_until:<срок>, max_uses:null }` → контрагент скачивает проект, видит статус,
грузит протокол разногласий. **Оба собираются конфигурацией одного примитива, без второго механизма
прав и без учётки** (§5).

Тонкое ядро, логика на границах (CONCEPT §5): новый код — токен-mint/хэш + tenant-lookup-by-hash +
эндпоинт-обёртка + rate-limit-гейт; авторизация **переиспользует** T-0021/T-0018/T-0119 без единой
новой permission-строки.

---

## 3. Rejected alternatives

| Развилка | Option | Why not |
|---|---|---|
| **Механизм прав** | **`external_acl` / `public_share_rights` / `surface.visibility`-поле** (отдельные права внешнего) | Второй источник истины «что видит внешний» дрейфует от grant-таблицы → тихий leak или тихий отказ на **публичной** поверхности (худшее место для дрейфа). Прямо запрещён gap-map §4б инвариант 2 / T-0018 §2 / T-0021 FF-R6 / NF-1. Право внешнего **выводится** из grant-строки тем же PDP — как T-0119 выводит право файла, T-0021 masked-fields. (FF-NOACL.) |
| **Где грант** | **Ad-hoc грант, выводимый из конфигурации поверхности на resolve-time** (нет `grant`-строки; PDP строит грант из `external_surface` при каждом запросе) | Вводит **второй путь деривации прав** рядом с grant-таблицей — PDP пришлось бы знать про `external_surface` как про источник authority, что и есть «второй механизм» под другим именем (subset gate, revoke, audit-trail гранта пришлось бы дублировать для surface-пути). Материализация в **обычную `grant`-строку mint-time** даёт: subset gate проходит через тот же `validateNarrowing`; отзыв/TTL — тот же grant-механизм; `grant.create`/`grant.revoke` уже в аудите; `resolveFor` не знает про «внешних» вовсе. Один источник истины, ноль нового authority-кода. (FF-NOACL/FF-DERIVED-GRANT.) |
| **Принципал** | **Грант цепляется напрямую к записи-контрагенту (`record`) как к принципалу** | T-0018: грант привязан к **роли**, не к личности/записи (substitution/audit/least-privilege ломаются иначе). Запись-контрагент — это **данные** (§2.1, grant-**target**/subject данных), не principal. Синтетическая `is_external`-роль — корректный principal-держатель без расширения identity-модели (роль никому не назначается, человека за ней нет). |
| **Tenant-вывод** | **Tenant закодирован в открытом теле токена** (токен несёт `tenant_id` + секрет; эндпоинт читает tenant из токена) | (а) Открытый `tenant_id` в публичной ссылке — утечка идентификатора тенанта (разведка); (б) парсинг tenant из недоверенного входа — ровно тот «внешний выбирает tenant», что запрещён NF-2; подделка/перебор tenant-сегмента стала бы вектором. **Tenant — производное от `sha256(secret)` через `external_token`-lookup** (§2.4): непрозрачный токен, tenant неизвлекаем из ссылки, выбор tenant внешним структурно невозможен. |
| **Хранение токена** | **Plaintext-токен в БД (или обратимое шифрование)** | Дамп БД = все действующие внешние доступы в открытом виде (как plaintext-пароли). Хранится **только `sha256(secret)`**; секрет существует лишь в выданной ссылке. Перебор хэша ⇔ перебор 256-бит секрета (неосуществимо). (FF-TOKEN-HASH.) |
| **Отказ-семантика** | **Дифференцированные ответы** («токен истёк» / «токен отозван» / «нет записи» — разные коды/тела наружу) | Дифференцированный отказ = **оракул**: атакующий перебирает токены/записи, по различию ответов картографирует существование тенантов/записей/сроков. Единообразный fail-closed отказ (§2.7) — наружу неразличим; причина только в аудит. (FF-UNIFORM-DENY.) |
| **Контент** | **Стриминг байтов через ядро / постоянный публичный URL объекта** | Постоянный публичный URL = контент мимо PDP навсегда (NF-5 нарушен); стриминг через ядро — ядро как узкое место (T-0119 §3 уже отверг). **presign-after-allow** (T-0119): ни байта без предшествующего allow, presign короткого TTL, постоянных URL нет — тот же путь, не второй механизм. |
| **Учётка** | **Завести внешнему лёгкую Keycloak-учётку / гостевой realm-аккаунт** | Прямо противоречит решению фаундера (внешний = данные, НЕ учётка) и tenancy §6 (identity не расширяется на внешних); гость-аккаунт = federation/IdP-сложность + lifecycle учёток для разовых QR-сканов. Внешний несёт **токен**, не сессию ядра (FR-1). |
| **Таблица аудита** | **Отдельная `external_access_log` таблица** | Второй append-only/isolation/chain код-путь + вторая 152-ФЗ/GDPR-история (дрейф, T-0016 §2 запрещает). Действия внешнего — **строки `audit_event`** с open-vocab `external.*` (как `grant.*`/`file.*` — строки, не таблицы). |

Ни одна не переоткрывает решение фаундера; это стандартные альтернативы делегированного
неаутентифицированного доступа, зафиксированные для аудируемости выбора.

---

## 4. Object model & contracts

> Postgres-типы авторитетны; TS-зеркало следует конвенции T-0014 (camelCase; `string` для `uuid`;
> `number` для `bigint`; `Buffer`/hex для `bytea`). Обе таблицы — обычные T-0013 tenant-таблицы,
> заносятся в `known_tenant_tables.txt`: `external_surface`, `external_token`. Синтетическая роль —
> обычная `role`-строка (T-0022) с `is_external = true` (новый булев флаг на `role`, как `is_system`).

### 4.1 `external_surface` — декларативная конфигурация доступа (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity |
| `external_role_id` | `uuid NOT NULL` | FK `(tenant_id, external_role_id) → role(tenant_id, id)` — синтетическая `is_external`-роль-принципал; держатель грантов поверхности |
| `target_ref` | `jsonb NOT NULL` | `ResourceRef` записи-цели (T-0014 §5; `record`-kind day-1); узкий scope, не «весь реестр» |
| `actions` | `text[] NOT NULL` | закрытый набор ⊆ `{download, verify, upload}`; CHECK на подмножество |
| `facet` | `jsonb NULL` | опубликованный срез полей для verify; absent/пусто ⇒ deny-by-default (не «всё») |
| `doc_mode` | `text NOT NULL DEFAULT 'snapshot'` | CHECK ∈ `{snapshot, live}` — снапшот (T-0119) vs явно «живой документ» (gap-map §4б инвариант 1); недвусмысленно |
| `max_uses` | `integer NULL` | NULL ⇒ многоразовый; ≥1 ⇒ лимит использований |
| `use_count` | `integer NOT NULL DEFAULT 0` | атомарный инкремент при успешном действии |
| `valid_from` | `bigint NULL` | epoch ms; материализуется в грант (T-0018) |
| `valid_until` | `bigint NULL` | epoch ms; out-of-window ⇒ ноль capability (action-time) |
| `revoked_at` | `bigint NULL` | немедленный отзыв на следующем resolve |
| `created_by` | `text NOT NULL` | выдавший принципал (трассировка «кто выдал») |
| `created_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; FK `(tenant_id, external_role_id)`; index `(tenant_id, external_role_id)` |

### 4.2 `external_token` — секрет-носитель (только хэш) (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity токена (для аудита/ротации; НЕ секрет) |
| `surface_id` | `uuid NOT NULL` | FK `(tenant_id, surface_id) → external_surface(tenant_id, id)` |
| `token_hash` | `bytea NOT NULL` | `sha256(secret)` (32 байта); **plaintext НИКОГДА** |
| `created_by` | `text NOT NULL` | актор выпуска |
| `created_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; FK `(tenant_id, surface_id)`; UNIQUE `(tenant_id, token_hash)`; lookup-индекс на `token_hash` (для tenant-вывода §2.4) |

### 4.3 Contracts (signatures — impl реализует; ADR фиксирует форму)

```ts
// Mint: создать поверхность + синтетическую роль + ОДИН/несколько grant-строк (T-0018)
// через validateNarrowing против гранта выдавшего. Возвращает ОДНОКРАТНО plaintext-секрет
// (далее только хэш). Грант — обычная grant-строка; нового authority-стораджа нет.
export function mintExternalSurface(
  deps: { grants: GrantWriter; roles: RoleWriter; ancestry: AncestryOracle; now: () => number },
  granter: ResolveSubject,                 // выдающий принципал (его scope ограничивает subset gate)
  cfg: {
    targetRef: ResourceRef;                // запись-цель (T-0014)
    actions: ReadonlyArray<"download" | "verify" | "upload">;
    facet?: Facet;                         // опубликованный срез (verify)
    docMode: "snapshot" | "live";
    maxUses?: number;
    validFrom?: number; validUntil?: number;
  },
): Promise<
  | { ok: false; reason: "scope_widens" | "facet_widens" | "not_granter" }   // subset gate (T-0018)
  | { ok: false; reason: "no_grant" }
  | { ok: true; surfaceId: string; secret: string }                          // secret — ТОЛЬКО здесь
>;

// Хэш секрета — единственная функция, считающая token_hash; sha256 фиксирован.
export function hashToken(secret: string): Buffer; // => sha256(secret), 32 bytes

// Tenant-вывод: единственный pre-tenant-context lookup. Возвращает ТОЛЬКО (tenant, surface) —
// ни байта прикладных данных. На отсутствие/несоответствие — null (вызывающий ⇒ uniform deny).
export function resolveTenantByToken(
  lookup: TokenLookupPort,                 // роль choros_token_lookup; читает лишь (tenant_id, surface_id) по token_hash
  secret: string,
): Promise<{ tenantId: string; surfaceId: string } | null>;

// Единый вход внешнего действия. Внутри: (1) resolveTenantByToken → (2) SET tenant-контекст →
// (3) валидация поверхности (effective/не отозвана/в окне/use_count<max_uses) →
// (4) PDP resolveFor / presign-after-allow (T-0119) → (5) audit (успех И отказ).
// Любой неуспех ⇒ единообразный uniform deny наружу (внутренний reason только в аудит).
export function handleExternalAction(
  deps: ExternalDeps,                      // resolver (T-0021), files (T-0119), audit (T-0016), rateLimit, surfaceSource
  secret: string,
  action: "download" | "verify" | "upload",
  body?: UploadBody,                       // только для upload (с declared-лимитами)
): Promise<
  | { denied: true }                       // UNIFORM — без причины наружу (§2.7)
  | { denied: false; kind: "download"; url: string; expiresAt: number }
  | { denied: false; kind: "verify"; fields: Record<string, unknown> }       // projectFields (скрытые отсутствуют)
  | { denied: false; kind: "upload"; versionId: string }
>;
```

### 4.4 Авторизационная последовательность (несущая — повторяет T-0021/T-0119, без нового пути)

1. **Token→tenant (pre-context):** `h = hashToken(secret)`; `resolveTenantByToken` через
   `choros_token_lookup` (только `(tenant_id, surface_id)`); `null` ⇒ **uniform deny** (нет утечки).
2. **Set tenant-контекст fail-closed** (tenancy §9 п.7): `SET LOCAL choros.tenant_id`; дальше всё под RLS.
3. **Валидация поверхности (под RLS):** `external_surface` найдена, `revoked_at IS NULL`, `now`
   в окне, `action ∈ actions`, `use_count < max_uses` (если задан). Любой провал ⇒ **uniform deny** + аудит.
4. **PDP-allow по записи-цели:** `resolveFor(handleOf(target_ref), {tenantId, subjectId: external_role_id}, op)`
   (op по §2.5). `{denied:true}` ⇒ **uniform deny** + аудит. Это **тот же резолвер** — никакого внешнего код-пути.
5. **Действие только при allow:** download → `getFileContentUrl` (T-0119, presign после allow);
   verify → `projectFields`; upload → `addVersion` (T-0119, declared-лимиты). Инкремент `use_count` атомарно.
6. **Аудит** (T-0016) — на каждом исходе (allow/deny), актор=поверхность, subject=запись-цель, секрет не пишется.

---

## 5. QR-кейс и контрагент-кейс — прогон через примитив (AC-15, требование фаундера)

**Контрагент-кейс (ТЭЛ §1/§2 — внешняя сторона по договору):**
1. Менеджер (выдающий принципал, имеет `read`+`update` на запись-договор) зовёт `mintExternalSurface`
   с `targetRef=<договор>`, `actions=["download","verify","upload"]`, `facet=<статус согласования>`,
   `validUntil=<срок>`. → `validateNarrowing`: `surface.scope ⊑ договор`, ops ⊆ выданных менеджеру,
   `facet ⊑` его права → **ok**; создаётся `is_external`-роль + grant-строки + токен; менеджер
   получает ссылку с секретом (отправляет контрагенту).
2. Контрагент по ссылке: `verify` → видит «статус: на согласовании» (только опубликованный срез,
   суммы/визы скрыты — **физически отсутствуют**); `download` → presign проекта договора (allow
   `read` → байты S3); `upload` → кладёт протокол разногласий (`update`, declared-лимит, T-0119).
3. Каждое действие — `external.*`-строка аудита (актор=`external-surface:<id>`, subject=договор).
   Срок вышел / менеджер отозвал → следующий resolve `no_grant` → **uniform deny**.
→ **Собрано конфигурацией одного примитива. Второго механизма прав нет; учётки нет.**

**QR-кейс (ТЭЛ §5 — анонимная валидация документа):**
1. При публикации документа: `mintExternalSurface` с `targetRef=<запись-документ>`,
   `actions=["verify","download"]`, `facet=<валидно/невалидно + публичные поля>`, `docMode="snapshot"`
   (ссылка указывает на иммутабельный снапшот T-0119) **или** `"live"` (явно «живой документ»),
   `maxUses=null`. Секрет → в QR (или handle T-0015 в QR).
2. Посетитель сканирует QR → `verify` → «валидно/невалидно» (узкий срез; verify не раскрывает
   скрытых полей); `download` → presign снапшота (воспроизводимый «вчерашний реестр») либо
   живого-документа-рендера (T-0124 потребляет этот контракт, рендер — там).
3. Действия в аудит; tenant выведен из токена, посетитель его не выбирал; cross-tenant неконструируем.
→ **Тот же примитив, другой набор `actions`/`facet`/`docMode`. Анонимно, без учётки, один механизм прав.**

**Вывод (ревью-гейт архитектора):** оба референс-кейса собираются из `external_surface`+`external_token`
конфигурацией (`actions`/`facet`/`docMode`/`valid_until`/`max_uses`); ни один не вводит второго
permission-подсистемы (право — производный grant, резолвит T-0021), ни один не создаёт учётку
(внешний = токен + запись-данные), ни один не нарушает tenancy (tenant из токена)/grant
(subset gate)/audit (строки, не таблица) инвариантов. **Направление фаундера (запись + внешняя
поверхность) проверено на обоих кейсах и держится.**

---

## 6. Fitness functions (CI gating — impl acceptance contract)

`gating`: **static-now** = лайнт/тип-чек/юнит, runnable в `npm run ci` после impl; **live-impl** =
проба, авторённая в impl-задаче, активируемая при Postgres+MinIO. **Каждый `ci/checks/*.sh` несёт
self-test (positive: посаженное нарушение детектится; negative: чистый/комментарий — нет); провал
self-теста ⇒ exit 2 (свежий урок: чек обязан УМЕТЬ падать).**

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-NOACL** | Нет второго механизма авторизации внешних: код/миграция не содержат `external_acl`/`public_share`/`share_rights`/`surface_visibility`/`*.visibility`-токенов; `external-surface.ts` не вычисляет права сам, а зовёт `resolveFor`/`getFileContentUrl` (T-0021/T-0119); `external_surface.facet` идёт **аргументом** гранта, не как authority-store. | `bash ci/checks/external-surface-isolation.sh`: grep forbidden tokens в `migrations/0NN_external_surface.sql` + `src/core/external-surface.ts`; assert вызов `resolveFor\|getFileContentUrl` присутствует, собственного grant-фильтра нет. **Self-test:** plant `external_acl` строку ⇒ детект; comment-only mention ⇒ ignore. | static-now |
| **FF-DERIVED-GRANT** | Право внешнего = материализованная `grant`-строка через `validateNarrowing` (T-0018), не ad-hoc resolve-time деривация: `mintExternalSurface` зовёт `validateNarrowing` и пишет `grant`; PDP-путь не знает про `external_surface` как authority-source. | `bash ci/checks/external-surface-isolation.sh`: assert `mintExternalSurface` вызывает `validateNarrowing` + `grant`-write; assert `grant-resolver.ts` НЕ импортирует `external_surface`. **Self-test:** stub без `validateNarrowing` ⇒ детект. | static-now |
| **FF-TOKEN-HASH** | Токен — высокоэнтропийный секрет, хранится только хэшем: миграция `external_token` имеет `token_hash bytea`, НЕ `token_plaintext`/`secret text`; `hashToken` = единственный конструктор хэша (`sha256`, ≥256-бит вход); plaintext не логируется. | `grep -iE 'token_plaintext|secret[_ ]?text|plaintext' migrations/0NN_*.sql` ⇒ 0; assert `token_hash bytea`; assert ровно один `export function hashToken`. **Self-test:** plant `secret_text text` колонку ⇒ детект; `token_hash` ⇒ pass. | static-now |
| **FF-TENANT-FROM-TOKEN** | Tenant выводится из токена, не из запроса: `handleExternalAction`/эндпоинт не принимает tenant-параметр; `resolveTenantByToken` — единственный pre-context lookup, отдаёт лишь `(tenantId, surfaceId)`. | `bash ci/checks/external-surface-isolation.sh`: grep что обработчик не читает `tenant_id` из тела/query; assert `resolveTenantByToken` тип возвращает только `{tenantId, surfaceId}`. **Self-test:** plant `req.body.tenant_id` чтение ⇒ детект. | static-now |
| **FF-UNIFORM-DENY** | Анти-оракул: все неуспехи (нет токена/истёк/отозван/исчерпан/cross-tenant/нет записи) дают байт-идентичный внешний отказ `{denied:true}` без reason наружу; внутренний reason идёт ТОЛЬКО в аудит. | unit: 6 deny-веток ⇒ deep-equal внешний результат (`{denied:true}`, без поля reason); reason присутствует в эмитированном `audit_event`, не в ответе. `vitest run … -t "uniform-deny"`. | static-now |
| **FF-PRESIGN-AFTER-ALLOW** | download внешнего — presign только после allow: при `{denied:true}` от `resolveFor` НЕ зовётся `presignGet`; verify не отдаёт скрытых полей (`projectFields` — отсутствуют, не null). | unit: мок-резолвер deny ⇒ `getFileContentUrl`/`presignGet` не вызван; allow ⇒ presign с `ttl ≤ 300`; verify скрытое поле физически отсутствует. `vitest run … -t "presign-after-allow|verify-projection"`. | static-now |
| **FF-FAILCLOSED** | Fail-closed tenant-контекст: без установленного tenant (token не найден/нет контекста) presign/verify/upload отказывают, ноль обращений к данным; tenant ставится ДО прикладного доступа. | unit: `resolveTenantByToken→null` ⇒ uniform deny, ноль вызовов `resolver`/`files`; assert порядок (set-context перед resolveFor). `vitest run … -t "fail-closed"`. | static-now |
| **FF-ACTIONS-CLOSED** | Набор действий закрыт day-1: `actions` ⊆ `{download, verify, upload}` (CHECK в миграции + тип-юнион в TS); неизвестное действие ⇒ отказ, не «новый примитив». | `grep` CHECK-constraint на `actions` в миграции; `tsc --noEmit` на юнионе `"download"|"verify"|"upload"`. **Self-test:** plant `actions` без CHECK ⇒ детект. | static-now |
| **FF-AUDIT-EVENTS** | Аудит на каждое действие (успех И отказ): `external.{download,verify,upload,deny,throttle}` = строки `audit_event` (open-vocab, новых таблиц нет); `actor=external-surface:<id>`, `subject=target_ref`, секрет НЕ в payload; `known_tenant_tables` не получает audit-дубль. | unit: каждый исход эмитит ожидаемое `audit_event`; assert нет `token_hash`/секрета в `payload`; assert нет `external_access_log` таблицы. `vitest run … -t "audit-events"`. | static-now |
| **FF-T13** | T-0013-контракт: `external_surface`/`external_token` — `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id`, `choros_app` DML-only, занесены в `known_tenant_tables.txt`. `choros_token_lookup` — отдельная роль ТОЛЬКО с SELECT `(tenant_id, surface_id)` по `token_hash`, без доступа к данным. | существующие T-0013/T-0115 пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) на новых таблицах после внесения в фикстуру; assert grants `choros_token_lookup` минимальны. | live-impl (T-0013 apparatus) |
| **FF-EXTERNAL-SCOPE** | Post-impl (AC-11): валидный токен даёт доступ РОВНО к опубликованному срезу (download/verify/upload) и НИ к чему шире; операция вне `actions` или поле вне `facet` ⇒ `no_grant`/отсутствует; решает PDP T-0021. | live-impl probe: seed запись+поверхность, предъявить токен, assert allow на опубликованном, deny/absent вне его; проверить через `makeGrantResolver`. | live-impl |
| **FF-EXTERNAL-TTL-REVOKE** | Post-impl (AC-12): истёкший/отозванный/исчерпанный токен ⇒ uniform deny на следующем resolve; до отзыва — доступ, после — немедленно нет (action-time, без mint-time снапшота). | live-impl probe: токен работает t0; `revoked_at`/просрочка/`use_count≥max_uses` ⇒ t1 deny; assert no capability. | live-impl |
| **FF-EXTERNAL-CROSS-TENANT** | Post-impl (AC-13): токен tenant B в любом эндпоинте ⇒ резолвится в контекст B, запись A недостижима; ни байта контента A; tenant из токена, не из запроса. | live-impl probe (стиль `ci/checks/db/cross_tenant.test.ts`): предъявить токен B, попытаться достать запись A ⇒ deny/cross-context; assert presign A не выпущен. | live-impl |
| **FF-EXTERNAL-AUDIT-LIVE** | Post-impl (AC-14): каждое действие (вкл. отказ при неверном/истёкшем токене) ⇒ ожидаемое `audit_event` (actor=поверхность, subject=запись, tenant-scoped); секрет в событии отсутствует. | live-impl probe: выполнить download/verify/upload + deny-ветку, assert строки `audit_event` с верными actor/subject, без секрета. | live-impl |

---

## 7. Traceability (FR/AC → design)

| AC / FR | covered_by |
|---|---|
| AC-1 / FR-1 | §2.1 (внешний = `record` T-0014, НЕ учётка; identity §6 не расширяется); §3 (rejected: Keycloak-учётка) |
| AC-2 / FR-2 | §2.2 (`external_surface`/`external_token`, target_ref/actions/facet/токен); §4.1/§4.2 |
| AC-3 / FR-3 / NF-1 | §2.3 (производный grant, subset gate, delegable=false, тот же PDP); §4.3 `mintExternalSurface`; §4.4 step4; FF-NOACL, FF-DERIVED-GRANT; §3 (rejected: external_acl, ad-hoc-грант) |
| AC-4 / NF-1 | §2.3 (запрет второго механизма); FF-NOACL; §3 (rejected: external_acl) |
| AC-5 / FR-4 / NF-4 | §2.6 (TTL через valid_from/until, отзыв action-time, одноразовость max_uses); §4.1; FF-EXTERNAL-TTL-REVOKE |
| AC-6 / FR-5 / NF-3/NF-5 | §2.5 (три op-отображения, presign-after-allow, facet-срез, declared-лимиты, набор закрыт); §4.4 step5; FF-PRESIGN-AFTER-ALLOW, FF-ACTIONS-CLOSED, FF-EXTERNAL-SCOPE |
| AC-7 / FR-6 / NF-7 | §2.8 (актор-без-учётки, open-vocab external.*, секрет не пишется, трассируемость кто-выдал↔что-сделал); FF-AUDIT-EVENTS, FF-EXTERNAL-AUDIT-LIVE; §3 (rejected: отдельная таблица) |
| AC-8 / FR-7 / NF-2 | §2.4 (tenant из токена, choros_token_lookup, fail-closed контекст); §4.1/§4.2 (T-0013-контракт); FF-TENANT-FROM-TOKEN, FF-FAILCLOSED, FF-T13, FF-EXTERNAL-CROSS-TENANT; §3 (rejected: tenant в открытом токене) |
| AC-9 / FR-8 / NF-6 | §2.7 (энтропия+хэш, константное сравнение, rate-limit, uniform deny, declared-лимиты); FF-TOKEN-HASH, FF-UNIFORM-DENY; §3 (rejected: plaintext, дифф-отказ) |
| AC-10 / FR-9 | §2.9 (QR через verify+download, snapshot/live недвусмысленно, рендер→T-0124); §4.1 `doc_mode`; §5 (прогон) |
| AC-11 | §2.3/§2.5 (ровно опубликованный срез, PDP тот же); FF-EXTERNAL-SCOPE |
| AC-12 | §2.6 (action-time TTL/revoke/исчерпание); FF-EXTERNAL-TTL-REVOKE |
| AC-13 | §2.4 (tenant из токена, cross-tenant неконструируем); FF-EXTERNAL-CROSS-TENANT |
| AC-14 | §2.8 (аудит каждого исхода, секрет не пишется); FF-EXTERNAL-AUDIT-LIVE |
| AC-15 | §5 (прогон QR + контрагент кейсов через примитив, без второго механизма/учётки); §3 (все rejected против инвариантов); ревью-гейт архитектора (этот §) |

---

## 8. Runtime target

**Дев-стек / контейнер.** Метаданные — Postgres-в-compose (T-0053/T-0114, уже на dev). Контент —
S3-совместимый MinIO (T-0119, дев-стек). Внешние эндпоинты — тот же Node-процесс ядра (новый узкий
HTTP-маршрут без Keycloak-сессии). Всё в рамках автономии — не требует денег/новых внешних ресурсов
поверх уже провижненных Postgres+MinIO.

**Развилка уровня фаундера (НЕ решается здесь, зафиксирована как deploy-time параметр):**
**анти-DoS-бюджет и дефолтные пороги rate-limit / TTL внешней ссылки** для prod — это операционная
политика (сколько запросов/мин на токен/IP/tenant, дефолтный срок жизни публичной ссылки), которая
взаимодействует с реальным трафиком, стоимостью egress и risk-аппетитом фаундера к публичной
поверхности. ADR закладывает **гейт как механизм** (§2.7, per-token/IP/tenant throttle + uniform
deny), а конкретные **пороги/окна/бюджет = deploy-time env** (`EXTERNAL_RATE_*`, `EXTERNAL_LINK_TTL_DEFAULT`),
не код. Это не открывает продуктовую развилку (механизм инвариантен) и не блокирует impl
(дев-дефолты достаточны для тестов). Подключение публичной поверхности к интернету в prod —
гейт фаундера (GT-4), как prod-сервер.

## 9. Compatibility notes (architect rule 7)

- **Implements, does not change, T-0021.** Внешний резолв переиспользует `resolveFor`/`makeGrantResolver`
  и reason-union verbatim; новых reason-значений, новой permission-функции, нового handle→fields-ребра
  НЕ вводится (honors `single-resolver.sh`, T-0021 FF-R5/R6). `ResolveSubject` остаётся identity-only —
  внешний субъект = `{tenantId, subjectId: external_role_id}`, без caller-kind флага.
- **Implements, does not change, T-0119.** download/upload идут через `getFileContentUrl`/`addVersion`
  verbatim (presign-after-allow, declared-лимиты); путь контента — производный грант, не второй механизм
  (T-0119 §2.5 явно это предусмотрел).
- **Honors T-0018 §2 / NF-1:** право внешнего = `grant`-строка, прошедшая `validateNarrowing`;
  FF-NOACL греп-лайнтит параллельный authority-store (`external_acl`/`public_share`/`visibility`).
  Грант привязан к `is_external`-роли (T-0018: грант на роль, не на личность).
- **Honors T-0013/T-0115:** `external_surface`/`external_token` — обычные tenant-таблицы; внесение в
  `known_tenant_tables.txt` — единственное (ожидаемое) изменение фикстуры. Роль `choros_token_lookup` —
  единственное расширение ролевой посадки: минимальный SELECT на `(tenant_id, surface_id)` по `token_hash`,
  без доступа к прикладным данным (FF-T13). Это легитимное добавление, не нарушение
  `grant-trail-no-new-table.sh` (та проба специфична T-0031).
- **Honors T-0016:** действия внешнего = строки `audit_event` с open-vocab `type` (`external.*`);
  новых аудит-таблиц нет (как `grant.*`/`file.*` — строки, не таблицы).
- **Новый булев флаг `role.is_external`** (как `registry_def.is_system`): аддитивная колонка на `role`
  (T-0022); существующие экспорты/пробы `role` не ломаются (ставится только при mint поверхности).

## 10. Escalation

None для DESIGN-объёма. Все пять внутри-DESIGN развилок решены (§2.3/§2.4/§2.6/§2.8 + §3):
материализованный grant mint-time, синтетическая `is_external`-роль-принципал, tenant-из-хэша-токена,
актор-аудита-от-поверхности, max_uses-атрибут. Единственная развилка уровня фаундера —
**анти-DoS/rate-limit-бюджет + TTL-дефолт публичной ссылки** — вынесена как **deploy-time параметр**
(§8): механизм инвариантен (throttle + uniform deny), пороги = env. Не блокирует impl (дев-дефолты),
не открывает продуктовую развилку, не требует кросс-вендор-петли. Подключение публичной поверхности
в prod = GT-4 (как prod-сервер).
