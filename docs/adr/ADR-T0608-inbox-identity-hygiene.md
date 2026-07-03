# ADR-T0608 — Инбокс/identity гигиена: шесть точечных фиксов

**Status:** ready
**Phase:** DESIGN
**Task:** T-0608 [P2]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0608-inbox-identity-hygiene.spec.md` + `docs/specs/T-0608.spec.contract.json` (AC-1..AC-16)
**База:** dev @ `6ae4299` (ветка `task/T-0608-inbox-identity-hygiene`)

---

## 1. Решения (по пункту)

### 1.1. (а) Стейл-задачи + (б) Дубли — ОДИН механизм

Разведка показала: (а) и (б) — проявления ОДНОГО пробела в
`listInstanceInboxTasks` (`src/http/process-projection.ts:906-978`).

База прячется по ДВУМ условиям (было): свой `task.approved` ИЛИ
`instance.ended`. Добавляется ТРЕТЬЕ: существование хотя бы одной
`process.next_task`-строки для того же инстанса.

```
// было
if (approvedTaskIds.has(row.id)) continue;
if (endedInstanceIds.has(inst)) continue;

// стало
if (approvedTaskIds.has(row.id)) continue;
if (endedInstanceIds.has(inst)) continue;
if (instancesWithNextTask.has(inst)) continue;   // T-0608 (б)
```

**Почему это безопасно (не ломает AND-split/6M, T-0456):** ВСЕ четыре
эмит-сайта `appendNextTaskEvent` (`reconcileInstanceTimers` T-0458,
`reconcileInstanceEngineDrive` T-0522/T-0571 ×2, `deliverMessageEnvelope`
T-0459, `surfaceMessageCatchWaits`) пишут `process.next_task` СТРОГО ПОСЛЕ
живого `engine.getActiveUserTasks`-вызова, подтвердившего, что движок УЖЕ
продвинулся на новый активный таск. Существование `next_task`-строки —
proof, что base-шаг больше не активен на движке, НЕЗАВИСИМО от того, писал
ли наш `/action`-эндпоинт `task.approved` для базового ряда. В AND-split
(6M) сценарии base уже approved ДО появления concurrent next_task-рядов
(человек approve'ит базовый шаг → гейтвей форкует N веток) — новое условие
там никогда не является ПЕРВОЙ причиной прятать (approved уже прячет), оно
лишь закрывает СЛУЧАЙ, где approve никогда не произошёл через наш путь
(таймер-эскалация с ДРУГОЙ ролью — эскалация НЕ гейтится по совпадению
роли, `process-projection.ts:1109-1124`).

**(а) отдельно не требует нового кода.** `reconcileInboxEngineDriveOnRead`
(T-0522, уже в проде) re-drive'ит КАЖДЫЙ waiting-инстанс на каждом
`GET /api/inbox`, независимо от «approved хоть раз нашим путём»; если
движок сообщает `isInstanceEnded=true`, эмитится `instance.ended` и
base-строка гаснет. Регресс-тест (`inbox-engine-drive.test.ts`, «T-0608 а»)
это доказывает — не новый код, лок существующего корректного поведения.
Историческая `dafc9b66` (живой факт) — контрольный инстанс ДО фикса T-0571
(когда `completeUserTask` был no-op, BUG-014) — легаси-артефакт, не
воспроизводимый текущим кодом; остаточный разрыв («движок перешёл на
ДРУГОЙ активный таск, не ended») закрыт фиксом (б).

### 1.2. (в) Сырые коды approve/complete

`ACTION_ERROR_MESSAGE` (объект-карта, mirror `CLAIM_ERROR_MESSAGE` из
T-0605) + `actionErrorMessage(code)` (проверяет `ENGINE_DRIVE_ERROR_MESSAGE`
первым, затем `ACTION_ERROR_MESSAGE`, затем ещё-человеческий fallback
`` `Не удалось выполнить действие: ${code}` ``). Заменяет: одноразовый
инлайн-тернар в `handleComplete` (`code === 'NOT_ELIGIBLE' ? '...' :
`Ошибка: ${code}` `` `) и полное отсутствие маппинга в `approveTask`.

### 1.3. (г) UUID вместо имён

Два независимых display-разрыва, ОБА чинятся display-фолбэком, БЕЗ
изменения записи (генезис уже честен — см. §4):

1. `GET /api/org/tenant-state` теперь селектит `display_name` (аддитивно —
   `SELECT id, slug, display_name` вместо `SELECT id, slug`). Дропдаун
   `ra-overview-forms.jsx` рендерит `formatPersonName(e.display_name) ||
   e.slug`.
2. `screen-record-detail.jsx` резолвит `record.created_by` (актор-slug)
   через `GET /api/org` (переиспользован `fetchEmployees`, ЭКСПОРТИРОВАН из
   `field-renderer.jsx` — не дублируется вторая fetch-логика) →
   `formatPersonName(authorNames.get(created_by)) || created_by`.

`formatPersonName(name, secondaryId)` (`web/src/lib/format.js`) — новая
чистая функция: пустое имя + доступный secondary (email/slug) → «Без имени
(X)»; оба пусты → `null` (вызывающий сам решает последний фолбэк — никогда
не изобретает подмену).

### 1.4. (д) Счётчик держателей + дубли

`holderCount(role) = dedupHolders(role.assignments).length` — число
РАЗЛИЧНЫХ `employee_id`, заменяет `grantCount(role) = role.grants.length`
(число грантов роли — независимая от держателей величина, ноль корреляции).

`dedupHolders(assignments)` группирует по `employee_id`, схлопывает в один
объект-holder, несущий ВСЕ исходные `assignment.id` в поле `ids`.
`RevokeAssignmentButton` принимает `ids` (в дополнение к legacy `id`) и
отзывает КАЖДЫЙ id последовательно на одно подтверждение — критично, чтобы
отзыв дубля не оставлял «невидимый» активный ряд (revoke только первого id
из двух создал бы ЛОЖНОЕ ощущение отзыва при реально сохранённом доступе).

**Read DAO (`rights-overview.ts`) НЕ меняется** — продолжает честно
возвращать ВСЕ `role_assignment`-ряды как ground truth; дедуп — чисто
display-слой экрана, не сокрытие состояния от админа (админ по-прежнему
может отозвать оба ряда, теперь одним кликом вместо двух).

### 1.5. (е) 401 mid-session

`fetchWithAuthRetry(url, init)` (`web/src/app-shell/dev-auth.js`) —
опциональный fetch-обёртчик, СТРОЯЩИЙСЯ НА authHeaders() (не
дублирует/не обходит его):

1. Обычный `fetch` с текущими headers.
2. Если статус ≠ 401 — возврат как есть.
3. Если 401 И dev mode (нет концепции токена/истечения) — возврат как есть
   (passthrough, поведение НЕ меняется для dev-режима).
4. Если 401 И keycloak mode — ОДИН `kc.tryRefresh` (уже существующая
   функция, уже используемая в boot-time bootstrap `shell.jsx`). Неудача
   (нет refresh-токена / refresh упал — `tryRefresh` уже чистит сессию) →
   `kc.login()` (редирект), возврат оригинального 401-Response.
5. Успех refresh → ОДИН ретрай оригинального запроса с новыми headers.
   Если ретрай ТОЖЕ 401 (отозванная сессия, не просто истёкшая) —
   `kc.login()` редирект, НЕ повторный цикл.

Применено ТОЛЬКО к `screen-inbox.jsx` (7 fetch-сайтов: form-binding,
task-detail, complete-action, load, load-more, claim, approve) — живой
факт приёмки наблюдался именно там. Остальные 28+ экранов, использующих
`authHeaders()`/`devHeaders()` напрямую — НЕ тронуты (follow-up, §5).

## 2. Отвергнутые альтернативы

1. **(б) Гейтить эскалацию по совпадению роли строже (менять
   `reconcileInstanceTimers`'s исключение).** Отвергнуто: причина дубля —
   не в ЭМИТЕ next_task (эмит корректен — эскалация ДОЛЖНА идти на другую
   роль), а в том, что base-строка не знает о существовании альтернативы.
   Фикс в источнике эмита не решил бы `reconcileInstanceEngineDrive`/
   `deliverMessageEnvelope`/`surfaceMessageCatchWaits` — те же 4 сайта
   пришлось бы патчить по отдельности. Единая точка (listInstanceInboxTasks)
   закрывает ВСЕ 4 пути одним условием.
2. **(а) Явный TTL/cron для "протухших" pool-задач (напр. "если строка
   старше N часов — скрыть").** Отвергнуто: угадывает симптом (возраст), а
   не причину (движок закрыл, мы не узнали); скрыло бы ЖИВУЮ pool-задачу,
   которая просто долго висит легитимно (SLA просрочен, но задача жива).
3. **(г) Миграция данных: UPDATE choros.employee SET display_name=... для
   пустых рядов.** Отвергнуто (см. §4) — риск неверной атрибуции.
4. **(д) Write-side идемпотентность на POST /api/role-assignments (409 при
   дубле).** Отвергнуто ИЗ РАМОК этой P2-задачи (тянет глубже — нужно
   решить семантику "то же самое" на write-пути: тот же org_scope? любой
   scope? затрагивает T-0044 дуал-контроль-флоу). Follow-up зафиксирован
   (§5). Текущий фикс — честный минимум: read-side дедуп для отображения +
   корректный отзыв дублей.
5. **(е) Глобальный monkey-patch `window.fetch`.** Отвергнуто: слишком
   широкий blast radius для P2-гигиены (влияет на ВСЕ fetch, включая
   сторонние/未предвиденные вызовы); opt-in обёртчик безопаснее и
   тестируемее, следует духу задачи «минимальный скоуп».

## 3. Контракты (изменённые файлы, поведение)

- `src/http/process-projection.ts::listInstanceInboxTasks` — добавлено
  `instancesWithNextTask` вычисление + третье условие прятать base-строку.
- `src/http/seed-write.ts::GET /api/org/tenant-state` — `display_name`
  добавлен в SELECT employee (аддитивно).
- `web/src/lib/format.js::formatPersonName` — новая чистая функция.
- `web/src/forms/field-renderer.jsx::fetchEmployees` — экспортирована (была
  module-private).
- `web/src/screens/screen-record-detail.jsx` — резолвит `created_by` через
  `fetchEmployees` + `formatPersonName`.
- `web/src/screens/rights/screen-rights.jsx` — `holderCount`, `dedupHolders`
  (экспортированы для юнит-тестов), `WhoCanDoWhat`/`RoleRailItem` используют
  дедуп.
- `web/src/screens/rights/ra-overview-forms.jsx` — `RevokeAssignmentButton`
  принимает `ids`; дропдаун использует `formatPersonName`.
- `web/src/app-shell/dev-auth.js::fetchWithAuthRetry` — новая функция.
- `web/src/screens/screen-inbox.jsx` — `ACTION_ERROR_MESSAGE` +
  `actionErrorMessage`; все fetch-вызовы на `fetchWithAuthRetry`.
- Тесты: `src/__tests__/inbox-engine-drive.test.ts` (+2 теста, а/б),
  `ci/checks/db/seed-pack.test.ts` (display_name assertion),
  `web/src/lib/format.test.js` (новый), `web/src/app-shell/fetch-with-auth-retry.test.js`
  (новый), `web/src/screens/screen-inbox.test.jsx` (+2 describe),
  `web/src/screens/rights/screen-rights.test.jsx` (+3 describe),
  `web/src/screens/screen-record-detail.test.jsx` (+1 describe).

## 4. Идентити-фикс: почему БЕЗ миграции данных

Разведка `src/core/register.ts:298-303` (генезис владельца тенанта)
показывает: `INSERT INTO choros.employee (..., display_name, ...) VALUES
(..., $4, ...)` c `[tenantId, employeeId, kcUserId, req.email, ts]` — т.е.
**генезис УЖЕ заполняет `display_name = req.email`** для КАЖДОГО нового
тенанта. Все остальные write-пути (`applications.ts`, `rights-intents.ts`
hire, `agent-provision.ts`) ТАКЖЕ валидируют `display_name` как
non-empty required перед INSERT. Наблюдаемая пустота на стенде — либо
легаси-ряд, созданный ДО текущей версии `register.ts`, либо ручная вставка
через `psql` в ходе разработки (правдоподобно — история сессий фиксирует
многократные прямые SQL-манипуляции на dev-стенде). Backfill-миграция
потребовала бы УГАДЫВАТЬ имя из slug/email/KC-профиля для рядов, чей
источник данных неизвестен — риск неверной атрибуции (записать чужой email
как имя, или наоборот) перевешивает косметическую выгоду для P2-гигиены.
**Решение: display-фолбэк только, без бэкфилла.** Если конкретный пустой
ряд на стенде блокирует демо/приёмку — точечное ручное исправление через
существующий UI (нет эндпоинта редактирования display_name у employee —
follow-up, вне рамок).

## 5. Follow-ups (зафиксированы, не в этой задаче)

- `fetchWithAuthRetry` для остальных 28+ экранов (общий рефакторинг
  fetch-обёрток по всему SPA) — системная дыра "мёртвый токен = мёртвый
  экран" шире одного экрана.
- Write-side идемпотентность `POST /api/role-assignments` (409/reuse при
  дубле employee+role) — устранило бы КОРЕНЬ дублей на записи, не только на
  чтении.
- UI/эндпоинт для редактирования `employee.display_name` постфактум (нет
  сейчас ни одного, кроме INSERT-time).
- Общий рефакторинг сырых/молчаливых ошибок по всем web-экранам (T-0605
  §O4 уже это отметил; T-0608 (в) сузило ещё на один путь — остаётся
  системным).

## 6. Fitness-функции и трассируемость

См. `docs/adr/T-0608.adr.contract.json` (FF-1..FF-9, traceability AC↔FF).

## 7. Миграция БД

**Не требуется.** Все шесть фиксов — DAO-логика (`process-projection.ts`,
`seed-write.ts` SELECT-расширение), UI-рендер, тестовый код. Ни одной новой
колонки/таблицы.

## 8. Эскалация

Нет. Шесть точечных фиксов read/render-слоя; ни одна пилюля не вводит новый
authority-путь, не расширяет права, не трогает секреты/деньги/необратимые
операции. Follow-ups (§5) зафиксированы честно, не спрятаны.
