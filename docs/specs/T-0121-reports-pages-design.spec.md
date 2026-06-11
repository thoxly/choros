# Spec · T-0121 — Отчёты как кастомные UI-страницы (two-floor) + реестр зависимостей страниц от полей схемы

**Status:** ready
**Phase:** SPEC (для дизайн-задачи — выход фазы = требования к будущему ADR, не сам ADR)
**Date:** 2026-06-11
**Task:** T-0121 (product=choros, type=design, prio 57)
**spec_ref:** `playbooks/choros-product-gap-map.md` §2,§3а (решение фаундера: отчёт = кастомная UI-страница two-floor + реестр зависимостей); `docs/design/extensibility-and-authoring.md` §4 (two-floor/named-binding) + §12

**Решение фаундера (данность, не развилка):** отчётность → кастомные UI-страницы (two-floor), генерируется по описанию внедренцу/администратору, живёт в разделе. Обязательное расширение: **реестр зависимостей страницы от полей схемы** → предупреждение при изменении данных, red-line на деструктивное изменение (расширение bundle-coherence + named-binding).

**Опора (не противоречить):**
- `docs/design/extensibility-and-authoring.md` §4 — two-floor (Floor-1: декларативный JSON Schema + UI-schema; Floor-2: React-код поверх named-binding контракта); named-binding как единый источник истины.
- `docs/design/extensibility-and-authoring.md` §7/§9.4 — bundle-coherence: связка BPMN↔форма↔схема↔grants когерентна; CI-гард; report-page → член bundle при наличии field-deps.
- `docs/design/extensibility-and-authoring.md` §3 — три ортогональные оси: выразительность (A), governance промоушна (B), физические среды (C); two-floor не путать с governance-осью.
- `docs/design/extensibility-and-authoring.md` §4 — RED-LINES: default-DENY на необратимость; деструктивное = human-gate; семантическое предупреждение, не техническое.
- `docs/design/extensibility-and-authoring.md` §8 — «агент предлагает — человек подтверждает»; promoted только после человека.
- `docs/design/tenancy-and-delivery.md` — multi-tenant-first, `tenant_id`-leading PK, FORCE RLS везде, нет cross-tenant FK, tenant-контекст fail-closed в async/фоне.
- `docs/design/T-0013-tenant-isolation.adr.md` — полный T-0013-контракт для tenant-таблиц.
- `docs/design/T-0014-registry-model.adr.md` — namespace Application→Registry→Record; `registry_def.record_schema` = JSON Schema полей объекта.
- `docs/design/T-0015-object-handles.adr.md` — непрозрачные ручки; ссылки в странице = handles, не сырые данные.
- `docs/design/T-0018-grant-authority.adr.md` — единая grant-алгебра; нет второго permission-механизма.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чекпойнт; fail-closed.
- `docs/design/T-0016-audit-floor.adr.md` — append-only hash-chained аудит.
- `docs/design/T-0027-bpmn-deploy-linter.adr.md` — `lintBpmn` deploy-gate; расширяемо новыми типами нарушений.
- `docs/specs/T-0072-named-binding.spec.md` — `form_binding` tenant-таблица, `checkBindingCompat`, `BindingViolation`; **report-page использует тот же паттерн** зависимостей «артефакт → поля схемы», не второй механизм.
- `docs/specs/T-0082-bundle-coherence.spec.md` — `bundle_members.txt`, `bundle-coherence.sh`; `report_page_dep` должна войти в bundle-реестр при создании.

