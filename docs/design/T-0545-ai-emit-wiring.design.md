# DESIGN · T-0545 — AI-emit→канвас (шов подключения ассистента к реестру T-0543)

> **status:** ready (DESIGN-фаза T-0545)
> **type:** architecture (design-спека; impl-код НЕ пишется здесь)
> **spec_ref:** `docs/design/T-0543-interface-builder-surface-contract.adr.md` §4/§6/§8,
>   `docs/design/T-0543-surface-document.schema.json`,
>   `docs/design/T-0543-widget-registry.interface.ts`,
>   `docs/specs/floor-boundary.spec.md` §3.2/§3.3/§3.4,
>   `docs/specs/text-first-solution-builder.spec.md` §3.3 (G1, `emit_form` →только шов формы),
>   `web/src/forms/form-document-emit.js` (существующий эмиттер),
>   `web/src/forms/form-document.js` (`validateDocument`, `PALETTE`, `FLOOR1_DOC_NODE_TYPES`),
>   `web/src/forms/form-document-soglasovanie.test.js` (доказательство байт-идентичности бот==человек),
>   `web/src/screens/screen-assistant.jsx` (СТУБ, TODO-SEAM)
> **owns:** T-0545 (E-FORMS/Ф-C AI-emit)
> **depends on:** T-0543 (реестр + валидатор), T-0544 (канвас, приёмник документа)
> **граница с:** D8/T-0455 (assistant-configurator, весь текст-первый конструктор)

---

## 1. Контекст и проблема

Задача T-0545 замыкает шов «ассистент → форма → канвас». На 2026-06-29:

- **Эмиттер существует** (`form-document-emit.js`): `emitFormDocument(intent, fields)` принимает
  структурированный `EmitIntent` и поля живой схемы, производит v1 `form-document` через
  `nodeForField` — тот же хелпер, что использует drag-n-drop редактор. Тест
  `form-document-soglasovanie.test.js` доказывает байт-идентичность: `expect(bot).toEqual(human)`.
- **Экран ассистента** (`screen-assistant.jsx`) — рабочий шелл (треды, сообщения, стриминг), но
  TODO-SEAM на LLM-роутинге и инструментах. Поле `intent` в ответе бота уже зарезервировано.
- **Реестр T-0543** вводит `validateSurface` + обобщённый `surface-document` v2; эмиттер нужно
  поднять с v1-`form-document` до v2-`surface-document` и нацелить на реестр дескрипторов.
- **Канвас T-0544** будет принимать `surface-document` и открывать его в редакторе.

**Проблема:** нет спроектированного шва — где живёт инструмент `emit_surface`, как он вызывается
из ассистента, как результат попадает на канвас и какие гарантии безопасности при кодовом выводе AI.

---

## 2. Граница: только форма-эмиттер шов (не весь D8)

| Здесь (T-0545) | Там (D8 / T-0455) |
|---|---|
| Инструмент `emit_surface` конфигуратора: входной контракт, обработка вывода LLM | Весь текст-первый сборщик решений (G1-G6): `create_application`, каскад связанных приложений, генерация BPMN-процесса, bundle-promote |
| Подключение результата к канвасу T-0544 (открыть surface-document в редакторе) | Роутинг интентов (построй/собери → конфигуратор), авторизационный гейт `authoring_draft` |
| Флаг Floor-2 для кодового/custom вывода | Floor-2 sandbox-iframe рендер (T-0076/T-0101, уже реализован) |
| Деградация: LLM недоступен или вывод невалидный | Весь assistant-configurator.ts инструментарий |
| Шов `emit_surface` → `validateSurface` (общий путь, не параллельный) | Инструменты `author_binding`, `author_dmn`, `request_promote` |

**Принцип:** T-0545 проектирует ТОЛЬКО инструмент-шов эмиссии формы/поверхности.
`emit_surface` — один из инструментов конфигуратора; остальные G1-G6 — вне охвата.

---

## 3. Где живёт инструмент `emit_surface`

### 3.1 Слой (server-side)

`emit_surface` — **серверный инструмент** конфигуратора (`src/assistant/assistant-configurator.ts`,
существующий модуль T-0455). Живёт рядом с `edit_jsonschema` / `emit_form` (сегодняшний стаб).

Принципы размещения:
- **Чистая функция core**: `emitSurface(intent: EmitSurfaceRequest, registry: WidgetRegistry,
  schema: LiveSchemaView): EmitSurfaceResult` — без I/O, без React. Тестируема в Node.
