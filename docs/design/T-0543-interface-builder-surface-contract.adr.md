# ADR · T-0543 — Конструктор интерфейсов: единый surface-контракт + реестр виджетов

> **status:** ready (выход DESIGN-фазы T-0543; refined 2026-06-29)
> **type:** architecture (дизайн/контракты; impl-код НЕ пишется здесь)
> **spec_ref:** `docs/specs/forms-data-contract-foundation.spec.md` §3.1/§6, `docs/specs/form-document-format.spec.md` §2/§3/§6, `docs/specs/floor-boundary.spec.md` (§3.1/§3.3, `FLOOR1_DOC_NODE_TYPES`), `docs/specs/T-0121-reports-pages-design.spec.md` (FR-1/FR-2), `docs/specs/T-0072-named-binding.spec.md`
> **artifacts:** `docs/design/T-0543-surface-document.schema.json` (JSON Schema v2), `docs/design/T-0543-widget-registry.interface.ts` (типы), `docs/design/T-0543.adr.contract.json` (хэндофф)
> **owns:** эпик E-FORMS (T-0479); дети T-0544 (канвас), T-0545 (AI-emit)
> **граница с:** E16/T-0349 (семантика действий), E-NAV-IA (T-0537/T-0540, дом страниц), T-0021/T-0539 (видимость по грантам), T-0121/report-pages (сведение)

---

## 1. Контекст и проблема

Сегодня в продукте **три раздельных представления одного и того же** — «кастомная UI-поверхность над named-binding контрактом», построенных независимо:

1. **Форма записи / шага** — `form-document` (дерево узлов, привязка `fieldKey`→живая схема), редактор `FormDesigner.jsx`, рендерер `FormDocumentRenderer.jsx`.
2. **Страница отчёта** — `report_page` (two-floor, named-binding, агрегаты/графики; T-0121), свой draft→published в `screen-reports.jsx`.
3. **Запасной** кнопочный `FormBuilder.jsx` (плоский `form_binding.fields`).

Заземление в код (прочитано, не выдумано):

- **Каталог блоков захардкожен в 5 местах:**
  - `PALETTE` (web/src/forms/form-document.js:114) — закрытый объект дескрипторов палитры;
  - `WIDGET_COMPAT` (form-document.js:190) — матрица тип→виджет;
  - `switch (node.type)` в `FormNode` (FormDocumentRenderer.jsx:340) — диспетч рендера 10 узлов;
  - ветки `FieldControl` по `contractKind`/`presentation` (field-renderer.jsx);
  - серверный `binding-contract-catalog.ts` (PD-18), зеркалируемый в клиентском `field-contract.js` (`BINDING_CONTRACT_CATALOG`, 11 kinds).
  - **Новый виджет = синхронная правка в 5 местах** + двух (клиент/сервер) зеркалах. Нет шва расширения.
- **Канвас узкий** (T-0544 решит): drag только корня, превью в аккордеоне, нет undo/мультивыбора.
- **Решение фаундера 2026-06-29:** конструктор собирает **полноценные страницы/дашборды** (несколько источников: своя запись / список других записей / агрегаты / графики), а не только формы; **бот == человек** (AI собирает теми же блоками); нужен **задел под новые виджеты** (расширяемый каталог, не хардкод).

Если строить «страницы/дашборды» отдельно — получим **четвёртый** редактор. Спека T-0121 сама требует «не плодить механизмы» (FR-2: report-page переиспользует named-binding T-0072, не второй механизм). Значит задача — **не новая система, а объединение**: тонкое ядро (один контракт + один реестр), потребляемое всеми драйверами и валидатором.

## 2. Решение (кратко)

**Ввести единый `surface`-контракт (v2, обобщение `form-document` v1) и единый декларативный реестр дескрипторов виджетов, потребляемый ОДНИМ рендерером, ОДНИМ конструктором и ОДНИМ серверным валидатором. Форма записи, форма шага и страница/дашборд (включая сегодняшний `report_page`) — конфигурации ОДНОГО `surface`-документа. Любой строительный блок добавляется ОДНОЙ записью реестра (дескриптор) — без правок `switch(node.type)`, `PALETTE`, `WIDGET_COMPAT` и веток рендера. Named-binding инвариант и two-floor (Floor-1 декларатив / Floor-2 sandbox-код) сохраняются и обобщаются с форм на все поверхности.**

Ядро тонкое: реестр — это `Map<id, WidgetDescriptor>`; рендерер, палитра, инспектор и валидатор спрашивают реестр, а не `switch`. Сегодняшние 10 узлов становятся 10 записями реестра без изменения поведения (поведенческий no-op под fitness-тест round-trip).