**Связанные задачи (инварианты, читать дизайнеру):**
- **T-0072 (named-binding)** — gap-map §4б: «T-0121 реестр зависимостей отчётов — та же подсистема согласованности, что T-0072 и T-0084; не плодить три механизма». ADR T-0121 **расширяет** паттерн T-0072 (BindingViolation → DepViolation), не изобретает отдельный механизм. field-dep — это обратная сторона того же named-binding контракта: форма _производит_ переменные, страница отчёта _потребляет_ поля схемы.
- **T-0082 (bundle-coherence)** — gap-map §4б: `report_page_dep` как таблица зависимостей входит в `bundle_members.txt` (задача T-0121-impl обязана обновить); `bundle-coherence.sh` расширяется проверкой существования полей-депедансов против актуальной `record_schema`. Деструктивное изменение схемы → CI fail если `report_page_dep` объявляет зависимость на удаляемое поле.
- **T-0084 (changelog/diff-валидатор)** — семантический changelog изменений схемы должен включать классификацию «изменение затрагивает N отчётов»; ADR T-0121 фиксирует, что это контракт, который T-0084 должен реализовать.
- **T-0077 (config-agent)** — gap-map §4б: config-agent авторит report-page как DRAFT-only артефакт через MCP-tool `author_report_page`; governance (ось B) — human-gated promote; ADR T-0121 фиксирует этот MCP-tool как новый в реестре агента.
- **T-0087 (draft-тиры)** — страница отчёта живёт в том же draft→published тире, что и любой другой артефакт (extensibility §8); ADR не вводит отдельный тир-механизм.

---

## 1. Summary

Choros получает подсистему **отчётных страниц** — кастомных UI-страниц для отчётности руководителю, живущих в разделе (Section→App→Page) наряду с формами и реестрами. Страница — это floor-2 артефакт (React-компонент над named-binding контрактом) или floor-1 (декларативная агрегация). Системный config-агент авторит страницу в DRAFT; человек (администратор/IT-директор клиента) промоутит в published.

Ключевое расширение — **реестр зависимостей `report_page_dep`**: tenant-таблица, фиксирующая, от каких полей (`field_key`) какой `registry_def.record_schema` зависит данная страница. При изменении поля схемы:
- **«мягкое» изменение** (rename label, add optional field) → **предупреждение** в UI и в семантическом changelog (via T-0084);
- **деструктивное изменение** (drop field, type-narrowing, rename field-key) → **блокирующая ошибка** через bundle-coherence CI-гард (расширение T-0082) и human-gate при promote.

Tenant-изоляция распространяется на все таблицы. Единый механизм прав — grant-алгебра T-0018. Аудит — единый T-0016 append-only sink.

Это **дизайн-задача**: выход фазы — спека требований, которые обязан покрыть будущий ADR (`docs/design/T-0121-reports-pages.adr.md`). Acceptance-критерии — проверяемые свойства будущего ADR и, после реализации, кода.

---

## 2. Зона фаундера vs зона дизайна

### Зафиксировано фаундером (не пересматривать)

| Решение | Источник |
|---|---|
| Отчёт = кастомная UI-страница (two-floor) | gap-map §3а; extensibility-ADR §4 |
| Страница генерируется «по описанию» (config-агент авторит в DRAFT) | gap-map §3а; extensibility-ADR §4 + §8 |
| Страница живёт «в разделе» (Section→App→Page навигация) | extensibility-ADR §5; gap-map §3а |
| Обязательный реестр зависимостей страницы от полей схемы | gap-map §3а (явная формулировка «обязательное расширение») |
| Предупреждение при изменении данных | gap-map §3а |
| Red-line на деструктивное изменение (расширение bundle-coherence) | gap-map §3а |

### Зона дизайна (ADR решает)

| Вопрос | Почему зона дизайна |
|---|---|
| Модель `report_page_dep`: статический анализ кода vs ручная декларация vs гибрид | gap-map §3а говорит «реестр», не «как наполняется»; у T-0072 аналог — ручная декларация (`form_binding.fields`); ADR выбирает |
| Семантика предупреждения: на published-изменении или на draft-изменении | не зафиксировано фаундером; ADR обязан определить момент генерации предупреждения |
| Граница «деструктивного» изменения (точный машинный критерий) | extensibility-ADR §4 даёт RED-LINES список (drop/rename field-key, lossy type-change) — ADR T-0121 применяет его к field-dep, уточняет что именно «деструктивно» для отчётной страницы |
| Каким grant-операцией управляется `report_page_dep` (author vs promote) | ADR определяет конкретные scope-строки в grant-алгебре T-0018 |
| Floor-1 vs Floor-2 для отчётных страниц: какой тип страницы доступен day-1 | extensibility-ADR §11 рекомендует Floor-1 day-1; ADR T-0121 может уточнить с учётом агрегационной природы отчётов |
| Миграционные слоты (`report_page`, `report_page_dep`) | DESIGN бронирует номера ≥ 046 |
| MCP-tool name (`author_report_page`) и его контракт в agent_card | ADR определяет точный интерфейс |
| Tenant UI — где именно страница в навигации Section→App→Page | DESIGN выбирает конкретный NAV-slot |

