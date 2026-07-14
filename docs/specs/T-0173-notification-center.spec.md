# Spec · T-0173 — Notifications E-N.6: REST API notification-центра + unread badge (частичный индекс) + mark-read

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0173 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2.2 (in-app notification center, REST surface, badge-индекс), §2.7 (ретенция, частичный индекс `idx_notification_unread`), §2.10 (tenant-RLS), §5 E-N.6 (декомпозиция), §6 (FF-OWN-ONLY-READ, FF-NO-CROSS-USER, FF-UNREAD-INDEXED)
**Foundations:** T-0013 (tenant-isolation/RLS), T-0120 §4.1 (notification schema: PK, FK, индексы), T-0168 (миграции 046–048), T-0169 (notification-router: NotifInsertPort), T-0171 (pgPrefStore)
**Deps done:** T-0168 (таблица `choros.notification`, `idx_notification_unread`, `idx_notification_listing`), T-0169 (notification-router), T-0171 (pgPrefStore)
**Parallel task (НЕ трогать):** T-0172 (notification-templates, render/router) — совместная ветка; скоуп T-0173 = только чтение/листинг/badge/mark-read.

---

## 1. Summary

Реализует E-N.6 нотификационного эпика: Postgres-DAO (`pgNotificationStore.ts`) для таблицы `choros.notification` + три REST-эндпоинта notification-центра. Авторизация структурна: получатель видит только свои уведомления (WHERE recipient_id = actor — нет cross-user параметра), tenant-контекст fail-closed (нет GUC → отказ). Listing с keyset-пагинацией по `idx_notification_listing`. Badge (`GET /api/notifications/unread-count`) через COUNT по `idx_notification_unread` — EXPLAIN подтверждает использование частичного индекса. Mark-read (`POST /:id/read` и batch `PATCH /api/notifications`) — атомарно UPDATE WHERE recipient_id = actor (чужую строку пометить нельзя → 404, не мутирует). Тесты: unit + live-DB (BEGIN / SET LOCAL / cleanup).

---

## 2. Functional requirements

- **FR-1** `pgNotificationStore.ts` в `src/core/postgres/pgNotificationStore.ts`: реализует порт `NotifInsertPort` (insert) из `notification-router.ts` + операции для REST: `list(client, params)`, `countUnread(client, recipientId)`, `markRead(client, notifId, recipientId)`, `batchMarkRead(client, ids, recipientId)`.

- **FR-2** `list(client, params)` — paginated listing по `idx_notification_listing` (keyset по `(created_at, id)`). Параметры: `recipientId` (обязательный, сервер-конструируемый), `limit` (default 20, max 100), `cursor` (опциональный keyset-курсор: `{createdAt, id}`), `isRead` (опциональный boolean-фильтр). SQL: `WHERE tenant_id=GUC AND recipient_id=$1 [AND is_read=$2] [AND (created_at, id) < (cursor.createdAt, cursor.id)] ORDER BY created_at DESC, id DESC LIMIT $N`. Возвращает `{ rows, nextCursor }`.

- **FR-3** `countUnread(client, recipientId)` — `SELECT COUNT(*) FROM choros.notification WHERE tenant_id=GUC AND recipient_id=$1 AND is_read=false`. Использует `idx_notification_unread` (частичный индекс WHERE is_read=false). Возвращает `number`.

- **FR-4** `markRead(client, notifId, recipientId)` — атомарно `UPDATE choros.notification SET is_read=true WHERE tenant_id=GUC AND id=$1 AND recipient_id=$2`. Возвращает `boolean` (true если строка найдена и обновлена). Чужая строка (recipient ≠ actor) → не матчится → false.

- **FR-5** `batchMarkRead(client, ids, recipientId)` — `UPDATE … SET is_read=true WHERE tenant_id=GUC AND id=ANY($1) AND recipient_id=$2`. Возвращает число обновлённых строк.

- **FR-6** REST-хендлер `GET /api/notifications` — возвращает listing уведомлений. Авторизация структурна: `recipient_id` ВСЕГДА = `actor` (X-Dev-User header), не из query-параметра. Опциональные параметры: `?is_read=true|false`, `?limit=N`, `?cursor=<base64>`. Ответ: `{ notifications, nextCursor? }`.

- **FR-7** REST-хендлер `GET /api/notifications/unread-count` — возвращает `{ count: N }`. `recipient_id` = actor. Tenant-контекст fail-closed.

- **FR-8** REST-хендлер `POST /api/notifications/:id/read` — помечает одно уведомление прочитанным. `recipient_id` = actor (сервер-конструируемый). Чужое уведомление → 404. Нет appendAuditEvent (FF-NO-ISREAD-AUDIT: is_read не аудитируется).

- **FR-9** REST-хендлер `PATCH /api/notifications` — batch mark-read. Тело: `{ ids: string[] }`. Помечает все переданные ids прочитанными WHERE recipient_id = actor. Чужие ids молча пропускаются (не crash, не 403 per-id). Возвращает `{ updated: N }`.

- **FR-10** Все четыре эндпоинта: tenant-контекст fail-closed (нет X-Dev-User → 401; SET LOCAL GUC в транзакции перед любым SELECT/UPDATE).

