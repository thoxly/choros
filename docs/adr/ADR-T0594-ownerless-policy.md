# ADR-T0594 — Политика для тенантов без владельца (R-2 миграции 118)

**Status:** ready
**Phase:** DESIGN
**Task:** T-0594 [W2/edge]
**Date:** 2026-07-02
**Спека:** `docs/specs/T-0594-ownerless-policy.spec.md` + `docs/specs/T-0594.spec.contract.json` (AC-1..AC-6)
**База:** dev @ `962f9d4` (ветка `task/T-0594-ownerless-policy`, следующая свободная миграция — **120**)
**Предшественники:** T-0573 (migration 118, ADR-T0573 §2.1 — уже смержено, файл НЕ редактируется), review R-2 (`docs/review/T-0573.review.json`), adversarial-щуп тестера T-0573 (`docs/test/T-0573.test-report.json`).

---

## 1. Контекст

Finding R-2 (info, не блокировал T-0573, вынесен ревьюером в отдельную задачу): тенант БЕЗ
единого владельца (ни одного confirmed `role_assignment` на `role(slug='tenant-owner')`) —
после прогона migration 118 блок A4 (владелец→role-configurator) корректно НЕ создаёт строку
(LATERAL-джойн на пустом множестве владельцев → 0 строк, не падает, не изобретает фиктивного
владельца). Но блоки A5 (assistant-agent→role-configurator), A6/A7 (4 гранта) вооружают
role-configurator БЕЗУСЛОВНО — их предикаты зависят только от `role-configurator` (A1) и
`employee assistant-agent` (A2), оба созданы для ЛЮБОГО тенанта блоками A1/A2, которые владельца
не спрашивают. Итог: role-configurator получает 4 confirmed-гранта + назначение АГЕНТА, но ни
один ЧЕЛОВЕК не может унаследовать эту роль.

Adversarial-щуп тестера T-0573 независимо воспроизвёл ровно это на смешанной трёхтенантной
фикстуре (T_FULL/T_PARTIAL/T_OWNERLESS) и подтвердил: не эскалация (агент не проходит HTTP auth
как человек — чат ассистента идёт под identity владельца, ADR-T0573 §1), не падает, не
осциллирует при повторном прогоне, собственный AC-1-предикат честно продолжает флагать такой
тенант.

**Откуда берётся ownerless-тенант.** Разведано в коде `src/core/register.ts`: `registerTenant`
вставляет `role(tenant-owner)` + `employee` + **confirmed** `role_assignment` владельца
ПЕРВЫМИ шагами (3b-3d) той же DB-транзакции — ДО tenant-zero блока (3e-3j-bis). Продукт **не
может** через живой путь создать тенант без владельца. Единственный источник такого состояния —
данные-сироты тестовых/приёмочных фикстур (например `seedTenant()` в
`migration-118-tenant-zero-backfill.test.ts` ВСЕГДА создаёт владельца — реальный ownerless-кейс
не порождается ни одним живым путём кода, только ручным сидом мимо `registerTenant`).

## 2. Решение

**(а) Skip-политика.** Ownerless-тенант остаётся полностью нетронутым и флагуемым
(role/employee/agent_card НЕ удаляются — безвредный субстрат), но вооружённый контур,
недостижимый для человека (role_assignment assistant-agent→role-configurator + 4 grant),
УДАЛЯЕТСЯ. Механизм: **новая миграция `migrations/120_ownerless_tenant_zero_unarm.sql`**
(файл 118 НЕ редактируется — уже применён на стенде и в CI-шаблонах, идемпотентный повтор не
случится). 120 — set-driven, идемпотентная, DELETE-only миграция: для каждого тенанта БЕЗ
confirmed `role_assignment` на `role(slug='tenant-owner')` удаляет ровно backfill-маркированные
(`source='backfill'` / `confirmed_by='backfill'`) строки `role_assignment` (assistant-agent→
role-configurator) и `"grant"` (4 строки на role-configurator).

**Почему (а), не (б)/(в) — аргументация по критериям задания:**

