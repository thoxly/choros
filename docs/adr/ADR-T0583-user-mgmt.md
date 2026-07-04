# ADR-T0583 — Управление пользователями-учётками из продукта (переиспользование KC-admin-порта)

**Задача:** T-0583 [W2/учётки, столп E5]. Опирается на T-0342 (KeycloakUserPort),
T-0470 (choros-registrar как единый KC-admin-клиент), T-0619 (hire-flow role-reader),
T-0469 (org-object authority гейт).
**Статус:** ready.
**changes_product:** 1 (LIVE_PROOF: человек логинится под учёткой, созданной из UI).
**Спека:** `docs/specs/T-0583-user-mgmt.spec.md` (AC-1..AC-15).

---

## 1. Контекст (разведанные несущие факты)

Программный KC-admin-порт создания человека-пользователя УЖЕ ПОСТРОЕН и ПРОВЕРЕН —
`KeycloakUserPort` в `src/keycloak/admin-port.ts` (T-0342), живой адаптер
`makeHttpKeycloakUserPort()`, фейк `InMemoryKeycloakUserPort`. Он:
- `createHumanUser({username,email,password,actorType:'human'})` → `{userId}` (KC user
  UUID = будущий JWT `sub`); ставит `actor_type=['human']`, `emailVerified:true`,
  password non-temporary; кидает `EMAIL_TAKEN`/`AUTH_UNAVAILABLE`;
- `deleteUser(userId)` — best-effort компенсация;
- аутентификация — `choros-registrar` (confidential, `manage-users`, client_credentials),
  креды из env (`KC_REGISTRAR_CLIENT_ID/SECRET`, `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`).

**Тот же порт-модуль** обслуживает и agent-hire (`makeHttpKeycloakAdminPort` для KC
client), объединённый T-0470 на `choros-registrar` (`manage-clients` + `manage-users`).
Сегодня `createHumanUser` вызывается ТОЛЬКО из `src/core/register.ts` (self-registration
владельца тенанта). **Per-tenant UI-пути «создать учётку человеку» не существует** —
это и есть разрыв E5.

Связка employee↔KC: `employee.slug = KC user UUID` для зарегистрированного человека
(инвариант T-0342; резолвер `resolveActorSlugFromAuth` в `src/db/org.ts`, sub-first +
preferred_username fallback, оба `kind='human'`). Существующий `POST /api/employees`
(`src/http/seed-write.ts`) создаёт `employee`-строку с ПРОИЗВОЛЬНЫМ slug и БЕЗ KC-логина
→ такой «сотрудник» войти не может.

Деактивации нет: KC-порт умеет только жёсткий `deleteUser`; `disable` (enabled:false)
отсутствует; на `employee` нет столбца статуса.

---

## 2. Решение

**Новый модуль управления учётками `src/http/user-mgmt.ts` с тремя эндпоинтами, который
ПЕРЕИСПОЛЬЗУЕТ существующий `KeycloakUserPort` (не новый KC-путь), hire-flow-выдачу
`role-reader` T-0619 и org-object authority гейт T-0469; плюс расширение
`KeycloakUserPort` одним методом `setUserEnabled` и один additive-столбец
`employee.deactivated_at`.**

### 2.1 POST /api/users — создать учётку (create-then-link, KC-first)

Паттерн — КОПИЯ дисциплины `register.ts`/`agent-hire`, но per-tenant:

1. `extractActor` → `resolveActorTenant` → `tenantId` (актёр); тело
   `{tenant_id, login, password, display_name, position_id?, role_id?}`.
2. **ГЕЙТ до side-effect**: `authorizeOrgWrite(req,pool,tenant_id,now)` (кросс-тенант-гард
   + резолв authority-тенанта) + `assertOrgObjectAuthority(admin,'mgmt_object:employee',
   'create',tenant_id,actorId,now, oracle)` — владелец ИЛИ делегируемый covering-грант;
   иначе 403. (Тот же гейт, что `POST /api/employees` в seed-write.ts:557.)
