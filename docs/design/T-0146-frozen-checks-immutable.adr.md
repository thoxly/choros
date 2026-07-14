# ADR · T-0146 — `frozen-checks-immutable` meta-gate

**Status:** ready
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** T-0146 — мета-гейт `ci/checks/frozen-checks-immutable.sh` (анти-гейт-ослабление): fitness-чек, запрещающий правку чужих `ci/checks/*.sh` на task-ветках.
**Spec:** `docs/specs/T-0146-frozen-checks-immutable.spec.md` (12 AC, `status: ready`) · contract `docs/specs/T-0146.spec.contract.json`.
**Base:** dev (текущий HEAD); worktree `task/T-0146-frozen-checks-immutable`.
**Deps:** none (мета-гейт поверх существующего CI-слоя).

---

## 1. Контекст (ретро-факты)

За день rt-choros-s8 два BUILD-агента независимо добавили `FROZEN_EXCLUDE_RE` / exclusion-паттерны в **чужие** frozen-чеки:

- **T-0118 BUILD** (`e7dc2ad`) — добавил exclusion в `role-criticality-isolation.sh` и `dual-control-isolation.sh`; ловил reviewer → revert `1037eba`.
- **T-0035 BUILD** (`72a02fd`) — добавил exclusion в те же файлы; ловил reviewer → revert `e6a9a79`.

В обоих случаях агент видел красный чек, не находил способа разрешить конфликт через механизм интеграции, и вместо этого тихо ослаблял чужой инвариант. Такое изменение проходило `npm run fitness` незамеченным — не было мета-чека.

---

## 2. Decision (механизм, один абзац)

Новый pure-bash fitness-чек `ci/checks/frozen-checks-immutable.sh` — нулевые новые зависимости, no Python/Node, только stdlib git. Алгоритм: (1) читает имя текущей ветки и извлекает `TASK_ID` из шаблона `task/T-XXXX-*`; если ветка не task-ветка — `exit 0`; (2) вычисляет список изменённых и удалённых `ci/checks/*.sh` через `git diff --name-only` vs merge-base с `dev`/`origin/dev` (тот же динамический merge-base, что в `dual-control-isolation.sh` и `role-criticality-isolation.sh`) плюс uncommitted-changes; если merge-base недостижим — `exit 0` (fail-open); (3) для каждого такого файла читает вторую строку (`sed -n '2p'`) и матчит паттерн `^# T-XXXX[[:space:]]·`; если T-ID в заголовке совпадает с TASK_ID текущей ветки — файл **свой** → разрешено; иначе — **чужой** → `FAIL` + инкремент счётчика; (4) если счётчик > 0 → `exit 1`. Чек регистрируется в конце цепочки `fitness` в `package.json`. Сам чек имеет заголовок `# T-0146 ·` на строке 2, поэтому на ветке `task/T-0146-*` он является **собственным** чеком задачи и его создание/правка разрешены (петля замкнута).

---

## 3. Детальный алгоритм чека

