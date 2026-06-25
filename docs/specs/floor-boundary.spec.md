# Spec: машинно-проверяемая граница Floor-1 ↔ Floor-2 + авто-гейт (T-0402 · D7-5)

> ADR [extensibility-and-authoring.md](../design/extensibility-and-authoring.md) §9.2 требует ЭТУ
> спеку ДО первого Floor-2-релиза (она гейтит T-0481 — палитру виджетов F2). Формализует §4 «граница
> машинно-проверяема, не на вкус агента» и §9 несущий-гард-2 «машинно-проверяемая граница Floor-1 ↔
> Floor-2». PD-18; уточняет/наследует [forms-data-contract-foundation.spec.md](forms-data-contract-foundation.spec.md)
> §6 (направление: декларативный форма-документ vs код-escape) и [form-document-format.spec.md](form-document-format.spec.md)
> §10 (правило границы вынесено сюда).
>
> Статус: спека (DESIGN) · 2026-06-26. Контракт: [floor-boundary.spec.contract.json](floor-boundary.spec.contract.json).

## 1. Зачем (проблема, которую закрывает)

ADR §9 гард-2: без формального правила «какая правка тривиальна (Floor-1) vs структурна (Floor-2)»
агент маршрутизирует тривиальное в код (зря теряя детерминизм) ИЛИ структурное в Floor-1 (тихо ломая
named-binding инвариант) — «обрыв B возвращается в маскировке».

Сегодня граница уже частично кодифицирована — но НЕДОСТАТОЧНО для Floor-2-релиза:

- `src/core/authoring-floor-classifier.ts` (T-0074) классифицирует по `FormEditChange.kind` —
  **лексически**: он ДОВЕРЯЕТ дискриминатору, который ему отдают. Это правильный слой «вид-правки →
  этаж», но он НЕ инспектирует фактическое содержимое артефакта. Агент, отдавший `kind:"relabel_field"`
  для диффа, который на самом деле протаскивает `<script>`/новое поле/кастом-компонент, прошёл бы как
  Floor-1. Лексический классификатор — необходимое, но не достаточное условие.
- `src/core/floor2-renderer.ts` (T-0076) гейтит уже-Floor-2-артефакт (vetted vs custom-флаг +
  sandbox), но это слой РЕНДЕРА ПОСЛЕ классификации — не классификатор.
- `forms-data-contract-foundation.spec.md` §6 + `form-document-format.spec.md` сместили линию: 99%
  авторинга = декларативный **форма-документ** (drag-n-drop ИЛИ ИИ-эмиссия одного и того же документа),
  1% = `custom`-узел = код-escape в sandbox. Линия больше НЕ «кнопки vs код» — она «**декларативный
  артефакт vs введение кода/логики**».

T-0402 закрывает разрыв: даёт правило, проверяемое по **СОДЕРЖИМОМУ диффа**, а не по самозаявленному
`kind`, и собирает оба слоя (лексический + контентный) в один авто-гейт, который классифицирует и
маршрутизирует операцию редактирования.

## 2. Что уже есть (orient — фундамент, на котором стоим)

| Артефакт | Роль | Что НЕ делает (разрыв T-0402) |
|---|---|---|
| `authoring-floor-classifier.ts` (T-0074) — `classifyAuthoringFloor`, `FLOOR1_EDIT_KINDS`, `FLOOR2_EDIT_KINDS` | лексический «kind → этаж»; unknown → Floor-2 | доверяет `kind`; не смотрит содержимое диффа |
| `binding-contract-catalog.ts` (T-0399, PD-18) — `BINDING_CONTRACT_KINDS`, каталог | КОНЕЧНЫЙ словарь контрактов привязки | сам по себе не граница; даёт whitelist слотов |
| `floor1-editor.ts` (T-0073) — `applyFloor1Edit`, `FieldUiMeta` | чистые Floor-1 трансформации над (BindingField[], UiSchema) | whitelist полей UI-schema, но только для 6 kinds |
| `floor2-renderer.ts` (T-0076) — `validateFloor2Descriptor`, `FLOOR2_CUSTOM_FLAG_KEY`, sandbox | гейт рендера Floor-2 (vetted/custom + sandbox-iframe) | пост-классификационный слой; не классификатор |
| `form-document-format.spec.md` — дерево узлов `section/columns/tabs/divider/text/field/table/readout/relation/custom` | сериализуемый декларативный документ | §10: правило границы вынесено в D7-5 (сюда) |
| `ci/checks/authoring-floor-isolation.sh` (FF-FLOOR-AUTH) | гард изоляции классификатора | проверяет существование/чистоту, не контентное правило |