---

## 3. Функциональные требования к дизайну (ADR обязан покрыть)

### FR-1 — Модель «отчёт = UI-страница»: Floor-1/Floor-2 разделение

ADR обязан определить:

1. **Артефакт `report_page`** — tenant-таблица с полным T-0013-контрактом, хранящая метаданные страницы: `tenant_id`, `id`, `app_id` (FK→`application`), `slug` (URL-safe имя, UNIQUE per tenant+app), `title`, `floor` (`'1'|'2'`), `tier` (`'draft'|'published'`, по T-0087), `bundle_ref` (ссылка на версию связки bundle, nullable пока git-под-капотом не реализован — дефолт `null`, explicit deferral по T-0082), `created_at`, `updated_at`.
2. **Код/конфиг страницы** — отдельно от метаданных: для Floor-1 — JSON Schema агрегата (`page_schema jsonb`), живущая в той же строке или в отдельной таблице `report_page_def` (выбор DESIGN); для Floor-2 — React-компонент (`page_code text`), аналогично. ADR фиксирует: **бинарь/компилированный бандл** в Postgres не хранится; для Floor-2 — сырой TSX/JS, компилируется на лету или в deploy-шаге.
3. **Floor разделение (кто пишет, где живёт код/бандл):** ADR обязан определить машинно-проверяемую границу:
   - **Floor-1**: декларативная JSON Schema агрегата (список метрик/полей с агрегационными функциями: count/sum/avg/list по полям из `record_schema`); редактируется кнопочно администратором без LLM; zero-LLM, детерминированно, переживает агента-офлайн. Дефолтная поверхность.
   - **Floor-2**: React-компонент, считывающий данные через авторизованный RLS-gated API-эндпоинт; авторит config-агент в DRAFT; promote — human-gated. Floor-2 код **не читает record-данные напрямую** — только через авторизованный серверный эндпоинт (тот же RLS-канал, что extensibility §6).
   - Граница: если агрегат выразим через Floor-1 JSON Schema — Floor-1 обязателен (ADR запрещает эмиссию Floor-2 компонента для тривиальных агрегаций). ADR фиксирует точное машинное правило (аналог extensibility §9.2).
4. **Расположение страницы в навигации:** Section→App→Page (extensibility §5); `page` — третий уровень иерархии; ADR фиксирует, как `report_page` связывается с `application` (FK) и как отображается в left-sidebar.

### FR-2 — Реестр зависимостей `report_page_dep` (ключевое расширение)

ADR обязан определить:

- **Tenant-таблица `choros.report_page_dep`** (полный T-0013-контракт): одна строка = зависимость одной страницы на одно поле одной схемы. Поля: `tenant_id`, `id`, `page_id` (FK→`report_page`), `registry_def_id` (FK→`registry_def`), `field_key` (text — ключ поля в `registry_def.record_schema`), `dep_kind` (`'read'` — страница читает поле, `'aggregate'` — страница агрегирует по полю; vocab закрытый, расширяем), `created_at`.
- **Способ наполнения реестра** — ADR обязан выбрать один из вариантов и обосновать (зона дизайна):
  - (а) **Ручная декларация** (аналог `form_binding.fields`): автор страницы (config-агент или администратор) явно объявляет зависимости при создании/редактировании страницы; API `POST /report-pages/:id/deps` с массивом `[{registry_def_id, field_key, dep_kind}]`; upsert.
  - (б) **Статический анализ**: для Floor-2 — парсер React-кода извлекает обращения к API-эндпоинтам и выводит field-ключи; для Floor-1 — синтаксический разбор JSON Schema агрегата. Сложнее, но не требует ручного труда.
  - (в) **Гибрид**: Floor-1 — автоматически (схема агрегата = декларация зависимостей); Floor-2 — ручная декларация (аналог best-effort EL-парсера в T-0072 NF-5 — приемлемы ложные отрицания; ложные срабатывания — нет).
  - ADR обязан зафиксировать способ наполнения явно (не «на усмотрение кодера»).
