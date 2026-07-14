# ADR · T-0572 — Экран «Доступ» пишет: живой READ tenant-состояния + выдача/отзыв из UI

- **Task:** T-0572 (Wave W1 / права-UI)
- **Phase:** DESIGN (architect)
- **Status:** ready
- **Date:** 2026-07-02
- **Spec:** `docs/specs/T-0572-rights-ui-writes.spec.md` (AC-1..AC-16, ready, no blocking questions)
- **Ratified founder decision (не переспрашивается):** PD-17 F1–F3 — редактор грантов только
  владелец/админ; обычный пользователь read-only «мои права человеческим языком»; критичное
  изменение всегда dual-control, не отключаемо.
- **Reads-through (do NOT contradict):**
  - `docs/specs/T-0570-read-pdp.spec.md` + `docs/adr/ADR-T0570-read-pdp.md` (D3 READ-PDP, уже в базе
    dev@7aac512 — §5 out-of-scope откладывает «UI/экран управления грантами» на ЭТУ задачу).
  - `docs/specs/T-0044-dual-control.spec.md` + живой `src/core/dual-control.ts`,
    `src/core/role-criticality.ts` (frozen, NF-5 T-0044) + `src/http/grants.ts` two-phase confirm.
  - `docs/specs/T-0022-roles-assignments.spec.md` (`role`/`role_assignment` table shape).
  - T-0390 `src/http/rights-change-requests.ts` — готовая dual-control «инбокс»-механика.
  - карта примитивов `/Users/shoxy/Code/demiurge/docs/choros-primitives-map-2026-07-02.md` §D (D4/D5),
    §4 п.4 (замкнутый круг `authoring_draft`), §7 п.1.

---

## 1. Контекст и проблема (доказано живьём 2026-07-01/02, карта примитивов D4/D5)

Экран «Доступ» (`/rights`, вкладка «Обзор ролей») **лжёт**. `GET /api/rights` (`src/http/rights.ts`,
`findRightsData()`) НЕ читает tenant-состояние: он отдаёт либо `RIGHTS_SEED` (12 захардкоженных ролей,
no-DB fallback), либо, при `DATABASE_URL`, `tryLoadShowcasePack().rights_cards` (статичный demo-pack
файл). **Ни один путь не делает `SELECT … FROM choros.role / role_assignment / "grant"` для тенанта
вызывающего.** На живом тенанте владелец видит либо «Нет ролей», либо демо-пакет — то и другое неправда.
Модуль помечен zero-`pg`-import (FF-DISPLAY-4) — этот инвариант чужого модуля мы НЕ снимаем (§2.1).

При этом бэкенд **богат и жив** (разведка §3):

- `POST /api/grants`, `POST /api/grants/:id/revoke`, `POST /api/role-assignments`,
  `POST /api/role-assignments/:id/revoke` (`src/http/grants.ts`) — структурная запись, gated
  `validateAdminDelegation`, атомарная транзакция INSERT+audit, T-0044 dual-control встроен.
- Two-phase confirm: тот же `POST /api/grants` / `POST /api/role-assignments` с телом
  `{phase:"confirm2", change_ref}` — approver-identity ТОЛЬКО из аутентифицированного actor (R-AUTH),
  distinctness enforced на трёх принципалах (proposed_by/confirmed_by/confirmed2_by).
- `GET /api/rights/change-requests` + `POST .../:id/approve|reject` (`src/http/rights-change-requests.ts`,
  T-0390) — готовый UI-friendly слой над dual-control (список semi-confirmed grant+assignment строк),
  уже потребляется вкладкой `/rights/criticality` (`ra-criticality.jsx`) честно (Loading/Error/Empty/list).
- `GET /api/rights/dictionaries` (`src/http/grants.ts`) — словари ресурсов/операций/org-дерева/scope-тегов
  + 14 пресетов, уже потребляется `ra-role-editor.jsx`/`ra-intents.jsx`.
- `parseScopeElement` (`src/http/grants.ts`) — единственный scope-парсер (`node`/`tags`/`interval`/`set`).

**Корень лжи D4 (единственный настоящий пробел):** нет НИ ОДНОГО GET-эндпоинта, читающего
`choros.role` + `choros.role_assignment` + `choros."grant"` ВМЕСТЕ для «честного обзора ролей тенанта».
`loadSubjectGrants` (`src/http/pdp-explain.ts:99`) содержит готовую JOIN-форму `role_assignment JOIN grant`
для ОДНОГО субъекта, но захардкожен на `DEV_TENANT_ID` — переиспользуем ФОРМУ SQL, не код и не хардкод.

**Замкнутый круг (карта §4 п.4):** `authoring_draft`-грант ассистенту/владельцу выдать неоткуда — UI нет.
Эта задача размыкает круг ручкой выдачи/отзыва из продукта (LIVE_PROOF §7). T-0573 (параллельно) даёт
backfill старым тенантам — не эта задача.

### 1.1 Ключевые находки, определяющие форму решения

1. **Write-путь ЗАМОРОЖЕН (NF-1 спеки).** Весь механизм записи + dual-control УЖЕ построен и жив. Новый
   код этой задачи = **READ-эндпоинт(ы) + UI-провод к существующим POST**. Ни строки нового write-пути,
   ни правки dual-control. Это не «спроектировать выдачу грантов» — это «показать правду и дать кнопки к
   уже существующим ручкам».
2. **UI-каркас `screen-rights.jsx` правильный.** Error→Loading→Empty→content уже реализованы полностью,
   включая retry. Дефект целиком в ИСТОЧНИКЕ (сервер отдаёт demo), не в компоненте. Достаточно сменить
   URL эндпоинта + расширить shape (роли с их назначениями и грантами из живых таблиц).
3. **`ra-role-editor.jsx` пишет грант в реальный API целиком** (разведка §3.4): читает роли из
   `GET /api/org/tenant-state`, `propose()`→живой `POST /api/grants/propose`, прямой `POST /api/grants`,
   `confirm2`-путь, честный Loading/Error/Empty, semi-confirmed-баннер. **НО** его грант-«черновик» на
   старте засеян `INITIAL_GRANTS` (3 статичных атома, `ra-role-editor.jsx:29-33`) — это редактируемый
   ДРАФТ формы, НЕ проекция существующих грантов роли из БД. Экран пишет живьём, но существующие гранты
   роли из БД не ПОКАЗЫВАЕТ. Это и есть нюанс вердикта бейджа (§2.6 / FR-8 / AC-12).
