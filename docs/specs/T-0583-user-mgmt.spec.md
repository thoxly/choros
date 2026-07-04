# T-0583 — Спека: управление пользователями-учётками из продукта

**Status:** ready
**Phase:** SPEC
**Task:** T-0583 [W2/учётки, столп E5 — жизнь компании]
**Date:** 2026-07-04
**База:** dev @ `ff85d73` (ветка `task/T-0583-user-mgmt`)
**Кейс-доказательство (D-064):** «завести сотрудника с логином» — админ тенанта из UI
создаёт пользователю логин+пароль, тот логинится и видит записи. Generic, без имён персон.

---

## 1. Контекст (железный диагноз из разведки кода, file:line)

Ирония, зафиксированная в карте примитивов §E5: **ИИ-агента из UI нанять можно, человека —
нельзя**. Разведка подтверждает и уточняет диагноз.

### 1.1. Что УЖЕ есть (переиспользуем, НЕ дублируем)

- **Программный KC-admin-порт создания человека-пользователя СУЩЕСТВУЕТ.**
  `src/keycloak/admin-port.ts` — `KeycloakUserPort` (T-0342):
  - `createHumanUser({username,email,password,actorType:'human'})` → `{userId}` —
    `POST /admin/realms/<realm>/users` c `attributes.actor_type=['human']`,
    `credentials:[{type:'password', value, temporary:false}]`, `enabled:true`,
    `emailVerified:true`. Кидает `EMAIL_TAKEN` (409) / `AUTH_UNAVAILABLE` (KC недоступен).
    Возвращает `userId` = KC user UUID = будущий JWT `sub`.
  - `deleteUser(userId)` — best-effort компенсация (DELETE user).
  - Живой адаптер `makeHttpKeycloakUserPort()` (`admin-port.ts:318`), фейк
    `InMemoryKeycloakUserPort` (`fake-user-port.ts`). Аутентификация — `choros-registrar`
    (confidential client, `manage-users`), client_credentials. **Тот же порт**, что и
    agent-hire использует для KC-admin (T-0470 объединил на `choros-registrar`).
- **KC-креды — из env** (`admin-port.ts:285-292`, NF-6): `KEYCLOAK_BASE_URL`,
  `KEYCLOAK_REALM` (default `choros`), `KC_REGISTRAR_CLIENT_ID`,
  `KC_REGISTRAR_CLIENT_SECRET`. В коде секретов нет. Стенд: KC admin `:8180`, realm `choros`.
- **Порт вызывается СЕГОДНЯ только из `src/core/register.ts`** (self-registration тенанта:
  создаёт KC-учётку владельца + `employee(kind='human', slug=kcUserId, display_name=email)`).
  Ни один per-tenant UI-путь его не зовёт.
- **Модель сотрудника** (`migrations/016_employee.sql`): `tenant_id, id, position_id NULL,
  kind CHECK IN ('human','agent'), slug, display_name, created_at, updated_at`.
  PK `(tenant_id,id)`, UNIQUE `(tenant_id,slug)`. RLS FORCE.
- **Связка employee↔KC = `employee.slug`.** Для зарегистрированного человека
  `slug = KC user UUID` (= JWT `sub`; инвариант T-0342). Резолвер
  `resolveActorSlugFromAuth` (`src/db/org.ts`): sub-first (slug==sub), затем
  fallback по `preferred_username` (сид-персоны), оба ограничены `kind='human'`
  (T-0372 анти-импересонация).
- **hire-flow людей T-0619** (`src/http/rights-intents.ts` `registerHire`,
  `POST /api/rights/intents/hire`): при `kind='human'` вызывает
  `ensureReaderRoleAndAssignHuman` → идемпотентно `role-reader` + covering READ-грант +
  `role_assignment(human→role-reader)` CONFIRMED. **Переиспользуем этот hire-flow** —
  чтобы созданный пользователь СРАЗУ видел записи.
- **Существующий `POST /api/employees`** (`src/http/seed-write.ts:539`): создаёт
  `employee`-строку (caller-supplied slug) под гейтом
  `authorizeOrgWrite` + `assertOrgObjectAuthority('mgmt_object:employee','create')`.
  **НЕ создаёт KC-логин** — созданный так «сотрудник» войти не может.
- **Списки**: `listHumanEmployees` (`src/db/org.ts`) питает `GET /api/users` и
  `GET /api/org`; `getOrgStructure` — дерево. Ни списка «учёток», ни статуса активности.
- **Авторизация (два гейта, `src/core/scoped-admin.ts`)**: `mgmt_object:employee`/`create`
  (владелец `tenant-owner` ИЛИ делегируемый covering-грант) + орг-ось (target-scope ⊆
  admin-scope). Владелец короткозамыкает. Тенант резолвится
  `resolveActorTenant` → `SET LOCAL choros.tenant_id` + RLS (fail-closed 403 на чужой тенант).