3. Валидация: `login` непустой, `password.length>=8`, `display_name` непустой
   (инвариант `register.ts.validateRequest`).
4. **KC-first**: `kcUserPort.createHumanUser({username:login, email:login, password,
   actorType:'human'})` → `{userId}`. Ошибка `EMAIL_TAKEN` → 409;
   `AUTH_UNAVAILABLE`/иное → 503. **Пароль дальше не переиспользуется и не логируется.**
5. **`withTenantTx(pool, tenant_id, …)`** (SET LOCAL choros.tenant_id + RLS):
   - INSERT `employee(tenant_id, id, position_id, kind='human', slug=userId,
     display_name, created_at, updated_at)` — **slug = KC userId** (связка).
   - **Переиспользовать hire-flow-выдачу READ**: тот же путь, что `registerHire`
     исполняет для `kind='human'` (`ensureReaderRoleAndAssignHuman` из
     `rights-intents.ts`) — идемпотентно `role-reader` + covering READ-грант +
     `role_assignment(employee→role-reader)` CONFIRMED. **Извлечь хелпер в общий модуль,
     чтобы оба вызывателя (rights-intents + user-mgmt) звали ОДНУ функцию** (см. §5,
     контракт совместимости FE-W23-0008).
   - Если задан `role_id` (роль позиции) — дополнительный `role_assignment` CONFIRMED
     под тем же гейтом (орг-ось target-scope ⊆ admin-scope); `position_id` — в INSERT
     employee.
   - `appendAuditEvent` (создание учётки; БЕЗ пароля).
6. При падении БД ПОСЛЕ KC-создания → best-effort `kcUserPort.deleteUser(userId)` +
   rethrow (компенсация, нет KC-сироты). Login-collision в БД (UNIQUE slug — не должно
   быть, slug=UUID) → 409.
7. `201 {employee_id, login}`. Пароль не в ответе.

### 2.2 GET /api/users/accounts — список учёток тенанта

Tenant-scoped через `resolveActorTenant` + RLS. Читает `kind='human'` тенанта с LEFT JOIN
position/department (переиспустить форму `listHumanEmployees` из `src/db/org.ts`, добавив
`deactivated_at`→`active`). Ответ `{accounts:[{employee_id, login (=slug-производное или
display), display_name, position, department, active}]}`. `active = deactivated_at IS
NULL`. Гейт — членство в тенанте (список своих сотрудников; чтение оргструктуры уже
доступно членам). `login` в списке — человекочитаемая метка учётки; сырой KC UUID
(slug) наружу не обязателен, но `employee_id` несётся для PATCH.

### 2.3 PATCH /api/users/:employee_id — деактивация/реактивация

1. `extractActor`→`tenantId`; гейт — `assertOrgObjectAuthority('mgmt_object:employee',
   'update', …)` (владелец ИЛИ covering-грант); иначе 403.
2. Резолв employee по `(tenant_id, employee_id)` под RLS; отсутствует/чужой тенант → 404.
   `employee.slug` = KC userId (для KC-вызова).
3. `{active:false}`: `kcUserPort.setUserEnabled(userId,false)` (PUT user `{enabled:false}`)
   → `withTenantTx`: `UPDATE employee SET deactivated_at=now, updated_at=now`.
   `{active:true}`: `setUserEnabled(userId,true)` → `deactivated_at=NULL`.
   KC-first: если KC-вызов упал (недоступен) → 503, БД не тронута.
4. Аудит-событие деактивации/реактивации. `200 {employee_id, active}`.

### 2.4 Расширение KeycloakUserPort: setUserEnabled

Добавить в интерфейс `KeycloakUserPort` (admin-port.ts) метод
`setUserEnabled(userId:string, enabled:boolean): Promise<void>` — `PUT
/admin/realms/<realm>/users/<userId>` c `{enabled}` через registrar-токен. Реализовать
в `makeHttpKeycloakUserPort` (тот же `doRequest`/`getRegistrarToken`-паттерн, что
`deleteUser`) и в `InMemoryKeycloakUserPort` (флаг `enabled` в capture-логе). Это
additive-расширение существующего порта, НЕ новый модуль (N5).