4. **`ra-intents.jsx`** пишет через ОТДЕЛЬНЫЕ `/api/rights/intents/*` (hire/fire/substitute) — это
   пресет-слой D-2, НЕ сырой grant/assignment. Он ортогонален и НЕ трогается.
5. **Нав-структура полная.** `shell.jsx` даёт ACCESS-жанр (`overview`=`/rights`, `trail`=`/rights/trail`)
   и REFERENCE-жанр (`criticality`/`sod`/`editor`/`intents`). Задача НЕ добавляет верхнеуровневых вкладок —
   чинит содержимое `overview` и встраивает «кто что может» + формы В НЕГО (§2.4).

---

## 2. Решение

Пять сцепленных элементов. Ни один не вводит второй write-путь и не трогает dual-control (NF-1/NF-2).
READ начинает читать ЖИВЫЕ таблицы; UI проводит к УЖЕ СУЩЕСТВУЮЩИМ POST; semi-confirmed виден честно.

### 2.1 Новый READ-эндпоинт `GET /api/rights/tenant-state` (FR-1, FR-6) — новый файл `src/http/rights-overview.ts`

**Почему новый файл, а не `rights.ts`:** `rights.ts` несёт заявленный zero-`pg` инвариант (FF-DISPLAY-4).
FR-1 требует живого DB-чтения `choros.role/role_assignment/"grant"` — это ПРОТИВОРЕЧИТ инварианту
чужого модуля. Соразмерно (NF-5) — новый файл `src/http/rights-overview.ts` по образцу
`rights-change-requests.ts` (own `withTenantTx`, own actor-extraction через shared-примитивы), НЕ снятие
чужого инварианта. `rights.ts` остаётся как есть (демо-fallback для no-DB/showcase-режима не удаляется —
это отдельная display-плоскость; переключение потребителя делает клиент, §2.3).

**Контракт эндпоинта.** `GET /api/rights/tenant-state` — `withAuth`, tenant РЕЗОЛВИТСЯ ИЗ AUTH-контекста
(`extractActorFromReq` → `resolveActorTenant`), **НЕ из query-параметра** (урок tenant-hardcode: даже
`tenant-state` из `seed-write.ts` берёт `tenant_id` из query и лишь СВЕРЯЕТ — мы не повторяем этот шов,
берём tenant только из идентичности). Ответ:

```jsonc
// GET /api/rights/tenant-state  (admin/owner projection)
{
  "scope": "tenant",                 // маркер проекции: весь тенант (admin) | "self" (обычный юзер)
  "can_manage": true,                // держит ли вызывающий mgmt_object:role/grant (форма записи видна)
  "roles": [
    {
      "id": "uuid", "slug": "role-fin-control", "name": "Контролёр расчётов",
      "assignments": [               // ТОЛЬКО confirmed & in-window (действующие)
        { "id": "uuid", "employee_id": "uuid", "employee_slug": "a-kravtsova",
          "employee_display": "А. Кравцова", "employee_kind": "human",   // human|agent|service
          "org_scope": { /* ScopeElement */ }, "state": "active" }
      ],
      "grants": [                    // ТОЛЬКО confirmed (действующие)
        { "id": "uuid", "resource_type": "record", "operation": "read",
          "resource_facet": null, "scope": { /* ScopeElement */ }, "state": "active" }
      ],
      "pending": {                   // FR-5: semi-confirmed ПОВЕРХ, ОТДЕЛЬНО от действующих
        "assignments": [ { "id": "uuid", "employee_display": "…", "confirmed_by": "…" } ],
        "grants":      [ { "id": "uuid", "description": "record:read", "confirmed_by": "…" } ]
      }
    }
  ]
}
```

**Инвариант действующего vs ожидающего (FR-5, AC-8).** `roles[].assignments` и `roles[].grants` содержат
ТОЛЬКО строки с `confirmed_by IS NOT NULL AND confirmed2_by IS NULL`-**НЕТ**, т.е. фильтр
`confirmed_by IS NOT NULL AND (для assignment) in-window` + **исключение semi-confirmed из действующих**.
Semi-confirmed (`confirmed_by IS NOT NULL AND confirmed2_by IS NULL`) идут ТОЛЬКО в `roles[].pending.*`.
Это тот же водораздел, что `rights-change-requests.ts:listChangeRequests` использует для инбокса — но
здесь спроецирован на роль. Read-path сегодня НЕ фильтрует гранты по `confirmed2_by` (известная
LIMITATION из T-0390), поэтому «действующее» для гранта в ЭТОЙ проекции определяется ЯВНЫМ SQL-условием
`confirmed2_by IS NOT NULL OR <не-критичный, routine confirmed>`. Точный предикат: строка «действующая»,
если `confirmed_by IS NOT NULL AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL)` — routine-путь
пишет `proposed_by=NULL, confirmed_by=actor, confirmed2_by=NULL` и АКТИВЕН; критичный пишет
`proposed_by=actor, confirmed_by=actor, confirmed2_by=NULL` и НЕ активен до второго. Этот предикат —
единственный «действующий»-фильтр, зеркалящий семантику записи `grants.ts` (§3.3), а не изобретающий свою.

**N+1-дисциплина (NF-1-эхо, AC-1).** Одна транзакция, три запроса: `SELECT roles`, `SELECT assignments
JOIN employee (все роли тенанта разом)`, `SELECT grants (все роли тенанта разом)`; агрегация ролей
in-memory по `role_id`. O(1) запросов на HTTP-вызов независимо от числа ролей — НЕ запрос-на-роль.
JOIN-форма переиспользует паттерн `loadSubjectGrants`/`listChangeRequests` (role LEFT JOIN
role_assignment LEFT JOIN grant + employee для display), БЕЗ `DEV_TENANT_ID`-хардкода.

### 2.2 PDP-гейт на самом эндпоинте: две проекции (FR-6, FR-7, AC-9, AC-10)

Эндпоинт ветвится по авторитету ВЫЗЫВАЮЩЕГО, определяемому тем же серверным сигналом, что уже питает
`GET /api/me/nav-capabilities` (`src/http/org.ts`): `admin.isGenesisOwner || adminCtx.adminGrants.length>0`
(держит любой `mgmt_object:*` грант). Единый резолвер — `loadAdminContext` (§3), НЕ клиентский флаг.

- **Админ/владелец** (`can_manage:true`): проекция `scope:"tenant"` — все роли тенанта с назначениями,
  грантами, pending (§2.1).
