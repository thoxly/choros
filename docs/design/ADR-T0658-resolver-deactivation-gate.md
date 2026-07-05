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

**Не найдено НИ ОДНОГО потребителя, полагающегося на то, что деактивированный
субъект резолвится в НЕПУСТОЙ грант-набор** — ни административного
аудит-пути ("показать права уволенного"), ни отчётного пути. Все найденные
consumers — live PDP-решения authorize-or-deny в реальном времени. Audit-трейл
деактивации (`userMgmtAuditWriter.appendAuditEvent`, `user-mgmt.ts:543-550`)
пишет СОБСТВЕННЫЕ audit-события (`user_account.deactivate`/`.reactivate`) в
отдельный append-only журнал — НЕ читает и не зависит от `getGrantsForSubject`,
так что не затронут.

**Вывод: БЕЗОПАСНО.** Фикс — чистое СУЖЕНИЕ (может только запретить то, что
было ошибочно разрешено; никогда не разрешает то, что было запрещено).

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
меняется только READ-предикат одной функции.

- `src/db/grants-dao.ts` — `getGrantsForSubject` шаг 1: добавлен
  `AND deactivated_at IS NULL` + расширенный комментарий (см. §2.1/§2.2).
  Остальное тело функции (шаги 2-3) не тронуто.
- Новый db-тест: `ci/checks/db/grants-dao-subject-deactivation.db.test.ts` —
  живой Postgres, доказывает AC-2/AC-3/AC-4 (см. спеку §5), мирроря стиль
  `invoke-grant-resolver.db.test.ts` (T-0610) и
  `grants-dao-deactivated.db.test.ts` (T-0588): свежий per-suite tenant,
  `uuid()`-суффиксные фикстуры, без кейс-литералов.

## 6. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| FF-658-DEACTIVATION-GATE | деактивированный сотрудник с валидным (confirmed + in-window + dual-confirmed, если критичный) грантом → `getGrantsForSubject` возвращает `[]`. Живой PG. | `npm run fitness:db` (новый db-тест) |
| FF-658-ACTIVE-REGRESSION | активный сотрудник с тем же самым грантом → грант присутствует (happy-path не сломан). Живой PG. | `npm run fitness:db` (тот же новый db-тест) |
| FF-658-AGENT-UNAFFECTED | `kind='agent'` сотрудник (без `deactivated_at`, как и все agent-строки в проде) резолвится не затронутым гейтом деактивации — его гранты присутствуют как прежде. Живой PG. | `npm run fitness:db` (тот же новый db-тест) |
| FF-658-REGRESSION | существующие unit/db-тесты (`src/__tests__/grants-dao.test.ts`, `ci/checks/db/invoke-grant-resolver.db.test.ts`, `ci/checks/db/grants-dao-deactivated.db.test.ts` и весь остальной набор) проходят без перекраски. | `npx vitest run` + `npm run fitness:db` |
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
| AC-5 (риппл документирован) | §3 этого ADR |
| AC-6 (существующие тесты без перекраски) | §4 этого ADR + прогон `npx vitest run` |
| AC-7 (tsc/eslint/vitest зелёные) | стандартный гейт |
| AC-8 (fitness:db зелёный вкл. новый тест) | §5/§6 |
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
- **`inbox.ts` локальные гейты (T-0588) остаются** — избыточны, но не
  конфликтуют (оба фейлят в одну сторону). Не удаляются в этом таске.
- **Нет миграции** — колонка уже существует и применяется к уже существующим
  строкам; меняется только то, какой SQL их читает.
