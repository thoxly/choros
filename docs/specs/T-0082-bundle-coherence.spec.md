# Spec · T-0082 — E12.1: Bundle Coherence Unit + CI Guard

**Phase:** SPEC · **Status:** ready (no blocking questions) · **Date:** 2026-06-11
**Task:** E12.1 — Когерентная единица версионирования связки (BPMN↔форма-код↔form-schema↔object-schema↔grants) + bundle-coherence CI-гард [ADR §7/§9.4]
**Raw TZ:** `docs/design/extensibility-and-authoring.md` §7 (+§9.4)
**Parent:** T-0071 (E12 — extensibility/authoring foundation)
**Deps:** T-0014 (registry_def / record_schema), T-0018 (grant table / lattice), T-0027 (bpmn-linter), T-0087 (тиры — в работе параллельно, NOT конфликт по файлам; шов: §3.2)
**Consumed by:** T-0077 (E11.6 config-agent), T-0084 (changelog/diff валидатор), T-0130 (simulate в draft-тире)

---

## 0. Контекст и ограничения scope — расхождение target-state с repo

> **КРИТИЧНЫЙ УРОК FE-2026-W24-0087-A** — всё ниже сверено с фактическим состоянием репо.

ADR §7 описывает ЦЕЛЕВОЕ состояние: git-под-капотом, когерентный коммит пятичленной
связки **BPMN ↔ форма-код ↔ form-JSON-Schema ↔ object-schema ↔ role/agent/MCP-grants**.

Что **существует сейчас** в Choros (migrations/001..043):

| Член связки | Фактическое состояние |
|---|---|
| object-schema | `choros.registry_def.record_schema` (jsonb NOT NULL, migration 004). СУЩЕСТВУЕТ. |
| MCP-grants | `choros."grant"` (migration 008, resource_type + scope + role_id). СУЩЕСТВУЕТ. |
| BPMN-process | **В Flowable-движке** (deployBpmn / flowable-client.ts). Чороса-таблицы нет. |
| форма-код (Floor-2) | Нет таблицы. Flowable через extensionElements. |
| form-JSON-Schema (Floor-1) | Нет таблицы. |

Нет таблиц `form_def`, `process_def`, `form_schema`. BPMN и формы целиком в Flowable;
Choros хранит только `registry_def.record_schema` (object-schema) и `grant`.

**Следствие для T-0082:** задача не может выполнить полную пятичленную когерентность
«за один ход». Полный git-механизм + form-def-таблицы — target-state инкрементально.

**T-0082 day-1 = три конкретных вещи:**

1. **Понятие «bundle»** — формальное определение и машинно-читаемый реестр
   (`ci/checks/bundle_members.txt`) членов связки: их table/column/source.
2. **Binding-coherence CI-гард** — статическая fitness-функция, проверяющая:
   (a) поле `record_schema` каждого `registry_def` является валидным JSON Schema
   (parse-проходит); (b) каждый `grant` с `resource_type='registry'` или
   `resource_type='record'` ссылается на `application_id`/`registry_id`, которые
   существуют (referential sanity); (c) `bpmn-linter` (T-0027) не пропускает
   raw-object bindings (уже есть, фитнес-проверка на интеграцию).
3. **bundle_members.txt реестр** + документация сейма — explicit deferral contract
   для form-def / BPMN-таблиц в Choros, аналог T-0027-bpmn-linter-deploy-contract.md.

**Out-of-scope day-1 (target-state, материализуется через отдельные задачи):**
- Таблицы `form_def`, `form_schema`, `process_bundle` — нет, нужен отдельный ADR/build-task.
- git-под-капотом (content-addressed bundle commit) — инкрементально после form-def.
- Семантический changelog + one-click promote (поверх git) — T-0084.
- Per-record expand/contract object-schema versioning — separate task per §9.5.
- Camunda-grade live-migration mapping — on-demand, вне T-0082.

---

## 1. Что строим (одно предложение)

Формальное определение и машинно-читаемый реестр связки (bundle_members.txt),
статическая fitness CI-функция `bundle-coherence.sh`, проверяющая cohesion
существующих членов связки (object-schema валидность + grant-registry referential
sanity + bpmn-linter интеграция), и explicit deferral contract для недостающих членов.