- **Обычный пользователь** (`can_manage:false`): проекция `scope:"self"` — сервер фильтрует по
  `employee_id = self` (роли, которыми обладает вызывающий, и что эти роли дают), НЕ по всему тенанту.
  `employee_id` вызывающего резолвится ИЗ AUTH (`resolveActorSlugFromAuth`→employee), **никогда из
  клиентского параметра** (AC-10: подмена `employee_id` в запросе не даёт чужие права — параметра нет).
  `pending` в self-проекции пуст/скрыт (обычный юзер не участвует в грант-механике). `can_manage:false`
  ⇒ клиент НЕ рендерит формы записи (§2.5).

Fail-closed: любая ошибка резолюции авторитета ⇒ трактуется как обычный пользователь (self-проекция),
НЕ как admin — та же дисциплина, что fail-closed в `nav-capabilities` (`zones:['work'], degraded:true`).

### 2.3 UI: `screen-rights.jsx` переключается на живой источник (FR-1, AC-3)

`screen-rights.jsx` меняет `fetch('/api/rights')` → `fetch('/api/rights/tenant-state')` и адаптирует
shape (роль теперь несёт `assignments`/`grants`/`pending` из живых таблиц вместо demo-`holders`/`grants`).
Error/Loading/Empty УЖЕ есть — переиспользуются как есть (kit `ErrorState`/`LoadingState`/`EmptyState`).
Пустой тенант ⇒ честный `EmptyState` (first-use вариант: «В этом тенанте ещё не определено ни одной роли
доступа», без demo-флага, отличимо от «источник недоступен» ⇒ `ErrorState`+retry — разные состояния,
UX-паттерн Empty-States severity-ladder). Захардкоженный `ROLE_GROUPS` (dept-группировка по demo-id,
`screen-rights.jsx:12`) заменяется группировкой по живым данным (или плоским списком) — demo-id больше
не существуют, оставить их = мёртвый аффорданс (G7). AC-3 проверяется грепом: компонент не фетчит
`/api/rights`.

### 2.4 «Кто что может»: секция во вкладке `overview`, не седьмая вкладка (FR-6, AC-8)

Спека (§2 находки, FR-6) прямо делегирует DESIGN: новая вкладка ИЛИ секция существующей `overview`.
**Решение — секция внутри `overview`,** НЕ новая верхнеуровневая вкладка. Обоснование: `overview`
уже показывает «роль-деталь» с секцией «Производное от грантов» (`screen-rights.jsx:184`) — естественное
место для «что эта роль даёт». UX-паттерн Tabs прямо предупреждает: >7-8 вкладок не сканируются;
нав уже несёт 6 (overview/trail/criticality/sod/editor/intents). Седьмая без нужды = дрейф.

- **Админ-взгляд** («кто что может»): в роль-детали — список действующих `grants` (человеко-читаемо,
  как секция «Производное») + список действующих `assignments` (кто держит роль: human/agent/service
  бейджем). Плюс переключатель проекции «по роли ↔ по сотруднику» (агрегация тех же данных FR-1 по
  `employee_id`) — опционально день-1 (по роли достаточно для AC; по сотруднику — расширение той же
  проекции, не новый эндпоинт). **Semi-confirmed сюда НЕ попадает как действующее** (FR-5, §2.7).
- **Юзер-взгляд** («мои права»): self-проекция (§2.2) — роли вызывающего + что дают, человеческим языком.
  Read-only. Нет форм записи, нет чужих ролей.

### 2.5 Формы выдачи/отзыва — провод к существующим POST, гейт видимости (FR-2, FR-3, FR-4, FR-7)

Формы рендерятся ТОЛЬКО при `can_manage:true` (§2.2). При `can_manage:false` формы НЕ монтируются вовсе
(не disabled-кнопка — компонент формы отсутствует в DOM; AC-9: DOM не содержит элементов формы выдачи).
Это деградация ВИДИМОСТИ, не пост-фактум перехват 403.

- **Выдать роль сотруднику (FR-2):** форма (employee + role + org_scope) → один
  `POST /api/role-assignments` (kit `Select`/`Field`; employee/role по имени из
  `GET /api/rights/tenant-state` или `GET /api/org/tenant-state`, submit по UUID — паттерн
  `ra-intents.jsx` «выбор по имени, submit по UUID»). Отзыв — кнопка на действующем назначении →
  `POST /api/role-assignments/:id/revoke`.
- **Выдать грант роли (FR-3):** форма (resource_type + operation + scope [+ constraint]) на базе
  `GET /api/rights/dictionaries` → один `POST /api/grants`. Отзыв → `POST /api/grants/:id/revoke`.
  Advanced-сырой-грант — только `can_manage` (PD-17 F1). Задача НЕ переписывает `ra-role-editor.jsx`
  с нуля — он уже F1; ЭТА задача добавляет проекцию существующих грантов роли (§2.6) и, если нужно,
  переиспользует его форму как «продвинутый» вход. Минимум: `overview` получает лёгкую форму
  выдачи/отзыва роли и гранта (не дубль сложного редактора).
- **Сужение scope (FR-4):** форма формирует тело запроса как `ScopeElement`-JSON, принимаемый
  существующим `parseScopeElement` (AC-14 — клиент НЕ вводит параллельный scope-формат). День-1
  выставленный поднабор палитры: `node` (org-дерево из `dictionaries.orgTree`) + `tags`
  (`dictionaries.scopeTags`) + `set` — достаточно, чтобы сужение было ДОСТИЖИМО через существующий
  парсер. `interval` и record-level «менеджер видит своих клиентов» (К1) — `out_of_scope` (FR-4
  явно), ссылка на будущую задачу палитры scope; НЕ вводится новый код-путь.

Никакого прямого DAO-вызова из HTTP в обход write-API (NF-1, FR-5, AC-4/AC-5/AC-6): формы бьют строго
в `/api/grants(/:id/revoke)` и `/api/role-assignments(/:id/revoke)`.

### 2.6 Честный semi-confirmed рендеринг (FR-5, NF-2, AC-7) — образец `ra-criticality.jsx`

Ответ `POST` бывает `{id, state:"confirmed"}` (201) или `{id, state:"semi-confirmed",
second_approver_required:true, reason}` (201). UI обязан:

- `confirmed` ⇒ действие активно; строка появляется в действующих `assignments`/`grants` после refetch.
- `semi-confirmed` ⇒ строка показана как «ждёт второго подтверждения» (kit `StatusChip`/`Badge`
  waiting-состоянием), **в ОТДЕЛЬНОМ визуальном контейнере** от confirmed (AC-7: полу-подтверждённая
  не попадает в тот же контейнер без маркера ожидания), с явной ссылкой/переходом на существующий инбокс
  `/rights/criticality` (потребляет `GET /api/rights/change-requests`) для второго подтверждающего. UI
  **НЕ дублирует** approve/reject-логику — только ведёт в готовый инбокс (NF-1). Клиент НЕ шлёт тело,
  минующее `dualControlDecision`-гейт (NF-2 — сервер и так гарантирует, но клиент не притворяется, что
  гейта нет: нет UI-флага «отключить dual-control»).

В «Обзоре ролей» и «кто что может» semi-confirmed виден ТОЛЬКО в `pending`-секции роли (визуально
отделённой, waiting-маркер), НИКОГДА в действующих правах (FR-5, AC-8).

### 2.7 Вердикт бейджа `/rights/editor` (FR-8, AC-12): остаётся `"demo"` с КОНКРЕТНОЙ причиной

Разведка DESIGN (§1.1 п.3, §3.4) установила: `ra-role-editor.jsx` **пишет грант в реальный API целиком**
(живой `POST /api/grants`/`propose`/`confirm2`, роли из `tenant-state`). НО его грант-**черновик** засеян
`INITIAL_GRANTS` (3 статичных мок-атома, `ra-role-editor.jsx:29-33`, `setGrants(INITIAL_GRANTS)`), и экран
НЕ проецирует существующие гранты выбранной роли из БД — редактируемая решётка стартует с фикстуры, не с
живого состояния роли. Это ОСТАТОЧНЫЙ мок-путь по букве FR-8: «что-то, используемое НЕ только как
placeholder до первого fetch». Плюс `ra-data.jsx` `TRAIL` (мок-аудит) импортируется соседними экранами.

**Вердикт: бейдж остаётся `"demo"`,** но его тултип в `shell.jsx` (`REFERENCE_TABS`, id=`editor`) меняется
с общего «данные иллюстративные (mock)» на КОНКРЕТНОЕ: «Черновик грантов засеян примером; существующие
гранты роли из БД пока не подгружаются (T-0572-FU: live-подгрузка грантов роли в редактор)». G7 (бейдж≡
контент) удовлетворён: бейдж честно указывает ЧТО именно мок, а не молчит и не врёт «live». Снятие в
`"live"` требует, чтобы редактор подгружал существующие гранты роли (устранение `INITIAL_GRANTS` как
стартового состояния) — это отдельный follow-up, не в периметре T-0572 (который чинит `overview`, не
переписывает `editor`). FR-8/AC-12 требует лишь ЯВНОГО решения DESIGN — оно здесь, с конкретикой.

### 2.8 Инварианты сохранены

- **NF-1 write-путь заморожен:** новый код = 1 READ-эндпоинт + UI-провод. Ни одного нового
  `router.register("POST"` для grant/assignment (AC-4/5/6). `grants.ts`, `dual-control.ts`,
  `role-criticality.ts`, `grant-resolver.ts`, `grant-lattice.ts` — не редактируются (FF-T0572-FROZEN).
- **NF-2 dual-control не отключаем:** нет UI-пути в обход `dualControlDecision`; semi-confirmed виден
  честно (§2.6).
- **NF-3 fail-closed видимость:** нет прав/данных ⇒ read-only/Empty/Error, не угаданное состояние.
- **NF-4 анти-кейс (D-064):** ни одной кейс-строки в ДОБАВЛЕННЫХ строках `src/` и `web/src/`
  (FF-T0572-ANTICASE, §5). Демо-константы `Согласование` в `rights.ts:RIGHTS_SEED`/`ra-data.jsx` —
  ПРЕДСУЩЕСТВУЮЩИЕ, не трогаются (гейт diff-scoped на добавленные строки).
- **NF-5 пропорциональность:** новый серверный код переиспользует
  `resolveActorTenant`/`resolveActorSlugFromAuth`/`loadAdminContext`/`withAuth`
  (те же, что `grants.ts`/`rights-change-requests.ts`) — не переизобретает actor/tenant resolution.

---

## 3. Проверенное состояние кода (разведка 2026-07-02, worktree T-0572 @ dev 7aac512)

- **`src/http/rights.ts`** — `GET /api/rights`: `findRightsData()` → `RIGHTS_SEED`(no-DB) |
  `tryLoadShowcasePack().rights_cards`(DB-режим, demo-pack). Zero-`pg` (FF-DISPLAY-4). НЕ трогается.
- **`web/src/screens/rights/screen-rights.jsx`** (218 строк) — читает `GET /api/rights`; Error/Loading/
  Empty+retry реализованы; `ROLE_GROUPS`/demo-id захардкожены; секция «Производное от грантов» вычисляет
  tools/fields из `role.grants`. Каркас правильный — меняется источник + shape (§2.3).
- **`src/http/grants.ts`** (1580 строк) — живой write-API: `POST /api/grants` (gated
  `validateAdminDelegation`; T-0044 `dualControlDecision`: routine→`{state:"confirmed"}` 201,
  критичное→`{state:"semi-confirmed", second_approver_required:true, reason}` 201, строка
  `confirmed2_by IS NULL` НЕ активна); `POST /api/grants/:id/revoke`→`{id}`; `POST /api/role-assignments`
  (тот же гейт+dual-control); `POST /api/role-assignments/:id/revoke`→`{id}` (owner-role защищена
  `isOwnerRole`); `{phase:"confirm2", change_ref}` — approver из auth (R-AUTH). `parseScopeElement`
  (единый парсер). `registerDictionariesRoute` `GET /api/rights/dictionaries`. НЕ трогается.
- **`src/http/rights-change-requests.ts`** (633 строки, T-0390) — `GET /api/rights/change-requests`
  (semi-confirmed grant+assignment), `POST .../:id/approve|reject`, DC-1/2/3 инварианты. Потребляется
  `ra-criticality.jsx`. НЕ трогается — T-0572 ВЕДЁТ в этот инбокс, не дублирует.
- **`web/src/screens/rights/ra-role-editor.jsx`** (789 строк) — F1 продвинутый редактор: роли из
  `GET /api/org/tenant-state`, `POST /api/grants`/`propose`/`confirm2`, Loading/Error/Empty,
  semi-confirmed-баннер. `INITIAL_GRANTS` (:29-33) засевает ДРАФТ (не проекция БД) — остаточный мок
  (§2.7). `EDITOR_ROLE_ID = selectedRoleId` (:297, живой UUID). Пишет ГРАНТЫ (не assignments).