- **Серверный вызов**: инструмент вызывается в теле POST `/api/assistant/threads/:id/messages`,
  когда LLM-ответ содержит `tool_use` вызов `emit_surface`.
- **Результат в ответе**: server отвечает обогащённым сообщением с полем `surface` (v2 документ)
  + полем `floor2Flag` (boolean) + `validationErrors` (array) + `deepLinks`.

### 3.2 Клиентский шев (screen-assistant.jsx)

Серверный ответ уже структурирован с полем `intent`. T-0545 добавляет поле `surface` в ответ.
В `MessageBubble` (screen-assistant.jsx) — новая ветка: если `msg.surface` присутствует →
показать кнопку «Открыть в конструкторе» (deep-link на канвас T-0544), а не рендерить форму
внутри чата.

```
msg.surface присутствует →
  <Button onClick={() => navigate(`/constructor/${appId}?draft=${draftId}`)}>
    Открыть черновик в конструкторе
  </Button>
```

**Принцип:** документ рендерится НА канвасе T-0544, не в чате. Это согласуется с D8 §3.1 (G4):
«ревью в разделах, не в диалоге».

---

## 4. Контракт инструмента emit_surface

### 4.1 EmitSurfaceRequest (вход)

```ts
interface EmitSurfaceRequest {
  // Из чего строим: контекст приложения/схемы
  source: {
    applicationId: string;     // uuid — приложение, чьи поля использует форма
    registryDefId?: string;    // uuid — конкретный registry_def (необязателен для page)
  };
  // Вид поверхности: 'record-form' | 'step-form' | 'page'
  kind: 'record-form' | 'step-form' | 'page';
  // Опционально: шаг процесса (только kind='step-form')
  step?: { processKey: string; step: string };
  // Опционально: slug (только kind='page')
  slug?: string;
  // Декларативный layout: массив EmitBlock (тот же формат, что form-document-emit.js)
  layout?: EmitBlock[];        // если отсутствует → buildDefaultDocument (как сейчас)
  // Дополнительный контекст (откуда пришёл запрос)
  draftId?: string;            // DRAFT-бандл (D8 G1/G2; опционально для этой задачи)
}
```

`EmitBlock` — существующий тип из `form-document-emit.js` (section / columns / field / table /
readout / relation / divider / text). Расширения (list / chart / metric / action) — за T-0543 impl
фазой 3; здесь только декларируются как допустимые, проходят через реестр.

### 4.2 EmitSurfaceResult (выход)

```ts
interface EmitSurfaceResult {
  // Готовый surface-document v2 (или null при полном отказе)
  doc: SurfaceDocument | null;
  // Прошёл ли единый validateSurface (тот же путь, что человек)
  ok: boolean;
  // Ошибки валидатора (V-NODE / V-KEY / V-CONTRACT / V-WIDGET / V-SUBKEY / V-CUSTOM)
  validationErrors: Array<{ code: string; path: string; message: string }>;
  // Битые ключи (отсутствуют в живой схеме)
  brokenKeys: string[];
  // TRUE если документ содержит custom-узел (Floor-2-сигнал; §5)
  floor2Flag: boolean;
  // Честная причина отказа (для отображения пользователю)
  errorMessage: string | null;
  // Deep-link на канвас (присутствует только при ok === true || brokenKeys.length > 0)
  canvasPath: string | null;    // e.g. '/constructor/{appId}?draft={draftId}'
}
```

### 4.3 Внутренний поток (impl-схема, не блокирует)

```
LLM tool_use emit_surface
  → emitSurface(request, registry, schema)
      → emitFormDocument(intent, fields)      ← СУЩЕСТВУЮЩИЙ (form-document-emit.js)
          → nodeForField (тот же хелпер, что человек)
      → coerceToSurface(doc v1 → v2)           ← T-0543 (impl фаза 0)
      → validateSurface(doc, fields, registry) ← ТОТЖЕ ПУТЬ, что человек в конструкторе
      → classifyFloorBoundary(op, schema)      ← floor-boundary.spec §3.2 (impl T-0402)
          R-3: hasCodeSignal → floor2Flag = true
      → return EmitSurfaceResult
  → сервер: сохранить doc в DRAFT-слот (draftId)
  → сервер: ответ с { surface: doc, floor2Flag, validationErrors, canvasPath }
```

**Ключевое:** `validateSurface` — ТОТ ЖЕ вызов, что идёт от человека из конструктора.
Нет параллельного валидатора для бота. Это — load-bearing инвариант (FF-T0545-SAME-GATE).

