# Spec · T-0120 — Уведомления: in-app центр + email-канал, per-событие настройка, расширяемость каналов

**Status:** ready
**Phase:** SPEC (для дизайн-задачи — выход фазы = требования к будущему ADR, не сам ADR)
**Date:** 2026-06-11
**Task:** T-0120 (product=choros, type=design, prio 60)
**spec_ref:** `playbooks/choros-product-gap-map.md` §2,§3а (решение фаундера: in-app центр + email опционально); gap-map §4б (связь T-0120 с T-0095/E7-эскалациями)
**Решение фаундера (данность, не развилка):** уведомления → **in-app центр уведомлений** (обязателен) + **опциональный email-канал через SMTP/почтовый API клиента, письма от его имени**; настройка per-событие; другие каналы — потом той же механикой.
**Опора (не противоречить):**
- `docs/design/tenancy-and-delivery.md` — multi-tenant-first, `tenant_id`-leading PK, FORCE RLS везде, нет cross-tenant FK, tenant-контекст fail-closed в async/фоне.
- `docs/design/T-0013-tenant-isolation.adr.md` — полный T-0013-контракт для tenant-таблиц.
- `docs/design/T-0018-grant-authority.adr.md` — единая grant-алгебра; нет второго permission-механизма.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чокпойнт; fail-closed.
- `docs/design/T-0016-audit-floor.adr.md` — append-only hash-chained аудит; события уведомлений пишутся через единый audit sink.
- `docs/design/T-0019-actor-event-ledger.adr.md` — typed actor_event (источники событий для нотификатора).
- `docs/design/T-0025-byo-llm-secret-custody.adr.md` — RL-3 паттерн: платформа хранит **handle**, не сырой секрет; SMTP-крединшелс клиента = тот же принцип (handle, не raw password).
- `docs/design/T-0062-idempotency-outbox.adr.md` — outbox T-0059/E1.2: доставка с гарантиями at-least-once; уведомления доставляются через outbox, не прямым HTTP-вызовом из транзакции.
- `docs/design/T-0033-data-classification.adr.md` — классификация полей; содержимое уведомления не должно поднимать классификацию выше `internal` без явной настройки.
- `docs/design/T-0041-egress-policy.adr.md` — egress-allowlist; тело email уходит наружу — egress-граница обязательна.
- `docs/design/T-0014-registry-model.adr.md` — namespace Application→Registry→Record; объекты = источники событий.
- `docs/design/T-0015-object-handles.adr.md` — непрозрачные ручки; ссылка в уведомлении = handle, не данные.
- `docs/design/T-0053-postgres-compose.adr.md` — single-Postgres substrate (нет внешней очереди).
- `web/src/screens/screen-inbox.jsx` — существующий таск-инбокс (список задач); **notification center — отдельная концепция**, не тот же экран.

**Связанные задачи (инварианты, читать дизайнеру):**
- **T-0095 (SLA warn/over) и эскалации E7** — gap-map §4б: T-0120 = канал доставки для SLA-предупреждений и эскалаций; ADR обязан задокументировать стандартный контракт источника события, чтобы T-0095/E7 могли его использовать.
- **T-0062 (outbox / idempotency)** — доставка уведомлений идёт через outbox; ADR T-0120 не изобретает второй механизм at-least-once.
- **T-0025 (BYO-LLM secret custody / RL-3)** — SMTP-handle = тот же паттерн хранения непрозрачной ссылки; ADR T-0120 ссылается на T-0025 как прецедент, не изобретает новое custody.

---

## 1. Summary

Choros получает подсистему **уведомлений** — двухслойную, расширяемую, tenant-изолированную. Слой 1 — **in-app notification center**: постоянное хранилище уведомлений пользователя в tenant-таблице, прочитываемое REST-эндпоинтом, с badge-счётчиком непрочитанных. Слой 2 — **email-канал**: опциональный, конфигурируется tenant-администратором через SMTP/почтовый API **самого клиента** (письма уходят от его имени); SMTP-credentials хранятся как непрозрачный handle (RL-3, T-0025). Настройка **per-событие**: для каждого класса событий (задача назначена, SLA предупреждение, эскалация, апрув запрошен и т.п.) независимо настраивается, какие каналы активны и кто получает. Архитектура каналов **расширяема**: добавление нового канала (Telegram, webhook, SMS) требует реализации одного контракта — `ChannelDriver`, не изменения ядра. Доставка идёт через существующий outbox (T-0062, at-least-once, ретраи, back-off).

