# Spec · T-0596 — замок-харден (R-4 quote-agnostic + ECO-1 PROJECT_ROOT + R-5 rc>=2)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Wave:** W2/замок-харден
**Date:** 2026-07-02
**Referenced (read, do NOT contradict):** `docs/review/T-0576.review.json` (findings R-4/R-5, `ff_0328_3_verdict`),
`docs/test/T-0576.test-report.json` (`notes.ECO-1_foreign_check_bug`, `notes.known_blindness`), `ci/checks/anti-case-lock.sh`
(T-0576, зонтик — свой файл этой волны), `ci/checks/rights-ui-anti-case.sh` (T-0572, ЧУЖОЙ — точечный фикс резолва
корня), `ci/checks/read-pdp-anti-case.sh` (T-0570, образец корректного `PROJECT_ROOT` — `${SCRIPT_DIR}/../..`),
`ci/checks/data/anti-case-baseline.json` (T-0576, данные этой волны — пересчитываются), `ci/checks/data/frozen-sanctions.jsonl`
(append-only санкционный журнал), `ci/checks/frozen-checks-immutable.sh` (FF-FCI1..13, механика санкции чужого чека).

---

## 0. Проблема

Ревью T-0576 (round 2, approved) оставило три открытые находки, не блокирующие мерж, но помеченные как
обязательный follow-up (`R-4`: major, `R-5`: minor) плюс независимую экосистемную находку test-фазы (`ECO-1`,
внедиффовый баг чужого чека `T-0572`). Все три — в периметре анти-кейс замка (D-064 §5) и логично закрываются
одной волной W2 «замок-харден», не дожидаясь следующей деТЭЛ-волны:

- **R-4** (`ci/checks/anti-case-lock.sh`, свой файл T-0576): матчер `count_literal()` ловит денилист-литерал
  ТОЛЬКО в двойных кавычках (`"\"${literal}\""` в grep-паттерне). web/src-конвенция репозитория — одинарные
  кавычки. Результат: 5 реальных code-only вхождений денилиста невидимы гейму — `'role-approver'`
  (`web/src/screens/screen-inbox.jsx:835`, код: `t.role === 'role-approver'`) и `'approvalRequired'` ×4
  (`web/src/canvas/gateway-condition-panel.jsx:55,87,90` — дефолт роутинг-переменной в конструкторе гейтвеев;
  `web/src/screens/screen-dmn-editor.jsx:47` — `DEFAULT_ROUTING_NAME`). Это pre-existing осадок (не внесён
  T-0576), но baseline-файл (`ci/checks/data/anti-case-baseline.json`) на сегодня фиксирует ЗАНИЖЕННЫЙ факт
  (19), потому что сам замер велся слепым к одинарным кавычкам матчером.
- **ECO-1** (`ci/checks/rights-ui-anti-case.sh`, ЧУЖОЙ файл, владелец T-0572): `PROJECT_ROOT` резолвится в
  `${SCRIPT_DIR}/..` = `ci/` (на один уровень МЕНЬШЕ, чем нужно — должно быть `${SCRIPT_DIR}/../..` = repo root,
  как в `read-pdp-anti-case.sh`). Следствие: `git -C "${PROJECT_ROOT}" diff ... -- web/src/` резолвит pathspec
  в несуществующий `ci/web/src/` → git возвращает пусто (не ошибку — просто нет такого пути в дереве) → скан
  ВСЕГДА пуст → гейт вечно-зелёный вне зависимости от реального содержимого диффа. Доказано живьём тест-фазой
  T-0576 (untracked plant с `e-orlov` прошёл боевой прогон exit 0). `--self-test` бага не ловит, потому что
  работает на synthetic temp-repo с явным `repo_root`, минуя реальный `PROJECT_ROOT`-резолв.
- **R-5** (`ci/checks/anti-case-lock.sh`, свой файл T-0576): каждая grep-стадия в `count_literal()`/`read_baseline()`
  обёрнута в `(... || true)`, что глушит не только легитимный rc=1 (no-match — суть zero-safety фикса R-1), но и
  rc>=2 (настоящая ошибка grep: несуществующий/нечитаемый root) — молчаливый fail-open в "0 OK (eroded)".