- **`web/src/screens/rights/ra-intents.jsx`** (472 строки, T-0223/D-2) — пресеты hire/fire/substitute
  через ОТДЕЛЬНЫЕ `/api/rights/intents/*`; читает `GET /api/org/tenant-state`. Ортогонален, НЕ трогается.
- **`web/src/screens/rights/ra-criticality.jsx`** (280 строк, T-0390) — `GET /api/rights/change-requests`
  + approve/reject, полный Loading/Error/Empty. **Образец честного dual-control UI** для FR-4/FR-5.
- **`web/src/screens/rights/ra-data.jsx`** (380 строк) — shared reference-константы + UI-примитивы
  (`ScopeToken`/`ProvenanceTag`/`SectionHead`/`Segmented`/`CriticalityBadge`). Мок-`TRAIL` (аудит).
  Переиспользуемые примитивы; `PRESETS` синхронны с backend `DICT_PRESETS`.
- **`web/src/components/components.jsx`** (932 строки) — kit: `EmptyState`/`LoadingState`/`ErrorState`/
  `Skeleton`/`Button`/`Field`/`Select`/`Badge`/`StatusChip`/`OpChip`/`ExecutorBadge`/`Tooltip`/`Modal`/
  `ConfirmDialog` (с dual-control reason-полем)/`DataTable`+суб-компоненты/`Toast`+`useToasts`.
- **`src/http/seed-write.ts:946`** — `GET /api/org/tenant-state?tenant_id=X`: `{id,slug}` строки
  dept/position/employee/role; gated `isGenesisOwner || hasOrgObjectAuthority`; берёт `tenant_id` из
  QUERY (сверяет с `authTenantId`). Справочник имён — НЕ содержит grants/assignments/holders (недостаточен
  как единственный источник «Обзора»). Наш эндпоинт tenant из AUTH, не query (урок tenant-hardcode).
- **`src/http/pdp-explain.ts:99` `loadSubjectGrants`** — готовая JOIN-форма `role_assignment JOIN grant`
  для одного субъекта; `DEV_TENANT_ID`-хардкод. Переиспользуем ФОРМУ, не код/хардкод.
- **`src/http/org.ts:301` `GET /api/me/nav-capabilities`** — `zones` включает `'admin'` при
  `isGenesisOwner || adminGrants.length>0`. Тот же сигнал питает `can_manage`/проекцию (§2.2).
- **`src/db/org.ts`** — `resolveActorTenant`/`resolveActorSlugFromAuth`/`isGenesisOwnerForTenant`/
  `loadAdminContext` — переиспользуемые примитивы (NF-5).
- **`web/src/app-shell/shell.jsx:72`** — `REFERENCE_TABS` `{id:"editor", …, status:"demo"}` + Tooltip
  «Демо — данные иллюстративные (mock)». Бейдж/тултип — единственная правка нав (§2.7).
- **`src/__tests__/nav-status.test.ts`** — тестирует ВЕРХНЕуровневый `rights`=`live` (mirror nav-config.js);
  НЕ покрывает суб-таб `editor`-бейдж. FR-8-вердикт нуждается в СВОЕЙ проверке (FF-T0572-BADGE).
- **Анти-кейс CI-гейт** `ci/checks/read-pdp-anti-case.sh` (D-064) — git-diff-scoped на ДОБАВЛЕННЫЕ строки
  под `src/` (греп `role-approver`/`soglasovanie`/`tel-`/`Согласование`/`e-larina`/`e-orlov`/
  `e-configurator`). **Ограничение:** scope только `src/`. Наш новый UI-код в `web/src/` — FF-T0572-ANTICASE
  расширяет проверку на `web/src/` (§5).

---

## 4. Отвергнутые альтернативы

1. **Живой READ в `rights.ts` (снять zero-pg инвариант FF-DISPLAY-4).** Отвергнуто: правка заявленного
   инварианта чужого модуля ради одного эндпоинта; `rights.ts` служит no-DB/showcase display-плоскости.
   Новый файл `rights-overview.ts` соразмернее (NF-5), не рвёт FF-DISPLAY-4.
2. **Расширить `GET /api/org/tenant-state` грантами/назначениями.** Отвергнуто: он берёт `tenant_id` из
   QUERY (урок tenant-hardcode — не хотим множить этот шов), gated только admin (нет self-проекции для
   обычного юзера, FR-6), и это importer/reset-diff инструмент — смешивать «обзор прав» с ним размывает
   назначение. Новый read с tenant-из-auth и двумя проекциями чище.
3. **Новый write-эндпоинт «выдать роль/грант» (например `POST /api/rights/overview/grant`).** Отвергнуто
   ДОСЛОВНО (NF-1, AC-4/5/6): write-путь + dual-control уже построен; второй вход = обход гейта или дубль.
   UI бьёт строго в существующие `/api/grants`/`/api/role-assignments`.
4. **Дублировать approve/reject в новых местах экрана.** Отвергнуто: `rights-change-requests.ts` +
   `ra-criticality.jsx` — готовый инбокс; T-0572 ВЕДЁТ туда ссылкой (NF-1), не копирует DC-1/2/3.
5. **Седьмая верхнеуровневая вкладка «Кто что может».** Отвергнуто: UX-паттерн Tabs (>7-8 не сканируются);
   `overview` роль-деталь — естественное место (уже есть «Производное от грантов»). Секция, не вкладка.
6. **Показывать semi-confirmed как активное право «оптимистично».** Отвергнуто ДОСЛОВНО (FR-5, PD-17 F2,
   AC-7/8): до `confirmed2_by` право НЕ действующее. Оптимистичный рендер = ложь о состоянии прав =
   ровно тот класс лжи (D4), который задача чинит.
7. **Снять бейдж `/rights/editor` в `"live"`.** Отвергнуто: `INITIAL_GRANTS` засевает драфт (не проекция
   БД) — остаточный мок; `"live"` нарушил бы G7 (бейдж≡контент). Оставлен `"demo"` с конкретикой (§2.7).
8. **Клиент фильтрует «мои права» по клиентскому `employee_id`.** Отвергнуто (AC-10, FR-6): сервер решает
   по идентичности вызывающего (`resolveActorSlugFromAuth`), не по клиентскому параметру — иначе подмена
   `employee_id` даёт чужие права. Проекция выбирается сервером по авторитету, параметра нет.
9. **Записать «действующее» как `confirmed_by IS NOT NULL` (без учёта confirmed2_by).** Отвергнуто:
   критичный semi-confirmed грант (`proposed_by=actor, confirmed2_by=NULL`) НЕ активен по семантике
   записи `grants.ts`; показать его действующим = FR-5-нарушение. Предикат «действующего» зеркалит
   семантику записи (§2.1), а не наивный `confirmed_by`-фильтр.

