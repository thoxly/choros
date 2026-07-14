# Spec · T-0171 — Notifications E-N.4: notification_preference per-событие + defaults-seed

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0171 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2.4 (per-событие подписка), §4.3 (notification_preference schema), §5 E-N.4 (декомпозиция: CRUD + defaults-seed), §6 (FF-PREF-AUTHZ/FF-SELF-PREF-SCOPED/FF-DEFAULTS-SEED)
**Foundations:** T-0013 (tenant-isolation/RLS), T-0018/T-0021 (grant/PDP — `mgmt_object:notification_config`), T-0026 (genesis-seed идемпотентный паттерн), T-0062 (outbox — импорт типов), T-0169 (notification-router: `NotificationPrefStore`, `NotificationPreference`, `NotificationPrefStore.getPreferences`)
**Deps done:** T-0168 (миграция 048 applied — таблица `notification_preference`), T-0169 (router с `NotificationPrefStore`-портом)

---

## 1. Summary

Реализует E-N.4 нотификационного эпика: Postgres-DAO (`pgPrefStore.ts`) для таблицы `choros.notification_preference`, реализующий порт `NotificationPrefStore` (читаемый router T-0169), плюс операции UPSERT/list/delete для admin- и self-эндпоинтов. Defaults-seed при genesis-tenant: идемпотентный набор подписок по умолчанию (`task.assigned→in_app`, `approval.requested→in_app`, `sla.warning→in_app+email`, `sla.breach→in_app+email`, `escalation.raised→in_app+email`) — как seed-паттерн T-0026. REST-поверхность для admin (`GET/PUT /api/notification-preferences`) и self (`GET/PUT /api/notification-preferences/self`) — scope-ограниченный self-эндпоинт структурно пишет только `actor:<self>`, не может тронуть `role:`/чужой `actor:`.

---

## 2. Functional requirements

- **FR-1** `pgPrefStore.ts` реализует порт `NotificationPrefStore` из `notification-router.ts`: метод `getPreferences(tenantId, eventKind): Promise<NotificationPreference[]>`, читает из `choros.notification_preference` под активным RLS-контекстом (GUC `choros.tenant_id` должен быть SET caller-ом).

- **FR-2** `pgPrefStore.ts` реализует дополнительные операции для REST-хендлеров: `upsert(row): Promise<void>` (ON CONFLICT (tenant_id, event_kind, recipient_scope) DO UPDATE), `listByTenant(): Promise<NotificationPreference[]>` (все подписки текущего tenant), `delete(eventKind, recipientScope): Promise<void>`.

- **FR-3** Defaults-seed при genesis-tenant: идемпотентная функция `seedDefaultPreferences(tx, tenantId, clock)` вставляет 5 строк по умолчанию (ON CONFLICT DO NOTHING) по ADR §2.4:
  - `{event_kind: 'task.assigned',        recipient_scope: 'actor:assignee',   channels: ['in_app']}`
  - `{event_kind: 'approval.requested',   recipient_scope: 'actor:approver',   channels: ['in_app']}`
  - `{event_kind: 'sla.warning',          recipient_scope: 'object_owner',     channels: ['in_app', 'email']}`
  - `{event_kind: 'sla.breach',           recipient_scope: 'object_owner',     channels: ['in_app', 'email']}`
  - `{event_kind: 'escalation.raised',    recipient_scope: 'escalation_chain', channels: ['in_app', 'email']}`

  Идемпотентность: повторный вызов не меняет существующие строки (ON CONFLICT DO NOTHING). Tenant-admin переопределяет через UPSERT.

- **FR-4** REST-хендлер `GET /api/notification-preferences` (tenant-admin): возвращает все подписки текущего tenant. Авторизация: PDP `mgmt_object:notification_config` / `read` (T-0021, через `resolveFor`). Нет второго ACL.

- **FR-5** REST-хендлер `PUT /api/notification-preferences` (tenant-admin): UPSERT подписки. Авторизация: PDP `mgmt_object:notification_config` / `update`. Нет нового ACL. Возвращает 200 + upserted row.

- **FR-6** REST-хендлер `GET /api/notification-preferences/self` (рядовой пользователь): возвращает свои подписки (`recipient_scope = 'actor:' + actor_id`). Структурно не видит чужих/role-scope подписок (WHERE recipient_scope = 'actor:' + actor).

- **FR-7** REST-хендлер `PUT /api/notification-preferences/self` (рядовой пользователь): UPSERT подписки с жёстко зафиксированным `recipient_scope = 'actor:' + actor_id`. Тело запроса содержит `event_kind` и `channels`; `recipient_scope` из тела **игнорируется/переопределяется** сервером. Нельзя поставить `role:x` или чужой `actor:y` — структурный барьер.

- **FR-8** Аудит `notif.preference.changed`: вызов `appendAuditEvent` при изменении preference через admin-эндпоинт (PUT). Payload содержит `event_kind`, `recipient_scope`, `channels`; не содержит секретов. Self-эндпоинт (FR-7) тоже аудитирует (т.к. изменение конфигурации). По ADR §2.8/§6 FF-AUDIT-CONFIG-ONLY.

- **FR-9** Модуль `pgPrefStore.ts` находится в `src/core/postgres/pgPrefStore.ts`. Импортирует `NotificationPrefStore` и `NotificationPreference` из `../notification-router.js`. Нет прямого `import pg` в `notification-router.ts` (pure-core инвариант T-0169 остаётся).

---

## 3. Non-functional requirements

- **NF-1** Авторизация preferences через PDP T-0021 (`resolveFor`) — нет нового `notification_acl` или `pref_rights`-таблицы/механизма. Grep: нет нового `CREATE TABLE.*pref_acl` / `pref_rights` в коде (FF-PREF-AUTHZ).

