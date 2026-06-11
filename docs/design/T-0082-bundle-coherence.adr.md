# ADR · T-0082 — E12.1: Bundle Coherence Unit + CI Guard

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Spec:** `docs/specs/T-0082-bundle-coherence.spec.md` (status: ready, 703a608, no blocking)
**Raw model:** `docs/design/extensibility-and-authoring.md` §7 (единица версионирования + связка) / §9.4 (блокирующий CI-гард когерентности) / §11 (секвенирование)
**Parent:** T-0071 (E12) · **Deps:** T-0014, T-0018, T-0027, T-0087 (parallel, non-conflict)
**Consumed by:** T-0077, T-0084, T-0130

---

## 1. Контекст и центральное напряжение

ADR §7 описывает **целевое** состояние: git-под-капотом, content-addressed когерентный
коммит пятичленной связки **BPMN ↔ форма-код ↔ form-JSON-Schema ↔ object-schema ↔
role/agent/MCP-grants**. §9.4 называет блокирующий CI-тест на когерентность связки
guard'ом #4 из 10 day-1 гардов: «баг в самой системе версионирования = та
security-регрессия, которую механизм призван предотвратить».

Но фактическое состояние репо (migrations/001..043, сверено): только **два** из пяти
членов материализованы как Choros-таблицы — `registry_def.record_schema` (object-schema,
004) и `choros."grant"` (grants, 008). BPMN живёт в Flowable-движке; form-код и
form-JSON-Schema таблиц не имеют вообще. Полная пятичленная git-когерентность «за один
ход» физически невозможна — нет объектов, которые она когерентила бы.

**Архитектурное следствие (соразмерность, рубрика ось 5):** day-1 — это НЕ
git-под-капотом и НЕ новые таблицы. Day-1 — это **периметр**: формальный машинно-читаемый
реестр «что есть bundle», статический fail-closed CI-гард над двумя существующими членами
+ делегация BPMN-члена уже существующему `bpmn-linter-isolation.sh` (T-0027), и **явный
deferral-контракт**, который превращает «недостающие члены» из молчаливой дыры в
зафиксированное обязательство: любая будущая задача, добавляющая form-def/bpmn-def-таблицу,
ОБЯЗАНА расширить реестр и пройти гард. Это §11-рекомендация дословно: «сначала Floor-1 +
drain-default + логические среды + **bundle-coherence CI-гард**; полная git+migration
машинерия — инкрементально».

---

## 2. Решение (механизм)

**Реестр-как-данные + bash-fitness-гард + deferral-контракт.** Три новых аддитивных файла,
ноль изменений существующих:

1. **`ci/checks/bundle_members.txt`** — TSV-реестр членов связки, единственный источник
   истины о составе bundle. 5 строк (2 `choros_table` + 3 `external`). Формат строки —
   замороженный контракт (см. §4.1). Человеко-читаем, `#`-комментарии.

2. **`ci/checks/bundle-coherence.sh`** — единая исполняемая точка входа, fail-closed.
   Парсит реестр, для каждого `choros_table`-члена статически проверяет существование
   таблицы (в `known_tenant_tables.txt`) и инвариант DDL в соответствующей migration;
   делегирует BPMN-член в `bpmn-linter-isolation.sh`; для каждого `external`-члена логирует
   `[bundle-deferred] …` и НЕ падает. Exit 0 = весь периметр когерентен, exit 1 = любой
   член связки потерял свой инвариант. Знает только о структуре связки — **ничего** о
   tier-семантике T-0087 (NF-3).

3. **`docs/design/T-0082-bundle-deferral-contract.md`** — explicit deferral contract,
   аналог `T-0027-bpmn-linter-deploy-contract`. Фиксирует, какие члены отсутствуют, и
   правило промоушна `external → choros_table` как требование DoD будущих задач.

Wiring: `bundle-coherence.sh` добавляется в конец `package.json`-скрипта `fitness` (его
уже гоняет `npm run ci` как blocking gate в `.github/workflows/ci.yml`, job `ci`, строка
24). Live-DB проверки (FR-2/FR-3) — отдельный vitest-файл `ci/checks/db/bundle-coherence.test.ts`,
который подхватывает `npm run fitness:db` (job `db`, строка 63) по образцу `cross_tenant.test.ts`.

