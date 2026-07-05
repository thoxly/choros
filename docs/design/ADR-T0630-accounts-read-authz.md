# ADR-T0630 — read-authority гейт на GET /api/users/accounts

Status: ready
Task: T-0630 (security, столп 4)
Base: dev@aee684b, branch `task/T-0630-accounts-read-authz`

## 1. Problem

`src/http/user-mgmt.ts` регистрирует три маршрута под общим комментарием
"all under the existing org-write gate, T-0469": POST create, GET list,
PATCH deactivate/reactivate. Но по факту:

- `POST /api/users` → `authorizeOrgWrite` + `loadAdminContext` +
  `assertOrgObjectAuthority(admin, "mgmt_object:employee", "create", …)`.
- `PATCH /api/users/:employee_id` → `loadAdminContext` +
  `assertOrgObjectAuthority(admin, "mgmt_object:employee", "update", …)`.
- `GET /api/users/accounts` → **ничего**. Только `extractActor` +
  `resolveActorTenant`, затем прямой SELECT по `tenantId`, без единого
  вызова `loadAdminContext`/`assertOrgObjectAuthority`.

Найдено адверс-скептиком на T-0628: любой аутентифицированный сотрудник
тенанта (например, рядовой seed-персонал без единого mgmt-гранта) забирает
`{employee_id, login, display_name, position, department, active}` для
КАЖДОГО человека в тенанте прямым `fetch('/api/users/accounts')`. Список
включает организационную структуру (кто где числится) и статус активности
(кто уволен/деактивирован) — данные, которые владелец явно гейтует на
записи (POST/PATCH), но по недосмотру не гейтовал на чтении.

## 2. Constraint from prior work (T-0658 / D-064)

T-0658 закрыло "деактивированный держит полномочия" эскалацию, добавив
`AND deactivated_at IS NULL` fail-closed в ОБА существующих authority-
резолвера (`isGenesisOwnerForTenant`, `loadAdminContext` — оба в
`src/db/org.ts`), явно называя их "a SECOND authority path parallel to
`getGrantsForSubject`" и предупреждая, что третий параллельный путь не
должен возникнуть без той же дисциплины.

Задача T-0630 прямо запрещает "городить новый employee-lookup без
deactivated_at" — то есть писать для GET свой SQL-запрос вида "есть ли у
актора роль X" в обход `loadAdminContext`. Это закрывает дверь для самого
дешёвого (и опасного) фикса — заменить отсутствующий гейт наспех
собранной проверкой.

## 3. Decision — reuse loadAdminContext + assertOrgObjectAuthority verbatim

GET получает ТОЧНО ТУ ЖЕ authority-проверку, что PATCH уже делает на той же
странице файла:

```ts
const admin = await loadAdminContext(pool, tenantId, actorId, nowMs());
const oracle = await loadTenantOrgAncestry(pool, tenantId);
assertOrgObjectAuthority(
  admin, "mgmt_object:employee", "read", tenantId, actorId, nowMs(),
  "owner or mgmt_object:employee grant required to read user accounts",
  oracle,
);
```

Это ноль новых SQL-запросов на "полномочия": `loadAdminContext` — уже
импортированная в этом файле функция (используется POST/PATCH), несёт
T-0658's `deactivated_at IS NULL` в ОБОИХ своих внутренних шагах (owner-
check и role_assignment-load). `assertOrgObjectAuthority` — уже
импортированная в этом файле функция (используется POST/PATCH),
использующая `validateAdminDelegation` (существующий lattice-резолвер,
`src/core/scoped-admin.ts`, FROZEN-adjacent и покрыт
`grant-resolver-isolation.sh`).

### 3.1 Почему `assertOrgObjectAuthority`, а не отдельный
`hasOrgObjectAuthority` (готовый пример GET /api/org/tenant-state)