---

## 5. Граница безопасности: Floor-классификатор

### 5.1 Кодовый/custom вывод AI

Если LLM эмитит `custom`-узел (`type: "custom"`, `componentId`, `reactSource`):

1. `hasCodeSignal(doc) === true` (floor-boundary §3.4 детектор — структурный, не эвристика).
2. `classifyFloorBoundary` возвращает `floor: '2'`, `route: 'sandbox'`.
3. `EmitSurfaceResult.floor2Flag = true`.
4. Клиент показывает предупреждение: «Черновик содержит кастомный код-виджет (Floor-2). Откроется
   в sandbox-редакторе с ограниченным доступом».
5. На канвасе T-0544: custom-узел рендерится через `Floor2Viewer.jsx` (T-0101), НЕ inline.
6. Требует `FLOOR2_CUSTOM_FLAG_KEY === 'true'` (governance-флаг). Без флага → 403/blocked,
   честная ошибка.

**Принцип:** AI не обходит Floor-классификатор. Этаж вычисляется из СОДЕРЖИМОГО документа,
не из самозаявленного LLM. Fail-up: неоднозначность → Floor-2.

### 5.2 Неизвестный fieldKey

Если LLM ссылается на `fieldKey`, отсутствующий в живой схеме (`byKey.get(fieldKey) === undefined`):
- Узел ЭМИТИРУЕТСЯ честно (как сейчас в `form-document-emit.js` `fieldNode`), не отбрасывается.
- `validateSurface` помечает как `V-KEY` / `brokenKeys`.
- `ok: false`, `brokenKeys: ['ghost_field']`.
- Канвас открывает документ с подсвеченными битыми привязками (поведение авторинга).
- Человек видит проблему и правит руками.

Принцип: честная ошибка видна, не маскируется.

### 5.3 Неизвестный тип узла (вне реестра)

Если LLM эмитит узел с `type` вне реестра T-0543 (`registry.has(type) === false`):
- `validateSurface` отклоняет: `V-NODE` error.
- `ok: false`, `doc` не сохраняется в DRAFT (полный отказ).
- `errorMessage` объясняет: «Тип узла "X" вне реестра».

Принцип: closed-by-default (T-0543 R-CLOSED). Нет implicit `default:`-узла.

---

## 6. Поток: эмиссия → тот же валидатор → канвас → правка человеком

```
[Чат ассистента]
  Пользователь: «Сделай форму заявки с позициями и итогом»
  ↓
  POST /api/assistant/threads/:id/messages
    → LLM → tool_use: emit_surface(intent)
    → emitSurface(intent, registry, schema)       [server]
        → emitFormDocument → nodeForField          [form-document-emit.js]
        → coerceToSurface(v1 → v2)                [T-0543]
        → validateSurface(doc, fields, registry)   [ОБЩИЙ ПУТЬ]
        → classifyFloorBoundary                    [floor-boundary]
    → сохранить DRAFT (draftId)
    → ответ: { text: "...", surface: doc, floor2Flag, validationErrors, canvasPath }
  ↓
[screen-assistant.jsx MessageBubble]
  ok === true:
    показать текст ответа + кнопку «Открыть в конструкторе»
  ok === false, brokenKeys:
    показать текст + предупреждение «X полей не найдено в схеме» + кнопку «Открыть и исправить»
  floor2Flag:
    показать предупреждение «Содержит кастомный виджет (Floor-2)»
  errorMessage (полный отказ):
    показать честную ошибку, предложить собрать вручную
  ↓
[Канвас T-0544]  ←  navigate(canvasPath)
  openDraft(draftId) → loadSurfaceDocument(v2)
  рендер через SurfaceRenderer + WidgetRegistry (реестр T-0543)
  человек правит drag-n-drop / инспектор
  ↓
[Сохранение]
  POST /api/constructor/surfaces/:id  (или существующий форм-save)
  тот же validateSurface перед persist
```

---

## 7. Деградация: LLM недоступен или вывод невалидный

