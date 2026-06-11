# Spec · T-0169 — Notifications E-N.2: routing событие→подписка + ChannelDriver-реестр

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0169 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2 (pipeline §2.1, ChannelDriver §2.5, outbox §2.6, fanout §4.4–4.5) и §5 E-N.2 (декомпозиция)
**Foundations:** T-0062 (outbox/dispatcher), T-0013 (tenant-isolation), T-0018/T-0021 (grant/PDP), T-0015 (ObjectRef), T-0033 (DataClass), T-0025 (secret-handle-validator, импорт)
**Deps done:** T-0168 (миграции 046–048 applied)

---

## 1. Summary

Реализует ядро маршрутизации уведомлений (E-N.2): `publishNotificationEvent` как единственная публикующая функция, fanout событие→подписка→notification-строки+outbox-ряды, `ChannelDriver`/`DeliveryJob`/`DeliveryResult`-типы, `makeNotificationDeliver` (реестр как `Map`, не switch), in_app no-op-драйвер — всё в `src/core/notification-router.ts`. Доставка делегирована существующему `runOutboxOnce` (T-0062), второго диспетчера нет.

---

## 2. Functional requirements

- **FR-1** Экспортируется интерфейс `ChannelDriver` с полями `key: string` и методом `deliver(job: DeliveryJob, ctx: TenantCtx): Promise<DeliveryResult>` точно по ADR §2.5/§4.4.

- **FR-2** Экспортируется тип `DeliveryJob` с полями `tenantId`, `recipientId`, `eventKind`, `title`, `body`, `objectRef: ObjectRef | null`, `occurredAt: number` по ADR §2.5.

- **FR-3** Экспортируется тип `DeliveryResult = { ok: true } | { ok: false; retryable: boolean; reason: string }` по ADR §2.5.

- **FR-4** Экспортируется тип `ChannelRegistry = ReadonlyMap<string, ChannelDriver>` по ADR §4.4 (реестр — Map, не switch/enum).

- **FR-5** Экспортируется `interface NotificationEvent` с полями `eventKind: string`, `tenantId: string`, `subjectActorId: string`, `objectRef: ObjectRef | null`, `payload: Record<string, unknown>`, `occurredAt: number` по ADR §4.4. Определён ровно один раз.

- **FR-6** Экспортируется функция `publishNotificationEvent(deps, ev, ctx)` по ADR §4.4. Это единственная публикующая функция; возвращает `{ inAppCreated: number; outboxEnqueued: number }`.

- **FR-7** `publishNotificationEvent` выполняет fanout по ADR §4.5: (1) tenant-gate fail-closed; (2) читает `notification_preference` для `(tenant_id, event_kind)`; (3) разворачивает `recipient_scope`→`recipient_id[]` через role/owner-резолвер; (4) рендерит `title`/`body` (≤ `internal`); (5) per (получатель × канал): in_app → INSERT `notification` + outbox-ряд; email → INSERT outbox-ряд (если `is_enabled`); (6) не пишет `audit_event`.

- **FR-8** Экспортируется функция `makeNotificationDeliver(registry: ChannelRegistry): Deliver` (тип `Deliver` из T-0062 `outboxDispatcher.ts`). Возвращённая функция: распознаёт `row.aggregateKind === 'notification'`, берёт `channel` из `row.payload`, зовёт `registry.get(channel)!.deliver(...)`, маппит `DeliveryResult → DispatchResult`. Нет switch/if по каналу.

- **FR-9** Маппинг `DeliveryResult → DispatchResult` в `makeNotificationDeliver` по ADR §2.6: `{ok:true}→{ok:true}`; `{ok:false,retryable:true}→{ok:false,error}`; `{ok:false,retryable:false}→` immediate-dead (`markRetry` с `maxAttempts=0` — реализуется через `DispatchResult.error` + подбрасывание `opts.maxAttempts=0` в вызывающем коде, но сам `makeNotificationDeliver` возвращает `{ok:false,error}` с пометкой `immediateDeadOnError`; либо альтернативно ADR-флаг через специальный error-prefix — способ выбирает coder при реализации согласно T-0062 semantics: `attempts ≥ maxAttempts` → `dead`).

- **FR-10** Экспортируется in_app-драйвер `inAppNoOpDriver: ChannelDriver` с `key = 'in_app'` и `deliver()` всегда возвращает `{ok:true}` (no-op success по ADR §2.6: строка `notification` уже создана при fanout).

- **FR-11** Outbox-ряд, вставляемый в fanout: `aggregate_kind = 'notification'`, `aggregate_id = notification.id` (для in_app) / синтетический UUID (для email), `event_type = event_kind`, `payload = {channel, recipientId, title, body, objectRef, occurredAt}`, `idempotency_key = 'notif:' + notification_id + ':' + channel` (NOT NULL, дедуп по ADR §2.6).