### 2.5 Миграция: employee.deactivated_at (additive)

`migrations/<NNN>_employee_deactivated_at.sql`:
`ALTER TABLE choros.employee ADD COLUMN deactivated_at bigint NULL;` — nullable, без
дефолта, обратно совместим (существующие строки = NULL = active). Никаких новых таблиц,
FK, RLS-политик (наследует employee). Столбец, НЕ строка-статус (D-064: generic признак,
не enum кейса). Номер миграции присвоить при мерже (перенумеровать при конфликте —
конвенция choros-run-poehali).

### 2.6 Wiring (server.ts)

Зарегистрировать `registerUserMgmtRoutes(router, {pool: grantsPool, kc: kcUserPort,
resolveActorTenant})` рядом с `registerRegisterRoutes`, **переиспользуя ТОТ ЖЕ
`kcUserPort`**, что уже собран в `server.ts:998-1013` (registrar-secret → живой порт,
иначе honest-degrade заглушка 503). Deps-gated на `grantsPool`. `setUserEnabled` в
honest-degrade-заглушке — no-op, деактивация вернёт 503.

---

## 3. Отвергнутые альтернативы

| Опция | Почему нет |
|---|---|
| Новый параллельный KC-интеграционный модуль/HTTP-логика для создания пользователя | Дублирование T-0342 `KeycloakUserPort`. Задача прямо требует переиспустить KC-admin-порт agent-hire (N5). Второй KC-путь = вторая точка дрейфа кредов/realm. |
| Расширить существующий hire-flow `POST /api/rights/intents/hire`, чтобы он создавал KC-логин при kind='human' | rights-intents — это выдача ПРАВ (preset-гранты + role_assignment), его семантика «нанять роль», а не «завести учётку». Создание KC-user внутри него смешало бы два контура и сломало бы существующий контракт (registerHire создаёт employee с произвольным slug; смена на slug=KC-UUID регрессировала бы вызывающих). Управление учётками — свой экран/эндпоинт; role-reader-выдачу переиспользуем как ХЕЛПЕР, а не как хост. |
| Расширить `POST /api/employees` (seed-write.ts), чтобы он опционально создавал KC-логин | seed-write.ts несёт org-CRUD и частично заморожен/зависит от isGenesisOwner-путей; впихивание KC-first+компенсации утяжелит его. Отдельный `user-mgmt.ts` — тонкий, single-purpose, не трогает org-CRUD контракты. |
| Хранить статус учётки в `role_assignment.valid_until` (как отзыв ролей) | Отзыв роли ≠ деактивация учётки. Деактивированный пользователь должен НЕ ЛОГИНИТЬСЯ (KC enabled:false) независимо от ролей; valid_until не влияет на KC-логин. Нужен явный признак на employee + KC-disable. |
| Enum-столбец `employee.status text` | Строка-статус приглашает кейс-специфичные значения (D-064). `deactivated_at bigint NULL` — generic, timestamp несёт и «когда», и «активен ли» (NULL=active), совместим с существующим bigint-epoch стилем таблицы. |
| Hard-delete учётки из UI вместо деактивации | Необратимо, ломает историю/аудит и FK; hard-delete остаётся owner-only `DELETE /api/employees/:id` (O7). Деактивация обратима и безопасна. |
| slug = login (человекочитаемый), KC sub отдельно | Нарушает инвариант T-0342 (slug=sub для зарегистрированных). Резолвер `resolveActorSlugFromAuth` sub-first ожидает slug=KC UUID; login-slug сломал бы вход нового пользователя. slug=userId — единственный совместимый выбор. |

---

## 4. Объектная модель

### 4.1 `employee` — additive-изменение (миграция)

