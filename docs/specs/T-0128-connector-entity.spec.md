# Spec · T-0128 — Сущность «коннектор/интеграция» в модели данных (заглушка)

**Phase:** SPEC · **Status:** ready (no blocking questions)
**Date:** 2026-06-12
**Task:** T-0128 (product=choros, type=design, prio 40) — «Сущность „коннектор/интеграция"
в модели данных (заглушка под 1С/AD/почту — место в модели, реализация коннекторов позже)».

**Authoritative source (решение фаундера — НЕ переоткрывать):**
`playbooks/choros-product-gap-map.md` §2 envelope (строка «Коннекторы/интеграции») + §3а:
> **Коннекторы** → сейчас не делаем, сущность «коннектор» закладывается в модель
> (1С/AD/почта встают в готовое место).

Это терминальное направление фаундера. Объём задачи фиксирован им: **место в модели +
CRUD без живых драйверов**. Спека НЕ предлагает строить драйверы и НЕ переоткрывает «делать
ли коннекторы».

**Foundations / прецеденты (НЕ противоречить):**
- **T-0034** (`docs/specs/T-0034-external-effect.spec.md`, реализован) — `effect_resource`
  первокласс: `kind ∈ {integration_endpoint, messaging_channel, external_account}`,
  grant `resource_type='effect_resource', operation='invoke', scope=<endpoint-identity>`,
  gateway-верификация `verifyEffectGrants` в `resolveFor`. **Вызов внешнего = эффект-грант.**
  Коннектор — это *конфигурируемая, несущая секрет* сущность, которая **бэкит**
  effect_resource; сам грант-механизм вызова остаётся за T-0034, не дублируется.
- **T-0025** (`docs/specs/T-0025-byo-llm-secret-custody.spec.md`, реализован) — паттерн
  RL-3 custody секрет-хэндла: opaque-токен (не сырой ключ), shape-guard
  (`validateSecretHandleShape`), redaction (`redactHandle`), аудит-без-значения,
  `SecretResolverPort`-seam (резолв только в worker-контексте Stage-2). **Эталон custody
  секретов коннектора.**
- **T-0170** (`docs/specs/T-0170-notifications-email.spec.md`, реализован, в dev) —
  `email_channel_config` + `smtp_handle` custody (RL-3) + `SmtpSecretResolverPort`. Это
  **живой прецедент «коннектор-подобной» сущности**. Red-line задачи: **НЕ ломать T-0170**
  (см. FR-7, NF-3, AC-9..AC-11).
- **T-0013** (tenant-isolation) — все tenant-таблицы: `tenant_id` ведущей колонкой PK,
  ENABLE+FORCE RLS, isolation-policy, `choros_app` grant, запись в `known_tenant_tables.txt`.
- **T-0016** (audit floor) — append-only `audit_event` для жизненного цикла коннектора.
- **T-0015** (object-handle) — конфиг/секрет коннектора custody-bound; сырые значения
  не текут в process-variables/connector-I/O (структурная опаковость).

**Downstream / Stage-2 (НЕ в скоупе):**
- Живые драйверы (1С/AD/SMTP/HTTP), реальные внешние вызовы, резолв секрета к реальному
  credential, проба связи (health-check), webhook-подписки — Stage-2 / производные задачи.
- `egress_policy` enforcement (T-0041), runtime бюджет/egress агента (E5.x Stage-2).

---

## 0. Что значит «коннектор как заглушка» (один экран)

Сегодня в модели есть **`effect_resource`** (T-0034) — *что* можно вызвать как внешний эффект
(грант-связанная identity эндпоинта). Чего НЕТ: первокласс **«чем именно подключаемся»** —
сущности, которая несёт *тип системы* (1С/AD/SMTP/…), *её конфигурацию* (хост, порт, БД,
realm — opaque jsonb), *custody секрета доступа* (по паттерну T-0025) и *статус подключения*
(декларативный, без живой пробы day-1).

Коннектор — это **конфигурационная, несущая секрет, tenant-изолированная запись**, в которую
позже «встанет» драйвер. Day-1 = **модель + CRUD + custody-shape + статус-поле**; **никаких
живых драйверов** — это явный red-line задачи и решение фаундера.

Разделение ответственности (фиксируется этой спекой, не переоткрывается):
- **`effect_resource` (T-0034)** = *цель вызова* + грант-точка (`invoke`). Остаётся как есть.
- **`connector` (T-0128)** = *как/чем* подключаемся (тип + конфиг + секрет + статус). Новое.
- Связь: коннектор **МОЖЕТ** ссылаться на/бэкить один или несколько effect_resource
  (вызов через коннектор = `invoke`-грант на соответствующий effect_resource, механика T-0034
  не дублируется). Точная форма связи (FK / логическая ссылка / поле `backs_effect_resource_id`)
  — **решение архитектора**; спека фиксирует только инвариант «вызов = эффект-грант T-0034,
  не второй механизм авторизации».

