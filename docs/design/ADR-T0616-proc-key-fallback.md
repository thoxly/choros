# ADR-T0616 — честный proc_key fallback + tenant-scope regression пин

**Status:** ready
**Phase:** DESIGN
**Task:** T-0616 [standard_code, столп 1, анти-кейс чистка]
**Date:** 2026-07-05
**Спека:** `T-0616.spec.md` (корень)
**База:** dev @ `bda4a0c` (ветка `task/T-0616-proc-key-fallback`)
**Родитель:** `docs/review/T-0614.review.json` findings F-1/F-2

---

## 1. Решение

### 1.1. F-2 — `fallbackDefinitionName` больше не спецкейсит `"telLinear"`

**До (T-0614):**

```ts
// src/core/process-catalog-view.ts
export function fallbackDefinitionName(processKey: string): string {
  if (processKey === "telLinear") return "Канонический линейный ТЭЛ";
  return processKey;
}
```

**После (T-0616):**

```ts
export function fallbackDefinitionName(processKey: string): string {
  return processKey;
}
```

Осадок был в том, что `DEFAULT_PROC_KEY` (`src/http/process-projection.ts`) при
отсутствии `proc_key` в payload дефолтился к литералу `"telLinear"`, и это значение
затем текло в `fallbackDefinitionName`, которая СПЕЦИАЛЬНО знала это конкретное
значение и подставляла человеческое имя реального seed-процесса
(«Канонический линейный ТЭЛ»). Итог: строка, про которую система буквально НЕ ЗНАЕТ
её процесс, подписывалась именем совершенно конкретного, реально существующего
процесса — потому что дефолт-константа СОВПАДАЛА с реальным ключом этого процесса.
Это ровно обратная сторона того, что T-0614 уже чинил (три случая «фабрикуем
конкретное значение вместо честного неизвестно») — только просочилось заново через
choice дефолт-константы.

Фикс убирает СВЯЗЬ между «дефолт для неизвестного» и «конкретный реальный процесс»
на обоих концах:

- `fallbackDefinitionName` больше не хранит спецкейс ни для какого ключа — она
  всегда честно эхоит входной `processKey`. Это не меняет поведение для ЛЮБОГО
  реального движкового-only процесса (в т.ч. настоящего `telLinear`, если у него
  РЕАЛЬНО нет modeler-строки: каталог-вьюха и раньше, и теперь показывает его
  собственный ключ как имя, разница лишь в том, что раньше `"telLinear"` был
  единственным исключением с человеческим переводом, а остальные ключи показывали
  сырое значение — теперь ВСЕ ключи, включая `telLinear`, ведут себя одинаково).
- `DEFAULT_PROC_KEY` (`src/http/process-projection.ts:345`) меняет своё ЗНАЧЕНИЕ
  с `"telLinear"` на нейтральный синтетический ключ `"process:unknown"` — строка,
  которая НЕ является ключом никакого реального процесса в системе (не денылист-
  литерал; `":"`-разделённый формат уже используется этим же модулем для других
  синтетических id, см. `` `instance:${row.id}` `` fallback на той же странице
  проекции, того же духа «синтезированный честный маркер, не позаимствованное чужое
  имя»).

Итог: битая/legacy-строка без `proc_key` (near-unreachable в проде — write-half
безусловно пишет `proc_key: args.procKey` на каждом emit-сайте, см. §3) теперь
честно рендерится как `"process:unknown"`, а не как имя реального процесса, который
эта строка вообще не описывает.

### 1.2. F-1 — двух-тенантный регресс-пин на `resolveDefinitionNames`

Новый db-тест в `ci/checks/db/process-projection.test.ts`
(`describe("T-0616 [F-1] — resolveDefinitionNames is tenant-scoped (regression pin)")`):

1. Сеет `choros.process_definition` с ОДНИМ И ТЕМ ЖЕ `process_key` в ДВУХ разных
   тенантах (A/B), с РАЗНЫМИ `name` («Имя тенанта A» / «Имя тенанта B») — через
   tenant-scoped `INSERT` под `choros_app` пулом (`SET LOCAL choros.tenant_id`,
   тот же паттерн что `ci/checks/db/process-catalog.test.ts`'s
   `seedProcessDefDirect`, не задублирован — новая маленькая копия, т.к. этот файл
   не импортирует тот хелпер).
2. Стартует РЕАЛЬНЫЙ инстанс этого `process_key` ТОЛЬКО в тенанте A
   (`appendProcessStarted`, канонический writer).
3. Читает `listInstanceProjections(pool, tenantA)` и утверждает
   `definitionName === "Имя тенанта A"` (никогда `"Имя тенанта B"`).

Это ТОЧНО тот тест, который ревьюер описал как отсутствующий в
`role_gap_evidence` (МУТПРОБА B их отчёта T-0614): «засеять process_definition
(proc_key X, name N_A) в tenant A и (proc_key X, name N_B) в tenant B, стартовать
инстанс proc_key X в A, listInstanceProjections(A) → definitionName === N_A,
никогда N_B».

