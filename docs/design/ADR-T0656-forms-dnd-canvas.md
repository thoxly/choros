# ADR-T0656 — форма-конструктор: живой drag-and-drop канвас + машинный шов (столп 2)

Status: ready
Task: T-0656 (флагманская, прямой заказ фаундера)
Base: dev@d7a7fb3, branch `task/T-0656-forms-dnd-canvas`

## 1. Заказ (дословно) и разбор на две равные цели

> «сделай удобный drag and drop для конструктора форм, чтобы было прямо
> реально удобно моделировать… нужно чтобы было классно и удобно (и
> человеку и машине/агенту через api или mcp — в духе нашего продукта)».

(A) **Человек** — канвас FormDesigner.jsx должен ощущаться как
современный конструктор (Notion/Airtable-класс), а не HTML5-DnD
прототип: видно КУДА встанет блок, видно КАКОЙ контейнер примет, есть
клавиатурная альтернатива, есть полноэкранный режим.

(B) **Машина/агент** — те же операции сборки формы (вставить/переместить/
удалить/поменять свойство блока) доступны программно через API, потому
что в духе продукта — «агент работает как сотрудник», а не как отдельный
привилегированный канал.

Общий инвариант: **один контракт документа** (form-document), одна
семантика мутаций (form-document-ops), два driver'а. Ни одна из целей не
должна породить вторую модель данных.

## 2. Что уже есть (разведано перед дизайном)

- `web/src/forms/FormDesigner.jsx` (912 строк) — канвас на HTML5
  `draggable`/`dragstart`/`dragover`/`drop`. `DropSlot` — тонкая (6-10px)
  полоса между узлами; `EmptyDropZone` — зона в пустом контейнере.
  `pathKey`/`childContainerPath` уже кодируют tab-aware пути.
  `moveNodeUp`/`moveNodeDown` уже дают Alt+↑/↓ клавиатурный fallback.
  `selectedKeys` (Set) уже даёт multiselect-инфраструктуру. История
  (undo/redo) уже коммитит через `history-stack.js`.
- `web/src/forms/form-document-ops.js` — ЧИСТЫЙ (React-free) слой мутаций:
  `insertNode/removeNode/reorderNode/updateNode/moveNode/moveNodeAcross/
  nodeAtPath`. Это уже единый контракт для человека; AI-emit
  (`form-emit-seam.js`, T-0545) уже проходит через ТОТ ЖЕ
  `validateDocument`, что и человек (`FF-T0545-SAME-GATE`) — тот же
  принцип «один гейт для обоих driver'ов» уже стоит на клиенте.
- Сервер: `POST /api/forms/binding` (`src/http/binding.ts`) уже
  принимает ВЕСЬ `layout` (form-document) целиком, гоняет его через
  `classifyFloorBoundary` (`src/core/floor-boundary.ts`, T-0519/T-0520) —
  контентный Floor-1/Floor-2 гейт, который проверяет KEY_SET документа
  против ЖИВОЙ схемы (не доверяя самозаявленному kind), — и апсертит в
  `form_binding.layout` (version+1). Это уже ЕДИНСТВЕННЫЙ судья: любой
  layout-сейв (человек или бот) обязан пройти классификатор.