---

## 5. Fitness-функции (исполнимые правила для CI)

| id | правило | ci_check |
|---|---|---|
| **FF-T0572-1** | `GET /api/rights/tenant-state` возвращает роли ИЗ `choros.role` реального тенанта вызывающего (не demo-pack, не `RIGHTS_SEED`); для тенанта с N>0 ролями — ровно эти N (сверка с прямым SQL). | `ci/checks/db/rights-overview.db.test.ts`: seed тенант с N ролей → GET → `roles.length===N`, id-множество == прямой `SELECT id FROM role`. (AC-1) |
| **FF-T0572-2** | Пустой тенант ⇒ `{roles:[]}` БЕЗ `demo:true`/фикстур-подмены (отличимо от «источник недоступен»). | `src/__tests__/rights-overview.test.ts`: 0 ролей ⇒ `roles:[]`, нет `demo`-поля; DB-error ⇒ 5xx/error-shape ≠ пустой список. (AC-2) |
| **FF-T0572-3** | `screen-rights.jsx` НЕ фетчит `/api/rights`; источник сменён на `/api/rights/tenant-state`. | `ci/checks/rights-overview-source-switch.sh`: grep `screen-rights.jsx` — нет `fetch('/api/rights')`(точный литерал без `/tenant-state`), есть `/api/rights/tenant-state`; self-test bad/good. (AC-3) |
| **FF-T0572-4** | Выдача роли из UI = ровно один `POST /api/role-assignments`; НЕТ нового write-эндпоинта для назначений. | `ci/checks/rights-ui-no-new-write.sh`: git-diff-scoped grep — в добавленных `src/` строках нет `router.register("POST", "/api/role-assignments"` (кроме предсуществующих); `web/src/` грантовые формы бьют в существующий путь. self-test. (AC-4) |
| **FF-T0572-5** | Выдача гранта из UI = ровно один `POST /api/grants`; НЕТ нового write-эндпоинта для грантов. | `ci/checks/rights-ui-no-new-write.sh` (та же проверка): нет добавленного `router.register("POST", "/api/grants"`; форма бьёт в существующий. self-test. (AC-5) |
| **FF-T0572-6** | Отзыв роли/гранта = существующие `POST .../:id/revoke`; НЕ прямой UPDATE, не новый revoke-путь. | `ci/checks/rights-ui-no-new-write.sh`: нет добавленного `router.register("POST", ".../revoke"`; UI зовёт `/api/grants/:id/revoke` / `/api/role-assignments/:id/revoke`. (AC-6) |
| **FF-T0572-7** | Ответ `{state:"semi-confirmed", second_approver_required:true}` рендерится как явное «ждёт подтверждения», НЕ активное право (semi-строка не в контейнере confirmed без waiting-маркера). | `web` unit (vitest+RTL или jsdom): мок POST-ответа semi-confirmed ⇒ DOM: строка в `pending`-контейнере с waiting-`StatusChip`, отсутствует в контейнере действующих. (AC-7) |
| **FF-T0572-8** | Полу-подтверждённое (`confirmed_by IS NOT NULL AND confirmed2_by IS NULL` критичное) НЕ отображается в «кто что может» как действующее ни в admin-, ни в self-взгляде. | `ci/checks/db/rights-overview.db.test.ts`: seed semi-confirmed grant+assignment ⇒ они в `roles[].pending.*`, НЕ в `roles[].grants`/`roles[].assignments`; сверка с SQL-фильтром на `confirmed2_by`. (AC-8) |
| **FF-T0572-9** | Обычный юзер (без `mgmt_object:role/grant`, не genesis owner) видит ТОЛЬКО read-only «мои права»; DOM не содержит форм выдачи роли/гранта; `can_manage:false`. | `src/__tests__/rights-overview.test.ts`: актор без admin-гранта ⇒ `scope:"self", can_manage:false`, `roles` только его; `web` unit: `can_manage:false` ⇒ формы записи не в DOM. (AC-9) |
| **FF-T0572-10** | Self-взгляд для актора X возвращает права ТОЛЬКО X (не всего тенанта), когда вызывающий не admin/owner; сервер фильтрует по идентичности, не по клиентскому параметру. | `ci/checks/db/rights-overview.db.test.ts`: два актора, non-admin; запрос от X ⇒ только роли X; попытка подмешать `employee_id` в запрос игнорируется (параметра нет / не читается). (AC-10) |
| **FF-T0572-ANTICASE** | Анти-кейс (D-064): в diff `src/` И `web/src/` нет литералов `role-approver`/`soglasovanie`/`tel-`/`Согласование`/`e-larina`/`e-orlov`/`e-configurator` в ДОБАВЛЕННЫХ строках. | `ci/checks/rights-ui-anti-case.sh`: git-diff-scoped grep по добавленным строкам под `src/`+`web/src/` (расширяет `read-pdp-anti-case.sh`, чей scope только `src/`); comment-strip + word-boundary как в оригинале; self-test bad/good. (AC-11, NF-4) |
| **FF-T0572-BADGE** | Бейдж `/rights/editor` в `shell.jsx` == `"demo"` с КОНКРЕТНЫМ тултипом (не общим): называет `INITIAL_GRANTS`/«гранты роли не подгружаются». (Вердикт §2.7.) | `ci/checks/rights-editor-badge-verdict.sh`: grep `shell.jsx` REFERENCE_TABS `editor`-строка `status:"demo"` + тултип содержит конкретный маркер (напр. «гранты роли»/«черновик»); self-test. (AC-12) |
| **FF-T0572-STATES** | Empty/Loading/Error на: «Обзоре ролей», форме выдачи/отзыва, обеих проекциях «кто что может» (admin+self) — по одному явному тесту/ветке на состояние. | `web` unit: для каждого — 3 ветки рендера (kit `EmptyState`/`LoadingState`/`ErrorState`) присутствуют; grep-присутствие компонентов + рендер-тест. (AC-13, NF-7) |
| **FF-T0572-SCOPE** | Формы используют существующий `parseScopeElement` через API-контракт: тело запроса — валидный `ScopeElement` JSON (`node`/`tags`/`set`), НЕ параллельный клиентский scope-формат. | `src/__tests__/rights-overview.test.ts` или grant-scope-тест: тело формы гранта парсится `parseScopeElement` без ошибки; `web` — нет собственного scope-сериализатора вне dictionaries-формы. (AC-14) |
| **FF-T0572-FROZEN** | Write-ядро байт-без-правок: `src/http/grants.ts`, `src/http/rights-change-requests.ts`, `src/core/dual-control.ts`, `src/core/role-criticality.ts`, `src/core/grant-resolver.ts`, `src/core/grant-lattice.ts` не редактируются (только импортируются). | `ci/checks/rights-ui-frozen-write.sh`: `git diff --name-only <base>` не содержит этих файлов (стиль `read-pdp-frozen-core.sh`); self-test bad/good. (NF-1, NF-2, FR-5) |
| **FF-UX-G2** | Контраст обе темы: новые/изменённые CSS-подсистемы (`overview` секции, формы, pending-контейнер) читаемы в light и dark; `:root`=light default, `[data-theme="dark"]` достижим (никакого dark-fallback). | существующий `ci/checks/ux/ux-g2-theme-pairing.sh` (репо-широкий, wired в fitness) — новые токены проходят A1/A2; ручная проверка обеих тем на LIVE_PROOF. (G2) |
| **FF-UX-G4** | State-примитивы: Empty/Loading/Error через kit-примитивы (`EmptyState`/`LoadingState`/`ErrorState`/`Skeleton`), не хэнд-роллед. | существующий `ci/checks/ux/ux-g4-state-primitives.sh`; FF-T0572-STATES дублирует по факту наличия. (G4, NF-7) |
| **FF-UX-G5** | Нет dev-жаргона в видимом тексте новых экранов (`web/src/screens/rights/**`): нет `T-\d{3,}`, bare-UUID, `is_system`, `confirmed2_by`, `mgmt_object`, `RESOURCE_ROOT` в отображаемом тексте (тех-термины — только в коде/комментах). | существующий `ci/checks/ux/ux-g5-jargon-denylist.sh` (comment-scoped, репо-широкий, wired) — новый видимый текст чист. (G5) |
| **FF-UX-G6** | Нет НОВОГО хардкода цвета/хэнд-роллед-оверлея в добавленных `web/src/screens/**`+`app-shell/**` строках; консумирует kit + токены. | существующий `ci/checks/ux/ux-g6-no-new-hardcode.sh` (diff-based, wired) — добавленные строки без `rgba(`/hex-литералов/inline-модалок. (G6) |
| **FF-UX-G7** | Бейдж≡контент + нет мёртвых аффордансов: бейдж `editor` честен (FF-T0572-BADGE); demo-`ROLE_GROUPS`/demo-id удалены из `screen-rights.jsx` (не мёртвая группировка по несуществующим id); нет disabled-кнопок без честной причины. | FF-T0572-BADGE + FF-T0572-3 (demo-id ушли); ручной UX_REVIEW G7-чек. (G7, FR-8) |
| **FF-T0572-TSC-LINT** | `tsc --noEmit` чист; `eslint` чист для новых/изменённых файлов; `npm run build` (веб-сборка) зелёный. | `tsc --noEmit && eslint src` + веб build; часть `npm run ci`. (AC-15) |