## 3. Surface-контракт (обобщение form-document → surface-document)

`form-document` (v1) обобщается до `surface-document` (v2). Форма — частный случай поверхности, привязанной к одной записи.

```jsonc
{
  "schemaVersion": 2,
  "surface": {
    "kind": "record-form" | "step-form" | "page",
    "source":  { "applicationId": "<uuid>", "registryDefId": "<uuid>" }, // контекст записи (record/step-form); page — опционально
    "step":    { "processKey": "...", "step": "..." },                   // ТОЛЬКО step-form
    "slug":    "ops-overview",                                           // ТОЛЬКО page: идентичность standalone-страницы (дом в разделе/нав)
    "title":   "..."
  },
  "root": { "type": "section", "children": [ /* дерево узлов */ ] }
}
```

Полная грамматика узлов — в `T-0543-surface-document.schema.json`.

Инварианты (наследуются из `form-document-format.spec.md` §2/§4, обобщены на все `kind`):

- **Named-binding (R-NB):** data-bound узлы хранят ТОЛЬКО ключ(и) (`fieldKey` / `subKey` / `displayField` / источниковые `columns[]`/`measure`/`groupBy`), НЕ типы/опции. Тип, опции, виджет-совместимость резолвятся из ЖИВОЙ схемы при рендере (анти-snapshot-drift, тот же баг enum→text из D7 §2). Узел не несёт type/options — резолв из живой схемы.
- **Удалённое поле → `broken`** в авторинге (`V-KEY`/`DepViolation`), не молча исчезает (form-document-format §4; T-0121 FR-2(в)).
- **`schemaVersion` гейтит эволюцию.** v1 `form-document` (`{schemaVersion:1, source, step?, root}`) **авто-коэрсится** в v2 `surface{kind:"record-form"|"step-form", source, step?}` без миграции хранилища (обратная совместимость; см. §9 и FF-COERCE-1).

### 3.1 Коэрсия v1 → v2 (обратная совместимость)

`coerceToSurface(doc)` — чистая, детерминированная функция (часть `surface-document.js` impl, не этого ADR):

- v1 `{schemaVersion:1, source, root}` без `step` → `{schemaVersion:2, surface:{kind:"record-form", source}, root}`.
- v1 `{schemaVersion:1, source, step, root}` → `{schemaVersion:2, surface:{kind:"step-form", source, step}, root}`.
- v2-документ → возвращается как есть.
- `root` и дерево узлов байт-стабильны (узлы v1 — подмножество v2). Это **load-bearing** инвариант под FF-COERCE-1: рендерер на коэрснутом v1-документе даёт байт-идентичный DOM прежнему.

## 4. Реестр виджетов (ядро задела)

Заменяем хардкод (`PALETTE` / `WIDGET_COMPAT` / dispatch-`switch` / ветки field-renderer / серверный каталог-как-отдельный-источник) на **один декларативный реестр дескрипторов**. Клиент-рендерер, конструктор (палитра + инспектор) и сервер-валидатор читают **один и тот же** реестр (общий манифест метаданных + клиентское дополнение `render`).

Полный TypeScript-контракт — в `T-0543-widget-registry.interface.ts`. Суть дескриптора:

```ts
interface WidgetDescriptor {
  id: WidgetId;                       // 'section' | 'columns' | ... | 'field' | 'table' | 'list' | 'chart' | 'metric' | 'action' | 'custom'
  class: WidgetClass;                 // 'layout'|'presentational'|'data-bound'|'list'|'viz'|'action'|'custom'
  floor: 1 | 2;                       // 1 = декларативный inline; 2 = sandbox-iframe код-escape
  dataSource: DataSourceKind;         // 'current-record'|'query'|'aggregate'|'none'
  contractKinds?: BindingContractKind[]; // для data-bound: какие binding-contracts принимает (scalar/enum/relation/collection/money/...)
  paletteGroup: string;              // 'Раскладка'|'Данные'|'Списки'|'Аналитика'|'Действия'|'Контент'|'Код'
  icon: string; label: string;
  editorProps: PropDescriptor[];     // что инспектор показывает для узла
  // client-only: единственное место отрисовки этого блока:
  render(node: SurfaceNode, ctx: RenderCtx): unknown;       // ReactNode
  validate?(node: SurfaceNode, ctx: AuthoringCtx): Violation[];
}
```