- **UI**: `web/src/screens/screen-org.jsx` (оргструктура CRUD), `screen-agents.jsx`
  (найм агента: форма+список+активность). Экрана «пользователи/учётки» нет.
  Токены слоя — `web/src/design/tokens.css`, префикс `--chs-*` (OBLIK).

### 1.2. Настоящий разрыв (что строим)

1. **Нет UI-пути «создать KC-логин из продукта».** KC-порт готов, но per-tenant
   вызова нет — учётки заводят руками в Keycloak-admin.
2. **`employee(kind='human')`, созданный через `/api/employees` или hire-flow, НЕ
   связан с KC-логином** (его `slug` — произвольная строка, не KC sub) → войти нельзя.
   Настоящая «учётка» = `employee`, чей `slug = KC user UUID`, как у владельца.
3. **Нет списка пользователей тенанта с признаком «активен/деактивирован».**
4. **Нет деактивации.** KC-порт умеет только жёсткий `deleteUser` (компенсация);
   `disable` (enabled:false) + пометка `employee` отсутствуют — **это часть скоупа**.
   На `employee` нет столбца статуса (сегодня отзыв делается через
   `role_assignment.valid_until`), нужен явный признак деактивации учётки.

### 1.3. Директивы задачи

- Почту НЕ прикручиваем: `emailVerified:true` (как в register.ts), без письма-верификации.
- Переиспользовать KC-admin-порт agent-hire и hire-flow T-0619 — НЕ новый параллельный
  KC-путь.
- Секреты — из env, не в коде/логах; **пароль пользователя не логируется**.
- tenant-изоляция строгая: создание/список/деактивация только в тенанте актёра.

---

## 2. Решение (одной фразой на дыру)

1. **Создать пользователя**: новый write-эндпоинт `POST /api/users` (управление
   учётками; регистрируется в новом `src/http/user-mgmt.ts`, НЕ трогает замороженные
   пути), который под гейтом `mgmt_object:employee`/`create` + орг-ось:
   (а) валидирует login+пароль (≥8; без email-верификации);
   (б) **KC-first** зовёт `KeycloakUserPort.createHumanUser` (переиспускаемый порт) →
       `{userId}`;
   (в) в одной `withTenantTx` создаёт `employee(kind='human', slug=userId,
       display_name)` + переиспользует hire-flow-хелпер выдачи `role-reader`
       (тот же `ensureReaderRoleAndAssignHuman`-путь T-0619), опционально
       `role_assignment` на роль позиции, если задан `role_id`/`position_id`;
   (г) при падении БД после KC — best-effort `deleteUser` (компенсация, как register.ts).
   Login-collision → 409; KC недоступен → 503.
2. **Список пользователей**: `GET /api/users/accounts` (tenant-scoped) — люди-учётки
   тенанта: `{employee_id, login, display_name, position?, active}`; `active` из нового
   признака деактивации.
3. **Деактивация**: `PATCH /api/users/:employee_id` `{active:false}` под тем же гейтом —
   (а) `KeycloakUserPort.setUserEnabled(userId,false)` (новый метод порта: PUT user
       `{enabled:false}`); (б) пометка `employee` деактивированным. `{active:true}` —
   реактивация (enabled:true + снятие пометки). Признак деактивации — новый
   nullable-столбец `employee.deactivated_at bigint` (миграция), НЕ строка-статус.

Так «человека нанимать не сложнее, чем ИИ-агента»: агент = `POST /api/agents/hire`
(KC client), человек = `POST /api/users` (KC user) — оба через ОДИН KC-admin-порт.

---

## 3. Функциональные требования

- **F1.** `POST /api/users` с телом `{tenant_id, login, password, display_name,
  position_id?, role_id?}` создаёт: KC-пользователя (actor_type=['human'],
  password non-temporary, emailVerified:true, БЕЗ письма) + `employee(kind='human',
  slug=<KC userId>, display_name)` в тенанте актёра; возвращает `201 {employee_id, login}`.
  Пароль в ответе не возвращается.
- **F2.** Созданный пользователь СРАЗУ получает covering READ (`role-reader`) через
  переиспользуемый hire-flow-хелпер T-0619 (тот же путь, что `registerHire` для
  `kind='human'`), поэтому после логина видит записи (LIST непусто) — без отдельного шага.
- **F3.** Если заданы `role_id` (роль позиции) и/или `position_id` — создаётся
  `role_assignment(employee→role_id)` CONFIRMED и/или `employee.position_id` проставлен,
  под тем же admin-гейтом (орг-ось target-scope ⊆ admin-scope).