Это **дизайн-задача**: выход фазы — спека требований, которые обязан покрыть будущий ADR (T-0120-notifications.adr.md). Acceptance-критерии — проверяемые свойства будущего ADR и, после реализации, кода.

---

## 2. Функциональные требования к дизайну (ADR обязан покрыть)

### FR-1 — Модель событие→подписка→канал→доставка

ADR обязан определить полную pipeline:

1. **Событие** (`NotificationEvent`): нормализованная структура — `event_kind` (закрытый vocab, аналог T-0019 `event`), `tenant_id`, `subject_actor_id` (кому адресовано, FK→`employee`), `object_ref` (непрозрачная ручка-источник: тип + id, аналог T-0019 `object_ref`), `payload` (jsonb, metadata события, без сырых данных выше `internal`), `occurred_at`.
2. **Подписка** (`NotificationPreference`): per-tenant, per-`event_kind`, per-субъект (или роль) — какие каналы включены (`in_app`, `email`, будущие). ADR обязан определить единицу подписки: подписка на `event_kind` × `recipient_scope` (конкретный actor или группа/роль), не «подписка на всё».
3. **Канал** (`ChannelDriver`): контракт нового канала (FR-7); routing-слой сопоставляет событие с активными подписками и вызывает соответствующие DriverKey.
4. **Доставка** через outbox (T-0062): один `outbox`-ряд per (событие × подписчик × канал); диспетчер T-0062 берёт ряды, вызывает `ChannelDriver.deliver`, на успех — `dispatched`, на ошибку — ретрай с back-off, после N — `dead`.

ADR обязан зафиксировать: кто и когда создаёт `NotificationEvent` (системные компоненты — движок процессов, SLA-watchdog, grant-слой) и как это событие связано с `actor_event` (T-0019): одно действие → один `actor_event` → при наличии подписок → outbox-ряды уведомлений. Двойной аудит (audit_event + actor_event) не повторяется внутри нотификатора.

### FR-2 — In-app notification center: хранение, чтение, badge

ADR обязан определить:

- **Tenant-таблица** `choros.notification` (полный T-0013-контракт): строка на одно уведомление одного получателя — `tenant_id`, `id`, `recipient_id` (FK→`employee`), `event_kind`, `title`, `body` (краткое, human-readable), `object_ref` (handle на источник — запись, инстанс и т.п.), `is_read` (boolean, default false), `created_at`, `expires_at` (nullable — для временных уведомлений). Бизнес-данные в `body` — не сырые данные объекта, а шаблонизированное сообщение; классификация тела — не выше `internal`.
- **REST-эндпоинт чтения**: `GET /api/notifications` (с фильтрами `is_read`, `event_kind`, пагинацией); авторизация — только свои уведомления (`recipient_id = actor`), никаких cross-user; fail-closed по tenant-контексту.
- **Пометка прочитанным**: `POST /api/notifications/:id/read` (или batch `PATCH /api/notifications` с массивом id); атомарно обновляет `is_read = true`; только для owner-actor.
- **Badge-счётчик непрочитанных**: `GET /api/notifications/unread-count` → `{ count: number }`; быстро (indexed query `WHERE recipient_id = $actor AND is_read = false`); ADR фиксирует индексную стратегию.
- **Отдельная концепция от task-inbox** (screen-inbox.jsx): task-inbox = список задач процесса; notification center = уведомления о событиях. Они могут быть на одном экране, но — разные API, разные таблицы, разная логика.
- **Ретенция in-app уведомлений**: ADR фиксирует политику — срок хранения (н-р, 90 дней для прочитанных) и механику удаления (sweeper или `expires_at`-ориентированный); данность: непрочитанные не удаляются автоматически.

### FR-3 — Email-канал: custody SMTP-credentials клиента (RL-3 паттерн)

ADR обязан определить:

- **SMTP/Почтовый API клиента**: tenant-администратор настраивает свой почтовый провайдер (SMTP: host, port, TLS, from-адрес, auth; или API клиента — Sendgrid, Mailgun и т.п.); Choros никогда не предоставляет свой SMTP-relay.
- **Custody по RL-3 (T-0025-паттерн)**: SMTP-пароль/API-ключ хранится как **непрозрачный handle** (opaque reference string) в `tenant_config`-like таблице, прошедший shape-guard (не сырой ключ вида `SG.xxx`, не plain hex 32+, не JWT); сырой секрет никогда не логируется, не попадает в audit_event payload, не возвращается в API-ответах. ADR ссылается на T-0025 как прецедент и **не вводит новый механизм custody** — те же инварианты.
- **Tenant-таблица** `choros.email_channel_config` (полный T-0013-контракт): `tenant_id` (PK), `smtp_host`, `smtp_port`, `smtp_tls` (boolean), `from_address` (адрес отправителя — «от имени клиента»), `from_name`, `smtp_handle` (непрозрачный handle к секрету); управление через REST-эндпоинт с grant `mgmt_object:email_config` / `operation:update` (аналог T-0025 §4 authority gate — нет нового механизма прав).
- **Resolve handle → реальный секрет**: только при отправке, в worker-контексте, через инжектируемый port `SmtpSecretResolverPort` (аналог T-0025 `SecretResolverPort`); day-1 = SMTP-библиотека читает handle как прямую строку (если клиент хранит app-password напрямую в handle-форме) или resolver заглушка; Stage-2 = интеграция с vault/env-secrets клиента. ADR фиксирует этот разрыв (аналог T-0025 §8).
- **Отправка от имени клиента**: `From: <from_address>` в заголовке, конверт — через его SMTP; платформа не является отправителем; SPF/DKIM — ответственность клиента.

### FR-4 — Per-событие настройка (кем/где)

ADR обязан определить:

- **`NotificationPreference`-таблица** (tenant-таблица): строка = (`tenant_id`, `event_kind`, `recipient_scope`, `channels: string[]`); `recipient_scope` — «конкретный actor-id», «роль», «владелец объекта», «эскалационная цепочка» и т.п. (vocab закрытый, расширяем).
- **Кто настраивает**: tenant-администратор (grant `mgmt_object:notification_config` / `operation:update`), не рядовой пользователь; рядовой пользователь может управлять только подписками на самого себя (`self-preference`) через отдельный эндпоинт.
- **Defaults**: ADR фиксирует систему дефолтных подписок (н-р, `task.assigned` → in-app всегда; `sla.warning` → in-app + email если email-канал настроен) — tenant-admin может переопределить.
- **UI/REST-путь**: `GET/PUT /api/notification-preferences?event_kind=…` — управление подписками; tenant-scoped, fail-closed.

### FR-5 — Ретраи и bounce (email)

ADR обязан определить:

- **Ретраи**: через outbox-механизм T-0062 — `attempts`, `available_at` с back-off; после `max_attempts` ряд → `dead` (DLQ в той же outbox-таблице). ADR не изобретает второй ретрай-механизм.
- **Bounce-обработка**: email-delivery не гарантирует доставку до ящика; ADR фиксирует: bounce = not-our-problem day-1 (клиент настраивает свой SMTP, DSN/bounce идут на его адрес); платформа обновляет статус outbox-ряда (успешная отправка через SMTP = `dispatched`, SMTP-ошибка = retry/dead). Bounce-webhooks от внешних провайдеров — Stage-2.
- **Таймаут**: ADR фиксирует таймаут SMTP-соединения и попытки; worker не должен висеть бесконечно.
- **Egress-граница**: тело email уходит наружу (к SMTP клиента) — попадает под egress-политику T-0041 по DataClass содержимого; ADR обязан отметить, что тело письма не должно нести данные классификации выше `internal` без явного разрешения egress-политики.

### FR-6 — Расширяемость каналов: контракт нового канала

ADR обязан определить **`ChannelDriver`-интерфейс** — единственный контракт, который нужно реализовать для добавления нового канала:

```ts
// ADR фиксирует этот или эквивалентный контракт
interface ChannelDriver {
  readonly key: string;                    // уникальный идентификатор канала ('in_app', 'email', ...)
  deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult>;
}

interface DeliveryJob {
  tenantId: string;
  recipientId: string;         // employee.id получателя
  eventKind: string;           // vocab-строка из NotificationEvent
  title: string;               // шаблонизированный заголовок
  body: string;                // шаблонизированное тело
  objectRef: ObjectRef | null; // handle на источник
  occurredAt: number;
}

type DeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };
```

ADR обязан зафиксировать: routing-слой держит реестр `Map<ChannelKey, ChannelDriver>`; добавление нового канала = регистрация нового Driver + `event_kind → channel` в настройках подписки; ядро нотификации не меняется. Нет switch/enum по каналам в ядре (только в конфиге/реестре).