- **Закрыто по умолчанию (R-CLOSED):** валидатор и рендерер принимают только зарегистрированные `id`; неизвестный блок → typed-rejection / broken-маркер. Нет неявного `default:`-узла.
- **Сервер ↔ клиент (R-MANIFEST):** источник истины — **общий манифест дескрипторов** (метаданные: `id`/`class`/`floor`/`dataSource`/`contractKinds`/`paletteGroup`). `render` и `editorProps` — клиентское дополнение, ключуемое по `id`. Один `id` ⇒ серверная валидация и клиентский рендер согласованы по построению. Серверный `binding-contract-catalog.ts` (PD-18) становится **источником `contractKinds`** для реестра, а не параллельным каталогом — реестр его потребляет.
- **Новый виджет = одна запись реестра** (+ его `render`), без правок dispatch/палитры/матрицы (FF-REG-1).

### 4.1 Классы блоков (стартовый набор = сегодняшние 10 узлов + 4 новых для страниц)

| Класс | Блоки (`id`) | dataSource | Floor | Источник |
|---|---|---|---|---|
| layout | `section`, `columns`, `tabs`, `divider` | none | 1 | сегодня |
| presentational | `text` | none | 1 | сегодня |
| data-bound | `field`, `table`, `readout`, `relation` | current-record | 1 | сегодня |
| list | `list` (таблица других записей) | query | 1 | **новый** (страницы) |
| viz | `chart`, `metric` | aggregate | 1 | **новый** (поглощает агрегаты report-page T-0121) |
| action | `action` (кнопка) | none (ссылка на E16) | 1 | **новый** |
| custom | `custom` | через `bindings[]` | 2 | сегодня (escape) |

Сегодняшние формовые узлы (`section`/`columns`/`tabs`/`divider`/`text`/`field`/`table`/`readout`/`relation`/`custom`) становятся дескрипторами 1-в-1, поведение не меняется (FF-COERCE-1 / round-trip). `list`/`chart`/`metric`/`action` — новые дескрипторы, добавляемые той же декларацией.

### 4.2 Как сегодняшние 10 узлов становятся дескрипторами

Каждый `case` в `FormNode` (FormDocumentRenderer.jsx:340-357) → `render` соответствующего дескриптора (тело `SectionNode`/`ColumnsNode`/… переезжает без изменений). `PALETTE`-запись → поля `class`/`paletteGroup`/`icon`/`label`/`editorProps` дескриптора. `WIDGET_COMPAT`-строка для типа → выводится из `contractKinds` дескриптора `field` + `presentations` из binding-contract-catalog (не отдельная матрица). `validateDocument`-ветки (V-NODE/V-KEY/V-CONTRACT/V-WIDGET/V-SUBKEY) → общий обход + `descriptor.validate?()`. **Импортёры `form-document.js`** (см. §10) продолжают видеть прежний публичный API через тонкий compat-фасад.

## 5. Источники данных (ключ к страницам)

Обобщение «форма (одна запись) → страница (много источников)» = у виджета **объявленный источник** (`dataSource` дескриптора):

- **`current-record`** — `field`/`table`/`readout`/`relation`: привязка к схеме записи поверхности (как форма сейчас).
- **`query`** — `list`: `{ applicationId, filter?, sort?, columns[] }` → читает ДРУГИЕ записи. Видимость гейтится read-грантом через резолвер T-0021/T-0539 (видишь только разрешённое).
- **`aggregate`** — `chart`/`metric`: `{ applicationId, groupBy?, measure, op }` → это и есть сегодняшние Floor-1-агрегаты report-page (T-0121 FR-1 §88: count/sum/avg/list по полям `record_schema`).
- **`none`** — layout/presentational/action.

**Named-binding обобщается на источники (R-SRC-BIND):** каждый источник объявляет ключи (`columns[]`/`measure`/`groupBy`/`filter`-поля), которые ОБЯЗАНЫ существовать в указанной схеме → `DepViolation` — тот же механизм, что T-0072/T-0121 дают для report-page (`report_page_dep`, `checkReportPageDepFields`). Деструктивное изменение схемы при активной зависимости страницы → red-line (член bundle-coherence, T-0082; 409 на runtime, exit 1 в CI — наследуется из T-0121 FR-3, не переоткрывается здесь).

> **Impl-зависимость (не решается этим ADR):** `query`/`aggregate` требуют read-API с грант-гейтом и батчингом N источников на странице. Конкретная DDL/эндпоинт — за impl-задачей (фаза 3, §9). Этот ADR фиксирует только контракт источника в `surface`-документе.

## 6. Бот == человек (один документ, обобщён на страницы)