«Заглушка» НЕ означает «мёртвая таблица»: CRUD реально пишет/читает/удаляет конфиг и хэндл
(аналогично тому, как T-0025 разбудил custody-путь `agent_card`, не разбудив runtime).

---

## 1. Summary

Завести первокласс tenant-сущность **`connector`** в модели данных Choros: тип подключаемой
системы (закрытый, расширяемый набор: `1c` / `ad_ldap` / `smtp` / `http_generic` / …),
opaque-конфиг, custody секрета доступа по RL-3-паттерну T-0025 (opaque-хэндл, shape-guard,
redaction, аудит-без-значения), и декларативный статус подключения. Поставить **CRUD**
(create/update/revoke/get-status) под tenant-RLS и аудит, **без единого живого драйвера** и без
реальных внешних вызовов. Зафиксировать **seam**, в который позже встают драйверы (резолвер
секрета + порт драйвера — по образцу `SmtpSecretResolverPort`/`SmtpSenderPort` из T-0170), и
**связь с эффект-грантами T-0034** (вызов коннектора = `invoke`-грант на effect_resource).
Существующий `email_channel_config` (T-0170) **не ломается** и **не мигрирует принудительно**:
коннектор-модель сосуществует с ним; возможная конвергенция (email как частный случай коннектора)
— Stage-2, не day-1.

Это **design-задача**: выход — ADR + типы/DDL-эскиз + seam-контракт, не работающий драйвер.

---

## 2. Functional requirements

- **FR-1 — `connector` — первокласс tenant-сущность.** Хранится в таблице `connector`
  (имя/номер миграции — решение архитектора) со столбцами как минимум: `tenant_id` (ведущий
  PK, T-0013), `id` (uuid), `kind` (тип системы, закрытый CHECK-набор), `display_name`,
  `config` (opaque jsonb — хост/порт/БД/realm/base_url и т.п.; **не используется в решении
  авторизации**), `secret_handle` (RL-3 opaque-хэндл, nullable), `status` (см. FR-4),
  `created_at`. Запись существует независимо от наличия драйвера.

- **FR-2 — `kind` — закрытый, но расширяемый набор.** `kind` — закрытое множество, заданное
  CHECK-констрейнтом + TypeScript-юнионом; день-1 включает заглушки под решение фаундера:
  `1c`, `ad_ldap`, `smtp`, `http_generic` (точный начальный список — решение архитектора, но
  ОБЯЗАН покрывать 1С/AD/почту из формулировки фаундера). Неизвестный `kind` отвергается
  fail-closed (на CRUD-входе и на чтении). Добавление нового `kind` позже = миграция CHECK +
  расширение юниона (тот же приём, что закрытый `EffectKind` T-0034).

- **FR-3 — Custody секрета по паттерну T-0025 (НЕ второй механизм).** `secret_handle`
  коннектора — opaque RL-3 хэндл (ссылка на client-hosted credential, никогда не сырой ключ).
  CRUD ПЕРЕИСПОЛЬЗУЕТ примитивы T-0025: shape-guard (`validateSecretHandleShape`-совместимый)
  на set/rotate, `redactHandle` на status-путях, `SecretResolverPort`-структурно-совместимый
  seam для будущего резолва. Платформа не декодирует и не использует хэндл day-1. Сырой секрет
  никогда не появляется в response/log/audit/exception (см. NF-1). **Не вводить новый custody-
  механизм** — переиспользовать существующий.

- **FR-4 — Статус подключения — декларативный day-1.** Поле `status ∈ {configured,
  disabled, error}` (точный набор — архитектор; ОБЯЗАН различать «настроен/готов к подключению»
  и «выключен»). Day-1 статус выставляется **CRUD-операциями и явной admin-командой**, НЕ живой
  пробой связи. Health-check/реальная проба доступности — Stage-2 (out of scope). `status` —
  это место, куда драйвер позже будет писать результат пробы.

