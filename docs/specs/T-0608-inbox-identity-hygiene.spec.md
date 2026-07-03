# T-0608 — Спека: инбокс/identity гигиена (P2, шесть точечных фиксов)

**Status:** ready
**Phase:** SPEC
**Task:** T-0608 [P2]
**Date:** 2026-07-03
**База:** dev @ `6ae4299` (ветка `task/T-0608-inbox-identity-hygiene`)

---

## 1. Контекст (живые факты приёмки, тенант Аксон, стенд, 2026-07-03)

Шесть мелких находок гигиены, каждая — узкий фикс + тест, без рефакторинга:

**(а) Стейл-задачи.** Движок закрыл userTask («Проверка руководителем»,
`dafc9b66`, `end_time` 02.07 08:26), а в «Мои задачи» строка висела «в пуле»
сутки+. Инбокс-проекция не реконсилировалась с закрытым движковым тасков.

**(б) Дубли.** На один живой engine-task — ДВЕ строки инбокса (base
`process.started` строка + `process.next_task` строка), с ДВУМЯ разными
дедлайнами (live: «Заказ поставщику» `1aecce4e`, 11:09 и 11:19).

**(в) Сырые коды.** «Ошибка: NOT_ELIGIBLE» тостом на approve/complete (T-0605
уже зачистил claim-путь `CLAIM_ERROR_MESSAGE`, но не approve/complete-путь
`/api/inbox/:id/action`).

**(г) UUID вместо имён.** Employee-запись без имени рендерится как raw
UUID/slug: «АВТОР: 4c653940-…» на карточке записи; «4c653940-…» в дропдауне
«Назначить роль».

**(д) Счётчик держателей роли врёт.** Число справа от роли в списке
(«Конфигуратор 4» при 2 держателях, «Снабженец 0» при 3) — считало ГРАНТЫ
роли, не держателей; задвоение держателя («Семён Сидоров» ×2) на карточке
роли — два `role_assignment`-ряда на одного employee, оба показаны отдельно.

**(е) 401 mid-session.** Протухший access-token → «Не удалось загрузить: HTTP
401», «Повторить» ретраит тем же мёртвым токеном; лечит только F5.

## 2. Разведка — корень каждого пункта (file:line)

### 2.1. (а) Стейл-задачи

`listInstanceInboxTasks` (`src/http/process-projection.ts:906-978`) прячет
base-строку ТОЛЬКО когда `approvedTaskIds.has(row.id)` (наш `task.approved`
аудит-эвент) ИЛИ `endedInstanceIds.has(inst)` (наш `instance.ended`). Если
движок закрыл таск способом, который не прошёл через
`/api/inbox/:id/action` (историческая `dafc9b66` — ДО фикса T-0571, когда
`completeUserTask` был no-op), наш аудит-трейл никогда не узнаёт об этом
напрямую. Механизм самолечения — `reconcileInboxEngineDriveOnRead`
(`process-projection.ts:1712-1769`, T-0522), запускаемый на КАЖДОЕ
`GET /api/inbox` (`inbox.ts:1046-1058`): re-drive'ит ЛЮБОЙ waiting-инстанс
(не только «хоть раз approved»), проверяет `isInstanceEnded` — если true,
эмитит `instance.ended` НЕЗАВИСИМО от того, approve'ил ли это НАШ
эндпоинт когда-либо. Тест `src/__tests__/inbox-engine-drive.test.ts`
(«T-0608 а») доказывает: механизм уже самолечит "закрыт-в-движке,
наш-approve-эвент-никогда-не-писался" на СЛЕДУЮЩЕМ чтении. Остаточный
разрыв — тот же, что и (б): движок ПЕРЕШЁЛ на новый активный таск (не
ended), и base-строка НЕ прячется, потому что "есть live next_task для
этого инстанса" не было условием прятать base.

### 2.2. (б) Дубли