`seed-write.ts` уже несёт паттерн read-гейта для GET: `hasOrgObjectAuthority`
— "держит ли актор ЛЮБОЙ делегируемый `mgmt_object:*` грант" (используется
`GET /api/org/tenant-state`, где "нет конкретной операции для гейта").
T-0630 просит уже, ПРИЦЕЛЬНО, "владелец ИЛИ `mgmt_object:employee` read
грант" — то есть ресурс-specific, не "любой оргобъект". `assertOrgObjectAuthority`
уже принимает `mgmtKind` как параметр (`"mgmt_object:employee"` конкретно)
— это более узкий, точный по спецификации гейт, чем `hasOrgObjectAuthority`
дал бы (тот пропустил бы держателя `mgmt_object:department`-only гранта,
что не то, что просит задача).

### 3.2 Расширение типа `operation` до `"create" | "update" | "delete" | "read"`

`assertOrgObjectAuthority`'s текущая сигнатура ограничивает `operation` до
`"create" | "update" | "delete"` — чисто TS-уровневое сужение поверх
`Operation` (`grant-lattice.ts`), который УЖЕ включает `"read"` (латтис не
меняется). Добавление `"read"` в объединение — аддитивная, обратно-
совместимая правка: все 8 существующих вызовов (seed-write.ts×6,
user-mgmt.ts×2) продолжают передавать create/update/delete без изменений.

Отклонённая альтернатива: заводить `assertOrgReadAuthority` как отдельную
функцию, дублирующую тело `assertOrgObjectAuthority` с operation
захардкоженной на `"read"`. Отклонено — чистое дублирование ради
косметики типа, когда параметризация уже существует и требует только
расширения union.

### 3.3 Почему НЕ трогаем POST/PATCH

Их гейт-код не меняется вообще (кроме соседнего 409-текста, п.4) — только
GET получает симметричный вызов. `assertOrgObjectAuthority`'s собственное
тело не меняется (кроме типа параметра), поведение genesis-owner
short-circuit и delegable-grant covering-check идентично уже проверенному
на POST/PATCH.

## 4. 409-текст: "email занят" → "логин или email уже заняты"

Побочный, но входящий в задачу фикс. `POST /api/users`'s `EMAIL_TAKEN`
ветка (KC-порт код) маппилась в `"an account with that email already
exists"`. Но `admin-port.ts`'s собственный комментарий признаёт: "DEFAULT
to EMAIL_TAKEN when the body is absent/unparseable/ambiguous" — то есть наш
`EMAIL_TAKEN` код НЕ гарантированно означает "именно email столкнулся";
Keycloak's 409-ответ на клэш логина иногда неразличим от клэша email при
отсутствующем/непарсящемся теле. Владелец, попытавшийся создать учётку со
свободным (не занятым) login, но получивший ошибку "email занят", будет
чинить не то поле. Текст смягчён до "логин или email уже заняты — выберите
другие значения" — честно отражает недифференцированность источника,
не сужая диагноз до одного поля, который бэкенд не может гарантировать.

`LOGIN_TAKEN` (отдельный KC-код, T-0633 round-3, однозначно про username)
не трогается — там диагноз уже точен ("this login is already taken").

## 5. Security invariant preserved

- Тенант-изоляция: GET по-прежнему резолвит `tenantId` актора ДО SELECT
  (`resolveActorTenant`) — новый гейт добавляется ПОСЛЕ, не меняет, какой
  тенант читается (актор физически не может увидеть чужой тенант ни при
  каком исходе authority-проверки).
- Deactivated actor fail-closed: наследуется от `loadAdminContext`'s T-0658
  предикат — деактивированный держатель гранта теперь не пройдёт ни write,
  ни (после этого фикса) read гейт.
- Owner short-circuit: `admin.isGenesisOwner` (резолвится из БД, NF-3) —
  владелец тенанта видит список без дополнительного гранта, как и раньше
  (не регрессия для владельца).

## 6. Alternatives rejected

- **Client-side hide only** (скрыть список в UI для не-владельца, оставить
  API открытым) — прямо то, что задача просит закрыть; отклонено, это
  ровно старый баг (маскировка вместо гейта).
- **Новый employee-lookup SQL без deactivated_at** — прямо запрещено
  постановкой (D-064/T-0658 предупреждение); отклонено.
- **hasOrgObjectAuthority (любой mgmt_object grant)** — шире, чем просит
  задача (`mgmt_object:employee` конкретно); отклонено в пользу
  параметризованного `assertOrgObjectAuthority`.