| Ситуация | Поведение системы | Пользователь видит |
|---|---|---|
| LLM не настроен (503 от `/api/assistant/…`) | Существующий путь в screen-assistant.jsx (строка 158: 503 → честное сообщение) | «LLM не настроен — настройте BYO-ключ» |
| LLM вернул невалидный JSON для `emit_surface` | Сервер: JSON.parse fail → `{ ok: false, errorMessage: "LLM вернул невалидный формат" }` | «Ассистент не смог собрать форму. Попробуйте снова или соберите вручную.» + кнопка открыть конструктор пустым |
| `validateSurface` вернул ошибки (brokenKeys) | `ok: false`, `doc` сохранён в DRAFT с broken-маркерами | «Форма готова с ошибками привязки» + предложение открыть и исправить |
| Floor-2 без governance-флага | 403 от сервера при попытке сохранить custom-узел | «Кастомные виджеты требуют включения Floor-2. Обратитесь к администратору.» |
| LLM timeout (> N сек) | Abort + честная ошибка | «Ассистент не ответил вовремя. Попробуйте снова.» |
| Все деградации | Канвас доступен пустым | Пользователь собирает форму руками (drag-n-drop) |

**Принцип:** при любой деградации ассистента человек может собрать форму вручную на канвасе T-0544.
LLM — ускоритель, не блокировщик.

---

## 8. Граница с D8 / T-0455 (assistant-configurator)

`emit_surface` — **один инструмент** в пространстве конфигуратора. Остальное — вне T-0545:

| Аспект | T-0545 | D8 / T-0455 |
|---|---|---|
| `emit_surface` контракт + impl | Здесь | — |
| Шов результата в screen-assistant.jsx | Здесь (deep-link + floor2-badge) | — |
| Флаг Floor-2 в ответе | Здесь | — |
| Деградация emit_surface | Здесь | — |
| `create_application` (G1) | — | T-0455 / text-first-solution-builder |
| Каскад приложений (G2) | — | T-0455 |
| BPMN-генерация (G3) | — | T-0455 |
| Bundle-promote (G4) | — | T-0455 (уже в screen-assistant.jsx как TODO-SEAM) |
| Роутинг интентов (построй/собери → конфигуратор) | — | T-0455 |
| Гейт `authoring_draft` | — | T-0455 |

Если серверный LLM-роутинг для конфигуратора ещё не реализован на момент impl T-0545 →
это **impl-зависимость**: `emit_surface` регистрируется как инструмент, но LLM его не вызовет
до подключения роутинга (T-0455). Это не блокирует DESIGN T-0545 — инструмент тестируется
unit-тестом с прямым вызовом.

---

## 9. Impl-зависимости (не блокируют DESIGN)

1. **T-0543 impl (фаза 0-1):** `coerceToSurface`, `validateSurface`, `WidgetRegistry` — нужны
   для wiring. До их появления `emit_surface` работает как v1 + `validateDocument` (compat-слой).
2. **T-0544 (канвас):** `canvasPath` в ответе — статический маршрут `/constructor/:appId`;
   открытие конкретного `draftId` — impl-деталь T-0544.
3. **T-0402 (floor-boundary.ts impl):** `classifyFloorBoundary` — нужен для Floor-2-флага.
   До появления: `hasCustomNode(doc)` из `form-document.js` (уже существует) как fallback.
4. **Серверный LLM-роутинг (T-0455):** до подключения `emit_surface` вызывается только unit-тестом.
5. **DRAFT-сохранение:** конкретный endpoint для сохранения `surface-document` в DRAFT-бандл —
   за T-0455 / D8 impl. Для MVP `emit_surface` может возвращать документ inline (без persist).

---

## 10. Fitness-функции (детали в T-0545.adr.contract.json)

- **FF-T0545-SAME-GATE** — AI-вывод проходит ТОТ ЖЕ `validateSurface` (или `validateDocument`
  до T-0543-impl), что и человек. Нет параллельного AI-only валидатора.
- **FF-T0545-FLOOR2-FLAG** — кодовый вывод (`custom`-узел, `reactSource`, `componentId`) →
  `floor2Flag: true`; сохранение требует `FLOOR2_CUSTOM_FLAG_KEY`; custom рендерится в
  `Floor2Viewer`, НЕ inline.
- **FF-T0545-NO-BYPASS** — `emit_surface` не сохраняет документ при `ok === false` с
  нарушением R-CLOSED (неизвестный тип узла). Только brokenKeys → DRAFT с маркером.
- **FF-T0545-HONEST-DEGRADE** — при недоступности LLM (503) и при `errorMessage != null`:
  пользователь видит честное сообщение + кнопку открыть конструктор вручную (пустой канвас).
  Не скрытое падение.
- **FF-UX-G1** — UI-элементы шва (кнопка «Открыть в конструкторе», floor2-badge, ошибки) —
  только `--chs-*` токены и `.chs-*` классы. Без hardcoded цветов.
