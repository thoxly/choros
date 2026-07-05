# ADR-T0658 — единый резолвер прав закрывает деактивацию fail-closed

Status: ready
Task: T-0658 (security/системный — столп 4, агенты/сотрудники с правами)
Base: dev@de79ad5, branch `task/T-0658-resolver-deactivation-gate`

## 1. Problem

`getGrantsForSubject` (`src/db/grants-dao.ts:208`) — единственный резолвер
прав (single-resolver constraint, T-0610). Его шаг 1 (`grants-dao.ts:216-220`
до фикса):

```sql
SELECT id FROM choros.employee
 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
```

резолвит subject slug → employee id БЕЗ предиката `deactivated_at IS NULL`.

`choros.employee.deactivated_at` (migration 125, T-0583, ADR-T0583-user-mgmt
§2.5) — генерик epoch-ms маркер деактивации УЧЁТНОЙ ЗАПИСИ, независимый от
`role_assignment.valid_until` ("деактивированный = не держатель"). PATCH
`/api/users/:employee_id` (`user-mgmt.ts:489-556`) деактивирует KC-логин
KC-first (`kc.setUserEnabled(kcUserId, false)`), затем ставит
`employee.deactivated_at`. Но KC `enabled:false` блокирует ТОЛЬКО выдачу
НОВОГО токена — уже выданный access-токен остаётся валидным до истечения
собственного TTL (окно порядка минут). В этом окне держатель токена
предъявляет его на ЛЮБОЙ PDP-путь, и `getGrantsForSubject` шаг 1 резолвит
его employee-строку как если бы аккаунт был жив — шаги 2 (role_assignment) и
3 (grant) после этого не видят никакой разницы и отдают полный, обычный набор
грантов.

Это уже было обнаружено локально: `inbox.ts` claim (T-0588 BLOCK-3,
`inbox.ts:1403-1417`) и approve (T-0588 RE-VERIFY, `inbox.ts:1625-1643`) оба
несут СВОЙ СОБСТВЕННЫЙ `findEmployeeById` + `deactivatedAt != null` гейт
ПЕРЕД делегацией в `resolveRolesForActor` (которая сама вызывает
`getGrantsForSubject`-путь через `getRoleSlugsForActor`), с явным комментарием
в коде: *"getRoleSlugsForActor does not filter on employee.deactivated_at, so
without this check a fired employee ... could still claim/approve"*. Это —
диагноз асимметрии: КАЖДЫЙ новый (или уже существующий) потребитель обязан
САМ вспомнить деактивацию и продублировать гейт. `invoke.ts`, `records.ts`
(оба резолвера — field-visibility и read-visibility), `org.ts`
(capability-token), `sandbox-gate-dao.ts`, `capability-grants-dao.ts`,
`registry-digest-dao.ts` — НИ ОДИН из них такого локального гейта не имеет.

Замечено также (адверс-скептик T-0610, унаследованная рекомендация): системный
фикс в РЕЗОЛВЕРЕ закрывает дыру РАЗОМ для всех текущих и будущих потребителей,
устраняя саму категорию "забыли продублировать гейт".

## 2. Decision

**Добавить `AND deactivated_at IS NULL` в шаг 1 `getGrantsForSubject`**
(fail-closed): деактивированный subject резолвится в `[]` employee-строк на
самом входе резолвера → шаги 2-3 никогда не выполняются для него →
`getGrantsForSubject` возвращает `[]` грантов, симметрично сентинелу
"неизвестный актор" (эти два случая теперь неразличимы для ЛЮБОГО потребителя
PDP — корректная fail-closed форма: PDP не обязан и не должен различать
"нет такого сотрудника" от "сотрудник уволен").

### 2.1 Где именно лёг предикат

```sql
SELECT id FROM choros.employee
 WHERE tenant_id = $1 AND slug = $2 AND deactivated_at IS NULL LIMIT 1
```

Один `AND`, один параметризованный запрос, БЕЗ нового условного ветвления —
шаги 2 (`role_assignment`) и 3 (`grant`) не тронуты (они и не должны быть:
дуал-контроль критичных грантов там — отдельный, ортогональный домен).

### 2.2 Human vs agent — почему единый безусловный предикат безопасен для обоих

`getGrantsForSubject` шаг 1 — ОДИН SQL-запрос против `choros.employee`, без
условия на `kind`. Разведка подтверждает: нет отдельного "агентского" пути
резолюции subject→id — assistant-agent (`register.ts:359-368`, комментарий на
строке 364: *"Without this row, getGrantsForSubject returns [] for the
agent"*) и все seed-агенты (`a-recon`, `a-invoice`, `a-triage`, `s-ledger`,
`s-ocr` — migration 032) резолвятся ЧЕРЕЗ ТОТ ЖЕ шаг 1, что и human-сотрудники.

