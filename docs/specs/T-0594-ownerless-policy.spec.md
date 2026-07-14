# SPEC T-0594 — Политика для тенантов без владельца (R-2 миграции 118)

**Status:** ready
**Phase:** SPEC
**Task:** T-0594 [W2/edge]
**Date:** 2026-07-02
**Источник:** finding R-2, `docs/review/T-0573.review.json`; adversarial-щуп тестера T-0573 (`docs/test/T-0573.test-report.json`, `adversarial_probe_performed_per_task_instruction`).
**База:** dev @ `962f9d4` (ветка `task/T-0594-ownerless-policy`).
**Предшественники:** T-0573 (migration 118, ADR-T0573 §2.1, уже смержено — файл 118 НЕ редактируется, идемпотентный повтор не случится на средах где он применён).

---

## 1. Контекст (L-факты, не гипотезы)

`migrations/118_assistant_tenant_zero_backfill.sql` восстанавливает 9-строчный tenant-zero
инвариант ассистента (role-configurator / employee assistant-agent / agent_card / 2×
role_assignment / 4× grant) для каждого существующего тенанта, у которого его не хватает.
Блок A4 (владелец → role-configurator) резолвит владельца set-driven через
`role_assignment → role(slug='tenant-owner') WHERE confirmed_by IS NOT NULL`. Если такого
владельца НЕТ ВООБЩЕ (ни одного confirmed role_assignment на tenant-owner), LATERAL-джойн даёт
пустое множество → A4 корректно НЕ вставляет строку (не падает, не изобретает фиктивного
владельца — F2 инварианта не нарушен).

**Но** блоки A5 (assistant-agent → role-configurator), A6 (2× authoring_draft grant), A7 (2×
capability grant) НЕ зависят от владельца вообще — их предикаты используют только
`role-configurator` (A1) и `employee assistant-agent` (A2), оба из которых создаются
безусловно для ЛЮБОГО тенанта. Итог для тенанта без владельца: role-configurator получает
**4 confirmed-гранта + назначение АГЕНТА**, но **ни один человек не может унаследовать эту
роль** (ни одного role_assignment человека на неё не существует).

**Разведано (review R-2 + adversarial-щуп T-0573, независимо воспроизведено, оба сходятся):**
- Не эскалация привилегий: агент (`kind='agent'`) не проходит HTTP auth как человек — чат
  ассистента идёт под identity владельца (ADR-T0573 §1), назначение роли агенту само по себе
  никому ничего не открывает, пока нет человека, аутентифицированного под этой ролью.
- Собственный AC-1-предикат миграции 118 (`ci/checks/db/migration-118-tenant-zero-backfill.test.ts`,
  секция `countInvariantViolations`) **честно продолжает флагать** такой тенант как нарушителя —
  ветка `OR NOT EXISTS (... role_assignment ra ... owner_ra ... owner_role.slug = 'tenant-owner')`
  не находит владельца → violations=1. Не молчаливая дыра.
- Повторный прогон стабилен: 0 новых строк, не осциллирует (idempotent no-op на уже
  вооружённом ownerless-тенанте).

**Откуда берётся ownerless-тенант — разведано, не гипотеза.** `src/core/register.ts`
(`registerTenant`) вставляет `role(slug='tenant-owner')` + `employee` + **confirmed**
`role_assignment` на владельца ПЕРВЫМИ ШАГАМИ той же DB-транзакции (шаги 3b-3d, до 3e-3j-bis
tenant-zero блока) — продукт **не может** создать тенант без владельца через живой путь.
Ownerless-тенант — это ТОЛЬКО данные-сироты из тестовых/приёмочных фикстур (сид без owner
role_assignment) или ручное вмешательство в БД в обход `registerTenant`, НЕ достижимое
состояние в проде.

## 2. Решение (см. ADR-T0594 для полной аргументации)

**(а) Skip A5-A7 для тенантов без владельца.** Новая миграция `migrations/120_*.sql` (следующий
свободный номер — 118/119 уже заняты; 118 не редактируется, применена на стенде и в CI-шаблонах)
УДАЛЯЕТ ровно те строки role_assignment/grant на role-configurator, которые были вооружены
(A5/A6/A7-подобным путём) для тенантов, у которых **на момент прогона 120** нет НИ ОДНОГО
confirmed `role_assignment` человека на `role(slug='tenant-owner')`. Set-driven, без литерала
UUID тенанта, DELETE только строк, у которых `granted_by='backfill' AND confirmed_by='backfill'`
(маркер миграции 118 — не трогает гранты, выданные вручную/другим путём после того как
владелец мог появиться и что-то поменять). role-configurator (роль) и employee assistant-agent
(агент) и agent_card НЕ удаляются — они безвредны сами по себе (роль без назначений и агент без
роли ничего не открывают); удаляется только сам ВООРУЖЁННЫЙ контур (назначение + гранты).

