# ADR T-0581 — Реестр представлений (view registry) + список как настраиваемый блок

> Фаза DESIGN (architect). Вход: `docs/specs/T-0581.spec.contract.json` (status ready).
> Столп 2. Кейс-доказательство К1 (CRM «список сделок под себя»). Реализацию пишет `coder`;
> здесь — механизм, объектная модель, контракты, fitness-функции, трассировка.

## 1. Решение (кратко)

Ввести **новую tenant-scoped сущность `list_view`** — строку реестра представлений: `type`
(открытый enum, v1 `list`; T-0582 добавит `kanban`), привязка к набору полей
(`registry_def`) внутри приложения, `name`, `is_default`, и **JSONB `config`** с
**рантайм-валидацией через диспетчер по `type`**. CRUD — новый модуль `src/http/list-views.ts`
(зеркало `sections.ts`/`report-pages.ts`: `withTenantTx` + RLS + audit + honest-degrade без БД).
**Применение** представления к списку идёт **тем же путём `GET /api/records`**, который уже
несёт RLS + sandbox-gate + READ-PDP (`isRecordReadable`) + field-visibility: добавляем
опциональные параметры (`?view_id=` ИЛИ инлайн `?filter=&sort=`), из которых чистый транслятор
(`src/core/view-query.ts`) собирает **параметризованный** `WHERE data->>… / ORDER BY data->>…`
на скалярных JSONB-путях; курсор-пагинация и in-memory READ-PDP-фильтр остаются как есть.
Автоген-список сегодня = **синтетический default-view** (когда сохранённых нет). Новый прямой
SQL-путь к `choros.record` мимо PDP **не создаётся**.

Механизм соразмерен (ось 5): одна tenant-таблица по проверенному шаблону `report_page`, один
чистый транслятор-ядро, переиспользование всего data-слоя, PDP и курсор-пагинации. Реестр — не
самоцель, а **несущий фундамент**: T-0582 (канбан) и будущие «страницы из блоков» вешаются на
`list_view.type`, не плодя параллельных таблиц.

## 2. Отвергнутые альтернативы

- **Колонка `views jsonb` на `registry_def`** (как `form_binding.layout`, migration 105) —
  отвергнуто: представлений на набор полей МНОГО (именованные, с `is_default`), их создают/
  удаляют/переименовывают независимо; массив-в-колонке даёт гонки на конкурентных правках и не
  даёт per-view RLS/аудит/уникальность имени. Отдельная сущность — правильный примитив (как
  `section` реверснул `application.section`-строку в сущность, migration 113).
- **Клиентская фильтрация/сортировка** (грузим всё, режем в браузере) — отвергнуто: ломает
  курсор-пагинацию и бюджет строк (MAX_PAGE_SIZE=200), не масштабируется, и что важнее — обходит
  смысл «сервер фильтрует» из рамок задачи. Сервер обязан фильтровать до пагинации.
- **Новый эндпоинт `GET /api/list-views/:id/records`** с собственным SELECT — отвергнуто:
  дублировал бы весь стек records.ts (RLS + sandbox + READ-PDP + field-visibility + курсор +
  derived-fields) и стал бы вторым, дрейфующим READ-путём мимо PDP (нарушение FR-7, «шов —
  ничей» из карты §4.3). Применение представления — параметры существующего `GET /api/records`.
- **Материализованные представления / генерация индексов на JSONB-поля** — отвергнуто как
  преждевременная оптимизация (PD-20: команды ~300 чел, сотни записей на список; seq-scan по
  JSONB приемлем). Индексы — additive-позже, если профиль покажет нужду (не в этой задаче).
- **`config`-валидация через CHECK-констрейнт в БД** — отвергнуто: валидатор должен быть
  диспетчером по `type` с богатыми, типо-зависимыми правилами (операторы по типу поля,
  серверно-сортируемость), сверяться с `record_schema` (которого БД-констрейнт не видит) и
  давать человекочитаемую 400-ошибку. Валидация — в TS-ядре (`src/core/view-config.ts`), в БД
  остаётся минимальный `CHECK (jsonb_typeof(config)='object')`.
- **Per-user приватные представления в v1** — отвергнуто (spec §6): не соответствует модели прав
  (конфигурация приложения — общая для тенанта), раздувает объём; добавляется поверх той же
  таблицы позже (nullable `owner_actor`).