- **NF-2** Self-эндпоинт структурно ограничен `actor:$self`: `recipient_scope` конструируется на сервере из актора, не из тела запроса. Нельзя передать `role:x` или `actor:other-id` — структурная защита (FF-SELF-PREF-SCOPED).

- **NF-3** Defaults-seed идемпотентен: повторный вызов не изменяет строки, не падает при конфликте. ON CONFLICT DO NOTHING (как T-0026 genesis-owner seed).

- **NF-4** `pgPrefStore.ts` не содержит IO-зависимостей помимо `pg`. Нет прямых fetch/http. Нет своего append-only механизма.

- **NF-5** Аудит при изменении preferences: `appendAuditEvent` вызывается через AuditWriter, не дублирует механизм (FF-AUDIT-CONFIG-ONLY). `is_read`-события не аудитируются (FF-NO-ISREAD-AUDIT).

- **NF-6** getPreferences fail-closed без GUC: вызов без SET choros.tenant_id → RLS возвращает 0 строк (Postgres-ответственность, не try/catch в коде).

---

## 4. Out of scope

- Email-драйвер (`EmailChannelDriver`), `email_channel_config`-CRUD, SMTP-адаптер — E-N.3 (параллельная ветка T-0170)
- `renderTemplate`, `notification-templates.ts` — E-N.5
- REST API notification center (`GET /api/notifications`, `POST /:id/read`, `unread-count`) — E-N.6
- Аудит `notif.email_config.*` — E-N.3/E-N.7 (EmailChannelDriver)
- SLA-watchdog / эскалации как продюсеры `NotificationEvent` — T-0095/E7
- Full notification center UI — Stage-2/зона 7
- Tenant-configurable шаблоны — Stage-2
- Реальный `SmtpSecretResolver` (vault/env) — Stage-2

---

## 5. Acceptance criteria

| id | text | verifiable_as |
|---|---|---|
| AC-1 | `pgPrefStore.ts` экспортирует класс/объект, реализующий `NotificationPrefStore` (структурная совместимость под `tsc --noEmit`) | fitness |
| AC-2 | `getPreferences(tenantId, eventKind)` возвращает строки из `choros.notification_preference` при SET choros.tenant_id; без GUC возвращает [] (RLS изоляция) | test + live-impl |
| AC-3 | `upsert` записывает новую строку; повторный upsert с теми же (tenant_id, event_kind, recipient_scope) обновляет channels (ON CONFLICT DO UPDATE) | test + live-impl |
| AC-4 | `seedDefaultPreferences` вставляет ровно 5 строк по умолчанию при первом вызове; повторный вызов не меняет channels (idempotent) | test + live-impl |
| AC-5 | Все 5 defaults имеют корректные event_kind / recipient_scope / channels по ADR §2.4 | test |
| AC-6 | `GET /api/notification-preferences` возвращает 403 без grant `mgmt_object:notification_config`/`read`; возвращает список подписок при наличии гранта | test |
| AC-7 | `PUT /api/notification-preferences` возвращает 403 без grant `mgmt_object:notification_config`/`update`; выполняет UPSERT при гранте и пишет `notif.preference.changed` audit_event | test |
| AC-8 | `PUT /api/notification-preferences/self` с `recipient_scope: 'role:manager'` в теле → 400 (структурный барьер FF-SELF-PREF-SCOPED); с валидным `event_kind` → 200, сохранён `actor:<self>` | test |
| AC-9 | `GET /api/notification-preferences/self` возвращает только строки `actor:<self>`, не видит `role:`/чужой `actor:` | test |
| AC-10 | Нет нового ACL-механизма в коде (grep: нет `notification_acl`, `pref_rights` в created tables/imports) — только вызов `resolveFor` (FF-PREF-AUTHZ) | fitness |
| AC-11 | `tsc --noEmit` и `npm test` (vitest) проходят без новых ошибок | fitness |
| AC-12 | `npm run fitness` (включая `notification-isolation.sh`) зелёный | fitness |
| AC-13 | Новый `ci/checks/notification-pref-isolation.sh` зелёный (FF-PREF-AUTHZ, FF-SELF-PREF-SCOPED, FF-DEFAULTS-SEED проверки) | fitness |
| AC-14 | Live-DB: `fitness:db` — тест `notification-preferences.test.ts` (owner T-0171) зелёный: getPreferences + UPSERT + seed + cross-tenant isolation | live-impl |

---

## 6. Design notes

- **Scope `actor:assignee` / `actor:approver`**: в seed используются вспомогательные scope-строки, не привязанные к конкретному UUID, т.к. конкретный исполнитель/согласующий неизвестен при genesis. Routing-слой (T-0169) разворачивает `actor:<id>` → конкретный recipient_id; при значениях без валидного UUID `expandScope` вернёт `[]` — безопасно (нет уведомлений без конкретного получателя, что верно для системных дефолтов). Настоящие подписки `actor:<employee_id>` создаются tenant-admin-ом или self-эндпоинтом после genesis.
- **PDP-вызов в REST-хендлерах**: используется `resolveFor` (T-0021) с action `read`/`update`, resource `mgmt_object:notification_config`. Нет нового таблицы прав.
- **Аудит**: `appendAuditEvent` вызывается в рамках той же транзакции, что и `upsert` (паттерн lifecycle-audit T-0068).
- **Конфликтность с T-0170 (E-N.3)**: email-канал и `EmailChannelDriver` — территория T-0170; `pgPrefStore.ts` ссылается только на `notification_preference`-таблицу. `EmailChannelConfigStore`-порт (`getConfig`) используется router-ом T-0169 — его реализация (`pgEmailChannelConfigStore`) может быть в T-0170 или T-0171; по сути принадлежит T-0170 (email-конфиг). T-0171 реализует только preference-сторону.