**Несущий инвариант (ADR §4), который граница обязана защитить:** код Floor-2 НЕ мутирует состояние
процесса напрямую — он презентация/интеракция над ТЕМ ЖЕ named-binding, валидируемым на бэке. `field-key
== variable-name`. Документ хранит только ключ + презентацию; тип/options — из живой `record_schema`.

## 3. ПРАВИЛО (машинно-проверяемая граница)

### 3.1 Две стороны линии

- **FLOOR-1 (тривиальное, декларативное, самообслуживание, low-risk).** Дифф авторинга, целиком
  выразимый как **декларативный форма-документ** (§3.2) ИЛИ как набор Floor-1 правок из закрытого словаря
  (`FLOOR1_EDIT_KINDS`). Касается ТОЛЬКО ключей из декларативного whitelist; НЕ содержит кода / выражений
  / скриптов / новых named-binding ключей вне живой схемы. Детерминирован, zero-LLM-достижим (drag-n-drop
  ИЛИ ИИ-эмиссия документа), переживает агента-офлайн.
- **FLOOR-2 (структурное, вводит код/логику).** Любой дифф, который вводит **код / выражение / скрипт /
  кастом-компонент** ИЛИ структурно меняет контракт данных (новое/удалённое/переименованное/перетипизированное
  поле, DMN-условие, external-task, object-migration). Маршрутизируется на vetted-палитру / sandbox-iframe
  путь с его гарантиями изоляции (§3.5, T-0076).

### 3.2 Предикат границы (точное правило)

Граница — функция ДВУХ входов: лексического (`kind`) И контентного (фактический дифф/документ).
Решение — `floor = max(lexicalFloor, contentFloor)` (этаж монотонно растёт; никогда не понижается).
**Floor-1 ⟺ ОБА слоя дают Floor-1.** Достаточно одного Floor-2-сигнала → Floor-2 (fail-up, симметрично
ADR §9 default-DENY на необратимость).

Дифф классифицируется **Floor-1 тогда и только тогда**, когда ВЫПОЛНЕНЫ ВСЕ условия (иначе — Floor-2):

- **R-1 (лексика).** `change.kind ∈ FLOOR1_EDIT_KINDS` (закрытый словарь T-0074). Неизвестный kind →
  Floor-2 (наследует §9.2 «неизвестное → структурное»).
- **R-2 (whitelist ключей).** Каждый изменённый ключ ∈ `FLOOR1_DECLARATIVE_WHITELIST` — конечный набор
  декларативных слотов, НЕ влияющих на контракт данных:
  - **UI-schema слой** (`FieldUiMeta`, T-0073): `label`, `placeholder`, `help_text`, `hidden`,
    `display_order`.
  - **named-binding presentation-слой** (НЕ контракт): `BindingField.required`, `BindingField.label`,
    `BindingField.presentation` (только из `descriptor.presentations` для уже-существующего `contract`),
    `BindingField.display_order`.
  - **структурно-нейтральные узлы форма-документа** (§3.3): `section`, `columns`, `tabs`, `divider`,
    `text` (раскладка/группировка), и узлы данных `field`/`table`/`readout`/`relation`, у которых
    меняются ТОЛЬКО `label`/`mode`/`placeholder`/`widget` (`widget` — из допустимых пар §6 форма-документа),
    БЕЗ смены `fieldKey`.
  Любой ключ ВНЕ whitelist (например `BindingField.key`, `BindingField.type`/`contract`, `record_schema`
  property, `reactSource`, `componentId`, expression-поле) → Floor-2.
- **R-3 (нет кода/логики).** Дифф НЕ содержит кодовый/логический сигнал (§3.4): нет нового `custom`-узла,
  нет `reactSource`/`componentId`, нет expression/script/condition-строки, нет нового external-task /
  DMN-таблицы.