---

## 2. Почему это нужно сейчас

ADR §9.4: «Блокирующий CI-тест на когерентность связки — ДО того, как git-под-капотом
считается готовым. Баг в самой системе версионирования = та security-регрессия, которую
механизм призван предотвратить.» Это guard #4 из 10 обязательных day-1 гардов.

Без формального реестра «что такое bundle» и без CI-чека каждый новый artifact-тип
(form-def, DMN) добавляется без явного включения в coherence-периметр. Рассинхрон
object-schema ↔ grants — не гипотетический: security-десинк при drain-инстансе описан
в ADR §7 дословно.

Связь с T-0087 (работает параллельно): T-0087 добавляет `tier` к существующим таблицам
(application, registry_def, grant, record). T-0082 не трогает эти таблицы; bundle
coherence-проверка работает поверх tier-aware данных без изменения tier-модели.

---

## 3. Функциональные требования

### FR-1 — bundle_members.txt реестр

Файл `ci/checks/bundle_members.txt` перечисляет каждый член bundle с полями:
`name|kind|source|table_or_path|key_column`. Виды (`kind`): `choros_table` (существует
в DB) или `external` (в Flowable или ещё нет таблицы — explicit deferral).

Минимальный состав:

| name | kind | source | table_or_path | key_column |
|---|---|---|---|---|
| object-schema | choros_table | migrations/004_registry_def.sql | registry_def | record_schema |
| grants | choros_table | migrations/008_grant.sql | grant | resource_type |
| bpmn-process | external | flowable-engine | deployments API | deploymentId |
| form-code | external | deferred | — | — |
| form-json-schema | external | deferred | — | — |

### FR-2 — object-schema валидность

Каждый `record_schema` в `choros.registry_def` является валидным JSON Schema
(draft-07 или draft-2020-12): parse не бросает, корневой тип `object` или с `$schema`.
Нарушение = CI fail. Проверка: статическая fitness-функция или live-DB тест.

### FR-3 — grant-registry referential sanity

Каждый `grant` с `resource_type IN ('registry', 'record', 'application')` содержит
в `resource_facet` либо `application_id`, либо `registry_id` (JSON-поле), которые
парсируются. Пустой/null facet при `resource_type='record'` = CI fail.
Цель: не допустить грантов «на registry, которого нет» без явной wildcard-семантики.

### FR-4 — bpmn-linter интеграция (существующий T-0027)

Fitness-функция `bundle-coherence.sh` вызывает `ci/checks/bpmn-linter-isolation.sh`
или проверяет, что `bpmn-linter.ts` импортируется из `flowable-client.ts` /
deploy-пути (уже задокументировано в T-0027 AC-15). Тем самым bundle-coherence гард
инкапсулирует BPMN-член связки.

### FR-5 — bundle-coherence.sh единая точка входа

Один исполняемый файл `ci/checks/bundle-coherence.sh`, который:
(a) Проверяет существование `bundle_members.txt` и валидность его структуры.
(b) Для каждого `kind=choros_table`-члена: таблица и ключевой столбец существуют
    в schema (через `known_tenant_tables.txt`-проверку или grep по migrations).
(c) Вызывает object-schema-validity-check (статический: grepping migration DDL on
    `record_schema jsonb NOT NULL` constraint, или live через DB test).
(d) Вызывает grant-registry referential sanity check.
(e) Вызывает `bpmn-linter-isolation.sh`.
(f) Для каждого `kind=external`-члена: логирует «deferred, deferral contract at …».
Выход 0 — все чеки зелёные. Выход 1 — любой чек красный.

### FR-6 — CI-интеграция (gated)

`bundle-coherence.sh` добавляется в `package.json` скрипт `fitness` и в
`.github/workflows/ci.yml` (blocking step). Любой PR, ломающий bundle-coherence,
не мержится.

### FR-7 — explicit deferral contract