**Совместимость (задетые тесты — должны остаться зелёными):** `src/__tests__/nav-status.test.ts`
(верхний `rights`=`live` не меняется), `web/src/app-shell/nav-config.test.js`,
`web/src/app-shell/nav-visibility.test.js`, любые `screen-rights`-снапшоты (обновятся под новый shape),
`ra-criticality`/`ra-role-editor`/`ra-intents`-тесты (эти экраны НЕ трогаются логикой, только соседний
`overview`). Существующие grant/dual-control тесты (`grants.ts` frozen) — не задеты.

---

## 6. Объектная модель / контракты (единый источник для coder и tester)

### 6.1 Новый серверный модуль `src/http/rights-overview.ts`

```ts
// GET /api/rights/tenant-state — withAuth; tenant из auth (resolveActorTenant), НЕ query.
export interface OverviewAssignment {
  id: string; employee_id: string; employee_slug: string | null;
  employee_display: string | null; employee_kind: "human" | "agent" | "service";
  org_scope: unknown /* ScopeElement JSON */; state: "active";
}
export interface OverviewGrant {
  id: string; resource_type: string; operation: string;
  resource_facet: unknown | null; scope: unknown /* ScopeElement JSON */; state: "active";
}
export interface OverviewPending {
  assignments: { id: string; employee_display: string | null; confirmed_by: string | null }[];
  grants:      { id: string; description: string; confirmed_by: string | null }[];
}
export interface OverviewRole {
  id: string; slug: string; name: string | null;
  assignments: OverviewAssignment[]; // ТОЛЬКО действующие (§2.1 предикат)
  grants: OverviewGrant[];            // ТОЛЬКО действующие
  pending: OverviewPending;           // semi-confirmed, отдельно (FR-5)
}
export interface TenantStateResponse {
  scope: "tenant" | "self";
  can_manage: boolean;   // держит ли вызывающий mgmt_object:role/grant (форма записи видна)
  roles: OverviewRole[];
}
export function registerRightsOverviewRoutes(router: Router, pool: pg.Pool): void;
// Регистрируется в server.ts внутри if(grantsPool), ПЕРЕД registerRightsRoutes
// (literal path "/api/rights/tenant-state" не должен попасть в :roleId catch-all).
```

- Actor/tenant: `extractActorFromReq`(как в `grants.ts`/`rights-change-requests.ts`)→`resolveActorTenant`.
- Проекция: `loadAdminContext` ⇒ `can_manage = isGenesisOwner || adminGrants.length>0`;
  `scope="tenant"` при can_manage, иначе `scope="self"` + фильтр `employee_id = resolveActorSlugFromAuth→id`.
- Одна `withTenantTx`: `SELECT roles` + `SELECT assignments JOIN employee` + `SELECT grants`,
  агрегация in-memory по `role_id` (N+1-free). JOIN-форма ← `loadSubjectGrants`/`listChangeRequests`,
  БЕЗ `DEV_TENANT_ID`.
- «Действующий» предикат (§2.1): `confirmed_by IS NOT NULL AND (confirmed2_by IS NOT NULL OR proposed_by
  IS NULL)` + (для assignment) in-window `valid_from/until`; semi-confirmed
  (`confirmed_by IS NOT NULL AND confirmed2_by IS NULL AND proposed_by IS NOT NULL`) ⇒ `pending`.

### 6.2 Изменяемые фронтенд-файлы (additive/минимально)