- **F4.** `GET /api/users/accounts` возвращает `{accounts:[{employee_id, login,
  display_name, position, department, active}]}` — только `kind='human'` тенанта актёра,
  tenant-scoped (RLS). `active=false` для деактивированных.
- **F5.** `PATCH /api/users/:employee_id` `{active:false}` деактивирует: KC
  `enabled:false` + `employee.deactivated_at` = now; `{active:true}` — реактивирует
  (KC `enabled:true` + `deactivated_at=NULL`). Возвращает `200 {employee_id, active}`.
- **F6.** Деактивированный пользователь не может войти/действовать: KC отказывает в токене
  (enabled:false); признак `active:false` виден в списке (F4).
- **F7.** UI-экран управления пользователями (`web/`): список учёток (F4) + форма
  создания (F1) + действие деактивации/реактивации (F5), на слое `--chs-*` (OBLIK),
  с честными Empty/Loading/Error-состояниями; пароль — `type=password`,
  `autoComplete=off`.
- **F8.** Все действия — под существующим org-write гейтом (`authorizeOrgWrite` +
  `assertOrgObjectAuthority('mgmt_object:employee', …)`): владелец тенанта ИЛИ держатель
  делегируемого covering `mgmt_object:employee`-гранта в покрывающем орг-скоупе; иначе 403.

---

## 4. Нефункциональные требования

- **N1. Пароль никогда не логируется и не пишется в audit_event** (включая текст ошибки
  KC — через санитайзер) и не возвращается ни в одном HTTP-ответе (create/list/patch/ошибки).
- **N2. KC-креды — только из env** (`KC_REGISTRAR_CLIENT_ID/SECRET`, `KEYCLOAK_BASE_URL`,
  `KEYCLOAK_REALM`); ни одного секрета/пароля-константы в `src/` (RL-1/NF-6).
- **N3. tenant-изоляция**: создание/список/деактивация строго в тенанте актёра
  (`resolveActorTenant` → `SET LOCAL choros.tenant_id` + RLS). Кросс-тенант (актёр A
  создаёт/видит/деактивирует в тенанте B) → 403/404/пусто, никогда не проходит.
- **N4. KC-first + компенсация**: KC-создание ДО записи в БД; падение БД после KC →
  best-effort `deleteUser` (нет KC-сироты). KC недоступен → 503, БД не тронута
  (паттерн register.ts / agent-hire).
- **N5. Переиспользование, НЕ дублирование**: используется существующий
  `KeycloakUserPort` (`src/keycloak/admin-port.ts`) и hire-flow-выдача `role-reader`
  T-0619; НЕ вводится второй KC-интеграционный модуль и не копируется KC-HTTP-логика.
- **N6. Честная деградация**: отсутствие KC-registrar-секрета/DATABASE_URL → 503
  `AUTH_UNAVAILABLE` (как register.ts wiring `server.ts:998-1013`), не 500/белый экран.
- **N7. Анти-кейс (D-064)**: никаких имён персон/кейс-слагов в `src/` — «создать
  пользователя» generic; login/display_name приходят из тела запроса на рантайме.
- **N8. UX_REVIEW обязателен (D-062)**: задача трогает `web/` — токены `--chs-*`,
  label/aria на полях формы, контраст статус-чипа «деактивирован», без dev-жаргона.
- **N9.** Login = `username` = `email`-поле KC (как register.ts: `username=email`), но
  письмо НЕ отправляется (`emailVerified:true`). Пароль ≥8 символов (инвариант register.ts).

---

## 5. Вне рамок (out of scope)

- **O1.** Смена/сброс пароля существующего пользователя, self-service профиль,
  восстановление доступа — отдельная задача.
- **O2.** Email-верификация/приглашения по почте — по прямой директиве «почту не
  прикручиваем».
- **O3.** Иерархия подчинения людей («мой руководитель», эскалация вверх, увольнение с
  замещением T-0035) — §E2/E3/E4 карты примитивов, отдельные задачи.
- **O4.** Управление учётками ИИ-агентов (kind='agent', KC client) — отдельный контур
  (`POST /api/agents/hire` уже покрывает создание; деактивация агента — не эта задача).
- **O5.** Массовый импорт пользователей / SCIM / внешний IdP-федерация.
- **O6.** Тонкая настройка ролей/грантов пользователя сверх дефолтного `role-reader` и
  опциональной роли позиции — управление правами живёт в экране «Доступ» (T-0609 и др.).
- **O7.** Жёсткое удаление учётки из UI (только деактивация; hard-delete остаётся
  owner-only админ-операцией `DELETE /api/employees/:id`, не расширяется этой задачей).

## 6. Acceptance criteria

См. `docs/specs/T-0583.spec.contract.json` (AC-1..AC-14).
