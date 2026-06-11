# Spec · T-0170 — Notifications E-N.3: email_channel_config + RL-3 smtp_handle custody + SMTP-драйвер + wiring

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0170 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2.3/§2.6/§2.8/§4.2/§4.4/§4.5/§5 E-N.3; §8 (custody-seam SMTP-секрета)
**Foundations:** T-0025 (secret-handle-validator: `validateSecretHandleShape`/`redactHandle`/`SecretResolverPort`), T-0062 (outbox/dispatcher: `runOutboxOnce`/`Deliver`), T-0013 (tenant-isolation), T-0033 (DataClass), T-0041 (egress-policy)
**Deps done:** T-0169 (notification-router.ts: `ChannelDriver`, `ChannelRegistry`, `makeNotificationDeliver`, `SmtpSecretResolverPort`, `EmailChannelConfigStore`), T-0168 (migrations 046–048: `email_channel_config` table applied)

**ABSORBED SCOPE:** Задача T-0190 (wiring) поглощена этой задачей. Скоуп T-0170 ВКЛЮЧАЕТ регистрацию `makeNotificationDeliver` в production dispatch loop (`lifecycle-bridge.ts:236` — сейчас только `makeExternalTaskDeliver`). Wired-entry тест от composition root ОБЯЗАТЕЛЕН.

---

## 1. Summary

Реализует E-N.3: `EmailChannelDriver` (`requiresEmailConfig=true`, ADR §2.5/§4.4) с RL-3 custody для `smtp_handle` (T-0025 `validateSecretHandleShape`/`redactHandle` + `SmtpSecretResolverPort`-seam), `email_channel_config`-CRUD (audit через `appendAuditEvent`), SMTP-адаптер (`src/adapters/smtp-sender.ts` — pure port, без реальных SMTP-звонков в тестах), и **wiring** `makeNotificationDeliver` в production dispatch loop (`lifecycle-bridge.ts`). Immediate-dead семантика реализуется честно: `markRetry(id, 0)` через `opts.maxAttempts=0` при вызове нотификационного dispatcher-instance. Сырой SMTP-секрет структурно недостижим: `validateSecretHandleShape` блокирует `sk-`/hex-32+/JWT при set/rotate; `redactHandle` на status-путях; resolved secret остаётся только внутри драйвера.

---

## 2. Functional requirements

- **FR-1** `EmailChannelDriver` реализует `ChannelDriver` (из `notification-router.ts`) с `key = 'email'` и `requiresEmailConfig = true` (ADR §2.5 delta / T-0169 jsdoc). Метод `deliver(job, ctx)` принимает `DeliveryJob` + `TenantCtx` и возвращает `Promise<DeliveryResult>`.

- **FR-2** `EmailChannelDriver` резолвит `smtp_handle` через инжектируемый `SmtpSecretResolverPort` (из `notification-router.ts`) ТОЛЬКО в worker-контексте при вызове `deliver`. Resolved secret не покидает драйвер (не в лог, не в audit, не в исключение — NF-2 / ADR §2.3).

- **FR-3** `EmailChannelDriver` формирует `From: <from_name> <from_address>` из `email_channel_config`; конверт идёт через SMTP/API клиента (платформа не SMTP-relay). Нет захардкоженного relay-домена в драйвере.

- **FR-4** SMTP-адаптер (`src/adapters/smtp-sender.ts`) — инжектируемый порт `SmtpSenderPort` с методом `sendEmail(opts: SmtpSendOpts): Promise<SmtpSendResult>`. Day-1 `SmtpSendOpts` включает: `host`, `port`, `tls`, `from`, `to`, `subject`, `text` (plain-text body), `html` (HTML body, optional). Day-1 реализация адаптера (`NodemailerSmtpSender` или inline stubbed) — используется только в production; в тестах инжектируется стаб. РЕАЛЬНАЯ SMTP-отправка В ТЕСТАХ ЗАПРЕЩЕНА (нет внешних эффектов).

- **FR-5** `email_channel_config`-CRUD (`setEmailChannelConfig`, `getEmailChannelConfigStatus`) — application-layer сервисы в `src/core/notification-email.ts`. `setEmailChannelConfig` валидирует `smtp_handle` через `validateSecretHandleShape` перед записью в БД (RL-3 shape-guard). Возвращает `{ok:false, reason: SecretHandleRejectReason}` при отказе shape-guard.