- **FR-5 — CRUD под грантом и аудитом.** Операции `setConnector` (create/update),
  `rotateConnectorSecret`, `revokeConnector` (или `disableConnector`), `getConnectorStatus`,
  `listConnectors`. Мутирующие операции:
  (а) требуют management-грант на tenant/org-скоуп коннектора (через grant-resolver T-0021;
      точный mgmt-объект — архитектор; модель — как T-0025 FR-1 `mgmt_object`);
  (б) валидируют `secret_handle` shape-guard'ом до записи (если хэндл задан);
  (в) пишут под `SET LOCAL choros.tenant_id` (FORCE RLS, T-0013);
  (г) эмитят `audit_event` (`connector.set` / `connector.rotate` / `connector.revoke`),
      payload несёт `kind`/`display_name`/неоткрытую часть конфига, **НИКОГДА** — `secret_handle`
      или resolved-секрет.
  `getConnectorStatus`/`listConnectors` возвращают `redactHandle(secret_handle)`, не сырой хэндл.

- **FR-6 — Связь с эффект-грантами (T-0034) — единый механизм вызова.** Вызов внешней системы
  через коннектор = `invoke`-грант на соответствующий `effect_resource` (T-0034), **а не новый
  тип права на сам `connector`**. Коннектор МОЖЕТ декларативно ссылаться на effect_resource,
  который он бэкит (форма ссылки — архитектор), но *авторизация вызова* остаётся за T-0034
  (`verifyEffectGrants` в `resolveFor`). Спека ЗАПРЕЩАЕТ вводить параллельную «connector-ACL»/
  «connectorRights» поверхность. Сам по себе `connector` — конфигурационная запись; *право
  вызвать* живёт в грант-решётке через effect_resource. (Инвариант «один механизм прав» — §4б.2
  gap-map.)

- **FR-7 — `email_channel_config` (T-0170) НЕ ломается и НЕ мигрирует принудительно.**
  Введение `connector` НЕ изменяет схему `email_channel_config`, НЕ удаляет её, НЕ перенаправляет
  T-0170-код. Email-канал продолжает работать через `email_channel_config` + `smtp_handle` +
  `SmtpSecretResolverPort` без изменений. Коннектор-модель **сосуществует** с
  `email_channel_config`. Спека фиксирует требованием: будущая конвергенция (email/SMTP как
  частный случай `kind='smtp'` коннектора) — **отдельная Stage-2 задача**, не day-1; до неё две
  сущности живут параллельно. (Red-line задачи: «НЕ ломать T-0170».) ADR ОБЯЗАН явно описать,
  почему принудительная миграция T-0170 отвергается, и зафиксировать путь будущей конвергенции
  как not-now.

- **FR-8 — Seam для драйверов (без драйверов day-1).** ADR фиксирует **место**, куда позже
  встают драйверы, по образцу T-0170: (а) `ConnectorSecretResolverPort` (структурно совместим с
  T-0025 `SecretResolverPort`) — резолв `secret_handle` только в worker-контексте Stage-2;
  (б) `ConnectorDriverPort` (по образцу `SmtpSenderPort`/`ChannelDriver`) — инжектируемый порт
  с методом-вызовом, **без day-1 реализации**. Day-1 в репо нет ни одного класса-драйвера и ни
  одного реального внешнего вызова из connector-пути (fail-closed заглушка/`denyAll`-аналог).

- **FR-9 — Tenant-изоляция.** `connector` — per-tenant: `tenant_id` ведущей колонкой PK,
  ENABLE+FORCE RLS, `<table>_tenant_isolation` policy на `current_setting('choros.tenant_id',
  true)::uuid`, `GRANT ... TO choros_app`, имя таблицы в `ci/checks/known_tenant_tables.txt`.
  Коннектор tenant'а A невидим/недоступен сессии tenant'а B (как любая T-0013-таблица).

---

## 3. Non-functional requirements

- **NF-1 — Сырой секрет никогда не покидает платформу.** `secret_handle`-значение (и любой
  resolved-секрет) НЕ появляется в HTTP-ответах, логах (`console.*`, structured-log),
  payload'ах `audit_event`, текстах исключений. Status-путь возвращает `redactHandle(...)`.
  (Эталон: T-0025 NF-1, T-0170 NF-1.)

- **NF-2 — Заглушка без живых эффектов.** Ни один code-path T-0128 НЕ инициирует реальный
  внешний вызов (нет `fetch`/`net`/SMTP/LDAP-вызовов в connector core). Платформа операбельна
  с нулём настроенных коннекторов и с коннекторами без драйверов. (Эталон: T-0034 «NOT day-1:
  runtime execution of connectors», T-0025 FR-6.)

- **NF-3 — `email_channel_config` нетронут.** Коммит T-0128 НЕ модифицирует
  `email_channel_config`-схему, `notification-email.ts`, `notification-router.ts`, миграции
  T-0168 и связанный T-0170-код. `git diff` по этим файлам/таблицам — чист.

