# Spec · T-0179 — bundle-coherence расширение: check-report-page-deps + bundle_members.txt

**Task:** T-0179 · type=impl · product=choros · T-0121e
**Status:** ready
**Date:** 2026-06-12
**ADR-источник:** `docs/design/T-0121-reports-pages.adr.md` §5.4 / §8 FF-BUNDLE-DEPS / §9 T-0121e
**Deps:** T-0175 (report_page + report_page_dep DDL) · T-0082 (bundle-coherence механика)
**Compat:** T-0176 (report-page-compat.ts)

---

## Легальность пути

**Вывод: АДДИТИВНЫЙ путь, frozen-блок отсутствует.**

Анализ:

1. `ci/checks/bundle_members.txt` — data-файл (не `.sh`), `frozen-checks-immutable.sh`
   защищает только `ci/checks/*.sh`. Добавление одной строки = аддитивная операция.
   Не затрагивает `bundle-coherence.sh`.

2. `ci/checks/bundle-coherence.sh` — FROZEN (владелец T-0082, строка 2:
   `# T-0082 · E12.1 · Bundle Coherence CI Guard`). T-0179 **не правит** этот файл.
   ADR §5.4 говорит «добавить `check-report-page-deps`» — это означает НОВЫЙ companion-скрипт,
   а не правку frozen check. Логика подтверждается: bundle-coherence.sh проверяет
   структурную когерентность (таблица существует, DDL-инвариант); live DB-проверка
   field_key ∈ registry_def.record_schema.properties находится за его пределами.

3. Новый `ci/checks/check-report-page-deps.sh` (владелец T-0179, строка 2:
   `# T-0179 · …`) — НОВЫЙ файл, создание разрешено (FF-FCI4: diff-filter=A не нарушение).

4. Новый `ci/checks/db/report_page_bundle_deps.test.ts` — НОВЫЙ файл (live-DB probe).