`deactivated_at` (migration 125) — колонка НА `employee`, физически общая для
`kind='human'` и `kind='agent'` строк (нет отдельной колонки на `agent_card`,
migration 032, — та таблица несёт `llm_endpoint`/`llm_model`/
`autonomy_threshold`/`budget_policy_id`/`escalation_rule_id`, НО никакого
enabled/disabled/deactivated поля).

Разведан **единственный write-путь**, ставящий `deactivated_at` в non-NULL —
`PATCH /api/users/:employee_id` (`user-mgmt.ts:489-556`). Он структурно
ограничен человеческими строками:

```ts
const found = await withTenantTx(pool, tenantId, async (client) => {
  const { rows } = await client.query<{ slug: string; kind: string }>(
    `SELECT slug, kind FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
    [tenantId, employeeId],
  );
  return rows[0] ?? null;
});
if (!found || found.kind !== "human") {
  throw new HttpError(404, "NOT_FOUND", "user account not found in your tenant");
}
```

(`user-mgmt.ts:515-524`). Нет НИКАКОГО другого места в кодовой базе,
записывающего `deactivated_at` (`grep -rn "SET deactivated_at" src/` находит
ровно эту одну строку). Значит для ЛЮБОЙ `kind='agent'` строки
`deactivated_at` **всегда** NULL в проде — предикат `AND deactivated_at IS
NULL` для агента **всегда истинен**, т.е. НИКОГДА не отфильтровывает
легитимного агента.

**Вывод**: единый безусловный предикат в шаге 1 (без явного ветвления по
`kind`) корректен и безопасен для ОБЕИХ веток субъекта ОДНОВРЕМЕННО — human
получает реальную защиту (дыра закрыта), agent получает предикат-но-оп
(колонка структурно недостижима для его ветки). Явное ветвление по `kind` в
SQL было бы ИЗБЫТОЧНЫМ усложнением без изменения семантики — а лишний
`CASE`/`OR kind='agent'` в security-предикате увеличивает площадь для будущей
ошибки (напр. кто-то решит "починить" branch и случайно ослабит гейт для
human). Простой единый `AND` — минимальная, наиболее fail-closed форма.

Если в будущем появится механизм агентской деактивации (напр.
`agent_card.deactivated_at` или подобное — сейчас такой колонки НЕТ), это
будет ОТДЕЛЬНЫЙ, новый предикат на `agent_card`, ортогональный этому фиксу —
не требует пересмотра текущего решения.

## 3. Риппл-анализ потребителей

> **ПОПРАВКА (CHANGES_REQUESTED, адверс-скептик REAL_HOLE severity HIGH).**
> Первая редакция этого раздела строила риппл ТОЛЬКО на
> `grep getGrantsForSubject src/` и заявляла «closes the gap for every
> consumer». Это заявление было **ЛОЖНЫМ для owner/admin-класса**. Владелец и
> админ тенанта авторизуются НЕ через `getGrantsForSubject`, а через ВТОРОЙ,
> ПАРАЛЛЕЛЬНЫЙ резолвер (`src/db/org.ts`: `isGenesisOwnerForTenant`,
> `loadAdminContext`), у которого свои инлайн-подзапросы slug→employee БЕЗ
> `deactivated_at IS NULL`. Owner-авторитет к тому же ЗАКОРАЧИВАЕТ грант-PDP
> (`capability-grants-dao.ts` owner-short-circuit `if (await
> isGenesisOwnerForTenant(...)) return true;` отрабатывает ДО
> `getGrantsForSubject`). Деактивация трогает только `deactivated_at`, а НЕ
> `role_assignment` tenant-owner → без гейта в org.ts деактивированный ВЛАДЕЛЕЦ
> (самый привилегированный субъект, ровно угроза «уволили, токен ещё жив») с
> живым токеном сохранял полную власть: seed-write сотрудников/оргструктуры
> (×11), LLM-ключи, системные агенты, mgmt_object-делегирование, SoD-админ.
> Раздел ниже перечисляет ОБА резолвера и подтверждает, что оба закрыты.

### 3.1. Резолвер А — грант-путь (`getGrantsForSubject`, шаг 1)

Полный список (`grep -rn getGrantsForSubject src/` — исключая тесты и
комментарии):

| потребитель | назначение | вердикт после фикса |
|---|---|---|
| `src/http/invoke.ts:290` (`loadCallerInvokeGrants`, T-0610) | caller invoke-гранты — авторизация запуска агент-эффекта | ПРАВИЛЬНО ужесточается: деактивированный caller не должен инициировать invoke |
| `src/http/records.ts` → `server.ts:835` (`resolveFieldVisibility`) | field-visibility редакция classified-полей записей | ПРАВИЛЬНО: деактивированный не должен видеть confidential/restricted поля |
| `src/http/records.ts` → `server.ts:853` (`resolveReadVisibility`, T-0570) | read-PDP на записях | ПРАВИЛЬНО: деактивированный не должен читать записи вообще |
| `src/http/org.ts:365` (capability-token check) | `/api/org` capability-проверка | ПРАВИЛЬНО: деактивированный теряет capability-права |
| `src/http/inbox.ts` (`resolveRolesForActor` → `getRoleSlugsForActor`, НЕ `getGrantsForSubject` напрямую, но тот же класс) | claim/approve роль-элигибилити | уже гейтится ЛОКАЛЬНО (T-0588 BLOCK-3/RE-VERIFY) — фикс делает локальный гейт ИЗБЫТОЧНЫМ, не конфликтующим (оба фейлят в одну сторону — deny) |
| `src/db/sandbox-gate-dao.ts:62` | authoring_draft sandbox гейт | ПРАВИЛЬНО: деактивированный конфигуратор теряет доступ к sandbox |
| `src/db/capability-grants-dao.ts:58,79` | LLM-connection capability-authz | ПРАВИЛЬНО |
| `src/db/registry-digest-dao.ts:189` | registry-digest доступ | ПРАВИЛЬНО |
| `src/db/role-grant-dao.ts` | НЕ вызывает `getGrantsForSubject` (комментарий "mirrors" — параллельная, но отдельная функция, читает гранты РОЛИ напрямую, не субъекта) | вне скоупа этого резолвера |

**Не найдено НИ ОДНОГО потребителя грант-пути, полагающегося на то, что
деактивированный субъект резолвится в НЕПУСТОЙ грант-набор** — ни
административного аудит-пути ("показать права уволенного"), ни отчётного пути.
Все найденные consumers — live PDP-решения authorize-or-deny в реальном
времени. Audit-трейл деактивации (`userMgmtAuditWriter.appendAuditEvent`,
`user-mgmt.ts:543-550`) пишет СОБСТВЕННЫЕ audit-события
(`user_account.deactivate`/`.reactivate`) в отдельный append-only журнал — НЕ
читает и не зависит от `getGrantsForSubject`, так что не затронут.

### 3.2. Резолвер B — owner/admin-путь (`org.ts`, ЗАКОРАЧИВАЕТ грант-PDP)

Этот резолвер `grep getGrantsForSubject` НЕ находит — он вызывается ОТДЕЛЬНО и
ПЕРЕД грант-путём (owner-short-circuit). Закрыт тем же fail-closed предикатом:

| функция / строки | что резолвит | кто вызывает (short-circuit) | вердикт после фикса |
|---|---|---|---|
| `src/db/org.ts` `isGenesisOwnerForTenant` (инлайн slug→employee подзапрос) | владелец ли субъект (tenant-owner role_assignment) | `capability-grants-dao.ts:57/78` (`canConfigureLlmConnection`/`canActorOperateSystemAgents` — `return true` ДО грантов), `seed-write.ts:153` (`isForestOwner`) | деактивированный владелец → FALSE (был TRUE); теряет LLM-config/system-agent/seed-write власть |
| `src/db/org.ts` `loadAdminContext` step 1 (owner-check подзапрос) | владелец ли (тот же tenant-owner) | `seed-write.ts` ×11, `report-page-render.ts:175`, `llm-config.ts:124/244/354`, `rights-sod-admin.ts:159`, `pdp-explain.ts:367` — все гейтят на `admin.isGenesisOwner` | деактивированный → `isGenesisOwner=false` |
| `src/db/org.ts` `loadAdminContext` step 2 (assignment-load подзапрос) | делегируемые `mgmt_object:*` гранты админа | те же ×11 seed-write mgmt-пути (`validateAdminDelegation`) | деактивированный админ → `adminGrants=[]` (теряет делегированную mgmt-власть) |

Обоснование выбора места: ВСЕ owner/admin-гейты в системе (`seed-write.ts` ×11,
`llm-config.ts`, `report-page-render.ts`, `rights-sod-admin.ts`,
`pdp-explain.ts`, `capability-grants-dao.ts`) сходятся ровно на эти две функции
(`isGenesisOwnerForTenant` / `loadAdminContext`) — закрытие ДВУХ функций (трёх
подзапросов) закрывает всю owner/admin-поверхность у ИСТОЧНИКА, без правки
десятка колл-сайтов. Проверено `grep -rn "isGenesisOwnerForTenant\|loadAdminContext"`.

### 3.3. Резолвер C — report-page delegated-reader (`report-page-render.ts`)

`report-page-render.ts::defaultCheckReadGrant` step 2 (не-owner ветка) имел
СВОЙ инлайн slug→employee + прямой `application`/`read` грант-JOIN (НЕ через
`getGrantsForSubject`). Деактивированный не-владелец с `application:read`
грантом мог рендерить отчёт-страницы в окне жизни токена. Закрыт тем же
`AND deactivated_at IS NULL` в подзапросе (step 1 owner-ветки уже закрыт через
`loadAdminContext` из §3.2).

### 3.4. Что проверено и НЕ является authority-резолвером (гейт НЕ добавлен намеренно)

Прочёсан весь `grep "FROM choros.employee"`/`"SELECT id FROM choros.employee"`
по `src/`. Остальные инлайн slug→employee подзапросы — НЕ authority-грантующие,
гейт им не нужен (а некоторым ВРЕДЕН — fail-OPEN для ограничений):

- `src/db/sod-dao.ts:395` (`PgSodSource`) — SoD это ОГРАНИЧЕНИЕ (separation of
  duties), не грант. Гейт тут вычел бы назначения деактивированного →
  «нет SoD-нарушения» = fail-OPEN для ограничения. НЕ трогаем (к тому же его
  гранты уже пусты через резолвер А).
- `src/db/substitution-dao.ts:203/291` — деактивированный substitute уже
  исключён на уровне `SUBST_SELECT` JOIN (`e_sub.deactivated_at IS NULL`,
  T-0588 BLOCK-2, строка 179); step-1 подзапрос — только slug→id.
- `src/http/rights-sod.ts:273` — SoD-нарушение-репорт (то же, что sod-dao).
- `src/http/rights-overview.ts:211` (`resolveCallerEmployeeId`) — резолвит
  СВОЙ id для ДИСПЛЕЯ прав; authority-решение (`canManage`, строка 450) идёт
  через `loadAdminContext` (уже закрыт §3.2).
- `src/http/pdp-explain.ts:119` — ДИАГНОСТИЧЕСКИЙ explain-эндпоинт; его
  собственная authz — `loadAdminContext` (закрыт) + self-query. Трасса грантов
  субъекта — explain-фиделити, не live-авторизация. Отмечено в §9 как
  follow-up на фиделити (сейчас explain деактивированного может показать
  гранты, которые real-PDP уже не чтит — расхождение диагностики, НЕ дыра).
- `src/http/assistant.ts:1290` (avoid self-notify), `:1783` (agent budget —
  агент, не деактивируется), `src/http/grants.ts:1468` (резолв по `id` —
  write-target existence, НЕ actor-authority), `org.ts:156/257/317`
  (display-списки), `org.ts:534` `humanEmployeeSlugExists` (identity-mapping
  для sub→slug auth-резолюции, не грант) — все не-authority.

> **ПОПРАВКА ТРИАЖА (round 3).** Первая редакция §3.4 ошибочно свалила
> `rights-intents.ts` в кучу «резолв по id / write-target existence». Это
> НЕВЕРНО для одного из его хендлеров: `POST /api/rights/intents/self-absence`
> резолвит АКТОРА (не write-target) собственным инлайн `slug→employee`
> подзапросом и на Tier-2 ветке МЯТИТ грант — это authority-путь. Он вынесен в
> §3.5 (резолвер D) как ЗАКРЫТАЯ дыра. Остальные 4 хендлера файла
> (hire/fire/substitute/urgent-revoke) идут через `loadAdminContext` (закрыт
> §3.2) — они действительно не-authority-по-своему-резолву.

### 3.5. Резолвер D — self-absence actor-резолв + Tier-2 mint (`rights-intents.ts`)

`POST /api/rights/intents/self-absence` (`rights-intents.ts:1155-1380`) —
ЕДИНСТВЕННЫЙ authority-ПИШУЩИЙ хендлер в файле, который НЕ идёт через
`loadAdminContext`. Сравнение: hire (:357), fire (:578), substitute (:756),
urgent-revoke (:979) — ВСЕ гейтят через `loadAdminContext` (закрыты §3.2). А
self-absence резолвит актора прямым `SELECT id FROM choros.employee ... slug=$2`
(строка ~1199) БЕЗ `deactivated_at` и гейтит role-holding прямым
`role_assignment`-запросом (~1264) без предиката.

Эксплойт: деактивированный актор (токен жив, `role_assignment` НЕ отозван)
объявляет self-absence → Tier-2 ветка (~1295) делает INSERT в `choros."grant"`
делегированного гранта СООБЩНИКУ (`substitute_employee_id`). Сообщник —
ЖИВОЙ субъект, поэтому `getGrantsForSubject` (резолвер A) отдаёт ему этот грант:
резолвер A НЕ ловит, т.к. эксплуатируемый субъект (сообщник) НЕ деактивирован —
деактивирован ПИШУЩИЙ. Тот же класс, что T-0588 латал локально в inbox.

ФИКС: `AND deactivated_at IS NULL` в actor-резолв подзапросе (строка 1199).
Fail-closed: деактивированный актор резолвится в ноль строк → 404, mint не
достигается. Проверено: остальные 4 хендлера файла закрыты через
`loadAdminContext`; строка 445 (`SELECT kind ... id=$2` в hire) — резолв
KIND write-ТАРГЕТА (нанимаемого), не актора, и hire уже гейтован
`loadAdminContext` — не authority-по-своему-резолву. Мутационно доказано:
без предиката тот же запрос доходит до mint (`tier:"tier2"`, `ttl_grant_id`
выдан) — 404 превращается в 200 с реальным грантом сообщнику.

### 3.6. Побочный OVER_BLOCK, вводимый §3.2 — self-lockout последнего владельца

Фикс §3.2 (деактивированный владелец → `isGenesisOwner=false`) вводит НОВЫЙ
дефект: реактивация идёт через `PATCH /api/users` (`user-mgmt.ts`), чей
собственный authz-гейт — `loadAdminContext` (теперь с `deactivated_at`). Если
деактивирован ПОСЛЕДНИЙ активный tenant-owner, реактивировать некому (сам он уже
`isGenesisOwner=false`, другого владельца нет) → тенант кирпич.

ФИКС (round 3): в `PATCH /api/users` (путь `active:false`) — pre-check «нельзя
деактивировать ПОСЛЕДНЕГО активного tenant-owner»: считаем ДРУГИХ активных
владельцев (confirmed, in-window `role_assignment` на `role.slug='tenant-owner'`,
`employee.deactivated_at IS NULL`, EXCLUDING цель); если целевой — владелец И
других активных владельцев ноль → 409 `LAST_OWNER` («нельзя деактивировать
единственного владельца тенанта»). Fail-CLOSED против НЕОБРАТИМОГО действия
(проверка ДО любой KC/DB-мутации). Реактивация (`active:true`) не затронута.
Мутационно доказано: без гейта деактивация единственного владельца → 200
(кирпич).

### 3.7. Систематизация — вынесено в T-0662

Пять authority-резолверов (A грант-путь, B owner/admin, C report-page, D
self-absence) закрыты ТОЧЕЧНО одним и тем же предикатом. То, что их пять —
симптом отсутствия ЕДИНОГО identity/деактивации-слоя: каждый новый
authority-путь обязан помнить про `deactivated_at`. Проектирование
анти-рецидивного механизма (identity-слой-гейт ИЛИ фитнес-гейт, статически
ловящий любой новый `slug→employee` authority-резолв без предиката) вынесено в
ОТДЕЛЬНУЮ задачу **T-0662** (архитектор). Этот таск (T-0658) — ТОЧЕЧНОЕ
закрытие пяти конкретных дыр + честный триаж, НЕ общий рефактор.

**Вывод: БЕЗОПАСНО.** Пять live authority-путей — грант-путь (A), owner/admin (B),
report-page delegated-reader (C), self-absence actor+mint (D) — закрыты одним и
тем же fail-closed предикатом; §3.6 закрывает побочный self-lockout. Фикс —
чистое СУЖЕНИЕ (может только запретить то, что было ошибочно разрешено; никогда
не разрешает то, что было запрещено), плюс last-owner guard (§3.6), не дающий
СУЖЕНИЮ сделать тенант необратимо-заблокированным.

## 4. Существующие тесты — влияние

`grep -rn deactivated ci/checks src/__tests__` (до фикса) не находит ни
одного теста, ожидающего, что `getGrantsForSubject` резолвит деактивированного
subject в непустой набор (баг-как-фича отсутствует — не пришлось
"переосмысливать" ни один существующий тест).

Существующий `ci/checks/db/grants-dao-deactivated.db.test.ts` (T-0588)
покрывает `getHoldersForRole`/`findTenantOwnerSlug`/
`getActiveSubstitutionsForSubstitute` — явно НЕ `getGrantsForSubject` (тот файл
был написан ДО этого фикса, закрывая ролевой-holder путь, но не грант-резолвер
— именно тот пробел, который закрывает T-0658). Ни один тест не требовал
правки/перекраски: полный прогон `npx vitest run` до и после фикса даёт
одинаковое число ПРОШЕДШИХ тестов (новые db-тесты — additive, не замена).

## 5. Object model / contracts

Без миграции — колонка `deactivated_at` уже существует (migration 125),
меняются только READ-предикаты authority-резолверов + добавляется last-owner
guard (тоже без миграции — читает существующие строки).

- `src/db/grants-dao.ts` — резолвер А: `getGrantsForSubject` шаг 1: добавлен
  `AND deactivated_at IS NULL` + расширенный комментарий (см. §2.1/§2.2).
  Остальное тело функции (шаги 2-3) не тронуто.
- `src/db/org.ts` — резолвер B (owner/admin): `AND deactivated_at IS NULL` в
  ТРЁХ инлайн slug→employee подзапросах: `isGenesisOwnerForTenant`,
  `loadAdminContext` step 1 (owner-check), `loadAdminContext` step 2
  (assignment-load) + расширенные комментарии над обеими функциями (см. §3.2).
- `src/http/report-page-render.ts` — резолвер C: `AND deactivated_at IS NULL`
  в инлайн slug→employee подзапросе не-owner ветки `defaultCheckReadGrant`
  (owner-ветка step 1 закрыта через `loadAdminContext`; см. §3.3).
- `src/http/rights-intents.ts` — резолвер D (round 3): `AND deactivated_at IS
  NULL` в actor-резолв подзапросе `POST /api/rights/intents/self-absence`
  (строка ~1199) + расширенный комментарий (см. §3.5).
- `src/http/user-mgmt.ts` — LAST-OWNER GUARD (round 3): в `PATCH /api/users`
  путь `active:false` — pre-check перед любой KC/DB-мутацией, считающий других
  активных tenant-owner; если цель — последний → 409 `LAST_OWNER` (см. §3.6).
- Новый db-тест: `ci/checks/db/grants-dao-subject-deactivation.db.test.ts`
  (резолвер А) — живой Postgres, AC-2/AC-3/AC-4.
- Новый db-тест: `ci/checks/db/org-admin-deactivation.db.test.ts` (резолвер B)
  — деактивированный владелец → `isGenesisOwnerForTenant`=false и
  `loadAdminContext.isGenesisOwner`=false; деактивированный админ →
  `adminGrants=[]`; активные владелец/админ → сохраняют власть. Мутационно
  проверено.
- Расширены (round 3, additive — новые describe-блоки, существующие тесты не
  тронуты):
  - `ci/checks/db/rights-intents.db.test.ts` (резолвер D) — позитив-контроль:
    активный актор → self-absence Tier-2 грант СОЗДАЁТСЯ (200); деактивированный
    → 404 и грант НЕ создаётся. Мутационно: без предиката тот же запрос доходит
    до mint (`tier:"tier2"`, `ttl_grant_id` выдан) — 404→200 с реальным грантом.
  - `ci/checks/db/user-mgmt.db.test.ts` (last-owner guard) — деактивация
    единственного владельца → 409 `LAST_OWNER` (KC не тронут, владелец активен);
    с вторым владельцем — деактивация одного разрешена, оставшийся последний
    защищён. Мутационно: без гейта деактивация единственного владельца → 200.
- Все новые/расширенные db-тесты — `uuid()`-суффиксные фикстуры, без
  кейс-литералов (кроме структурного slug `'tenant-owner'` — имя корня решётки,
  migration 026, не бизнес-литерал).

## 6. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| FF-658-DEACTIVATION-GATE (резолвер А) | деактивированный сотрудник с валидным (confirmed + in-window + dual-confirmed, если критичный) грантом → `getGrantsForSubject` возвращает `[]`. Живой PG. | `npm run fitness:db` (`grants-dao-subject-deactivation.db.test.ts`) |
| FF-658-ACTIVE-REGRESSION (резолвер А) | активный сотрудник с тем же самым грантом → грант присутствует (happy-path не сломан). Живой PG. | `npm run fitness:db` (тот же db-тест) |
| FF-658-AGENT-UNAFFECTED (резолвер А) | `kind='agent'` сотрудник (без `deactivated_at`, как и все agent-строки в проде) резолвится не затронутым гейтом деактивации — его гранты присутствуют как прежде. Живой PG. | `npm run fitness:db` (тот же db-тест) |
| FF-658-OWNER-GATE (резолвер B) | деактивированный tenant-owner → `isGenesisOwnerForTenant`=false И `loadAdminContext.isGenesisOwner`=false (теряет owner-short-circuit во всех ×11 seed-write / LLM-config / system-agent / report-page путях). Живой PG, мутационно проверен. | `npm run fitness:db` (`org-admin-deactivation.db.test.ts`) |
| FF-658-ADMIN-GATE (резолвер B) | деактивированный админ (делегируемый `mgmt_object:*` грант, не владелец) → `loadAdminContext.adminGrants=[]`. Живой PG. | `npm run fitness:db` (тот же db-тест) |
| FF-658-OWNER-ADMIN-REGRESSION (резолвер B) | активный владелец → `isGenesisOwner=true`; активный админ → сохраняет делегируемый `mgmt_object` грант (happy-path не сломан). Живой PG. | `npm run fitness:db` (тот же db-тест) |
| FF-658-SELFABS-GATE (резолвер D, round 3) | деактивированный актор → self-absence 404 и Tier-2 грант НЕ создаётся; активный актор → грант СОЗДАЁТСЯ (позитив-контроль). Живой PG, мутационно проверен (без предиката mint фактически происходит). | `npm run fitness:db` (`rights-intents.db.test.ts`) |
| FF-658-LAST-OWNER-GUARD (round 3) | деактивация ЕДИНСТВЕННОГО активного tenant-owner → 409 `LAST_OWNER` (KC не тронут, владелец остаётся активен); при наличии второго активного владельца деактивация одного разрешена. Живой PG, мутационно проверен (без гейта → 200, тенант-кирпич). | `npm run fitness:db` (`user-mgmt.db.test.ts`) |
| FF-658-REGRESSION | существующие unit/db-тесты (`src/__tests__/grants-dao.test.ts`, `ci/checks/db/invoke-grant-resolver.db.test.ts`, `ci/checks/db/grants-dao-deactivated.db.test.ts` и весь остальной набор, включая нетронутые тесты в расширенных файлах) проходят без перекраски. | `npx vitest run` + `npm run fitness:db` |
| grant-resolver-isolation (inherited, unchanged) | `src/core/grant-resolver.ts` не тронут этим таском вовсе. | `ci/checks/grant-resolver-isolation.sh` |
| dual-control-isolation (inherited, unchanged) | шаг 3 (`criticalGrantPredicate`, `confirmed2_by`) не тронут — additive `AND` в шаге 1 ортогонален дуал-контрольному домену. | `ci/checks/dual-control-isolation.sh` |
| single-resolver (inherited, unchanged) | `src/core/object-handle.ts` не тронут — фикс живёт целиком в `grants-dao.ts`. | `ci/checks/single-resolver.sh` |

## 7. Rejected alternatives

| option | why not |
|--------|---------|
| Оставить гейт только в `inbox.ts` (per-path), как сейчас, и просто задокументировать риск | Не закрывает дыру для `invoke.ts`/`records.ts`/`org.ts`/`sandbox-gate-dao.ts`/`capability-grants-dao.ts`/`registry-digest-dao.ts` — ровно та асимметрия, которую задача просит устранить. Отклонено. |
| Явное ветвление `CASE WHEN kind='agent' THEN true ELSE deactivated_at IS NULL END` в SQL | Избыточно: `deactivated_at` структурно недостижим (всегда NULL) для agent-строк уже сегодня (единственный writer — `user-mgmt.ts`, human-only). Явная ветка не меняет поведение, но добавляет площадь для будущей ошибки (кто-то "упростит" ветку и случайно ослабит human-гейт). Простой безусловный `AND` — минимальный, наиболее fail-closed вариант. Отклонено. |
| Гейтить деактивацию в `withTenantReadTx`/на уровне пула (глобальный middleware) вместо конкретного запроса шага 1 | `withTenantReadTx` — общая инфраструктура (используется КАЖДОЙ функцией файла, включая `getFieldVisibilityPolicy`, не завязанной на employee вообще) — не тот уровень для employee-специфичного предиката. Шаг 1 — единственное место, где subject slug резолвится в employee id; там и должен жить гейт. Отклонено. |
| Удалить `inbox.ts` локальные T-0588 гейты (BLOCK-3/RE-VERIFY) сразу в этом таске, раз резолвер теперь сам fail-closed | Defence-in-depth: два независимых слоя защиты (резолвер + локальный гейт) безопаснее одного, стоимость почти нулевая (уже написан и протестирован код). Удаление — отдельный follow-up по явному запросу на упрощение, не требуется для закрытия дыры T-0658. Отклонено (см. спека §7 вне рамок). |

## 8. Traceability

| AC (spec) | covered by |
|-----------|-----------|
| AC-1 (единый предикат, без ветвления по kind) | §2.1/§2.2 + код `grants-dao.ts` |
| AC-2 (деактивированный + валидный грант → []) | новый db-тест `grants-dao-subject-deactivation.db.test.ts`, describe "AC-2" |
| AC-3 (активный + тот же грант → грант есть) | тот же файл, describe "AC-3" (позитив-контроль) |
| AC-4 (агент не задет) | тот же файл, describe "AC-4" |
| AC-5 (риппл документирован, все резолверы) | §3.1 (грант) + §3.2 (owner/admin) + §3.3 (report-page) + §3.4 (не-authority триаж) + §3.5 (self-absence) + §3.6 (last-owner guard) + §3.7 (T-0662) |
| AC-owner/AC-admin (owner/admin-путь закрыт, мутационно проверен) | §3.2 + `org-admin-deactivation.db.test.ts` |
| AC-selfabs (self-absence закрыт, мутационно проверен) | §3.5 + `rights-intents.db.test.ts` (round 3) |
| AC-last-owner (self-lockout предотвращён, мутационно проверен) | §3.6 + `user-mgmt.db.test.ts` (round 3) |
| AC-6 (существующие тесты без перекраски) | §4 этого ADR + прогон `npx vitest run` |
| AC-7 (tsc/eslint/vitest зелёные) | стандартный гейт |
| AC-8 (fitness:db зелёный вкл. новые тесты) | §5/§6 |
| AC-9 (изоляционные гейты зелёные) | §6 inherited rows |

## 9. Risks / compatibility

- **Поведенческое УЖЕСТОЧЕНИЕ, не ослабление**: единственные строки, чей
  PDP-статус меняется — деактивированные сотрудники, чьи гранты раньше
  ошибочно резолвились. Ни одна легитимная (активная) строка не теряет
  доступ.
- **KC-токен всё ещё жив до TTL** — этот фикс закрывает ТОЛЬКО резолюцию
  прав внутри системы Choros (PDP), НЕ отзывает сам KC access-токен. В окне
  между деактивацией и истечением TTL держатель токена по-прежнему может
  пройти AUTHENTICATION (токен подписан и не просрочен) — но AUTHORIZATION
  (любой PDP-путь через `getGrantsForSubject`) теперь корректно отдаёт `[]`.
  Отзыв самого KC-токена (session revocation API) — отдельная, более крупная
  задача вне рамок T-0658 (спека §7).
- **Пять точечных фиксов, не общий механизм (round 3)** — закрыты пять
  конкретных authority-путей (A/B/C/D + last-owner guard). Тот факт, что их
  оказалось пять, — симптом отсутствия единого identity/деактивации-слоя;
  проектирование анти-рецидивного механизма (identity-слой-гейт ИЛИ статический
  фитнес-гейт, ловящий любой новый `slug→employee` authority-резолв без
  предиката) вынесено в **T-0662**. Этот таск НЕ строит общий механизм.
- **last-owner guard — узкий, не общий invariant** — гейт срабатывает ТОЛЬКО
  на деактивацию (`active:false`) последнего активного tenant-owner; реактивация
  и деактивация не-владельцев/не-последних владельцев не затронуты. Это защита
  от НЕОБРАТИМОСТИ, введённой §3.2, а не общая политика владения.
- **`inbox.ts` локальные гейты (T-0588) остаются** — избыточны, но не
  конфликтуют (оба фейлят в одну сторону). Не удаляются в этом таске.
- **`pdp-explain.ts` фиделити (follow-up, НЕ дыра)** — диагностический
  explain-эндпоинт (`src/http/pdp-explain.ts:119`) грузит гранты субъекта своим
  локальным grant-source без deactivation-гейта. Его СОБСТВЕННАЯ authz
  (`loadAdminContext`, §3.2) закрыта, так что деактивированный не может вызвать
  explain о чужом субъекте. Но при self-query explain деактивированного может
  показать гранты, которые real-PDP (резолвер А) уже НЕ чтит — расхождение
  ДИАГНОСТИКИ, а не выдача прав. Выравнивание explain-фиделити с real-PDP —
  отдельный follow-up (нужно, чтобы explain не «врал», но это не security-дыра,
  т.к. explain ничего не авторизует — только объясняет).
- **Нет миграции** — колонка уже существует и применяется к уже существующим
  строкам; меняется только то, какой SQL её читает.
