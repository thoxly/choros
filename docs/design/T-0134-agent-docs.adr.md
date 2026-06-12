# ADR · T-0134 — Агентный слой документации: LLM-wiki без `raw` + UI-страница доков + read-only MCP-сервер документации

**Task:** T-0134 · type=design · product=choros · prio 40 · phase = DESIGN (architect)
**Status:** ready (no founder escalation — направление задано фаундером §3а «Документация»; все продуктовые развилки закрыты; внутри-DESIGN развилки решены автономно ниже с rejected-alternatives)
**Date:** 2026-06-12
**Spec источник:** `docs/specs/T-0134-agent-docs.spec.md` (status: ready, 20 AC) + `docs/specs/T-0134.spec.contract.json`
**Решение фаундера (данность, НЕ развилка):** доки **пишут и поддерживают агенты** (не люди вручную); адаптированный LLM-wiki Карпатого = `index`/страницы/`log` + **lint-проход**, но **БЕЗ папки `raw`** — источник истины = **живая система** (код/конфиги/схемы/процессы); lint сверяет доки с **актуальным** состоянием, не с замороженным сырьём; **три потребителя** одного слоя (UI / внутренний агент / внешние harness через MCP); детальный пайплайн генерации → **исследование №3** (Stage-2, явно НЕ блокирует рамку).

**Foundation / прецеденты (do NOT contradict) — легенда клеймов:**
- `docs/design/T-0043-mcp-tool-registry.adr.md` — `choros.mcp_tool(declares jsonb, resource_ops jsonb, pure_compute bool)` (миграция 040); toolset = **запрос над грантами** (`resolveAgentToolset` / `isToolReachable`), не хранимый список; `resource_ops` = типизированный `{resourceType, operation}[]`, матчится против `grant`-строк; **никакого свободного текста** в authority-пути; `mcp_tool` не вводит второй authority-store. **docs-MCP опирается, не переоткрывает.**
- `docs/design/T-0018-grant-authority.adr.md` / `docs/design/T-0021-grant-resolver-pdp.adr.md` — единая grant-алгебра (closed scope-lattice), `validateNarrowing` (write-time subset gate), `valid_from`/`valid_until`/`delegable`; единый PDP-чокпойнт `resolveFor(handle, subject, op)`, action-time, fail-closed; `projectFields` (скрытые поля физически отсутствуют); `ResolveSubject = {tenantId, subjectId}` identity-only. **«нет второго permission-механизма» (§2/NF-1).**
- `docs/design/T-0122-external-participant.adr.md` — паттерн **«внешняя поверхность»**: внешний/harness-принципал = **производный ограниченный грант** на **синтетическую `is_external`-роль** (write-time `validateNarrowing`, `delegable=false`); токен → tenant-вывод fail-closed; единообразный deny; каждое обращение (успех И отказ) — строка `audit_event` с актором, производным от поверхности. **docs-MCP — read-only специализация этого же паттерна, не второй механизм.**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant-таблица: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)`, DML только `choros_app`, занесение в `known_tenant_tables.txt`; **fail-closed tenant-контекст в async/external-пути** (§9 п.7).
- `docs/design/T-0016-audit-floor.adr.md` — append-only per-tenant hash-chained `audit_event`; `type/actor/subject/scope/via/payload`, **open-vocab `type`** (новые события = строки, не таблицы); секрет в payload не пишется.
- `docs/design/T-0121-reports-pages.adr.md` — **несущий прецедент структуры**: артефакт = страница (две tenant-таблицы `report_page` + `report_page_dep`); **реестр зависимостей `<артефакт> ↔ <field_key> схемы`** как расширение named-binding (T-0072), не третий механизм; lint = `checkReportPageDepFields` (pure, no-IO) + `bundle-coherence.sh`-гард; `stale boolean` как сигнал устаревания; права = grant на `application`, ноль ACL; MCP-tool `author_report_page` (seed dev-тенант). **docs-deps — родственный реестр «док-страница ↔ ссылка на живой элемент».**
- `docs/design/T-0082-bundle-coherence.adr.md` — **родство lint-механики**: реестр-как-данные + bash-fitness-гард + deferral-контракт; «баг в самой системе согласованности = security-регрессия, которую механизм призван предотвратить»; периметр day-1 + явное обязательство будущих задач. **docs-lint = тот же класс гарда «производный артефакт ↔ источник».**
- `docs/design/T-0072-named-binding.adr.md` — `checkBindingCompat` / `form_binding`: контракт «артефакт ↔ поля схемы»; **переиспользуем форму, не плодим четвёртый механизм** (NF-6).
- `docs/specs/...T-0132...` FF-1-паттерн — машинная сверка **структуры/ссылок** артефакта (наличие именованного утверждения/трассировки), вход = артефакт, выход = список нарушений (пусто = ок). **docs-lint и часть AC этого ADR — того же класса.**
- `docs/design/T-0133-process-templates.adr.md` (§2.5/§3.6, [ЖИВОЙ] git `db913d6`) — **managed-solution / vendor-update**: каталог инстанцируется в тенант с `origin`-provenance + `catalog_version`; vendor-update vX→vY = governed-операция, **day-1 = детект+уведомление (`VendorUpdateProposal`), полная merge-машинерия = Stage-2 deferral** (соразмерность). **Прецедент для проекции `scope='system'`-доков в тенант (§2.4, R-1) — синхронизация копий тем же managed-solution-классом, не новый механизм.**

> Это ADR **design-only.** Choros имеет Postgres-в-compose (T-0053/T-0114). Миграции, объектная
> модель доков, код MCP-сервера, UI-компоненты, строки lint-правил и wire-протокол MCP —
> **последующие impl-задачи** (§9), не здесь. Migration-слоты `doc_page`/`doc_ref`/`doc_log` —
> **бронь ≥ 055** (051/052/053 заняты T-0121-волной; **054 уже занят дизайном T-0128/connector, смержен
> `e2f8d79`** — coder T-0134 берёт `055+`, §11 R-5; точный слот выбирает coder при материализации,
> сохраняя порядок `doc_page` → `doc_ref`/`doc_log` ради FK). Каждая fitness-функция несёт `gating`:
> **static-now** = grep/тип-чек/unit в сегодняшнем `npm run ci`; **live-impl** = проба, авторённая
> позже, активируемая при Postgres. Этот ADR — единый источник полей/типов/контрактов для `coder`/`tester`.

---

## 1. Decision (суть в одном экране)

Документация Choros — это **агентно-поддерживаемый wiki-слой, чей источник истины = живая система**
(символы кода / REST-эндпоинты / таблицы-столбцы схемы / BPMN-DMN-процессы / конфиг-ключи). **Папки
или таблицы `raw`-сырья НЕТ** (несущее отличие от gist Карпатого): доки описывают живые артефакты, а
их актуальность проверяется **сверкой ссылок с живым состоянием**, не с замороженной копией (FR-1, NF-2).

Слой материализуется **тремя tenant-таблицами ядра** (полный T-0013-контракт), поверх существующих
grant/PDP/audit — **нового механизма прав, согласованности или аудита НЕ вводится**:

1. **`doc_page`** — единица контента wiki: `(tenant_id, id)` PK; `slug`/`title`/`body`; `scope ∈ {'system','tenant'}` (общесистемные доки продукта vs per-tenant); `stale boolean`; `app_id` nullable (привязка к разделу навигации); `authored_by`/`authored_at` (агент-автор). Структура `index` = выборка `doc_page` (каталог), `page` = строка.
2. **`doc_ref`** — **реестр типизированных ссылок**: одна строка = одна ссылка одной страницы на **один элемент живой системы**, с `ref_kind ∈ {'code_symbol','rest_endpoint','schema_field','process','config_key'}`, машинно-разрешимым `ref_target jsonb` (типизированный идентификатор, **не свободный текст**), и `broken boolean` (выставляется lint-проходом). Это **родственник `report_page_dep`** (T-0121) — реестр «док-страница ↔ референт в живой системе».
3. **`doc_log`** — журнал изменений доков (LLM-wiki `log`): `(tenant_id, id)` PK; `page_id`; `op ∈ {'authored','updated','marked_stale','ref_fixed',...}` (open-vocab text); `agent_actor`/`at`; опц. `diff_summary`. Версионирование/история **переиспользует** дисциплину `<артефакт↔источник>` (T-0072/T-0082-класс), а не вводит четвёртый параллельный механизм (FR-4, NF-6).

**Один слой — три потребителя (NF-3):** UI-страница доков (человек), внутренний агент-интерфейс
(агенты Choros читают доки как контекст) и read-only MCP-сервер (внешние harness) читают **те же** три
таблицы — **не три копии**.

**Lint устаревания = fitness-семейство (несущий механизм, FR-5..FR-8, ось B).** Чистое ядро
`src/core/doc-ref-lint.ts` экспортирует `checkDocRefs(refs, liveSnapshot): DocLintResult` —
**pure, no-IO** (паттерн `checkReportPageDepFields` T-0121 / `checkBindingCompat` T-0072 / FF-1
T-0132). Для каждой типизированной ссылки (`doc_ref`) проверяет существование референта в **снимке
живой системы**: `code_symbol` ∈ экспортах модуля, `rest_endpoint` ∈ зарегистрированных роутах,
`schema_field` ∈ `registry_def.record_schema.properties`, `process` ∈ задеплоенных BPMN/DMN-ключах,
`config_key` ∈ валидных конфиг-ключах. Битая ссылка → `{type:'missing_referent', ref_kind, ref_target}`.
Выход = список битых ссылок (**пусто = ок**) — машинно-проверяемо, CI-готово (NF-4).

**Реакция на устаревание (FR-8, развилка решена):** дефолт day-1 = **детекция + сигнал**, не hard-block:
битая ссылка → `doc_ref.broken=true` + `doc_page.stale=true` + строка `doc_log('marked_stale')` + **бейдж
на UI** (§4) + дефект в отчёте lint. **Развилка «блокировать ли публикацию/CI при битой ссылке» —
помечена SEAM-2 (design-owned, Stage-2)**; факт детекции — обязателен day-1.

**MCP-сервер документации = read-only специализация T-0122-паттерна (ось D).** Внешний harness
(Claude Code/ChatGPT/ЯндексGPT) читает `index`/страницы/поиск через docs-MCP; **никаких мутаций**
системы или доков. Authz — **ВНУТРИ grant-модели**: harness-принципал = **производный ограниченный
read-only грант** на `is_external`-роль (T-0122), резолвится тем же `resolveFor` (T-0021), fail-closed;
**второго механизма авторизации нет** (NF-1, gap-map §4б инвариант 2). Tenant-изоляция — структурная
(T-0013 FORCE RLS + fail-closed external-контекст): отдаются доки под грантом принципала **обычным RLS-путём
его tenant**, включая `scope='system'`-доки, присутствующие как **per-tenant проекция** (§2.4) — **один
read-путь, без второго RLS-предиката/context-switch** (R-1, NF-1); cross-tenant-утечка неконструируема (FR-14). Каждое
обращение — строка `audit_event` (T-0016, open-vocab `docs.*`), актор производен от harness-токена (FR-15).
Docs-сервер представлен **mcp-инструментами в реестре T-0043** (`docs_list`/`docs_read`/`docs_search`):
их `resource_ops` типизированы (`{resourceType:'doc_page', operation:'read'}`), `declares='[]'`,
`pure_compute=true` — проверяемы тем же путём; **новый authority-store не вводится** (FR-16, NF-1).

**Природа задачи (FR §4 / AC-18):** доки **пишут и поддерживают агенты**; UI-страница —
**отчётно-навигационная** (чтение + сигнал устаревания); **ручной WYSIWYG-редактор доков клиентом не
проектируется**. Детальный **пайплайн генерации/поддержки** (обход живой системы, генерация/обновление/дедуп
страниц, конфликт-резолюция, триггеры, частота) — **вне T-0134, исследование №3 (Stage-2)**, явно НЕ
blocking: T-0134 проектирует **рамку** (модель страницы, lint, UI, MCP-authz), не пайплайн (FR-17, SEAM-3).

---

## 2. Object model (DDL бронируется ≥055; 054=T-0128/connector; не выполняется в DESIGN)

> Postgres-типы авторитетны; TS-зеркало по конвенции T-0014 (camelCase; `string` для `uuid`; `number`
> для `bigint`). Все три — обычные T-0013 tenant-таблицы (FORCE RLS, default-DENY, `tenant_id`-leading,
> `choros_app` DML-only), заносятся в `known_tenant_tables.txt`.

### 2.1 `choros.doc_page` — единица контента wiki (T-0013-контракт)

| Колонка | Тип | Примечание |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK, RLS-ключ |
| `id` | `uuid NOT NULL` | |
| `slug` | `text NOT NULL` | URL-safe; `UNIQUE (tenant_id, slug)` |
| `title` | `text NOT NULL` | заголовок в `index`/навигации |
| `body` | `text NOT NULL` | контент страницы (markdown/structured) |
| `scope` | `text NOT NULL DEFAULT 'tenant'` | `CHECK (scope IN ('system','tenant'))` — origin/навигационный маркер: общесистемные доки продукта (проецируются в каждый тенант, §2.4) vs per-tenant (FR-3/FR-11/FR-14) |
| `catalog_version` | `text NULL` | версия пакета system-доков для `scope='system'`-проекций (vendor-update, §2.4, прецедент T-0133); NULL для `scope='tenant'` |
| `app_id` | `uuid NULL` | FK `(tenant_id, app_id) → application(tenant_id, id)` — привязка к разделу навигации (nullable: общая страница) |
| `stale` | `boolean NOT NULL DEFAULT false` | выставляется lint при битой ссылке; сигнал устаревания (FR-8/FR-10) |
| `authored_by` | `text NOT NULL` | агент-автор (природа задачи: доки пишут агенты) |
| `authored_at` | `bigint NOT NULL` | epoch ms |
| `updated_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; `UNIQUE (tenant_id, slug)`; FORCE RLS; policy `doc_page_tenant_isolation` на `current_setting('choros.tenant_id', true)::uuid`; `GRANT … TO choros_app`; в `known_tenant_tables.txt` |