- **Валидация при регистрации dep**: `field_key` обязан присутствовать в актуальном `registry_def.record_schema` того же tenant на момент регистрации; несуществующий field_key = ошибка регистрации (не тихий accept). ADR фиксирует: функция валидации `checkReportPageDepFields(page_deps, record_schema): DepCompatResult` — чистая, аналог `checkBindingCompat` (T-0072 FR-3), экспортируется из `src/core/report-page-compat.ts`.

### FR-3 — Предупреждение при изменении поля схемы («мягкое» изменение)

ADR обязан определить:

1. **Триггер предупреждения**: изменение `registry_def.record_schema` через API (PUT/PATCH эндпоинт) — сервер проверяет, есть ли активные `report_page_dep` ссылающиеся на изменяемые поля. ADR фиксирует: **кто видит предупреждение** (вызывающий API-клиент — администратор/config-агент) и **когда**: при изменении опубликованной (`tier='published'`) схемы регистрируется предупреждение.
2. **Форма предупреждения**: семантическое сообщение «поле X изменено, от него зависят страницы: [список slug]; проверьте отчёты». Не техническое (не «field_key mismatch»). Аналог extensibility §4 RED-LINES: «семантическое предупреждение, не техническое».
3. **Предупреждение не блокирует**: «мягкое» изменение (relabel, add optional field, add new field) НЕ блокирует операцию — возвращает предупреждение в ответе (`warnings: [...]`), изменение применяется.
4. **Перечень «мягких» vs «деструктивных» изменений** — ADR обязан зафиксировать классификацию (зона дизайна, см. FR-4).
5. **Связь с T-0084 (changelog/diff)**: при семантическом changelog изменения схемы список затронутых отчётных страниц обязан войти в changelog-payload (контракт T-0084, ADR T-0121 документирует его как требование к T-0084).

### FR-4 — Red-line на деструктивное изменение (расширение bundle-coherence)

ADR обязан определить:

1. **Критерий «деструктивного» изменения поля схемы** применительно к `report_page_dep`:
   - Удаление `field_key` из `record_schema` при наличии активного `report_page_dep` с этим ключом.
   - Переименование `field_key` (remove + add с другим ключом) — эквивалентно удалению для зависимых страниц.
   - Сужение типа (type-narrowing: `number` → `integer`, `string` → `enum` с меньшим vocab) при наличии `dep_kind='aggregate'` — ADR обязан решить, является ли это деструктивным.
   - ADR **не обязан** трактовать как деструктивное: добавление нового поля, расширение enum, relabeling (только UI-отображение), изменение `required`-флага поля.
2. **Механизм блокировки**:
   - **CI-гард (расширение bundle-coherence.sh, T-0082)**: `bundle-coherence.sh` получает новую проверку — `check-report-page-deps`: для каждой строки `report_page_dep` с `dep_kind='read'|'aggregate'` проверяет, что `field_key` присутствует в актуальной `registry_def.record_schema`. Несуществующий dep → `exit 1` (CI fail).
   - **Runtime API-блок**: попытка деструктивного изменения `record_schema` через API, при наличии активных `report_page_dep` → ответ `409 Conflict` с телом `{ error: "destructive_schema_change", affected_pages: [...], fields: [...] }`. Изменение НЕ применяется. Это `default-DENY на необратимость` (extensibility §4/§9.7).
   - **Human-gate при promote**: если страница находится в `tier='draft'` и её `report_page_dep` содержат несуществующий field_key (схема уже изменилась) — promote в `published` заблокирован, пока зависимости не исправлены или не удалены.