- **FR-12** Deps-объект `publishNotificationEvent` включает: `prefStore` (читает `notification_preference`), `notifStore` (INSERT `notification`), `outboxStore` (enqueueInTx outbox-ряд), `templates` (renderTemplate), `roleResolver` (разворот `role:<id>`), `clock` (Clock из T-0062). Все порты инъектируемы, нет прямых DB-импортов в `notification-router.ts`.

- **FR-13** `SmtpSecretResolverPort` экспортируется из `notification-router.ts` (или отдельного `notification-types.ts`) — структурно совместим с T-0025 `SecretResolverPort` по ADR §4.4/§8. Day-1 = прямая строка/заглушка.

---

## 3. Non-functional requirements

- **NF-1** Нет switch/enum по каналу в `notification-router.ts` и в `makeNotificationDeliver`: routing/deliver обращаются к каналу ТОЛЬКО через `driverMap.get(key)` (FF-NO-SWITCH-CHANNEL).

- **NF-2** Нотификатор переиспользует `runOutboxOnce`/`PostgresOutboxStore` (T-0062); нет нового диспетчера/очереди/ретрай-петли в коде E-N.2 (FF-ONE-OUTBOX).

- **NF-3** `notification-router.ts` — pure-core: нет прямых `pg`/`node:http`/`node:net`/`fetch`-импортов; все IO за портами.

- **NF-4** `publishNotificationEvent` / email-deliver fail-closed по tenant-контексту: без tenantId → отказ, 0 INSERT/outbox (FF-FANOUT-FAILCLOSED).

- **NF-5** `SmtpSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort` под `tsc` (FF-RESOLVER-PORT).

- **NF-6** `NotificationEvent` определён один раз, `publishNotificationEvent` — одна экспортируемая функция (FF-EVENT-CONTRACT).

- **NF-7** Нет нового `audit_event` в delivery-пути; `appendAuditEvent` не вызывается в `makeNotificationDeliver` (FF-NO-DELIVERY-AUDIT).

- **NF-8** DataClass импортируется из `src/core/data-classification.ts`, не редекларируется.

---

## 4. Out of scope (E-N.3+)

- Email-драйвер (`EmailChannelDriver`), `email_channel_config`-CRUD, SMTP-адаптер — E-N.3
- `notification_preference`-CRUD-хендлеры, defaults-seed при genesis tenant — E-N.4
- `renderTemplate`, `notification-templates.ts` (полный рендерер) — E-N.5
- REST API notification center (`GET /api/notifications`, `POST /:id/read`, `unread-count`) — E-N.6
- Аудит-события `notif.email_config.*` / `notif.preference.changed` — E-N.7
- SLA-watchdog / эскалационный движок как продюсеры `NotificationEvent` — T-0095/E7
- Full notification center UI — Stage-2/зона 7
- Bounce-webhook-обработка — Stage-2
- Реальный `SmtpSecretResolver` (vault/env) — Stage-2 за `SmtpSecretResolverPort`

---

## 5. Acceptance criteria

### AC-1 — `NotificationEvent` определён ровно один раз, `publishNotificationEvent` — ровно одна публикующая функция (test/fitness)
`grep` по `src/core/notification-router.ts` обнаруживает ровно одно `export interface NotificationEvent` и ровно одно `export function publishNotificationEvent`. `tsc --noEmit` проходит на файле фикстуры, импортирующем `NotificationEvent`.
*verifiable_as: fitness*

### AC-2 — `ChannelDriver`-реестр — Map, нет switch/enum по каналу (test/fitness)
`notification-router.ts` не содержит `switch (channel)`, `if (channel === 'email')`, `case 'email':`, `case 'in_app':` в routing/deliver-путях. Обращение к каналу только через `driverMap.get(key)`.
*verifiable_as: fitness*

### AC-3 — `makeNotificationDeliver` использует реестр-Map, не switch (test)
Unit-тест: `makeNotificationDeliver` с двумя зарегистрированными драйверами (in_app, email-mock) — строка с `aggregateKind='notification'` и `payload.channel='email'` → email-mock вызван; `channel='in_app'` → in_app-mock вызван; `channel='unknown'` → `{ok:false}` (нет Driver → не краш, не switch).
*verifiable_as: test*

### AC-4 — in_app-драйвер — no-op success (test)
Unit-тест: `inAppNoOpDriver.key === 'in_app'`; `inAppNoOpDriver.deliver(job, ctx)` всегда возвращает `{ok: true}`.
*verifiable_as: test*

### AC-5 — `publishNotificationEvent` fail-closed без tenant-контекста (test)
Unit-тест с именем `fanout-fail-closed`: вызов `publishNotificationEvent` с `ev.tenantId = ''` или без tenantId → reject/throw, 0 INSERT, 0 outbox-ряд вставлено.
*verifiable_as: test*

### AC-6 — Fanout создаёт notification-строку и outbox-ряд для in_app (test)
Unit-тест: preference содержит `(event_kind='task.assigned', channels=['in_app'])` → `inAppCreated=1`, `outboxEnqueued=1`; outbox-ряд имеет `aggregateKind='notification'`, `payload.channel='in_app'`, `idempotencyKey` начинается с `'notif:'`.
*verifiable_as: test*

