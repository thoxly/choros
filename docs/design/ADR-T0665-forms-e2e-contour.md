# ADR-T0665 — Замыкание контура форм: биндинг шага, load layout, GET+рендерер

Столп 2/3 (интерфейс-из-блоков-на-данных + бесшовность). Продолжение T-0656
(DnD-конструктор форм). Статус: BUILD.

## 1. Что доказал LIVE_PROOF T-0656 (docs/handoff/T-0656.pr-handoff.json, live_proof)

Механика канваса (drag/drop/клавиатура/fullscreen) — GREEN живьём. Машинный шов
(`POST /api/forms/document-ops`) — GREEN живьём против реального биндинга.
Но **три независимых разрыва** не дают собранной форме дойти до исполнителя:

1. `FormDesigner.jsx persistLayout()` читает `doc.step?.processKey || 'record'`
   и `doc.step?.step || 'record-form'` — но `doc.step` НИКОГДА не устанавливается:
   нет UI выбрать процесс/шаг. Каждое сохранение бьёт в фолбэк `'record'`,
   которого нет ни у одного тенанта на стенде → `409 WRONG_FLOOR` всегда.
2. `FormDesigner` при выборе набора полей (`selectedDefId`) ВСЕГДА вызывает
   `buildDefaultDocument(...)` заново (см. эффект на `[selectedDefId, registryDefs,
   selectedAppId]`) — существующий `form_binding.layout` для этого шага никогда
   не читается при открытии. Переоткрытие конструктора теряет раскладку.
3. `GET /api/forms/binding` (actor-scoped, `src/http/binding.ts`) отвечает
   `{fields, version, processKey, stepKey}` — без `layout`, хотя колонка и
   геттер (`getBindingLayout`) уже существуют (T-0656 машинный шов их использует).
   `InboxTaskForm` (`web/src/screens/screen-inbox.jsx`) рендерит `fields`
   построчно через `FieldControl` и не подозревает о `layout` — собранная
   раскладка физически не может отрисоваться исполнителю, ни человеком собранная,
   ни агентом через `document-ops`.

## 2. Доменная модель биндинга (как есть, после этой задачи)

```
form_binding (tenant_id, process_key, form_key, fields, layout, version, ...)
```

- `process_key` — ключ процесса (`process_definition.process_key` / ключ,
  под которым процесс опубликован в Flowable). НЕ произвольная строка —
  должен соответствовать реальному опубликованному процессу тенанта, иначе
  `classifyLayoutSave` (Floor-boundary гейт, T-0520) не может резолвнуть live
  schema через `process_app_binding` → `registry_def` → `409 WRONG_FLOOR`
  (fail-closed, НЕ ослабляется этой задачей).
- `form_key` — он же `stepKey` в actor-scoped API: BPMN userTask id/name,
  под которым инбокс-задача несёт `item.step` (см. `InboxTaskForm({processKey,
  stepKey, ...})` — `stepKey` приходит из `detail.item.step`).