> **Tenant-изоляция `scope='system'`-доков (несущий инвариант, FR-3/FR-11/FR-14; R-1, iter-2).**
> Развилка «как читается общесистемная (`scope='system'`) дока из сессии чужого тенанта под FORCE RLS, не
> вводя второй read/authz-путь (NF-1)» решена **проекцией system-доков в каждый тенант** (§2.4), а не
> чтением их из чужой сессии. **Почему не «две выборки из system-тенанта» (iter-1 underspecified).** Под
> FORCE RLS сессия тенанта B (`choros.tenant_id = B`) физически видит только строки `tenant_id = B`; запрос
> `SELECT … FROM doc_page WHERE scope='system'` вернул бы **0 строк**, потому что system-доки лежали бы в
> `tenant_id = a0…001 ≠ B` — RLS отрезает их **до** предиката `scope`. Достать их можно было бы лишь (а)
> tenant-context-switch на system-тенант на внешней (harness) сессии — новый код-путь обхода tenant-контекста
> на самой опасной поверхности, либо (б) вторым RLS-предикатом `USING (scope='system')` — второй
> authorization-предикат не по `tenant_id`. Оба = именно тот «второй read/authz-путь», который ADR клянётся
> не вводить (NF-1); прецедента в `src/`/`migrations/` нет (паттерн RLS `migrations/051_report_page.sql:79`
> — чисто per-tenant, без `scope`/system). Поэтому system-доки **не читаются cross-tenant вовсе**: каждый
> тенант при provision/update получает **локальную проекцию** system-доков как обычные `tenant_id = <his>`
> строки (`scope='system'`, `authored_by='system'`), и tenant-B-сессия читает их **обычным RLS-путём**
> (`tenant_id = B`) — ноль второго механизма. Цена — синхронизация копий, решённая vendor-update-потоком по
> прецеденту managed-solution T-0133 (см. §2.4). Per-tenant доки (`scope='tenant'`) — тот же обычный RLS-путь.
> Разграничение `scope` — это **навигационный/origin-маркер внутри одного RLS-пути**, не второй read-путь.

