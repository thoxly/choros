# ADR · T-0576 — анти-кейс CI-гейт (D-064 п.2, закон границы)

**Status:** ready (no blocking questions)
**Phase:** DESIGN
**Wave:** W1/анти-кейс-CI
**Date:** 2026-07-02
**Spec:** `docs/specs/T-0576-anticase-ci.spec.md`

---

## 1. Решение

Один новый зонтичный скрипт `ci/checks/anti-case-lock.sh`, состоящий из двух фаз:

**Фаза 1 (делегирование).** Вызывает три существующих точечных анти-кейс гейта КАК ЕСТЬ, как
сабпроцессы, не трогая их код/владение:
- `read-pdp-anti-case.sh` (T-0570) — git-diff-scoped на `src/`, 7 литералов
- `rights-ui-anti-case.sh` (T-0572) — git-diff-scoped на `web/src/`, тот же список
- `detel-literal-baseline.sh` (T-0575) — repo-wide code-only baseline на 3 литерала

**Фаза 2 (полный денилист, свой скан).** Repo-wide code-only подсчёт ПОЛНОГО денилиста карты
примитивов §5 (все 8 позиций: `role-approver`, `soglasovanie`, `tel-approval`, `telLinear`,
`e-larina`, `e-orlov`, `approvalRequired`/`TEL_GATEWAY_VAR`, `gw-approval-threshold`/
`TEL_GATEWAY_ID`) поверх `src/**/*.ts` и `web/src/**/*.{jsx,tsx}`, сравниваемый с data-baseline-
файлом `ci/checks/data/anti-case-baseline.json` по семантике `<=` (erodes-or-steady, никогда не
растёт) — как per-литерал, так и агрегатно.

Отдельно: правка `ci/checks/http-route-auth-coverage.sh` §5 FF-0328-3 (чужой чек, владелец
T-0328) — сужение `FROZEN_FILES` до одного `secret-handle.ts`, снимающее известный
санкционированный known-red, названный в записи T-0575 в `frozen-sanctions.jsonl` как явный
follow-up этой задачи.

### Почему зонтик-делегатор, а не единая переписанная логика

Рассмотренные варианты (§2 rejected_alternatives) сводились к трём формам:
(а) зонтик, вызывающий существующие точечные гейты + добирающий непокрытое собственным сканом
(**выбрано**); (б) заменить три точечных гейта одним монолитным чеком; (в) не строить зонтик,
просто расширить `detel-literal-baseline.sh` до полного денилиста.

(а) выбран, потому что: (1) `read-pdp-anti-case.sh`/`rights-ui-anti-case.sh` — git-diff-scoped
(ловят вросты В ДИФФЕ конкретной будущей задачи, раньше репо-wide проверки); их семантика
принципиально ИНАЯ и ДОПОЛНЯЮЩАЯ, а не заменяемая repo-wide baseline-проверкой — задача явно
требует «НЕ ломая их — они принадлежат своим задачам»; (2) три чека принадлежат трём разным
задачам (T-0570/T-0572/T-0575), `frozen-checks-immutable.sh` FF-FCI1 запрещает T-0576 их
редактировать без санкции — переписывание их логики внутрь монолита потребовало бы либо их
модифицировать (нарушение владения), либо тройного дублирования кода (грязный копипаст).
Делегирование через `bash <script>` в сабпроцессе не требует владения — вызов чужого
исполняемого файла не является его модификацией.

## 2. Отвергнутые альтернативы

| Вариант | Почему отвергнут |
|---|---|
| Б1. Единый монолитный чек, дублирующий git-diff-scoped логику трёх существующих гейтов заново | Дублирует уже написанный, протестированный код (санитайзер комментариев T-0570, R-1-исправленная защита от bypass через trailing-comment) — риск рассинхронизации логики между копиями; нарушает «не ломая их» из формулировки задачи. |
| Б2. Заменить `detel-literal-baseline.sh` (T-0575, 3 литерала) новым файлом с полным денилистом, удалив старый | `frozen-checks-immutable.sh` запрещает T-0576 удалять чужой чек (владелец T-0575) без санкции; T-0575's AC-10/FF-7 — контракт этой задачи со своим "strictly less" семантикой (baseline входа для T-0576) — удаление сломало бы её собственную acceptance-историю. |
| В1. Расширить `detel-literal-baseline.sh` литералами денилиста напрямую (правка чужого файла) | Тот же запрет владения; кроме того, семантика T-0575 («строго меньше» — one-time reduction proof для её собственного диффа) отличается от нужной T-0576 семантики («не больше» — steady-state guard навсегда) — смешивание двух разных контрактов в одном файле путает читателя будущего ADR. |
| Г1. Baseline как встроенная bash-константа внутри `anti-case-lock.sh` (аналог `detel-literal-baseline.sh`'s `BASELINE_*` переменных) вместо отдельного data-файла | Спека NF-5 явно требует data-файл (не код) — сам факт, что порог живёт вне исполняемого скрипта, делает любое БУДУЩЕЕ расширение видимым как отдельная строка в git diff data-файла, а не спрятанным внутри логики скрипта; это тот же принцип, что `frozen-sanctions.jsonl` (append-only data, не код). |
| Г2. JSON-схема с nested-объектами (`{"src": {...}, "web": {...}}`) для baseline | Избыточно для плоского набора из 8 ключей + агрегат; плоский объект читается grep'ом без парсера (zero-dep, тот же принцип, что весь control-plane — `validate.py`'s docstring: "тупой код без зависимостей"). |
| Д1. НЕ трогать FF-0328-3 в этой задаче, оставить known-red документированным навсегда | Отклонено — запись T-0575 в `frozen-sanctions.jsonl` explicit называет T-0576 её follow-up исполнителем; оставить нерешённым means накопление второй санкции при каждой будущей правке `process-start.ts` (тот же паттерн повторных санкций, который D-064 сама называет дрейфом). |
| Д2. Полностью снять байт-фриз с `process-start.ts` (удалить весь арм FF-0328-3 для этого файла) | Отклонено — ADR T-0328 §4.2 сам называет `process-start.ts` "contract-frozen" (не "unfrozen") — контракт (REST-форма) остаётся enforced отдельным структурным гейтом `start-route-isolation.sh`; T-0576 не отменяет фриз, только чинит НЕТОЧНОЕ ПРЕДСТАВЛЕНИЕ этого фриза (byte-diff вместо contract-check) в чужом файле. |