- **NF-4 — Один механизм прав, один механизм custody.** НЕТ параллельной connector-ACL/
  visibility-поверхности (право вызова = effect-грант T-0034). НЕТ нового secret-custody-
  механизма (переиспользование T-0025-примитивов). НЕТ второго dispatch/resolver-механизма.

- **NF-5 — Pure-core / IO за портами.** Connector core-модуль не импортирует `pg`/`fs`/`net`/
  `http`/`fetch` напрямую; весь IO (хранилище конфига, будущий резолвер секрета, будущий драйвер)
  — за инжектируемыми портами (как T-0034 `EffectSource`, T-0170 `SmtpSenderPort`). Чистые
  функции детерминированы.

- **NF-6 — Без новых зависимостей.** T-0128 НЕ добавляет в `package.json` SDK/клиентов 1С/AD/
  LDAP/SMTP/HTTP. `node_modules` остаётся без driver-библиотек (они приходят со Stage-2
  драйверами).

- **NF-7 — `tsc --noEmit` зелёный, фитнес зелёный.** Новый TS компилируется чисто; новый
  isolation-чек (`ci/checks/connector-isolation.sh` или аналог) зелёный; существующий фитнес-
  суит без регрессий.

---

## 4. Out of scope (явные не-цели)

- **Любой живой драйвер** (1С/AD-LDAP/SMTP/HTTP) и реальный внешний вызов — Stage-2 / производные.
- **Health-check / живая проба связи** — `status` day-1 декларативный; проба — Stage-2.
- **Резолв `secret_handle` к реальному credential** и его использование драйвером — Stage-2
  (как T-0025 FR-4 / C-2).
- **Принудительная миграция `email_channel_config` под connector-модель** — отдельная Stage-2
  задача конвергенции; day-1 две сущности сосуществуют (FR-7).
- **Webhook-подписки, входящие коннекторы, маппинг полей/трансформации** — не MVP.
- **`egress_policy` enforcement / runtime бюджет-egress агента** — T-0041 / Stage-2.
- **Дублирование грант-механики T-0034** — вызов остаётся `invoke`-грантом на effect_resource.
- **UI управления коннекторами** — фронтенд-задача; спека покрывает модель + контракт CRUD.
- **Postgres-DAO порта хранилища** — может быть отложен (T-0053-паттерн), решает архитектор.

---

## 5. Acceptance criteria (свойства будущего ADR + проверяемые на impl)