## 3. Functional

- **F1.** Новая миграция `120_*.sql` для каждого тенанта БЕЗ confirmed `role_assignment` на
  `role(slug='tenant-owner')` удаляет: (i) `role_assignment` `assistant-agent → role-configurator`
  с `source='backfill'`; (ii) все 4 `grant` на `role-configurator` с `confirmed_by='backfill'`
  (authoring_draft×2 + capability×2) — ровно те строки, которые были бы созданы блоками
  A5/A6/A7 миграции 118 для этого тенанта.
- **F2.** Тенанты, у которых владелец ЕСТЬ (confirmed role_assignment на tenant-owner) —
  полный или частичный инвариант — миграция 120 не удаляет ни одной их строки (нулевой эффект,
  N1 non-regression).
- **F3.** role (`role-configurator`), employee (`assistant-agent`) и `agent_card` тенанта без
  владельца НЕ удаляются миграцией 120 (остаются как безвредный, но НЕ вооружённый субстрат —
  если владелец появится позже, будущий отдельный ручной/операторский шаг может довооружить
  контур, не пересоздавая роль/агента/карточку с нуля).
- **F4.** Собственный AC-1-предикат миграции 118 (та же SQL-форма, что в
  `migration-118-tenant-zero-backfill.test.ts`) продолжает флагать тенант без владельца ПОСЛЕ
  120 (было 1 нарушение до 120, остаётся 1 нарушение после — теперь по ПРАВИЛЬНОЙ причине:
  «нет ни одной из недостающих строк для человека», а не «агент вооружён, человека нет»).

## 4. Non-functional

- **N1 (non-regression).** Миграция 120 не удаляет НИ ОДНОЙ строки, относящейся к тенанту, у
  которого confirmed role_assignment на tenant-owner СУЩЕСТВУЕТ — ни полному (T_FULL), ни
  частичному (T_PARTIAL, например только что зарегистрированному или прошедшему 118 нормально)
  инварианту ничего не грозит.
- **N2 (set-driven, без литерала).** Ни один литерал UUID тенанта в теле 120 — тот же
  дисциплинарный стандарт, что 118 (`FROM choros.tenant t ...`).
- **N3 (идемпотентность).** Повторный (второй, третий) прогон тела 120 — no-op: тенант без
  владельца, у которого 120 уже удалила A5/A6/A7-строки, при повторном прогоне даёт 0 новых
  DELETE (нечего удалять — предикат `source/confirmed_by='backfill' AND NOT EXISTS(owner)`
  второй раз не находит таких строк).
- **N4 (маркер-точность).** DELETE ограничен строго строками с `source='backfill'` /
  `confirmed_by='backfill'` (маркер, вставленный ИМЕННО миграцией 118) — если тенант без
  владельца ПОЗЖЕ получил grant/role_assignment на role-configurator ЧЕЛОВЕКОМ (не через
  backfill-маркер, например administrative), миграция 120 (если бы применилась заново — она
  так же одноразовая) их НЕ тронула бы. Это описательное свойство предиката, DoD не требует
  повторного прогона 120 после появления владельца (миграции одноразовые).
- **N5.** Никаких новых таблиц/колонок — чистый DELETE над существующими `role_assignment` и
  `"grant"`.

## 5. Out of scope

- **O1.** Правка файла `migrations/118_*.sql` — запрещена директивой (уже применена на стенде
  и в CI-шаблонах, повторный идемпотентный прогон не случится).
- **O2.** Автоматическое обнаружение/уведомление о появлении владельца у ранее ownerless
  тенанта, и авто-довооружение контура в этот момент — не in scope; это ручная операторская
  забота (см. ADR §5 «что если владелец появится позже»).
- **O3.** Изменение `register.ts`/живого пути регистрации — не тронут (там ownerless
  недостижим по конструкции, F2 п.1 spec T-0573 уже гарантирует владельца первым шагом
  транзакции).
- **O4.** Удаление role-configurator/assistant-agent employee/agent_card у ownerless-тенанта —
  явно НЕ в объёме (F3): это не вооружённый контур, удалять их — потерять субстрат для
  будущего довооружения без пользы для гигиены прав.

## 6. Открытые вопросы