Тот же `listInstanceInboxTasks`: base-строка прячется по `task.approved`
СВОЕЙ строки ИЛИ `instance.ended`, но НИКОГДА — по факту "для этого
инстанса уже есть `process.next_task`-строка". `process.next_task` может
появиться ЧЕТЫРЬМЯ путями, ни один из которых трогает base-строку:
`reconcileInstanceTimers` (T-0458, эскалация по таймеру — целевая роль
эскалации ОТЛИЧАЕТСЯ от роли base-шага, `process-projection.ts:1109-1124`
исключает совпадение только когда роль СОВПАДАЕТ), `reconcileInstanceEngineDrive`
(T-0522/T-0571, post-approve/on-read fan-out), `deliverMessageEnvelope`
(T-0459), `surfaceMessageCatchWaits`. Все четыре site эмитят
`process.next_task` ТОЛЬКО после `engine.getActiveUserTasks` подтвердил
живой НОВЫЙ активный таск — т.е. факт существования `next_task`-строки для
инстанса УЖЕ доказывает, что базовый шаг больше не активен на движке,
независимо от того, писали ли МЫ `task.approved` для него.

### 2.3. (в) Сырые коды

`web/src/screens/screen-inbox.jsx`: T-0605 добавил `CLAIM_ERROR_MESSAGE` +
`claimErrorMessage(code)` ТОЛЬКО для claim-пути (`claimTask`). Approve/
complete-путь (`approveTask` — построчная кнопка «Согласовать»;
`TaskDetailPanel.handleComplete` — кнопка «Выполнить шаг» в дровере) читает
`ENGINE_DRIVE_ERROR_MESSAGE` (только 502-коды engine-drive) и падает в
сырой `` `Ошибка: ${code}` `` для ЛЮБОГО другого кода (`NOT_ELIGIBLE`,
`NOT_FOUND`, `VALIDATION`, `FORM_VALIDATION` — все реальные коды
`POST /api/inbox/:id/action`, `src/http/inbox.ts:1454-1783`).
`handleComplete` имел ОДНОРАЗОВЫЙ инлайн-тернар для `NOT_ELIGIBLE`;
`approveTask` не имел даже этого.

### 2.4. (г) UUID вместо имён

Два независимых разрыва, оба — отображение, НЕ запись (`register.ts:298-303`
УЖЕ заполняет `display_name=req.email` при генезисе владельца тенанта):

- `GET /api/org/tenant-state` (`src/http/seed-write.ts:974-977`) выбирал
  ТОЛЬКО `id, slug` — `display_name` вообще не читался. Дропдаун «Назначить
  роль» (`ra-overview-forms.jsx:213`) рендерил `e.slug`, который для
  KC-зарегистрированного человека РАВЕН UUID из Keycloak (`register.ts:302`:
  `employee.slug = kcUserId`).
- `screen-record-detail.jsx:679-686` рендерил `record.created_by` (актор-slug
  из `src/http/records.ts:74/447/454`) СЫРЫМ, никогда не резолвя в
  display_name.

### 2.5. (д) Счётчик держателей + дубли

`web/src/screens/rights/screen-rights.jsx` до фикса: `grantCount(role) =
role.grants.length` — рендерился в позиции, которую пользователь читает как
«число держателей» (`chs-rolerow__count`). Держатели (`role.assignments`,
из `src/http/rights-overview.ts:250-325`) и гранты (`role.grants`) —
НЕЗАВИСИМЫЕ массивы одной роли; ноль связи между их длинами. Отдельно:
`POST /api/role-assignments` (`src/http/grants.ts:1048-1156`) не имеет
write-side идемпотентности — два сабмита «Назначить роль» одному employee
на одну роль создают ДВА активных `role_assignment`-ряда, оба возвращаются
`rights-overview.ts` как честная ground truth (это НЕ баг read-стороны) —
но экран рендерил их как ДВА отдельных badge/holder-блока. КРИТИЧНО (F-1):
`migrations/020:29-32` (NO UNIQUE(employee_id, role_id)) — два назначения с
РАЗНЫМ `org_scope`/окном НЕ дубли, а легитимно разные гранты; дедуп обязан
их РАЗЛИЧАТЬ (композитный ключ), а не схлопывать по `employee_id`.

### 2.6. (е) 401 mid-session

`web/src/app-shell/shell.jsx:744-806` — одноразовый bootstrap-эффект: silent
refresh (`kc.tryRefresh`) запускается ТОЛЬКО если токен уже истёк НА МОМЕНТ
загрузки приложения. Токен, истёкший ПОКА приложение открыто, не имеет
никакого обработчика — каждый экран (напр. `screen-inbox.jsx`) делал сырой
`fetch(url, {headers: authHeaders()})`; 401 рендерился как `ErrorState`
"HTTP 401", и «Повторить» вызывал ТОТ ЖЕ `load()`/`loadDetail()` с ТЕМ ЖЕ
мёртвым токеном.