### FR-7 — Tenant-изоляция

ADR обязан определить:

- Все tenant-таблицы нотификатора (`notification`, `email_channel_config`, `notification_preference`) — полный T-0013-контракт: `tenant_id`-leading PK, `ENABLE + FORCE RLS`, default-DENY политика на `current_setting('choros.tenant_id', true)::uuid`, DML только `choros_app`, занесены в `ci/checks/known_tenant_tables.txt`.
- Outbox-ряды уведомлений (T-0062) — уже tenant-scoped; ADR не создаёт второй outbox.
- Worker/диспетчер: fail-closed по tenant-контексту в async-путях — нет tenant-контекста → операция падает, не выполняется глобально (tenancy §9 п.7).
- SMTP-отправка: каждый tenant использует только свой `email_channel_config`; нет cross-tenant утечки SMTP-секрета или тела письма.

### FR-8 — Аудит (не дублировать audit_floor)

ADR обязан определить:

- **Что аудитируется** в рамках T-0016: изменение `email_channel_config` (set/rotate/revoke SMTP-handle), изменение `notification_preference` (кто/когда изменил подписку). Факт доставки уведомления — фиксируется в outbox (`dispatched_at`), отдельного `audit_event` per-delivery day-1 нет (ADR должен это зафиксировать явно).
- **Что НЕ аудитируется отдельно**: `is_read` — пометка прочитанным не пишет audit_event (не является действием с бизнес-значимостью, разрядка для audit_event таблицы).
- ADR **не создаёт** второй audit-sink; единственный canonical `appendAuditEvent` (T-0016).

### FR-9 — Шаблонизация сообщений

ADR обязан определить:

- **Шаблоны per-`event_kind`**: title-шаблон и body-шаблон; переменные = поля из `NotificationEvent.payload` (только `internal`-data-class, не `confidential`/`restricted`). Шаблоны хранятся как конфиг (в коде или tenant-таблице — выбор DESIGN). ADR должен зафиксировать: кто может изменять шаблон (tenant-admin vs вендор), где хранится (code-bundled vs tenant-configurable).
- **Рендер шаблона**: server-side, без LLM, без внешних зависимостей day-1; простая string-подстановка или lightweight template engine.
- **Безопасность**: шаблон не исполняет произвольный код; payload-переменные экранируются при вставке в HTML-тело email.

### FR-10 — Миграционные слоты

ADR обязан зафиксировать номера миграций SQL-файлов для новых tenant-таблиц: **следующая свободная миграция ≥ 041** (барьер T-0119; ADR T-0120 бронирует слоты, не выполняет DDL — DDL создаёт coder-фаза). Дизайн без кода.

---

## 3. Нефункциональные требования

### NF-1 — Tenant-изоляция структурна (non-negotiable)
Notification-таблицы под FORCE RLS; SMTP-handle под `tenant_id`-leading PK; worker fail-closed по tenant-контексту. Один cross-tenant leak = смерть GTM (tenancy §5).

### NF-2 — SMTP-credentials: ни сырого секрета нигде
Сырой SMTP-пароль/API-ключ никогда: не логируется, не попадает в audit_event payload, не возвращается в API, не попадает в exception message. RL-3 паттерн (T-0025) применяется без исключений.

### NF-3 — Один outbox, один ретрай-механизм
Нотификатор не изобретает собственного механизма at-least-once. Все delivery-попытки — через T-0062 outbox (existing dispatching machinery).

### NF-4 — Аудит переживает ошибки доставки
Сбой доставки (smtp timeout, dead-letter) фиксируется в outbox (`dead`), не стирает факт попытки. Аудит-след действий над конфигурацией переживает удаление самой конфигурации (T-0016 append-only).

### NF-5 — Egress-согласование (T-0041)
Тело email уходит наружу — egress-граница зафиксирована в ADR; содержимое уведомлений не несёт данных выше `internal` без явной egress-политики.

### NF-6 — Канальный реестр без switch/enum в ядре
Добавление нового канала (Telegram и т.п.) — регистрация Driver, не изменение ядра нотификатора. Это проверяется структурно: routing-слой не имеет if/switch по ключу канала (только `driverMap.get(key)`).

### NF-7 — Нет UI для notification center day-1 (за исключением badge)
Badge-счётчик может быть добавлен в существующий app-shell; full notification center UI — Stage-2 или отдельная задача. ADR фиксирует REST API как первичную поверхность; UI не блокирует дизайн.