Файл `docs/design/T-0082-bundle-deferral-contract.md` фиксирует:
- Какие члены bundle ещё отсутствуют в DB (form-def, BPMN-def).
- Условие «когда добавить в bundle_members.txt»: при появлении первой таблицы/ADR.
- Кто отвечает: задача, добавляющая form-def/bpmn-def, ОБЯЗАНА обновить
  `bundle_members.txt` и пройти bundle-coherence.sh. Это требование в шаблоне DoD.

---

## 4. Нефункциональные требования

- **NF-1 — Zero new production dependencies.** `bundle-coherence.sh` — bash + grep +
  sqlite3/psql (уже есть в CI). Никаких новых npm-зависимостей.
- **NF-2 — Additive, no existing files broken.** Новые файлы: `ci/checks/bundle_members.txt`,
  `ci/checks/bundle-coherence.sh`, `docs/design/T-0082-bundle-deferral-contract.md`.
  НЕ трогать: `known_tenant_tables.txt` (T-0087 гард FF-11b), существующие migrations,
  `grant-lattice.ts`, `types.ts`, `flowable-client.ts` (architect rule 7).
- **NF-3 — T-0087 non-conflict.** T-0082 не добавляет `tier` ни к одной таблице.
  bundle-coherence.sh не проверяет тир — это зона T-0087. bundle_members.txt
  не перечисляет тиры. Файлы не пересекаются.
- **NF-4 — Fail-closed.** Любой parse-error в bundle_members.txt или отсутствие
  обязательного файла = CI fail (не пропуск).
- **NF-5 — Vitest (если live-DB test).** Если FR-2/FR-3 проверяются через DB тест,
  он в `ci/checks/db/bundle-coherence.test.ts` по образцу `cross_tenant.test.ts`.
- **NF-6 — bundle_members.txt человеко-читаем.** TSV-формат, #-комментарии.
  Документирует сейм для DESIGN-фазы последующих задач.

---

## 5. Out of scope

- **Полный git-под-капотом** (content-addressed bundle commit, diff, branch-per-bundle) —
  target-state, требует form-def/bpmn-def таблиц.
- **Таблицы form_def, form_schema, process_bundle** — нет в репо, нужен отдельный ADR +
  build-task (target-state, материализуется после T-0082).
- **Семантический changelog** — T-0084.
- **Per-record expand/contract** — отдельная задача (ADR §9.5).
- **Camunda-grade live-migration** — on-demand эскалация, отдельная задача.
- **Floor-1 ↔ Floor-2 boundary enforcement** — T-0083 / §9.2.
- **Config-агент DRAFT-only авторинг** — T-0077 (E11.6).
- **Promote-endpoint** — T-0087 (уже в работе).
- **UI promote-экрана** — дизайн-задача.

---

## 6. Target-state расхождения (обязательно учесть в DESIGN)

| Член связки | Статус | Таблица / путь в repo | Требуется в DESIGN |
|---|---|---|---|
| object-schema | СУЩЕСТВУЕТ | `registry_def.record_schema` (004_registry_def.sql) | FR-2 реализуем today |
| grants | СУЩЕСТВУЕТ | `choros."grant"` (008_grant.sql) | FR-3 реализуем today |
| BPMN-process | ОТСУТСТВУЕТ в Choros DB | Flowable API / flowable-client.ts | explicit deferral; bpmn-linter-isolation.sh уже есть |
| form-code (Floor-2) | ОТСУТСТВУЕТ | — | explicit deferral contract |
| form-JSON-Schema (Floor-1) | ОТСУТСТВУЕТ | — | explicit deferral contract |

Architect ОБЯЗАН проектировать bundle-coherence.sh без создания новых таблиц для form/bpmn.

---

## 7. Критерии приёмки