**Почему именно так — соразмерность.** Связка сегодня = 2 живых члена + 3 указателя.
Реестр-как-данные делает периметр явным и расширяемым строкой TSV (не кодом); bash-гард
переиспользует ровно ту же машинерию, что 50+ существующих fitness-чеков (zero new dep,
NF-1); deferral-контракт несёт всю target-state-семантику git-под-капотом БЕЗ единой
строки преждевременной реализации. Гард — статический (grep по migration DDL + реестру),
поэтому проходит в чистом worktree без БД (AC-2); live-инварианты (parse-валидность JSON,
непустой facet) живут в DB-тесте, который запускается только когда БД есть (AC-12/13).

---

## 3. Отвергнутые альтернативы

| Опция | Почему нет |
|---|---|
| Реализовать git-под-капотом (content-addressed bundle commit) day-1 | Нет объектов для когерентности — form-def/bpmn-def-таблиц не существует. §11 явно секвенирует это «инкрементально после Floor-1». Преждевременно, нарушает соразмерность (ось 5). |
| Создать таблицы `form_def`/`form_schema`/`process_bundle`, чтобы связка стала «настоящей» пятичленной | Out-of-scope спеки §5; требует отдельного ADR+build-task; раздувает T-0082 далеко за периметр-гард. SPEC §0 прямо запрещает. |
| Захардкодить список членов связки прямо в `bundle-coherence.sh` | Состав связки — данные, не логика. Хардкод заставляет менять исполняемый гард при каждом новом artifact-типе; реестр-как-TSV расширяется строкой и человеко-читаем (NF-6), а гард остаётся стабильным. |
| TS/vitest-реализация всего гарда (включая статику) | Статические проверки (существование таблицы в реестре, grep DDL) не нуждаются в БД; гонять их через vitest заставило бы тащить tsc-build перед каждым static-чеком и не дало бы exit-0-в-чистом-worktree (AC-2). Bash-гард соответствует существующему паттерну 50+ чеков и NF-1. |
| Скопировать инвариант BPMN-линтера внутрь bundle-coherence.sh | Дублирование границы T-0027 → дрейф двух копий. Делегация (`bash bpmn-linter-isolation.sh`, проброс exit-кода) инкапсулирует BPMN-член без копирования логики (FR-4). |
| Включить tier-проверку в bundle-coherence (раз уж tier — на тех же таблицах) | Граница ответственности: tier — зона T-0087. Смешение моделей = связанность двух параллельных задач и нарушение NF-3. AC-11 запрещает токены `tier/draft/published` в гарде дословно. |
| Fail-open на отсутствующем/битом `bundle_members.txt` (skip-and-continue) | Гард когерентности, который молча пропускает себя при битом реестре, — это та самая дыра в системе версионирования, что §9.4 называет security-регрессией. Fail-closed обязателен (NF-4). |

---

## 4. Объектная модель / контракты

### 4.1 `bundle_members.txt` — формат строки (ЗАМОРОЖЕННЫЙ контракт)

Один член связки на строку. Пять `|`-разделённых полей, без пробелов вокруг `|`.
Строки, начинающиеся с `#`, и пустые строки игнорируются парсером.

```
name|kind|source|table_or_path|key_column
```

| Поле | Тип | Семантика |
|---|---|---|
| `name` | slug | Стабильный идентификатор члена связки (`object-schema`, `grants`, `bpmn-process`, `form-code`, `form-json-schema`). |
| `kind` | enum `choros_table \| external` | `choros_table` — материализован как таблица Choros, подлежит статической проверке существования+DDL. `external` — в Flowable или ещё не существует; deferral. |
| `source` | path \| token | Для `choros_table`: путь migration (`migrations/004_registry_def.sql`). Для `external`: `flowable-engine` или `deferred`. |
| `table_or_path` | identifier \| `—` | Для `choros_table`: имя таблицы (должно присутствовать в `known_tenant_tables.txt`). Для `external`: путь/API или `—`. |
| `key_column` | identifier \| `—` | Для `choros_table`: ключевой столбец, несущий инвариант члена (`record_schema`, `resource_type`). Для `external`: `—`. |

**Минимальный обязательный состав (≥5 строк, AC-1):**

```
object-schema|choros_table|migrations/004_registry_def.sql|registry_def|record_schema
grants|choros_table|migrations/008_grant.sql|grant|resource_type
bpmn-process|external|flowable-engine|deployments-api|—
form-code|external|deferred|—|—
form-json-schema|external|deferred|—|—
```

> Инвариант контракта: строка `object-schema` обязана присутствовать; её удаление —
> моделируемая поломка (AC-9), на которой гард обязан дать exit 1.