### 2.2 `choros.doc_ref` — реестр типизированных ссылок (T-0013-контракт; родственник `report_page_dep`)

| Колонка | Тип | Примечание |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK, RLS-ключ |
| `id` | `uuid NOT NULL` | |
| `page_id` | `uuid NOT NULL` | FK `(tenant_id, page_id) → doc_page(tenant_id, id)` ON DELETE CASCADE |
| `ref_kind` | `text NOT NULL` | `CHECK (ref_kind IN ('code_symbol','rest_endpoint','schema_field','process','config_key'))`; vocab закрытый, расширяем аддитивной миграцией |
| `ref_target` | `jsonb NOT NULL` | **типизированный машинно-разрешимый идентификатор** референта (НЕ свободный текст), форма по `ref_kind` (§3.1) |
| `broken` | `boolean NOT NULL DEFAULT false` | выставляется lint при отсутствии референта в живой системе (FR-6) |
| `created_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; `UNIQUE (tenant_id, page_id, ref_kind, ref_target)`; FK ON DELETE CASCADE; FORCE RLS; policy `doc_ref_tenant_isolation`; `GRANT … TO choros_app`; в `known_tenant_tables.txt` |

### 2.3 `choros.doc_log` — журнал изменений доков (LLM-wiki `log`) (T-0013-контракт)

| Колонка | Тип | Примечание |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK, RLS-ключ |
| `id` | `uuid NOT NULL` | |
| `page_id` | `uuid NOT NULL` | FK `(tenant_id, page_id) → doc_page(tenant_id, id)` ON DELETE CASCADE |
| `op` | `text NOT NULL` | open-vocab: `'authored'`/`'updated'`/`'marked_stale'`/`'ref_fixed'`/`'system_doc_projected'` (vendor-update проекция, §2.4)/… (строки, не таблицы — паттерн T-0016 open-vocab) |
| `agent_actor` | `text NOT NULL` | какой агент обновил (что/когда/каким агентом — FR-2) |
| `diff_summary` | `text NULL` | человеко/машинно-читаемая сводка изменения |
| `at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; FK ON DELETE CASCADE; index `(tenant_id, page_id, at)`; FORCE RLS; policy `doc_log_tenant_isolation`; `GRANT … TO choros_app`; в `known_tenant_tables.txt` |

> **Версионирование без четвёртого механизма (FR-4, NF-6).** `doc_log` — это `log`-член LLM-wiki
> (история «кто-агент/когда/diff»), **не новая подсистема версионирования**. Связь «доки актуальны ↔
> живая система» держит **lint** (§3) — тот же класс гарда «производный артефакт ↔ источник», что
> `bundle-coherence.sh` (T-0082) и `report_page_dep` (T-0121); мы **переиспользуем** этот класс, а не
> вводим параллельный. `doc_log` фиксирует историю правок; согласованность с источником — `doc_ref`+lint.

### 2.4 `scope='system'`-доки = per-tenant проекция (R-1 решение, FR-3/FR-11/FR-14, ось 4)

**Развилка (R-1) и её честный разбор — см. блок-инвариант §2.1.** Выбранная ветвь: **(а) per-tenant
проекция** system-доков в каждый тенант, отвергнуты **(б) выделенная RLS-политика по `scope`** и **(в)
отдельная глобальная таблица `doc_page_system` без RLS** (rejected-alternatives — §7). Механика:

- **Авторская копия (vendor master).** Оригиналы system-доков продукта авторятся агентами в **выделенном
  system-тенанте** `a0000000-…-001` (T-0077) — это обычные `doc_page`-строки с `tenant_id = a0…001`,
  `scope='system'`. Эта копия — **источник проекции**, она НЕ читается из чужих сессий.
- **Проекция при provision/update.** При провижне тенанта (и при vendor-update каталога system-доков)
  агент-поставщик **реплицирует** актуальные `scope='system'`-страницы в тенант как обычные строки
  `tenant_id = <этот тенант>`, `scope='system'`, `authored_by='system'`, с `doc_page.catalog_version`
  (версия пакета system-доков; nullable для `scope='tenant'`). Чтение из любой tenant-сессии (UI / агент /
  docs-MCP) — **обычный RLS-путь** `tenant_id = current_setting('choros.tenant_id')` — **ноль второго
  предиката, ноль context-switch**. Изоляция остаётся структурой T-0013, не дисциплиной кода.
- **Vendor-update-поток (managed-solution, прецедент T-0133 §2.5/§3.6, [ЖИВОЙ] git `db913d6`).** Версия
  пакета system-доков растёт vX→vY; при provision/update проекция в тенант обновляется как
  **governed-операция** (тот же класс, что `VendorUpdateProposal` T-0133): day-1 = **детект+перепроекция
  с уведомлением** (`doc_log('system_doc_projected', diff_summary)` + `audit_event('docs.system_projected')`),
  полная diff/merge-машинерия локально-изменённых проекций — **Stage-2 deferral** (как T-0133 §3.6,
  соразмерность). Tenant НЕ редактирует system-проекцию (она read-only origin внутри его tenant-данных);
  попытка записи — обычный grant-deny, не спец-путь.
- **Единообразие чтения двух классов (lint/MCP/UI).** Поскольку system-доки физически живут как
  `tenant_id = <его>` строки, **все три потребителя читают ОДИН класс данных одним путём**: lint
  (`checkDocRefs`) сверяет `scope='system'`- и `scope='tenant'`-строки **одинаково** (референты — тот же
  `LiveSnapshot`); docs-MCP отдаёт обе под тем же `resolveFor` (нет ветки «это system?»); UI рендерит
  `index` смешанно, помечая `scope='system'` бейджем «общесистемная». `scope` — навигационный/origin-маркер,
  НЕ ключ авторизации и НЕ переключатель read-пути.

> **Слот миграции для `catalog_version`.** Колонка `doc_page.catalog_version text NULL` входит в DDL
> `doc_page` (§2.1), не отдельная таблица — проекция использует ту же таблицу-семью (NF-3). Vendor-master
> (`a0…001`) и проекции различаются только `tenant_id`; форма строки идентична.

---

## 3. Lint устаревания — чистое ядро `src/core/doc-ref-lint.ts` (FR-5..FR-8, fitness-семейство)

### 3.1 Типизированная ссылка (FR-5) — `ref_target` по `ref_kind` (закрытый vocab)

```ts
// Машинно-разрешимый референт. НЕ свободный текст — каждый kind несёт проверяемый идентификатор.
export type DocRefKind =
  | 'code_symbol'    // ref_target: { module: string, symbol: string }       — экспорт модуля
  | 'rest_endpoint'  // ref_target: { method: string, path: string }          — зарегистрированный роут
  | 'schema_field'   // ref_target: { registryDefId: string, fieldKey: string }— registry_def.record_schema.properties
  | 'process'        // ref_target: { processKey: string }                     — задеплоенный BPMN/DMN ключ
  | 'config_key';    // ref_target: { key: string }                           — валидный конфиг-ключ

export interface DocRef { refKind: DocRefKind; refTarget: Record<string, string>; }
```