### AC-7 — Fanout создаёт только outbox-ряд для email (test)
Unit-тест: preference содержит `channels=['email']`, email `is_enabled=true` → `inAppCreated=0`, `outboxEnqueued=1`; outbox-ряд `payload.channel='email'`.
*verifiable_as: test*

### AC-8 — Fanout пропускает email-канал при `is_enabled=false` (test)
Unit-тест `ac-16-email-if-configured`: preference `channels=['email']`, email_channel_config `is_enabled=false` → `outboxEnqueued=0`.
*verifiable_as: test*

### AC-9 — Один dispatcher, нет нового setInterval/startNotificationDispatcher (fitness)
Grep: `notification-router.ts` не содержит `setInterval`, `startNotificationDispatcher`, `startOutboxDispatcherLoop` — нет своего ретрай-механизма; dispatch через существующий T-0062.
*verifiable_as: fitness*

### AC-10 — `DeliveryResult.retryable:false` маппится в immediate-dead (test)
Unit-тест: `makeNotificationDeliver` — драйвер возвращает `{ok:false, retryable:false, reason:'bad'}` → возвращённый `DispatchResult.ok === false` И содержит маркер `immediateDeadOnError` (или специальный error-prefix) → вызывающий outbox-dispatcher установит `dead` через `maxAttempts=0`.
*verifiable_as: test*

### AC-11 — `SmtpSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort` под `tsc` (fitness)
`tsc --noEmit`: код, присваивающий `SmtpSecretResolverPort`-совместимый объект переменной типа T-0025 `SecretResolverPort`, компилируется без ошибок (структурная совместимость).
*verifiable_as: fitness*

### AC-12 — `notification-router.ts` — pure-core (нет IO-импортов) (fitness)
`notification-router.ts` не содержит прямых импортов `pg`, `node:pg`, `node:http`, `node:net`, `node:https`, `fetch` (все IO за портами).
*verifiable_as: fitness*

### AC-13 — Нет `appendAuditEvent` в delivery-пути (fitness)
Grep: `appendAuditEvent` не вызывается в `makeNotificationDeliver` и в in_app-драйвере.
*verifiable_as: fitness*

### AC-14 — Idempotency_key строится по схеме `'notif:' + notifId + ':' + channel` (test)
Unit-тест: outbox-ряд, вставляемый при fanout с конкретным `notification.id` и `channel='in_app'`, имеет `idempotencyKey = 'notif:' + notification.id + ':in_app'`.
*verifiable_as: test*

### AC-15 — `tsc` и `npm test` проходят на всём проекте (fitness)
`tsc --noEmit` и `npm test` (vitest) выходят с кодом 0. Нет новых ошибок типов в `notification-router.ts` или в тестах.
*verifiable_as: fitness*

### AC-16 — `npm run fitness` и `npm run fitness:db` зелёные (fitness)
`npm run fitness` и `npm run fitness:db` (если применимо в live-impl) выходят с кодом 0. Новый check `ci/checks/notification-isolation.sh` (owner T-0169) присутствует и зелёный.
*verifiable_as: fitness*

---

## 6. Blocking questions

Нет. ADR T-0120 §2.1/§2.5/§2.6/§4.4 однозначно фиксирует:

- Контракт `ChannelDriver`/`DeliveryJob`/`DeliveryResult` — verbatim из ADR §2.5/§4.4.
- Реестр — `Map<ChannelKey, ChannelDriver>`, не switch.
- `makeNotificationDeliver` — один seam для `runOutboxOnce`.
- In_app day-1 = no-op success (INSERT уже в fanout).
- Email day-1 — E-N.3 (здесь только routing + outbox-ряд, Email-драйвер не реализован).
- `SmtpSecretResolverPort` — тип, структурно совместимый с T-0025 `SecretResolverPort`.
- `publishNotificationEvent` — единственная публикующая функция (AC-20 ADR).

---

## 7. Traceability ADR → AC

| ADR §/FF | AC(s) |
|---|---|
| §2.1 pipeline + fanout | AC-5, AC-6, AC-7, AC-8 |
| §2.5 ChannelDriver/Map | AC-1, AC-2, AC-3, AC-4 |
| §2.6 outbox T-0062 integration | AC-9, AC-10, AC-11 |
| §4.4 NotificationEvent/publishNotificationEvent | AC-1, AC-5 |
| §4.4 makeNotificationDeliver | AC-3, AC-10 |
| §4.4 SmtpSecretResolverPort | AC-11 |
| §4.5 fanout sequence | AC-6, AC-7, AC-8, AC-14 |
| FF-EVENT-CONTRACT | AC-1 |
| FF-NO-SWITCH-CHANNEL | AC-2 |
| FF-ONE-OUTBOX | AC-9 |
| FF-FANOUT-FAILCLOSED | AC-5 |
| FF-RESOLVER-PORT | AC-11 |
| FF-NO-DELIVERY-AUDIT | AC-13 |
| NF-3 pure-core | AC-12 |