- **R-4 (named-binding целостность).** Полное множество ключей record_schema, на которые ссылается
  документ ПОСЛЕ правки, — **`KEY_SET(doc)`** — обязано быть ⊆ множеству ключей живой `record_schema`
  (никаких новых/висящих биндингов). `KEY_SET(doc)` определяется тремя каналами привязки:
  1. **`fieldKey`** — на каждом узле `field`, `table`, `readout`, `relation` (первичная привязка).
  2. **`table.columns[].subKey`** — каждая колонка узла `table` называет отдельный ключ в
     `record_schema` коллекции (форма-документ §4: «`fieldKey` и `subKey` для table == ключ поля в
     `record_schema`»; реализует контракт `collection` / `child-rows`).
  3. **`relation.displayField`** — вторичная схема-ссылка на узле `relation`: если указан
     `displayField`, он обязан быть ключом живой `record_schema` связанного приложения (F5
     cross_app_ref; схема-слот `foreign-key` в `binding-contract-catalog.ts`).

  Любой ключ из `KEY_SET(doc)`, отсутствующий в живой `record_schema`, — висящий биндинг → Floor-2.
  Это касается как добавления/переименования/удаления через операции с семантикой Floor-1 (`relabel_field`
  и т. п.), так и ситуации, когда операция заявляет только label/widget-изменение, но ВВОДИТ новый
  `subKey` или `displayField` вне существующей схемы — такая операция проходит R-1 лексически, но
  нарушает R-4 контентно и обязана классифицироваться Floor-2. Это — анти-дрейф §4 форма-документа,
  поднятый в гард границы.

Floor-2 ⟺ ¬(R-1 ∧ R-2 ∧ R-3 ∧ R-4). Внутри Floor-2 уже-существующая под-классификация (vetted vs
custom — T-0076) и red-lines (T-0078, default-DENY на необратимость) применяются как сегодня; T-0402 их
НЕ дублирует, а ссылается.

### 3.3 Whitelist декларативных узлов (форма-документ)

`FLOOR1_DOC_NODE_TYPES` — закрытый набор типов узлов, допустимых в декларативном (Floor-1) документе:
`section`, `columns`, `tabs`, `divider`, `text`, `field`, `table`, `readout`, `relation`. Любой узел
`custom` (§3.1 форма-документа: escape, `componentId` + `bindings[]`, sandbox-iframe) → документ содержит
Floor-2 элемент → маршрут Floor-2. То есть: один `custom`-узел НЕ делает весь документ Floor-2-кодом, но
делает ОПЕРАЦИЮ ввода/правки этого узла Floor-2-операцией (она идёт через гейт §3.5 — vetted/флаг +
sandbox). Остальные узлы того же документа остаются декларативными.

### 3.4 Сигналы кода/логики (контентный детектор)

Машинно-обнаружимые маркеры, любой из которых ⟹ Floor-2 (`hasCodeSignal === true`):

- наличие узла `type: "custom"` в дереве форма-документа;
- непустое поле `reactSource` (custom Floor-2 descriptor, T-0076);
- наличие `componentId` (ссылка на кастом-компонент);
- наличие `kind ∈ {add_conditional, custom_component, external_task, object_migration}` (T-0074
  Floor-2 kinds, кодирующие логику/код/миграцию);
- наличие expression/condition/script-поля (DMN-условие, expression-visibility — Middle-слой ADR,
  который для целей ЭТОЙ границы трактуется как Floor-2: вводит логику сверх плоской декларации).

Детектор — структурный (ключи/типы узлов), не эвристика по тексту значений: он смотрит на ФОРМУ диффа
(присутствие code-несущих полей/узлов/kinds), а не пытается «понять» произвольную строку. Это держит его
детерминированным и fail-closed.

### 3.5 Гарантии изоляции Floor-2 (куда маршрутизируем — ссылка, не новое)

Floor-2-операция с кодом/кастом-компонентом идёт на путь sandbox-iframe (T-0076 / T-0101):
`sandbox="allow-scripts"` БЕЗ `allow-same-origin` (опаковый origin `'null'`); единственный шов наружу —
origin-валидированный height-postMessage; custom-режим требует `FLOOR2_CUSTOM_FLAG_KEY === 'true'`
(§9.10 governance-флаг); бэкенд-валидация (`form-validator.ts`) остаётся authority на submit-значениях
(iframe-презентация НЕДОВЕРЕНА). T-0402 НЕ переопределяет эти гарантии — он маршрутизирует НА них.

## 4. ГЕЙТ (авто-классификация + маршрутизация)

### 4.1 Вход / предикат / выход

**Чистая функция-классификатор** (предлагаемое имя `classifyFloorBoundary`, новый модуль
`src/core/floor-boundary.ts`; реализуется отдельной build-задачей, НЕ этой DESIGN-задачей):

```
classifyFloorBoundary(op: FloorEditOp, schema: LiveSchemaView): FloorBoundaryResult
```

