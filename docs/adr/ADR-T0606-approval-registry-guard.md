# ADR-T0606 — Guard над реестром согласований: per-registry триггер-скоуп + engine_managed write-protection

**Status:** ready
**Phase:** DESIGN
**Task:** T-0606 [approval-registry-guard]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0606-approval-registry-guard.spec.md` + `docs/specs/T-0606.spec.contract.json` (AC-1..AC-10)
**База:** dev @ `da28079` (ветка `task/T-0606-approval-registry-guard`, содержит T-0603 + T-0604)
**Предшественники:** T-0335 (E15-S1b), T-0575 (BUG-017, `target_registry_slug`, migration 119), T-0604 (`submit_task_key`, migration 121), T-0351 (E16 on_create).

---

## 1. `target_registry_slug` — что это, и почему НЕ переиспользовано

**Investigation (подтверждено чтением `migrations/119_process_app_binding_target_registry_slug.sql`,
`src/db/step-applier.ts`, `src/db/process-instance-resolver.ts`):**

`process_app_binding.target_registry_slug` (migration 119) — это ИСКЛЮЧИТЕЛЬНО
таргет ЗАПИСИ РЕЗУЛЬТАТА шага. `applyStepResult` (step-applier.ts, ~line 640)
резолвит его так:

```ts
const resolvedSlug = target.targetRegistrySlug ?? resolveDefaultStepResultSlug();
const approvals = await resolveApprovalsRegistry(client, tenantId, target.applicationId, resolvedSlug);
```

Это происходит ПОСЛЕ того, как шаг BPMN УЖЕ ЗАВЕРШЁН (approve/reject) — вопрос,
на который отвечает эта колонка: «в какой реестр писать акт РЕЗУЛЬТАТА
уже-принятого решения». Сидовые данные migration 119
(`UPDATE ... SET target_registry_slug = 'soglasovanie' WHERE process_key =
'telLinear'`) настраивают именно ЭТО — куда telLinear пишет результат своего
шага, а НЕ какой реестр запускает telLinear на create.

Bug #2 этой задачи — про СОВЕРШЕННО ДРУГОЙ вопрос: «какое create-событие
должно ЗАПУСТИТЬ процесс» (inbound, ДО любого решения). Это читает
`getOnCreateBinding` (`src/db/binding-trigger-dao.ts`), вызываемый из
`createRecord` (`src/http/records.ts` ~813) — до всякого BPMN-шага, до всякого
approve. Переиспользование `target_registry_slug` для этого вопроса было бы
категориальной ошибкой: одна колонка обслуживала бы два семантически
несовместимых NULL-фоллбека (одна сторона — «default-таргет уже решённого
шага», другая — «default-источник создания, решающий, ЗАПУСКАТЬ ЛИ процесс
вообще»), что дальше усложнило бы (не упростило) both reads.

**Решение: новая, отдельная колонка `trigger_registry_id`.**

## 2. Новая колонка — `trigger_registry_id` (не slug-text) + NULL-семантика

### 2.1 Имя и тип

`process_app_binding.trigger_registry_id uuid NULL` — FK-shaped ссылка на
`registry_def.id`, а НЕ text-slug (в отличие от `target_registry_slug`).

**Почему id, не slug:** вызывающий код (`records.ts::createRecord`) уже
держит `reg` (governing registry_def) В РУКАХ на месте вызова
`getOnCreateBinding` — `reg.id` доступен без доп. лукапа/джойна. `reg.slug`
ТОЖЕ доступен (registry_def несёт `slug`), но `id` строже (immutable
identity; slug теоретически можно переименовать без нарушения
FK-семантики — id переживает переименование). Выбор `id`-колонки избегает
лишнего джойна/лукапа, который вызывающему коду иначе не нужен (спека §2,
задание явно требует «avoid an extra join/lookup»).

### 2.2 NULL-семантика

**NULL = биндинг срабатывает на create в PRIMARY реестре приложения.**
«PRIMARY» определён ИДЕНТИЧНО существующему примитиву
`process-instance-resolver.ts`'s Step 3 (`resolveInstanceTargetReads`):

```sql
SELECT id, slug, display_name FROM choros.registry_def
 WHERE tenant_id = $1 AND application_id = $2 AND is_system = false
 ORDER BY created_at ASC LIMIT 1