### 4.2 `bundle-coherence.sh` — сигнатура и контракт исполнения

```
bundle-coherence.sh [MEMBERS_FILE]
  MEMBERS_FILE  optional, default = $SCRIPT_DIR/bundle_members.txt
  stdout: PASS/FAIL/[bundle-deferred] строки (человеко-читаемо)
  exit 0  — все choros_table-члены прошли существование+DDL-инвариант,
            делегированный bpmn-linter прошёл, реестр валиден
  exit 1  — отсутствует реестр | битый формат строки | отсутствует таблица/DDL-инвариант
            choros_table-члена | bpmn-linter-isolation.sh вернул ненуль
```

Аргумент `MEMBERS_FILE` (переопределяемый путь реестра) — контракт для AC-9: тест
подсовывает заведомо сломанный реестр и ожидает exit 1, не трогая боевой файл.

**Алгоритм (псевдокод, реализует coder):**

```
set -euo pipefail
MEMBERS_FILE = ${1:-$SCRIPT_DIR/bundle_members.txt}
ERRORS=0
[[ -f $MEMBERS_FILE ]] || { echo "FAIL: registry missing"; exit 1; }   # NF-4 fail-closed
for line in (non-#, non-empty lines of MEMBERS_FILE):
    split into name|kind|source|table_or_path|key_column   # ровно 5 полей или FAIL (NF-4)
    case kind in
      choros_table:
        # (b) таблица в реестре известных таблиц
        grep -qx "$table_or_path" $SCRIPT_DIR/known_tenant_tables.txt  || FAIL
        # (c) DDL-инвариант члена в его migration (whitespace-tolerant: [[:space:]]+)
        case name in
          object-schema:  grep -Eq 'record_schema[[:space:]]+jsonb[[:space:]]+NOT[[:space:]]+NULL' $source  || FAIL   # AC-3
          grants:         grep -Eq 'CREATE TABLE[[:space:]]+choros\."grant"' $source
                          && grep -Eq 'resource_type[[:space:]]+text[[:space:]]+NOT[[:space:]]+NULL' $source || FAIL    # AC-4
        esac
      external:
        echo "[bundle-deferred] $name: see docs/design/T-0082-bundle-deferral-contract.md"   # AC-6, НЕ ERROR
    esac
# (e) делегация BPMN-члена в T-0027
bash $SCRIPT_DIR/bpmn-linter-isolation.sh || ERRORS++    # AC-5: проброс ненуля
[[ $ERRORS -eq 0 ]] && exit 0 || exit 1
```

> DDL-grep'ы **whitespace-tolerant** (`[[:space:]]+`): migration 004 содержит
> `record_schema  jsonb NOT NULL` (двойной пробел), 008 — `resource_type  text NOT NULL`.
> Хрупкий single-space grep дал бы ложный красный. Это load-bearing деталь контракта.

### 4.3 `ci/checks/db/bundle-coherence.test.ts` — live-DB контракт (FR-2/FR-3)

Vitest по образцу `cross_tenant.test.ts`, подключается через `migratorUrl()` (чтение
метаданных, RLS не релевантен), импортирует хелперы из `./_helpers.js`. Skip-friendly:
если БД недоступна — тест не должен валить static-pipeline (он в job `db`, не в `ci`).

| Тест | Инвариант | AC |
|---|---|---|
| FR-2 | для каждой строки `choros.registry_def`: `record_schema` парсится как JSON и его корень — объект (`JSON.parse` не бросает, `typeof === 'object'`) | AC-12 |
| FR-3 | для каждого `choros."grant"` с `resource_type = 'record'`: `resource_facet IS NOT NULL` | AC-13 |

> Тонкость FR-3: столбец `resource_facet` объявлен `jsonb NULL` (008). Это НЕ ослабление —
> инвариант намеренно сильнее схемы: «grant на конкретную запись без указания, на какую
> registry/record он ссылается» = висячий грант, та самая object-schema↔grant-десинхронизация
> из §7. Тест ловит её на данных, чего БД-констрейнт (nullable) не делает.

### 4.4 Компатибилити-поверхность (architect rule 7 / FE-W23-0008)

