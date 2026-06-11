# Spec · T-0178 — Reports T-0121d: report_page CRUD + author/promote API + регистрация report_page_dep (PDP-gated)

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0178 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0121-reports-pages.adr.md`
  §5 (promote-gate при stale dep),
  §6 (права — `mgmt_object:report_page`/`author`/`promote`, PDP T-0021),
  §7 (аудит — `appendAuditEvent`, audit-vocab, tenant-изоляция),
  §8 (FF-DEP-VALIDATE, FF-PROMOTE-GATE, FF-NO-2ND-AUTHZ, FF-AUDIT-EVENTS),
  §9 T-0121d (декомпозиция)
**Foundations:**
  T-0175 (DDL таблицы 051/052 — `report_page`, `report_page_dep`),
  T-0176 (`checkReportPageDepFields`, `PageDep`, `classifyReportPageFloor`),
  T-0177 (schema-change API — `stale`-флаг на deps, депромоут — пишет T-0178 consume),
  T-0021 (PDP — `resolveFor`/`loadAdminContext` паттерн),
  T-0018 (grant-lattice),
  T-0016 (appendAuditEvent — единственный canonical audit sink),
  T-0087 (tier-promote/demote — SET LOCAL choros.promoting, decidePromote),
  T-0077 (config-agент / authoring_draft паттерн),
  T-0013/T-0115 (RLS-контракт, withTenantTx дисциплина),
  T-0144 (BEGIN до SET LOCAL, cleanup after self)

---

## 1. Summary

Эндпоинты CRUD `report_page` + регистрация `report_page_dep` + promote `draft→published`.

**Ось A (авторинг DRAFT):** `POST /api/report-pages` создаёт страницу в `tier='draft'` с
атомарной регистрацией `report_page_dep`. Для Floor-1 deps выводятся автоматически из
`page_def`; для Floor-2 — из тела запроса `deps[]`. Каждый `field_key` проверяется
`checkReportPageDepFields` против живой `record_schema` реестра — 422 при нарушении.

**Ось B (promote human-gate):** `POST /api/report-pages/:id/promote` переводит страницу
из `draft` в `published`. Gate: actor = human (не агент). PDP gate:
`mgmt_object:report_page` / `promote`. Блок: любой `dep.stale=true` → 409
`stale_dependencies`. Механика: SET LOCAL `choros.promoting='1'` + UPDATE tier (T-0087).

**Ось C (CRUD — read/update/delete):** `GET/PATCH/DELETE /api/report-pages/:id`.
Update в `draft` только (published-locked). Delete: всегда можно; ON DELETE CASCADE
чистит deps (аудит-след переживает — append-only).

**Авторизация:** единый PDP T-0021.
- Просмотр: `read` на `application` (страница наследует видимость app).
- Авторинг (create/update): `mgmt_object:report_page` / `author`.
- Promote: `mgmt_object:report_page` / `promote` (human-only).
- Нет `report_page_acl`, нет второго permission-механизма (FF-R6 / FF-NO-2ND-AUTHZ).

**Аудит:** единый `appendAuditEvent` (T-0016) на каждую мутацию.

---

## 2. Functional requirements

- **FR-1** `POST /api/report-pages` — создаёт `report_page` в `tier='draft'`.
  Тело: `{ app_id, slug, title, floor, page_def? | page_code?, deps?: PageDepInput[] }`.
  Ответ: `201 { id, app_id, slug, title, floor, tier, created_at }`.

- **FR-2** Атомарная регистрация deps в той же транзакции что и INSERT report_page:
  - Floor-1 (`page_def` не null): deps выводятся синтаксически из `page_def`
    (`source_registry_def_id` + `field_key` → строки `report_page_dep`; agg-метрики →
    `dep_kind='aggregate'`, list → `dep_kind='read'`). Ручной `deps[]` игнорируется для
    Floor-1 (единый источник истины — `page_def`).
  - Floor-2 (`page_code` не null): deps берутся из `deps[]` в теле запроса.
  - Атомарность: INSERT `report_page` + INSERT `report_page_dep × N` — одна транзакция.

- **FR-3** Валидация deps при регистрации: для каждого dep из `deps` (Floor-2) или
  derived (Floor-1) вызывается `checkReportPageDepFields` против живой
  `registry_def.record_schema` (SELECT по `registry_def_id`). Несуществующий `field_key`
  → `422 INVALID_DEP_FIELD` (запись не создаётся). Несуществующий `registry_def_id` →
  `422 REGISTRY_DEF_NOT_FOUND`.

- **FR-4** PDP gate для авторинга (create/update):
  `mgmt_object:report_page` / `author` (genesis-owner short-circuit). Нет гранта →
  `403 NO_AUTHOR_GRANT`.

- **FR-5** `GET /api/report-pages/:id` — читает одну страницу (tenanted).
  Ответ: `200 { id, app_id, slug, title, floor, tier, page_def, page_code, bundle_ref, created_at, updated_at }`.
  Не найдено / другой тенант → `404 NOT_FOUND`.

- **FR-6** `GET /api/report-pages?app_id=<uuid>` — список страниц приложения (tenanted).
  Ответ: `200 { pages: [...] }`.

- **FR-7** `PATCH /api/report-pages/:id` — обновление полей `title`, `page_def`,
  `page_code` в `draft`. Если `tier='published'` → `409 PUBLISHED_LOCKED`.
  При изменении `page_def` (Floor-1) — deps пересчитываются: DELETE старых +
  INSERT новых выведенных deps, атомарно (одна транзакция).

- **FR-8** `DELETE /api/report-pages/:id` — удаление страницы. ON DELETE CASCADE
  чистит `report_page_dep`. Аудит-событие `report_page.deleted` записывается до DELETE
  (append-only, NF-7 ADR — аудит-след переживает удаление страницы).

- **FR-9** `POST /api/report-pages/:id/promote` — promote `draft→published`.
  - actor-type gate: если actor — agent → `403 FORBIDDEN_AGENT_SELF_PROMOTE` (human-only).
  - PDP gate: `mgmt_object:report_page` / `promote` (genesis-owner short-circuit).
  - Stale-dep gate: SELECT `report_page_dep WHERE page_id=$id AND stale=true LIMIT 1` →
    если есть → `409 STALE_DEPENDENCIES` (страница остаётся в draft).
  - Страница не в draft → `409 NOT_IN_DRAFT`.
  - Страница не найдена → `404 NOT_FOUND`.
  - Success: SET LOCAL `choros.promoting='1'` + UPDATE `tier='published'` +
    `appendAuditEvent({ action: 'report_page.promoted', ... })` — атомарно.

- **FR-10** Аудит-события (T-0016, единственный canonical `appendAuditEvent`):
  - `report_page.authored` — create/update (action='authored' или 'updated' — оба
    покрываются vocab; see §6 ADR для frozen seam).
  - `report_page.promoted` — promote success.
  - `report_page.deleted` — delete.
  - `report_page_dep.registered` — dep insert при create.
  - `report_page_dep.updated` — dep upsert при patch (Floor-1 re-derive).
  - `report_page_dep.deleted` — dep delete при patch или page delete.
  Ноль второго audit-sink / дубль-таблицы. Каждый event = `appendAuditEvent` (T-0016).

- **FR-11** Tenant-изоляция: все операции через `withTenantTx` + SET LOCAL
  `choros.tenant_id` (T-0013, T-0144: BEGIN до SET LOCAL, cleanup after self).

- **FR-12** Новый HTTP-модуль `src/http/report-pages.ts` + функция
  `registerReportPageRoutes(router, _poolHint?, deps?)`. Регистрируется в `src/server.ts`.

---

## 3. Non-functional requirements

- **NF-1** Нет `report_page_acl` / `page_visibility`-поля / второго permission-механизма.
  Авторинг/promote/просмотр — исключительно через PDP T-0021 (`mgmt_object:report_page`
  / `author` | `promote`) и grant `read` на `application`. FF-NO-2ND-AUTHZ.

- **NF-2** Tenant-изоляция структурная (T-0013 FORCE RLS). Нет cross-tenant выборки.
  API fail-closed: нет тенант-параметра в URL — тенант всегда из сессионного контекста.

- **NF-3** Aтомарность: INSERT/UPDATE страницы + deps + audit_event — одна транзакция
  (withTenantTx). Partial failure → ROLLBACK, ничего не создаётся/не изменяется.

- **NF-4** Promote: actor_type из AUTHENTICATED claim (или employee.type в dev-режиме) —
  НИКОГДА из тела запроса (паттерн T-0044 §9 / artifacts.ts).

- **NF-5** `classifyReportPageFloor` вызывается при create/update для машинной проверки
  floor-совместимости (`page_def` ↔ `floor`): нельзя создать Floor-2 страницу с
  `page_def`, выражаемым Floor-1 vocab (FF-FLOOR). Ошибка → `400 FLOOR_MISMATCH`.

- **NF-6** Нет нового npm-зависимости для ядра (ADR NF-6 — zero new prod deps).

- **NF-7** Аудит-след переживает удаление страницы: `appendAuditEvent` вызывается до
  DELETE (append-only тaблица, не CASCADE-удаляется).

- **NF-8** Promote-блок на stale dep: 409 (не тихий skip / не warn), страница остаётся в
  draft. Человек должен починить или удалить stale-deps явно.

---

## 4. Out of scope

- `bundle-coherence check-report-page-deps` + `bundle_members.txt` расширение — T-0121e
- MCP-tool seed `author_report_page` — T-0121f
- Floor-1 server-side агрегат-рендерер / Floor-2 RLS-gated data API — T-0121g
- Статический анализ Floor-2 React → автоизвлечение field-deps — T-0121h (Stage-2)
- schema-change guard (soft-warning / destructive-deny / force) — T-0177 (done)
- UI-редактор страниц Floor-1 — зона 7

---

## 5. Acceptance criteria

| AC | Text | Verifiable |
|---|---|---|
| **AC-1** | `POST /api/report-pages` создаёт страницу `tier='draft'`; ответ 201 с `id`, `slug`, `tier`; tsc exit 0. | test |
| **AC-2** | Floor-1 create: deps выводятся из `page_def` автоматически; `report_page_dep` строки созданы с правильными `field_key` + `dep_kind`. | test |
| **AC-3** | Floor-2 create: deps берутся из `deps[]` в теле; строки `report_page_dep` созданы корректно. | test |
| **AC-4** | Create с `field_key ∉ record_schema` → 422 `INVALID_DEP_FIELD`; запись в `report_page` не создана (атомарность). | test |
| **AC-5** | Create без авторского гранта (`mgmt_object:report_page`/`author`) → 403 `NO_AUTHOR_GRANT`. | test |
| **AC-6** | `GET /api/report-pages/:id` → 200 с полным объектом страницы. | test |
| **AC-7** | `GET /api/report-pages?app_id=<uuid>` → 200 `{ pages: [...] }` только для данного `app_id` тенанта. | test |
| **AC-8** | `PATCH /api/report-pages/:id` обновляет `title` в draft; ответ 200; `updated_at` меняется. | test |
| **AC-9** | `PATCH` published-страницы → 409 `PUBLISHED_LOCKED`. | test |
| **AC-10** | `PATCH` Floor-1 страницы с новым `page_def` → старые deps удалены, новые пересчитаны атомарно. | test |
| **AC-11** | `DELETE /api/report-pages/:id` → 204; запись удалена из `report_page`; deps каскадно удалены; audit_event `report_page.deleted` записан. | test |
| **AC-12** | `POST /api/report-pages/:id/promote` для agent-actor → 403 `FORBIDDEN_AGENT_SELF_PROMOTE`. | test |
| **AC-13** | `POST /api/report-pages/:id/promote` без `mgmt_object:report_page`/`promote` гранта → 403 `NO_PROMOTE_GRANT`. | test |
| **AC-14** | `POST /api/report-pages/:id/promote` с `dep.stale=true` → 409 `STALE_DEPENDENCIES`; `tier` остаётся `'draft'`. | test |
| **AC-15** | `POST /api/report-pages/:id/promote` для non-draft → 409 `NOT_IN_DRAFT`. | test |
| **AC-16** | Promote success: `tier='published'` в БД, audit_event `report_page.promoted` записан, атомарно (live-DB). | test |
| **AC-17** | Create Floor-2 с `page_def` выразимым Floor-1 vocab → 400 `FLOOR_MISMATCH` (FF-FLOOR guard). | test |
| **AC-18** | Audit-события: create → `report_page.authored`, promote → `report_page.promoted`, delete → `report_page.deleted`; каждое = `appendAuditEvent` (T-0016); нет второго audit-sink. | test |
| **AC-19** | Нет `report_page_acl` / `page_visibility` / второго permission-поля в новых файлах; grep forbidden tokens = 0. | fitness |
| **AC-20** | `registerReportPageRoutes` принимает injectable `deps?` параметр (ReportPageAuthzDeps); unit-тест без живой БД проходит. | test |
| **AC-21** | tsc --noEmit exit 0 после всех новых файлов. | fitness |
| **AC-22** | npm run fitness exit 0 (новый `report-page-crud-isolation.sh` добавлен и проходит). | fitness |
| **AC-23** | Live-DB: create + promote flow (with genesis-owner) end-to-end за один тест. | test |
| **AC-24** | Live-DB: promote blocked on stale dep; stale dep исправлен (stale=false); promote success. | test |

---

## 6. Fitness functions (machine-verifiable, owner T-0178)

| ID | Rule | Check |
|---|---|---|
| **FF-DEP-VALIDATE** | POST dep с `field_key ∉ record_schema` → 422; нет записи в `report_page_dep`. | live-impl probe (AC-4). |
| **FF-PROMOTE-GATE** | Promote с `dep.stale=true` → 409; `tier` остаётся draft. | live-impl probe (AC-14/AC-24). |
| **FF-NO-2ND-AUTHZ** | Grep: нет `report_page_acl` / `page_visibility` / `report_page_permission` в новых файлах; PDP вызов (`loadAdminContext`/`checkAdminGrant`) присутствует. | static + fitness script. |
| **FF-AUDIT-EVENTS** | Каждая мутация (create/update/delete/promote) эмитит ожидаемый audit event; нет `appendAuditEvent` в обход `makePgAuditWriter` (единственный sink). | unit + live-impl probes. |
| **FF-FLOOR-GUARD** | Create Floor-2 c page_def, выразимым Floor-1 vocab → 400. | unit + live-impl probes (AC-17). |

---

## 7. Integrity constraints (live-DB checks)

- `report_page_dep.field_key` всегда проверяется против `registry_def.record_schema.properties` при create/update.
- Promote гейт `stale=true` проверяется атомарно до UPDATE tier (SELECT FOR UPDATE строки страницы).
- DELETE страницы — аудит-событие пишется ДО DELETE, не после (append-only table, NF-7).