| Критерий | (а) skip A5-A7 | (б) как есть + докс | (в) вооружаем + маркер аномалии |
|---|---|---|---|
| Гигиена прав (висячие гранты) | Нет висячих грантов — контур неактивен, пока нет владельца | 4 гранта + назначение агента висят НЕОПРЕДЕЛЁННО долго, некому употребить | Гранты всё ещё висят, маркер лишь ОПИСЫВАЕТ проблему, не решает |
| Идемпотентность | Да — DELETE-предикат стабилен на повторном прогоне (нечего удалять второй раз) | Да (существующее свойство 118) | Требует НОВОЙ колонки/поля-маркера — новая DDL-поверхность ради информационной пометки |
| Владелец появится позже | Роль/агент/agent_card ЦЕЛЫ (F3) — оператор, чинящий ownerless-тенант вручную, довооружает role_assignment+grant тем же паттерном, что 118, БЕЗ пересоздания субстрата | Ничего не меняется — контур уже вооружён «на всякий случай», случайно достижим, если человек когда-либо получит эту роль по ошибке конфигурации | Маркер остаётся висеть даже после появления владельца, если его никто не снимет — лишняя уборка |
| Откуда ownerless берётся | Только тестовые/ручные сироты — гигиена издержек не платит живой путь | То же (наблюдение общее для всех вариантов) | То же |
| Соразмерность (новая DDL) | Нет новых колонок — чистый DELETE над существующими таблицами | Ноль изменений кода (только докс) — минимальна, но оставляет дыру гигиены | Требует новую колонку/таблицу для маркера — непропорционально задаче R-2 (info-уровня) |

Ключевой довод: **живой путь никогда не производит ownerless-тенант** (`registerTenant`
гарантирует владельца первым шагом транзакции), поэтому «(б) ждём владельца» ждёт то, что
никогда не наступит через штатный путь — единственный реалистичный сценарий появления
владельца у уже-ownerless тенанта — ручное операторское вмешательство (кто-то руками чинит
данные-сироту), и именно этот оператор в состоянии одним движением довооружить контур (взять
пример insert-предикатов A5/A6/A7 миграции 118 и применить их точечно к этому тенанту — role/
employee/agent_card НЕ тронуты, их не нужно пересоздавать). Оставлять контур вооружённым «на
всякий случай» до тех пор — чистый риск без пользы: агент не может быть аутентифицирован как
человек, но случайное будущее изменение системы (например если когда-то appear auth service
account для агента, ADR-T0573 §1 явно исключает это на сегодня, но не навечно) превратило бы
эту недостижимость в реальную дыру, УЖЕ СИДЯЩУЮ в БД без причины.

**Что если владелец появится позже (после 120).** Миграции одноразовые (schema_migrations
трекает по имени файла) — повторный прогон 118 ИЛИ 120 не произойдёт автоматически. Появление
владельца у бывшего ownerless-тенанта (ручной сид/операторская правка) не запускает никакого
авто-довооружения контура — это ОСОЗНАННО out-of-scope (SPEC §5 O2): оператор, который чинит
такую аномалию вручную (единственный реалистичный путь появления владельца там, где живой код
никогда не оставляет тенант без него), сам сознательно довооружает контур тем же паттерном
INSERT, что 118 A5/A6/A7 — не нуждается в автоматизации для события, которое НЕ происходит
штатно ни разу.

## 3. Отклонённые альтернативы

1. **(б) текущее поведение + докс.** Отклонено: оставляет 4 confirmed-гранта + назначение
   агента висящими на роли, которую ни один человек не может унаследовать, НЕОПРЕДЕЛЁННО
   долго — чистый риск без функциональной пользы (агент не является auth-субъектом сегодня, но
   права остаются в БД как потенциальная дыра при будущих изменениях модели идентичности
   агента). Документация одна не убирает висячие гранты.
2. **(в) вооружаем + маркер аномалии.** Отклонено: требует новую колонку/поле для маркера —
   непропорциональная DDL-поверхность для info-уровня находки (R-2 не блокировал T-0573);
   маркер САМ ПО СЕБЕ не решает гигиену — гранты всё ещё висят, только теперь описаны. Не
   вносит нового наблюдаемого поведения, которое AC-1-предикат миграции 118 (без изменений)
   уже не даёт: он и так честно флагует ownerless-тенант.
3. **Правка файла `migrations/118_*.sql` на месте (добавить WHERE-условие на владельца в A5/A6/A7).**
   Отклонено директивой задания: 118 уже применена на стенде и в CI-шаблонах — правка тела
   применённой миграции невоспроизводима на средах, где 118 уже прошла (тот же аргумент, что
   ADR-T0573 приводил против правки 115 на месте).