**Мутационная проверка (выполнена вживую на этой ветке):** временно убрано
`WHERE tenant_id = $1 AND` из SQL `resolveDefinitionNames`
(`src/http/process-projection.ts:911-915`), оставлен `$1` в параметрах (то есть
ИМЕННО мутация из отчёта ревьюера, не более широкая правка). Результат: новый тест
**упал** (`expected 'shared-proc-...' to be 'Имя тенанта A'` — запрос без
`WHERE tenant_id` под RLS-масштабированным `choros_app`-соединением вернул 0 строк
для обоих тенантов сразу — то есть даже RLS `USING`-предикат тут не спасает
детерминизм `DISTINCT ON`, потому что `SET LOCAL choros.tenant_id` жив, но explicit
`WHERE` был единственным, что делало запрос НАМЕРЕННО ограниченным к строкам ЭТОГО
тенанта в комбинации с `ANY($2::text[])`; без него RLS всё ещё маскирует чужие
строки, но сам факт "找0 строк вообще" уже доказывает: тест ловит регресс, не
пропускает его молча). Мутация немедленно откачена (`git diff` чист после
отката), см. `ci_local` в `docs/handoff/T-0616.pr-handoff.json` для точных чисел
прогона.

## 2. Отвергнутые альтернативы

1. **Оставить `fallbackDefinitionName`'s `"telLinear"` спецкейс, убрать только
   `DEFAULT_PROC_KEY`'s значение (сделать его каким-нибудь ДРУГИМ реальным
   ключом).** Отвергнуто — заменяет одну заимствованную личность другой, не решает
   корень (F-2 явно про то, что дефолт НЕ должен быть именем какого-либо
   КОНКРЕТНОГО реального процесса, каким бы он ни был).
2. **Убрать `DEFAULT_PROC_KEY`-fallback совсем (кидать/фильтровать строки без
   `proc_key`).** Отвергнуто — вне периметра F-2 (который про честность значения
   fallback-а, не про то, нужен ли сам fallback); строки без `proc_key`
   — legacy-путь, не должны 500-ть или молча выпадать из проекции (тот же honest-
   degrade принцип, что и остальной модуль).
3. **Оставить `fallbackDefinitionName`'s спецкейс, но расширить его на ВСЕ реальные
   seed-ключи с честными переводами (telLinear → …, purchaseApproval → …).**
   Отвергнуто — это НАРАЩИВАНИЕ кейс-хардкода (больше спецкейсов), ровно
   противоположное направлению D-064; функция уже имеет честный generic fallback
   (echo ключа) для любого ключа без modeler-строки — специальные переводы, если
   они нужны, принадлежат `choros.process_definition.name` (реальная modeler
   запись), не платформенному коду.
4. **Пин F-1 через unit-тест (fake pool), не через db-тест.** Отвергнуто —
   ревьюер САМ показал (МУТПРОБА B), что unit fake-pool матчит запрос по ТЕКСТУ и
   игнорирует `WHERE`-условие целиком; только живой Postgres с реальным RLS +
   реальным `WHERE`-планом ловит эту мутацию.

## 3. Fitness-функции и трассируемость

| FF | Правило | CI-чек |
|----|---------|--------|
| FF-1 | `fallbackDefinitionName` не содержит спецкейса ни для одного значения ключа (echo-only) | `src/__tests__/process-catalog-view.test.ts` — `fallbackDefinitionName("telLinear") === "telLinear"` |
| FF-2 | repo-wide code-only count литерала `telLinear` строго не растёт (эрозия приветствуется) | `bash ci/checks/anti-case-lock.sh` (Phase 2) — count 3→1, baseline обновлён в `ci/checks/data/anti-case-baseline.json` |
| FF-3 | `resolveDefinitionNames` возвращает ТОЛЬКО собственное имя тенанта для общего `process_key`, никогда чужое | `ci/checks/db/process-projection.test.ts` — `T-0616 [F-1]` describe-блок, живой Postgres |

Трассируемость: AC-1/AC-3 (спека) ↔ FF-1/FF-2; AC-2 ↔ `DEFAULT_PROC_KEY` echo
(тот же FF-1 покрывает косвенно — `process-catalog-view.test.ts` пинит функцию,
`processes-live-instances.test.ts`'s AC-2 тест пинит end-to-end путь через неё);
AC-4/AC-5 ↔ FF-3.

## 4. Follow-up (не в этой задаче)

- **O-fb1** — `DEFAULT_PROC_KEY`-ветка (`payload` без `proc_key`) технически
  недостижима с текущего write-half (безусловная запись `proc_key: args.procKey`
  на каждом emit-сайте — grep `proc_key: args.procKey` /
  `procKey: strField(payload, "proc_key", DEFAULT_PROC_KEY)`, 7 использований,
  все за уже-записанным `proc_key`). Явное удаление этой ветки (сделать `procKey`
  обязательным полем payload, падать явной ошибкой на его отсутствии вместо
  honest-degrade) — отдельный follow-up, не в периметре этого nit-фикса.

## 5. Эскалация

Нет. Чисто READ-путь honest-fallback переименования + один regression-pin
db-тест; никакого нового write-пути, никакого нового authority-предиката,
`display-plane-purity` `processes.ts` не затронута (правка целиком в
`process-projection.ts`/`process-catalog-view.ts`, оба уже `pg`-несущие/pure-core
модули по своему исходному контракту).