## 3. Объектная модель

### 3.1 Сущность `list_view` (миграция — следующий свободный слот, ориентир 123)

Таблица `choros.list_view` — tenant-таблица по шаблону `report_page` (051)/`section` (113):
`tenant_id`-leading PK, ENABLE+FORCE RLS, default-DENY policy на
`current_setting('choros.tenant_id', true)::uuid`, GRANT для `choros_app`, регистрация в
`ci/checks/known_tenant_tables.txt`.

| Поле | Тип | Заметки |
|------|-----|---------|
| `tenant_id` | uuid NOT NULL | scope; ведёт PK; резолвится из актора, не из тела |
| `id` | uuid NOT NULL | server-generated |
| `registry_def_id` | uuid NOT NULL | владелец-набор полей; составной FK (tenant_id, registry_def_id) → registry_def(tenant_id, id), ON DELETE CASCADE (представление без набора бессмысленно) |
| `application_id` | uuid NOT NULL | денормализованный владелец-приложение (для быстрого «представления приложения»); составной FK → application; согласован с registry_def.application_id |
| `type` | text NOT NULL DEFAULT 'list' | ОТКРЫТЫЙ дискриминатор вида; v1 принимается только 'list' (валидатором, НЕ CHECK-констрейнтом — чтобы T-0582 добавил 'kanban' без миграции DDL) |
| `name` | text NOT NULL | отображаемое имя представления (данные тенанта, не константа) |
| `is_default` | boolean NOT NULL DEFAULT false | ровно одно true на (tenant, registry_def_id) — частичный UNIQUE-индекс |
| `config` | jsonb NOT NULL | конфиг вида (см. 3.2); CHECK jsonb_typeof='object'; семантика валидируется в TS |
| `created_at` | bigint NOT NULL | epoch ms, серверные часы |
| `updated_at` | bigint NOT NULL | epoch ms |
| `created_by` | text NOT NULL | actor slug |

Констрейнты:
- `PRIMARY KEY (tenant_id, id)`
- `UNIQUE (tenant_id, registry_def_id, name)` — одно имя на набор полей в тенанте (нет дублей).
- `CONSTRAINT list_view_registry_fk FOREIGN KEY (tenant_id, registry_def_id) REFERENCES
  choros.registry_def(tenant_id, id) ON DELETE CASCADE`.
- `CONSTRAINT list_view_app_fk FOREIGN KEY (tenant_id, application_id) REFERENCES
  choros.application(tenant_id, id)` (без ON DELETE — registry_def CASCADE снимет строки раньше).
- Частичный уникальный индекс `list_view_one_default ON choros.list_view (tenant_id,
  registry_def_id) WHERE is_default` — гарантирует ≤1 default на набор полей (AC-10).
- `CONSTRAINT list_view_config_obj CHECK (jsonb_typeof(config) = 'object')`.

> Заметка о нумерации миграции (известная грабля памяти «migration-№ перенумеровать при
> мерже»): T-0579/T-0580 идут параллельно и тоже могут занять 123. Берём **123**; при мерже
> конфликт нумерации разруливается перенумерацией слота, DDL идемпотентна
> (`CREATE TABLE IF NOT EXISTS`, DO-guard на policy/constraint) — безопасно.

### 3.2 Форма `config` (v1, `type='list'`) — контракт данных

```jsonc
{
  "columns": [                     // порядок массива = порядок колонок слева-направо
    { "field_key": "amount", "visible": true,  "width": 160 },   // width опционален (px или доля 0..1)
    { "field_key": "status", "visible": true },
    { "field_key": "notes",  "visible": false },                  // скрыта
    { "field_key": "created_at", "visible": true }                // системная псевдо-колонка
  ],
  "filters": [                     // AND-соединение (v1)
    { "field_key": "status", "op": "in",  "value": ["open", "won"] },
    { "field_key": "amount", "op": "gte", "value": 100000 }
  ],
  "sort": [                        // многоключевой ORDER BY
    { "field_key": "amount", "dir": "desc" },
    { "field_key": "created_at", "dir": "desc" }
  ]
}
```