---

## 4. Out of Scope (явные не-цели T-0120)

1. **Реализация (DDL/код/SMTP-клиент):** T-0120 — дизайн-задача; ADR + DDL + TS-код — следующие фазы; миграции бронируются, не создаются.
2. **Telegram / Webhook / SMS-каналы:** дизайн `ChannelDriver`-контракта обязателен; реализация этих драйверов — Stage-2 или отдельные задачи.
3. **Notification center UI (полный экран):** REST API проектируется; UI-компоненты — задачи зоны 7; badge в app-shell — может быть additive.
4. **Bounce-webhook-обработка:** DSN/bounce от провайдеров клиента — Stage-2; day-1 = SMTP-ошибка → retry/dead в outbox.
5. **Push-уведомления (мобильные):** мобильный — not MVP (gap-map зона 6).
6. **LLM-генерация тела уведомлений:** шаблонизация server-side без LLM; AI-assistive notifications — Stage-2 за stage-разморозкой.
7. **Globa/ SaaS relay (платформенный SMTP):** Choros не предоставляет свой почтовый сервис; email идёт только через SMTP/API клиента.
8. **Read-receipts email:** только SMTP-доставка, не трекинг открытий (pixel tracking).
9. **Второй permission-механизм:** права доступа к notification-конфигу = grant-алгебра T-0018 (нет нового ACL).
10. **Pooled-режим:** дефолт — silo; tenant-изоляция закладывается без достройки pooled.

---

## 5. Acceptance Criteria

Критерии — **проверяемые свойства будущего ADR** (`fitness`) либо **test после реализации** (`test`), либо **ревью-гейт** (`manual`).