T-0082 **не меняет ни одного экспорта, сигнатуры или пути модуля** — только добавляет
файлы. Импортёров ломать нечем. Единственная точка интеграции с чужим кодом —
**вызов** `bpmn-linter-isolation.sh` как чёрного ящика по его публичному контракту
(exit-код). Этот контракт T-0082 трактует как замороженный: гард зависит только от
«0 = чисто, ненуль = нарушение», не от внутренностей. Файлы T-0087 (`tier_bearing_tables.txt`,
`tier-isolation.sh`) на базе dev@83c9c7c **не существуют** — T-0082 их не создаёт и не
ссылается (чистый шов, AC-10).

---

## 5. Fitness-функции

| id | rule | ci_check |
|---|---|---|
| FF-1 | `bundle_members.txt` существует, ≥5 строк-членов; каждая `choros_table`-строка имеет непустые `table_or_path` и `key_column`; каждая `external`-строка присутствует с записью о deferral | `bundle-coherence.sh` парсит реестр fail-closed; кол-во не-#-строк ≥5; bash-проверка пустых полей у choros_table-строк |
| FF-2 | `bundle-coherence.sh` исполняем (`chmod +x`), в чистом worktree без БД завершается exit 0 на статических проверках | `bash ci/checks/bundle-coherence.sh` в `npm run fitness` (job `ci`, без сервиса postgres) → exit 0 |
| FF-3 | object-schema-член когерентен: `registry_def` ∈ `known_tenant_tables.txt` И migration 004 содержит `record_schema … jsonb … NOT NULL` (whitespace-tolerant); отсутствие любого → exit 1 | `bundle-coherence.sh`: `grep -qx registry_def known_tenant_tables.txt` + `grep -E 'record_schema[[:space:]]+jsonb[[:space:]]+NOT[[:space:]]+NULL' migrations/004_registry_def.sql` |
| FF-4 | grants-член когерентен: migration 008 содержит `CREATE TABLE choros."grant"` И `resource_type … text … NOT NULL`; отсутствие → exit 1 | `bundle-coherence.sh`: `grep -E 'CREATE TABLE[[:space:]]+choros\."grant"'` + `grep -E 'resource_type[[:space:]]+text[[:space:]]+NOT[[:space:]]+NULL'` по 008 |
| FF-5 | BPMN-член делегирован: `bundle-coherence.sh` вызывает `bpmn-linter-isolation.sh` и пробрасывает его ненулевой exit | `bundle-coherence.sh` содержит `bash …/bpmn-linter-isolation.sh \|\| ERRORS++`; интеграционно — подмена линтера на падающий стаб даёт ненуль bundle-гарда |
| FF-6 | external-члены не являются ошибкой: для каждого логируется `[bundle-deferred] <name>: …` и exit остаётся 0 | `bundle-coherence.sh` на корректном реестре печатает ≥3 `[bundle-deferred]` строки и завершается 0 |
| FF-7 | deferral-контракт существует и содержит секцию «Deferred members» с form-code, form-json-schema, BPMN-def и условием промоушна `external→choros_table` | `grep -q 'Deferred members' docs/design/T-0082-bundle-deferral-contract.md` + grep по трём именам + по фразе условия |
| FF-8 | wiring: `package.json` `fitness` вызывает `bundle-coherence.sh`; `ci.yml` гоняет этот скрипт как blocking (через уже существующий `npm run ci`) | `grep -q bundle-coherence.sh package.json` + `ci.yml` job `ci` шаг `npm run ci` (наследует) |
| FF-9 | fail-closed на сломанном реестре: гард с реестром без строки `object-schema` (через `MEMBERS_FILE`-аргумент) завершается exit 1 | DB/integration или dedicated bash-кейс: `bundle-coherence.sh /tmp/broken_members.txt` → exit 1 (AC-9) |
| FF-10 | T-0087 non-conflict: `known_tenant_tables.txt`, `bpmn-linter-isolation.sh`, `tier_bearing_tables.txt`, `tier-isolation.sh` не изменены/не созданы T-0082 | `git diff --name-only HEAD` (после T-0082) не содержит этих путей; первых двух — байт-идентичны базе, вторых двух — отсутствуют |
| FF-11 | tier-изоляция: `bundle-coherence.sh` не содержит токенов `tier`, `draft`, `published` | `grep -Evi 'tier\|draft\|published'`-инвариант: `! grep -Eiq '\b(tier\|draft\|published)\b' ci/checks/bundle-coherence.sh` |
| FF-12 | живая object-schema валидна: каждый `registry_def.record_schema` в `choros` — parse-валидный JSON-объект | `ci/checks/db/bundle-coherence.test.ts` (vitest, `npm run fitness:db`) — итерация по строкам, `JSON.parse` не бросает (AC-12) |
| FF-13 | живая grant-referential sanity: каждый `grant` с `resource_type='record'` имеет `resource_facet IS NOT NULL` | `ci/checks/db/bundle-coherence.test.ts` — SQL `WHERE resource_type='record' AND resource_facet IS NULL` даёт 0 строк (AC-13) |
| FF-14 | frozen public surface: `git diff --name-only` не затрагивает `src/core/grant-lattice.ts`, `src/core/types.ts`, `src/core/flowable-client.ts`, `src/core/bpmn-linter.ts` | `git diff --name-only HEAD` ∩ {эти 4 пути} = ∅ (architect rule 7, AC-14) |