- **FR-6** `getEmailChannelConfigStatus` возвращает статус-объект без raw `smtp_handle`; использует `redactHandle(smtp_handle)` для вывода handle (ADR §2.3 / NF-2).

- **FR-7** Аудит конфигурации через `appendAuditEvent` (T-0016): `notif.email_config.set` при создании/обновлении, `notif.email_config.revoke` при отзыве. Payload аудита несёт `from_address`/`smtp_host`; НИКОГДА не несёт `smtp_handle`/resolved secret (ADR §2.8).

- **FR-8** Immediate-dead семантика: `DeliveryResult.retryable:false` от email-драйвера должна немедленно перевести outbox-ряд в `dead` без цикла back-off. Реализация: нотификационный dispatcher-instance вызывает `runOutboxOnce` с `maxAttempts=1` (или wiring использует `markRetry(id, 0)` механику T-0062: `attempts ≥ maxAttempts` → `dead`). В `makeNotificationDeliver` уже возвращается `{ok:false, error: IMMEDIATE_DEAD_ERROR_PREFIX+reason}` — честная реализация означает, что wiring использует `maxAttempts=1` для notification rows.

- **FR-9** Wiring: `makeNotificationDeliver(registry)` регистрируется в `lifecycle-bridge.ts` в production dispatch loop (сейчас только `makeExternalTaskDeliver`). Registry включает `inAppNoOpDriver` и `emailChannelDriver`. Два варианта wiring: (a) отдельный `startOutboxDispatcherLoop` для notification rows с `maxAttempts=1`, или (b) compose `deliver`-функций: сначала `makeNotificationDeliver`, fallthrough для non-notification rows в `makeExternalTaskDeliver`.

- **FR-10** Wired-entry тест (FE-W24-0045): от composition root `startLifecycleBridge` с инжектируемыми in-memory boundary IO — проверяет что `makeNotificationDeliver` реально вызывается при наличии notification outbox-ряда. Тест не делает реальных SMTP-звонков (стаб драйвер).

- **FR-11** `EmailChannelDriver` — fail-closed по tenant-контексту: без `ctx.tenantId` — `{ok:false, retryable:false, reason:'no_tenant_context'}` (ADR §2.10 / FF-FANOUT-FAILCLOSED).

- **FR-12** Egress-граница: `body` email ≤ `internal` data-class (фильтр fanout T-0169); `DataClass` импортируется из `data-classification.ts`, не редекларируется. Egress runtime-гейт = Stage-2 (как T-0041/T-0119); граница зафиксирована схемой.

---

## 3. Non-functional requirements

- **NF-1** Сырой SMTP-секрет нигде: `smtp_handle` / resolved secret НЕ появляется в `console.*`, `appendAuditEvent`, `res.json`, exception message (FF-NO-RAW-SMTP). Status-путь возвращает `redactHandle(smtp_handle)`.

- **NF-2** RL-3 shape-guard: `setEmailChannelConfig` с `sk-…`/bare-hex-32+/JWT-shape → `{ok:false, reason: …}`, запись НЕ происходит (FF-HANDLE-SHAPE).

- **NF-3** Custody-seam: `SmtpSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort` под `tsc --noEmit`. Нет LLM-вызовов, нет платформенного relay в email-драйвере (FF-RESOLVER-PORT).

- **NF-4** Отправка от имени клиента: `From` = `from_name <from_address>` из `email_channel_config`. Нет захардкоженного relay-домена (FF-EMAIL-FROM-CLIENT).

- **NF-5** Wiring fail-closed: email-deliver без tenant-контекста → отказ, нет SMTP-звонка (FF-FANOUT-FAILCLOSED).

- **NF-6** Нет нового dispatch-механизма: `makeNotificationDeliver` инжектируется в СУЩЕСТВУЮЩИЙ `runOutboxOnce` / `startOutboxDispatcherLoop`. Нет `setInterval`, нет нового `startEmailDispatcher` в notification-email.ts или в адаптере (FF-ONE-OUTBOX).

- **NF-7** `notification-email.ts` — pure-core: нет прямых `pg`/`node:http`/`node:net`/`fetch`-импортов. Все IO (SMTP-адаптер, email-config store) за инжектируемыми портами.

