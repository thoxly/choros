# ADR · T-0120 — Уведомления: in-app центр + email-канал клиента, per-событие, расширяемые каналы

**Status:** ready (no escalation — все внутри-DESIGN развилки решены §3; единственная развилка уровня фаундера вынесена как deploy-time/Stage-2 параметр §8, не блокирует impl)
**Phase:** DESIGN · **Date:** 2026-06-11
**Task:** T-0120 (product=choros, type=design, prio 60)
**Spec consumed:** `docs/specs/T-0120-notifications-design.spec.md` (status: ready, AC-1..AC-20).
**Founder data (не развилка):** in-app центр — обязателен; email — опционален, через SMTP/почтовый API **самого клиента** (письма от его имени, без платформенного relay); настройка per-событие; другие каналы — потом той же механикой → контракт `ChannelDriver` обязателен day-1 (gap-map §2, §3а).
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant-таблица: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)`, DML только `choros_app`, занесение в `known_tenant_tables.txt`.
- `docs/design/T-0014-registry-model.adr.md` / `T-0015-object-handles.adr.md` — `record (tenant_id, id)` = grant-target; непрозрачные ручки: уведомление несёт handle на источник, не данные объекта.
- `docs/design/T-0018-grant-authority.adr.md` §2 — единая grant-алгебра; «нет второго permission-подсистемы». Права на notification-конфиг = grant-строки, не новый ACL.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чокпойнт `grant-resolver`, action-time, fail-closed; reason-union `"no_grant"|"cross_tenant"|"not_found"`.
- `docs/design/T-0016-audit-floor.adr.md` — append-only per-tenant hash-chained `audit_event`; новые события = строки (open vocab `type`), не таблицы; единственный canonical `appendAuditEvent`.
- `docs/design/T-0019-actor-event-ledger.adr.md` — typed `actor_event` с `object_ref`; источник событий нотификатора. Двойной аудит не дублируется внутри нотификатора.
- `docs/design/T-0025-byo-llm-secret-custody.adr.md` — RL-3 паттерн: платформа хранит **handle**, не сырой секрет; `validateSecretHandleShape`/`redactHandle`/`SecretResolverPort` (`src/core/secret-handle-validator.ts`); custody-seam §8.
- `docs/design/T-0062-idempotency-outbox.adr.md` — `choros.outbox` (миграция 024/025), полиморфный `aggregate_kind`, at-least-once; диспетчер `runOutboxOnce(store, deliver, opts)` (`src/core/outboxDispatcher.ts`): один seam `deliver(row)`, ретрай с back-off, `dead` = DLQ.
- `docs/design/T-0033-data-classification.adr.md` — `DataClass = "public"|"internal"|"confidential"|"restricted"` (закрытая ось, импорт из `src/core/data-classification.ts`).
- `docs/design/T-0041-egress-policy.adr.md` — egress-allowlist по DataClass; тело email уходит наружу → egress-граница.
- `docs/design/T-0053-postgres-compose.adr.md` — single-Postgres substrate (нет внешней очереди; outbox = механизм at-least-once).
- `web/src/screens/screen-inbox.jsx` — существующий task-inbox (список задач процесса); **notification center — отдельная концепция/таблица/API**.

**Связанные задачи (инварианты):**
- **T-0095 (SLA warn/over) и эскалации E7** — gap-map §4б: T-0120 = канал доставки для SLA-предупреждений/эскалаций; ADR фиксирует **стандартный контракт источника** `NotificationEvent`, чтобы SLA-watchdog/эскалационный движок публиковали события без изменения ядра нотификатора (AC-20).
- **T-0062 (outbox)** — доставка идёт через существующий outbox; ADR **не изобретает** второй at-least-once механизм.
- **T-0025 (RL-3 custody)** — SMTP-handle = тот же паттерн непрозрачной ссылки; ADR ссылается, не вводит новое custody.

> Это ADR **design-only**. Choros имеет Postgres-в-compose (T-0053/T-0114) и уже-живой outbox
> (T-0062, миграция 024/025, `src/core/outboxDispatcher.ts`). Сами DDL-миграции трёх новых
> tenant-таблиц, TS-код routing/ChannelDriver/шаблонизатора и SMTP-адаптер — **последующие
> impl-задачи**, не здесь. **Следующие свободные миграционные слоты ≥ 044**: слоты 043 и ниже
> заняты к моменту дизайна (043_invoke_proposal.sql — наивысший занятый; часть слотов ниже 043
> тоже уже занята, в т.ч. 044 может быть занят T-0077 или другим post-base merge — точный
> следующий свободный слот выбирает coder при материализации). Каждая
> fitness-функция несёт конкретный `ci_check` + `gating`-ноту (**static-now** = лайнт/тип-чек/юнит
> в `npm run ci` после impl; **live-impl** = проба, авторённая позже, активируемая при Postgres).
> Этот ADR — единый источник полей/типов/контрактов для `coder` и `tester`.

---

## 1. Context

Референс-процесс (ТЭЛ, gap-map): сотрудник должен **узнавать о событиях своей работы** — задача
назначена, апрув запрошен, SLA-предупреждение, эскалация — даже когда он не смотрит в task-inbox.
Фаундер закрыл продуктовые развилки: in-app центр обязателен; email опционален и идёт через
**SMTP/API самого клиента** (письма от его имени, платформа не SMTP-relay); настройка per-событие;
другие каналы — позже той же механикой. Остаются **внутри-DESIGN развилки** (зона архитектора из
спеки), которые этот ADR обязан решить с rejected-alternatives:
**(а)** vocab `recipient_scope` (что значит «кому»);
**(б)** `smtp_handle` day-1: RL-3 shape-guard (прецедент T-0025) vs полноценный Stage-2-resolver;
**(в)** шаблоны: code-bundled (вендор) vs tenant-configurable (tenant-таблица);
**(г)** ретенция/badge-индексы (sweeper vs `expires_at`, индексная стратегия счётчика);
**(д)** где сидит `ChannelDriver`-реестр относительно существующего outbox-диспетчера.

Несущий принцип (как T-0021/T-0119): дизайн **негативен** не меньше, чем позитивен — сделать
неправильное **структурно невозможным** (нет второго permission-механизма — права через PDP T-0018/21;
нет второго at-least-once — доставка через outbox T-0062; сырой SMTP-секрет в хранилище структурно
неконструируем — RL-3 shape-guard T-0025; нет switch/enum по каналам в ядре — реестр-Map), а не только
покрытым тестом. Notification center — **отдельная концепция** от task-inbox: разные таблицы, разные API.

---

## 2. Decision

**Уведомление моделируется ТРЕМЯ tenant-таблицами ядра + реестром каналов `Map<ChannelKey,
ChannelDriver>`, доставка делегирована СУЩЕСТВУЮЩЕМУ outbox T-0062, авторизация конфигурации —
СУЩЕСТВУЮЩЕМУ PDP T-0018/21, custody SMTP-секрета — СУЩЕСТВУЮЩЕМУ RL-3 паттерну T-0025. Ни одного
нового механизма прав, очереди или custody.**

### 2.1 Pipeline событие → подписка → канал → доставка (FR-1, AC-1)

Один поток, четыре звена, без второй очереди:

1. **`NotificationEvent`** — нормализованная структура-сигнал (НЕ таблица; transient-вход
   нотификатора, конструируется системным компонентом). Поля: `event_kind` (закрытый расширяемый
   vocab, аналог T-0019 `event`), `tenant_id`, `subject_actor_id` (кому потенциально адресовано —
   может разворачиваться через `recipient_scope`), `object_ref` (непрозрачная ручка-источник: тип+id,
   аналог T-0019/T-0015), `payload` (jsonb metadata, **≤ `internal`** data-class, без сырых данных
   объекта), `occurred_at`. **Тот же shape** публикуют SLA-watchdog/эскалации (T-0095/E7, AC-20) —
   контракт источника, не частный формат.
2. **Routing-слой** (`fanout`) — чистая функция: берёт `NotificationEvent`, читает активные
   `notification_preference` для `(tenant_id, event_kind)`, разворачивает `recipient_scope` → конкретные
   `recipient_id` (через PDP/role-резолвер, см. §2.4), и для каждой пары **(получатель × канал)**:
   (а) если канал `in_app` — INSERT строки `choros.notification` (in-app центр, §2.2) **И** outbox-ряд
   для немедленной/будущей push-доставки (day-1 in_app = только INSERT + outbox no-op-driver, см. §2.6);
   (б) для прочих каналов (`email`, будущие) — INSERT **одного** outbox-ряда `aggregate_kind =
   'notification'` per (событие × получатель × канал). Шаблонизация (§2.9) рендерит `title`/`body` в
   момент fanout (данные ≤ `internal`).
3. **Канал** — `ChannelDriver` (§2.5); routing хранит `Map<ChannelKey, ChannelDriver>`, не switch.
4. **Доставка** — существующий `runOutboxOnce(store, deliver, opts)` (T-0062). Notification-специфичный
   `deliver(row)` (см. §2.6) распознаёт `row.aggregateKind === 'notification'`, достаёт `channel` из
   `row.payload`, зовёт `driverMap.get(channel).deliver(job, ctx)`; `{ok:true}` → `markDispatched`;
   `{ok:false, retryable:true}` → `markRetry` (back-off); после `maxAttempts` → `dead` (DLQ в той же
   outbox-таблице); `{ok:false, retryable:false}` → **immediate-dead**: вызвать `markRetry` с
   `maxAttempts=0` (механизм T-0062: `attempts ≥ maxAttempts` → `dead` без следующего poll; отдельный
   `markDead` не требуется — `maxAttempts=0` достаточен). Не уходит в бесконечный back-off.
   **Второго диспетчера/очереди нет** (NF-3).

**Связь с T-0019 (без двойного аудита):** одно действие → один `actor_event` (T-0019, как и было) →
**при наличии подписок** → routing создаёт notification-строки/outbox-ряды. Нотификатор **не пишет
свой** `audit_event` per-delivery (FR-8/§2.8); `actor_event` остаётся единственным ledger-следом
действия. Кто создаёт `NotificationEvent`: движок процессов (назначение/апрув), SLA-watchdog
(T-0095), grant-слой (эскалация) — все через **одну** публикующую функцию `publishNotificationEvent`
(§4.3), не каждый сам по себе.

### 2.2 In-app notification center: `choros.notification` (FR-2, AC-2/AC-3)

**Tenant-таблица `choros.notification`** (T-0013-контракт verbatim) — строка = одно уведомление
**одного получателя** (fanout уже развёрнут per-recipient): `(tenant_id, id)` PK, `recipient_id`
(FK `(tenant_id, recipient_id) → employee(tenant_id, id)`), `event_kind`, `title`, `body`
(шаблонизированное human-readable сообщение — **не** сырые данные объекта; `data_class ≤ internal`),
`object_ref` (handle на источник — запись/инстанс), `is_read` (boolean DEFAULT false), `created_at`,
`expires_at` (nullable — для временных уведомлений). §4.1.

**REST-поверхность (первичная, NF-7 — full UI = Stage-2):**
- `GET /api/notifications` — фильтры `is_read`, `event_kind`, пагинация (keyset по `(created_at, id)`);
  авторизация структурна: запрос **всегда** `WHERE recipient_id = $actor` (только свои; нет cross-user
  параметра); tenant-контекст fail-closed (нет контекста → отказ).
- `POST /api/notifications/:id/read` (и batch `PATCH /api/notifications` с массивом id) — атомарно
  `UPDATE … SET is_read = true WHERE tenant_id = GUC AND id = $id AND recipient_id = $actor`; чужая
  строка не матчится → 404 (нет cross-user мутации; AC-17).
- `GET /api/notifications/unread-count` → `{count}` — indexed query (§2.7, badge-индекс).

**Отдельно от task-inbox:** `screen-inbox.jsx` = список задач процесса (другая таблица/API);
notification center = события. Могут жить на одном экране, но это **разные API/таблицы/логика**.

### 2.3 Email-канал: `choros.email_channel_config` + RL-3 custody (FR-3, AC-4/AC-5)

**Tenant-таблица `choros.email_channel_config`** (T-0013-контракт; `tenant_id` = leading PK,
**одна строка на tenant** — конфиг канала): `smtp_host`, `smtp_port`, `smtp_tls` (boolean),
`from_address` (отправитель — «от имени клиента»), `from_name`, `smtp_handle` (**непрозрачный handle**
к секрету), `is_enabled` (boolean — канал можно выключить, не стирая конфиг), audit-поля. §4.2.

**Custody = RL-3 паттерн T-0025 verbatim (НЕ новое custody):** `smtp_handle` проходит
`validateSecretHandleShape` (`src/core/secret-handle-validator.ts`) при set/rotate — **тот же**
shape-guard, который ловит `sk-`/`xai-`/`AIza`-префиксы, bare-hex-32+, JWT-shape, too_short. Сырой
SMTP-пароль/API-ключ в форме реального ключа в столбец **не пройдёт** (структурный барьер, как T-0025
FR-5). Сырой секрет **никогда**: не логируется, не в `audit_event.payload`, не в API-ответе (статус
отдаёт `redactHandle(smtp_handle)`), не в exception message (NF-2, AC-5). ADR ссылается на T-0025
NF-1 как прецедент.

**Отправка от имени клиента:** `From: <from_name> <from_address>`, конверт — через SMTP/API клиента;
платформа **не отправитель**, SPF/DKIM/DMARC — ответственность клиента; Choros никогда не предоставляет
свой relay (Out-of-Scope §7 спеки).

**Управление:** REST `GET/PUT /api/email-channel-config` — grant `mgmt_object:email_config` /
`operation:update` через тот же PDP T-0021 (аналог T-0025 §4 authority-gate; **нет нового механизма прав**).

### 2.4 Per-событие настройка: `choros.notification_preference` (FR-4, AC-7)

**Tenant-таблица `choros.notification_preference`** (T-0013-контракт): строка =
`(tenant_id, event_kind, recipient_scope, channels: text[])`. §4.3-таблица.

**`recipient_scope` vocab (РЕШЕНИЕ §3-а, закрытый расширяемый):**
`actor:<employee_id>` (конкретный сотрудник) · `role:<role_id>` (все носители роли, разворот через
T-0018 role-резолвер) · `object_owner` (владелец `object_ref` события) · `escalation_chain`
(эскалационная цепочка — резолвится T-0095/E7-движком, day-1 = пустой разворот, hook). Разворот
scope → конкретные `recipient_id` идёт **через существующие резолверы** (PDP/role/owner), не через
новый граф получателей.

**Кто настраивает:** tenant-admin — grant `mgmt_object:notification_config` / `update` (PDP T-0021).
Рядовой пользователь правит только **свои** подписки (`recipient_scope = actor:<self>`) через отдельный
эндпоинт `GET/PUT /api/notification-preferences/self` (структурно ограничен `actor:$self`, не может
тронуть чужие/role-scope). Tenant-admin — `GET/PUT /api/notification-preferences?event_kind=…`.

**Defaults (РЕШЕНИЕ §3, day-1 code-bundled seed):** `task.assigned → [in_app]` всегда;
`approval.requested → [in_app]`; `sla.warning → [in_app, email-if-configured]`;
`sla.breach`/`escalation.raised → [in_app, email-if-configured]`. Дефолты — **seed-строки** при
genesis tenant (как T-0026 genesis-owner), tenant-admin переопределяет UPSERT-ом. «email-if-configured»
= routing пропускает email-канал, если `email_channel_config.is_enabled = false` (AC-16).

### 2.5 ChannelDriver — единственный контракт нового канала (FR-6, AC-6)

```ts
// ADR фиксирует этот контракт. Новый канал = реализация ОДНОГО интерфейса + регистрация в Map.
export interface ChannelDriver {
  readonly key: string;                                    // 'in_app' | 'email' | 'telegram' | …
  deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult>;
}
export interface DeliveryJob {
  tenantId: string; recipientId: string; eventKind: string;
  title: string; body: string;                             // уже шаблонизированы (§2.9)
  objectRef: ObjectRef | null; occurredAt: number;
}
export type DeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };     // retryable→markRetry, !retryable→dead
```

**Реестр — `Map<ChannelKey, ChannelDriver>`, НЕ switch/enum в ядре (NF-6, AC-6).** Routing и
notification-`deliver` обращаются к каналу **только** через `driverMap.get(key)`. Добавление Telegram/
webhook/SMS = новый Driver + регистрация в Map + строка `event_kind → channel` в подписке; **ядро
нотификатора не меняется**. `DeliveryResult.retryable` маппится на outbox-исход:
`retryable:true → markRetry` (back-off), `retryable:false → dead` сразу.

### 2.6 Доставка через outbox T-0062 — без второго at-least-once (FR-1/FR-5/FR-8, AC-8)

Нотификатор **переиспользует** `choros.outbox` (миграция 024/025) и `runOutboxOnce` —
полиморфный `aggregate_kind` уже предусматривает новые источники ('job'/'record'/… → +'notification').
- **outbox-ряд** per (событие × получатель × канал): `aggregate_kind = 'notification'`,
  `aggregate_id = notification.id` (для in_app) / синтетический id (для email), `event_type = event_kind`,
  `payload = {channel, recipientId, title, body, objectRef, occurredAt}`, `idempotency_key =
  'notif:' + notification_id + ':' + channel` (NOT NULL, дедуп доставки на стороне consumer — драйвера).
- **`deliver(row)`** (notification-вариант, инжектируется в `runOutboxOnce`): распознаёт
  `aggregateKind === 'notification'`, берёт `channel` из `payload`, зовёт `driverMap.get(channel).deliver`.
  Маппинг `DeliveryResult → DispatchResult`: `{ok:true}→{ok:true}`; `{ok:false,retryable:true}→{ok:false,
  error}` (→`markRetry`, back-off); `{ok:false,retryable:false}→` **immediate-dead**: `markRetry` с
  `maxAttempts=0` — механизм T-0062: `attempts ≥ maxAttempts` → `dead` без следующего poll. Отдельного
  `markDead`-вызова T-0062 не требует; `maxAttempts=0` достаточен. Контракт: non-retryable не уходит
  в бесконечный back-off.
- **`in_app`-драйвер day-1 = no-op success** (строка `choros.notification` уже создана при fanout —
  in-app «доставка» = факт INSERT; outbox-ряд для in_app существует ради единообразия pipeline и
  будущего push, day-1 его driver просто `{ok:true}`). Это держит pipeline единым (нет спец-ветки
  in-app мимо outbox), но не плодит лишней работы.
- **Ретраи/bounce (FR-5):** через outbox `attempts`/`available_at`/back-off (`defaultBackoff`);
  после `maxAttempts` → `dead`. **Bounce = not-our-problem day-1** — клиент настраивает свой SMTP,
  DSN/bounce идут на его адрес; платформа фиксирует только SMTP-исход (успех → `dispatched`,
  SMTP-ошибка → retry/dead). Bounce-webhooks провайдеров = Stage-2. **SMTP-таймаут** — параметр
  драйвера (дефолт ≤ 30 с на попытку + connect-timeout); worker не висит бесконечно.

### 2.7 Ретенция in-app + badge-индексы (FR-2/FR-13, AC-13)

**Badge-индекс (РЕШЕНИЕ §3-г):** частичный индекс
`CREATE INDEX idx_notification_unread ON choros.notification (tenant_id, recipient_id) WHERE is_read = false`.
Счётчик `unread-count` = `COUNT(*)` по этому индексу (только непрочитанные в индексе → малый, горячий).
**Не** materialized view day-1 (резолюция спеки §6) — частичного индекса достаточно при ожидаемых
объёмах; MV — Stage-2, если профилирование потребует.

**Ретенция (РЕШЕНИЕ §3-г):** **гибрид `expires_at` + sweeper**.
`expires_at` (nullable) — для уведомлений с естественным сроком (временные/информационные); sweeper —
для прочитанных без `expires_at` (дефолт: удаление прочитанных старше **90 дней**). Данность спеки:
**непрочитанные не удаляются автоматически** (`is_read = false` → sweeper не трогает, `expires_at`
для непрочитанных не ставится по умолчанию). Сам **sweeper-процесс = Stage-2** (как T-0119 retention
sweeper); day-1 фиксирует **схему** (`expires_at` колонка) + **политику** (90д прочитанные, immutable
непрочитанные) + ручной/lifecycle-триггер; авто-фон — позже. Удаление прочитанного уведомления —
**не** audit-событие (как `is_read`, §2.8).

### 2.8 Аудит — не дублировать audit_floor (FR-8, AC-11)

**Аудитируется** (строки `audit_event` T-0016, open vocab `type`, **новых таблиц нет**):
- `notif.email_config.set` / `.rotate` / `.revoke` — изменение `email_channel_config` (кто/когда;
  `payload` несёт `from_address`/`smtp_host`, **никогда** `smtp_handle`/сырой секрет, §2.3/NF-2).
- `notif.preference.changed` — изменение `notification_preference` (кто/когда/какой `event_kind`/scope).

**НЕ аудитируется отдельно:** `is_read` (пометка прочитанным — не бизнес-значимое действие, разрядка
audit-таблицы); **факт доставки** = `outbox.dispatched_at` (не отдельный `audit_event` per-delivery,
day-1 — явно зафиксировано). Нотификатор **не создаёт** второй audit-sink; единственный
`appendAuditEvent` (T-0016). Аудит-след конфигурации **переживает** удаление самой конфигурации
(append-only; NF-4).

### 2.9 Шаблонизация (FR-9, AC-12)

**РЕШЕНИЕ §3-в: шаблоны code-bundled (вендор-owned) day-1, tenant-override = Stage-2.** Шаблон
per-`event_kind` (`title`-шаблон + `body`-шаблон) живёт в коде (`src/core/notification-templates.ts`,
константная Map `event_kind → {title, body}`). Менять шаблон day-1 может **только вендор** (деплой
нового кода); tenant-configurable шаблоны (таблица `notification_template`) — **Stage-2** (когда
появится спрос на брендинг/локализацию per-tenant). Это держит day-1 простым и безопасным (нет
tenant-инъекции в рендер).

**Рендер:** server-side, **без LLM, без внешних зависимостей** — простая именованная string-подстановка
`{{var}}` из `NotificationEvent.payload` (только переменные **≤ `internal`** data-class; `confidential`/
`restricted` в шаблон не попадают — фильтр на этапе fanout). **Безопасность:** шаблон не исполняет
код (не eval, не template-engine с выражениями); при вставке в HTML-тело email payload-переменные
**HTML-экранируются** (`escapeHtml`); plain-text-часть — без экранирования. Рендер падает закрыто:
отсутствует обязательная переменная → `body` рендерится с плейсхолдером/пропуском, не с raw-объектом.

### 2.10 Tenant-изоляция + egress (FR-7/FR-10, AC-10/AC-14)

Все три таблицы (`notification`, `email_channel_config`, `notification_preference`) — обычные T-0013
tenant-таблицы (FORCE RLS, default-DENY на `choros.tenant_id` GUC, `tenant_id`-leading PK/FK,
`choros_app` DML-only), заносятся в `known_tenant_tables.txt`. Outbox-ряды уже tenant-scoped (T-0062) —
**второго outbox нет**. **Worker fail-closed (AC-14):** SMTP-отправка в async-пути идёт только с явным
tenant-контекстом (диспетчер T-0062 phase-2 ставит GUC per-tenant); нет контекста → отказ, не глобальная
отправка (tenancy §9 п.7). Каждый tenant использует только свой `email_channel_config` (cross-tenant
SMTP-секрет/тело недостижимы — RLS + tenant-scoped claimBatch). **Egress (AC-10):** `body` email/in-app
несёт данные **≤ `internal`** (фильтр §2.9); отправка через SMTP клиента = egress-событие под политику
T-0041 по DataClass содержимого; граница зафиксирована схемой, runtime-гейт egress = Stage-2 (как T-0041).

Тонкое ядро, логика на границах: новый код — три миграции, routing/fanout (чистая функция),
ChannelDriver-реестр + email/in_app-драйверы, шаблонизатор, REST-хендлеры. Авторизация
**переиспользует** PDP T-0018/21; доставка — outbox T-0062; custody — T-0025. Ни одной новой
permission-строки, очереди или custody-механизма.

---

## 3. Rejected alternatives

| Развилка | Option | Why not |
|---|---|---|
| **(д) ChannelDriver-реестр** | **Второй диспетчер/очередь для уведомлений** (свой notification-worker мимо T-0062) | Дублирует at-least-once-машинерию (claim/back-off/dead/cross-tenant phase-1), второй источник ретрай-семантики → дрейф и двойная отладка; против NF-3. **Реестр-Map внутри notification-`deliver`, инжектируемого в существующий `runOutboxOnce`** даёт расширяемость каналов БЕЗ второй очереди: outbox-ряд `aggregate_kind='notification'` несёт `channel` в payload, `driverMap.get(channel)` маршрутизирует. Полиморфный `aggregate_kind` (T-0062) уже это предусматривает. |
| **(д) маршрут по каналам** | **switch/enum по ChannelKey в ядре** | Добавление Telegram = правка ядра (новый `case`), рекомпиляция всех, риск пропустить ветку; против NF-6. **`Map<ChannelKey, ChannelDriver>`** = добавление канала есть регистрация Driver, ядро не меняется; структурно греп-проверяемо (нет `switch(channel)`/`if channel ===` в routing). |
| **(а) recipient_scope** | **«подписка на всё» (per-tenant on/off канала, без event_kind × scope)** | Грубо: нельзя «SLA-предупреждения → мне в email, назначения → только in-app»; фаундер требует per-событие. **Единица подписки = `(event_kind, recipient_scope)`** даёт per-событие × per-кому, закрытый расширяемый scope-vocab (`actor`/`role`/`object_owner`/`escalation_chain`), разворот через существующие резолверы — не новый граф получателей. |
| **(б) smtp_handle day-1** | **Полноценный SmtpSecretResolver (vault/env-интеграция) day-1** | Преждевременно: требует выбора vault-провайдера клиента (внешний ресурс/деньги/деплой) до того, как канал вообще востребован; раздувает MVP. **Day-1 = RL-3 shape-guard (T-0025 `validateSecretHandleShape`) + `SmtpSecretResolverPort`-seam с прямой-строкой/заглушкой-резолвером**; Stage-2 = реальный resolver (vault/env клиента), инжектируемый за тот же порт. Разрыв зафиксирован (§8, аналог T-0025 §8). |
| **(б) хранение секрета** | **Хранить сырой SMTP-пароль/API-ключ в столбце (зашифровать в БД)** | At-rest-шифрование в БД не закрывает leak через логи/audit/exception/API-ответ; платформа становится держателем сырого секрета (против решения фаундера «handle, не raw» и T-0025 RL-3/NF-1). **Непрозрачный handle + shape-guard** делает сырой ключ в столбце структурно непроходимым (`sk-`/hex/JWT отвергаются) и снимает с платформы роль держателя секрета. |
| **(в) шаблоны** | **Tenant-configurable шаблоны в таблице day-1** | Tenant-инъекция строки в рендер → риск XSS/инъекции в email-тело, нужен sandbox-движок и валидация day-1; преждевременная сложность без подтверждённого спроса на брендинг/локализацию. **Code-bundled вендор-шаблоны day-1** (Map в коде, простая `{{var}}`-подстановка + HTML-escape), tenant-override = Stage-2 за разморозкой. |
| **(в) рендер-движок** | **Полноценный template-engine (Handlebars/EJS) с выражениями** | Внешняя зависимость + выражения = возможность исполнить логику/обойти экранирование; против «без внешних зависимостей, шаблон не исполняет код». **Именованная string-подстановка `{{var}}` + `escapeHtml`** — детерминирована, безопасна, нулевая зависимость. |
| **(г) badge-счётчик** | **Materialized view непрочитанных day-1** | MV требует refresh-стратегии (синхронной → запись дорожает, или асинхронной → счётчик отстаёт) — сложность без нужды. **Частичный индекс `WHERE is_read = false`** (резолюция спеки §6): `COUNT(*)` по горячему малому индексу; MV — Stage-2, если профиль потребует. |
| **(г) ретенция** | **Только sweeper (без `expires_at`)** ИЛИ **только `expires_at` (без sweeper)** | Только-sweeper не даёт явного срока временным уведомлениям (TTL — свойство фоновой задачи, не строки); только-`expires_at` требует ставить срок каждому, в т.ч. бессрочным прочитанным. **Гибрид:** `expires_at` для естественно-временных + sweeper-политика (90д прочитанные) для прочих; непрочитанные immutable. Sweeper-процесс = Stage-2 (как T-0119), схема+политика = day-1. |
| **In-app хранилище** | **In-app уведомление = строка task-inbox / общая таблица с задачами** | Слил бы две концепции (задача процесса ≠ событие-уведомление), разные жизненные циклы/права/ретенция → дрейф и спутанная семантика «прочитано». **Отдельная `choros.notification` + отдельный API** (резолюция спеки §6): task-inbox и notification center могут делить экран, но не таблицу/логику. |
| **Аудит доставки** | **`audit_event` per-delivery (каждое отправленное уведомление)** | Раздувает append-only audit-таблицу высокочастотными низко-значимыми событиями; факт доставки уже durable в `outbox.dispatched_at`. **Доставка = `outbox.dispatched_at`; audit_event только на конфиг-изменения** (set/rotate/revoke config, change preference); `is_read` не аудитируется. |

---

## 4. Object model & contracts

> Postgres-типы авторитетны; TS-зеркало следует конвенции T-0014. Все три таблицы — обычные T-0013
> tenant-таблицы (FORCE RLS, default-DENY, `tenant_id`-leading PK/FK, `choros_app` DML-only),
> заносятся в `ci/checks/known_tenant_tables.txt`: `notification`, `email_channel_config`,
> `notification_preference`. **Никаких новых isolation-кодпутей** — те же FF T-0013/T-0115 покрывают.
> `NotificationEvent` — transient-структура (вход нотификатора), НЕ таблица. Outbox-ряды — существующая
> `choros.outbox` (T-0062), новой таблицы нет.

### 4.1 `notification` — in-app уведомление одного получателя (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity |
| `recipient_id` | `uuid NOT NULL` | FK `(tenant_id, recipient_id) → employee(tenant_id, id)`; cross-tenant структурно невозможен |
| `event_kind` | `text NOT NULL` | закрытый расширяемый vocab |
| `title` | `text NOT NULL` | шаблонизированный заголовок (§2.9) |
| `body` | `text NOT NULL` | шаблонизированное тело; data-class ≤ `internal`; не сырые данные объекта |
| `object_ref` | `text NULL` | handle на источник (запись/инстанс); не данные (T-0015) |
| `is_read` | `boolean NOT NULL DEFAULT false` | пометка прочитанным; не аудитируется |
| `created_at` | `bigint NOT NULL` | epoch ms |
| `expires_at` | `bigint NULL` | TTL для временных уведомлений; непрочитанные не истекают по умолчанию |
| | PK `(tenant_id, id)`; FK `(tenant_id, recipient_id)`; partial index `(tenant_id, recipient_id) WHERE is_read = false` (badge); index `(tenant_id, recipient_id, created_at, id)` (keyset-листинг) |

### 4.2 `email_channel_config` — конфиг email-канала tenant (tenant-таблица, одна строка/tenant)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | PK (одна строка на tenant); RLS-ключ |
| `smtp_host` | `text NOT NULL` | хост SMTP/почтового API клиента |
| `smtp_port` | `integer NOT NULL` | порт |
| `smtp_tls` | `boolean NOT NULL DEFAULT true` | TLS/STARTTLS |
| `from_address` | `text NOT NULL` | адрес отправителя — «от имени клиента» |
| `from_name` | `text NULL` | display-имя отправителя |
| `smtp_handle` | `text NOT NULL` | **непрозрачный handle** к секрету (RL-3, T-0025); прошёл `validateSecretHandleShape`; сырой ключ структурно непроходим |
| `is_enabled` | `boolean NOT NULL DEFAULT false` | канал выключаем без стирания конфига; routing пропускает email при false (AC-16) |
| `updated_by` | `text NOT NULL` | актор последнего изменения |
| `updated_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id)` |

### 4.3 `notification_preference` — per-событие подписка (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `event_kind` | `text NOT NULL` | закрытый расширяемый vocab |
| `recipient_scope` | `text NOT NULL` | vocab: `actor:<id>` \| `role:<id>` \| `object_owner` \| `escalation_chain` |
| `channels` | `text[] NOT NULL` | активные каналы: `{in_app, email, …}` (ключи ChannelDriver) |
| `updated_by` | `text NOT NULL` | актор |
| `updated_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, event_kind, recipient_scope)` — одна подписка на (событие × кому); UPSERT при изменении |

### 4.4 Contracts (signatures — impl-задача реализует; ADR фиксирует форму)

```ts
// --- Источник события (transient-вход; SLA-watchdog/эскалации публикуют ТОТ ЖЕ shape, AC-20) ---
export interface NotificationEvent {
  eventKind: string; tenantId: string; subjectActorId: string;
  objectRef: ObjectRef | null; payload: Record<string, unknown>;  // ≤ internal data-class
  occurredAt: number;
}
// ЕДИНСТВЕННАЯ публикующая функция: движок процессов / SLA-watchdog / grant-слой зовут ЕЁ.
// Создаёт notification-строки (in_app) + outbox-ряды (per получатель × канал). Не пишет свой audit.
export function publishNotificationEvent(
  deps: { prefStore; notifStore; outboxStore; templates; roleResolver; clock },
  ev: NotificationEvent, ctx: TenantCtx,
): Promise<{ inAppCreated: number; outboxEnqueued: number }>;