**Расширяемость под kanban (FR-11):** для `type='kanban'` config получит СВОЙ вид (напр.
`{ "group_by": "<select_field_key>", "columns_order": [...], "card": {...}, "filters": [...],
"sort": [...] }`). Валидатор — **диспетчер по `type`** (`validateViewConfig(type, config,
recordSchema)`), поэтому добавление kanban = новая ветка диспетчера + новый валидатор вида, БЕЗ
изменения таблицы, CRUD-роутов и общего контракта. `filters`/`sort` намеренно вынесены в общие
структуры, переиспользуемые обоими видами.

### 3.3 Синтетический default-view (не строка БД)

Когда у набора полей нет сохранённых `list_view` (или клиент не передал `view_id`), сервер и
клиент используют **производный** default: `columns` = все поля в порядке `x-field-order` +
`created_at`, все `visible:true`; `filters=[]`; `sort=[{created_at, desc}]`. Это чистая функция
`defaultViewConfig(recordSchema)` в `src/core/view-config.ts` — **байт-эквивалент** сегодняшнему
поведению (NF-2). Строки БД он не создаёт.

### 3.4 Типы полей → JSON-тип хранения → операторы/сортируемость (ядро транслятора)

Тип поля берётся из `record_schema` (JSON-Schema `type` + `x-*`-аннотации, см.
`apps-schema.js`). Таблица управляет и валидатором операторов (FR-5), и серверной
сортируемостью (FR-6):

| Тип поля | JSON-хранение | Операторы фильтра (v1) | Серверно-сортируем |
|----------|---------------|------------------------|--------------------|
| string / url / email | string | eq,neq,contains,starts_with,is_empty,is_not_empty | да (текст) |
| number / integer / money | number | eq,neq,gt,gte,lt,lte,between,is_empty,is_not_empty | да (числовой каст) |
| date | string (ISO) | eq,before,after,between,is_empty,is_not_empty | да (лексикографически = хронологически для ISO) |
| boolean | boolean | is_true,is_false,is_empty | да |
| select | string | eq,neq,in,is_empty,is_not_empty | да |
| multi-select | array | contains_any,contains_all,is_empty,is_not_empty | нет |
| person / relation | string (id) | eq,neq,is_empty,is_not_empty | нет (id не осмысленный порядок) |
| computed | не хранится | — (отклоняется) | нет |
| collection | array объектов | — (отклоняется) | нет |
| created_at (псевдо) | bigint (колонка record) | eq,gt,gte,lt,lte,between | да (нативная колонка) |

## 4. Контракты API

Новый модуль `src/http/list-views.ts`, `registerListViewRoutes(router, deps?)` (зеркало
`registerSectionRoutes`; при отсутствии `pool` роуты не регистрируются — honest-degrade).
`deps = { pool, resolveActorTenant, resolveActorPrivilege? }`. Все под `withAuth`, tenant
резолвится из актора (`resolveActorTenant`), запись/мутация — привилегия конфигуратора
(owner/admin | authoring_draft через `resolveActorPrivilege`, как DELETE /api/records).

```
GET    /api/list-views?registry_def_id=<uuid>[&application_id=<uuid>]
         → 200 { views: [ { id, registry_def_id, application_id, type, name, is_default,
                            config, created_at, updated_at } ], default_view: <config> }
         (default_view — синтетический default для набора; views может быть пуст)
POST   /api/list-views  body { registry_def_id, application_id?, type?, name, config, is_default? }
         → 201 { …view }  | 400 VIEW_CONFIG_INVALID (детали) | 404 (набор не в тенанте)
         | 409 CONFLICT (дублирующее имя)
GET    /api/list-views/:id  → 200 { …view } | 404
PUT    /api/list-views/:id  body { name?, config?, is_default? }
         → 200 { …view } | 400 VIEW_CONFIG_INVALID | 404
DELETE /api/list-views/:id  → 204 | 404
```

Применение представления к списку — расширение существующего `GET /api/records` (frozen-контракт
ответа СОХРАНЁН, новые вход-параметры аддитивны):

```
GET /api/records?application_id=&registry_def_id=&limit=&after=
   [&view_id=<uuid>]                       // применить сохранённое представление тенанта
   [&filter=<base64url-json>]              // ИЛИ инлайн-конфиг (filters[])
   [&sort=<base64url-json>]                // ИЛИ инлайн (sort[]); взаимоисключимо с view_id
   → 200 { records, nextCursor, limit }    // контракт БЕЗ ИЗМЕНЕНИЙ (NF-2/AC-9)
```