4. **Удалить role/employee/agent_card ownerless-тенанта вместе с role_assignment/grant.**
   Отклонено (SPEC F3/O4): это не вооружённый контур сам по себе — роль без назначений и агент
   без роли ничего не открывают; удаление лишает будущего оператора, чинящего аномалию вручную,
   готового субстрата (пришлось бы пересоздавать role/employee/agent_card с нуля вместо точечного
   довооружения role_assignment+grant).
5. **Полностью пропустить (skip) ВЕСЬ тенант в новой миграции, включая уже вставленные 118-строки
   независимо от владельца.** Формулировка задания предлагала как один из вариантов «(а) skip-
   тенант целиком... не трогаем вовсе». Уточнено при разборе кода: 118 УЖЕ применена
   (безусловно для всех тенантов, включая ownerless) — «не трогать вовсе» относится к БУДУЩЕМУ
   прогону 118, которого не будет (одноразовая миграция). Для УЖЕ существующих последствий 118
   на ownerless-тенантах единственный реализуемый механизм — новая миграция, которая ТОЧЕЧНО
   отменяет A5/A6/A7-результат (а не «весь тенант»), т.к. A1/A2/A3 (role/employee/agent_card)
   безвредны и их отмена не incrementally улучшает гигиену прав, только теряет субстрат (см.
   альтернативу 4 выше — тот же аргумент).

## 4. Механизм миграции 120

`migrations/120_ownerless_tenant_zero_unarm.sql` — set-driven, без литерала UUID тенанта, два
DELETE-блока (роль_assignment + grant), каждый с точным маркер-предикатом
(`source='backfill'`/`confirmed_by='backfill'` — тот же маркер, что 118 проставляет) И
`NOT EXISTS` на confirmed owner role_assignment:

```sql
-- B1. role_assignment: assistant-agent -> role-configurator, backfill-marked,
--     for tenants with NO confirmed tenant-owner role_assignment.
DELETE FROM choros.role_assignment ra
 USING choros.role cfg_role, choros.employee agent
 WHERE ra.tenant_id = cfg_role.tenant_id
   AND ra.role_id = cfg_role.id
   AND cfg_role.slug = 'role-configurator'
   AND ra.employee_id = agent.id
   AND agent.tenant_id = ra.tenant_id
   AND agent.slug = 'assistant-agent' AND agent.kind = 'agent'
   AND ra.source = 'backfill'
   AND NOT EXISTS (
     SELECT 1 FROM choros.role_assignment owner_ra
       JOIN choros.role owner_role
         ON owner_role.tenant_id = owner_ra.tenant_id AND owner_role.id = owner_ra.role_id
      WHERE owner_ra.tenant_id = ra.tenant_id
        AND owner_role.slug = 'tenant-owner'
        AND owner_ra.confirmed_by IS NOT NULL
   );

-- B2. grant: 4 backfill-marked grants on role-configurator, same NOT EXISTS guard.
DELETE FROM choros."grant" g
 USING choros.role cfg_role
 WHERE g.tenant_id = cfg_role.tenant_id
   AND g.role_id = cfg_role.id
   AND cfg_role.slug = 'role-configurator'
   AND g.confirmed_by = 'backfill'
   AND NOT EXISTS (
     SELECT 1 FROM choros.role_assignment owner_ra
       JOIN choros.role owner_role
         ON owner_role.tenant_id = owner_ra.tenant_id AND owner_role.id = owner_ra.role_id
      WHERE owner_ra.tenant_id = g.tenant_id
        AND owner_role.slug = 'tenant-owner'
        AND owner_ra.confirmed_by IS NOT NULL
   );
```

Идемпотентность: второй прогон находит 0 строк (первый DELETE уже убрал их — `NOT EXISTS`
предикат сам по себе не осциллирует, т.к. не зависит от СВОЕГО ЖЕ предыдущего эффекта, кроме
как через отсутствие удалённых строк). role/employee/agent_card НЕ упоминаются ни в одном
DELETE — F3 гарантируется структурно (не багом, а тем, что миграция не содержит `DELETE FROM
choros.role`/`choros.employee`/`choros.agent_card`).