- **Вход `op`** — операция редактирования:
  - `kind: FormEditKind` (лексический сигнал, T-0074);
  - `changedKeys: string[]` — ключи, которых касается дифф (для R-2);
  - `doc?: FormDocument` — целевой/новый форма-документ (для R-3/R-4, обход дерева);
  - `descriptor?: Floor2RenderDescriptor` — если операция несёт Floor-2-рендер (vetted/custom);
  - `meta?` — аудит-контекст (agentId, draftId); классификатор его НЕ читает (чистота).
- **Вход `schema`** — read-only проекция живой `record_schema` (множество существующих `fieldKey` +
  их `contract`/`presentations`), для R-4 и валидации пар тип→widget. БЕЗ I/O: проекция передаётся,
  не читается из БД внутри (purity, как у всех `src/core/*` классификаторов).
- **Предикат** — §3.2: `floor = '1'` ⟺ `R-1 ∧ R-2 ∧ R-3 ∧ R-4`; иначе `'2'`. Вычисляется как
  `max(lexicalFloor(kind), contentFloor(changedKeys, doc, descriptor, schema))`.
- **Выход `FloorBoundaryResult`**:
  ```
  { floor: '1' | '2',
    route: 'declarative' | 'sandbox',
    reasons: string[],            // какие из R-1..R-4 (и какой сигнал) подняли этаж
    floor2Sub?: 'vetted'|'custom' // только при floor==='2' (делегируется T-0076)
  }
  ```
  `route: 'declarative'` → drag-n-drop/ИИ-документ путь (один рендерер, §3.1 spec). `route: 'sandbox'`
  → vetted-палитра / sandbox-iframe путь (T-0076 `validateFloor2Descriptor` + §3.5 изоляция).

Детерминизм + fail-closed: при любой неоднозначности / неизвестном kind / висящем биндинге → Floor-2
(`route: 'sandbox'`). Floor-1 — это явно-доказанное «всё четыре условия выполнены», не дефолт.

### 4.2 Куда подключается (концептуально)

- **Авторинг-API (HTTP).** Перед применением Floor-1-правки (`src/http/floor1-editor.ts`,
  `applyFloor1Edit`) и перед сохранением форма-документа: `classifyFloorBoundary(op, schema)`. Если
  `floor === '2'` на пути, заявленном как Floor-1 → отказ `409 WRONG_FLOOR` (так уже делает
  `validateFloor1Request` для лексического слоя — T-0402 расширяет его контентной проверкой). Если
  `route === 'sandbox'` → операция уходит на Floor-2-валидатор (`validateFloor2Descriptor`).
- **Config-агент (эмиссия документа).** Когда агент эмитит форма-документ ИЛИ Floor-2-descriptor,
  тот же классификатор решает, нужен ли sandbox + флаг (§9.10). Агент НЕ выбирает этаж «на вкус» —
  этаж вычисляется из содержимого его артефакта.
- **Рендер.** `route` детерминирует рендерер: `declarative` → единый каталог-рендерер
  (`field-renderer.jsx` / form-document renderer); `sandbox` → `Floor2Viewer.jsx`.

### 4.3 Активация гейта — FOUNDER-CLASS (НЕ делается этой задачей)

Боевой статический гард `ci/checks/floor-boundary-isolation.sh` (предлагаемый id **FF-FLOOR-BND**),
утверждающий контентное правило и изоляцию модуля `floor-boundary.ts`, — это founder-class активация:
файлы под `ci/checks/**` заморожены (Check-6 + FF-FCI1). ЭТА спека ПРОЕКТИРУЕТ гейт (правило +
предикат + AC ниже); она его НЕ активирует и НЕ добавляет/не правит ничего под `ci/checks/`.
Активация (добавление чека в `npm run fitness` + `--self-test`) — отдельный founder-санкционированный
шаг. См. §6 «Гард-дизайн (для будущей активации)».

## 5. Машинно-проверяемые инварианты (AC — см. contract.json)

- **FB-1** Floor-1 ⟺ R-1 ∧ R-2 ∧ R-3 ∧ R-4; нарушение любого условия → Floor-2 (параметризованный тест
  по матрице входов). `verifiable_as: test`.
- **FB-2** Контентный детектор ловит код-сигнал, который лексика пропускает: `kind:"relabel_field"` +
  дифф с `custom`-узлом / `reactSource` / новым `fieldKey` → Floor-2 (а НЕ Floor-1). `test`.
- **FB-3** `floor = max(lexicalFloor, contentFloor)` — этаж не понижается контентом: Floor-2-kind с
  чисто-декларативным телом остаётся Floor-2. `test`.