| файл | изменение |
|---|---|
| `web/src/screens/rights/screen-rights.jsx` | источник → `/api/rights/tenant-state`; адаптация shape (assignments/grants/pending); удаление demo-`ROLE_GROUPS`/demo-id; секция «кто что может» (admin+self); формы выдачи/отзыва роли+гранта под `can_manage`; semi-confirmed pending-контейнер. Error/Loading/Empty — kit-переиспользование. |
| `web/src/app-shell/shell.jsx` | `REFERENCE_TABS` `editor` тултип → конкретный (§2.7); `status` остаётся `"demo"`. |
| (опц.) новый `web/src/screens/rights/ra-overview-forms.jsx` | если формы выдачи/отзыва выносятся из `screen-rights.jsx` для чистоты — kit `Field`/`Select`/`Button`/`ConfirmDialog`; провод к `/api/grants`+`/api/role-assignments`. Переиспользует `ra-data.jsx` примитивы + `dictionaries`. |

### 6.3 Существующие таблицы (НЕ новые столбцы/таблицы)

Читаются: `choros.role {id,slug,name,tenant_id}`, `choros.role_assignment {id,employee_id,role_id,
org_scope,confirmed_by,confirmed2_by,proposed_by,valid_from,valid_until}`, `choros."grant"
{id,role_id,resource_type,resource_facet,operation,scope,confirmed_by,confirmed2_by,proposed_by}`,
`choros.employee {id,slug,display_name,kind}`. Никаких DDL.

### 6.4 FROZEN (не редактируются, только импортируются)

`src/http/grants.ts`, `src/http/rights-change-requests.ts`, `src/http/rights.ts` (zero-pg),
`src/core/dual-control.ts`, `src/core/role-criticality.ts`, `src/core/grant-resolver.ts`,
`src/core/grant-lattice.ts`. `web/src/screens/rights/ra-role-editor.jsx`, `ra-intents.jsx`,
`ra-criticality.jsx`, `ra-sod.jsx` — не трогаются (соседние вкладки не ломаются, §совместимость).

### 6.5 Публичная поверхность и импортёры (совместимость)

- Новый `src/http/rights-overview.ts` — импортёр только `src/server.ts` (wiring, ПЕРЕД
  `registerRightsRoutes`). Порядок регистрации критичен (как `change-requests`/`sod` — literal перед
  `:roleId`).
- `screen-rights.jsx` — импортёр `web/src/app-shell/shell.jsx` (`RightsScreen`, маршрут `/rights`) —
  сигнатура компонента не меняется (`initialRole` prop опционален).

---

## 7. LIVE_PROOF-путь (D-064) — на живом тенанте (владелец ООО Аксон, не демо-ТЭЛ), глазами

1. Владелец открывает «Доступ»→«Обзор ролей» → видит РЕАЛЬНЫЕ роли тенанта (не «Нет ролей», не demo;
   если ролей 0 — честный first-use `EmptyState`). *(AC-1, AC-2, §2.3)*
2. Владелец выдаёт роль сотруднику (форма FR-2) → `POST /api/role-assignments` → либо
   `state:"confirmed"` (активно), либо честное `state:"semi-confirmed"` «ждёт второго». *(AC-4, AC-7)*
3. Владелец выдаёт грант роли — `authoring_draft` (разблокировка ассистента, карта §4 п.4) ИЛИ сужение
   `role-reader` (READ-грант T-0570) — форма FR-3 с явным scope. *(AC-5, AC-14)*
4. Владелец открывает «кто что может» (секция overview) → видит выданное действующее право по роли/
   сотруднику (если `confirmed`). *(AC-8, §2.4)*
5. **Dual-control честно прожит:** если шаг 2/3 эскалировал в semi-confirmed — переход в существующий
   инбокс `/rights/criticality` → `POST /api/rights/change-requests/:id/approve` → ПОСЛЕ этого право
   в «кто что может» действующее; ДО — только в `pending` (не действующее). *(AC-7, AC-8, §2.6)*
6. Обычный сотрудник открывает «Доступ» → видит ТОЛЬКО «мои права» человеческим языком; нет форм записи,
   нет чужих ролей. *(AC-9, AC-10, §2.2)*
7. **Круг размыкается:** владелец, у которого до задачи UI-пути выдать `authoring_draft` не было (карта
   §4 п.4), теперь делает это себе/ассистенту через форму FR-3 — без curl. Это разомкнёт T-0573-цепочку.

---

## 8. runtime_target

`runtime:node` + `web`. Сервер: новый `src/http/rights-overview.ts` (read-only, single-resolver DAO,
переиспользует `src/db/org.ts` примитивы) + wiring `src/server.ts`. Фронт: `screen-rights.jsx`
(живой источник + секции + формы), `shell.jsx` (бейдж-тултип). Fitness: vitest
(`src/__tests__/rights-overview.test.ts`) + live-PG (`ci/checks/db/rights-overview.db.test.ts`,
`npm run fitness:db`) + shell-линтеры (`rights-overview-source-switch.sh`, `rights-ui-no-new-write.sh`,
`rights-ui-anti-case.sh`, `rights-editor-badge-verdict.sh`, `rights-ui-frozen-write.sh` — все с
self-test, wired в `npm run fitness`) + существующие UX-гейты G2/G4/G5/G6 (репо-широкие) + web unit
(states, semi-confirmed) + `tsc --noEmit`/`eslint`/`npm run build`. **NF-6: UX_REVIEW фаза обязательна
перед TEST** (задача существенно трогает `web/`: 1 экран переписан на живые данные + новые формы/секции).

---

## 9. Escalation

Нет. Направление ратифицировано PD-17 (F1–F3) и картой примитивов (D4/D5, §7 п.1 — READ-PDP уже решён
T-0570, эта задача строит UI НАД готовым). Открытые инженерные развилки, делегированные architect/DESIGN
спекой §2/§8, закрыты здесь:

- **Где живёт новый GET** → новый файл `src/http/rights-overview.ts` (не снятие zero-pg инварианта
  `rights.ts`), §2.1.
- **Полнота scope-палитры формы гранта день-1** → `node`+`tags`+`set` (достижимость сужения через
  существующий `parseScopeElement`); `interval`/record-level К1 — `out_of_scope`, §2.5/FR-4.
- **Вердикт бейджа `/rights/editor`** → остаётся `"demo"` с КОНКРЕТНОЙ причиной (`INITIAL_GRANTS`
  засевает драфт, гранты роли не подгружаются из БД), §2.7/FF-T0572-BADGE — не разворот объёма.

Ничего высоколевериджно-спорного (деньги/продукт-направление/секреты/необратимое) не осталось.