## 1. Summary

Три точечных, независимых друг от друга фикса в периметре замка:

1. **Quote-agnostic матчер + пересчёт baseline фактом** (свой файл, `anti-case-lock.sh`): `count_literal()`
   переходит с жёсткого `"\"${literal}\""` на `[\"']${literal}[\"']` (одинарные ИЛИ двойные ИЛИ обратные
   кавычки — репозиторий не использует template-literal-обёрнутые денилист-значения, но паттерн включает
   backtick ради полноты класса quote-стилей). Baseline пересчитывается ФАКТОМ на текущем HEAD этой ветки
   (ожидание из ревью: `role-approver` 2→3, `approvalRequired` 1→5, агрегат 19→24 — числа перепроверяются
   живым прогоном, не берутся на веру из текста ревью).
2. **Резолв корня в `rights-ui-anti-case.sh`** (чужой файл, T-0572): однострочный фикс `${SCRIPT_DIR}/..` →
   `${SCRIPT_DIR}/../..`. Санкционируется как аддитивная санкц-запись в `frozen-sanctions.jsonl` (класс
   `auto_additive`/эквивалент — основание: фикс ВОССТАНАВЛИВАЕТ задокументированный контракт гейта
   (`resolve_base_ref`/`scan_diff` уже написаны с расчётом на корректный `PROJECT_ROOT="repo root"` — сравни
   с идентичной идиомой `read-pdp-anti-case.sh:26` — баг чисто арифметический, не архитектурное решение
   T-0572, которое можно было бы "ослабить"). После фикса гейт прогоняется БОЕВЫМ образом на текущей ветке;
   т.к. гейт diff-scoped (`git diff <base_ref> -- web/src/` + untracked-файлы — НЕ repo-wide baseline), а
   R-4-находки — pre-existing на dev (внесены до этой ветки, не в её диффе), ожидание — гейт остаётся зелёным
   на чистой ветке (см. §2 разведку семантики).
3. **Явная обработка rc>=2** (свой файл, `anti-case-lock.sh`): `count_literal()`/`read_baseline()` перестают
   слепо глушить весь nonzero rc. rc=0/1 (match/no-match) остаются данными (0 матчей — легитимный "eroded"
   исход). rc>=2 (реальная ошибка grep: отсутствующий root, permission, некорректный regex) становится
   ФАТАЛЬНЫМ для скрипта — явное сообщение об ошибке вместо молчаливого fail-open в "0 OK (eroded)".

## 2. Разведка (2026-07-02, живой worktree T-0596, база dev@0370cf5)

### 2.1 R-4: подтверждение находок ревью живым grep

Прямое чтение файлов подтверждает **все 5** находок ревью буквально (проверено `Read`, не понаслышке):

| Файл:строка | Литерал | Кавычка | Код или комментарий |
|---|---|---|---|
| `web/src/screens/screen-inbox.jsx:835` | `role-approver` | одинарная | код: `t.role === 'role-approver'` (JSX-условие рендера) |
| `web/src/canvas/gateway-condition-panel.jsx:55` | `approvalRequired` | одинарная | код: `const safeVar = stripped \|\| 'approvalRequired';` |
| `web/src/canvas/gateway-condition-panel.jsx:87` | `approvalRequired` | одинарная | код: `if (!bo) return 'approvalRequired';` |
| `web/src/canvas/gateway-condition-panel.jsx:90` | `approvalRequired` | одинарная | код: `?? 'approvalRequired';` (fallback-цепочка) |
| `web/src/screens/screen-dmn-editor.jsx:47` | `approvalRequired` | одинарная | код: `const DEFAULT_ROUTING_NAME = 'approvalRequired';` |

`gateway-condition-panel.jsx:45` (JSDoc `readRoutingVar fallback = 'approvalRequired'`) — комментарий
(первый непробельный символ строки — `*`, блок-комментарий), корректно НЕ считается ни старым, ни новым
матчером — методология comment-strip не меняется этой задачей.

Ожидание ревью — `role-approver` 2→3 (было 2 в двойных кавычках src, +1 одинарная web), `approvalRequired`
1→5 (было 1 двойная src, +4 одинарные web), агрегат 19→24. Точное число фиксируется BUILD-фазой прогоном
пересчитанного скрипта на своей же ветке (не переписывается вручную — baseline обязан быть фактом, не
догадкой).

### 2.2 ECO-1: подтверждение бага резолва корня

`ci/checks/rights-ui-anti-case.sh:25`: `PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"` — `SCRIPT_DIR` есть
`<repo>/ci/checks`, значит `${SCRIPT_DIR}/..` = `<repo>/ci`, а не `<repo>`. Сравнение с корректной идиомой
`ci/checks/read-pdp-anti-case.sh:26`: `PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"` (два уровня вверх —
`ci/checks/../..` = repo root). `anti-case-lock.sh:70` использует ТУ ЖЕ корректную двухуровневую форму.
Однострочный фикс: заменить `${SCRIPT_DIR}/..` на `${SCRIPT_DIR}/../..` в `rights-ui-anti-case.sh:25`.

**Семантика гейта после фикса** (важно для AC): `rights-ui-anti-case.sh` — **git-diff-scoped**, не repo-wide
baseline. `scan_diff()` сравнивает `git diff <base_ref> -- web/src/` (плюс untracked-файлы) — то есть ловит
только СТРОКИ, ДОБАВЛЕННЫЕ в диффе текущей ветки относительно `base_ref` (`merge-base HEAD origin/dev` →
`merge-base HEAD dev` → `HEAD~1` fallback-цепочка). R-4-находки (одинарные кавычки в `screen-inbox.jsx`,
`gateway-condition-panel.jsx`, `screen-dmn-editor.jsx`) — **pre-existing на dev**, они НЕ являются добавленными
строками диффа ветки `task/T-0596-lock-harden` (эта ветка их не трогает и не добавляет). Значит, боевой прогон
`rights-ui-anti-case.sh` на этой ветке ПОСЛЕ фикса корня обязан остаться зелёным (diff этой ветки чист от
денилиста в web/src/) — фикс резолва восстанавливает способность гейта видеть БУДУЩИЙ дифф, не перекрашивает
прошлое задним числом. Доказательство исправности самого механизма после фикса — плант нового untracked-файла
с денилист-литералом (не переименование существующих pre-existing строк), см. AC-2 ниже.

### 2.3 R-5: текущая обработка rc в count_literal/read_baseline

Обе функции оборачивают КАЖДУЮ grep-стадию в `(grep ... || true)`. `|| true` присваивает финальный rc=0
безусловно — не различает "grep нашёл 0 совпадений" (rc=1, легитимно) от "grep упал с ошибкой" (rc>=2:
`No such file or directory`, `Permission denied`, некорректный regex). Фикс: после каждой стадии, где это
материально (регулярный grep по `${root}` — единственная точка внешнего отказа; последующие `grep -v`/`grep -oE`
стадии работают над уже-полученным текстом, где rc>=2 практически недостижим при валидном самим скриптом
regex-паттерне, но проверка на них добавляется тем же приёмом ради единообразия и симметрии с первой стадией) —
явно перехватить `rc`, и фатально упасть с сообщением при `rc>=2`, в отличие от `rc<=1`, которое проходит как
раньше.

## 3. Functional Requirements

- **FR-1.** `count_literal()` в `ci/checks/anti-case-lock.sh`: паттерн первой grep-стадии переходит с
  `"\"${literal}\""` (только двойные кавычки) на quote-agnostic форму, ловящую литерал, обёрнутый в `"`, `'`
  ИЛИ `` ` `` (все три стиля кавычек, единообразно для всех 8 денилист-литералов, без per-литерал спецкейсов).
- **FR-2.** `ci/checks/data/anti-case-baseline.json` пересчитывается ФАКТОМ — прогоном пересчитанного скрипта
  на этой ветке (не переносится текстом из ревью-документа как оценка) — для каждого из 8 литералов + агрегата.
- **FR-3.** `ci/checks/rights-ui-anti-case.sh:25` (`PROJECT_ROOT`): однострочная правка резолва на
  `${SCRIPT_DIR}/../..`, приводящая идиому к тому же виду, что `read-pdp-anti-case.sh:26` и
  `anti-case-lock.sh:70`. Никакая другая строка/логика файла не меняется.
- **FR-4.** Правка FR-3 санкционируется append-записью в `ci/checks/data/frozen-sanctions.jsonl`
  (`task:"T-0596"`, `file:"ci/checks/rights-ui-anti-case.sh"`, `owner:"T-0572"`), с основанием: фикс
  ВОССТАНАВЛИВАЕТ задокументированную функциональность чужого гейта (был структурно нефункционален — ECO-1
  судьи T-0576 — pathspec резолвился в несуществующий путь, скан всегда пуст), не ослабляет и не переопределяет
  предикат гейта.
- **FR-5.** `count_literal()`/`read_baseline()` в `ci/checks/anti-case-lock.sh`: rc=0/1 первой (внешней)
  grep-стадии остаются немыми данными (0 матчей — легитимный результат, как задокументировано R-1-фиксом);
  rc>=2 становится фатальным для скрипта — явное `FAIL`/error-сообщение с указанием какая стадия/root упала,
  ненулевой exit скрипта в целом (не молчаливый "0 OK (eroded)").

## 4. Non-Functional Requirements

- **NF-1 (обратная совместимость self-test).** Все существующие self-test-ассерты `anti-case-lock.sh`
  (5 ассертов R-1/R-3 регрессии) остаются зелёными после FR-1/FR-5 правок — расширение покрытия кавычек и
  ужесточение rc-обработки не меняют поведение для уже покрытых сценариев (двойные кавычки, zero-count,
  eroded-to-zero фикстуры).
- **NF-2 (не ломает существующее — чужие файлы).** `read-pdp-anti-case.sh`, `detel-literal-baseline.sh`
  (не затронуты этой волной) продолжают проходить свои `--self-test` и производственные прогоны без
  модификации.
- **NF-3 (диффовая честность правки чужого чека).** Правка `rights-ui-anti-case.sh` — РОВНО одна строка
  (`PROJECT_ROOT` присвоение); никакая другая строка файла (в т.ч. `FORBIDDEN_LITERALS`, `scan_diff`,
  `self_test`, `resolve_base_ref`) не меняется этой задачей.
- **NF-4 (требуемый CI).** Оба изменённых скрипта остаются в существующих местах `npm run fitness`
  (`anti-case-lock.sh` в хвосте, `rights-ui-anti-case.sh` в своём существующем месте цепочки) — package.json
  порядок звеньев не переставляется.
- **NF-5 (self-tests живы).** `anti-case-lock.sh --self-test` и `rights-ui-anti-case.sh --self-test` оба
  проходят после соответствующих правок.

## 5. Out of Scope

- **O1.** Выедание самих 5 pre-existing одинарно-кавычных вхождений (`role-approver`/`approvalRequired` в
  web/src) — это BUILD-задача будущей волны деТЭЛ (следующая волна и так трогает
  `gateway-condition-panel.jsx`/`screen-dmn-editor.jsx` по независимым причинам — ревью явно называет их
  конструкторским UI, дефолтящимся в ТЭЛ-переменную).
- **O2.** Любые другие находки ревью/теста T-0576, не относящиеся к R-4/R-5/ECO-1 (все остальные пункты
  ревью — `FIXED`/`approved`, не переоткрываются).
- **O3.** Изменение diff-scope семантики `rights-ui-anti-case.sh` (переход на repo-wide baseline) — вне
  мандата; фикс только резолва корня, семантика "diff-scoped" сохраняется как есть (это архитектурное решение
  T-0572, не багфикс-предмет).
- **O4.** Добавление новых литералов в денилист — не в мандате этой волны (только матчер/резолв/rc-обработка).
- **O5.** Ужесточение rc-обработки в `read_baseline()`'s вторичных grep-стадий (`grep -oE '[0-9]+$' | head -1`)
  сверх симметричного применения того же приёма, что и в первой стадии — если анализ BUILD-фазы покажет, что
  вторичные стадии структурно не могут получить rc>=2 при валидном baseline-файле, они не переусложняются
  избыточными проверками несуществующих путей отказа.

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | Плант ЛЮБОГО денилист-литерала в ОДИНАРНЫХ кавычках (напр. `const X = 'role-approver';`) в `src/**/*.ts` красит `anti-case-lock.sh` (aggregate/per-литерал `INCREASED`), rc=1 — доказано `--self-test` синтетической фикстурой. | fitness |
| AC-2 | То же самое для одинарно-кавычного планта в `web/src/**/*.jsx` — обе плоскости (src + web/src) чувствительны к обеим кавычкам после фикса. | fitness |
| AC-3 | Baseline (`ci/checks/data/anti-case-baseline.json`) — ФАКТ, полученный прогоном пересчитанного скрипта на HEAD этой ветки, не переписанная вручную оценка; production-прогон `anti-case-lock.sh` на неизменном дереве после обновления baseline возвращает exit 0. | fitness |
| AC-4 | `rights-ui-anti-case.sh` после фикса корня, боевым прогоном на новом untracked-плант-файле в `web/src/` с денилист-литералом (не переименование существующего pre-existing кода) — красит гейт (rc≠0), доказывая, что резолв корня теперь указывает на реальный repo root и `git diff`/`ls-files --others` видят `web/src/`. | fitness |
| AC-5 | `rights-ui-anti-case.sh` на ЧИСТОЙ ветке `task/T-0596-lock-harden` (без плантов) — зелёный: diff-scoped семантика гейта означает, что pre-existing одинарно-кавычные вхождения R-4 (не внесённые этой веткой) не триггерят FAIL. | fitness |
| AC-6 | `rights-ui-anti-case.sh --self-test` остаётся зелёным после фикса корня (synthetic temp-repo self-test не зависит от реального `PROJECT_ROOT`, но не должен сломаться правкой). | fitness |
| AC-7 | rc>=2 у внешней grep-стадии `count_literal()`/`read_baseline()` (напр. несуществующий `SRC_ROOT`/`WEB_ROOT`/`BASELINE_FILE`) — теперь ФАТАЛЕН: скрипт печатает явное сообщение об ошибке и завершается ненулевым exit, а не "0 OK (eroded)". Доказано self-test или прямым прогоном с намеренно битым root. | fitness |
| AC-8 | rc=0/1 (match/no-match) у той же стадии продолжают трактоваться как данные (0 — легитимный eroded-исход) — существующие R-1-регрессии self-test (zero-occurrence, eroded-to-zero фикстура) остаются зелёными без изменений поведения. | fitness |
| AC-9 | Новая append-запись в `ci/checks/data/frozen-sanctions.jsonl` (`task:"T-0596"`, `file:"ci/checks/rights-ui-anti-case.sh"`) присутствует, валидный compact JSON по образцу существующих строк. | fitness |
| AC-10 | `frozen-checks-immutable.sh` зелёный: модификация `rights-ui-anti-case.sh` (чужой файл, владелец T-0572) распознаётся как санкционированная; собственные файлы этой волны (`anti-case-lock.sh` правки, baseline-файл) проходят как own. | fitness |
| AC-11 | Полный `npm run fitness` прогон на итоговом дереве этой волны зелёный (весь существующий набор чеков + оба изменённых звена). | fitness |
| AC-12 | `anti-case-lock.sh --self-test` (все существующие + новые ассерты) полностью зелёный. | fitness |

## 7. Traceability

AC-1..AC-3 → R-4 (FR-1, FR-2). AC-4..AC-6 → ECO-1 (FR-3, FR-4). AC-7..AC-8 → R-5 (FR-5). AC-9..AC-10 →
санкц-дисциплина правки чужого чека (FR-4). AC-11..AC-12 → регрессия/required CI (NF-1, NF-4, NF-5).
