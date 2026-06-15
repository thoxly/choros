# ADR · T-0232 — Авто-санкция аддитивных Враг-verified frozen-thaw

**Status:** ready
**Phase:** DESIGN
**Date:** 2026-06-15
**Task:** T-0232 — «Авто-санкция аддитивных Враг-verified frozen-thaw — убрать фаундера из рутинных верифицированных правок security-ядра (D-060)»
**Spec:** `docs/specs/T-0232-auto-sanction-additive-thaw.spec.md` (13 AC, status ready)
**Authoritative source:** `docs/decisions.md` D-060 (ратифицировано 2026-06-15), риппл-1 (choros)
**Guardrails не нарушать:** D-026 (агент не ослабляет свои guardrails) · D-007 (≠ самооценка; нужен независимый верификатор) · D-054/D-053 (конверт frozen-sanction) · NF-4 (нет нового auth-root, T-0146 не ослаблен).

---

## 1. Решение (одним абзацем)

Вводим **второй класс санкции** в канал `ci/checks/data/frozen-sanctions.jsonl` —
`auto_additive` — рядом с существующим `founder`-классом (T-0199). Логика классификации
живёт в **отдельном владеемом-T-0232 чеке `ci/checks/auto-sanction-additive.sh`**, который
мета-гейт `frozen-checks-immutable.sh` **вызывает** при встрече auto-санкционной строки;
сам мета-гейт получает строго аддитивную правку (новая ветка `elif` рядом с FF-FCI12). Для
строки `auto_additive` решение «пропустить чужой frozen-чек» принимается ТОЛЬКО если: (a) чек
аддитивности **сам, независимо** доказывает, что КАЖДЫЙ затронутый под санкцию файл аддитивен
против BASE_REF по правилу A-1..A-4 (gate НЕ верит маркеру строки — D-007), И (b) в строке
присутствует валидная **Враг-аттестация** (машинно-сверяемая ссылка на детерминированный
корпус Врага + зелёный enemy-сегмент `npm run fitness` на этом коммите). Деструктивный/редуктивный
thaw, поданный как `auto_additive`, краснит проверку аддитивности → FAIL → откатывается к
`founder`-классу (D-060 граница). Существующий `founder`-путь (T-0085, T-0227) байт-эквивалентен.

---

## 2. Два вопроса спеки — решения architect

### Q1 — где живёт логика аддитивности

**Решение: отдельный чек `ci/checks/auto-sanction-additive.sh` (владелец T-0232), который мета-гейт ВЫЗЫВАЕТ. НЕ инлайн в `frozen-checks-immutable.sh`.**

**Почему:**
- **NF-4 / OOS-6.** Инлайн раздул бы frozen-файл T-0146 содержательной логикой парсинга диффа
  — это деструктивно-крупная правка чужого frozen-чека. Отдельный чек, владеемый T-0232,
  само-защищается мета-гейтом T-0146 (тот сторожит ВСЕ `ci/checks/*.sh`, включая новый), без
  введения нового trust-root и без ослабления T-0146.
- **Соразмерность / тонкое ядро (рубрика ось 5, CONCEPT §5).** Мета-гейт остаётся тонким
  диспетчером классов; вся «толстая» машинерия A-1..A-4 — на границе, в собственном файле с
  собственным `--self-test`. Это зеркалит уже принятый паттерн: `catalog-frozen.sh` и
  `corpus-append-only.sh` — отдельные владеемые чеки, НЕ инлайн в мета-гейте.
- **Тестируемость.** Отдельный файл несёт изолированный `--self-test`, бьющий обе стороны
  (AC-1..AC-5), не таща за собой весь мета-гейт.