- **FB-4** R-4: документ с `fieldKey` вне живой `record_schema` → Floor-2 (висящий/новый биндинг —
  контракт данных). `test`.
- **FB-5** `custom`-узел / непустой `reactSource` → `route:'sandbox'` + (custom → требует
  `FLOOR2_CUSTOM_FLAG_KEY`); делегирование `validateFloor2Descriptor` (T-0076), не дублирование. `test`.
- **FB-6** Детерминизм + fail-closed: неизвестный `kind` / неоднозначный вход → Floor-2; повтор того же
  входа → байт-идентичный результат. `test`.
- **FB-7** Чистота: `src/core/floor-boundary.ts` без I/O (pg / node:fs / node:http / child_process /
  import.meta / process.env / process.exit) — как все `src/core/*` классификаторы. `fitness`
  (FF-FLOOR-BND — founder-class активация, §4.3).
- **FB-8** Один control-plane: классификатор ПОТРЕБЛЯЕТ `FLOOR1_EDIT_KINDS`/`FLOOR2_EDIT_KINDS`
  (T-0074), `BINDING_CONTRACT_KINDS` (T-0399), `FLOOR1_DOC_NODE_TYPES` (форма-документ) и делегирует
  Floor-2-под-классификацию `validateFloor2Descriptor` (T-0076) — НЕ вводит параллельный словарь/
  второй sandbox-полиси. `fitness` (FF-FLOOR-BND).

## 6. Гард-дизайн (для будущей founder-class активации — НЕ активируется здесь)

Будущий `ci/checks/floor-boundary-isolation.sh` (FF-FLOOR-BND, с `--self-test`, краснеющим на
намеренно-сломанной фикстуре — паттерн всех fitness-чеков) утверждал бы статически:

- FB-BND-1 — `src/core/floor-boundary.ts` существует и чист (нет forbidden I/O — паттерн AFC-2).
- FB-BND-2 — экспортирует `classifyFloorBoundary`, `FLOOR1_DECLARATIVE_WHITELIST`,
  `FLOOR1_DOC_NODE_TYPES`, `FloorEditOp`, `FloorBoundaryResult`.
- FB-BND-3 — whitelist'ы — `ReadonlySet`/`readonly` (машинно-читаемая граница, паттерн AFC-5).
- FB-BND-4 — модуль ИМПОРТИРУЕТ `FLOOR1_EDIT_KINDS`/`FLOOR2_EDIT_KINDS` (T-0074) и
  `validateFloor2Descriptor` (T-0076) — один control-plane, не второй (паттерн AFC-3 precedent-link).
- FB-BND-5 — fallback-ветка «неизвестное / неоднозначное → Floor-2» присутствует (паттерн AFC-7).

Этот раздел — ПРОЕКТ гарда. Его файл под `ci/checks/**` и его включение в `npm run fitness` —
founder-class шаги, выполняемые ОТДЕЛЬНО (§4.3).

## 7. Границы / не входит

- **Реализация** `floor-boundary.ts` + его тесты + активация FF-FLOOR-BND — отдельные build-задачи
  (эта задача — DESIGN/spec).
- **Floor-2 под-классификация** (vetted vs custom) и **sandbox-изоляция** — уже в T-0076/T-0101; здесь
  только ССЫЛКА и маршрут на них.
- **Red-lines** (drop/rename/lossy — default-DENY на необратимость) — уже в T-0078; граница лишь
  относит их к Floor-2, governance-гейт остаётся в T-0078.
- **Каталог контрактов / каталог визуалов** — PD-18 / T-0399; граница потребляет каталог как whitelist
  слотов, не переопределяет его.
- **Посредник данных + лимиты** (PD-19 / D7-3) и **submit-валидация** (D7-2) — ортогональны; граница
  про КЛАССИФИКАЦИЮ правки, не про data-access.
- **Активация любого ci/checks** — founder-class, вне scope (§4.3).

## 8. Приёмка

См. машинно-проверяемые AC в [floor-boundary.spec.contract.json](floor-boundary.spec.contract.json):
FB-1..FB-8 (правило, контентный детектор, монотонность этажа, named-binding целостность, маршрут на
sandbox, детерминизм/fail-closed, чистота, один control-plane). DESIGN-достаточность: ADR §4/§9.2/§9 +
PD-18 + форма-документ §10 ДОСТАТОЧНЫ как design — продуктовых развилок нет, остаток реализационный
(КАК закодировать предикат, не ЧТО он решает).