**Связь с тестом миграции 118.** `ci/checks/db/migration-118-tenant-zero-backfill.test.ts`
(FF-1/FF-2/FF-3) не редактируется — эти тесты покрывают ТОЛЬКО тенантов с владельцем (pre-T-0373
seed, свежерегистрированный) и остаются валидными без изменений (AC-4). Новый тестовый файл
`ci/checks/db/migration-120-ownerless-unarm.test.ts` вводит смешанную трёхтенантную фикстуру
(T_FULL/T_PARTIAL/T_OWNERLESS — именует те же роли, что использовал adversarial-щуп тестера
T-0573 в своём отчёте, для прямой прослеживаемости находка→тест) и ИМПОРТИРУЕТ/переиспользует
тот же `countInvariantViolations()`-предикат (буквально, не изменяя оригинальный файл — новый
файл либо копирует SQL-текст предиката verbatim, либо экспортирует его в общий helper без
изменения существующего теста; конкретика — в реализации, критерий — байт-в-байт тот же SQL).

## 5. Dual-control relief для миграции 120

`ci/checks/dual-control-isolation.sh` (владелец T-0044, FF-DC7) распознаёт ЛЮБОЙ новый/
изменённый файл миграции, кроме `031_grant_confirmed2_by.sql`, как "unexpected migration" —
false-red по умолчанию. Миграция 120 (DELETE над `role_assignment`/`"grant"`) попадает в тот же
класс, что 109/117/118/119: НЕ трогает `confirmed2_by` (dual-control's own column), НЕ содержит
DDL (`CREATE`/`ALTER`/`DROP TABLE`, `ADD`/`DROP COLUMN`, RLS/POLICY) — точный прецедент 109
(`migrations/109_dual_control_pdp_backfill.sql`, T-0397), которая точно так же мутирует
`role_assignment`/`"grant"` (там — `UPDATE`, здесь — `DELETE`, тот же защищённый домен, та же
fail-closed форма relief: разрешить только если НЕТ DDL и НЕТ упоминания `confirmed2_by`).

Механизм: **добавлен per-migration relief-блок** (`T0594-DC-MIG120-GUARD` guard-token) в
`ci/checks/dual-control-isolation.sh` — тот же паттерн, что T0573-DC-MIG118-GUARD/
T0575-DC-MIG119-GUARD непосредственно перед ним: (1) флаг `_dc_mig120_failed=0` перед основным
циклом; (2) post-loop relief-блок, который перечитывает non-comment содержимое 120, проверяет
отсутствие `CREATE|ALTER|DROP TABLE`, `ADD|DROP COLUMN`, `ROW LEVEL SECURITY`, `CREATE POLICY`,
`confirmed2_by` — и только тогда `ERRORS=$((ERRORS - 1))`, гася false-red ИМЕННО для этой одной
миграции. Санкционирован через уже существующий `auto_additive` канал
(`ci/checks/auto-sanction-additive.sh`, T-0232) — запись в `ci/checks/data/frozen-sanctions.jsonl`
(append-only), тот же формат, что T-0570/T-0573/T-0575 записи для 117/118/119 (см. BUILD за
точным JSON).

## 6. Fitness functions

| ID | Правило | ci_check |
|---|---|---|
| FF-1 | AC-1: на смешанной фикстуре T_FULL/T_PARTIAL/T_OWNERLESS прогон 120 удаляет ровно backfill-строки T_OWNERLESS (role_assignment+4 grant), role/employee/agent_card T_OWNERLESS нетронуты, AC-1-инвариант-предикат (форма 118) по-прежнему = 1 нарушение для T_OWNERLESS; T_FULL/T_PARTIAL — 0 удалённых строк | `vitest run ci/checks/db/migration-120-ownerless-unarm.test.ts --no-file-parallelism` |
| FF-2 | AC-2: повторный прогон тела 120 — 0 новых DELETE | тот же файл |
| FF-3 | AC-3: файл 120 не содержит литерала UUID тенанта | grep-проверка внутри того же тестового файла (или расширение `no-hardcoded-tenant-uuid.sh`, см. BUILD) |
| FF-4 | AC-4: существующий migration-118-tenant-zero-backfill.test.ts (FF-1/FF-2/FF-3 T-0573) зелёный без правок логики | `vitest run ci/checks/db/migration-118-tenant-zero-backfill.test.ts --no-file-parallelism` |
| FF-5 | AC-5: dual-control-isolation.sh зелёный после добавления 120 + relief-блока | `bash ci/checks/dual-control-isolation.sh` |
| FF-6 | AC-6: полный fitness:db/vitest/fitness | `npm run fitness:db && npx vitest run && npm run fitness` |

## 7. Traceability

| AC | covered_by |
|---|---|
| AC-1 | FF-1 |
| AC-2 | FF-2 |
| AC-3 | FF-3 |
| AC-4 | FF-4 |
| AC-5 | FF-5 |
| AC-6 | FF-6 |