- **NF-8** Нет `appendAuditEvent` в delivery-пути email-драйвера (FF-NO-DELIVERY-AUDIT). Доставка = `outbox.dispatched_at`.

- **NF-9** `EmailChannelDriver.requiresEmailConfig === true` — флаг ОБЯЗАТЕЛЕН (T-0169 jsdoc: «REQUIRED: any EmailChannelDriver implementation MUST set `requiresEmailConfig: true`»). Fanout T-0169 читает этот флаг без сравнения ключей.

---

## 4. Out of scope

- notification_preference-CRUD, defaults-seed — E-N.4
- renderTemplate, notification-templates.ts — E-N.5
- REST API notification center, `/api/email-channel-config` route — E-N.6
- audit-события `notif.preference.changed` — E-N.7
- Реальный `SmtpSecretResolver` (vault/env клиента) — Stage-2
- Bounce-webhook-обработка DSN — Stage-2
- Tenant-configurable шаблоны — Stage-2
- push (мобильный) — not-MVP
- SLA-watchdog / эскалации как продюсеры NotificationEvent — T-0095/E7

---

## 5. Acceptance criteria

### AC-1 — `EmailChannelDriver.requiresEmailConfig === true` (test)
Unit-тест: `emailChannelDriver.requiresEmailConfig === true`; `emailChannelDriver.key === 'email'`.
*verifiable_as: test*

### AC-2 — `EmailChannelDriver.deliver` вызывает `SmtpSecretResolverPort.resolveSecret` (test)
Unit-тест `email-driver-resolves-secret`: `deliver(job, ctx)` с mock-resolver → resolver вызван с `(handle, { tenantId })`.
*verifiable_as: test*

### AC-3 — Resolved secret не покидает драйвер (fitness + test)
- `grep` по `src/core/notification-email.ts` и `src/adapters/smtp-sender.ts`: `smtp_handle` / resolved-secret не передаётся в `console.*`, `appendAuditEvent`, `res.json`, исключение. (FF-NO-RAW-SMTP)
- Unit-тест: при SMTP-ошибке driver возвращает `{ok:false, retryable:true}` без expose секрета в `reason`.
*verifiable_as: fitness*

### AC-4 — RL-3 shape-guard: `setEmailChannelConfig` отвергает raw-секреты (test)
Unit-тесты именованные `smtp-handle-shape`:
- `sk-abc123def456` → `{ok:false, reason:'vendor_key_prefix'}`.
- bare hex-32+ → `{ok:false, reason:'bare_hex_token'}`.
- JWT-shape (`eyJ…`) → `{ok:false, reason:'jwt_shape'}`.
- valid opaque handle (e.g. `vault://secret/smtp`) → `{ok:true}`, запись происходит.
*verifiable_as: test*

### AC-5 — `getEmailChannelConfigStatus` возвращает `redactHandle` (test)
Unit-тест: после `setEmailChannelConfig` с valid handle → `getEmailChannelConfigStatus` возвращает объект с `handleRedacted: redactHandle(handle)`, НЕ raw handle.
*verifiable_as: test*

### AC-6 — Аудит config-изменений (test)
Unit-тест `audit-config`: `setEmailChannelConfig` эмитит `audit_event` типа `notif.email_config.set`; payload содержит `from_address`/`smtp_host`; НЕ содержит `smtp_handle`.
*verifiable_as: test*

### AC-7 — `From` из `email_channel_config` (test)
Unit-тест `email-from-client`: SMTP-адаптер-стаб получает `from = 'from_name <from_address>'` точно из конфига; нет захардкоженного relay-домена в драйвере.
*verifiable_as: test*

### AC-8 — `deliver` fail-closed без tenant-контекста (test)
Unit-тест `fanout-fail-closed` (email): `emailChannelDriver.deliver(job, { tenantId: '' })` → `{ok:false, retryable:false}`, нет SMTP-звонка.
*verifiable_as: test*

### AC-9 — `SmtpSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort` под `tsc` (fitness)
`tsc --noEmit`: `SmtpSecretResolverPort`-совместимый объект присваивается переменной типа T-0025 `SecretResolverPort` — 0 ошибок. Нет LLM-вызовов/relay-домена в `notification-email.ts`. (FF-RESOLVER-PORT)
*verifiable_as: fitness*