- Драйверы (человек drag-n-drop / бот emit / Floor-2 escape) производят **один** `surface-document`, проходят **один** authoring-validator и **один** floor-классификатор (`floor-boundary.spec.md` §3.3; `FLOOR1_DOC_NODE_TYPES` обобщается на surface-узлы).
- AI-инструмент эмиттера (`emit_surface`, расширение `emit_form` / `form-document-emit.js`) строит то же дерево из дескрипторов реестра; кодовый вывод → Floor-2-sandbox с флагом, не в обход (T-0545).
- Один `SurfaceRenderer` детерминированно рисует документ для обоих драйверов; типы/данные — из живой схемы / источников.

## 7. Границы (без новых пересечений)

- **E16/T-0349 — семантика действий.** `action`-виджет несёт ТОЛЬКО `outcomeRef` (и опц. `triggerRef`); что кнопка делает (запуск процесса, исходы, триггеры, точки входа) **владеет E16**. Конструктор размещает кнопку и ссылку на исход; смысл исхода — не здесь. (Решение фаундера 2026-06-29.)
- **E-NAV-IA (T-0537/T-0540) — дом страниц.** `surface{kind:"page", slug}` живёт в модели Раздел→Приложение→Страница; видимость — через гранты (T-0021/T-0539), как вся навигация. Формы записи/шага достигаются из записи/инбокса (не отдельный пункт нав).
- **report-pages (T-0121) — СВЕДЕНИЕ, не форк.** `report_page` становится `surface{kind:"page"}` с viz/list-виджетами. Хранилище/API `report_page` + `report_page_dep` сохраняются совместимыми (T-0121 — данность); рендеринг перенаправляется через `SurfaceRenderer` + реестр; редактор `screen-reports` сводится в общий конструктор (не третий редактор). Зависимости страница↔схема — тот же named-binding / `report_page_dep` / bundle-coherence.

## 8. Floor-1 vs Floor-2

- **Floor-1 (≈99%)** — декларативные дескрипторы реестра (layout/data/list/viz/action/text). Рендер inline. `floor:1`.
- **Floor-2 (≈1%)** — `custom`: React-код в sandbox-iframe (opaque origin `'null'`, `allow-scripts` БЕЗ `allow-same-origin`, `FLOOR2_CUSTOM_FLAG_KEY`-гейт, привязка ТОЛЬКО к объявленным `bindings[]` из живой схемы — уже реализовано `Floor2Sandbox.jsx` / T-0101). `floor:2`. Реестр помечает `floor` дескриптора; floor-классификатор (floor-boundary §3.3) маршрутизирует операцию по `floor`. Путь к более богатым кастом-виджетам позже не закрыт.

## 9. Путь миграции (инкрементально, не ломая live)

0. **Контракт + реестр (этот ADR / T-0543, DESIGN):** введён `surface` v2 (`T-0543-surface-document.schema.json`) + интерфейс `WidgetDescriptor` (`T-0543-widget-registry.interface.ts`); v1 form-document авто-коэрсится в `record-form`/`step-form`.
1. **SurfaceRenderer (impl):** `WidgetRegistry` + `SurfaceRenderer`, читающий реестр; сегодняшние 10 узлов → дескрипторы (поведение не меняется; `FormDocumentRenderer` становится тонким фасадом `SurfaceRenderer` через `coerceToSurface`); `field-renderer` сводится под `render` дескрипторов `field`/`relation`/`readout`/`table`. Гейт: FF-COERCE-1 + FF-REG-1.
2. **Канвас (T-0544):** `FormDesigner` → конструктор поверх реестра (вложенный drag, живое превью, undo, мультивыбор). Палитра/инспектор читают `registry.list()`/`descriptor.editorProps`.
3. **Страницы (impl):** дескрипторы `list`/`chart`/`metric`/`action`; read-API источников (query/aggregate) с грант-гейтом и батчингом; перенаправить рендер `report_page` на `SurfaceRenderer`; свести редактор `screen-reports` в конструктор.
4. **AI-emit (T-0545):** эмиттер целит в реестр; `screen-assistant` подключает `emit_surface`.

## 10. Обратная совместимость публичной поверхности `form-document.js`

`form-document.js` — load-bearing модуль; его публичные экспорты импортируются (заземлено `grep`):

- `form-document-ops.js` (insert/move/remove/update ops),
- `form-document-emit.js` (`buildDefaultDocument`, `nodeForField`, `validateDocument`, `FORM_DOCUMENT_SCHEMA_VERSION`, `indexSchema`),
- `FormDocumentRenderer.jsx` (`childrenOf`, `isDataNodeType`, `indexSchema`, `defaultWidgetForType`),
- `FormDesigner.jsx`, `screen-forms.jsx` (через рендерер),
- тесты: `form-document.test.js`, `form-document-ops.test.js`, `form-document-soglasovanie.test.js`, `FormDocumentRenderer.test.jsx`.