| Поле | Тип | Null | Смысл |
|---|---|---|---|
| `deactivated_at` | `bigint` | Yes | epoch-ms деактивации учётки; NULL = активна. Единственное изменение таблицы. |

Остальные столбцы (`tenant_id, id, position_id, kind, slug, display_name, created_at,
updated_at`) — без изменений. Для учётки, созданной этой задачей: `kind='human'`,
`slug = KC user UUID`, `display_name` из запроса.

### 4.2 Существующие таблицы (переиспускаются, НЕ меняются)

- `choros.role` (role-reader) — ensure ON CONFLICT (hire-flow-хелпер).
- `choros.role_assignment` — employee→role-reader (CONFIRMED) + опц. employee→role_id.
- `choros."grant"` — covering READ на role-reader (hire-flow-хелпер).
- `choros.audit_event` — событие создания/деактивации учётки (без пароля).

### 4.3 KeycloakUserPort (расширение интерфейса, admin-port.ts)

| Метод | Сигнатура | Смысл |
|---|---|---|
| `createHumanUser` | `(spec:KcHumanUserSpec)→Promise<{userId}>` | СУЩЕСТВУЕТ (T-0342). Переиспускается. |
| `deleteUser` | `(userId:string)→Promise<void>` | СУЩЕСТВУЕТ. Компенсация. |
| `setUserEnabled` | `(userId:string, enabled:boolean)→Promise<void>` | **НОВЫЙ.** PUT user `{enabled}`. |

---

## 5. Контракты

- **`src/http/user-mgmt.ts` (новый файл):** `registerUserMgmtRoutes(router, {pool,
  kc:KeycloakUserPort, resolveActorTenant})` регистрирует:
  - `POST /api/users` → `{tenant_id, login, password, display_name, position_id?,
    role_id?}` → 201 `{employee_id, login}` (§2.1). Гейт `assertOrgObjectAuthority(
    'mgmt_object:employee','create')`. KC-first + компенсация. Пароль не в ответе/логе.
  - `GET /api/users/accounts` → `{accounts:[{employee_id, login, display_name, position,
    department, active}]}` (§2.2). Tenant-scoped.
  - `PATCH /api/users/:employee_id` → `{active:boolean}` → 200 `{employee_id, active}`
    (§2.3). Гейт `assertOrgObjectAuthority('mgmt_object:employee','update')`.
- **Извлечение hire-flow-хелпера (контракт совместимости FE-W23-0008):**
  `ensureReaderRoleAndAssignHuman` сейчас — приватная функция в
  `src/http/rights-intents.ts`. Вынести её (или её тело) в общий модуль (например
  `src/core/reader-grant.ts` или экспорт из существующего read-visibility-контура),
  чтобы `rights-intents.ts` (registerHire) И `user-mgmt.ts` звали ОДНУ реализацию.
  `rights-intents.ts` продолжает вызывать её с ТЕМ ЖЕ поведением (регрессия hire-flow
  T-0619 запрещена — покрыто существующим `hire-read-grant.db.test.ts`, который должен
  остаться зелёным). Публичная поверхность `rights-intents.ts` (registerHire и др.) не
  меняется.
- **`src/keycloak/admin-port.ts` (additive):** `KeycloakUserPort.setUserEnabled` в
  интерфейсе + реализация в `makeHttpKeycloakUserPort`; фейк
  `InMemoryKeycloakUserPort.setUserEnabled` (`fake-user-port.ts`) с capture (`enabled`
  на CapturedUser). Существующие `createHumanUser`/`deleteUser` — не трогаются.
- **`migrations/<NNN>_employee_deactivated_at.sql`:** `ALTER TABLE choros.employee ADD
  COLUMN deactivated_at bigint NULL;` — additive, идемпотентно применяется run.mjs.
- **`src/server.ts` (wiring):** `registerUserMgmtRoutes` рядом с
  `registerRegisterRoutes`, ПЕРЕИСПОЛЬЗУЯ тот же `kcUserPort`
  (registrar-secret gate → живой/honest-degrade). Deps-gated на `grantsPool`.