Семантика применения (в `listRecordsPaginated`, тот же tenant-tx):
1. RLS + `r.tenant_id=$1` (первый обязательный фильтр, NF-3) + sandbox-предикат — как сейчас.
2. **view-WHERE**: `translateFilters(filters, recordSchema)` → массив параметризованных
   предикатов `data->>'k' = $n` / `(data->>'k')::numeric >= $n` / … (только валидные
   поле+оператор; `field_key` из белого списка ключей схемы — NF-6). AND к `conds`.
3. **view-ORDER BY**: `translateSort(sort, recordSchema)` → `ORDER BY data->>'k' [ASC|DESC],
   …, r.id ASC` (только серверно-сортируемые поля; вторичный `r.id` — детерминизм). Если sort
   пуст/дефолтный — прежний `created_at DESC, id ASC` (курсор совместим).
4. Курсор-пагинация — как есть (при кастомной сортировке курсор кодирует
   `(sortKeyValue, id)` — см. §5 риск R-2; v1 допускает keyset по `created_at` и «Показать
   ещё» без стабильного курсора для произвольного sort → деталь реализации coder).
5. READ-PDP `isRecordReadable` in-memory фильтр страницы (FR-7/AC-6) — как сейчас; field-
   visibility redaction — как сейчас.

`translate*` живут в чистом ядре `src/core/view-query.ts` (без pg/http — как
`data-access-port.ts`), возвращают `{ sql, params }`-фрагменты, которые edge-слой вставляет в
уже-параметризованный запрос. **Значения фильтра — только bind-параметры; `field_key` — только
из белого списка** (NF-6/AC-13). Field-visibility и фильтр: транслятор ПОЛУЧАЕТ множество
видимых актору полей и **исключает** предикаты по невидимым полям (условие по redacted-полю не
транслируется → не становится оракулом, FR-8/AC-7). Точную политику («исключить» vs «отклонить
на этапе применения») фиксирует coder; дизайн-инвариант: скрытое поле не влияет на выборку
наблюдаемо.

## 5. Риски / известные ограничения

- **R-1 (наследуется от T-0570): короткие страницы.** READ-PDP фильтрует страницу ПОСЛЕ SQL-
  LIMIT, поэтому страница может вернуть <limit строк — это УЖЕ так сегодня, задача не ухудшает.
  Фильтр представления сужает набор ДО пагинации (в SQL), что скорее уменьшает эффект. Не
  BLOCKING; зафиксировать в тестах (страница может быть неполной — это норма).
- **R-2: keyset-курсор при произвольной сортировке.** Текущий курсор кодирует `(created_at,
  id)`. Кастомный `sort` по `data->>'k'` требует, чтобы курсор кодировал значение сорт-ключа.
  v1-решение (соразмерность): при кастомном sort — либо кодировать `(sortValue, id)` в тот же
  opaque-курсор, либо (минимум) отдавать первую страницу отсортированной и «Показать ещё» по
  offset. Выбор — за coder; дизайн допускает оба, контракт ответа не меняется. НЕ BLOCKING.
- **R-3: сортировка по `data->>'k'` числовых полей лексикографична.** Числа/деньги хранятся как
  JSON number; для корректного порядка сортировать `(data->>'k')::numeric` (каст в ORDER BY по
  типу поля из схемы), даты (ISO-строки) — лексикографически (совпадает с хронологией). Учтено
  в `translateSort` (тип-зависимый каст). Тест на числовую сортировку (10 vs 9) обязателен.
- **R-4: NULL/отсутствующие ключи в JSONB.** `data->>'k'` для отсутствующего ключа = NULL;
  операторы `is_empty`/`is_not_empty` и поведение сравнения на NULL специфицируются в
  трансляторе (NULL не матчит gt/lt — стандартный SQL). Тест на записи без ключа.
- **R-5 (анти-кейс дисциплина):** `type='list'` — платформенное generic-значение (не кейс-
  строка); имена представлений — данные тенанта. Fitness FF-VR-5 сторожит, что в коде нет
  «сделка/стадия/deal/stage» и прочих кейс-констант, и что `type` не захардкожен списком
  case-значений.
- Нет BLOCKING-вопросов к фаундеру; решение по видимости (общие для тенанта) принято analyst по
  существующей модели прав (spec §6), архитектурно совместимо.

## 6. Fitness-функции (машинно-проверяемые границы)