## 3. Решения (по одной фразе на пункт)

- **(а)** Не отдельный фикс — механизм (`reconcileInboxEngineDriveOnRead`)
  уже самолечит "закрыт-в-движке" случай (регресс-тест добавлен, доказывает
  корректность); остаточный разрыв ЗАКРЫТ фиксом (б).
- **(б)** `listInstanceInboxTasks` прячет base-строку ТАКЖЕ когда для её
  инстанса существует ХОТЬ ОДНА `process.next_task`-строка (approved или
  нет) — существование доказывает, что движок уже продвинулся мимо
  base-шага.
- **(в)** Тот же принцип T-0605: `ACTION_ERROR_MESSAGE` map + общий
  `actionErrorMessage(code)`, используемый И `approveTask`, И
  `handleComplete` — ни один код approve/complete-пути не долетает до
  пользователя сырым.
- **(г)** Display-фолбэк (`formatPersonName` в `web/src/lib/format.js`) +
  `GET /api/org/tenant-state` теперь селектит `display_name` (аддитивно) +
  `screen-record-detail.jsx` резолвит `created_by` через `GET /api/org`
  (уже используемый `PersonPicker`-паттерн, `fetchEmployees` экспортирован).
  Бэкфилл существующих пустых имён МИГРАЦИЕЙ ДАННЫХ НЕ делается (см. ADR §4 —
  генезис уже честно заполняет имя; наблюдаемая пустота — легаси/ручной сид,
  не воспроизводимый текущим кодом).
- **(д)** Счётчик переименован в `holderCount` = число РАЗЛИЧНЫХ ЛЮДЕЙ
  (distinct `employee_id`, не `grants.length`) — честный ответ на «сколько
  человек держит роль» (человек с двумя охватами = один человек). Секция
  держателей и Revoke — по КОМПОЗИТНОМУ ключу (`dedupAssignments`:
  `employee_id` + `org_scope` + окно валидности): `migrations/020:29-32`
  документирует, что назначения одной (employee, role) пары с разным
  охватом/окном ЛЕГИТИМНО различны (не дубли). Схлопываются ТОЛЬКО истинные
  дубли (идентичный охват+окно); различные охваты — ОТДЕЛЬНЫЕ строки со
  scope-лейблом (`ScopeSummary`) и раздельным `Отозвать` (`row.ids` = только
  этого охвата). `RevokeAssignmentButton` получает `scopeLabel` —
  ConfirmDialog называет охват и сообщает «другие охваты сохранятся»;
  revoke-А не трогает-Б. `GET /api/rights/tenant-state` аддитивно surface
  `valid_from`/`valid_until` (полный композитный ключ на клиенте). [F-1 fix
  review+ux: первая версия дедупила по `employee_id` одному → отзыв лишнего
  гранта, blocking.]
- **(е)** `fetchWithAuthRetry` (`dev-auth.js`) — общий fetch-обёртчик:
  401 → (keycloak mode) один silent refresh → один ретрай → на неудаче
  редирект на логин; dev mode — passthrough (нет концепции истечения
  токена). `screen-inbox.jsx` — единственный опт-ин потребитель в рамках
  этой задачи (живой факт наблюдался именно там); остальные экраны — вне
  рамок (follow-up, см. ADR).

## 4. Границы (D-064, закон границы)

Никаких кейс-литералов (`procurement`/`снабженец`/`Конфигуратор`/конкретный
слаг роли) в `src/`/`web/src/`. Слаги/роли/имена приходят из данных.
`bash ci/checks/anti-case-lock.sh` зелёный.

## 5. Acceptance criteria

См. `docs/specs/T-0608.spec.contract.json` (AC-1..AC-16).

## 6. Вне рамок

- Полный рефакторинг молчаливых/сырых ошибок по ВСЕМ web-экранам (только
  approve/complete/claim инбокса в рамках).
- `fetchWithAuthRetry` для ВСЕХ экранов, использующих fetch (только
  `screen-inbox.jsx` в рамках; follow-up зафиксирован в ADR).
- Миграция данных для бэкфилла пустых `display_name` существующих
  employee-рядов (решение: НЕ делать без уверенности в источнике пустоты —
  см. ADR §4).
- Переработка модели дуал-контроля/critical-grant (T-0605 уже это закрыл;
  не трогается).