5. `package.json` — добавление одного `bash ci/checks/check-report-page-deps.sh`
   в `"fitness"` script. Это правка package.json, не ci/checks/*.sh.

**Нет frozen-блока. Нет frozen-класса.**

---

## Что делает T-0179

Двойная защита от десинка `report_page_dep.field_key` ↔ `registry_def.record_schema`:

### (а) bundle_members.txt — регистрация report_page_dep

Добавить строку в `ci/checks/bundle_members.txt`:

```
report_page_dep|choros_table|migrations/052_report_page_dep.sql|report_page_dep|dep_kind
```

Это сигнализирует `bundle-coherence.sh`, что таблица входит в bundle и
проверяется на DDL-инвариант (название таблицы в `known_tenant_tables.txt` + поле `dep_kind`).

### (б) ci/checks/check-report-page-deps.sh — статический guard

Новый static-check (exit 0 / exit 1), владелец T-0179:

**Проверки (статические, без live DB):**

- **RD-1:** `report_page_dep` присутствует в `bundle_members.txt` как `kind=choros_table`.
- **RD-2:** Миграция `052_report_page_dep.sql` существует в `migrations/`.
- **RD-3:** DDL-инвариант `dep_kind IN ('read','aggregate')` (CHECK `report_page_dep_kind_chk`)
  присутствует в тексте миграции.
- **RD-4:** DDL-инвариант UNIQUE `(tenant_id, page_id, registry_def_id, field_key)` присутствует
  в миграции (защита от дублей deps).
- **RD-5:** `stale` колонка с DEFAULT объявлена в миграции (guard stale-path).
- **RD-6:** `report_page_dep` присутствует в `known_tenant_tables.txt` (T-0013-контракт).
- **RD-7:** Self-test `--self-test` флаг: при отсутствии `bundle_members.txt` → exit 1 (fail-closed).

### (в) ci/checks/db/report_page_bundle_deps.test.ts — live-DB probe (FF-BUNDLE-DEPS)

Vitest-тест (паттерн bundle-coherence.test.ts / report_page.test.ts), skipIf(!DATABASE_URL).
Выполняется в `npm run fitness:db`.

**Проверки (live DB, FF-BUNDLE-DEPS):**

- **DB-1:** Каждая строка `report_page_dep` (по all tenants, migrator-роль) имеет
  `field_key ∈ соответствующей registry_def.record_schema.properties`;
  несуществующий field_key (de-facto stale dep) → fail с деталями.
- **DB-2:** Каждая строка `report_page_dep` с `stale=true` залогирована как предупреждение
  (не блок; stale — легитимное состояние после force-escape-hatch).
- **DB-3:** Нет orphan `report_page_dep` строк (page_id не ссылается на несуществующую
  report_page) — FK ON DELETE CASCADE обязан это закрыть, но live-проба подтверждает.

### (г) package.json fitness

`check-report-page-deps.sh` добавляется в `"fitness"` script (после `bundle-coherence.sh`).
`report_page_bundle_deps.test.ts` автоматически подхватывается `npm run fitness:db` (vitest
сканирует `ci/checks/db/`).

---

## Acceptance Criteria

| AC | Текст | Проверяемость |
|---|---|---|
| AC-1 | `bundle_members.txt` содержит строку `report_page_dep\|choros_table\|migrations/052_report_page_dep.sql\|report_page_dep\|dep_kind` | fitness |
| AC-2 | `bundle-coherence.sh` проходит на текущей кодовой базе (файл НЕ изменён, ≥5 members) | fitness |
| AC-3 | `check-report-page-deps.sh` существует, строка 2 начинается с `# T-0179 ·` | fitness |
| AC-4 | `check-report-page-deps.sh` проходит (exit 0) на текущей кодовой базе | fitness |
| AC-5 | RD-1: `bundle_members.txt` содержит `report_page_dep` как choros_table (grep в check-script) | fitness |
| AC-6 | RD-2: `migrations/052_report_page_dep.sql` существует | fitness |
| AC-7 | RD-3: DDL-инвариант `dep_kind` CHECK присутствует в миграции | fitness |
| AC-8 | RD-4: UNIQUE constraint на `(tenant_id, page_id, registry_def_id, field_key)` в миграции | fitness |
| AC-9 | RD-5: `stale` колонка с DEFAULT в миграции | fitness |
| AC-10 | RD-6: `report_page_dep` в `known_tenant_tables.txt` | fitness |
| AC-11 | RD-7: self-test `--self-test` с отсутствующим `bundle_members.txt` → exit 1 | fitness |
| AC-12 | DB-1 (live): все `report_page_dep.field_key` присутствуют в соответствующих `registry_def.record_schema.properties` | test (fitness:db) |
| AC-13 | DB-2 (live): строки с `stale=true` логируются, не блокируют тест | test (fitness:db) |
| AC-14 | DB-3 (live): нет orphan `report_page_dep` (page_id указывает на существующую report_page) | test (fitness:db) |
| AC-15 | `npm run fitness` exit 0 (check-report-page-deps.sh в fitness цепочке) | fitness |
| AC-16 | `tsc --noEmit` exit 0 (нет новых TS-файлов в core/http, только test) | fitness |
| AC-17 | `frozen-checks-immutable.sh` exit 0 (bundle-coherence.sh не тронут) | fitness |

---

## Out-of-scope

- Правка `ci/checks/bundle-coherence.sh` (frozen T-0082 — не трогаем).
- Добавление `report_page` (без суффикса `_dep`) в `bundle_members.txt` — T-0121a (T-0175) это
  не требовал, и ADR §5.4 упоминает только `report_page_dep`.
- Live-проверка «field_key присутствует» через bash (требует DB-доступа) — делегировано
  в vitest fitness:db (паттерн bundle-coherence.test.ts).
- Любые правки src/core/, src/http/ — вне задачи.
- MCP-seed, Floor-рендерер — отдельные задачи T-0121f/T-0121g.