См. `fitness_functions` в `T-0581.adr.contract.json`. Кратко:
- **FF-VR-1** — новый прямой READ-путь к `choros.record` мимо PDP запрещён (grep: единственный
  SELECT из `choros.record` в списке — в `listRecordsPaginated`; фильтр/сортировка не создают
  второго SELECT-модуля).
- **FF-VR-2** — `list_view` зарегистрирована в `known_tenant_tables.txt` и несёт ENABLE+FORCE RLS
  + default-DENY policy (та же проверка, что `cross-tenant-fitness.sh`/`registry-defs-pdp-
  isolation.sh` применяют к tenant-таблицам).
- **FF-VR-3** — динамические ORDER BY/WHERE безопасны: `field_key` не попадает в строку SQL иначе
  как через белый список ключей `record_schema`; значения — только bind-параметры (линтер на
  `view-query.ts`: нет шаблонной интерполяции `field_key` в строку запроса вне whitelisted-мапы).
- **FF-VR-4** — открытость `type` под kanban: `type` — не CHECK-констрейнт значений в DDL;
  валидатор — диспетчер по `type` (проверка формы `validateViewConfig` — switch/map по type, не
  прямой list-хардкод), так что T-0582 добавляет ветку без DDL-миграции.
- **FF-VR-5** — анти-кейс (D-064): denylist «сделка/стадия/deal/stage/CRM» как платформенных
  констант в добавленном коде; agent `anti-case-lock.sh` не растёт (интегрируется в общий гейт).
- **FF-VR-6** — обратная совместимость: `GET /api/records` без view-параметров даёт прежний ответ
  (тест байт-эквивалентности default-пути).
- **FF-UX-VR-7** — панель настройки колонок/фильтров/сортировки проходит UX honest-gate G1–G7
  (`ci/checks/ux/*` / `e2e/journeys/*.ux.journey.ts`): контраст обеих тем, нет мёртвых
  enabled-аффордансов, Empty/Loading/Error, без дев-жаргона (view/registry/JSONB → «представление
  списка»/«колонки»/«фильтр»/«сортировка»), стиль через слой (--chs-*), не хардкод.

## 7. Трассировка (критерий приёмки → место в дизайне)

| AC | Покрыто |
|----|---------|
| AC-1 | §3.1 сущность list_view + §4 POST/GET /api/list-views |
| AC-2 | §3.1 RLS (tenant_id-leading PK, FORCE RLS, default-DENY) + FF-VR-2 |
| AC-3 | §4 применение через GET /api/records + §3.4 транслятор; default-путь §3.3 |
| AC-4 | §3.2/§3.4 диспетчер-валидатор операторов по типу (validateViewConfig) |
| AC-5 | §3.4 таблица «серверно-сортируем» + §4 translateSort отклоняет несортируемые |
| AC-6 | §4 шаг 5: READ-PDP isRecordReadable ПОСЛЕ фильтра (FR-7) + FF-VR-1 |
| AC-7 | §4 field-visibility: предикат по невидимому полю не транслируется (FR-8) |
| AC-8 | §4 шаги 1-5 в одном tenant-tx, O(1) резолюция грантов (наследует T-0570 NF-1) |
| AC-9 | §3.3 default-view + §4 frozen-контракт ответа + FF-VR-6 |
| AC-10 | §3.1 частичный UNIQUE list_view_one_default WHERE is_default |
| AC-11 | §3.2 kanban-расширяемость + FF-VR-4 (открытый type, диспетчер-валидатор) |
| AC-12 | §5 R-5 + FF-VR-5 (анти-кейс denylist, agent lock не растёт) |
| AC-13 | §4 bind-параметры + whitelist field_key + FF-VR-3 (транслятор-линтер) |
| AC-14 | §6 FF-UX-VR-7 (UX honest-gate G1-G7) |
| AC-15 | LIVE_PROOF manual: живой стенд, произвольное приложение, второй актор, READ-PDP |

## 8. Runtime / deploy-таргет

Сервер (тот же dev-стек Choros, `/srv/choros`). Внешних ресурсов НЕ требует: одна additive-
миграция (idempotent) на существующем single-Postgres, новый HTTP-модуль в существующем
сервере. Провижн-гейта фаундера (GT-4) НЕ нужно — деплой в dev через обычный founder-gated
промоушн (не в объёме этой задачи, зона coder/CI).