**Цена — bootstrap-правка мета-гейта (одноразовый founder-санкционированный thaw).** Чтобы
мета-гейт начал распознавать класс `auto_additive` и делегировать, в `frozen-checks-immutable.sh`
надо добавить одну `elif`-ветку (вызов делегата). Это правка ЧУЖОГО frozen-чека (владелец T-0146),
сама по себе **аддитивная** (новая ветка рядом, founder-путь байт-эквивалентен) — но по `--self-bind`
парадоксу её НЕ может авто-санкционировать механизм, который она же и вводит. Поэтому: **первая,
bootstrap-правка `frozen-checks-immutable.sh` санкционируется ОДИН раз `founder`-классом** (строка
`{"task":"T-0232","file":"ci/checks/frozen-checks-immutable.sh","owner":"T-0146","sanctioned_by":"founder",...}`
→ `founder_decide`). После этого механизм auto-санкции живой и сам обслуживает БУДУЩИЕ аддитивные
thaw без фаундера. Это согласуется с §8 спеки (правка мета-гейта = разрешённый вопрос, не блокер)
и D-060 (саму инфраструктуру авто-санкции вводит фаундер; дальше она работает сама).

> Координат-нота для coder: bootstrap-строка `founder`-класса на `frozen-checks-immutable.sh`
> — это `founder_decide`-гейт (GT-уровень), а не код. coder помечает в preflight, что нужна
> founder-строка ДО мержа в dev; до её появления fitness на ветке T-0232 краснит FF-FCI1 на
> правке мета-гейта (ожидаемо). Это единственный человек-в-петле во всей задаче — одноразовый
> и по делу (вводим новый класс санкции = продуктовое решение D-060, уже ратифицировано).

### Q2 — форма Враг-аттестации

**Решение: аттестация = поле(я) В auto-additive-строке `frozen-sanctions.jsonl`, машинно-сверяемое против детерминированного корпуса Врага + факта зелёного enemy-сегмента в той же цепочке `npm run fitness`. НЕ отдельный артефакт-файл.**

Форма (см. §5 object-model): строка несёт `"vrag_attestation":{...}` с полями `families` (множество
семей инвариантов Врага, покрывающих затронутую поверхность), `corpus_ref` (commit-sha корпуса
`src/__tests__/enemy/corpus/corpus.jsonl` на момент аттестации — детерминированный якорь),
`enemy_segment` (имя зелёного enemy-сегмента — `enemy.adversarial.test.ts` + `enemy/*` чеки),
`attested_at` (метка). Сверка делегата:
1. **Семья покрывает поверхность.** `families` непусто и каждая семья присутствует в каталоге
   инвариантов Врага (`docs/design/T-0152-security-invariants-catalog.md`, тот же набор, что
   сторожит `catalog-frozen.sh`). Семья, которой нет в каталоге → аттестация невалидна.
2. **Корпус-якорь существует и достижим.** `corpus_ref` указывает на коммит, в котором
   `corpus.jsonl` присутствует (`git cat-file -e <corpus_ref>:<corpus_rel>`); корпус не подделать
   без зелёного Врага, т.к. `corpus-append-only.sh` (T-0154) уже сторожит его append-only в той же
   цепочке fitness.
3. **Зелёность Врага — структурно гарантирована цепочкой, не повторно прогоняется делегатом
   (FR-3, OOS-2).** `enemy/*` чеки + `enemy.adversarial.test.ts` УЖЕ в `npm run fitness`/`ci` и
   обязаны пройти на том же прогоне; делегат лишь СВЕРЯЕТ присутствие+форму аттестации (это и есть
   «независимое подтверждение» — Враг бьёт surface, аттестация привязывает её к конкретному thaw),
   не дублируя прогон.

**Почему не отдельный файл:** канал санкций уже append-only и аудируем (NF-2/NF-5); добавлять
второй артефакт = вторая поверхность для рассинхрона. Поле в строке держит «что санкционировано»
и «чем подтверждено» в ОДНОЙ append-only записи, видимой фаундеру постфактум (NF-5). Подделать поле
без зелёного Врага нельзя: семья сверяется с frozen-каталогом, корпус — с append-only-якорем, а сам
enemy-сегмент должен быть зелёным в том же fitness-прогоне, иначе мерж в dev не пройдёт (D-056).