---

## 6. Трассировка (каждый AC → место в дизайне)

| AC | covered_by |
|---|---|
| AC-1 | §4.1 формат строки + минимальный состав (5 строк) + FF-1 |
| AC-2 | §2 static-гард exit-0-в-чистом-worktree + §4.2 алгоритм + FF-2 |
| AC-3 | §4.2 case object-schema (known_tenant_tables + DDL-grep 004, whitespace-tolerant) + FF-3 |
| AC-4 | §4.2 case grants (CREATE TABLE choros."grant" + resource_type DDL-grep 008) + FF-4 |
| AC-5 | §4.2 делегация `bash bpmn-linter-isolation.sh \|\| ERRORS++` + §4.4 black-box контракт + FF-5 |
| AC-6 | §4.2 case external → `[bundle-deferred]` лог, не ERROR + FF-6 |
| AC-7 | §2(3) deferral-контракт + §4.4 + FF-7 (и сам файл T-0082-bundle-deferral-contract.md) |
| AC-8 | §2 wiring (package.json fitness + ci.yml job ci `npm run ci`) + FF-8 |
| AC-9 | §4.2 `MEMBERS_FILE`-аргумент + fail-closed на отсутствии object-schema-строки + FF-9 |
| AC-10 | §4.4 чистый шов: 4 T-0087-файла неизменны/несозданы + FF-10 |
| AC-11 | §2 «знает только структуру связки, ничего о tier» + §4.2 запрет токенов + FF-11 |
| AC-12 | §4.3 FR-2 live JSON-parse-валидность record_schema + FF-12 |
| AC-13 | §4.3 FR-3 live resource_facet NOT NULL при resource_type='record' + FF-13 |
| AC-14 | §4.4 компатибилити-поверхность (zero export change) + FF-14 |

---

## 7. Граница с T-0087 (adversarial, спека §8)

| Инвариант | Покрытие |
|---|---|
| T-0082 не добавляет tier к таблицам | FF-10 (known_tenant_tables.txt байт-неизменён; миграций T-0082 не пишет) |
| T-0082 не вызывает assertWritable / decidePromote / artifacts.ts | FF-14 (frozen surface) + §2 (ни строки реализации tier-модели) |
| bundle-coherence.sh не знает tier-семантики | FF-11 (запрет токенов tier/draft/published) |
| Promote в T-0087 не ломает bundle-coherence | Гард статичен над DDL/реестром, ортогонален tier-колонкам → проходит ПОСЛЕ merge T-0087 без изменений; live-тест читает только record_schema/resource_facet, не tier |

T-0087-файлы (`tier_bearing_tables.txt`, `tier-isolation.sh`) на базе dev@83c9c7c
отсутствуют. T-0082 их **не создаёт** — это зона T-0087; чистый шов сохраняется.

---

## 8. Runtime / deploy-таргет

**Локально.** Весь day-1-периметр исполняется в CI-раннере и локально через `npm run ci`
(статический гард, job `ci`) и `npm run fitness:db` (live-инварианты, job `db` с postgres:16
service-контейнером, уже сконфигурирован). Никаких новых внешних ресурсов, серверов,
БД-хостинга или npm-зависимостей (NF-1). Провижн не требуется → **GT-4 не задействован**.

---

## 9. Эскалация

Нет. Решение соразмерно (периметр-гард + реестр + deferral, НЕ git-под-капотом), не
меняет направление продукта, не требует кросс-вендор-спарринга. Высоколеверажный
target-state (git-под-капотом, form-def-таблицы, семантический changelog) **явно
отложен** через deferral-контракт и отдельные задачи (T-0084 и будущие build-tasks),
а не решается здесь. SPEC ready без blocking; продуктовая петля не нужна.