| ID | Текст | verifiable_as |
|---|---|---|
| AC-1 | ADR вводит первокласс tenant-сущность `connector` со столбцами ≥ `{tenant_id, id, kind, display_name, config(jsonb), secret_handle(nullable), status, created_at}`; `tenant_id` — ведущая колонка PK. Типы/DDL-эскиз присутствуют в ADR. | manual |
| AC-2 | `kind` — закрытое множество (CHECK + TS-юнион), включающее минимум покрытие 1С/AD/почты (`1c`, `ad_ldap`, `smtp`, `http_generic` или эквивалент); неизвестный `kind` отвергается fail-closed на CRUD-входе. Юнит-тест: `setConnector` с `kind='__bogus__'` → ошибка, запись не происходит. | test |
| AC-3 | Custody переиспользует T-0025: `setConnector`/`rotateConnectorSecret` с raw-секретом (`sk-…` / bare-hex-32+ / JWT-shape) → отказ shape-guard, запись хэндла не происходит. Юнит-тест по образцу T-0025 AC-2..AC-6 / T-0170 AC-4. | test |
| AC-4 | `getConnectorStatus`/`listConnectors` возвращают `redactHandle(secret_handle)` (или `{bound:false}`), НЕ сырой хэндл. Полное значение `secret_handle` не возвращается ни одним эндпоинтом. Юнит-тест. | test |
| AC-5 | Каждая мутирующая CRUD-операция эмитит `audit_event` (`connector.set`/`connector.rotate`/`connector.revoke`) с `subject`=connector id и `kind`/`display_name` в payload; ни одно поле аудита не содержит `secret_handle`/resolved-секрет. Юнит-тест по образцу T-0025 AC-12, T-0170 AC-6. | test |
| AC-6 | `status` day-1 устанавливается CRUD/admin-командой, не живой пробой; ADR явно помечает health-check как Stage-2. Тест: создание коннектора без драйвера → `status` валиден, ни одного внешнего вызова не сделано. | test |
| AC-7 | Связь вызова с T-0034: ADR фиксирует, что вызов через коннектор = `invoke`-грант на `effect_resource` (T-0034), без нового типа права на `connector` и без параллельной connector-ACL поверхности. Fitness: `ci/checks/connector-isolation.sh` банит токены `_acl`/`connector_visibility`/`connectorRights`/`connectorAcl` в connector core. | fitness |
| AC-8 | Seam без драйверов: ADR определяет `ConnectorSecretResolverPort` (структурно совместим с T-0025 `SecretResolverPort` под `tsc`) и `ConnectorDriverPort` (по образцу T-0170 `SmtpSenderPort`), НО day-1 в репо нет ни одного класса-драйвера и ни одного реального внешнего вызова из connector-пути. Fitness: `grep` по connector core не находит `fetch`/`net`/`http`/SMTP/LDAP-вызовов; компиляция порт-совместимости проходит. | fitness |
| AC-9 | `email_channel_config` (T-0170) не сломан: коммит T-0128 НЕ изменяет `email_channel_config`-схему, `notification-email.ts`, `notification-router.ts`, миграции T-0168. `git diff dev` по этим путям — чист. | fitness |
| AC-10 | После мержа T-0128 существующий T-0170-суит (email-канал) проходит без изменений; никакой connector-код не перехватывает email-доставку. Fitness: `npm test` + `notification-email.sh` зелёные. | fitness |
| AC-11 | ADR явно описывает, почему принудительная миграция `email_channel_config` отвергается day-1, и фиксирует путь будущей конвергенции (email как `kind='smtp'`) как Stage-2 not-now. | manual |
| AC-12 | `connector` — tenant-таблица: `tenant_id` ведущий PK, ENABLE+FORCE RLS, `<table>_tenant_isolation` policy, `GRANT ... TO choros_app`, имя в `known_tenant_tables.txt`. Fitness: `force_rls.sql`+`tenant_id_leading.sql` = 0 строк; таблица в списке. | fitness |
| AC-13 | Cross-tenant изоляция: запрос коннектора tenant'а B в сессии tenant'а A возвращает 0 строк (red без RLS, green с FORCE). | fitness |
| AC-14 | Заглушка без живых эффектов: ни один T-0128 code-path не делает реального внешнего вызова; платформа операбельна с нулём коннекторов и с коннектором без драйвера. Fitness: `grep` connector core на отсутствие прямых `pg`/`fs`/`net`/`http`/`fetch`; `npm run fitness` зелёный. | fitness |
| AC-15 | Без новых driver-зависимостей: `package.json` не получает SDK/клиентов 1С/AD/LDAP/SMTP/HTTP в результате T-0128. Fitness: `git diff dev -- package.json` не добавляет driver-пакетов. | fitness |
| AC-16 | `tsc --noEmit` зелёный после T-0128; новый isolation-чек зелёный; существующий фитнес-суит без регрессий. | fitness |

---

## 6. Связи и инварианты (для архитектора)

- **T-0034 — не дублировать грант вызова.** `connector` бэкит effect_resource; *право вызвать*
  — `invoke`-грант на effect_resource. Не вводить право на `connector` как объект вызова.
- **T-0025/T-0170 — переиспользовать custody, не плодить.** `secret_handle` коннектора = тот же
  RL-3 паттерн (shape-guard, redaction, resolver-port). Один механизм custody на платформу.
- **T-0170 — сосуществование, не миграция.** Email остаётся на `email_channel_config`;
  конвергенция — Stage-2. (Прямой red-line задачи.)
- **Заглушка ≠ мёртвая таблица.** CRUD реально работает (custody-путь разбужен, как T-0025
  разбудил `agent_card`-custody); драйверы/runtime спят (как T-0025 не разбудил
  autonomy/budget runtime).
- **Один механизм прав / fail-closed.** §4б.2 gap-map: внешние принципалы и вызовы — внутри
  грант-модели, не второй авторизатор. Любая неясность `kind`/гранта → deny.

---

## 7. Blocking questions

**Нет.** Решение фаундера терминально и однозначно (gap-map §2 envelope + §3а):
«коннекторы сейчас не делаем, сущность закладываем (1С/AD/почта встают в готовое место)».
Объём — модель + CRUD без живых драйверов — задан этим решением. Red-line «не ломать T-0170»
снимает единственный потенциальный фор́к (миграция email): спека фиксирует сосуществование,
а конвергенцию явно откладывает в Stage-2 как not-now (FR-7, AC-11). Все остальные развилки
(точный начальный список `kind`, форма ссылки connector↔effect_resource, имя/номер миграции,
mgmt-объект гранта, отложить ли Postgres-DAO) — **зона архитектора**, не меняют объём/поведение
продукта и выводимы из прецедентов T-0034/T-0025/T-0170. Эскалация фаундеру не требуется.

Статус: **ready**.
