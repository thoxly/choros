# Spec · T-0576 — анти-кейс CI-гейт (D-064 п.2, закон границы)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Wave:** W1/анти-кейс-CI
**Date:** 2026-07-02
**Referenced (read, do NOT contradict):** карта примитивов §5 (ТЭЛ-осадок), `docs/adr/ADR-T0575-detel-primitives.md`
§6 (baseline-таблица), `ci/checks/detel-literal-baseline.sh` (T-0575, FF-7), `ci/checks/read-pdp-anti-case.sh`
(T-0570, git-diff-scoped санитайзер — образец), `ci/checks/rights-ui-anti-case.sh` (T-0572, web/src/ расширение),
`docs/design/T-0328-agent-facing-auth-model.adr.md` §4.1/§4.2/§5 (FF-0328-3 contract-frozen vs byte-frozen),
`ci/checks/data/frozen-sanctions.jsonl` (запись `T-0575`/`http-route-auth-coverage.sh`, поручает эту правку).

---

## 0. Проблема

D-064 «функция потерь фабрики = столпы» именует ТЭЛ-осадок как факт дрейфа: серия T-0278..0289 закодировала живой
демо-кейс (роль `role-approver`, реестр `soglasovanie`, приложение `tel-approval`, процесс `telLinear`, персоны
`e-larina`/`e-orlov`, порог 5 000 000, `TEL_GATEWAY_VAR`/`TEL_GATEWAY_ID`) прямо в несущие пути платформы. T-0575
уменьшил три из этих литералов на несущих путях (agregat 7→5, FF-7) и оставил явный входной baseline для этой
задачи (её собственная NF-3: «это станет входным гейтом T-0576»; out-of-scope O3: «сам гейт — это T-0576»).

Точечные анти-кейс гейты уже существуют (`read-pdp-anti-case.sh` — src/, git-diff-scoped на 7 литералов;
`rights-ui-anti-case.sh` — web/src/, тот же список) — оба ловят только **новые вросты в диффе конкретной
задачи**, ни один не покрывает полный денилист карты примитивов §5 (`telLinear`, персоны как object-literal
фикстура, `TEL_GATEWAY_VAR`/`ID`) и ни один не является **baseline-гейтом всего репозитория** (аналог
`detel-literal-baseline.sh`, но по полному списку, не по трём литералам T-0575).

Без единого замка: (а) три существующих точечных чека покрывают только свои диффы/директории — за их периметром
(например `src/core/`, `src/db/` вне T-0570/572 диффов) новый вырост незаметен до следующего специального гейта;
(б) `detel-literal-baseline.sh` покрывает только 3 литерала T-0575, не весь денилист; (в) нет required-цепи,
которая гарантирует, что баланс не растёт СНОВА в будущих задачах, не знающих про D-064.

## 1. Summary

Единый агрегатный CI-гейт `ci/checks/anti-case-lock.sh`, который:

1. Считает code-only (non-comment, non-`__tests__`/`.test.ts`) вхождения **полного денилиста** карты
   примитивов §5 в `src/**/*.ts` и `web/src/**/*.jsx`/`*.tsx` (там, где применимо): `role-approver`,
   `soglasovanie`, `tel-approval`, `telLinear`, `e-larina`, `e-orlov`, `TEL_GATEWAY_VAR`/`approvalRequired`
   значение, `TEL_GATEWAY_ID`/`gw-approval-threshold` значение.
2. Сравнивает агрегат и КАЖДЫЙ отдельный литерал с записанным **data-baseline-файлом** (не кодом) —
   семантика «выедается, не растёт»: `<=` baseline для каждого литерала и агрегата (T-0576 сам не обязан
   уменьшать — задача строит гейт, не выедает остаток; будущие задачи обязаны либо не расти, либо уменьшать).
3. Вызывает существующие точечные гейты (`read-pdp-anti-case.sh`, `rights-ui-anti-case.sh`,
   `detel-literal-baseline.sh`) как есть — не переопределяет, не дублирует их git-diff-scoped логику —
   и добирает своим собственным репозиторий-wide code-only сканом то, что они не покрывают (`telLinear`,
   персоны как структурные object-literals, `TEL_GATEWAY_*`).
4. Прошивается аддитивно в хвост `npm run fitness` (package.json) — становится частью required CI (то же
   required-положение, что и все остальные fitness-чеки в этой цепи; отдельного workflow-флага не заводится,
   т.к. `npm run fitness`/`npm run ci` уже required по существующей конфигурации CI).

Порог `5000000` в `migrations/080_tel_dmn_seed.sql` — это данные миграции-сида (не `src/`), карта примитивов §5
сама называет его «параметризовать» отдельно (out-of-scope и для T-0575, и для этой задачи — денилист-гейт
проверяет **код**, не seed-миграции).