```

Переиспользование ЭТОЙ формулы (а не изобретение новой) — намеренный выбор:
одна и та же «PRIMARY registry» концепция используется и для OUTBOUND
(куда step-applier пишет результат по умолчанию) и для INBOUND (что
запускает процесс по умолчанию) направлений. Регистр, который НЕ может быть
step-result-таргетом по умолчанию (is_system=true), структурно НЕ может
стать и NULL-фоллбек-триггер-источником — оба направления согласованы одной
инвариантой.

**Non-NULL = биндинг срабатывает ТОЛЬКО для этого конкретного `registry_def.id`.**

### 2.3 Верификация против ТЭЛ-сидов

Проверено чтением `migrations/076_soglasovanie_registry_seed.sql` +
`086_tel_purchases_user_registry.sql`:

- `076` сидит ДВЕ строки `registry_def` под `tel-approval`
  (application_id=`a7000000-…-0001`): `purchases` (Заявки,
  id=`a7000000-…-0002`) И `soglasovanie` (Согласование, id=`a7000000-…-0003`)
  — ОБЕ изначально `is_system = true`, `created_at = 0`.
- `086` флипает ТОЛЬКО `purchases` в `is_system = FALSE` (обоснование в
  086's собственном header: «Заявки holds real business data — is_system =
  FALSE is the semantically correct classification»). `soglasovanie`
  ОСТАЁТСЯ `is_system = TRUE` навсегда (086's header: «Согласование
  (soglasovanie) stays is_system = TRUE — approvals-infrastructure
  registry»).

**Вывод (проверено, не предположено):** под `tel-approval` СУЩЕСТВУЕТ РОВНО
ОДИН `is_system=false` реестр — `purchases`. Формула «первый is_system=false
по created_at ASC» тривиально резолвится в `purchases`, поскольку это
единственный кандидат — tie-break по `created_at` (оба ряда имеют
`created_at=0`) НЕ ДАЖЕ ВСТУПАЕТ В ИГРУ (нет второго `is_system=false`
кандидата, с которым можно было бы конфликтовать). Это делает NULL-фоллбек
для ТЭЛ-биндинга telLinear→tel-approval ДЕТЕРМИНИРОВАННЫМ И КОРРЕКТНЫМ БЕЗ
ЛЮБОГО изменения данных — миграция 122 НЕ трогает `trigger_registry_id`
telLinear-биндинга (085), оставляя его NULL, что уже резолвится в «Заявки»
ровно так, как нужно.

**Детерминированность запроса (защита от будущих сидов с двумя
`is_system=false` реестрами одного created_at):** `getOnCreateBinding`'s
собственная реализация нового SQL добавляет `ORDER BY rd.created_at ASC, rd.id
ASC LIMIT 1` в подзапрос — та же стабильная tie-break дисциплина, что уже
используют другие резолверы этого файла (`resolveGoverningRegistryDef`'s
`ORDER BY created_at ASC, slug ASC`). Для ТЭЛ-сидов эта деталь не решающая
(см. выше — только один кандидат), но обеспечивает будущую устойчивость.

### 2.4 Что меняется для существующих биндингов

- **telLinear (085 seed):** `trigger_registry_id` остаётся NULL (не
  трогается миграцией). Поведение НЕ МЕНЯЕТСЯ (NULL уже резолвится в
  «Заявки», единственный кандидат) — create в «Заявки» по-прежнему
  стартует telLinear (регрессия проверена, AC-4). Create в «Согласование»
  (ранее ошибочно ТОЖЕ запускавший telLinear, bug #2) БОЛЬШЕ НЕ запускает
  его — «Согласование» is_system=true, никогда не PRIMARY-кандидат.
- **purchaseApproval (живой UI-биндинг, вне migrations/):** `trigger_registry_id`
  NULL по умолчанию (колонка нова для него так же, как для всех
  существующих строк) — если у этого приложения ОДИН реестр, поведение не
  меняется; если несколько (сценарий bug #2), NULL теперь корректно
  ограничивает триггер только primary-реестром вместо любого реестра
  приложения.

## 3. `engine_managed` — колонка, не jsonb-convention

### 3.1 Выбор

`registry_def.engine_managed boolean NOT NULL DEFAULT false` — первоклассная
булева колонка, зеркалящая ФОРМУ и ПРЕЦЕДЕНТ существующей `is_system`
колонки (migration 004, тот же тип/дефолт/nullability-паттерн).

**Отклонённая альтернатива: jsonb-convention внутри `record_schema`**
(например, зарезервированный ключ `"x-write-protected": "engine"` внутри
`record_schema` jsonb). Отклонена по трём причинам:
1. **Конфлейт данных со governance-метаданными.** `record_schema` — это
   ФОРМА данных записи (какие поля, какие типы). «Кто имеет право писать в
   этот реестр» — ортогональная governance-забота, не свойство схемы
   данных. Смешение усложняет both concerns (схема-валидатор теперь должен
   игнорировать non-schema ключи; governance-чтение требует парсить jsonb
   вместо простого `WHERE engine_managed = true`).
2. **Query/index эргономика.** Первоклассная колонка queryable/indexable
   напрямую (`WHERE engine_managed = true`); jsonb-конвенция требует
   `record_schema->>'x-write-protected'` на КАЖДЫЙ чек — дороже и менее
   очевидно для будущих читателей кода.
3. **Прецедент этой кодовой базы.** `is_system` — уже первоклассная колонка
   для РОВНО ТОЙ ЖЕ категории метаданных («это инфраструктурный /
   специально-обрабатываемый реестр»), не jsonb-конвенция. Консистентность с
   существующим прецедентом сильнее, чем гипотетическая экономия одной
   миграции.

### 3.2 Гейт (Part B, records.ts)

`assertNotEngineManaged(reg)` — новая функция в `src/http/records.ts`,
вызываемая из `createRecord`, `updateRecord`, `deleteRecord` СРАЗУ после
резолюции governing `registry_def` (до валидации данных, до write-mask
гейта, до любой мутации). При `reg.engine_managed === true` — бросает
`HttpError(403, "REGISTRY_ENGINE_MANAGED", "Записи этого раздела создаёт
процесс — согласуйте через задачу в Моих задачах")`, следуя существующему
конверту `{error:{code,message}}` (тот же паттерн, что `denialError` для
`FIELD_WRITE_FORBIDDEN` в этом же файле).

### 3.3 Данные

Миграция 122 идемпотентным `UPDATE` помечает СУЩЕСТВУЮЩУЮ ТЭЛ
«Согласование» строку (`a7000000-…-0003`, migration 076)
`engine_managed = true`. Это — единственная реестровая строка, которую
`step-applier.ts` реально пишет сегодня (по `SOGLASOVANIE_SLUG`-фоллбеку/
`target_registry_slug`); других живых «согласование»-подобных реестров в
сидах нет.

## 4. Изоляция `step-applier.ts` (N4 из спеки) — доказано СТРУКТУРНО

`applyStepResult`'s резолюция approvals-реестра (`resolveApprovalsRegistry`,
`src/db/step-applier.ts` ~252):