### 3.2 Снимок живой системы + чистая проверка (FR-6/FR-7)

```ts
// Снимок актуального состояния системы — собирается импортёром (DAO/интроспекция), НЕ внутри ядра.
// Ядро остаётся pure: вход = ссылки + снимок; выход = список битых (паттерн T-0121 checkReportPageDepFields).
export interface LiveSnapshot {
  codeSymbols: ReadonlySet<string>;      // `${module}#${symbol}`
  restEndpoints: ReadonlySet<string>;    // `${method} ${path}`
  schemaFields: ReadonlySet<string>;     // `${registryDefId}#${fieldKey}`
  processKeys: ReadonlySet<string>;
  configKeys: ReadonlySet<string>;
}
export interface DocRefViolation { type: 'missing_referent'; refKind: DocRefKind; refTarget: Record<string,string>; }
export type DocLintResult = { ok: true } | { ok: false; violations: DocRefViolation[] };

// PURE. NO I/O. NO pg/fs/net. Для каждой ссылки: референт ∈ соответствующего множества снимка?
// Отсутствует ⇒ violation. Пусто ⇒ {ok:true}. (FF-1 T-0132-класс: вход=артефакт+снимок, выход=нарушения.)
export function checkDocRefs(refs: readonly DocRef[], live: LiveSnapshot): DocLintResult;
```

Контракт идентичен по форме `checkReportPageDepFields` (T-0121 §3) — ADR **явно объявляет** lint доков
расширением того же fitness-класса «производный артефакт ↔ живой источник» (T-0072/T-0082/T-0132), **не
четвёртым механизмом** (NF-6). Сбор `LiveSnapshot` (интроспекция экспортов/роутов/схем/процессов/конфигов)
— impl-зона DAO, не ядра; ядро детерминированно и тестируемо без БД (static-now).

> **Граница источника `LiveSnapshot` по `ref_kind` (R-3, явно).** Поля снимка собираются из **двух разных
> источников**, и эта граница — design-owned, не недоговорённость:
> - **`codeSymbols` (`code_symbol`) = build/CI-time источник.** «Экспорты модуля» — build-time-интроспекция
>   исходников; на **проде исходников нет** (деплой = собранный артефакт). Поэтому `code_symbol`-сверка
>   живёт в **CI на исходниках** (естественно для lint-as-CI-fitness, как `report-page-compat` T-0121),
>   либо снимок экспортов **пакуется в артефакт** при сборке. `code_symbol`-lint — **не рантайм-проба**.
> - **`restEndpoints`/`processKeys`/`configKeys`/`schemaFields` = runtime-разрешимы** из живых реестров
>   (роут-реестр, задеплоенные BPMN/DMN-ключи, конфиг-реестр, `registry_def.record_schema`) — доступны и
>   на проде в рантайме.
> Эта граница фиксируется для T-0134c (сборщик `LiveSnapshot`): `code_symbol`-ветвь = build/CI-time,
> остальные — runtime. Ядро `checkDocRefs` от источника снимка **не зависит** (вход = собранный снимок).

### 3.3 CI-гард `doc-coherence.sh` + реакция на устаревание (FR-7/FR-8)

- **CI-fitness-функция** (T-0082-класс): `ci/checks/doc-coherence.sh` запускает `checkDocRefs` над
  `doc_ref`-фикстурой + снимком; **любая битая ссылка ⇒ exit 1** в отчёте lint (вход = страница+снимок,
  выход = список битых, пусто = ок). `doc_page`/`doc_ref`/`doc_log` вносятся в реестр bundle-членов
  (как `report_page_dep` в `bundle_members.txt`, T-0121 §5.4) — обязательство impl-задачи (deferral-контракт T-0082).
- **Runtime-реакция (дефолт day-1):** lint-проход (плановый/по-триггеру — зона пайплайна №3) выставляет
  `doc_ref.broken=true` + `doc_page.stale=true` + пишет `doc_log('marked_stale')` + `audit_event('docs.stale_detected')`.
  Это **детекция + сигнал**, не hard-block.
- **SEAM-2 (design-owned, Stage-2):** «блокировать ли публикацию/CI при битой ссылке» (hard-gate, как
  `409 destructive_schema_change` T-0121) — отложено; факт детекции (`broken`/`stale`/отчёт) обязателен day-1.

---

## 4. UI-страница доков (ось C, FR-9..FR-11)

- **Роут / навигация (FR-9):** страница доков — раздел продукта `/docs` (навигация по `index` =
  каталог `doc_page` выбранного `scope`/`app`, чтение `body` страницы). Читает **тот же** док-слой
  (§2-таблицы) через RLS-gated серверный API (`GET /api/docs` / `GET /api/docs/:slug`), что и
  агенты/MCP — **не отдельную копию** (NF-3). Страница **отчётно-навигационная**: чтение + сигнал; **ручного
  редактора доков нет** (доки пишут агенты, AC-18).
- **Сигнал устаревания (FR-10):** результат lint виден на UI — `doc_page.stale=true` рендерится **бейджем/
  предупреждением** «раздел может быть устаревшим» (+ при разворачивании: какие `doc_ref.broken` ссылки), чтобы
  человек не доверял молча протухшему тексту.
- **Tenant-граница видимости (FR-11):** UI показывает только доки, видимые пользователю — и `scope='tenant'`,
  и `scope='system'`-проекция (§2.4) под RLS его tenant **одним путём** (+ видимость по грантам для
  scoped-страниц, тот же PDP). Per-tenant vs общесистемные различаются полем `scope` (бейдж «общесистемная»),
  не отдельным read-путём; cross-tenant-доки в UI неконструируемы (T-0013).

---

## 5. MCP-сервер документации (ось D, FR-12..FR-16) — read-only специализация T-0122

### 5.1 Поверхность read-only (FR-12)

Три read-операции, **никаких мутаций** системы или доков: `docs_list` (каталог `index` видимых страниц),
`docs_read` (тело страницы по `slug`), `docs_search` (поиск по `title`/`body`). Запись доков — **зона
агентов Choros** по пайплайну исследования №3, **не** внешних harness. **Отсутствие mutation-операций —
несущий инвариант** (read-only-гард, §8 FF-DOCS-READONLY): docs-MCP не несёт ни одной операции с
`operation ∈ {create,update,delete}`.

### 5.2 Authz внутри grant-модели (FR-13, NF-1 — non-negotiable)

Доступ к docs-MCP авторизуется **ВНУТРИ** grant-модели T-0018/T-0021 — **никакого второго механизма**:

- Harness-принципал = **производный ограниченный read-only грант** на **синтетическую `is_external`-роль**
  (T-0122 §2.3): `resource_type='doc_page'`, `operation='read'`, `delegable=false`, опц. `scope`-сужение до
  подмножества страниц; грант проходит `validateNarrowing` (write-time subset gate) при выдаче — **структурно
  не шире**, чем выдавший имел право.
- Резолв «что видит harness» принимает **тот же** `resolveFor(handle, subject, 'read')` (T-0021), action-time,
  fail-closed; `projectFields` применяется идентично внутреннему (нет ветки «это harness?»).
- **Запрет второго механизма:** нет `docs_acl` / `mcp_doc_share` / `doc_page.public`-поля. «Кто видит доку»
  вычисляет **только** PDP из grant-строк (FF-DOCS-NO-2ND-AUTHZ, как T-0121 FF-R6 / T-0122 FF-NOACL).

### 5.3 Tenant-изоляция MCP-доступа (FR-14)

Tenant **детерминируется токеном harness** (T-0122 §2.4 fail-closed tenant-вывод), harness его не выбирает.
Отдаются доки под грантом предъявленного принципала **обычным RLS-путём этого tenant** — и `scope='tenant'`,
и `scope='system'` (последние присутствуют в этом тенанте как проекция, §2.4): **один read-путь, не два**;
нет ни tenant-context-switch, ни второго RLS-предиката по `scope` (R-1). Cross-tenant-утечка структурно
невозможна (T-0013 FORCE RLS + fail-closed external-контекст, tenancy §9 п.7): даже зная чужой `slug`,
harness не подставит чужой tenant; system-доки чужого тенанта недостижимы, потому что harness читает только
свою проекцию. FF-DOCS-TENANT покрывает обе грани (tenant B не достаёт `scope='tenant'` tenant A **и** видит
ровно свою system-проекцию, не master-копию `a0…001`).

### 5.4 Аудит обращений (FR-15)

Каждое обращение к docs-MCP (успех И deny) — строка `audit_event` (T-0016), tenant-scoped, **open-vocab `type`**
(`docs.list`/`docs.read`/`docs.search`/`docs.deny`) — **строки, не вторая таблица/лог**. `actor` =
производный от harness-токена/поверхности (`external-surface:<id>`, T-0122 §2.8; учётки может не быть, **секрет
не пишется**); `subject` = `doc_page`-ref/slug; `via='docs-mcp'`; `payload` = allow/deny + reason. Единый аудит, без второго sink.

### 5.5 Согласованность с реестром `mcp_tool` T-0043 (FR-16)

Docs-сервер **представлен mcp-инструментами в реестре T-0043** (`mcp_tool`-строки `docs_list`/`docs_read`/`docs_search`,
seed в dev-тенант — урок T-0077/T-0121 §6.1):
- `declares='[]'::jsonb`, `pure_compute=true` (read-only чтение доков — не внешний эффект);
- `resource_ops='[{"resourceType":"doc_page","operation":"read"}]'::jsonb` — **типизированы**, матчатся против
  `grant`-строк тем же `isToolReachable`/`resolveAgentToolset` (T-0043), **не свободный текст**;
- docs-сервер **не вводит** новый authority-store поверх T-0043/T-0018 — reachability и authority остаются в
  существующих стораджах, соединённых тем же запросом над грантами.

`resource_type='doc_page'`-строка живёт как **TEXT** в `grant.resource_type`/`resource_ops` (нет DB CHECK на
vocab — паттерн T-0077 §2.2 / T-0121 §6 widening-cast); frozen TS-union `ResourceType` **не правится**,
widening-cast только на границе/в тестах.

---

## 6. Природа задачи и граница (ось E, FR-17/FR-18, §4 спеки)

- **Доки пишут агенты (AC-18):** `doc_page.authored_by`/`doc_log.agent_actor` фиксируют агента-автора;
  UI/MCP — **read-поверхности**; ручной WYSIWYG-редактор доков клиентом **не проектируется** (решение фаундера).
- **Пайплайн генерации = исследование №3 / Stage-2 (FR-17, SEAM-3):** как именно агент обходит живую систему,
  генерирует/обновляет/дедуплицирует страницы, разрешает конфликты, по каким триггерам/частоте — **вне T-0134**.
  T-0134 даёт рамку (модель страницы §2, lint §3, UI §4, MCP-authz §5), пайплайн — Stage-2 после исследования.
  **НЕ blocking** (рамка проектируема сейчас); T-0134 разблокирует №3, передавая ему `doc_page`/`doc_ref`/`doc_log`
  + `checkDocRefs` как контракт, который пайплайн наполняет.
- **Границы design-only (AC-20, SEAM-2/SEAM-3):** миграции (≥055, 054=T-0128), объектная модель доков, код MCP-сервера/wire-
  протокол, UI-компоненты, строки lint-правил, сбор `LiveSnapshot` — **зона производных DESIGN/BUILD-задач** (§9);
  hard-gate-политика lint = SEAM-2; пайплайн = SEAM-3.

---

## 7. Rejected alternatives (внутри-DESIGN развилки)

| Развилка | Option (отвергнут) | Why not |
|---|---|---|
| **Носитель док-слоя** (FR-3, AC-3) | **Доки = файлы в репозитории/хранилище** (markdown в git, без таблиц) | (а) **tenant-изоляция теряется**: per-tenant доки в общем git/FS не несут FORCE RLS — cross-tenant-видимость = дисциплина кода, не структура (T-0013 прямо запрещает: один leak = смерть GTM); (б) **UI/MCP-чтение под грантом**: PDP резолвит видимость по `ResourceRef` записи — файл вне registry-модели требует второго пути авторизации видимости (NF-1 нарушен); (в) tenant-видимый поиск/индекс по файлам = параллельный индекс мимо RLS. **Выбран Postgres tenant-таблицы** (FORCE RLS, `tenant_id`-leading) — видимость = тот же PDP, изоляция = структура, как `report_page` T-0121. Общесистемные доки (`scope='system'`) — выделенный system-тенант, не файлы (§2.1). |
| **Носитель — гибрид** (файлы для system + таблицы для tenant) | Два носителя ⇒ два пути чтения/lint/authz ⇒ дрейф «один слой» (NF-3) в две подсистемы. `scope`-колонка в одной таблице-семье даёт разграничение без второго носителя. |
| **Чтение `scope='system'` из system-тенанта (R-1, ветвь б)** | **Выделенная read-only RLS-политика `USING (scope='system')` на `doc_page`** (второй предикат рядом с tenant-ключом) | Это **именно второй authorization-предикат** не по `tenant_id` — буквально «второй read/authz-путь», который NF-1 запрещает. Аргумент «политика ≠ authz» слаб: RLS-предикат, решающий что видно, **и есть** read-time authorization-чекпойнт мимо PDP/grant. Даже с FF, доказывающей «не достаёт `scope='tenant'`-строк», остаётся два USING-предиката на одной таблице → структурный дрейф «одного пути» на самой опасной (harness) поверхности. **Отвергнут** в пользу проекции (§2.4): один RLS-путь по `tenant_id`. |
| **Чтение `scope='system'` (R-1, ветвь в)** | **Отдельная глобальная таблица `doc_page_system` без RLS, read-only, своя FF-обвязка** | Честный отдельный класс данных, но **раскалывает «один слой» (NF-3) на две таблицы-семьи**: lint, docs-MCP, UI и `doc_ref`-FK обязаны нести **две ветки чтения** (RLS-таблица + глобальная) — тот же дрейф, что отвергнут в «гибридном носителе» выше. Глобальная таблица без RLS = новый класс «вне tenant-контекста», требующий собственной authz-обвязки на harness-поверхности. **Отвергнут** в пользу проекции: system-доки физически = обычные tenant-строки, один путь чтения для всех потребителей (§2.4). |
| **Чтение `scope='system'` (R-1, ветвь а — ВЫБРАНА)** | *(per-tenant проекция, §2.4)* | system-доки реплицируются в каждый тенант при provision/update как обычные `tenant_id=<его>` строки → чтение обычным RLS-путём, **ноль второго механизма** (NF-1 удержан). Цена — синхронизация копий, решённая vendor-update-потоком (managed-solution, прецедент T-0133 §2.5/§3.6, git `db913d6`): day-1 = детект+перепроекция+уведомление, полная merge-машинерия = Stage-2 deferral (соразмерность). FF-DOCS-SYSTEM-PROJECTION доказывает один read-путь. |
| **Реестр ссылок** (FR-5) | **Ссылка дока = свободный текст / markdown-линк** | Свободный текст неразрешим машинно — lint не сможет сверить с живой системой (вернёмся к «человек заметит», прямо запрещено FR-6/NF-4). Типизированный `doc_ref(ref_kind, ref_target)` — машинно-разрешимый идентификатор, как `report_page_dep.field_key` (T-0121) и `declares`/`resource_ops` (T-0043 — anti-free-text). |
| **Lint-механизм** (FR-6) | **Сверка доков с замороженной копией системы (`raw`-снапшот, как gist Карпатого)** | `raw`-копия = **второй источник истины**, дрейфует от живой системы; устаревание детектировалось бы относительно копии, не реальности (NF-2 нарушен, прямо против решения фаундера «без raw»). Lint сверяет с **живым `LiveSnapshot`** (актуальные экспорты/роуты/схемы/процессы), не с замороженным. |
| **Lint-механизм** | **Новый отдельный coherence-движок для доков** | Четвёртый параллельный механизм «артефакт↔источник» рядом с T-0072/T-0082/T-0121 (gap-map §4б / NF-6 запрещает). Переиспользуем класс: pure `checkDocRefs` (форма `checkReportPageDepFields`) + bash-гард (`doc-coherence.sh`, форма `bundle-coherence.sh`). |
| **Версионирование** (FR-4) | **Полноценная git-под-капотом / отдельная version-подсистема доков** | Соразмерность (ось 5): day-1 не нужна content-addressed машинерия; `doc_log` (LLM-wiki `log`) + lint-сигнал достаточны для «история видна, устаревание детектируемо». Полная версионная машинерия — инкрементально (как `bundle_ref` nullable T-0121/T-0082 §11). |
| **MCP authz** (FR-13) | **`docs_acl` / `mcp_doc_share` / `doc_page.public`-поле (отдельные права harness)** | Второй источник истины «что видит harness» дрейфует от grant-таблицы → тихий leak на **внешней** поверхности (худшее место). Запрещён gap-map §4б инвариант 2 / T-0018 §2 / T-0021 FF-R6 / NF-1. Право harness **выводится** из производного гранта тем же PDP (T-0122-паттерн). |
| **MCP authz** | **Отдельный токен-механизм/keycloak-гость для harness** | T-0122 уже решил: внешний/harness = токен → производный грант на `is_external`-роль, не учётка/не второй authz. Docs-MCP **переиспользует** §2.3/§2.4 T-0122 (read-only-срез), не вводит параллель. |
| **MCP представление** (FR-16) | **Docs-сервер вне реестра `mcp_tool` (собственный tool-каталог)** | Второй tool/authority-store рядом с T-0043; reachability harness считалась бы отдельным путём. Docs-операции = `mcp_tool`-строки с типизированными `resource_ops` (T-0043), reachability = тот же `resolveAgentToolset`. |
| **Аудит** (FR-15) | **Отдельная `docs_access_log` таблица** | Второй append-only/isolation/chain код-путь (T-0016 §2 запрещает). Обращения = строки `audit_event` open-vocab `docs.*` (как `external.*` T-0122 / `report_page.*` T-0121). |
| **Один слой** (NF-3) | **Три копии доков под трёх потребителей (UI-копия / agent-копия / MCP-копия)** | Три копии рассинхронизируются; lint и `log` пришлось бы вести трижды. Один слой (§2), три read-проекции (§4/§5 + внутренний агент-интерфейс читает те же таблицы). |

Ни одна не переоткрывает решение фаундера; это стандартные альтернативы делегированного доступа/реестра
согласованности, зафиксированные для аудируемости выбора.

---

## 8. Fitness functions (machine-verifiable)

| ID | Rule | CI-check (gating) | AC |
|---|---|---|---|
| **FF-T13-DOCS** | `doc_page`/`doc_ref`/`doc_log` — `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id`, `choros_app` DML-only, в `known_tenant_tables.txt`. | T-0013/T-0115-пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) после внесения в фикстуру. **live-impl**. | AC-3, AC-11, AC-14 |
| **FF-SCHEMA-DOCS** | Миграции `≥055_doc_page.sql`/`_doc_ref.sql`/`_doc_log.sql` (054 занят T-0128, R-5) определяют поля §2.1–§2.3 (вкл. `doc_page.catalog_version text NULL`), CHECK на `scope`/`ref_kind`, UNIQUE-ключи, FK ON DELETE CASCADE; контент = `text` (не bytea/lo_). | `grep`-статик на DDL: assert колонки (вкл. catalog_version)/CHECK/UNIQUE/FK; `grep -iE '\b(bytea|lo_)\b'` ⇒ 0. **static-now** (после coder). | AC-2, AC-3 |
| **FF-NO-RAW** | В миграциях/коде/реестре нет таблицы/папки `raw`-сырья доков; источник истины = живая система; ADR/код несут явное утверждение «нет raw». | `grep -riE 'doc_?raw\|docs?_source_raw\|raw_doc' migrations/ src/` ⇒ 0; assert ADR §1/§7 содержит утверждение «нет raw, источник = живая система». **static-now**. | AC-1 |
| **FF-DOCREF-TYPED** | `doc_ref.ref_target` — типизированный (`ref_kind`-CHECK закрытый vocab), не свободный текст; `DocRef`/`DocRefKind` в `doc-ref-lint.ts`. | `grep` CHECK `ref_kind IN (...)` в миграции; unit на форму `ref_target` по kind. **static-now**. | AC-5 |
| **FF-LINT-PURE** | `checkDocRefs` экспортируется из `src/core/doc-ref-lint.ts`; pure (нет импортов `pg`/`fs`/`net`/DAO); комментарий ссылается на T-0121 `checkReportPageDepFields` / T-0132 FF-1. | `grep -nE 'from "(pg\|fs\|net\|http\|node:.*)"\|require\(' src/core/doc-ref-lint.ts` ⇒ 0; vitest `-t 'pure'`. **static-now**. | AC-6, AC-7 |
| **FF-LINT-BEHAVIOR** | `checkDocRefs`: ссылка с референтом ∉ снимка ⇒ `{ok:false, violations:[{type:'missing_referent', refKind, refTarget}]}`; все референты ∈ снимка ⇒ `{ok:true}` (пусто = ок). | vitest `-t 'missing-referent' / 'all-present'`. **static-now**. | AC-6, AC-7 |
| **FF-DOC-COHERENCE** | `ci/checks/doc-coherence.sh` запускает `checkDocRefs` над фикстурой+снимком; битая ссылка ⇒ exit 1; `doc_page`/`doc_ref`/`doc_log` ∈ реестра bundle-членов. | запуск `doc-coherence.sh` на фикстуре с битой ссылкой ⇒ exit 1; grep реестра. **static-now** (после impl, T-0082-класс). | AC-7 |
| **FF-STALE-SIGNAL** | Битая ссылка ⇒ `doc_ref.broken=true` + `doc_page.stale=true` + `doc_log('marked_stale')` + `audit_event('docs.stale_detected')`; реакция = детекция+сигнал (hard-gate помечен SEAM-2). | live-impl probe: lint над страницей с битой ссылкой ⇒ broken/stale выставлены, событие записано. **live-impl**. | AC-8 |
| **FF-UI-SAME-LAYER** | UI `/api/docs` читает `doc_page`/`doc_ref` (тот же слой), не отдельную копию; ответ несёт `stale`-флаг для бейджа; видимость tenant-scoped (RLS) + `scope`-разграничение. | static: assert UI-API селектит из `doc_page`, не из отдельного docs-store; ответ содержит `stale`. live-impl: cross-tenant docs invisible. **static-now + live-impl**. | AC-9, AC-10, AC-11 |
| **FF-DOCS-READONLY** | Docs-MCP несёт только read-операции (`docs_list`/`docs_read`/`docs_search`); ни одной `operation ∈ {create,update,delete}` на доки/систему; `mcp_tool`-seed `resource_ops` — только `operation:'read'`. | `grep` resource_ops seed ⇒ только `read`; assert нет mutation-handler в docs-MCP-слое. **static-now**. | AC-12 |
| **FF-DOCS-NO-2ND-AUTHZ** | Authz docs-MCP = grant-алгебра T-0018 + PDP T-0021 (производный read-only грант на `is_external`-роль); нет `docs_acl`/`mcp_doc_share`/`doc_page.public`; harness резолвится тем же `resolveFor`. | `grep` forbidden tokens в migrations/MCP-слое ⇒ 0; assert PDP-call (`resolveFor`), не локальный фильтр видимости. **static-now**. | AC-13 |
| **FF-DOCS-TENANT** | Docs-MCP отдаёт только доки под грантом принципала **обычным RLS-путём** (один путь для `scope='tenant'` И `scope='system'`-проекции); tenant из токена (fail-closed, не вход); cross-tenant-утечка структурно невозможна. | live-impl probe (style `cross_tenant.test.ts`): токен tenant B не достаёт `doc_page` tenant A (ни `scope='tenant'`, ни system-проекцию A). **live-impl**. | AC-14 |
| **FF-DOCS-SYSTEM-PROJECTION** | `scope='system'`-доки читаются из любой tenant-сессии **обычным RLS-путём** (`tenant_id = current_setting('choros.tenant_id')`) — нет второго RLS-предиката по `scope`, нет tenant-context-switch на внешней сессии (NF-1, R-1). System-доки присутствуют в каждом тенанте как проекция (§2.4); master-копия (`a0…001`) недостижима из чужой сессии. | (а) **static-now**: `grep` политик `doc_page` ⇒ единственный USING-предикат `tenant_id = current_setting(...)` (нет `scope`-предиката); `grep` docs-MCP/UI-слоя ⇒ нет `SET choros.tenant_id`/cross-tenant-context-switch. (б) **live-impl** probe: tenant-B-сессия читает `scope='system'`-строки `tenant_id=B` (своя проекция), `SELECT scope='system' AND tenant_id=a0…001` ⇒ 0 строк под FORCE RLS. | AC-3, AC-11, AC-14 |
| **FF-DOCS-AUDIT** | Обращения к docs-MCP (allow И deny) ⇒ `audit_event` open-vocab `docs.*` (единый sink, без второй таблицы); актор производен от harness-токена, секрет не пишется. | vitest `-t 'docs-audit'`: каждая операция эмитит событие; assert нет audit-дубля/`docs_access_log`. **static-now + live-impl**. | AC-15 |
| **FF-MCP-T43** | Docs-операции = `mcp_tool`-строки (T-0043): `declares='[]'`, `pure_compute=true`, `resource_ops` типизированы (`{doc_page,read}`); reachability через `resolveAgentToolset`; нет нового authority-store. | grep seed-строк mcp_tool; assert reachability-путь = T-0043 (`isToolReachable`), не отдельный каталог. **static-now**. | AC-16 |
| **FF-DEFERRAL-PIPELINE** | ADR явно фиксирует: пайплайн генерации = исследование №3/Stage-2 (SEAM-3), НЕ blocking; T-0134 = рамка; границы design-only перечислены + вытекающие задачи (§9). | static (FF-1 T-0132-класс): assert ADR содержит именованные SEAM-3/Stage-2-утверждения + §9-декомпозицию. **static-now**. | AC-17, AC-20 |
| **FF-AGENTS-AUTHOR** | ADR утверждает: доки пишут агенты (`authored_by`/`agent_actor`); UI отчётно-навигационная; ручной редактор не проектируется. | static: assert ADR §1/§6 несёт утверждение; `doc_page.authored_by`/`doc_log.agent_actor` в §2. **static-now**. | AC-18 |
| **FF-TRACE** | Раздел трассировки присутствует: каждое требование → §3а/envelope/опорный ADR (T-0013/T-0016/T-0018/T-0021/T-0043). | static (FF-1 T-0132-класс): assert §10 содержит ≥20 AC-строк с covered_by. **static-now**. | AC-19 |

---

## 9. Build-задачи (декомпозиция; материализуются после ADR)

| Задача | Название | Depends on | Fitness (DoD) |
|---|---|---|---|
| **T-0134a** | `[impl] doc_page (+catalog_version) + doc_ref + doc_log DDL (migrations ≥055, 054=T-0128) + known_tenant_tables` | T-0014, T-0013/T-0017 apparatus | FF-T13-DOCS, FF-SCHEMA-DOCS, FF-NO-RAW, FF-DOCREF-TYPED; три таблицы под FORCE RLS, в фикстуре, T-0013-пробы зелёные |
| **T-0134b** | `[impl] core/doc-ref-lint.ts — checkDocRefs (pure) + DocRef/LiveSnapshot типы` | T-0121 (паттерн compat) / T-0072 | FF-LINT-PURE, FF-LINT-BEHAVIOR; vitest зелёный, нет I/O-импортов |
| **T-0134c** | `[impl] LiveSnapshot-сборщик (интроспекция экспортов/роутов/схем/процессов/конфигов) + doc-coherence.sh` | T-0134a, T-0134b, T-0082 | FF-DOC-COHERENCE; гард fail на битой ссылке, реестр bundle-членов расширен |
| **T-0134d** | `[impl] lint-runtime: doc_ref.broken/doc_page.stale + doc_log + audit (docs.stale_detected)` | T-0134a, T-0134b, T-0016 | FF-STALE-SIGNAL; детекция+сигнал, событие записано (SEAM-2 hard-gate отложен) |
| **T-0134e** | `[impl] UI-страница /docs: index-навигация + чтение + stale-бейдж (RLS-gated /api/docs)` | T-0134a, T-0021 | FF-UI-SAME-LAYER; читает тот же слой, бейдж устаревания, tenant-scoped видимость |
| **T-0134f** | `[impl] docs-MCP read-only сервер (docs_list/read/search) + производный грант (T-0122) + audit` | T-0134a, T-0122, T-0021, T-0016 | FF-DOCS-READONLY, FF-DOCS-NO-2ND-AUTHZ, FF-DOCS-TENANT, FF-DOCS-AUDIT; read-only, единый PDP, tenant fail-closed |
| **T-0134g** | `[seed] mcp_tool docs_list/docs_read/docs_search (dev-тенант, паттерн T-0077/T-0121)` | T-0134f, T-0043, T-0077 | FF-MCP-T43; reachable в resolveAgentToolset, resource_ops `{doc_page,read}`, нет нового authority-store |
| **T-0134i** | `[impl] system-docs проекция: vendor-master (a0…001) → per-tenant репликация при provision/update + vendor-update (детект+перепроекция+doc_log/audit, managed-solution T-0133)` | T-0134a, T-0077, T-0133 | FF-DOCS-SYSTEM-PROJECTION; system-доки читаются обычным RLS-путём в каждом тенанте; merge локально-изменённых = Stage-2 deferral |
| **T-0134h** *(Stage-2 / исследование №3)* | `[research] агентный docs-pipeline: обход живой системы, генерация/обновление/дедуп страниц, конфликт-резолюция, триггеры` | T-0134a–g (рамка) | вне day-1; T-0134 разблокирует, передаёт doc_page/doc_ref/doc_log + checkDocRefs как контракт |

Внутренний агент-интерфейс (агенты Choros читают доки как контекст) = чтение тех же таблиц под тем же PDP —
не отдельная задача-механизм (NF-3); материализуется в рамках T-0134e/f-API либо пайплайна №3.

---

## 10. Traceability (20 AC → решения ADR)

| AC | verifiable_as | Покрыто |
|---|---|---|
| AC-1 | fitness | §1/§7 (источник = живая система, нет `raw`) + FF-NO-RAW |
| AC-2 | fitness | §2.1–§2.3 (`doc_page`=страница, `index`=выборка, `doc_log`=`log` что/когда/агент) + FF-SCHEMA-DOCS |
| AC-3 | fitness | §2.1/§2.4/§7 (носитель = Postgres tenant-таблицы FORCE RLS; rejected: файлы/гибрид/RLS-scope-предикат/глобальная таблица; `scope='system'` = per-tenant проекция, один RLS-путь) + FF-T13-DOCS/FF-SCHEMA-DOCS/FF-DOCS-SYSTEM-PROJECTION |
| AC-4 | fitness | §2.3 (`doc_log` версионирование/история, переиспользует T-0072/T-0082-класс, не четвёртый механизм) + FF-SCHEMA-DOCS |
| AC-5 | fitness | §2.2/§3.1 (`doc_ref(ref_kind, ref_target)` типизированная машинно-разрешимая ссылка, не текст) + FF-DOCREF-TYPED |
| AC-6 | manual | §3.2 (`checkDocRefs` сверяет каждую ссылку с `LiveSnapshot`; битая → детектируемый дефект) + FF-LINT-BEHAVIOR |
| AC-7 | fitness | §3.2/§3.3 (lint = pure CI-fitness; вход=ссылки+снимок, выход=битые, пусто=ок; `doc-coherence.sh`) + FF-LINT-PURE/FF-DOC-COHERENCE |
| AC-8 | manual | §3.3/§1 (реакция = детекция+сигнал: broken/stale/log/audit; hard-gate = SEAM-2 design-owned) + FF-STALE-SIGNAL |
| AC-9 | manual | §4 (UI `/docs` навигация по `index`+чтение, тот же слой §2, не копия) + FF-UI-SAME-LAYER |
| AC-10 | manual | §4 (`stale`-бейдж/предупреждение об устаревании на UI) + FF-UI-SAME-LAYER |
| AC-11 | fitness | §2.1/§2.4/§4 (tenant-граница UI: RLS + видимость по грантам; system = per-tenant проекция, один путь, бейдж) + FF-T13-DOCS/FF-UI-SAME-LAYER/FF-DOCS-SYSTEM-PROJECTION |
| AC-12 | manual | §5.1 (read-only docs-MCP: list/read/search; никаких мутаций — несущий инвариант) + FF-DOCS-READONLY |
| AC-13 | fitness | §5.2 (authz внутри T-0018/T-0021: производный read-only грант на is_external-роль; PDP fail-closed; нет второго механизма) + FF-DOCS-NO-2ND-AUTHZ |
| AC-14 | fitness | §5.3/§2.1/§2.4 (tenant-изоляция MCP: грант принципала; cross-tenant невозможен; system = per-tenant проекция, один RLS-путь) + FF-DOCS-TENANT/FF-DOCS-SYSTEM-PROJECTION |
| AC-15 | manual | §5.4 (обращения → единый аудит T-0016 open-vocab `docs.*`; актор производен; без второго лога) + FF-DOCS-AUDIT |
| AC-16 | fitness | §5.5 (docs-операции = `mcp_tool`-строки T-0043; declares/resource_ops типизированы; нет нового authority-store) + FF-MCP-T43 |
| AC-17 | fitness | §1/§6 (пайплайн генерации = исследование №3/Stage-2, SEAM-3, НЕ blocking; T-0134 = рамка) + FF-DEFERRAL-PIPELINE |
| AC-18 | manual | §1/§6 (доки пишут агенты `authored_by`/`agent_actor`; UI отчётно-навигационная; ручного редактора нет) + FF-AGENTS-AUTHOR |
| AC-19 | fitness | этот §10 (раздел трассировки; каждое требование → опорный ADR) + FF-TRACE |
| AC-20 | fitness | §6/§9 (design-only границы: миграции/модель/MCP-код/UI/wire — производные задачи; пайплайн = №3/Stage-2; декомпозиция T-0134a–h) + FF-DEFERRAL-PIPELINE |

---

## 11. Открытые развилки

**BLOCKING к фаундеру: нет.** Решение фаундера §3а «Документация» закрыло продуктовый объём (доки пишут
агенты; LLM-wiki без `raw`, источник = живая система, lint против устаревания; три потребителя UI/агент/MCP;
пайплайн = исследование №3, явно НЕ блокирует рамку). Все внутри-DESIGN развилки решены автономно внутри
существующих механизмов (T-0013/T-0016/T-0018/T-0021/T-0043/T-0072/T-0082/T-0121/T-0122).

**Design-owned точки (решены автономно, зафиксированы выше с rejected-alternatives §7):**
- Носитель = **Postgres tenant-таблицы** (`doc_page`/`doc_ref`/`doc_log`), не файлы/гибрид (§2/§7) — ради
  tenant-изоляции (T-0013) и единого пути видимости через PDP. `scope='system'`-доки = **per-tenant проекция**
  (§2.4, R-1): авторятся в system-тенанте `a0…001`, реплицируются в каждый тенант при provision/update →
  читаются обычным RLS-путём, без второго read/authz-пути (NF-1); синхронизация = vendor-update (T-0133).
- Ссылка = **типизированный `doc_ref(ref_kind, ref_target)`**, не свободный текст (§2.2/§3.1).
- Lint = **pure `checkDocRefs` + `doc-coherence.sh`** (родственник T-0121/T-0082, FF-1 T-0132-класс), не
  четвёртый механизм (§3).
- Реакция на устаревание = **детекция+сигнал** (broken/stale/log/audit/бейдж) day-1; hard-gate = **SEAM-2** (Stage-2) (§3.3).
- docs-MCP = **read-only специализация T-0122** (производный грант на is_external-роль), представлен
  **`mcp_tool`-строками T-0043** (§5).

**Развилки, осознанно отложенные (помечены, НЕ блокируют ADR):**
- **SEAM-2** — «блокировать ли публикацию/CI при битой ссылке» (hard-gate, как `409` T-0121): design-owned,
  Stage-2; day-1 = сигнал. Факт детекции обязателен.
- **SEAM-3 (исследование №3)** — детальный пайплайн генерации/поддержки доков агентом: вне T-0134, Stage-2 после
  исследования; T-0134 даёт рамку и разблокирует.
- **Версионная глубина** — полная git-под-капотом машинерия истории доков: инкрементально (соразмерность); day-1
  = `doc_log` + lint-сигнал.

**Координация для оркестратора/coder (R-2, R-5):**
- **Прецедентные lint-артефакты — уже в base (R-2).** `src/core/report-page-compat.ts` (T-0176, 12 КБ) и
  `src/core/binding-compat.ts` (T-0072) **физически присутствуют в базе этого worktree** (смержены, не на
  сестринской ветке). При материализации T-0134b coder сверяет точную форму
  `checkReportPageDepFields`/`DepViolation` **с живым `src/core/report-page-compat.ts` (уже в base, сверять
  можно сейчас)** и зеркалит 1:1 (NF-6 — один механизм). Если сигнатуры разошлись — это синхронизация
  реализации, не развилка дизайна. (mcp_tool-seed-дисциплина T-0077 §2.3 — seed в dev-тенант — тоже живой
  прецедент.)
- **Слот миграции — `055+`, не `054` (R-5).** В базе этого worktree максимум `053` (051/052/053 = T-0121-волна;
  050 = tier-fix), но **слот `054` уже занят дизайном T-0128 (connector, смержен `e2f8d79`, ADR T-0128 §3.1 D1
  пинит `migrations/054_connector.sql`)**. Coder T-0134 обязан взять **`055+`** (порядок
  `doc_page` → `doc_ref`/`doc_log` ради FK; `catalog_version` — в DDL `doc_page`, §2.4). Точный слот выбирает
  coder при материализации, но **054 = T-0128, не T-0134**.

**Headless/программная граница (R-4):** ADR переиспользует `is_external`-роль (T-0122) для harness-поверхности
docs-MCP. Механизм-прецедент = **живой T-0122 §0** («внешний принципал = токен → производный грант на
`is_external`, один механизм; покрывает И программную/headless поверхность, И человека-контрагента»). **T-0126
(headless-design) пока НЕ материализован** (нет `docs/design/T-0126*`/`docs/specs/T-0126*`); headless/программная
граница для docs-MCP держится **T-0122 §0**, не отдельным ADR T-0126. ADR T-0134 не опирается на T-0126.