Отдельно (бонус-поручение оркестратора, вердикт ревью T-0575, `frozen-sanctions.jsonl`): FF-0328-3 в
`ci/checks/http-route-auth-coverage.sh` §5 сегодня byte-diff-фризит ОБА файла (`secret-handle.ts` +
`process-start.ts`), хотя ADR T-0328 §4.2 называет `process-start.ts` **contract-frozen** (REST-контракт,
enforced `start-route-isolation.sh`), не byte-frozen — только `secret-handle.ts` (§4.1) держит настоящий
byte-freeze. Эта задача сужает `FROZEN_FILES` в FF-0328-3 до одного `secret-handle.ts`, снимая санкционированный
known-red (запись `T-0575`/`http-route-auth-coverage.sh` в `frozen-sanctions.jsonl` явно указывает: «T-0576
приведёт §5 в соответствие §4.2»). Это правка ЧУЖОГО чека (владелец T-0328) — санкционирована докозаписью T-0575
+ собственной новой записью этой задачи (frozen-sanctions.jsonl append, FF-FCI12 founder-класс, канал design
T-0199 — правка сужает предикат, не аддитивна в смысле FF-FCI13, поэтому founder-класс, а не auto_additive).

## 2. Разведка (2026-07-02, живой worktree T-0576, HEAD=afa856b)

Точный текущий (code-only, `src/**/*.ts`, исключая `__tests__`/`.test.ts`, исключая комментарии — методология
`detel-literal-baseline.sh`) подсчёт денилиста:

| Литерал | Count | Где (code-only, не комментарий, не тест) |
|---|---|---|
| `role-approver` | 2 | `process-projection.ts:278` (`APPROVER_ROLE` def), `http/inbox.ts:229` (`USER_ROLES` фикстура-массив ролей персоны) |
| `soglasovanie` | 2 | `step-applier.ts:83` (`SOGLASOVANIE_SLUG` def), `form-record-persister.ts:122` (default-fallback значение) |
| `tel-approval` | 1 | `form-record-persister.ts:135` (default-fallback значение) |
| `telLinear` | 7 | `process-catalog-view.ts:89` (`fallbackDefinitionName` строковое сравнение), `process-projection.ts:850/928/964/1129/1799/1875` (default-fallback значения `procKey`) |
| `e-larina` | 2 | `http/inbox.ts:229` (`USER_ROLES` фикстура-ключ), `http/org.ts:73` (`people[]` object-literal фикстура оргструктуры) |
| `e-orlov` | 2 | `http/inbox.ts:232` (`USER_ROLES` фикстура-ключ), `http/org.ts:86` (`people[]` object-literal фикстура) |
| `approvalRequired` (`TEL_GATEWAY_VAR` значение) | 1 (код), 5 doc-comment | `core/dmn-gateway.ts:82` (`export const TEL_GATEWAY_VAR = "approvalRequired" as const` — сама сущность УЖЕ `@deprecated`, строки 77-84) |
| `gw-approval-threshold` (`TEL_GATEWAY_ID` значение) | 1 | `core/dmn-gateway.ts:90` (`export const TEL_GATEWAY_ID = ... as const` — тоже `@deprecated`, строки 85-91) |
| **Агрегат** | **18** | (сумма кода-строк выше; каждый литерал считается один раз на строку-определение/фикстуру, не на каждое упоминание типа/JSDoc) |

`sod-dao.ts:382` (`e-orlov` в doc-комментарии `LATENT-TRAP GUARD`) — доказанно НЕ код (первый непробельный символ
строки — `//`), исключается методологией. `web/src/**` на момент разведки НЕ содержит совпадений денилиста (сам
`rights-ui-anti-case.sh` — git-diff-scoped на будущее, не repo-wide; отдельный repo-wide проход по `web/src/`
подтверждает ноль текущих вхождений — фиксируется как baseline `0` для web-стороны, тем же гейтом).

`FF-0328-3` разведка: на текущем HEAD (afa856b) `process-start.ts` byte-identical к merge-base — красного нет
СЕЙЧАС (санкция T-0575 покрывала ЕЁ СОБСТВЕННЫЙ диф на своей ветке, уже смерженный и не оставивший остаточной
модификации файла относительно dev). Тем не менее сужение предиката — обязательная часть задачи (устраняет
структурную неточность §5 vs ADR §4.2 навсегда, не полагаясь на то, что будущие задачи не тронут
`process-start.ts` байтово).

## 3. Functional Requirements

