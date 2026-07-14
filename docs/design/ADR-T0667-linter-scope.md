# ADR-T0667 — candidategroups-role-slug-linter: evidence вне скана, не в линтере

Status: ready
Task: T-0667 (substrate/gate-integrity)
Base: dev@73f86df, branch `task/T-0667-candidategroups-linter-scope`

## 1. Problem

`ci/checks/candidategroups-role-slug-linter.sh` (T-0336, деплой-time линтер
`candidateGroups` → `role.slug`) КРАСНЫЙ на dev:

```
FAIL 'role-manager' — NOT found in any migration SQL (production BPMN requires a seeded role)
FAIL 'role-owner' — NOT found in any migration SQL (production BPMN requires a seeded role)
```

на `docs/live-proof/T-0612-evidence/T-0612-liveproof-defect.bpmn20.xml`.
Этот файл — намеренно ДЕФЕКТНАЯ модель из live-proof T-0612 «Уровень 1»:
доказывает, что линтер блокирует публикацию BPMN с незасеянными ролями
(`docs/live-proof/T-0612.live-proof.md` описывает сценарий явно). Файл — не
production-артефакт, не деплоится, не относится ни к одному тенанту; это
доказательная фикстура, зафиксированная как evidence прошлого прогона.

Красный fitness на dev нарушает D-056 (гейты фабрики должны быть зелёными на
dev; красный гейт маскирует реальные регрессии под шум).

## 2. Root cause

Линтер (`ci/checks/candidategroups-role-slug-linter.sh:167-174`) собирает ВСЕ
`*.bpmn`/`*.bpmn20.xml` под `PROJECT_ROOT` (за вычетом `node_modules`/`.git`) и
классифицирует `is_prod=true` для ЛЮБОГО пути вне `seed/*` — включая
`docs/live-proof/**`, `src/__tests__/fixtures/**`, `spikes/**`. Изначальный
design (T-0336) знал только про две категории: `config/` (production) и
`seed/` (demo/showcase, → WARN). `docs/live-proof/**` появился ПОЗЖЕ (T-0612,
эпоха D-064 LIVE_PROOF-фазы) как каталог доказательных прогонов и никогда не
был учтён в этой бинарной классификации — отсюда ложный FAIL.

## 3. Frozen-check constraint (проверено)

`ci/checks/candidategroups-role-slug-linter.sh` строка 2:
`# T-0336 [E15-S2]: candidateGroups → role.slug deploy-time linter` —
владелец T-0336. Текущая задача — T-0667.

`ci/checks/frozen-checks-immutable.sh` (FF-FCI1..13) — на task-ветке
(`task/T-0667-…` → `TASK_ID=T-0667`) любой diff (`CDMRT`, т.е. change/delete/
rename/type-change; НЕ add) файла `ci/checks/*.sh`, чей BASE_REF-заголовок
несёт ИНОЙ T-ID, — FAIL, если только:
- нет founder-санкции в `ci/checks/data/frozen-sanctions.jsonl`
  (`{"task":"T-0667","file":"ci/checks/candidategroups-role-slug-linter.sh"}`),
  ИЛИ
- нет auto_additive-санкции (T-0232 путь, тоже отсутствует).

Проверено: `grep -i "T-0667\|candidategroups" ci/checks/data/frozen-sanctions.jsonl`
— ни одной строки. **Санкции нет.** Значит редактирование verdict-логики
линтера (в т.ч. добавление exclude-паттерна ВНУТРИ скрипта) запрещено этой
задаче без founder_decide. Запрашивать founder-санкцию для правки одного
`find`-паттерна — несоразмерно риску: есть менее инвазивный путь (§4), не
требующий трогать чужой frozen-файл вообще.

## 4. Decision — переименовать evidence, не редактировать линтер

Переименовать оба evidence-файла (add `.txt`), чтобы glob линтера
(`-name "*.bpmn" -o -name "*.bpmn20.xml"`) их не матчил:

- `docs/live-proof/T-0612-evidence/T-0612-liveproof-defect.bpmn20.xml` →
  `T-0612-liveproof-defect.bpmn20.xml.txt`
- `docs/live-proof/T-0612-evidence/T-0612-liveproof-fixed.bpmn20.xml` →
  `T-0612-liveproof-fixed.bpmn20.xml.txt`

Это НЕ изобретение — та же конвенция УЖЕ используется в кодовой базе:
`docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt` (сам T-0612,
референс в `ci/checks/flowable/purchase-approval-convergence-smoke.sh:11,45`).
`.txt`-суффикс = установленный сигнал «BPMN-подобный текстовый артефакт,
намеренно НЕ адресуемый деплой/линтер-сканерами по расширению».

### Почему это НЕ ослабление гейта (scope-correction)