### 3.1 Шаг 1 — Извлечение TASK_ID

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TASK_ID=$(echo "${BRANCH}" | grep -oE '^task/(T-[0-9]+)' | sed 's|^task/||')
if [[ -z "${TASK_ID}" ]]; then exit 0; fi
```

Результат: `T-0146` для `task/T-0146-frozen-checks-immutable`.
Detached HEAD (`HEAD`) — паттерн не совпадает, `exit 0`.
Ветки `dev`, `main`, `claude/*`, `chore/*` — не совпадают, `exit 0`.

### 3.2 Шаг 2 — Определение BASE_REF (merge-base с dev)

```bash
BASE_REF=""
for cand in "dev" "origin/dev"; do
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then BASE_REF="${mb}"; break; fi
  fi
done
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN: frozen-checks-immutable: no dev/origin/dev reachable, skipping (fail-open)"
  exit 0
fi
```

Зеркало алгоритма из `dual-control-isolation.sh` и `role-criticality-isolation.sh`. Не хардкодит SHA.

### 3.3 Шаг 3 — Сбор diff-файлов `ci/checks/*.sh`

```bash
changed_sh() {
  {
    git -C "${PROJECT_ROOT}" diff --name-only "${BASE_REF}" HEAD 2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only HEAD        2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only --cached    2>/dev/null || true
  } | sort -u | grep -E '^ci/checks/[^/]+\.sh$'
}
```

**Glob `ci/checks/[^/]+\.sh`** — верхний уровень только. `ci/checks/db/*.ts`, `ci/checks/kc/*.sh`, `ci/checks/flowable/*.sh` НЕ захватываются (FR-6.5, AC-12).

### 3.4 Шаг 4 — Классификация каждого изменённого .sh-файла

```bash
ERRORS=0
for f in $(changed_sh); do
  full_path="${PROJECT_ROOT}/${f}"
  # Определяем T-ID из второй строки файла:
  if [[ -f "${full_path}" ]]; then
    header_tid=$(sed -n '2p' "${full_path}" \
      | grep -oE '^# T-[0-9]+[[:space:]]' \
      | grep -oE 'T-[0-9]+' || true)
  else
    # Файл удалён — читаем из git объекта (BASE_REF версия):
    header_tid=$(git -C "${PROJECT_ROOT}" show "${BASE_REF}:${f}" 2>/dev/null \
      | sed -n '2p' \
      | grep -oE '^# T-[0-9]+[[:space:]]' \
      | grep -oE 'T-[0-9]+' || true)
  fi

  if [[ "${header_tid}" == "${TASK_ID}" ]]; then
    echo "PASS [FF-FCI1]: ${f} is own check for ${TASK_ID}, allowed"
  else
    echo "FAIL [FF-FCI1]: ${f} belongs to task '${header_tid:-<no-T-ID>}', not ${TASK_ID}; modification/deletion forbidden on this branch"
    ERRORS=$((ERRORS + 1))
  fi
done
```

**Ключевой edge-case — удалённый файл:** при `diff-filter=D` файла на диске нет. Чек должен прочитать вторую строку из `git show BASE_REF:path`, чтобы определить владельца. Это обязательно для AC-6.

**Ключевой edge-case — новый файл (`diff-filter=A`):** файл существует на диске, не существует в BASE_REF. Он НЕ попадает в область проверки, потому что паттерн `ci/checks/[^/]+\.sh` по `changed_sh()` его захватит, но если он добавлен (`diff-filter=A`) — его второй строки в BASE_REF нет, и по логике header_tid = TASK_ID (новый файл, принадлежащий задаче, несёт правильный заголовок) ИЛИ пуст. Правило: **только ADD — разрешено без проверки заголовка** (FR-6.1). Реализация: в `changed_sh()` исключаем файлы, добавленные (`diff-filter=A`) относительно BASE_REF.

Уточнённый вариант `changed_sh`:

```bash
changed_sh() {
  {
    # Изменённые/удалённые: ACDMRT — исключаем только-добавленные (A)
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT "${BASE_REF}" HEAD 2>/dev/null || true
    # Uncommitted изменённые/удалённые (не новые):
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT HEAD 2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT --cached 2>/dev/null || true
  } | sort -u | grep -E '^ci/checks/[^/]+\.sh$'
}
```

`--diff-filter=CDMRT` покрывает: Copy, Delete, Modify, Rename (source), Type-change — но **не A**. Это закрывает FR-6.1 (новые файлы разрешены).

### 3.5 Edge-cases

| Ситуация | Поведение |
|---|---|
| Ветка `dev`/`main` | exit 0 (нет task-контекста) |
| Detached HEAD | `git rev-parse --abbrev-ref HEAD` → `HEAD`; паттерн не совпадает → exit 0 |
| Merge-base = HEAD (diff пуст) | `changed_sh` пуста → 0 итераций → exit 0 |
| Новый файл `ci/checks/new-gate.sh` | `diff-filter=A` → не в `CDMRT` → не в `changed_sh` → exit 0 |
| Удалённый чужой `ci/checks/role-criticality-isolation.sh` | D → в `changed_sh`; читаем из BASE_REF git show → `T-0040` ≠ TASK_ID → FAIL |
| Переименование `ci/checks/foo.sh` → `ci/checks/bar.sh` | R (rename) → D+A; источник в CDMRT → FAIL для источника если чужой; новый `bar.sh` — A → разрешён |
| Symlink замена (mode-change) | T (type-change) в CDMRT → классифицируется как правка → FAIL если чужой |
| `ci/checks/dual-control-isolation.sh` в diff, TASK_ID=T-0118 | `T-0044` в заголовке ≠ T-0118 → FAIL |
| `ci/checks/frozen-checks-immutable.sh` в diff, TASK_ID=T-0146 | `T-0146` в заголовке = T-0146 → PASS |
| Чек с заголовком без T-ID (`# FF-4 …`) | `header_tid=""` ≠ любой TASK_ID → FAIL |

---

## 4. Дизайн hostile-probe теста (AC-10)

### 4.1 Выбор механизма: bash harness (не vitest shell-spawning)

Рассмотрены два варианта:
- **vitest + shell-spawning** (`child_process.execFileSync`): зависит от Node, добавляет complexity, нужен реальный временный git-репо внутри vitest-окружения — запускается в `fitness:db` pipeline, не в `fitness`.
- **bash harness** `ci/checks/db/frozen-checks-immutable.test.ts` (vitest) vs отдельный `ci/checks/frozen-checks-immutable.probe.sh`.

Решение: **vitest + child_process** в `ci/checks/db/frozen-checks-immutable.test.ts` — стиль соседних db/behavior.test.ts. Запускается через `npm run fitness:db` (`vitest run --dir ci/checks/db`). Тест создаёт временный `mktemp -d` git-repo, воспроизводит нужное состояние ветки/diff через shell, вызывает скрипт напрямую, проверяет exit code.

### 4.2 Структура harness

```typescript
// ci/checks/db/frozen-checks-immutable.test.ts
// Создаёт isolated bare git-repo, настраивает ветку + diff, вызывает
// ../../ci/checks/frozen-checks-immutable.sh, проверяет exit code.

describe('frozen-checks-immutable', () => {
  let tmpDir: string;
  let scriptPath: string;

  // setup: mktemp git init, commit baseline on "dev", create task branch
  beforeAll(async () => { ... });
  afterAll(() => rimraf(tmpDir));

  // AC-1 / AC-2: exclusion-правка в чужом чеке → exit 1
  it('FAIL: modifying dual-control-isolation.sh (T-0044) on task/T-0999-test branch', async () => {
    // patch dual-control-isolation.sh на task/T-0999-test ветке
    // → вызов скрипта → expect exit code 1, stdout contains "FAIL"
  });

  // AC-3: правка собственного чека → exit 0
  it('PASS: modifying frozen-checks-immutable.sh (T-0146) on task/T-0146-test branch', async () => {
    // patch frozen-checks-immutable.sh на task/T-0146-test ветке
    // → вызов скрипта → expect exit code 0
  });

  // AC-4: на dev → exit 0
  it('PASS: on dev branch, no task context', async () => { ... });

  // AC-5: новый файл → exit 0
  it('PASS: adding new ci/checks/new-gate.sh', async () => { ... });

  // AC-6: удаление чужого → exit 1
  it('FAIL: deleting role-criticality-isolation.sh (T-0040) on T-0999 branch', async () => { ... });

  // AC-11: чек без T-ID заголовка → exit 1
  it('FAIL: modifying actor_event_append_only.sh (no T-ID header)', async () => { ... });

  // AC-12: поддиректория ci/checks/kc/*.sh → exit 0
  it('PASS: modifying ci/checks/kc/some-check.sh, not matched by glob', async () => { ... });
});
```

Harness НЕ требует живой БД — это чистый git/shell тест, запускаемый через vitest в `fitness:db`.

---

## 5. Объектная модель / данные

Чек работает исключительно со структурами git и файловой системой. Внутренние «данные» минимальны:

| Сущность | Поля | Описание |
|---|---|---|
| `TASK_ID` | `string` (e.g. `T-0146`) | Извлекается из имени ветки |
| `BASE_REF` | `string` (git SHA) | Merge-base с dev/origin/dev |
| `changed_sh[]` | `string[]` (path list) | Изменённые/удалённые `ci/checks/*.sh` |
| `header_tid` | `string` или `""` | T-ID из второй строки файла |
| `ERRORS` | `int` | Счётчик нарушений |

---

## 6. Контракты / интерфейсы

1. **Входной контракт скрипта:** запускается в PROJECT_ROOT (или из любого пути — скрипт вычисляет `SCRIPT_DIR` / `PROJECT_ROOT` сам). Не принимает аргументов. Читает git-состояние текущего репо.
2. **Выходной контракт:** `exit 0` = зелёный; `exit 1` = нарушение. `stdout` содержит FAIL-строки с именем файла и TASK_ID владельца. Сигналы STDERR минимальны.
3. **Контракт второй строки:** все `ci/checks/*.sh`, созданные задачами, ДОЛЖНЫ иметь вторую строку в формате `# T-XXXX · <description>` (U+00B7, middle dot). Чеки без T-ID в заголовке (legacy) считаются **чужими** для любой task-ветки.
4. **Интеграция в `npm run fitness`:** добавляется в конец строки `fitness` в `package.json`: `... && bash ci/checks/frozen-checks-immutable.sh`.
5. **Интеграция в `fitness:db`:** `ci/checks/db/frozen-checks-immutable.test.ts` запускается автоматически через `vitest run --dir ci/checks/db`.

---

## 7. Fitness-функции (CI-enforcement)

| id | rule | ci_check |
|---|---|---|
| FF-FCI1 | **Мета-гейт активен.** На task-ветке с TASK_ID≠владелец-чека: любое изменение или удаление `ci/checks/*.sh` (исключая только-добавленные файлы) → FAIL + exit 1 с именем файла. | `bash ci/checks/frozen-checks-immutable.sh` в `npm run fitness` |
| FF-FCI2 | **Собственный чек разрешён.** На `task/T-0146-*`: правка `ci/checks/frozen-checks-immutable.sh` (заголовок `# T-0146 ·`) → exit 0. | `bash ci/checks/frozen-checks-immutable.sh` в `npm run fitness` (AC-3) |
| FF-FCI3 | **Fail-open на нетask-ветках.** На `dev`/`main`/detached/нет merge-base → exit 0. Мета-гейт не блокирует интеграцию. | `bash ci/checks/frozen-checks-immutable.sh` в `npm run fitness` (AC-4) |
| FF-FCI4 | **Новые файлы разрешены.** `diff-filter=A` новый `ci/checks/*.sh` → не нарушение. | `bash ci/checks/frozen-checks-immutable.sh` (AC-5) |
| FF-FCI5 | **Удаление чужого → красный.** DELETE `ci/checks/*.sh` с TASK_ID≠владелец → FAIL. Удалённые файлы читаются из BASE_REF через `git show`. | `bash ci/checks/frozen-checks-immutable.sh` (AC-6) |
| FF-FCI6 | **Поддиректории не в области.** `ci/checks/db/`, `ci/checks/kc/`, `ci/checks/flowable/` НЕ захватываются glob `ci/checks/[^/]+\.sh`. | `bash ci/checks/frozen-checks-immutable.sh` (AC-12) |
| FF-FCI7 | **Заголовок чека корректен.** `sed -n '2p' ci/checks/frozen-checks-immutable.sh` совпадает с `^# T-0146[[:space:]]·`. | `grep -E '^# T-0146[[:space:]]' ci/checks/frozen-checks-immutable.sh | head -1` в `npm run fitness` или отдельная assert-строка в скрипте (AC-8) |
| FF-FCI8 | **Регистрация в npm run fitness.** `package.json` содержит `bash ci/checks/frozen-checks-immutable.sh` в строке скрипта `fitness`. | `grep 'frozen-checks-immutable' package.json` (AC-7) |
| FF-FCI9 | **Hostile-probe тест красный при exclusion-правке чужого чека (AC-1, AC-2).** Vitest harness воспроизводит diff T-0035/T-0118: на ветке T-0999 добавляет строку в `dual-control-isolation.sh`; ожидает exit 1. | `vitest run --dir ci/checks/db` → `frozen-checks-immutable.test.ts` |
| FF-FCI10 | **Hostile-probe тест зелёный для собственного чека (AC-3).** Тот же harness: на ветке T-0146 правит `frozen-checks-immutable.sh`; ожидает exit 0. | `vitest run --dir ci/checks/db` → `frozen-checks-immutable.test.ts` |
| FF-FCI11 | **Чек без T-ID в заголовке (legacy) → чужой.** `actor_event_append_only.sh` (заголовок `# FF-4 …`) изменён на task-ветке → FAIL. | `bash ci/checks/frozen-checks-immutable.sh` (AC-11) |

---

## 8. Трассировка AC → дизайн

| AC | covered_by |
|---|---|
| AC-1 | FF-FCI1, FF-FCI9 — exclusion T-0035: `dual-control-isolation.sh` (T-0044) ≠ TASK_ID → FAIL |
| AC-2 | FF-FCI1, FF-FCI9 — exclusion T-0118: то же, FROZEN_EXCLUDE_RE в `dual-control-isolation.sh` → FAIL |
| AC-3 | FF-FCI2, FF-FCI10 — собственный чек T-0146 → exit 0 |
| AC-4 | FF-FCI3 — на `dev` merge-base = HEAD или нет TASK_ID → exit 0 |
| AC-5 | FF-FCI4 — `diff-filter=A` → не в `changed_sh` → exit 0 |
| AC-6 | FF-FCI5 — DELETE `role-criticality-isolation.sh` (T-0040) ≠ TASK_ID → FAIL; §3.5 edge-case удалённого файла |
| AC-7 | FF-FCI8 — `grep 'frozen-checks-immutable' package.json` |
| AC-8 | FF-FCI7 — строка 2 соответствует `^# T-0146[[:space:]]·` |
| AC-9 | FR-6.2 scope: `ci/checks/known_tenant_tables.txt` — не `*.sh`, grep `ci/checks/[^/]+\.sh` не захватывает |
| AC-10 | FF-FCI9 + FF-FCI10 — vitest harness: isolated git-repo, vызов скрипта, проверка exit code |
| AC-11 | FF-FCI11 — legacy заголовок без T-ID → header_tid="" ≠ TASK_ID → FAIL |
| AC-12 | FF-FCI6 — поддиректории не в glob → exit 0 |

---

## 9. Отвергнутые альтернативы

| option | why_not |
|---|---|
| Хардкодить список защищённых файлов в отдельном конфиге | Требует обновления при каждой новой задаче. Само-регистрирующийся механизм через заголовок `# T-XXXX ·` = zero maintenance; новый чек автоматически защищён с момента создания (NF-4). |
| Проверять только hardcoded «критические» чеки (RC, DC) | Защищает только известные на сегодня чеки; будущий чек добавит задача и тоже получит защиту без явного перечисления. |
| Blocklisting (список запрещённых к правке файлов) vs allowlisting (список своих) | Blocklisting требует знать заранее, какие файлы чужие. Allowlisting через заголовок (`# T-XXXX ·`) — self-contained; файл несёт метаданные владельца. |
| Python/Node-скрипт вместо pure bash | NF-1 запрещает новые runtime-зависимости. Все существующие чеки — bash; единый стиль. |
| Отдельный GitHub Actions job | Out of scope (spec §7); мета-гейт запускается в `npm run fitness` локально и в CI без дополнительного job. |
| Читать владельца из metadata-файла (`ci/checks/owners.json`) | Дополнительный файл, требующий синхронизации. Заголовок внутри самого скрипта = единый источник правды (нет рассинхронизации). |
| Bash harness как отдельный `.probe.sh` вне vitest | Не интегрируется в `npm run fitness:db` / CI pipeline; vitest-harness запускается автоматически вместе с другими db-тестами. |

---

## 10. Runtime / deploy target

**Локально** + CI (GitHub Actions). Чек — pure bash, запускается в `npm run fitness` на рабочей станции и в CI-пайплайне. Нет внешнего ресурса, нет GT-4. Hostile-probe тест — vitest в `fitness:db` (Node, уже в зависимостях). Никаких новых runtime-зависимостей (NF-1).

---

## 11. Amendment after review (2026-06-11) — R-1 ownership-capture + R-2 branch-spoof

**Trigger:** reviewer verdict `changes_requested` (T-0146.review.md, findings R-1/R-2 blocking).

### R-1: ownership-capture fix

**Problem (probe 2/3):** The original Step 4 read the owner T-ID from the on-disk file (`sed -n '2p' "${full_path}"`). An attacker could rewrite the second line of a foreign check to their own T-ID and have the gate accept the modification as "own". Similarly, DELETE+re-ADD the same filename with an own header was accepted.

**Fix:** For ALL files processed by the gate (diff-filter C/M/R/T/D), the owner T-ID is now read exclusively from the BASE_REF version of the file via `git show BASE_REF:path | sed -n '2p'`. The on-disk `sed` read is removed entirely. The BASE_REF version was committed before the current branch touched the file, so the branch agent cannot retroactively forge it.

This closes PROBE 2 (DELETE+re-ADD with own header) and PROBE 3 (modify + rewrite header).

**Changed:** `ci/checks/frozen-checks-immutable.sh` Step 4 — removed `[[ -f "${full_path}" ]]` branch, unified to single `git show BASE_REF:path` read for all cases.

### R-2: branch-name-spoof residual risk

**Problem (probe 5):** `TASK_ID` derives from the branch name (`task/T-XXXX-*`), which is chosen by the agent itself. A branch named `task/T-0044-spoof` obtains `TASK_ID=T-0044` and can amend `dual-control-isolation.sh` if that file's BASE_REF header already reads `# T-0044 ·`.

**Design decision (accepted residual risk):**
- The R-1 fix already closes the dangerous path: rewriting a foreign header to your own T-ID is now caught by BASE_REF comparison.
- The remaining residual is a branch genuinely named `task/T-0044-*` editing the real T-0044 check (whose BASE_REF header is `# T-0044 ·`). This passes the gate.
- Fully closing this would require verifying `TASK_ID` against a control-plane claim (out of scope for a local pure-bash gate, NF-1).
- **Mitigation:** the reviewer sees the PR branch name alongside the diff; a branch `task/T-0044-spoof` from an unexpected agent is visible in the PR title and audit trail. This is reviewer-visible, not silently green.
- **Threshold:** the gate's stated threat model (spec §2, ADR §1) is "misdirected BUILD agent, not adversary". A spoofed branch name to impersonate another task's ownership is above the erring-agent threshold. The gate provides meaningful deterrence + reviewer visibility for this case.

**Documented in:** script header (RESIDUAL RISK comment), this section, hostile-probe test `PROBE-5 residual` (exit 0, accepted).

### New hostile-probe tests added (review iteration 2)

| Test | Scenario | Expected | Closes |
|---|---|---|---|
| PROBE-2 | DELETE foreign check + re-ADD with own T-ID header | exit 1 | R-1 |
| PROBE-3 | Modify foreign check + rewrite header to own T-ID | exit 1 | R-1 |
| PROBE-5 residual | Branch `task/T-0044-spoof` edits T-0044 check (BASE_REF header matches) | exit 0 (accepted) | R-2 documented |