// --- Канальный контракт (§2.5) — единственное, что реализует новый канал ---
export interface ChannelDriver {
  readonly key: string;
  deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult>;
}
export type DeliveryResult = { ok: true } | { ok: false; retryable: boolean; reason: string };

// --- Реестр (НЕ switch/enum в ядре, NF-6) ---
export type ChannelRegistry = ReadonlyMap<string, ChannelDriver>;
// notification-вариант Deliver для runOutboxOnce (T-0062): маршрут по payload.channel через Map.
export function makeNotificationDeliver(registry: ChannelRegistry): Deliver;  // (row)=>DispatchResult

// --- Custody-seam SMTP-секрета (аналог T-0025 §8 SecretResolverPort; импорт, НЕ редекларация) ---
export interface SmtpSecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}
// Структурно совместим с T-0025 SecretResolverPort; day-1 = прямая строка/заглушка, Stage-2 = real.

// --- Шаблонизатор (§2.9): server-side, без LLM, HTML-escape ---
export function renderTemplate(
  tmpl: { title: string; body: string },        // code-bundled per event_kind
  payload: Record<string, unknown>,             // только ≤ internal переменные
  opts: { html: boolean },                       // html=true → escapeHtml переменных
): { title: string; body: string };

// Импорт (НЕ редекларация): ObjectRef/TenantCtx (T-0015/T-0013), Deliver/DispatchResult/OutboxRow
// (T-0062 outboxDispatcher/outboxTypes), DataClass (T-0033), validateSecretHandleShape/redactHandle/
// SecretResolverPort (T-0025 secret-handle-validator), grant-резолвер (T-0018/21).
```

### 4.5 Несущие последовательности

**Fanout (publishNotificationEvent):** (1) tenant-gate fail-closed; (2) читает
`notification_preference` для `(tenant_id, event_kind)`; (3) разворачивает каждый `recipient_scope` →
`recipient_id[]` через role/owner-резолвер; (4) рендерит `title`/`body` (≤ `internal`); (5) per
(получатель × канал из `channels`): in_app → INSERT `notification` + outbox-ряд (no-op-driver);
email → INSERT outbox-ряд (если `email_channel_config.is_enabled`); (6) **не пишет** свой `audit_event`.

**Delivery (runOutboxOnce + makeNotificationDeliver):** диспетчер T-0062 phase-1 (cross-tenant) →
phase-2 (per-tenant GUC, fail-closed) claim → `deliver(row)` распознаёт `aggregate_kind='notification'`,
`driverMap.get(payload.channel).deliver(job, ctx)`; email-драйвер резолвит `smtp_handle` через
`SmtpSecretResolverPort` (в worker-контексте), шлёт через SMTP клиента, `{ok}`→`dispatched`,
`{ok:false,retryable}`→back-off/`dead`. Сырой секрет не покидает драйвер (не в лог/audit/exception).

---

## 5. Build plan & декомпозиция на build-задачи

ADR-декомпозиция (E-нумерация — продолжение notifications-эпика; точные T-номера присвоит
материализация бэклога; зависимости и несомые fitness указаны):

| Build-задача (предлагаемая) | Что создаёт | Зависит от | Несёт fitness |
|---|---|---|---|
| **E-N.1 `[impl] notification: 3 миграции + tenant-изоляция`** | Миграции `0NN_notification.sql`, `0NN+1_email_channel_config.sql`, `0NN+2_notification_preference.sql` (свободные слоты ≥ 044) по §4.1–4.3 — FORCE RLS + default-DENY + `choros_app` DML + badge/keyset-индексы; **добавляет 3 имени в `known_tenant_tables.txt`** (единственное легитимное изменение фикстуры). | T-0013, T-0014 (employee), T-0119 (слот-дисциплина) | FF-T13, FF-NB-OUTBOX (нет второго outbox), FF-UNREAD-INDEXED |
| **E-N.2 `[impl] notification routing + ChannelDriver-реестр`** | `src/core/notification-router.ts` (`publishNotificationEvent`, fanout, scope-разворот), `ChannelDriver`/`DeliveryJob`/`DeliveryResult`-типы, `makeNotificationDeliver` (Map, не switch), in_app-no-op-driver; **импортирует** `Deliver`/`OutboxRow` (T-0062), grant/role-резолвер (T-0018/21). | E-N.1, T-0062 (outbox/dispatcher), T-0018/21 (PDP/role) | FF-NO-SWITCH-CHANNEL, FF-ONE-OUTBOX, FF-FANOUT-FAILCLOSED, FF-EVENT-CONTRACT |
| **E-N.3 `[impl] email-channel config + RL-3 custody + SMTP-драйвер`** | `src/core/notification-email.ts` (`email_channel_config`-CRUD через PDP `mgmt_object:email_config`, `EmailChannelDriver`, `SmtpSecretResolverPort`-seam day-1=stub), `src/adapters/smtp-sender.ts`; **импортирует** `validateSecretHandleShape`/`redactHandle`/`SecretResolverPort` (T-0025). | E-N.2, T-0025 (custody), T-0041 (egress), T-0053 (Postgres) | FF-NO-RAW-SMTP, FF-HANDLE-SHAPE, FF-RESOLVER-PORT, FF-EMAIL-FROM-CLIENT, FF-EGRESS-CLASS |
| **E-N.4 `[impl] notification preferences + defaults seed`** | `notification_preference`-CRUD (tenant-admin `mgmt_object:notification_config` + self-эндпоинт), `recipient_scope`-vocab, defaults-seed при genesis tenant. | E-N.2, T-0018/21, T-0026 (genesis-seed) | FF-PREF-AUTHZ, FF-SELF-PREF-SCOPED, FF-DEFAULTS-SEED |
| **E-N.5 `[impl] notification templates (code-bundled) + render`** | `src/core/notification-templates.ts` (Map `event_kind→{title,body}`), `renderTemplate` (string-подстановка, HTML-escape, без LLM/зависимостей, ≤ internal фильтр). | E-N.2, T-0033 (DataClass) | FF-TEMPLATE-NO-LLM, FF-HTML-ESCAPE, FF-TEMPLATE-CLASS |
| **E-N.6 `[impl] REST API notification center + badge`** | `GET /api/notifications`, `POST /:id/read`/`PATCH`, `GET /api/notifications/unread-count` (только-свои, fail-closed, keyset); `GET/PUT /api/email-channel-config`, `/api/notification-preferences[/self]`. | E-N.1..N.4 | FF-OWN-ONLY-READ, FF-NO-CROSS-USER, FF-UNREAD-INDEXED |
| **E-N.7 `[impl] audit-события config + delivery-через-outbox`** | wiring аудита (`notif.email_config.*`, `notif.preference.changed`) через `appendAuditEvent` (T-0016); подтверждение, что delivery = `outbox.dispatched_at`, `is_read` НЕ аудитируется. | E-N.2..N.6, T-0016 | FF-AUDIT-CONFIG-ONLY, FF-NO-DELIVERY-AUDIT, FF-NO-ISREAD-AUDIT |

**Defers (НЕ здесь / Stage-2):**
- **T-0095/E7** — SLA-watchdog/эскалационный движок как **продюсеры** `NotificationEvent` (контракт
  источника зафиксирован здесь, AC-20; их impl — отдельные задачи). `escalation_chain`-scope разворот.
- **Full notification center UI** (полный экран) — зона 7; badge в app-shell может быть additive (NF-7).
- **Sweeper авто-ретенции** (фоновый процесс) — Stage-2; схема (`expires_at`) + политика = day-1.
- **Tenant-configurable шаблоны** (таблица `notification_template`, брендинг/локализация) — Stage-2.
- **Прочие каналы** (Telegram/webhook/SMS-драйверы) — реализация Stage-2/отдельные задачи; контракт
  `ChannelDriver` готов day-1.
- **Bounce-webhook-обработка** (DSN от провайдеров) — Stage-2; day-1 = SMTP-ошибка → retry/dead.
- **Реальный `SmtpSecretResolver`** (vault/env клиента) — Stage-2 за `SmtpSecretResolverPort` (§8).
- **Push (мобильный)** — not-MVP.

---

## 6. Fitness functions (CI gating — impl acceptance contract)

`gating`: **static-now** = лайнт/тип-чек/юнит, runnable в `npm run ci` после impl; **live-impl** =
проба, авторённая в impl-задаче, активируемая при Postgres.

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-EVENT-CONTRACT** | Стандартный контракт источника: `NotificationEvent {eventKind, tenantId, subjectActorId, objectRef, payload, occurredAt}` определён один раз и публикуется единственной `publishNotificationEvent`; SLA-watchdog/эскалации (T-0095/E7) используют ТОТ ЖЕ shape (AC-1/AC-20). | `tsc --noEmit` на `NotificationEvent`-фикстуре; grep ровно один `export interface NotificationEvent` и один `export function publishNotificationEvent`. gating=static-now. |
| **FF-NO-SWITCH-CHANNEL** | Нет switch/enum по каналу в ядре (NF-6/AC-6): routing/deliver обращаются к каналу только через `driverMap.get(key)`; нет `switch(channel)`/`if (channel === 'email')`-веток в `notification-router.ts`. | `bash ci/checks/notification-isolation.sh`: grep forbidden (`switch *( *channel`, `channel ===`, `case 'email'`) в `src/core/notification-router.ts`; assert `driverMap.get(` присутствует. gating=static-now. |
| **FF-ONE-OUTBOX** | Один outbox/один ретрай-механизм (NF-3/AC-8): нотификатор использует `runOutboxOnce`/`PostgresOutboxStore` (T-0062), `aggregate_kind='notification'`; нет второй очереди/диспетчера/ретрай-петли. | `bash ci/checks/notification-isolation.sh`: assert импорт `runOutboxOnce`/`OutboxRow` из T-0062; grep отсутствие нового `startNotificationDispatcher`/`setInterval`-петли вне T-0062. gating=static-now. |
| **FF-NO-RAW-SMTP** | Сырой SMTP-credential нигде (NF-2/AC-5; аналог T-0025 FF-25-4): `smtp_handle` не появляется в лог/`audit_event` payload/API-ответе/exception; статус отдаёт `redactHandle`. | `bash ci/checks/notification-isolation.sh`: grep что `smtp_handle`/resolved-secret не передаётся в `console.*`/`appendAuditEvent`/`res.json` сырым; assert `redactHandle(` на status-пути. gating=static-now. |
| **FF-HANDLE-SHAPE** | RL-3 shape-guard (AC-4): set/rotate `smtp_handle` зовёт `validateSecretHandleShape` (T-0025) перед записью; сырой `sk-`/hex-32+/JWT отвергается. | `tsc` + unit: `setEmailConfig` с `sk-…`/bare-hex/JWT ⇒ reject; valid handle ⇒ ok. assert импорт из `secret-handle-validator.ts`, не редекларация. `vitest … -t 'smtp-handle-shape'`. gating=static-now. |
| **FF-RESOLVER-PORT** | Custody-seam (AC-9): `SmtpSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort`; day-1 = заглушка/прямая строка; платформа не делает LLM-звонков и не SMTP-relay. | `tsc --noEmit`: `SmtpSecretResolverPort` ↔ `SecretResolverPort` совместимы; grep отсутствие LLM-вызова/собственного relay в email-драйвере. gating=static-now. |
| **FF-EMAIL-FROM-CLIENT** | Отправка от имени клиента (FR-3): `From` берётся из `email_channel_config.from_address/from_name`, конверт — через SMTP клиента; нет хардкод-платформенного from/relay-хоста. | unit: SMTP-драйвер формирует `From: from_name <from_address>` из конфига; grep отсутствие захардкоженного relay-домена. `vitest … -t 'email-from-client'`. gating=static-now. |
| **FF-FANOUT-FAILCLOSED** | Fanout/worker fail-closed по tenant-контексту (AC-14/tenancy §9 п.7): без tenant-контекста `publishNotificationEvent`/email-deliver отказывают, не выполняются глобально. | unit: вызов без tenant-контекста ⇒ отказ, ноль INSERT/SMTP. `vitest … -t 'fanout-fail-closed'`. gating=static-now. |
| **FF-OWN-ONLY-READ** | Только-свои чтение (AC-3/AC-15): `GET /api/notifications` всегда `WHERE recipient_id = $actor`; нет параметра чужого recipient. | unit + live-impl: запрос не принимает чужой recipient_id; tenant B не видит notification tenant A. `vitest … -t 'own-only'` + live cross-tenant probe. gating=static-now + live-impl. |
| **FF-NO-CROSS-USER** | Нет cross-user мутации (AC-17): `read`/`PATCH` чужой строки (recipient ≠ actor) ⇒ 404/403, не мутирует. | unit + live-impl: пометка чужого уведомления ⇒ no-match/403; строка не тронута. `vitest … -t 'no-cross-user'`. gating=static-now + live-impl. |
| **FF-UNREAD-INDEXED** | Badge-счётчик indexed (AC-13): `unread-count` = `COUNT` по partial-индексу `(tenant_id, recipient_id) WHERE is_read=false`; не seq-scan, не MV. | live-impl: `EXPLAIN` `unread-count` использует `idx_notification_unread`; assert индекс в миграции. + grep отсутствие materialized view. gating=static-now (миграция) + live-impl (EXPLAIN). |
| **FF-PREF-AUTHZ** | Подписки через PDP (AC-7/NF-9): tenant-admin меняет preference только с grant `mgmt_object:notification_config`/`update` (PDP T-0021); нет второго ACL. | unit + live-impl: без grant ⇒ `{denied}`; grep отсутствие нового `notification_acl`/`pref_rights`. assert вызов `resolveHandle`/`resolveFor`. gating=static-now + live-impl. |
| **FF-SELF-PREF-SCOPED** | Self-preference структурно ограничен (FR-4): self-эндпоинт пишет только `recipient_scope = actor:<self>`; не может тронуть `role:`/чужой `actor:`. | unit: self-PUT с `role:x`/чужим actor ⇒ reject; только `actor:$self`. `vitest … -t 'self-pref-scoped'`. gating=static-now. |
| **FF-DEFAULTS-SEED** | Defaults зафиксированы (AC-7): genesis tenant получает seed-подписки (`task.assigned→in_app`, `sla.warning→in_app+email-if-configured`, …); tenant-admin override-абелен. | unit/live-impl: после genesis-seed ожидаемые preference-строки присутствуют; UPSERT переопределяет. gating=static-now + live-impl. |
| **FF-TEMPLATE-NO-LLM** | Рендер без LLM/зависимостей (AC-12): `renderTemplate` — string-подстановка, без import LLM/template-engine/eval. | `bash ci/checks/notification-isolation.sh`: grep отсутствие `eval(`/LLM-import/template-engine-import в `notification-templates.ts`. gating=static-now. |
| **FF-HTML-ESCAPE** | HTML-экранирование (AC-12): при `html:true` payload-переменные `escapeHtml`-ятся; `<script>`-инъекция в payload не исполняется в email-теле. | unit: `renderTemplate({html:true})` с `<script>`-payload ⇒ экранировано. `vitest … -t 'html-escape'`. gating=static-now. |
| **FF-TEMPLATE-CLASS** | Шаблон ≤ internal (AC-12/AC-10): переменные шаблона только `≤ internal` data-class; `confidential`/`restricted` отфильтрованы на fanout. | unit: payload с `confidential`-полем ⇒ не попадает в рендер. assert импорт `DataClass` (T-0033), не редекларация. `vitest … -t 'template-class'`. gating=static-now. |
| **FF-EGRESS-CLASS** | Egress-граница (AC-10/NF-5): тело email/in-app ≤ `internal`; отправка через SMTP клиента = egress-событие под T-0041 по DataClass. | `tsc` на DataClass-контракте тела; grep `DataClass` импортирован; egress-граница помечена (runtime-гейт Stage-2 как T-0041). gating=static-now. |
| **FF-AUDIT-CONFIG-ONLY** | Аудит только на конфиг (AC-11): `notif.email_config.set/rotate/revoke` + `notif.preference.changed` пишутся через `appendAuditEvent` (T-0016, open vocab); новых audit-таблиц нет; `smtp_handle` не в payload. | unit: config-изменение эмитит ожидаемый `audit_event` без секрета; assert `known_tenant_tables` не получает audit-дубль. `vitest … -t 'audit-config'`. gating=static-now. |
| **FF-NO-DELIVERY-AUDIT** | Доставка = `outbox.dispatched_at`, НЕ audit per-delivery (AC-11): нет `appendAuditEvent` в delivery-пути per уведомление. | grep отсутствие `appendAuditEvent` в `makeNotificationDeliver`/email-драйвере. gating=static-now. |
| **FF-NO-ISREAD-AUDIT** | `is_read` не аудитируется (AC-11): `POST /:id/read`-путь не зовёт `appendAuditEvent`. | grep отсутствие `appendAuditEvent` в read-хендлере. gating=static-now. |
| **FF-T13** | T-0013-контракт 3 таблиц: `notification`/`email_channel_config`/`notification_preference` — `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id` GUC, `choros_app` DML-only, занесены в `known_tenant_tables.txt`. | существующие T-0013/T-0115 пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) применяются к 3 новым таблицам после внесения в фикстуру. gating=live-impl (T-0013 apparatus). |
| **FF-NB-OUTBOX** | Нет второго outbox-хранилища (NF-3): миграции не создают новой delivery/queue-таблицы; доставка через существующую `choros.outbox`. | grep что миграции T-0120 не содержат `CREATE TABLE … (queue|delivery|dispatch)`; outbox-ряды используют существующую таблицу. gating=static-now. |

---

## 7. Traceability (FR/AC → design)

| AC / FR | covered_by |
|---|---|
| AC-1 / FR-1 | §2.1 (pipeline, `NotificationEvent`, routing→preference→outbox) + §4.4 `NotificationEvent`/`publishNotificationEvent` + FF-EVENT-CONTRACT; §3 rejected(второй диспетчер) |
| AC-2 / FR-2 | §2.2 + §4.1 (`notification`, поля, T-0013) + FF-T13; §3 rejected(in-app=task-inbox) |
| AC-3 / FR-2 | §2.2 (REST: own-only, read, unread-count) + §5 E-N.6 + FF-OWN-ONLY-READ/FF-NO-CROSS-USER/FF-UNREAD-INDEXED |
| AC-4 / FR-3 | §2.3 + §4.2 (`email_channel_config`, `smtp_handle` RL-3) + FF-HANDLE-SHAPE; §3 rejected(сырой секрет в столбце) |
| AC-5 / FR-3 / NF-2 | §2.3 (никакого сырого секрета нигде, ссылка T-0025 NF-1) + §2.8 + FF-NO-RAW-SMTP |
| AC-6 / FR-6 / NF-6 | §2.5 (`ChannelDriver`, `Map`, не switch) + §4.4 + FF-NO-SWITCH-CHANNEL; §3 rejected(switch/enum) |
| AC-7 / FR-4 | §2.4 (`notification_preference`, scope-vocab, admin/self, defaults) + §4.3 + §5 E-N.4 + FF-PREF-AUTHZ/FF-SELF-PREF-SCOPED/FF-DEFAULTS-SEED; §3 rejected(подписка на всё) |
| AC-8 / FR-1/FR-5 / NF-3 | §2.6 (outbox T-0062, один ряд per событие×получатель×канал, back-off, dead) + FF-ONE-OUTBOX/FF-NB-OUTBOX; §3 rejected(второй диспетчер) |
| AC-9 / FR-3 | §2.3/§4.4 (`SmtpSecretResolverPort`, day-1 stub, Stage-2 real, не LLM/relay) + §8 + FF-RESOLVER-PORT; §3 rejected(полный resolver day-1) |
| AC-10 / FR-5 / NF-5 | §2.9/§2.10 (тело ≤ internal, фильтр class, egress T-0041) + FF-EGRESS-CLASS/FF-TEMPLATE-CLASS |
| AC-11 / FR-8 | §2.8 (audit на config, не per-delivery, не is_read; единственный appendAuditEvent) + FF-AUDIT-CONFIG-ONLY/FF-NO-DELIVERY-AUDIT/FF-NO-ISREAD-AUDIT; §3 rejected(audit per-delivery) |
| AC-12 / FR-9 | §2.9 (шаблоны code-bundled, рендер без LLM, HTML-escape, ≤ internal) + §4.4 `renderTemplate` + §5 E-N.5 + FF-TEMPLATE-NO-LLM/FF-HTML-ESCAPE/FF-TEMPLATE-CLASS; §3 rejected(tenant-configurable day-1, template-engine) |
| AC-13 / FR-2 | §2.7 (badge partial-индекс, ретенция гибрид expires_at+sweeper, непрочитанные immutable, sweeper=Stage-2) + §4.1 + FF-UNREAD-INDEXED; §3 rejected(MV, только-sweeper/только-expires_at) |
| AC-14 / FR-7 | §2.10 (worker fail-closed по tenant-контексту в async) + §4.5 + FF-FANOUT-FAILCLOSED |
| AC-15 (test) | §2.2/§2.10 (own-only, RLS, cross-tenant) → FF-OWN-ONLY-READ (live-impl) |
| AC-16 (test) | §2.4 (email-if-configured), §2.6 (in_app независимо) → live-impl probe (E-N.3/E-N.6) |
| AC-17 (test) | §2.2 (no cross-user мутация) → FF-NO-CROSS-USER (live-impl) |
| AC-18 (test) | §2.6 (SMTP-failure → retry/dead, не дубль in-app), §2.3 (handle не в логах) → live-impl probe (E-N.3) |
| AC-19 (manual) | §3 (rejected обоснованы против инвариантов) + §6 (FF-ONE-OUTBOX/FF-PREF-AUTHZ/FF-NO-RAW-SMTP гарантируют отсутствие второго outbox/permission/сырого секрета) + ревью-гейт архитектора §7 |
| AC-20 / FR-1 | §2.1 (тот же `NotificationEvent` shape для SLA/эскалаций) + §4.4 + §5 defers(T-0095/E7 продюсеры) + FF-EVENT-CONTRACT |

---

## 8. Custody-seam SMTP-секрета (аналог T-0025 §8)

Как T-0025 владеет `SecretResolverPort` для T-0039, T-0120 определяет **`SmtpSecretResolverPort`** —
структурно совместимый порт для резолва `smtp_handle → реальный SMTP-секрет` **только в worker-контексте
при отправке**:
```ts
export interface SmtpSecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}
```
1. **Day-1** — email-драйвер инжектирует **заглушку/прямую-строку-резолвер**: если клиент хранит
   app-password напрямую в handle-форме (прошедшей shape-guard, т.е. **не** похожей на сырой vendor-ключ),
   резолвер возвращает его как есть; иначе — `not_implemented`-стаб. Day-1 **не** делает client-side
   secret retrieval (как T-0025 day-1 не реализует `resolveSecret`).
2. **Stage-2** — реальный RL-3-резолвер (vault/env-secrets клиента), инжектируемый за **тот же** порт,
   без изменения ядра/драйвера (как T-0025 §8 / T-0045).
3. **Платформа не делает LLM-звонков** в пути уведомлений и **не является SMTP-relay** — конверт идёт
   через SMTP клиента, секрет резолвится локально в worker, не покидает драйвер (NF-2).

Разрыв day-1/Stage-2 зафиксирован здесь, как T-0025 §8 — `FF-RESOLVER-PORT` гарантирует совместимость
портов под `tsc`.

---

## 9. Compatibility notes (architect rule 7)

- **Implements, does not change, T-0062.** Доставка переиспользует `choros.outbox` (миграция 024/025),
  `runOutboxOnce`/`PostgresOutboxStore`, полиморфный `aggregate_kind` (+'notification'), `Deliver`-seam;
  новой очереди/диспетчера/ретрай-петли НЕТ (FF-ONE-OUTBOX/FF-NB-OUTBOX). `idempotency_key` доставки —
  consumer-side (драйвер), как FR-6 T-0062.
- **Implements, does not change, T-0025.** SMTP-custody = `validateSecretHandleShape`/`redactHandle`/
  `SecretResolverPort`-паттерн verbatim; нового custody-механизма нет (FF-NO-RAW-SMTP/FF-HANDLE-SHAPE/
  FF-RESOLVER-PORT). Handle, не сырой секрет — как T-0025 NF-1.
- **Honors T-0018 §2 / T-0021.** Права на email-config/preferences = grant-строки через тот же PDP
  (`mgmt_object:email_config`/`mgmt_object:notification_config`); нет `notification_acl`/`pref_rights`/
  второго permission-механизма (FF-PREF-AUTHZ); role/owner-разворот scope — через существующие резолверы.
- **Honors T-0013/T-0115.** Три таблицы — обычные tenant-таблицы; внесение в `known_tenant_tables.txt` —
  единственное (ожидаемое) изменение фикстуры impl-миграцией, покрытое T-0013-пробами (FF-T13).
- **Honors T-0016.** Notification-аудит = строки `audit_event` (open vocab `notif.*`); новых
  audit-таблиц нет; доставка = `outbox.dispatched_at`, `is_read` не аудитируется (FF-AUDIT-CONFIG-ONLY/
  FF-NO-DELIVERY-AUDIT/FF-NO-ISREAD-AUDIT).
- **Honors T-0019.** Одно действие → один `actor_event` → (при подписках) notification-fanout; двойной
  аудит внутри нотификатора не повторяется. `NotificationEvent.object_ref` — handle-стиль T-0019/T-0015.
- **Honors T-0033/T-0041.** `body`/`payload` ≤ `internal` (`DataClass` импорт, не редекларация);
  egress-граница помечена, runtime-гейт = Stage-2 (как T-0041/T-0119).

## 10. Escalation

**None для DESIGN-объёма.** Все пять внутри-DESIGN развилок (§1: recipient_scope vocab; smtp_handle
day-1 shape-guard vs Stage-2 resolver; шаблоны code-bundled vs tenant-configurable; ретенция/badge-индексы;
расположение ChannelDriver-реестра) решены §3 с rejected-alternatives. Спека отдала эти выборы архитектору
(§2 спеки «твоя зона»), все resolved без эскалации.

**Развилка уровня фаундера (НЕ решается здесь, вынесена как Stage-2/деплой-параметр, не блокирует impl):**
выбор/оплата **реального SMTP-secret-resolver-бэкенда для prod** (vault-провайдер клиента / env-secrets)
— это внешний ресурс/деньги/деплой-решение клиента, вынесено за `SmtpSecretResolverPort` (§8), day-1 =
заглушка/прямая-строка достаточна для impl+тестов. Аналогично — **момент включения email-канала на
конкретного клиента** (нужны его SMTP-креды) = операционный гейт клиента, не блок дизайна. Этих развилок
ADR **не гадает** — порт+стаб day-1, реальный бэкенд = Stage-2 за тем же контрактом.