3. **ADR фиксирует обходной путь** (escape-hatch): деструктивное изменение схемы **при явном human-confirm** (`force: true` флаг + требование явной роли `mgmt_object:schema_destructive`/`operation:apply`): изменение применяется, `report_page_dep` для затронутых страниц помечается `stale=true`; страницы переводятся в `tier='draft'` (депромоут). Аудит-событие T-0016 пишется с меткой `destructive`.
4. **bundle_members.txt расширение**: `report_page_dep` добавляется в `bundle_members.txt` как `kind=choros_table` (задача T-0121-impl обязана это сделать); `bundle-coherence.sh` включает check-report-page-deps.

### FR-5 — Права на страницы (единый механизм прав)

ADR обязан определить:

- **Просмотр страницы** (`report_page`): субъект обязан иметь grant `read` на `application` (или конкретно на `report_page`-ресурс — ADR выбирает granularity); через PDP T-0021; fail-closed. ADR **не вводит** второй механизм видимости страниц.
- **Авторинг страницы** (создание/редактирование в DRAFT): grant `mgmt_object:report_page`/`operation:author` — только для config-агента (роль → MCP-tool) и администратора. Аналог T-0077 config-agent discipline.
- **Promote в published**: grant `mgmt_object:report_page`/`operation:promote`; только человек (не агент self-promote); human-gate (extensibility §4 ось B).
- **Управление `report_page_dep`**: grant `mgmt_object:report_page`/`operation:author` (те же права, что авторинг страницы); редактирование зависимостей автоматически требует того же уровня доступа.
- **Деструктивное изменение схемы с force**: grant `mgmt_object:schema_destructive`/`operation:apply` — admin-only, отдельная операция, требующая явного confirm.

ADR **не вводит** новых scope-строк за пределами существующей grant-алгебры (T-0018). Все grant — через единый PDP T-0021 (FF-R6).

### FR-6 — Tenant-изоляция

ADR обязан определить:

- Все tenant-таблицы (`report_page`, `report_page_dep`) — полный T-0013-контракт: `tenant_id`-leading PK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)::uuid`, DML только `choros_app`, занесены в `ci/checks/known_tenant_tables.txt`.
- API-эндпоинты — tenant-scoped, fail-closed по tenant-контексту; нет cross-tenant доступа к страницам или зависимостям.
- Floor-2 код страницы читает record-данные только через авторизованный RLS-gated серверный канал (extensibility §6); Floor-2 код не имеет прямого DB-доступа.

### FR-7 — Аудит

ADR обязан определить:

- Аудит-события (T-0016) для: создание/обновление/удаление `report_page` (actor, app_id, slug, tier_change); promote `draft`→`published`; регистрация/обновление/удаление `report_page_dep`; деструктивное изменение схемы с force (включает список affected_pages).
- ADR **не создаёт** второй audit-sink; единственный canonical `appendAuditEvent` (T-0016).

### FR-8 — MCP-tool для config-агента

ADR обязан определить:

- Новый MCP-tool `author_report_page` в `choros.mcp_tool` (seed): input-schema `{app_id, slug, title, floor, page_def}`, назначение — создать или обновить `report_page` в `tier='draft'` + зарегистрировать/обновить `report_page_dep`. Config-агент вызывает только этот tool; прямого SQL-доступа нет.
- Tool `promote_report_page` (или переиспользование существующего promote-tool T-0087): promote `draft`→`published`; вызывается только человеком через UI (не агентом напрямую).
- ADR фиксирует: `author_report_page` = DRAFT-only операция; промоутить агент не может (extensibility §4 §8 governance).

### FR-9 — Миграционные слоты

ADR обязан зафиксировать номера миграций SQL-файлов для новых tenant-таблиц: **≥ 046** (T-0072 занял 045; T-0082 не добавляет миграций; следующие свободные — 046+; ADR T-0121 бронирует слоты, не выполняет DDL — DDL создаёт coder-фаза).

---

## 4. Нефункциональные требования

### NF-1 — Один механизм согласованности «артефакт → поля схемы»
ADR T-0121 расширяет паттерн T-0072 (`checkBindingCompat` → `checkReportPageDepFields`), не вводит третий отдельный механизм. Функция `checkReportPageDepFields` — чистая (no I/O), экспортируется из `src/core/report-page-compat.ts`, симметрична `binding-compat.ts`.

### NF-2 — Tenant-изоляция (инвариант tenancy, non-negotiable)
`report_page` и `report_page_dep` под FORCE RLS; cross-tenant доступ к страницам структурно невозможен. Один cross-tenant leak страницы = смерть GTM.

### NF-3 — Default-DENY на деструктивное изменение схемы
Деструктивное изменение `record_schema` при наличии зависимых отчётных страниц блокируется по умолчанию (API 409 + CI fail); обход требует явного human-confirm с отдельным grant. Симметрично extensibility §4 и tenancy RLS default-DENY.

### NF-4 — Floor-2 код не является SPOF для Floor-1 страниц
Floor-1 страницы (декларативный агрегат) переживают LLM-офлайн; рендер — детерминированный server-side; без зависимости от агента-авторства.

### NF-5 — bundle-coherence.sh проходит после T-0121-impl
Задача T-0121-impl обязана: (а) добавить `report_page_dep` в `bundle_members.txt`; (б) добавить `check-report-page-deps` в `bundle-coherence.sh`; (в) пройти `bundle-coherence.sh` после merge. Это DoD T-0121-impl (аналог T-0082 deferral contract FR-7).

### NF-6 — Zero new npm production dependencies для core-модуля
`report-page-compat.ts` — pure TS, no I/O. Floor-2 runtime может использовать существующие React/Vite зависимости (уже в проекте); новых внешних npm-зависимостей для ядра нет.

### NF-7 — Аудит переживает удаление страницы
Удаление `report_page` (депромоут + delete) не стирает аудит-след о её жизненном цикле (T-0016 append-only). Аналог T-0119 NF-5.

### NF-8 — Предупреждение машинно-читаемо
Предупреждение о зависимых страницах при изменении схемы возвращается в API-ответе как структурированный массив `warnings: [{page_slug, registry_def_id, field_key}]`, не только как текст. Потребляется T-0084 changelog.

---

## 5. Out of Scope (явные не-цели T-0121)

1. **Реализация (DDL/код/React-компоненты):** T-0121 — дизайн-задача; ADR + DDL + TS-код + React-страницы — следующие фазы; миграции бронируются, не создаются.
2. **Полный Floor-2 git-под-капотом бандл:** table `report_page` бронирует поле `bundle_ref`; полная git-машинерия — инкрементально (extensibility §11 секвенирование).
3. **UI редактора страниц (Floor-1 кнопочный):** REST API проектируется; UI-компоненты — задачи зоны 7.
4. **Статический анализ Floor-2 React-кода** для автоизвлечения field-deps: если ADR выбирает вариант (а) ручная декларация или (в) гибрид — статический анализ Floor-2 = Stage-2.
5. **Дашборд руководителя как конкретный шаблон:** T-0121 проектирует **механизм**, не конкретные отчёты (gap-map §4б инвариант дизайн-инварианта 5: аналог T-0133).
6. **SLA-dashboard (T-0095/E7):** страницы SLA-отчётности создаются поверх механизма T-0121 как конкретные экземпляры; T-0121 проектирует только механизм.
7. **Второй permission-механизм:** видимость страниц = grant-алгебра T-0018 без исключений.
8. **Pooled-режим:** дефолт — silo; T-0013-контракт закладывается без pooled.
9. **LLM-генерация тела отчётов / «вопрос-ответ по данным»:** агент авторит структуру страницы, не сам отвечает на запросы в runtime; LLM-runtime для query-time = Stage-2.
10. **Публичный (без аутентификации) доступ к отчётным страницам:** вне scope; внешняя поверхность (T-0122) — отдельная задача.

---

## 6. Acceptance Criteria

Критерии — **проверяемые свойства будущего ADR** (`fitness`) либо **test после реализации** (`test`), либо **ревью-гейт** (`manual`).

| ID | Text | Verifiable as |
|---|---|---|
| **AC-1** | ADR определяет tenant-таблицу `choros.report_page` с полным T-0013-контрактом (`tenant_id`-leading PK, FORCE RLS, default-DENY, choros_app, known_tenant_tables.txt); поля: `id`, `app_id`, `slug`, `title`, `floor ('1'\|'2')`, `tier ('draft'\|'published')`, `bundle_ref` (nullable), `created_at`, `updated_at`; UNIQUE(tenant_id, app_id, slug). | fitness |
| **AC-2** | ADR определяет tenant-таблицу `choros.report_page_dep` с полным T-0013-контрактом; поля: `id`, `page_id` (FK→report_page), `registry_def_id` (FK→registry_def), `field_key`, `dep_kind ('read'\|'aggregate')`, `stale` (boolean default false), `created_at`; UNIQUE(tenant_id, page_id, registry_def_id, field_key). | fitness |
| **AC-3** | ADR определяет машинно-проверяемую границу Floor-1 ↔ Floor-2: явное правило «какая страница обязательно Floor-1 (декларативный агрегат), когда допустим Floor-2 (React-компонент)»; граница не «на вкус агента». | fitness |
| **AC-4** | ADR экспортирует из `src/core/report-page-compat.ts` чистую функцию `checkReportPageDepFields(deps: PageDep[], recordSchema: JsonSchema): DepCompatResult` — аналог `checkBindingCompat` (T-0072); возвращает `{ok:true}` или `{ok:false; violations: DepViolation[]}`; ADR явно ссылается на T-0072 как прецедент, не изобретает второй механизм. | fitness |
| **AC-5** | ADR определяет валидацию при регистрации dep: `field_key` обязан существовать в актуальном `registry_def.record_schema`; несуществующий field_key = ошибка 422 (не тихий accept). | fitness |
| **AC-6** | ADR определяет предупреждение при «мягком» изменении схемы: API PUT/PATCH `record_schema` с полями, от которых есть активные deps, возвращает `warnings: [{page_slug, field_key}]`; операция применяется; список затронутых страниц машинно-читаем. | fitness |
| **AC-7** | ADR определяет классификацию деструктивных изменений (минимум: drop field_key, rename field_key при наличии dep) и механизм блокировки: API 409 `destructive_schema_change` при попытке без force; `bundle-coherence.sh` fail при stale dep в CI. | fitness |
| **AC-8** | ADR определяет escape-hatch: деструктивное изменение с `force:true` + grant `mgmt_object:schema_destructive/apply` → изменение применяется, затронутые deps помечаются `stale=true`, страницы депромоутируются в `tier='draft'`, пишется audit_event с меткой `destructive`. | fitness |
| **AC-9** | ADR определяет human-gate на promote: `report_page` с `dep.stale=true` не промоутируется в `published` без исправления или удаления stale-депедансов. | fitness |
| **AC-10** | ADR фиксирует расширение `bundle-coherence.sh` (T-0082): новая проверка `check-report-page-deps` — для каждого `report_page_dep` `field_key` существует в `registry_def.record_schema`; несуществующий dep → CI exit 1; ADR фиксирует обязательство T-0121-impl обновить `bundle_members.txt`. | fitness |
| **AC-11** | ADR определяет Floor-2 код страницы: читает record-данные только через авторизованный RLS-gated серверный API-эндпоинт; прямой DB-доступ из Floor-2 React-кода структурно невозможен (нет DB-credentials в клиентском бандле). | fitness |
| **AC-12** | ADR определяет права: просмотр, авторинг (DRAFT), promote (human-only), управление deps — через grant-алгебру T-0018; PDP T-0021; нет второго permission-механизма (FF-R6). Новый MCP-tool `author_report_page` зафиксирован как DRAFT-only операция агента. | fitness |
| **AC-13** | ADR определяет аудит-события (T-0016) для: create/update/delete report_page; tier_change (promote/demote); register/update/delete report_page_dep; destructive schema-change с force. Единственный canonical appendAuditEvent. | fitness |
| **AC-14** | ADR фиксирует миграционные слоты ≥ 046 для `report_page` и `report_page_dep`; DDL не выполняется в DESIGN-фазе. | fitness |
| **AC-15** | Post-impl: пользователь без grant `read` на application не видит связанных report_page; `GET /api/report-pages` fail-closed по tenant-контексту; tenant B не видит report_page tenant A. | test |
| **AC-16** | Post-impl: попытка деструктивного изменения `record_schema` (drop поля, от которого есть dep) без force → API 409; изменение не применяется; `record_schema` неизменна. | test |
| **AC-17** | Post-impl: попытка promote `report_page` с `dep.stale=true` → API 409; страница остаётся в `tier='draft'`. | test |
| **AC-18** | Post-impl: `checkReportPageDepFields(deps, schema)` — если `field_key` отсутствует в `schema.properties` → `{ok:false, violations:[{type:'missing_in_schema', field_key}]}`; если все поля присутствуют → `{ok:true}`. | test |
| **AC-19** | Post-impl: деструктивное изменение с force → deps помечены `stale=true`, затронутые страницы в `tier='draft'`, audit_event содержит `action='schema_destructive_force'` с полями affected_pages. | test |
| **AC-20** | ADR трассируется к gap-map §3а: каждое FR-1..FR-9 покрыто ≥1 решением ADR; ни одно решение не вводит второго permission-механизма, второго coherence-механизма, не противоречит T-0072/T-0082/extensibility-инвариантам; ревью-гейт архитектора. | manual |
| **AC-21** | ADR явно фиксирует связь с T-0084: предупреждение о зависимых страницах входит в changelog-payload семантического changelog; ADR T-0121 документирует это как контрактное требование к T-0084. | fitness |
| **AC-22** | ADR фиксирует: `checkReportPageDepFields` — pure function (no I/O, no DB, no network); аналог T-0072 NF-2; проверяется jest-тестом на отсутствие I/O-импортов. | fitness |

---

## 7. Снятые неоднозначности

**Зафиксировано фаундером (gap-map §3а) — не поднимать заново:**
- Отчёт = кастомная UI-страница (two-floor) — данность.
- Страница генерируется config-агентом в DRAFT, промоутируется человеком — данность.
- Реестр зависимостей страницы от полей схемы — обязателен.
- Предупреждение при изменении данных — обязательно.
- Red-line на деструктивное изменение (расширение bundle-coherence) — обязателен.

**Резолюции по существующей модели (не эскалация):**
- **Один механизм согласованности**: `checkReportPageDepFields` расширяет паттерн `checkBindingCompat` (T-0072) — принято; ADR ссылается, не изобретает.
- **bundle_members.txt расширение**: добавление `report_page_dep` в реестр — DoD T-0121-impl; DESIGN фиксирует обязательство.
- **Floor-1 как дефолт**: extensibility §11 рекомендует Floor-1 day-1; для отчётов Floor-1 = декларативный агрегат; Floor-2 = кастомный React; ADR обязан зафиксировать границу.
- **Деструктивное изменение с force**: escape-hatch нужен (невозможно полностью заблокировать evolving схему); принцип — явный audit-след + депромоут страниц; принято по аналогии extensibility §4 escape-hatch.

**BLOCKING questions:** нет. Решение фаундера по two-floor + реестру зависимостей + предупреждению + red-line закрывает объём. Связи с T-0072/T-0082 — внутри зоны DESIGN и не меняют продуктовый объём. Статус спеки = `ready`.