### AC-10 — Нет `appendAuditEvent` в delivery-пути email-драйвера (fitness)
`grep` по `notification-email.ts`: `appendAuditEvent` не вызывается внутри `deliver`-пути (только в config-CRUD). (FF-NO-DELIVERY-AUDIT)
*verifiable_as: fitness*

### AC-11 — Нет нового dispatcher/setInterval в `notification-email.ts` (fitness)
`grep`: нет `setInterval`, `startEmailDispatcher`, `startOutboxDispatcherLoop` в `src/core/notification-email.ts` и `src/adapters/smtp-sender.ts`. (FF-ONE-OUTBOX)
*verifiable_as: fitness*

### AC-12 — `makeNotificationDeliver` зарегистрирован в production dispatch loop (fitness + wired-entry test)
- `grep` по `src/server/lifecycle-bridge.ts`: `makeNotificationDeliver` импортирован и используется в `startLifecycleBridge`.
- Wired-entry тест от composition root: `startLifecycleBridge` с in-memory stores + stub email-driver — outbox-ряд `aggregate_kind='notification'` → `deliver` email-стаба вызван.
*verifiable_as: fitness*

### AC-13 — Immediate-dead: `retryable:false` не уходит в back-off (test)
Unit-тест: `makeNotificationDeliver` — driver возвращает `{ok:false, retryable:false, reason:'perm'}` → `DispatchResult.error` начинается с `IMMEDIATE_DEAD_ERROR_PREFIX`; wiring lifecycle-bridge использует `maxAttempts=1` для notification dispatcher (или equivalent row dies on attempt 1).
*verifiable_as: test*

### AC-14 — `DataClass` импортируется из `data-classification.ts` (fitness)
`grep` по `notification-email.ts`: `DataClass` импортируется из `../core/data-classification.js`, не редекларируется. (FF-EGRESS-CLASS)
*verifiable_as: fitness*

### AC-15 — `tsc --noEmit` и `npm test` зелёные (fitness)
`tsc --noEmit` и `npm test` (vitest) выходят с кодом 0. Нет новых ошибок типов.
*verifiable_as: fitness*

### AC-16 — `npm run fitness` зелёный (fitness)
`npm run fitness` (включая `notification-isolation.sh` и новый `ci/checks/notification-email.sh`) выходит с кодом 0.
*verifiable_as: fitness*

### AC-17 — `npm run fitness:db` (1 pass) зелёный (fitness)
Один прогон `npm run fitness:db` (live-impl DB probe) завершается с кодом 0.
*verifiable_as: fitness*

---

## 6. Blocking questions

Нет. ADR T-0120 §2.3/§2.6/§4.2/§4.4/§8 и T-0025 однозначно фиксируют все контракты. T-0169 уже содержит `SmtpSecretResolverPort` и `EmailChannelConfigStore`. Wiring-паттерн аналогичен T-0068 (`makeExternalTaskDeliver`). Immediate-dead = `IMMEDIATE_DEAD_ERROR_PREFIX` из T-0169 + `maxAttempts=1` в notification dispatcher-instance.

---

## 7. Traceability ADR → AC

| ADR §/FF | AC(s) |
|---|---|
| §2.3 email_channel_config + RL-3 smtp_handle | AC-4, AC-5, AC-6 |
| §2.5 ChannelDriver (requiresEmailConfig) | AC-1 |
| §2.6 outbox immediate-dead | AC-13 |
| §2.8 аудит только config, не delivery | AC-6, AC-10 |
| §4.2 email_channel_config schema | AC-4, AC-5, AC-7 |
| §4.4 SmtpSecretResolverPort + deliver | AC-2, AC-9 |
| §4.5 wiring makeNotificationDeliver | AC-12 |
| §8 custody-seam day-1 | AC-2, AC-9 |
| FF-NO-RAW-SMTP | AC-3, AC-5 |
| FF-HANDLE-SHAPE | AC-4 |
| FF-RESOLVER-PORT | AC-9 |
| FF-EMAIL-FROM-CLIENT | AC-7 |
| FF-FANOUT-FAILCLOSED | AC-8, AC-11 |
| FF-ONE-OUTBOX | AC-11 |
| FF-NO-DELIVERY-AUDIT | AC-10 |
| FF-EGRESS-CLASS | AC-14 |
| FE-W24-0045 wired-entry | AC-12 |