---

## 3. Отвергнутые альтернативы

| Вариант | Почему нет |
|---|---|
| **Инлайн A-1..A-4 в `frozen-checks-immutable.sh`** | Раздувает frozen-файл T-0146 толстой логикой → деструктивная правка чужого чека, против NF-4/OOS-6; ломает тонкое ядро (ось 5). |
| **Отдельный артефакт-файл аттестации (`ci/checks/data/vrag-attestations/<task>.json`)** | Вторая append-only поверхность → рассинхрон с jsonl; не несёт ценности сверх поля в строке; больше surface для подделки. |
| **Гейт ВЕРИТ маркеру `sanctioned_by:auto_additive` без ре-верификации A-1..A-4** | Прямое нарушение D-007 (самооценка) — оркестратор подписал бы сам себе деструктивный thaw. Гейт ОБЯЗАН независимо доказать аддитивность. |
| **Делегат повторно прогоняет Врага (enemy-тесты) внутри себя** | Нарушает NF-1 (offline/детерминизм без БД/сети — Враг гоняет surface), дублирует уже-в-цепочке сегмент, медленно. Враг гоняется ОДИН раз в fitness; делегат сверяет аттестацию. |
| **Семантический доказатель эквивалентности прав (вместо Врага)** | OOS-5: статанализ не докажет «новый enum-член = всё разрешено»; достаточность даёт именно Враг. A-1..A-4 — необходимое, зелёный Враг — достаточное (D-007). |
| **Расширить control-plane `founder_decide` новым тихим режимом** | OOS-3: не трогаем founder_decide тул; класс различается в data-файле, не в control-plane. |

---

## 4. Машинно-проверяемое определение «аддитивного thaw» (A-1..A-4, крус)

Якорь — **BASE_REF** (merge-base с `dev`/`origin/dev`), читается через `git show BASE_REF:f`,
НЕ рабочая копия (иначе аддитивность подделывается переписыванием файла; тот же приём, что
`corpus-append-only.sh`/`frozen-checks-immutable.sh` R-1). Для набора файлов `F` (затронутых под
auto-санкцию = файлы из диффа, для которых TASK_ID несёт auto-additive-строку) thaw **АДДИТИВЕН**
⟺ для КАЖДОГО `f ∈ F` одновременно:

- **A-1 (сохранение строк / «+»-only).** Каждая непустая не-комментарий строка BASE_REF-версии `f`
  присутствует в HEAD-версии `f` **байт-идентично**. `git diff BASE_REF HEAD -- f` не содержит ни
  одной содержательной `-`-строки (только `+`). Реализация-идиома: `grep -qxF` каждой base-строки в
  head (как `corpus-append-only.sh` FF-CORPUS1) ИЛИ проверка, что в `git diff --` нет `^-` по
  не-пустым/не-комментарий строкам.
- **A-2 (множество именованных сущностей не сужается).** `entities(BASE_REF:f) ⊆ entities(HEAD:f)`.
  «Именованная сущность» — в зависимости от поверхности: enum-член (`'foo'`), `ResourceType`-вид,
  семья инварианта, enforcement-ссылка. Множество растёт, не сужается (идиома `catalog-frozen.sh`
  FF-CAT1: `families base` ⊆ `families head`). Извлечение сущностей — настраиваемое (см. §6
  pluggable extractor), но дефолт — добавленные/существующие токены-идентификаторы в `+`/контекст-строках.
- **A-3 (нет смысловой мутации существующего).** Ни один существующий именованный член не
  переименован/переопределён/не сменил привязку. Операционализация через A-1 (существующая строка
  байт-frozen ⇒ её токен не мог сменить значение в самой строке) + A-2 (член не исчез). Доп.
  red-триггеры (грубый, но кусачий фильтр на содержимое `+`-дельты, бьющий очевидное ослабление):
  паттерны переноса дефолта `deny→allow`, расширения scope, флипа toggle на СУЩЕСТВУЮЩЕМ члене →
  если `+`-строка трогает существующий член с такими паттернами, FAIL. (Полнота — не цель; Враг
  закрывает остаток, §точность.)