- **FR-1.** Новый скрипт `ci/checks/anti-case-lock.sh` — зонтичный агрегатор: (a) вызывает
  `read-pdp-anti-case.sh`, `rights-ui-anti-case.sh`, `detel-literal-baseline.sh` как сабпроцессы (их
  собственная логика и владение — не трогается, не дублируется); (b) добавляет свой repo-wide code-only скан
  полного денилиста (`telLinear`, `e-larina`, `e-orlov`, `approvalRequired`-значение, `gw-approval-threshold`-
  значение — плюс те же `role-approver`/`soglasovanie`/`tel-approval`, чтобы агрегат был АБСОЛЮТНЫМ, не только
  диффовым) поверх `src/**/*.ts` И `web/src/**/*.{jsx,tsx}`.
- **FR-2.** Baseline — data-файл (не код), `ci/checks/data/anti-case-baseline.json` (или `.txt` построчный формат
  по образцу `frozen-sanctions.jsonl` — решение формата за DESIGN), фиксирующий текущий count на момент этой
  задачи (см. таблицу §2) для каждого литерала денилиста + агрегат.
- **FR-3.** Гейт FAIL, если count любого отдельного литерала СТРОГО БОЛЬШЕ записанного baseline ИЛИ агрегат
  строго больше baseline-агрегата — семантика «выедается, не растёт» (`<=`, не `<`; T-0576 не обязана уменьшать
  сама, в отличие от T-0575 AC-10, которая обязана была строго уменьшить).
- **FR-4.** Гейт ловит планту КАЖДОГО класса денилиста независимо — синтетический self-test для каждого
  литерала (или представительного поднабора классов, если механизм скана единообразен по всем литералам —
  решение DESIGN).
- **FR-5.** `anti-case-lock.sh` не читает/не пишет ничего вне `src/`, `web/src/`, `ci/checks/data/` и себя самого
  (zero side-effects, чистая grep-проверка, как все существующие isolation-чеки).
- **FR-6.** Правка `ci/checks/http-route-auth-coverage.sh` §5 FF-0328-3: `FROZEN_FILES` сужается до ровно одного
  элемента `src/http/secret-handle.ts`; `process-start.ts` перестаёт участвовать в byte-diff проверке этого
  арма (структурная проверка `start-route-isolation.sh` FF-7-1..3 остаётся единственным гейтом контракта
  `process-start.ts`, как и требует ADR §4.2). `--self-test` скрипта остаётся живым и зелёным после правки.
- **FR-7.** Собственная запись в `ci/checks/data/frozen-sanctions.jsonl` (append, `task:"T-0576"`,
  `file:"ci/checks/http-route-auth-coverage.sh"`, `owner:"T-0328"`, `sanctioned_by:"founder"` или эквивалент,
  ссылающаяся на docozapись T-0575 + это ADR) — не foundeк_decide-сессия заново, а формальная запись,
  завершающая уже начатую в T-0575 санкцию (та явно называет T-0576 её исполнителем).

## 4. Non-Functional Requirements

- **NF-1 (идемпотентность).** Повторный прогон `anti-case-lock.sh` на неизменном дереве даёт идентичный
  результат (детерминированный подсчёт, без флаки — тот же принцип, что во всех существующих grep-based
  fitness-чеках).
- **NF-2 (не ломает существующее).** `read-pdp-anti-case.sh`, `rights-ui-anti-case.sh`,
  `detel-literal-baseline.sh` продолжают проходить свои собственные `--self-test` и производственные прогоны
  БЕЗ модификации их файлов этой задачей (owned by T-0570/T-0572/T-0575 — `frozen-checks-immutable.sh` FF-FCI1
  запрещает T-0576 их трогать; зонтик их только ВЫЗЫВАЕТ).
- **NF-3 (required CI).** `anti-case-lock.sh` (и, отдельно, `--self-test`) добавляются в хвост `npm run fitness`
  в `package.json` — аддитивно (новая пара `&&`-звеньев в конце строки), не переставляя существующие звенья.
  `npm run fitness` уже participates в required CI (`npm run ci` вызывает его) — отдельного workflow-флага не
  требуется.
- **NF-4 (анти-кейс дисциплина в самой задаче).** Дифф этой задачи (сам `anti-case-lock.sh`, baseline-файл,
  правка `http-route-auth-coverage.sh`) не добавляет НОВЫХ кейс-специфичных литералов сверх упоминания их as
  data-строк в денилисте/baseline (упоминание строки `"role-approver"` в списке денилиста самого чека —
  ЛЕГИТИМНАЯ мета-строка, аналог `FORBIDDEN_SANITY_LIST`/`FORBIDDEN_LITERALS` в существующих чеках — не
  является хардкодом-нарушением).
- **NF-5 (no-weakening мета).** Никакой будущий коммит не может тихо ослабить порог (поднять baseline без
  явного изменения самого data-файла в диффе, видимого в code review) — сам факт, что baseline — отдельный
  data-файл, а не встроенная в грep-скрипт константа, делает любое расширение видимым построчно в git diff
  (тот же принцип прозрачности, что и `frozen-sanctions.jsonl`/append-only).