- **`web/` (новый экран):** список учёток + форма создания + деактивация, компоненты на
  `--chs-*` (tokens.css), паттерн `screen-agents.jsx` (форма+список). Empty/Loading/Error.
- **FROZEN (только чтение/импорт):** `src/core/register.ts` (его KC-first-паттерн —
  образец, не меняется), `src/http/records.ts`/`read-visibility.ts`/`grants-dao.ts`
  (READ-PDP гейт), `src/core/scoped-admin.ts` (гейт-логика), frozen rights-write
  (`grants.ts`, `rights.ts` — не трогаем).
- **Известные BUILD-фазные test-seam правки (coder):** новая колонка employee →
  проверить `ci/checks/db/*` схема-ассерты по employee (колоночные счётчики,
  cross_tenant seed) — обновить как в T-0020 §4.4 (тот же класс правки).

---

## 6. Fitness-функции

| id | правило | ci_check |
|----|---------|----------|
| FF-583-1 | POST /api/users под владельцем создаёт KC-user (createHumanUser вызван 1×) + employee(kind='human', slug=<KC userId>); 201; slug==возвращённый userId (связка). | `ci/checks/db/user-mgmt.db.test.ts` (live PG + InMemoryKeycloakUserPort): POST → capture.created.length==1, employee.slug==capture userId, kind='human'. |
| FF-583-2 | Созданный пользователь получает role-reader + covering READ (тот же результат, что hire-flow T-0619); getGrantsForSubject содержит read/record/RESOURCE_ROOT; GET /api/records видит запись. | тот же db-тест: после POST → getGrantsForSubject(employee) содержит read-грант; prod-shaped resolver отдаёт запись. |
| FF-583-3 | KC-first + компенсация: падение БД после KC-create → deleteUser вызван 1× тем же userId; 201 НЕ возвращается; login уже занят (createHumanUser→EMAIL_TAKEN) → 409, employee не создан. | db-тест с инъекцией сбоя (fake failAfterCreate / failOnCreate): deleteCallCount==1; на EMAIL_TAKEN — 0 строк employee. |
| FF-583-4 | Деактивация: PATCH {active:false} → setUserEnabled(userId,false) 1× + employee.deactivated_at!=NULL; список показывает active:false; {active:true} → enabled:true + deactivated_at=NULL, active:true. | db-тест: PATCH false → fake.enabled==false, deactivated_at set; PATCH true → enabled==true, deactivated_at NULL. |
| FF-583-5 | tenant-изоляция: актёр A на POST с tenant_id B → 403; PATCH по employee B → 403/404; GET /accounts A не содержит сотрудников B (RLS первичен под choros_app NOBYPASSRLS). | db-тест live PG: два тенанта; кросс-действия 403/404; список scoped. |
| FF-583-6 | Авторизация: непривилегированный член (без mgmt_object:employee) на POST/PATCH → 403 ADMIN_GATE_REJECTED, не 500/тихий успех; владелец — 201/200. | db-тест: актёр без гранта → 403; владелец → успех. |
| FF-583-7 | Пароль не утекает: греп всех тел HTTP-ответов интеграционного прогона + серверного лога + audit_event на известную тестовую строку пароля → 0 совпадений; греп src/ на захардкоженный пароль/KC-registrar-секрет → 0 (только process.env). | `ci/checks/user-mgmt-no-secret-leak.sh` (греп прогона + статик-скан src/). |
| FF-583-8 | Переиспользование, НЕ дублирование: user-mgmt.ts НЕ содержит собственных KC-HTTP-вызовов (admin/realms/.../users) — импортирует KeycloakUserPort; hire-flow-выдача role-reader — общий хелпер, звонимый и из rights-intents.ts, и из user-mgmt.ts. | `ci/checks/user-mgmt-reuses-kc-port.sh`: греп — в src/http/user-mgmt.ts нет literal '/admin/realms', есть import KeycloakUserPort; общий reader-grant хелпер импортируется в обоих. |
| FF-583-9 | Анти-кейс (D-064): git-diff src/ без имён персон/кейс-слагов; механизм generic (login/display_name из тела). | существующий `ci/checks/read-pdp-anti-case.sh` (git-diff scoped src/) зелёный на diff. |
| FF-583-10 | hire-flow T-0619 НЕ регрессировал после извлечения общего хелпера: существующий hire-read-grant db-тест зелёный (registerHire kind='human' по-прежнему выдаёт role-reader; kind='agent' — нет). | существующий `ci/checks/db/hire-read-grant.db.test.ts` остаётся зелёным. |
| FF-583-11 (UX) | Экран управления пользователями: контраст ≥ WCAG AA в обеих темах, потребление --chs-* (нет hardcoded hex), есть Empty/Loading/Error, поле пароля type=password + autoComplete=off + label/aria, статус-чип «деактивирован» ≡ данным, нет dev-жаргона. | `ci/checks/ux/*` + `e2e/journeys/user-mgmt.ux.journey.ts` (UX honest-gate G1–G7). |