- `rootDir: src` в tsconfig.json + факт (проверено grep'ом), что
  существующие server-модули (`binding-compat.ts`, `form-schema.ts`,
  `view-config.ts`) только **упоминают** `web/src/...` в комментариях
  как «зеркалируемый» источник, но НЕ импортируют его — граница
  «сборка web/ изолирована» (память `choros-run-poehali-w2-2026-07-04`:
  «Docker-честность гейта… рантайм-импорт web→src ломает контейнер»)
  реальна и уже соблюдается конвенцией «один клиентский модуль
  зеркалит один серверный каталог» (ровно как `field-contract.js` ↔
  `binding-compat.ts`).

Вывод: система уже построена по правильному скелету. Не хватает ТОЛЬКО
(1) визуальной точности drop-preview + подсветки + автоскролла +
fullscreen на клиенте и (2) программного шва по ту же семантику ops на
сервере. Переписывать канвас с нуля — не нужно и рискованно (уже есть
912 строк протестированного поведения: multiselect, undo, tabs, broken-
key highlight, inspector-driven-by-registry).

## 3. Решение — ОДИН канвас, усиленный на месте

**НЕ форкаем отдельный канвас-компонент.** FormDesigner.jsx остаётся
единственным человеческим драйвером; меняем только слой визуальной
обратной связи внутри него:

1. `DropSlot` → `DropIndicator` — та же роль (path-aware insertion
   target), но:
   - высота/видимость реагируют на `dragover` РЕЗУЛЬТАТОМ (полоса на всю
     ширину контейнера-приёмника, не 6px), позиционируется по midpoint
     курсора относительно соседних узлов (используем existing `onDragOver`
     + `getBoundingClientRect` половину-проверку — чистая доп. логика в
     компоненте, ноль изменений в `form-document-ops.js`);
   - контейнер-приёмник (обёртка `ChildrenCanvas`/`TabsCanvas`) получает
     `data-drop-target-active` класс/атрибут → CSS через `--chs-*`
     (граница/фон) — целевой контейнер виден целиком, не только щель.
2. `CanvasNode` (уже `draggable`) — без изменений в семантике переноса
   (`reorder` kind → `moveNode`/`reorderNode`, как сейчас); только
   визуальная связь через тот же `DropIndicator`.
3. Автоскролл: новый маленький хук `useCanvasAutoscroll(canvasRef)` —
   слушает `dragover` на канвасе, если курсор в «горячей зоне» у
   верхнего/нижнего края скроллящегося родителя — гонит
   `requestAnimationFrame` цикл, прирост скролла пропорционален
   расстоянию до края; останавливается на `dragleave`/`drop`/unmount.
   Чистая DOM-механика, не трогает документ.
4. Клавиатура: расширяем существующий `onKeyDown` в `CanvasNode` —
   `ArrowUp`/`ArrowDown` (без Alt, когда фокус на самом узле, а не на
   input) вызывают те же `onMoveUp`/`onMoveDown`; `Cmd/Ctrl+X` вызывает
   новый `cutSelected()` (снимает узел через `removeNode`, кладёт JSON-
   копию в `clipboardRef`), `Cmd/Ctrl+V` — `pasteClipboard()` (вставляет
   через `insertNode` после текущего выделения). ОБА — тонкие обёртки
   над уже существующими ops, ноль новой мутационной логики.
5. Live-region: `<div aria-live="polite" className="chs-sr-only">` в
   FormDesigner, текст обновляется при каждом commit-е перемещения
   (`«Блок «X» перемещён в «Y», позиция N из M»`) — человеческий текст,
   не путь.
6. Fullscreen: `isFullscreen` локальный state + CSS-класс на `<main>`
   (`position:fixed; inset:0; z-index` через токен), кнопка-toggle в
   тулбаре канваса + `Escape` слушатель. Палитра/инспектор остаются
   в DOM (не удаляются) — в fullscreen канвас растягивается, но чтобы не
   потерять доступ к палитре/инспектору, тулбар канваса в fullscreen
   получает узкую боковую вкладку-переключатель («Показать поля» /
   «Показать свойства») — простой toggle, не отдельный компонент.

Почему не отдельный канвас: (a) 912 строк уже несут протестированное
поведение (undo, multiselect, broken-key, registry-driven inspector),
дублирование = риск рассинхронизации; (b) фаундер разрешил «отдельный
канвас», ЕСЛИ так чище — здесь чище НЕ форкать, потому что весь новый
UX — это слой ВОССТАНОВЛЕНИЯ ОБРАТНОЙ СВЯЗИ (где визуально упадёт узел),
а не новая модель поведения; сама модель (ops) уже разделяемая и
переиспользуется без изменений.

## 4. Машинный шов — HTTP-эндпоинт поверх ТЕХ ЖЕ ops + ТОГО ЖЕ гейта

### 4.1 Почему НЕ рантайм-импорт web/src/forms/form-document-ops.js

`rootDir: src` в tsconfig.json + изоляция сборки (web-builder не видит
src/ и наоборот, доказано на прошлых задачах: «web-builder изолирован до
web/, рантайм-импорт web→src ломает контейнер»). Импортировать
JS-модуль из web/ в серверный TS — сломать Docker-сборку сервера
(разные бандл-границы). Значит — **зеркалирование**, как уже принято в
кодовой базе (`binding-compat.ts` мирро́рит `field-contract.js`,
`form-schema.ts` мирро́рит `form-defs.js`, с комментарием-обязательством
+ CI-гейтом сверки).

### 4.2 Новый серверный модуль: `src/core/form-document-ops.ts`

TS-порт четырёх операций 1:1 с клиентским `form-document-ops.js`:
`insertNode, removeNode, reorderNode, updateNode, moveNode,
moveNodeAcross, nodeAtPath` — тот же path-model (число | `{tab,index}`),
та же иммутабельность (структурное расшаривание нетронутых поддеревьев),
ТЕ ЖЕ имена функций и сигнатур (порт, не переизобретение). Комментарий
в шапке файла — явное обязательство синхронизации с клиентским
модулем, как у `binding-compat.ts`.

**Паритет доказан тестом, а не только декларацией**: новый
`src/__tests__/form-document-ops-parity.test.ts` прогоняет ОДИН И ТОТ
ЖЕ набор тест-векторов (несколько insert/move/reorder/remove сценариев,
включая nested columns/tabs) через:
  (a) `web/src/forms/form-document-ops.js` (импортируется в vitest,
      т.к. тестовый раннер не подчиняется рантайм-границе сборки — это
      статическая проверка эквивалентности, а не деплоймый код);
  (b) `src/core/form-document-ops.ts`;
и сравнивает результат `JSON.stringify` — байт-идентичность. Если один
файл правится, а другой — нет, тест красный. Это даёт то, чего не даёт
голый комментарий: механическую гарантию, что дрейф не пройдёт незаметно.

### 4.3 Новый роут: `POST /api/forms/document-ops`

`src/http/forms-document-ops.ts`, регистрируется в `server.ts` рядом с
`registerBindingRoutes` (те же deps: pool, resolveActorTenant).

```
POST /api/forms/document-ops
body: { processKey, stepKey, op: { kind, ...opArgs } }

kind ∈ { insert, remove, reorder, update, move }  (closed vocabulary)
  insert:  { containerPath, node, index?, tabIndex? }
  remove:  { containerPath, index, tabIndex? }
  reorder: { containerPath, fromIndex, toIndex, tabIndex? }
  update:  { containerPath, index, patch, tabIndex? }
  move:    { fromPath, toPath, fromTab?, toTab? }

→ 200 { layout, version }
→ 400 VALIDATION      (malformed op / unknown kind — fail-closed)
→ 404 NOT_FOUND       (нет form_binding для processKey+stepKey — нечего патчить)
→ 409 WRONG_FLOOR     (classifyFloorBoundary говорит Floor-2 — та же причина/формат,
                        что уже выдаёт POST /api/forms/binding)
→ 401 / 403           (тот же extractActorSlug + checkRole, что у /api/forms/binding)
```

Обработчик:
1. auth (withAuth) + `extractActorSlug` — тот же, что в `binding.ts`.
2. `resolveActorTenant(actor)` → tenantId (тот же паттерн).
3. в транзакции (`withTenantTx`, тот же helper, экспортированный из
   `binding.ts`) — `checkRole` (тот же `process_designer`/dev-конвент).
4. читает текущий `form_binding` (переиспользует `getBinding` — либо
   экспортируем её из `binding.ts`, либо инлайним идентичный SELECT;
   решение: **экспортируем**, чтобы не дублировать SQL).
5. если `layout` пуст/отсутствует → 404 (нечего патчить агенту — сначала
   форма должна существовать, создание с нуля — отдельный сценарий,
   вне скоупа F8, см. out_of_scope).
6. применяет `op` через `src/core/form-document-ops.ts` → новый layout.
7. прогоняет новый layout через **тот же** `classifyFloorBoundary`
   вызов, что стоит в `binding.ts` (`layoutFloorOp` с `kind:
   "relabel_field"`, `changedKeys` = тот же whitelist, `schemaView` из
   `resolveLiveSchemaFieldKeys`) — буквально копия блока (вынесен в
   переиспользуемую функцию `classifyLayoutSave(client, tenantId,
   processKey, layout)` в `binding.ts`, экспортирован, вызывается из
   обоих роутов — НЕ вторая копия проверки).
8. если Floor-2 → 409 (не сохраняет). Иначе — upsert (тот же SQL,
   version+1) → 200.

Это даёт «машина работает как сотрудник, не как привилегированный
канал»: тот же auth, та же роль, тот же контентный гейт, что видит
человек через FormDesigner.

### 4.4 MCP / tool-обёртка — FINDINGS, не в этой задаче

Полноценный MCP-сервер или Anthropic tool-descriptor для ассистента —
отдельная обвязка (см. паттерн `assistant-configurator.ts`
`ToolDeclaration` + `CONFIGURATOR_TOOLS` — там уже есть 8 инструментов
конфигуратора того же типа). T-0656 строит рабочий HTTP-шов и доказывает
паритет; регистрация `document-ops` как ещё одного `ToolDeclaration` в
`assistant-configurator.ts` (по образцу `TOOL_AUTHOR_BINDING`) —
следующий шаг, заведён как FINDING в PR-handoff, не раздувается сюда
(дисциплина «рабочий шов + тест паритета важнее полноты»).

## 5. Дисциплина

- **Анти-кейс (D-064)**: ни один слаг сделки/закупки не появляется в
  новых файлах; палитра/шов остаются générique.
- **UX-гейт OBLIK**: подсветка контейнера-приёмника и полоса-плейсхолдер
  — только `--chs-*` токены (не хардкод hex); кнопка fullscreen — видимый
  рабочий контрол (не заглушка); русские подписи.
- **Не второй гейт**: `classifyFloorBoundary` остаётся ЕДИНСТВЕННЫМ
  судьёй Floor-1/2 для layout — новый роут ВЫЗЫВАЕТ его, не пишет
  параллельную проверку.
- **Не второй мутатор**: человек и машина проходят через ОДИН набор
  чистых ops (клиент: `form-document-ops.js`; сервер: TS-порт,
  доказанный паритетным тестом) — не два разных алгоритма вставки/сдвига.

## 6. Риски / компромиссы

- TS-порт ops — это дублирование КОДА (не контракта): признанный
  компромисс сборочной изоляции (web/src не шарят рантайм). Параллель
  смягчена механическим parity-тестом, а не только комментарием —
  дрейф ловится CI, а не на глаз.
- HTTP document-ops не создаёт form_binding с нуля (только патчит
  существующий) — сознательно узкий периметр (out_of_scope), чтобы не
  раздувать задачу; агент, желающий создать форму с нуля, использует
  `POST /api/forms/binding` с полным layout (уже существует) или
  will-be MCP-обёртку emit-seam (T-0545 уже даёт `emitSurfaceLocal`).