- `fields: BindingField[]` — LIVE-схема снимка на момент последнего сохранения
  (key/type/required/label/contract/presentation/options/**mode**). `mode`
  (T-0404) — ПЕР-ШАГОВЫЙ режим поля (read-only/required-to-advance/hidden),
  задаётся отдельно от layout (FormBuilder путь), это источник правды для
  submit-гейта (`resolveFieldMode` в `field-renderer.jsx`/`field-contract.js`).
- `layout: FormDocument | null` — декларативное дерево (`form-document.js`
  `{schemaVersion, source, root:{type,children,...}, step?}`), собранное
  человеком (FormDesigner) ИЛИ агентом (`document-ops` seam). `null` для
  легаси-биндингов (сохранённых через FormBuilder до T-0506/T-0656, или через
  сырой POST без `layout`).

**Как layout течёт (после этой задачи):**

```
FormDesigner (человек)                     document-ops (агент)
   │ выбор процесса+шага (F1)                  │ читает layout из form_binding
   │ GET /api/forms/binding?processKey&stepKey │ (T-0656, не меняется)
   │   → если layout есть → initHistory(layout)│
   │   → если нет → buildDefaultDocument(...)  │
   │ POST /api/forms/binding                   │ POST /api/forms/document-ops
   │   {process_key, form_key, layout}         │   применяет ОДНУ op, тот же
   │   → classifyLayoutSave (ТОТ ЖЕ гейт)      │   classifyLayoutSave
   ▼                                            ▼
              form_binding.layout (jsonb, persisted)
                           │
                           │ GET /api/forms/binding?processKey&stepKey (F4)
                           │   → {fields, version, layout?, processKey, stepKey}
                           ▼
              InboxTaskForm (production, screen-inbox.jsx)
                 layout present + valid .root → FormDocumentRenderer (F5)
                 layout absent (legacy)        → построчный FieldControl (не меняется)
```

Один и тот же `FormDocumentRenderer` (`web/src/forms/FormDocumentRenderer.jsx`,
«ОДИН РЕНДЕРЕР» по комментарию T-0481) уже используется как живое превью
ВНУТРИ FormDesigner — эта задача просто подключает его ВТОРЫМ потребителем
(InboxTaskForm), без второй копии дерева-обхода.

## 3. Решение по трём разрывам

### 3.1 F1/F2 — UI биндинга шага в FormDesigner

Новый блок «Привязка» перед существующим блоком «Приложение/Набор полей»:
- Пикер процесса — список из `/api/process-catalog` (ТЕ ЖЕ данные,
  что уже тянет `FormBuilder.jsx`), отфильтрованный на `status === 'published'`
  (форма привязывается к РЕАЛЬНОМУ шагу реального опубликованного процесса —
  черновик ещё может менять BPMN и терять шаг). Анти-кейс: список из API,
  не константа.
- Текстовое поле «Шаг процесса» (stepKey/userTask id) — тот же паттерн, что
  уже в FormBuilder (свободный ввод + подсказка «совпадает со значением поля
  «Шаг» в карточке задачи инбокса»). Дополнительно: best-effort автоподсказка
  доступных `bpmn:userTask` id/name, извлечённых из `bpmnXml` выбранного
  процесса (`fetchProcessDef` уже существует в `process-editor-api.js`) —
  лёгкий `DOMParser`-разбор (тот же примитив, что уже используется в
  `bpmn-save-load.js` для well-formedness), НЕ интеграция с полным
  bpmn-moddle (вне скоупа). Отказ парсинга (нет XML/невалиден) → подсказки
  просто нет, ручной ввод остаётся рабочим.
- Выбор процесса+шага пишет `doc.step = {processKey, step}` — контракт уже
  существует в `form-document.js buildDefaultDocument(source, fields,
  {step})` и уже читается `persistLayout`. Фолбэк `'record'/'record-form'`
  остаётся ТОЛЬКО как крайний случай «шаг не выбран» (не новый кейс-хардкод —
  тот же смысл, что и до задачи, просто перестаёт быть единственным путём).

### 3.2 F3 — Load layout при открытии

Когда пользователь выбирает процесс+шаг (до или после выбора набора полей —
порядок в UI не навязывается), эффект дёргает `GET /api/forms/binding` для
этой пары. Если ответ несёт `layout` с `.root` — `initHistory(layout)`
инициализирует историю ЭТИМ документом (а не `buildDefaultDocument`), и `fields`
стейт заполняется из ответа (`data.fields`), а НЕ из `parseRecordSchema`
заново — так UI не расходится с тем, что реально сохранено. Если биндинга нет
(404) или он без `layout` (легаси) — прежнее поведение: набор полей + выбор
приложения/registry-def строит документ через `buildDefaultDocument`.

### 3.3 F4 — GET отдаёт layout

`getBinding()` (src/http/binding.ts) расширяется на `layout` в SELECT — один
геттер, не два параллельных пути (сейчас `getBinding` и `getBindingLayout`
дублируют один и тот же SELECT с разным набором колонок; `getBinding` теперь
включает `layout`, `getBindingLayout` остаётся для `document-ops` seam, либо
внутренне переиспользует `getBinding` — реализация проверяет оба места
использования, чтобы не сломать T-0656 seam). Оба HTTP-ответа (T-0072 named
route и T-0376 actor-scoped route) добавляют `layout` в JSON, **только когда
не NULL** (`'layout' in data` — так клиент отличает легаси от размеченного,
не полагаясь на `null` vs `undefined` двусмысленность в JSON).

### 3.4 F5 — InboxTaskForm применяет layout

`InboxTaskForm` получает `binding.layout` из ответа. Ветвление:
- `layout` присутствует и `layout.root` — рендер через `<FormDocumentRenderer
  document={layout} fields={binding.fields} values={values} onChange=.../>`.
  `fields` (LIVE BindingField[] с `mode`/`contract`/`options`) остаётся
  источником типов — `FormDocumentRenderer` уже спроектирован именно так
  (`renderableField` резолвит тип/опции из `ctx.schema`, узел несёт только
  `fieldKey`+presentation — анти-дрейф-контракт T-0481).
- `layout` отсутствует — существующий построчный `FieldControl`-путь,
  байт-в-байт как сейчас (NF3).

**Найденный смежный гэп (не новый регресс, но усиливает P0, если не закрыть
сейчас):** `FormDocumentRenderer`'s `renderableField()` берёт `mode` из
`node.mode` (авторское свойство layout-узла, редактируемое Inspector'ом в
FormDesigner) и НЕ учитывает `schemaField.mode` (пер-шаговый режим из
`binding.fields[]`, T-0404 — тот самый источник, которым уже руководствуется
`resolveFieldMode` в построчном пути и submit-валидация). Без исправления
поле с server-side `mode:'hidden'`/`'read-only'` рендерилось бы через layout
редактируемым/видимым, хотя построчный путь его прячет/блокирует —
расхождение поведения между legacy- и layout-путём на ОДНОМ и том же биндинге.
Правится минимально: `renderableField` мёржит `schemaField.mode` как
приоритетный источник (`node.mode` — только для полей, у которых схема не
задаёт mode, то есть authoring-time дефолт, не серверная per-step политика).
Т.к. `FormDocumentRenderer.jsx` — общий модуль (не форкается для InboxTaskForm),
фикс автоматически применяется и к живому превью в FormDesigner (тем лучше:
превью станет честнее относительно того, что увидит исполнитель).

Submit-валидация (`resolveFieldMode`/`editableKeys` в `InboxTaskForm`) не
меняется — она уже читает `binding.fields[].mode`, а не layout — остаётся
ЕДИНЫМ источником правды для required/hidden/readonly на submit независимо
от того, каким путём поле было отрисовано.

## 4. Обратная совместимость (NF3)

- Существующие `form_binding` строки без `layout` (NULL) продолжают:
  сохраняться (POST без `layout` в теле — не меняется), читаться (`GET`
  просто не добавляет ключ `layout` в ответ), рендериться (`InboxTaskForm`
  ветвится на builtin `FieldControl`-путь).
- `screen-inbox.test.jsx` (существующие тесты) не переписываются — новое
  поведение добавляется, не замещает.
- `FormBuilder.jsx` (fields-путь, без layout) не трогается этой задачей —
  он и не подразумевает layout вообще (T-0376 origin).

## 5. Что НЕ входит (out of scope, см. spec)

- Доступ/роль `process_designer` — T-0666, не трогается.
- Полный bpmn-moddle парсинг userTask — только легковесный DOMParser best-effort.
- Изменение схемы `form_binding` — колонка `layout` уже существует (T-0506).
- Правка `document-ops` seam (T-0656 F7-F10) — не меняется.

## 6. Риски / компромиссы

- DOMParser-разбор BPMN на клиенте — best-effort, не критичный путь (ручной
  ввод stepKey всегда работает без него); в SSR/тестовой среде без DOM
  вернёт пустой список подсказок, не бросает.
- `renderableField` mode-мёрж — минимальное изменение общего рендерера;
  покрывается тестом, что legacy-поведение (без per-step mode) не меняется.
- Список процессов ограничен `published` — черновики не предлагаются
  (сознательно: black-box гейт `classifyLayoutSave` всё равно потребует
  реального `process_app_binding`, так что предложение черновика создало бы
  ложную видимость работоспособности).