## 3. Fitness Functions

| ID | Rule | ci_check |
|---|---|---|
| FF-T0576-1 | `anti-case-lock.sh` фаза 1 делегирует ко всем трём существующим точечным гейтам без модификации их файлов; их собственные `--self-test` остаются зелёными. | `bash ci/checks/read-pdp-anti-case.sh --self-test && bash ci/checks/rights-ui-anti-case.sh --self-test && bash ci/checks/detel-literal-baseline.sh --self-test` (AC-4) |
| FF-T0576-2 | `anti-case-lock.sh` фаза 2 ловит планту КАЖДОГО класса денилиста — представительный self-test (одна литерал-семья на `src`-скоуп, одна на `web/src`-скоуп, один "TEL_GATEWAY-семейства" литерал, доказывающий детектор не hand-tuned на 3 литерала T-0575) плюс доказательство, что comment/test-file occurrences НЕ ложно-срабатывают. | `bash ci/checks/anti-case-lock.sh --self-test` (AC-1) |
| FF-T0576-3 | Production-прогон на текущем dev даёт КАЖДЫЙ литерал `<=` записанного baseline и агрегат `<=` записанного агрегата (значения зафиксированы §4 ниже; проверено разведкой на HEAD задачи). | `bash ci/checks/anti-case-lock.sh` (exit 0) (AC-2) |
| FF-T0576-4 | Повторный прогон на неизменном дереве идемпотентен (два последовательных вызова дают идентичный stdout+exit code). | ручной прогон дважды подряд, diff вывода = пусто (проверено при DESIGN — см. §5); фиксируется как регрессионный инвариант, не отдельный скрипт (сам подсчёт детерминирован — grep над неизменными файлами не может дать разные числа) (AC-3) |
| FF-T0576-5 | `http-route-auth-coverage.sh` FF-0328-3 после правки: `FROZEN_FILES` содержит РОВНО `src/http/secret-handle.ts`; полный прогон (FF-0328-1/2/3) и `--self-test` зелёные. | `bash ci/checks/http-route-auth-coverage.sh && bash ci/checks/http-route-auth-coverage.sh --self-test` (AC-5/AC-6) |
| FF-T0576-6 | Новая санкц-запись в `frozen-sanctions.jsonl` (`task:"T-0576"`, `file:".../http-route-auth-coverage.sh"`) валидный JSON, признаётся мета-гейтом как founder-класс санкция. | `bash ci/checks/frozen-checks-immutable.sh` (проверяет SANCTION/AUDIT строки на этой ветке) (AC-7/AC-8) |
| FF-T0576-7 | `anti-case-lock.sh` (+ `--self-test`) прошиты аддитивно в хвост `npm run fitness`; порядок существующих звеньев не нарушен. | `bash ci/checks/package-json-no-dup-keys.sh` + визуальный diff `package.json` (единственное изменение — хвост строки `fitness`) (AC-9) |
| FF-T0576-8 | Полный `npm run fitness` прогон зелёный на итоговом дереве задачи (включая новое звено). | `npm run fitness` (AC-10) |
| FF-T0576-9 (мета, no-weakening) | Baseline-файл — единственный источник порогов; никакая future-задача не может расширить его молча (git diff на data-файл ВСЕГДА виден в review; сам `anti-case-lock.sh` не содержит встроенных чисел-порогов). | ручная проверка при ревью — `ci/checks/data/anti-case-baseline.json` содержит `_comment`, объясняющий контракт, читаемый людьми при любом будущем PR, трогающем этот файл. |