| ID | Text | Verifiable as |
|---|---|---|
| **AC-1** | ADR определяет pipeline событие→подписка→канал→доставка: `NotificationEvent` с полями `event_kind`, `tenant_id`, `subject_actor_id`, `object_ref`, `payload`, `occurred_at`; routing-слой сопоставляет событие с активными `NotificationPreference` и создаёт outbox-ряды. | fitness |
| **AC-2** | ADR определяет tenant-таблицу `choros.notification` с полным T-0013-контрактом (`tenant_id`-leading PK, FORCE RLS, default-DENY, choros_app, known_tenant_tables.txt); поля: `id`, `recipient_id`, `event_kind`, `title`, `body`, `object_ref`, `is_read`, `created_at`, `expires_at`. | fitness |
| **AC-3** | ADR определяет REST-эндпоинты: `GET /api/notifications` (свои уведомления, fail-closed), `POST /api/notifications/:id/read` (только owner-actor), `GET /api/notifications/unread-count` (indexed query); tenant-scoped, нет cross-user чтения. | fitness |
| **AC-4** | ADR определяет tenant-таблицу `choros.email_channel_config` (T-0013-контракт): `smtp_host`, `smtp_port`, `smtp_tls`, `from_address`, `from_name`, `smtp_handle` (непрозрачный handle по RL-3 паттерну T-0025); сырой SMTP-пароль/API-ключ в таблице структурно невозможен (handle shape-guard аналог T-0025 validator). | fitness |
| **AC-5** | ADR явно запрещает: сырой SMTP-credential в любом поле — логах, audit_event payload, API-ответах, exception messages; ссылается на T-0025 NF-1 как прецедент; fitness-grep аналог FF-25-4 (no raw smtp credential in log/error/audit). | fitness |
| **AC-6** | ADR определяет `ChannelDriver`-интерфейс: `key: string`, `deliver(job, ctx): Promise<DeliveryResult>` где `DeliveryResult = {ok:true} | {ok:false; retryable:boolean; reason:string}`; routing-слой использует `Map<ChannelKey, ChannelDriver>` (нет switch/enum в ядре). | fitness |
| **AC-7** | ADR определяет `NotificationPreference`-таблицу (T-0013-контракт): (`tenant_id`, `event_kind`, `recipient_scope`, `channels[]`); управление: tenant-admin через grant `mgmt_object:notification_config`/`update`, self-preference через отдельный эндпоинт; defaults зафиксированы. | fitness |
| **AC-8** | ADR явно фиксирует: доставка идёт через T-0062 outbox (один `outbox`-ряд per событие × подписчик × канал); нет второго outbox / второго ретрай-механизма; ретраи с back-off; `dead` = DLQ в outbox. | fitness |
| **AC-9** | ADR определяет `SmtpSecretResolverPort` (инжектируемый port по паттерну T-0025 §8); day-1 = прямая строка / заглушка; Stage-2 = реальный resolver; ADR фиксирует этот разрыв и то, что платформа не делает LLM-звонков и не является SMTP-relay. | fitness |
| **AC-10** | ADR определяет egress-границу (T-0041): тело email/in-app уведомления несёт данные классификации не выше `internal`; отправка через SMTP клиента = egress-событие; ADR зафиксировал эту границу. | fitness |
| **AC-11** | ADR определяет аудит-события (T-0016) для: set/rotate/revoke `email_channel_config`; изменение `notification_preference`; и явно исключает audit_event per `is_read` (не бизнес-значимо). Факт доставки = outbox `dispatched_at`. | fitness |
| **AC-12** | ADR определяет шаблонизацию сообщений: шаблоны per-`event_kind`, server-side рендер без LLM, переменные из `NotificationEvent.payload` (≤ `internal`), экранирование в HTML-теле email; кто может изменять шаблоны — зафиксировано. | fitness |
| **AC-13** | ADR фиксирует политику ретенции in-app уведомлений: срок хранения прочитанных, механику удаления (sweeper / `expires_at`), данность «непрочитанные не удаляются автоматически»; индексная стратегия для badge-счётчика. | fitness |
| **AC-14** | ADR фиксирует worker fail-closed по tenant-контексту в async-путях (tenancy §9 п.7): SMTP-отправка в async только с явным tenant-контекстом; нет tenant-контекста → отказ. | fitness |
| **AC-15** | Post-impl: пользователь получает in-app уведомление только о своих событиях (recipient_id = actor); `GET /api/notifications` из контекста tenant B не возвращает уведомления tenant A. | test |
| **AC-16** | Post-impl: при отключённом email-канале (email_channel_config не настроен или email не в channels) — email не отправляется; in-app уведомление создаётся независимо. | test |
| **AC-17** | Post-impl: попытка прочитать/отметить уведомление другого пользователя (recipient_id ≠ actor) возвращает 403/404; нет cross-user чтения. | test |
| **AC-18** | Post-impl: SMTP-failure на delivery (таймаут/auth-error) переводит outbox-ряд в retry/dead; не создаёт дублирующего уведомления в in-app таблице; SMTP-handle не появляется в logах при ошибке. | test |
| **AC-19** | ADR трассируется к gap-map §2/§3а: каждое FR-1..FR-10 покрыто ≥1 решением ADR; ни одно решение не вводит второго permission-механизма / второго outbox / сырого SMTP-секрета в хранилище; ревью-гейт архитектора. | manual |
| **AC-20** | ADR фиксирует связь с T-0095/E7-эскалациями: стандартный контракт источника события (`NotificationEvent` shape) позволяет SLA-watchdog и эскалационному движку публиковать события без изменения ядра нотификатора. | fitness |

---

## 6. Снятые неоднозначности

**Зафиксировано фаундером (gap-map §3а) — не поднимать заново:**
- In-app центр — обязателен (не опция).
- Email — опционален (настраивается per-tenant); через SMTP/API **клиента**, не платформенный relay.
- Письма — **от имени клиента** (его `from_address`, его SMTP).
- Настройка per-событие — обязательна.
- Другие каналы — «потом той же механикой» → контракт `ChannelDriver` обязателен day-1.

**Резолюции по существующей модели (не эскалация):**
- **SMTP-handle паттерн = T-0025 RL-3**: принято; ADR ссылается, не изобретает нового custody.
- **Outbox = T-0062**: принято; нотификатор не строит второй at-least-once механизм.
- **Отдельная таблица от task-inbox**: screen-inbox.jsx = список задач процесса; notification center = уведомления о событиях; два разных API.
- **Badge-счётчик**: indexed query на `is_read = false`; ADR фиксирует индексную стратегию (не отдельный materialized view day-1).
- **Bounce-обработка**: day-1 = SMTP ошибка → retry/dead; DSN/bounce-webhooks = Stage-2.

**BLOCKING questions:** нет. Решение фаундера по in-app + email + per-событие + расширяемость закрывает объём; custody SMTP-handle = RL-3 паттерн (T-0025 — прецедент); outbox = T-0062 (прецедент). Статус спеки = `ready`.