Нет блокирующих вопросов — политика (а) полностью выводима из уже разведанного кода (T-0573
review R-2 + adversarial-щуп), директива задания явно предпочитает (а) и оставляет
подтверждение «по коду» на усмотрение исполнителя; код подтверждает: ownerless-тенант
недостижим живым путём (registerTenant гарантирует владельца первым шагом), поэтому
гигиена (не плодить недостижимые для человека гранты) перевешивает предположение «подождём
владельца» — ждатьнечего, живой путь никогда не производит такое состояние.

## 7. Acceptance criteria

- **AC-1 (F1/F4, fitness).** На смешанной фикстуре из трёх тенантов — `T_FULL` (полный
  9-строчный инвариант, например только что через `registerTenant()` или уже прошедший 118
  штатно), `T_PARTIAL` (role-configurator role + confirmed tenant-owner assignment есть, но
  employee/agent_card/role_assignment-на-role-configurator/grants отсутствуют — владелец ЕСТЬ),
  `T_OWNERLESS` (роль/employee/agent_card/role_assignment/grant на role-configurator ЕСТЬ,
  но ни одного confirmed role_assignment человека на tenant-owner НЕТ вовсе — точная
  постановка R-2/adversarial-щупа) — после прогона тела миграции 120: у `T_OWNERLESS`
  role_assignment `assistant-agent→role-configurator` и все 4 grant на role-configurator с
  `source/confirmed_by='backfill'` удалены (0 строк); role/employee/agent_card `T_OWNERLESS`
  остаются нетронутыми (>0 строк, F3); AC-1-инвариант-предикат (форма 118) по-прежнему
  возвращает 1 нарушение для `T_OWNERLESS` (было 1 и до 120 — F4, теперь по правильной
  причине). У `T_FULL` и `T_PARTIAL` — 0 удалённых строк (row-counts до/после байт-в-байт
  идентичны, N1).
- **AC-2 (N3, fitness).** Повторный (второй) прогон тела миграции 120 на той же фикстуре ПОСЛЕ
  первого прогона — 0 новых DELETE (ничего не осталось удалять), состояние стабильно.
- **AC-3 (N2, fitness/grep).** Файл `migrations/120_*.sql` не содержит литерала UUID тенанта
  (тот же regex-класс, что `ci/checks/migrations/no-hardcoded-tenant-uuid.sh` проверяет для
  118) — задача расширяет этот чек на 120 ИЛИ проверяет эквивалентным grep-тестом внутри
  `ci/checks/db/*.test.ts` (см. ADR §4 за окончательным механизмом).
- **AC-4 (регресс, fitness).** Существующий `ci/checks/db/migration-118-tenant-zero-backfill.test.ts`
  (FF-1/FF-2/FF-3, все три существующих сценария: pre-T-0373 тенант, свежерегистрированный
  тенант, повторный прогон 118) остаётся зелёным БЕЗ ИЗМЕНЕНИЙ логики существующих тестов —
  120 не меняет поведение 118 для тенантов С владельцем.
- **AC-5 (dual-control, fitness).** `bash ci/checks/dual-control-isolation.sh` зелёный после
  добавления миграции 120 (DELETE над `role_assignment`/`"grant"` — тот же протектед-домен,
  что 118 задел; relief по прецеденту 117/118/119, если чек красит без него).
- **AC-6 (полный vitest, fitness).** `npm run fitness:db` (весь `ci/checks/db`) зелёный;
  `npx vitest run` (корневой раннер) зелёный; `npm run fitness` (полная цепочка) зелёный.

## 8. Машинные предикаты (для контракта/ADR)

AC-1 инвариант-предикат — **тот же SQL**, что `countInvariantViolations()` в
`ci/checks/db/migration-118-tenant-zero-backfill.test.ts` (verbatim, без изменений) — этот файл
НЕ редактируется по логике (только читается тестом 120, если новый тестовый файл его
импортирует, или предикат дублируется буквально в новом файле — решение в ADR/BUILD).

DELETE-предикат миграции 120 (по духу, точная форма — в самом файле):

```sql
DELETE FROM choros."grant" g
 USING choros.role r
 WHERE g.tenant_id = r.tenant_id AND g.role_id = r.id
   AND r.slug = 'role-configurator'
   AND g.confirmed_by = 'backfill'
   AND NOT EXISTS (
     SELECT 1 FROM choros.role_assignment ra
       JOIN choros.role owner_role
         ON owner_role.tenant_id = ra.tenant_id AND owner_role.id = ra.role_id
      WHERE ra.tenant_id = g.tenant_id
        AND owner_role.slug = 'tenant-owner'
        AND ra.confirmed_by IS NOT NULL
   );
```

(аналогично для `role_assignment` — только строка `assistant-agent → role-configurator` с
`source='backfill'`; см. миграцию 120 за точным текстом).