## 4. Baseline (зафиксировано на HEAD задачи, разведка §2 spec)

`ci/checks/data/anti-case-baseline.json`:

```json
{
  "role-approver": 2,
  "soglasovanie": 2,
  "tel-approval": 1,
  "telLinear": 8,
  "e-larina": 2,
  "e-orlov": 2,
  "approvalRequired": 1,
  "gw-approval-threshold": 1,
  "aggregate": 19
}
```

`telLinear:8` = 7 code-only вхождений в `src/**/*.ts` (`process-catalog-view.ts:89`,
`process-projection.ts:850/928/964/1129/1799/1875`) + 1 в `web/src/forms/FormBuilder.jsx:509`
(`placeholder="telLinear"` — UI-подсказка формата ключа процесса, НЕ хардкод-значение бизнес-
логики; включена в baseline ради честности подсчёта, не как нарушение, требующее фикса).

Три из восьми ключей (`role-approver:2`, `soglasovanie:2`, `tel-approval:1`) СОВПАДАЮТ с
production-выводом `detel-literal-baseline.sh` (T-0575's собственный текущий count после её
уменьшения с 7 до 5 в агрегате по трём литералам — числа по отдельным литералам,
2/2/1, идентичны между двумя чеками, т.к. считаются той же code-only методологией над тем же
деревом).

## 5. Верификация DESIGN-фазы (проведена при написании этого ADR)

- `bash ci/checks/anti-case-lock.sh --self-test` → PASS (все три представительные литерал-семьи
  детектируются, comment/test-file exclusion корректен).
- `bash ci/checks/anti-case-lock.sh` (production) → PASS (Phase 1 все три делегата зелёные;
  Phase 2 — все 8 литералов `== baseline`, агрегат `19 == 19`).
- Идемпотентность: два последовательных прогона дали побайтово идентичный stdout и `rc=0`.
- `git status --porcelain ci/checks/{read-pdp-anti-case,rights-ui-anti-case,detel-literal-baseline}.sh`
  → пусто (делегаты НЕ модифицированы).
- `bash ci/checks/http-route-auth-coverage.sh --self-test` → PASS после сужения `FROZEN_FILES`.
- `bash ci/checks/http-route-auth-coverage.sh` (production) → PASS, FF-0328-3 арм печатает ровно
  одну строку `PASS (FF-0328-3): src/http/secret-handle.ts byte-unchanged vs merge-base`
  (`process-start.ts` больше не участвует в этом арме).
- `bash ci/checks/frozen-checks-immutable.sh` на ветке `task/T-0576-anticase-ci` → PASS, печатает
  `SANCTION [FF-FCI12]` + `AUDIT [FF-FCI12]` для правки `http-route-auth-coverage.sh` (санкция
  распознана как founder-класс).
- `bash ci/checks/package-json-no-dup-keys.sh` → PASS после аддитивной правки хвоста `fitness`.

## 6. Traceability

| AC | Covered by |
|---|---|
| AC-1 | §1 фаза 2 механизм; FF-T0576-2 |
| AC-2 | §4 baseline-таблица; FF-T0576-3 |
| AC-3 | §5 идемпотентность-проверка; FF-T0576-4 |
| AC-4 | §1 фаза 1 делегирование (не модифицирует делегатов); FF-T0576-1 |
| AC-5 | §1 правка FF-0328-3; FF-T0576-5 |
| AC-6 | §1 правка FF-0328-3 (self-test); FF-T0576-5 |
| AC-7 | §1 санкц-запись; FF-T0576-6 |
| AC-8 | §1 санкц-запись; FF-T0576-6 |
| AC-9 | §3 wiring; FF-T0576-7 |
| AC-10 | §5 полный прогон; FF-T0576-8 |

## 7. Governance note (санкция FF-0328-3)

Правка `ci/checks/http-route-auth-coverage.sh` (владелец T-0328) санкционирована ДВУМЯ записями в
`ci/checks/data/frozen-sanctions.jsonl`:
1. Существующая запись `task:"T-0575"` (документарная — сама НЕ редактирует чек, только
   санкционирует T-0575's собственный diff `process-start.ts` под старым, ещё не суженным
   предикатом; explicit follow-up: «T-0576 will align FF-0328-3 §5 ... under its own sanction»).
2. Новая запись этой задачи, `task:"T-0576"`, `sanctioned_by:"founder"` (не `auto_additive`/
   FF-FCI13 — сужение allowlist/frozen-set предиката — это СОКРАЩЕНИЕ enforcement-поверхности
   чужого чека, не провably-additive A-1..A-4 thaw; тот же governance-класс, что запись T-0575).

Обе записи вместе дают полную аудиторскую цепочку: T-0575 объясняет ПОЧЕМУ её собственный diff
`process-start.ts` был безопасен под СТАРЫМ (широким) предикатом; T-0576 объясняет ПОЧЕМУ сам
предикат был неточен относительно ADR §4.2 и как он теперь исправлен.