## 5. Out of Scope

- **O1.** Само уменьшение текущего baseline (выедание остатка) — не обязанность этой задачи; T-0575 уже сделала
  единственное обязательное уменьшение (её AC-10). Будущие задачи по мере деТЭЛизации будут уменьшать
  baseline-файл как часть СВОИХ диффов (та же семантика, что `detel-literal-baseline.sh`, но теперь под общим
  зонтиком).
- **O2.** Параметризация порога `5000000` в `migrations/080_tel_dmn_seed.sql` — не `src/`, отдельная задача карты
  примитивов §5 (эта задача проверяет КОД, не seed-данные миграций).
- **O3.** Полная деТЭЛизация оставшихся 18 вхождений (это BUILD-задачи будущих волн, не CI-инфраструктура).
- **O4.** Изменение логики/владения существующих точечных гейтов (`read-pdp-anti-case.sh`,
  `rights-ui-anti-case.sh`, `detel-literal-baseline.sh`) — они остаются в собственности своих задач
  (T-0570/T-0572/T-0575), зонтик их только оркестрирует.
- **O5.** Правки `http-route-auth-coverage.sh` за пределами FF-0328-3 `FROZEN_FILES` (FF-0328-1/2 не трогаются).
- **O6.** Новый founder_decide-сеанс для FF-0328-3 — задача использует уже существующую санкцию T-0575 +
  добавляет свою запись как её формальное завершение (не новый диалог с фаундером).

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `anti-case-lock.sh` ловит планту КАЖДОГО класса денилиста (`role-approver`, `soglasovanie`, `tel-approval`, `telLinear`, `e-larina`, `e-orlov`, `approvalRequired`-значение, `gw-approval-threshold`-значение) — подтверждено `--self-test`, планирующим по одному синтетическому файлу на литерал (или представительный поднабор, если единый детектор доказуемо покрывает все литералы одним и тем же путём) и проверяющим ненулевой exit. | fitness |
| AC-2 | Baseline точен на текущем dev (HEAD на момент мержа этой задачи): production-прогон `anti-case-lock.sh` на неизменном дереве возвращает exit 0 (каждый литерал и агрегат `<=` записанного baseline — записанные значения ИЗ разведки §2, не произвольные). | fitness |
| AC-3 | Повторный прогон на том же дереве без изменений идемпотентен: два последовательных вызова `anti-case-lock.sh` дают идентичный exit code и идентичные напечатанные числа. | fitness |
| AC-4 | Существующие точечные чеки (`read-pdp-anti-case.sh --self-test`, `rights-ui-anti-case.sh --self-test`, `detel-literal-baseline.sh --self-test`) продолжают проходить без модификации их файлов этой задачей. | fitness |
| AC-5 | `http-route-auth-coverage.sh` FF-0328-3 после правки: `FROZEN_FILES` содержит РОВНО `src/http/secret-handle.ts` (не `process-start.ts`); полный прогон скрипта (FF-0328-1/2/3) зелёный; известный санкционированный red из `frozen-sanctions.jsonl`-записи T-0575 более не воспроизводим (структурно исчез вместе с узким предикатом). | fitness |
| AC-6 | `http-route-auth-coverage.sh --self-test` остаётся зелёным после правки FF-0328-3 (три существующих само-теста FF-0328-1/2/3 логики не задеты сужением списка). | fitness |
| AC-7 | Новая запись в `ci/checks/data/frozen-sanctions.jsonl` (`task:"T-0576"`, `file:"ci/checks/http-route-auth-coverage.sh"`) присутствует и валидный JSON (compact, без интериорных пробелов в `"key":"value"`, по образцу существующих строк). | fitness |
| AC-8 | `frozen-checks-immutable.sh` (FF-FCI1..13) на этой ветке зелёный: модификация `http-route-auth-coverage.sh` (чужой чек, владелец T-0328) распознаётся как санкционированная (FF-FCI12, запись T-0576), модификация/создание СОБСТВЕННЫХ файлов задачи (`anti-case-lock.sh`, baseline-файл) проходит как own/new без нужды в санкции. | fitness |
| AC-9 | `anti-case-lock.sh` прошит в хвост `npm run fitness` в `package.json` (аддитивно, существующие звенья не переставлены/не удалены); `bash ci/checks/package-json-no-dup-keys.sh` остаётся зелёным. | fitness |
| AC-10 | Полный `npm run fitness` прогон (вся цепь, включая новое звено) зелёный на итоговом дереве задачи. | fitness |

## 7. Traceability (предварительная, детали в ADR)

AC-1..AC-4 → сам механизм гейта (FR-1..FR-4, NF-1..NF-2). AC-5..AC-8 → FF-0328-3 правка + санкция (FR-6..FR-7).
AC-9..AC-10 → wiring (FR-1, NF-3).