---

## 7. Трассировка критериев приёмки

| AC | покрыто |
|----|---------|
| AC-1 create → employee(kind=human, slug=KC userId) | §2.1 + FF-583-1 |
| AC-2 slug == KC userId (связка) | §2.1 + FF-583-1 |
| AC-3 covering READ через hire-flow T-0619 | §2.1 переиспуск хелпера + FF-583-2 |
| AC-4 EMAIL_TAKEN → 409, нет частичного | §2.1 п.4/6 + FF-583-3 |
| AC-5 компенсация deleteUser 1× | §2.1 п.6 + FF-583-3 |
| AC-6 список tenant-scoped, active | §2.2 + FF-583-5 |
| AC-7 деактивация (KC disable + deactivated_at) | §2.3/§2.4/§2.5 + FF-583-4 |
| AC-8 реактивация | §2.3 + FF-583-4 |
| AC-9 кросс-тенант блокирован | §2.1/§2.3 гейт+RLS + FF-583-5 |
| AC-10 непривилегированный → 403 | §2.1/§2.3 гейт + FF-583-6 |
| AC-11 пароль не в ответах | §2.1 N1 + FF-583-7 |
| AC-12 пароль/секрет не в логе/аудите/коде | §2.1/§2.6 N1/N2 + FF-583-7 |
| AC-13 анти-кейс | N7 + FF-583-9 |
| AC-14 LIVE_PROOF вход/деактивация | весь §2 (сквозной путь) |
| AC-15 UX_REVIEW | §2.6 web + FF-583-11 |

---

## 8. runtime_target

`runtime:node` + Postgres + **живой Keycloak** (KC admin `:8180`, realm `choros`).
TS/HTTP-слой (`src/http/user-mgmt.ts`) + additive-миграция
(`migrations/<NNN>_employee_deactivated_at.sql`, штатный `migrations/run.mjs`) + web-экран.
Внешний ресурс = уже работающий на dev-стенде Keycloak (registrar-креды в env
контейнера, T-0470) — новый провижн НЕ требуется. Fitness: live-PG vitest
(`npm run fitness:db` на PG :55432, соло) с `InMemoryKeycloakUserPort` (без живого KC
в CI) + shell-линтеры (no-secret-leak, reuses-kc-port, anti-case) + UX-journey.
LIVE_PROOF (AC-14) — на задеплоенном стенде с реальным KC (гейт фаундера = деплой).

## 9. escalation

Пусто. Локализованная фича поверх ратифицированных примитивов (KeycloakUserPort T-0342,
hire-flow T-0619, org-object authority T-0469); переиспускает существующий KC-admin-порт,
кросс-вендор-петля не нужна. Единственный расширяемый примитив — additive `setUserEnabled`
на существующем порту и additive-столбец `deactivated_at` (не новая подсистема).