| ID | Текст | verifiable_as |
|---|---|---|
| AC-1 | `ci/checks/bundle_members.txt` существует, содержит ≥5 строк (5 членов), каждая строка `kind=choros_table` содержит непустые `table_or_path` и `key_column`; каждая `kind=external` строка содержит запись о deferral | fitness |
| AC-2 | `ci/checks/bundle-coherence.sh` существует, исполняем (`chmod +x`), и при запуске в чистом worktree (без DB) завершается с кодом 0 для статических проверок (FR-1, FR-5a/b) | fitness |
| AC-3 | `bundle-coherence.sh` проверяет, что `registry_def` упомянута в `known_tenant_tables.txt` и migration 004 содержит `record_schema jsonb NOT NULL`; отсутствие любого из них → exit 1 | fitness |
| AC-4 | `bundle-coherence.sh` проверяет, что migration 008 содержит `CREATE TABLE choros."grant"` с `resource_type text NOT NULL`; отсутствие → exit 1 | fitness |
| AC-5 | `bundle-coherence.sh` вызывает или ссылается на `bpmn-linter-isolation.sh` (делегирует BPMN-член); если `bpmn-linter-isolation.sh` завершается ненулём, `bundle-coherence.sh` тоже завершается ненулём | fitness |
| AC-6 | `bundle-coherence.sh` для каждого `kind=external` члена логирует строку `[bundle-deferred] <name>: …deferral-contract…` и НЕ завершается ненулём (external члены не являются ошибкой) | fitness |
| AC-7 | `docs/design/T-0082-bundle-deferral-contract.md` существует, содержит секцию «Deferred members» с перечислением form-code, form-json-schema, BPMN-def и условием «when to promote to choros_table» | fitness |
| AC-8 | `package.json` скрипт `fitness` (или `fitness:bundle`) вызывает `bundle-coherence.sh`; `.github/workflows/ci.yml` содержит шаг, запускающий этот скрипт как blocking gate | fitness |
| AC-9 | Если передать в `bundle-coherence.sh` заведомо сломанный `bundle_members.txt` (удалённая строка object-schema), скрипт завершается exit 1 | test |
| AC-10 | Ни один файл из списка `known_tenant_tables.txt`, `bpmn-linter-isolation.sh`, `tier_bearing_tables.txt`, `tier-isolation.sh` не изменён (T-0087 non-conflict, NF-3) | fitness |
| AC-11 | `ci/checks/bundle-coherence.sh` не содержит `tier`, `draft`, `published` (не смешивает тир-модель T-0087 и bundle-coherence T-0082) | fitness |
| AC-12 | При наличии live-DB: для каждого `registry_def` в `choros` схеме `record_schema` является parse-валидным JSON (не строкой вне JSON); failing parse → тест red (FR-2) | test |
| AC-13 | При наличии live-DB: каждый `grant` с `resource_type='record'` содержит `resource_facet IS NOT NULL`; null facet → тест red (FR-3) | test |
| AC-14 | `git diff --name-only` после применения T-0082 не затрагивает `src/core/grant-lattice.ts`, `src/core/types.ts`, `src/core/flowable-client.ts`, `src/core/bpmn-linter.ts` (NF-2, architect rule 7) | fitness |

---

## 8. Adversarial: граница с T-0087

| Инвариант | Проверяемый AC |
|---|---|
| T-0082 не добавляет tier к таблицам | AC-10 (known_tenant_tables.txt неизменён) |
| T-0082 не вызывает assertWritable / decidePromote | AC-14 (не трогает artifacts.ts) |
| bundle-coherence.sh не знает о tier-семантике | AC-11 |
| Promote в T-0087 не нарушает bundle-coherence | bundle-coherence.sh должен пройти ПОСЛЕ merge T-0087 (архитектор учитывает при wiring) |

---

## 9. Трассируемость

| Источник | Покрыт |
|---|---|
| extensibility-ADR §7 «единица версионирования и связка» | FR-1, FR-7, AC-1, AC-7 |
| extensibility-ADR §9.4 «блокирующий CI-тест на когерентность» | FR-5, FR-6, AC-2, AC-8 |
| extensibility-ADR §9.3 «единый источник истины field-key==variable-name + compat-проверка» | FR-3 (grant-registry sanity — partial coverage day-1) |
| extensibility-ADR §11 «секвенирование: сначала Floor-1 + drain + логические среды + bundle-coherence CI-гард» | §0 + Out of scope §5 |
| T-0027 (bpmn-linter deploy contract) | FR-4, AC-5 |
| T-0087 (тиры) | NF-3, AC-10, AC-11 |
| Demiurge conventions (zero-dep, capability-not-text) | NF-1, NF-2 |
| FE-2026-W24-0087-A (target-state lesson) | §0, §6 |