```sql
SELECT id, application_id FROM choros.registry_def
 WHERE tenant_id = $1 AND application_id = $2 AND slug = $3 LIMIT 1
```

Эта SELECT НИКОГДА не выбирает `engine_managed` — колонка ей физически
невидима. Прямой `INSERT INTO choros.record` (~line 700) идёт СРАЗУ вслед,
без какой-либо проверки на write-protection. Гейт Part B живёт
ИСКЛЮЧИТЕЛЬНО внутри `src/http/records.ts`'s HTTP create/update/delete
хендлеров — `step-applier.ts` НЕ импортирует и не вызывает ни одну функцию
из `records.ts`. Изоляция доказана И статически (чтением обоих модулей —
ноль общих функций между HTTP-роутом и DAO-путём step-applier), И тестом
(`src/__tests__/step-applier.test.ts::SA-11` — юнит, проверяющий, что ни
один SQL-запрос этого пути не упоминает `engine_managed`, + живой
Postgres-тест `ci/checks/db/approval-registry-guard.db.test.ts`,
вызывающий `applyStepResult` напрямую против реального
`engine_managed=true` реестра и подтверждающий успешную запись).

## 5. Риски и остаточные пробелы

- **Two-phase window (существующий, не новый):** `createRecord`'s
  `startInstance` — REST-вызов вне PG-транзакции; успех движка + сбой
  COMMIT оставляет осиротевший инстанс движка (та же известная граница, что
  и до этой задачи — не расширена и не сужена этой задачей).
- **Seed-данные литерал boundary (D-064 §5).** Литерал `'soglasovanie'`
  (косвенно, через id `a7000000-…-0003`) фигурирует ТОЛЬКО в SQL
  data-completion `UPDATE` миграции 122 — тот же прецедентный класс, что
  119's `WHERE process_key = 'telLinear'` / 121's `submit_task_key =
  'task-submit'`. Ноль соответствующего литерала в `src/` TypeScript —
  подтверждено чтением diff'а и повторным прогоном
  `detel-literal-baseline.sh` (аггрегат не растёт).
- **Остаточный пробел:** UI для редактирования `trigger_registry_id`/
  `engine_managed` не предоставлен этой задачей (O1 в спеке) — оба поля
  задаются данными/SQL. Если продукту понадобится конструктор для этого,
  это отдельная задача.
- **purchaseApproval (живой тенантский биндинг) не размечен явно:** если у
  этого приложения СЕЙЧАС несколько реестров (потенциальный живой
  bug #2-сценарий), NULL `trigger_registry_id` автоматически ограничивает
  триггер только primary-реестром — это ЖЕЛАЕМОЕ поведение без доп.
  данных (не требует ретроактивной простановки, O2 в спеке).

## 6. Отклонённые альтернативы (сводка)

| Вариант | Почему отклонён |
|---|---|
| Реиспользовать `target_registry_slug` для триггер-скоупа | Категориальная путаница двух NULL-семантик (outbound-result-target vs inbound-trigger-source); см. §1. |
| `trigger_registry_slug text` вместо `trigger_registry_id uuid` | Вызывающий код уже держит `reg.id`; text-slug добавил бы либо доп. join, либо риск рассинхронизации slug↔id при переименовании реестра. |
| jsonb-convention (`x-write-protected`) вместо колонки `engine_managed` | Конфлейт схемы данных с governance-метаданными; хуже query/index эргономика; расходится с прецедентом `is_system`. См. §3.1. |
| Изобрести НОВОЕ определение «primary registry» для триггер-скоупа | Дублирование существующей формулы `process-instance-resolver.ts` — расхождение первично-инбound/outbound понятий «примари» было бы ХУЖЕ, не проще. |

---

*Файл: `docs/adr/ADR-T0606-approval-registry-guard.md`.*