- **A-4 (дельта = только новые сущности).** `delta = HEAD ∖ BASE_REF` (добавленные строки) состоит
  только из ДОБАВЛЕНИЯ новых сущностей; добавленное не дописывает элемент в существующий allowlist,
  расширяющий уже выданное право. Операционализация: каждая `+`-строка либо вводит НОВУЮ сущность
  (её токена нет в `entities(BASE_REF)`), либо чисто структурна (скобка/запятая/комментарий); `+`-строка,
  модифицирующая контекст СУЩЕСТВУЮЩЕЙ сущности через A-3-триггер → FAIL.

Если ЛЮБОЙ A-1..A-4 нарушен для ЛЮБОГО `f ∈ F` ⇒ thaw НЕ аддитивен ⇒ auto-санкция ОТКЛОНЕНА ⇒
founder-only.

**Граница точности (осознанный остаточный риск).** Проверка структурна (строки + множество имён),
не семантическая полнота. Класс «синтаксически-аддитивно, семантически расширяет право» (новый
enum-член, который PDP трактует как all-allow) закрывается ИМЕННО Врагом: **A-1..A-4 — НЕОБХОДИМОЕ
условие, зелёный adversarial-гейт T-0151 — ДОСТАТОЧНОЕ независимое подтверждение (D-007)**. Оба
обязательны; ни одного по отдельности недостаточно. Это прямой риппл D-060.

**Fail-open вне task-ветки.** На dev/main/non-task ветке или при отсутствии merge-base проверка —
no-op (exit 0), как все frozen-чеки (FF-FCI3/FF-CORPUS3/FF-CAT3): вне task-ветки нечего санкционировать.

---

## 5. Объектная модель / контракты

### 5.1 Запись санкции `frozen-sanctions.jsonl` (append-only, компактный JSON, одна строка)

**Существующий `founder`-класс (T-0199, НЕ менять, FR-6):**
```json
{"task":"T-0085","file":"ci/checks/...","owner":"T-0040","decision":"founder_decide@2026-06-14","sanctioned_by":"founder","note":"..."}
```

**Новый `auto_additive`-класс (T-0232):**
```json
{"task":"T-0232","file":"ci/checks/mutation-gateway-isolation.sh","owner":"T-0028","sanctioned_by":"auto_additive","vrag_attestation":{"families":["OBJECT-HANDLE-ISO","GRANT-ESCALATION"],"corpus_ref":"<sha>","enemy_segment":"enemy.adversarial.test.ts","attested_at":"2026-06-15"},"additive_basis":"A-1..A-4 over BASE_REF","note":"..."}
```

Поля (entity = **sanction_line**):

| name | type | примечание |
|---|---|---|
| `task` | string `T-NNNN` | санкционируемая задача (как сегодня) |
| `file` | string `ci/checks/...` | чужой frozen-чек/защищаемая поверхность (как сегодня) |
| `owner` | string `T-NNNN` | владелец чужого чека (BASE_REF header) |
| `sanctioned_by` | enum `"founder"\|"auto_additive"` | **класс-дискриминатор** (машинно-различим, FR-1/AC-7) |
| `decision` | string `founder_decide@DATE` | ТОЛЬКО для `founder`-класса (как сегодня) |
| `vrag_attestation` | object | ТОЛЬКО для `auto_additive`; см. ниже |
| `additive_basis` | string | человекочитаемая привязка к A-1..A-4 (аудит) |
| `note` | string | аудит-нота |

`vrag_attestation` (entity = **vrag_attestation**):