1. Verdict-логика (`is_prod`, WARN/FAIL, seed-исключение) — байт-в-байт
   нетронута. Ни один production-путь не выведен из-под строгой проверки.
2. Единственное, что изменилось — ДВА конкретных файла перестали
   ошибочно матчиться glob'ом, потому что они никогда не были
   production-BPMN — это исторические доказательные фикстуры, зафиксированные
   как evidence оконченного live-proof прогона T-0612.
3. Мутационная проверка (см. §5) доказывает: линтер по-прежнему ПАДАЕТ на
   реальном production `.bpmn`/`.bpmn20.xml` с незасеянным
   `candidateGroups` — детектор жив, просто больше не видит несуществующий
   "production"-файл там, где production никогда не было.
4. Обратное решение («расширить `is_prod=false` на `docs/live-proof/**`
   внутри линтера») было бы ФУНКЦИОНАЛЬНО эквивалентно (то же исключение
   из строгого скана), но потребовало бы правки чужого frozen-файла без
   санкции — отклонено как более рискованный путь (нарушение
   frozen-checks-immutable без обоснованной необходимости, когда
   file-rename достигает той же цели с нулевым риском для чужого гейта).

## 5. Мутационная проверка (доказательство: детектор жив)

Временно создан `config/flowable/processes/_mutation-test-tmp/T-0667-mutation-probe.bpmn20.xml`
(production-путь, вне `seed/`):

```xml
<userTask id="t1" flowable:candidateGroups="role-definitely-not-seeded-xyz" .../>
```

Прогон линтера:

```
FAIL 'role-definitely-not-seeded-xyz' — NOT found in any migration SQL (production BPMN requires a seeded role)
FAIL: candidategroups-role-slug-linter found 1 error(s), 4 warning(s)
```

`echo $?` → `1`. Файл и временная директория удалены сразу после проверки
(`rm -rf config/flowable/processes/_mutation-test-tmp`) — не входят в
финальный diff.

## 6. Rejected alternatives

1. **Править `find`/exclude внутри линтера напрямую.** Технически самое
   «чистое» решение (один `-not -path "*/docs/live-proof/*"` в
   `find`-инвокации), но линтер владеет T-0336 → FAIL
   `frozen-checks-immutable` без санкции. Отклонено: несоразмерный риск
   ради экономии одной строки, когда есть zero-risk альтернатива.
2. **Запросить founder-санкцию (`ci/checks/data/frozen-sanctions.jsonl`,
   FF-FCI12) на правку линтера.** Технически доступный путь, но требует
   founder_decide — эскалация не оправдана: задача явно разрешает
   «переименовать/убрать evidence-файлы» как менее рискованную
   альтернативу, что и выбрано.
3. **Удалить evidence-файлы из репозитория.** Отклонено — доказательные
   XML-фикстуры имеют историческую/аудиторскую ценность (доказывают, что
   T-0612 live-proof реально нашёл дефектную и исправленную модели);
   переименование сохраняет файлы и их назначение, только снимает их с
   глаз деплой-линтера.
4. **Общий каталог-суффикс `docs/**/evidence/**` exclude в линтере** (как
   предлагала задача «разумно»). Тоже требует правки чужого frozen-файла
   без санкции — тот же отказ, что и (1). Единственный evidence-путь с
   BPMN-расширением в текущем репозитории — `T-0612-evidence/`; расширять
   правило на гипотетические будущие `evidence/` каталоги без реальной
   потребности сейчас было бы преждевременной генерализацией chужого
   frozen-кода. Если такие каталоги появятся позже — та же задача (rename)
   решает их точечно, без правки линтера.

## 7. Verification

- `bash ci/checks/candidategroups-role-slug-linter.sh` → PASS (with
  warnings; 4 WARN на `seed/vendor-crm` — pre-existing, не regressии).
- `bash ci/checks/candidategroups-role-slug-linter.sh --self-test` → PASS
  (детекторы линтера сами по себе не менялись).
- `bash ci/checks/frozen-checks-immutable.sh` → PASS (`ci/checks/*.sh` diff
  пуст — линтер не тронут ни байтом).
- `bash ci/checks/anti-case-lock.sh` → PASS (aggregate literal count не
  вырос).
- `npm run build` → 0 ошибок (после `npm ci --maxsockets=3`; worktree был
  провижен без `node_modules` — pre-existing infra-friction, не связано с
  задачей).

## 8. Scope boundary

Эта задача НЕ трогает: verdict-логику `candidategroups-role-slug-linter.sh`,
любой другой `ci/checks/*.sh`, кейс-контент, production BPMN-каталоги
(`config/`, `seed/`). Единственное изменение — rename двух файлов под
`docs/live-proof/T-0612-evidence/`.