- **FR-11** `pgNotificationStore.ts` не содержит appendAuditEvent (FF-NO-ISREAD-AUDIT, FF-NO-DELIVERY-AUDIT). Аудит is_read = не аудитируется по ADR §2.8.

---

## 3. Non-functional requirements

- **NF-1** Own-only чтение и мутация: `GET /api/notifications` и mark-read всегда `WHERE recipient_id = actor` на SQL-уровне. Нет query-параметра для чужого recipient_id (FF-OWN-ONLY-READ).

- **NF-2** No cross-user мутация: `markRead` / `batchMarkRead` возвращают 0 совпадений на чужих строках — UPDATE не применяется; REST `POST /:id/read` возвращает 404 если строка не совпала (FF-NO-CROSS-USER).

- **NF-3** Badge индексированный: `countUnread` должен использовать `idx_notification_unread` (частичный индекс WHERE is_read=false). EXPLAIN `ANALYZE FALSE` на live-DB должен показывать `Index Scan` / `Index Only Scan` на `idx_notification_unread` (FF-UNREAD-INDEXED).

- **NF-4** Keyset корректность: listing без пропусков и дублей — при cursor-пагинации `(created_at, id) <` гарантирует строгое упорядочивание; использует индекс `idx_notification_listing`.

- **NF-5** Tenant-изоляция (FF-T13 / T-0013): все операции DAO внутри транзакции с SET LOCAL choros.tenant_id; без GUC RLS блокирует. Cross-tenant → пусто.

- **NF-6** Нет appendAuditEvent в DAO и в read/mark-read-хендлерах (FF-NO-ISREAD-AUDIT). Только факт mutable в `is_read` колонке.

- **NF-7** pgNotificationStore импортирует `NotifInsertPort` и `NotifInsertRow` из `notification-router.ts` — не редекларирует (pure-DAO).

- **NF-8** Нет нового at-least-once механизма: mark-read = прямой UPDATE, не через outbox.

---

## 4. Out of scope

- Шаблонизация (renderTemplate, notification-templates.ts) — T-0172
- Email channel config REST — T-0170
- Notification preferences REST — T-0171
- publishNotificationEvent / routing / fanout — T-0169
- Full notification center UI (полный экран) — Stage-2
- Admin-обзор чужих уведомлений — ADR §2.2 явно не упоминает admin-просмотр чужих; собственный recipient-scope = единственный авторизованный scope; admin-view в данном ADR не предусмотрен
- Sweeper авто-ретенции — Stage-2
- Push (мобильный) — not-MVP
- DELETE уведомлений через REST — не в E-N.6 scope
- Кеш unread count (Redis, materialized view) — Stage-2

---

## 5. Acceptance criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `pgNotificationStore.ts` структурно совместим с `NotifInsertPort` под `tsc --noEmit`; импортирует `NotifInsertPort`/`NotifInsertRow` из `notification-router.ts`, не редекларирует | fitness |
| AC-2 | `GET /api/notifications` возвращает только уведомления текущего актора (`recipient_id = actor`); посторонний recipient_id игнорируется/не принимается | test |
| AC-3 | Keyset-пагинация корректна: второй запрос с `cursor` из предыдущего ответа не возвращает дубли и не пропускает строки (при фиксированных данных) | test |
| AC-4 | `GET /api/notifications/unread-count` возвращает `{ count: N }` = количество непрочитанных; EXPLAIN live-DB показывает `idx_notification_unread` (частичный индекс) | test + fitness |
| AC-5 | `POST /api/notifications/:id/read` для своего уведомления → 200 `{ ok: true }`, `is_read` = true в БД | test |
| AC-6 | `POST /api/notifications/:id/read` для чужого (другой recipient) или несуществующего id → 404, строка не мутирует | test |
| AC-7 | `PATCH /api/notifications` с `{ ids: [...] }` — помечает все свои ids прочитанными; чужие ids молча пропускаются (updated = только свои совпадения) | test |
| AC-8 | `GET /api/notifications` без X-Dev-User → 401; без SET LOCAL GUC SQL ничего не возвращает (RLS fail-closed) | test |
| AC-9 | Cross-tenant: уведомление tenant A не видно в контексте tenant B ни через listing, ни через unread-count | test |
| AC-10 | `pgNotificationStore.ts` не содержит `appendAuditEvent` ни в каком пути (FF-NO-ISREAD-AUDIT + FF-NO-DELIVERY-AUDIT) | fitness |
| AC-11 | `tsc --noEmit` и `npm test` (vitest) проходят без новых ошибок | fitness |
| AC-12 | `npm run fitness` зелёный (включая существующие `notification-isolation.sh`, `notification-pref-isolation.sh`, `notification-email.sh` + новый `notification-center-isolation.sh`) | fitness |
| AC-13 | `ci/checks/notification-center-isolation.sh` (owner T-0173) зелёный: FF-OWN-ONLY-READ, FF-NO-CROSS-USER, FF-UNREAD-INDEXED (static), FF-NO-ISREAD-AUDIT | fitness |
| AC-14 | `fitness:db` тест `notification-center.test.ts` зелёный: insert + list + unread-count + markRead + batchMarkRead + cross-tenant isolation + EXPLAIN badge-index | test |