| name | type | примечание |
|---|---|---|
| `families` | string[] | семьи инвариантов Врага, покрывающие поверхность; ⊆ каталог T-0152 |
| `corpus_ref` | string (git sha) | детерминированный якорь корпуса (`corpus.jsonl` достижим на этом sha) |
| `enemy_segment` | string | имя зелёного enemy-сегмента (`enemy.adversarial.test.ts`) |
| `attested_at` | string (date) | метка |

### 5.2 Контракт делегата `ci/checks/auto-sanction-additive.sh`

```
# 2-я строка: "# T-0232 · auto-sanction-additive — машинная аддитивность A-1..A-4 + Враг-аттестация"
# (frozen-checks discipline: T-0146 защищает этот чек сам, AC-10)

# Режим verify (вызывается мета-гейтом):
#   auto-sanction-additive.sh --verify <TASK_ID> <file> <BASE_REF> [<sanction_json_line>]
#     exit 0  → аддитивность A-1..A-4 PASS И Враг-аттестация валидна → bypass РАЗРЕШЁН
#     exit 1  → аддитивность нарушена ИЛИ аттестация отсутствует/невалидна → bypass ЗАПРЕЩЁН
#                (вызывающий мета-гейт трактует как НЕ-санкционированный → FAIL/founder-only)
#     exit 2  → сломана машинерия чека

# Режим self-test:
#   auto-sanction-additive.sh --self-test   (AC-1..AC-5, чистый: git/grep/awk/diff, без БД/сети)

# Standalone live-режим (в npm run fitness, как sibling-чеки):
#   auto-sanction-additive.sh   → на task-ветке сверяет auto_additive-строки СВОЕЙ задачи; вне — no-op
```