**Контракт совместимости:** на фазах 0-1 публичные функции (`PALETTE`, `WIDGET_COMPAT`, `validateDocument`, `buildDefaultDocument`, `nodeForField`, `childrenOf`, `keySet`, `walkDocument`, `indexSchema`, `defaultWidgetForType`, `isDataNodeType`, `FORM_DOCUMENT_SCHEMA_VERSION`) сохраняют сигнатуру и семантику. `PALETTE`/`WIDGET_COMPAT` становятся **производными от реестра** (вычисляются из дескрипторов), а не отдельными литералами — но экспорт-форма прежняя (FF-REG-1 запрещает второй источник, не ломает импортёров). Снятие/изменение экспорта — только за явной задачей-депрекацией, не в этом эпике.

## 11. Расширяемость

- Новый блок = один дескриптор (client `render` + server-метаданные) + `paletteGroup`. Без правок dispatch/палитры/матрицы.
- `schemaVersion` бамп при добавлении КЛАССОВ узлов (не при добавлении дескриптора существующего класса); старые документы коэрсятся.
- Закрыто по умолчанию: валидатор/рендерер пускают только зарегистрированные `id` и совместимые `floor`/`contractKinds`/`dataSource`.

## 12. Последствия

**Плюсы:** один контракт / рендерер / конструктор / реестр на формы + страницы + отчёты; бот == человек на всех поверхностях; новый виджет — одна декларация; устранён третий/четвёртый редактор; страницы честно ложатся в нав (E-NAV-IA) и действия (E16).

**Издержки / открытые вопросы для impl:**
- Query/aggregate-источникам нужен read-API с грант-гейтом (T-0021) и батчингом N источников — отдельная impl-зависимость (эндпоинт списков/агрегатов).
- Миграция `report_page` обязана быть обратносовместимой — не сломать живой экран «Отчёты» (FF-COERCE-1 распространяется и на report_page→page рендер-эквивалентность на фазе 3).
- Производительность страниц с многими источниками — батчинг/кеш.
- Floor-2 «маркетплейс» кастом-виджетов — вне охвата; реестр не должен закрыть путь.

## 13. Fitness-функции (полностью — см. `T-0543.adr.contract.json`)

- **FF-REG-1** — новый виджет = одна запись реестра; нет `switch(node.type)`/литерала `PALETTE`/`WIDGET_COMPAT` вне реестра (grep/eslint-гард).
- **FF-CONTRACT-1** — любой `surface-document` валидируется против `T-0543-surface-document.schema.json`.
- **FF-NAMED-BIND** — data-bound узел не хранит `type`/`options` (резолв из живой схемы); анти-drift.
- **FF-COERCE-1** — v1 form-document авто-коэрсится в v2 и рендерится байт-идентично (round-trip + рендер-эквивалентность).
- **FF-SRC-DEP** — каждый источник (query/aggregate) объявляет ключи, проверяемые против живой схемы (DepViolation; член bundle-coherence).
- **FF-UX-G1, FF-UX-G6** — конструктор/рендерер на дизайн-системе (`--chs-*` токены, `.chs-*` классы; honest-empty), без хардкод-цветов и жаргона (G-гейты OBLIK).

## 14. Что НЕ решаем здесь

Семантику действий/исходов (E16), модель навигации/разделов (E-NAV-IA), capability-видимость (T-0539), конкретную DDL/эндпоинты query/aggregate read-API, `report_page_dep`-механику (T-0121 — данность) — этот ADR только потребляет их границы.

## 15. Отвергнутые альтернативы

- **Отдельный page/dashboard-редактор поверх report_page (четвёртый редактор).** Нарушает «не плодить механизмы» (T-0121 FR-2); дублирует named-binding, палитру, рендер; бот != человек снова.
- **Per-driver контракты (человек ↔ бот эмитят разные формы).** Ломает «бот==человек»; два валидатора, drift. Один документ — один валидатор.
- **Реестр как серверный код-плагин (исполняемый дескриптор с сервера).** Размывает Floor-границу (исполняемый код вне sandbox), усложняет ядро. Реестр — декларативные метаданные + клиентский `render`, Floor-2 остаётся единственным код-escape.
- **Оставить хардкод, добавить страницы ad-hoc.** Каждый новый виджет — правка в 5 местах × 2 зеркала; не масштабируется, нет шва для AI-emit.