Чистые функции (мирроринг `catalog-frozen.sh`/`corpus-append-only.sh`, драйвятся self-test'ом на синтетике):
- `verify_additive <base_file> <head_file>` → 0/1 (A-1..A-4 над двумя файлами; pure, без git).
- `entities <file>` → отсортированное множество именованных токенов (pluggable extractor, §6).
- `attestation_valid <sanction_json_line>` → 0/1 (поля присутствуют, `families` ⊆ каталог, `corpus_ref` достижим).

### 5.3 Контракт правки мета-гейта `frozen-checks-immutable.sh` (минимальная аддитивная)

В блоке классификации (`elif is_sanctioned`), РЯДОМ с существующей founder-веткой, добавить
auto-additive-ветку. Founder-путь байт-эквивалентен. Псевдо-дифф (только `+`):

```diff
   elif is_sanctioned "${f}"; then
-    echo "SANCTION [FF-FCI12]: ... FOUNDER frozen-sanction ... ALLOWED"
-    echo "AUDIT [FF-FCI12]: frozen-sanction GRANTED — task=... owner=... branch=..."
+    klass="$(sanction_class "${f}")"            # "founder" | "auto_additive"
+    if [[ "${klass}" == "auto_additive" ]]; then
+      if "${SCRIPT_DIR}/auto-sanction-additive.sh" --verify "${TASK_ID}" "${f}" "${BASE_REF}" "$(sanction_line "${f}")"; then
+        echo "SANCTION [FF-FCI13]: ${f} — ${TASK_ID} carries an AUTO-ADDITIVE frozen-sanction (A-1..A-4 PASS + Враг-аттестация) — modification ALLOWED"
+        echo "AUDIT [FF-FCI13]: auto-additive frozen-sanction GRANTED — task=${TASK_ID} file=${f} owner=${header_tid} class=auto_additive vrag=<families/corpus_ref> branch=${BRANCH}"
+      else
+        echo "FAIL [FF-FCI13]: ${f} — auto_additive sanction REJECTED (not additive OR Враг-attestation invalid); требуется founder-класс"
+        ERRORS=$((ERRORS + 1))
+      fi
+    else
+      echo "SANCTION [FF-FCI12]: ${f} — FOUNDER frozen-sanction — modification ALLOWED"   # founder-путь без изменений
+      echo "AUDIT [FF-FCI12]: frozen-sanction GRANTED — task=${TASK_ID} file=${f} owner=${header_tid} class=founder branch=${BRANCH}"
+    fi
```

`sanction_class`/`sanction_line` — два новых хелпера в мета-гейте, читают поле `sanctioned_by`/строку
из jsonl (по той же grep-логике, что `is_sanctioned`). FF-FCI12 (founder) — поведенчески
неизменён (FR-6/AC-5/AC-12); FF-FCI13 — новая ветка класса auto_additive.

> Маркер класса в AUDIT-строке делает классы машинно-различимыми постфактум (AC-7): `class=founder`
> vs `class=auto_additive` + `vrag=`-ссылка.

---

## 6. Pluggable entity extractor (соразмерность)

`entities <file>` дефолтно извлекает идентификатор-токены, НО защищаемые поверхности разнородны
(`.ts` enum vs `.sh` enforcement-список vs `.md` каталог). Чтобы не строить семантический парсер
на каждый язык (ось 5 — не переусложнять), extractor — **структурный, консервативный**:
- дефолт = множество кавыченных строк-литералов `'foo'`/`"foo"` и UPPER-CASE-токенов (как
  `catalog-frozen.sh` families), извлечённых из непустых не-комментарий строк;
- A-2 проверяет ⊆ на ЭТОМ множестве (консервативно: если extractor что-то не распознал как
  сущность, A-1 всё равно держит байт-сохранение строк — двойная страховка).

Это НАМЕРЕННО грубее семантики: достаточность даёт Враг (D-007). Extractor бьёт очевидные
структурные регрессии (удалён enum-член, мутирована строка), Враг — семантические (член-как-all-allow).

---

## 7. Поток (sequence, тезисами)

1. Оркестратор делает аддитивный thaw на task-ветке (напр. дописал `process_instance` в `ResourceType`).
2. `npm run fitness` гоняет полную цепочку, ВКЛЮЧАЯ enemy-сегмент (Враг) — он зелёный на surface.
3. Оркестратор аппендит `auto_additive`-строку в `frozen-sanctions.jsonl` (append-only) с
   `vrag_attestation` (семьи + corpus_ref + enemy_segment) — БЕЗ `founder_decide`, БЕЗ парковки в
   `awaiting_founder` (FR-4).
4. `frozen-checks-immutable.sh` на следующем прогоне видит чужой изменённый чек → `is_sanctioned`
   → класс `auto_additive` → ВЫЗЫВАЕТ `auto-sanction-additive.sh --verify`.
5. Делегат НЕЗАВИСИМО проверяет A-1..A-4 над BASE_REF→HEAD И валидность аттестации.
   - PASS → SANCTION+AUDIT (class=auto_additive), bypass разрешён, мерж в dev.
   - FAIL (деструктивно/нет аттестации) → ERRORS++, мета-гейт краснит → founder-only (D-060 граница).
6. Фаундер постфактум видит AUDIT-лог + jsonl-строку с классом и Враг-ссылкой (NF-5), может ретро-ревьюить.

---

## 8. Fitness-функции (CI as code)

| id | rule | ci_check |
|---|---|---|
| FF-ASA1 | Делегат `auto-sanction-additive.sh --verify` принимает чистый аддитивный thaw (только `+`-строки/новые сущности) с валидной Враг-аттестацией (exit 0). | `bash ci/checks/auto-sanction-additive.sh --self-test` (case A) |
| FF-ASA2 | Делегат ОТКЛОНЯЕТ thaw с удалённой существующей сущностью/строкой (A-2/A-1 краснит, exit 1). | `bash ci/checks/auto-sanction-additive.sh --self-test` (case B) |
| FF-ASA3 | Делегат ОТКЛОНЯЕТ thaw с мутацией/переопределением/scope-расширением существующего члена (A-1/A-3 краснит). | `bash ci/checks/auto-sanction-additive.sh --self-test` (case C) |
| FF-ASA4 | Делегат ОТКЛОНЯЕТ аддитивный thaw БЕЗ валидной Враг-аттестации (precondition Врага обязателен, FR-3). | `bash ci/checks/auto-sanction-additive.sh --self-test` (case D) |
| FF-ASA5 | На dev/main/non-task ветке или без merge-base делегат и standalone-режим — no-op (fail-open), как frozen-checks-immutable/corpus/catalog (FF-FCI3/FF-CORPUS3). | `bash ci/checks/auto-sanction-additive.sh` на dev (exit 0, INFO skip) |
| FF-ASA6 | Делегат зарегистрирован в `npm run fitness` (package.json) с `--self-test`; 2-я строка = `^# T-0232[[:space:]]·` (frozen-checks discipline → T-0146 сторожит его). | grep `auto-sanction-additive.sh` в package.json + `sed -n 2p` = `# T-0232 ·` |
| FF-FCI13 | Мета-гейт распознаёт класс `auto_additive` и ДЕЛЕГИРУЕТ верификацию `auto-sanction-additive.sh`; founder-класс (FF-FCI12) поведенчески неизменён (байт-эквивалентен). | `bash ci/checks/frozen-checks-immutable.sh` (founder-регрессия T-0085/T-0227 зелёная) + новая ветка покрыта hostile-probe |
| FF-ASA7 | Деструктивный thaw, поданный как `auto_additive` (нет founder-строки), НЕ проходит мета-гейт (exit 1); тот же thaw с founder-строкой — проходит (FR-5/AC-8). | `frozen-checks-immutable.sh` hostile-probe: синтетика destructive+auto_additive → FAIL; +founder-строка → PASS |
| FF-ASA8 | `frozen-sanctions.jsonl` append-only: существующие founder-строки (T-0085, T-0227) байт-сохранены; новый формат только аппендится (структурно как corpus-append-only, NF-2/AC-9). | `corpus-append-only`-стиль diff BASE_REF: ни одна существующая jsonl-строка не удалена/мутирована |
| FF-ASA9 | AUDIT-строка auto-санкции содержит `class=auto_additive` + Враг-ссылку; founder — `class=founder`; классы машинно-различимы (AC-7). | grep AUDIT-вывода мета-гейта на синтетике обоих классов |

---

## 9. Трассировка (AC → дизайн)

| AC | covered_by |
|---|---|
| AC-1 | FF-ASA1 — delegate `--self-test` case A (аддитивный+аттестован → ПРИНЯТ) |
| AC-2 | FF-ASA2 — delegate `--self-test` case B (удалена сущность → A-1/A-2 краснит) |
| AC-3 | FF-ASA3 — delegate `--self-test` case C (мутация/scope → A-1/A-3 краснит) |
| AC-4 | FF-ASA4 — delegate `--self-test` case D (нет аттестации → ОТКЛОНЕНА), §2-Q2 |
| AC-5 | FF-FCI13 + FF-ASA9 — founder-класс поведенчески неизменён (§5.3) |
| AC-6 | §4 A-1..A-4 над диффом T-0227 (`mutation-gateway-isolation.sh` thaw `process_instance`) — A-1..A-4 выполнены, auto-путь ПРИНЯЛ БЫ; verifiable_as=test |
| AC-7 | FF-ASA9 — AUDIT `class=auto_additive`+vrag vs `class=founder` (§5.3) |
| AC-8 | FF-ASA7 — destructive-as-auto_additive → FAIL; +founder-строка → PASS (§7 шаг 5) |
| AC-9 | FF-ASA8 — jsonl append-only, T-0085/T-0227 байт-сохранены |
| AC-10 | FF-ASA6 — регистрация в `npm run fitness` + 2-я строка `# T-0232 ·` |
| AC-11 | FF-ASA5 — fail-open вне task-ветки/без merge-base (§4) |
| AC-12 | FF-FCI13 — founder-регрессия T-0085/T-0227 зелёная в полном fitness; verifiable_as=test |
| AC-13 | вся §8 — `npm run fitness` зелёный end-to-end на ветке T-0232 (после bootstrap-founder-строки на мета-гейт, §2-Q1) |

---

## 10. Runtime / deploy-таргет

**Локально / CI** — это CI-gate-change (поведение fitness-чеков + формат data-строки), НЕ
рантайм-продукта и НЕ объектная модель Choros. Артефакт самотестируем `--self-test`, чист
(git/grep/awk/diff, без БД/сети/часов), исполняется на КАЖДОМ `npm run fitness`. Внешний ресурс
НЕ требуется.

**Один человек-в-петле (по делу, не эскалация механизма):** одноразовая bootstrap-строка
`founder`-класса на `frozen-checks-immutable.sh` (§2-Q1) — `founder_decide`-гейт, вводящий саму
инфраструктуру нового класса (D-060 уже ратифицировал направление). coder помечает её в preflight;
после неё механизм автономен. Это НЕ блокирующая эскалация архитектуры (D-060 закрыл вопрос границы),
а ожидаемый разовый founder-санкционный шаг для правки чужого frozen-файла — тот же канал T-0199.

---

## 11. Связь с guardrails (D-026 / D-007 / D-060)

- **D-026 удержан.** Агент НЕ может убрать/ослабить инвариант: A-1/A-2/A-3/A-4 структурно
  запрещают удаление/мутацию/scope-расширение; FF-ASA7 запрещает авто-санкцию деструктивного thaw.
  Система не имеет пути само-санкционировать редуктивную правку — она всегда краснит делегата и
  падает в founder-only. Снят ТОЛЬКО рутинный человек-в-петле на ДОКАЗУЕМО-аддитивном.
- **D-007 удержан.** Достаточность авто-санкции — НЕ самооценка: (a) делегат НЕЗАВИСИМО ре-верифицирует
  A-1..A-4 (не верит маркеру строки), (b) Враг (T-0151) независимо подтверждает семантику. Гейт —
  независимый верификатор, не подпись оркестратора.
- **D-060 риппл-1 реализован.** Мета-гейт принимает класс авто-санкции (Враг-аттестация аддитивности
  вместо `founder_decide`-трейса); оркестратор сам аппендит аудируемую строку → задача класса T-0227
  не паркуется в `awaiting_founder`. Граница «аддитивный→авто, деструктивный→фаундер» машинно
  закодирована в A-1..A-4 + FF-ASA7.
- **NF-4 удержан.** Нет нового trust-root; T-0146 не ослаблен (его frozen-файл правится ОДИН раз
  аддитивно под одноразовую founder-санкцию; делегат — собственный владеемый чек, само-защищён T-0146).

---

## 12. Заметки для coder

- Bootstrap-founder-строка на `frozen-checks-immutable.sh` — ДО мержа в dev, preflight-сигнал; до неё
  FF-FCI1 краснит на правке мета-гейта (ожидаемо).
- Мирроринг: `corpus-append-only.sh` (A-1/`grep -qxF`/diff-prefix), `catalog-frozen.sh`
  (`entities`/`enforced_refs` ⊆), `arena-sealed.sh` (self-test exit-коды 0/1/2, `--self-test`-драйв
  на синтетике), `agent-instruction-additive.sh` (BASE_REF merge-base резолв).
- `--self-test` exit 2 = сломана машинерия (как catalog/arena); 1 = bite-кейс не пойман.
- AC-6 (T-0227 канон) — `test`, не `fitness`: демонстрационный прогон A-1..A-4 над зафиксированным
  диффом T-0227, не часть постоянной fitness-цепочки.
- Регистрировать в `package.json` `fitness` БЛОКОМ рядом с enemy-чеками:
  `&& bash ci/checks/auto-sanction-additive.sh && bash ci/checks/auto-sanction-additive.sh --self-test`.
