# ADR T-0101 — Формы в изолированном sandbox-iframe (opaque origin) + origin-валидированная авто-высота

- **status:** ready
- **task:** T-0101 (build)
- **spec:** `docs/specs/T-0101-forms-sandbox-iframe.spec.md`

## Контекст

Рантайм-форма (form-js разметка + инлайн-рантайм-скрипт) исполняется внутри
`srcdoc`-iframe. Контент формы — недоверенный (конфиг тенанта / AI-генерация
Stage-3). Изоляционный seam уже частично существует
(`web/src/forms/FormViewer.jsx`, `web/preview/forms.html`,
`web/src/forms/form-defs.js`), но имеет дыры:

1. iframe помечены `sandbox="allow-scripts"` (опаковый origin — ✔), но это нигде
   статически не зафиксировано → регрессия (кто-то добавит `allow-same-origin`)
   не ловится.
2. Родительский `message`-приёмник проверяет `e.source`, но **не `e.origin`** и
   не границы/конечность высоты → любой фрейм/расширение может спамить
   height-сообщения; скомпрометированная форма может раздуть iframe (DoS).
3. Логика приёмки размазана по двум разным обработчикам (React + ванильный
   preview) и не покрыта тестами.

## Решение

**1. Чистая функция-приёмник `acceptFrameHeight` (новый модуль
`web/src/forms/frame-height.js`).**

Единственный источник истины для «можно ли принять это height-сообщение и какую
высоту применить». IO-free, тестируемая без DOM/jsdom-фреймов:

```js
// frame-height.js
export const FRAME_MIN_HEIGHT = 280;
export const FRAME_MAX_HEIGHT = 20000; // анти-DoS верхняя граница

// Принимает событие-подобный объект и ожидаемый contentWindow.
// Возвращает заклампленную высоту (number) ЕСЛИ сообщение валидно,
// иначе null (= игнорировать).
export function acceptFrameHeight(evt, expectedSource) {
  if (!evt || evt.source !== expectedSource) return null;     // SI-2 source
  if (evt.origin !== 'null') return null;                     // SI-2 opaque origin
  const d = evt.data;
  if (!d || d.type !== 'fjs-height') return null;             // SI-2 shape
  const h = d.h;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null; // SI-3 finite
  return Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(h))); // SI-3 clamp
}
```

`origin === 'null'` — это и есть подпись опакового origin: sandboxed iframe без
`allow-same-origin` всегда постит `event.origin === "null"` (строка). Сообщение с
любым другим origin (реальный фрейм, расширение, опечатка-конфигурация) —
отбрасывается.

**2. `FormViewer.jsx` и `forms.html` используют `acceptFrameHeight`.**

Оба родительских обработчика делегируют в одну функцию. React-компонент
импортирует её; ванильный preview — тоже (через `<script type="module">` или
инлайн-копию минимальной проверки; preview не бандлится Vite, поэтому там
дублируется минимальная origin-проверка, а fitness-гейт следит, что обе
поверхности валидируют origin).

iframe-атрибут остаётся `sandbox="allow-scripts"` (БЕЗ `allow-same-origin`) —
зафиксировано тестом и FF-FORMS2.

**3. `form-defs.js` — payload минимизируется, target-origin документируется.**

Внутри sandbox ребёнок постит `parent.postMessage({type:'fjs-height', h}, '*')`.
Target-origin `'*'` остаётся (ребёнок надёжно не знает origin родителя, а тело —
только высота, не секрет), но: (a) ребёнок шлёт РОВНО `{type,h}` (никаких других
полей/данных), (b) комментарий фиксирует инвариант. Защита — на родителе (он
валидирует, кто прислал).

**4. Статический гейт `ci/checks/forms-sandbox-iframe.sh` (FF-FORMS2).**

- FF-FORMS2-1: каждый form-iframe (FormViewer.jsx `sandbox=...`, оба в forms.html)
  содержит `allow-scripts` и НЕ содержит `allow-same-origin`.
- FF-FORMS2-2: чистый приёмник `frame-height.js` существует и валидирует
  `origin` (греп `origin` + `'null'`), клампит (`FRAME_MAX_HEIGHT`).
- FF-FORMS2-3: оба родительских приёмника (FormViewer.jsx + forms.html)
  ссылаются на origin-валидацию (греп `origin` в их message-обработчиках).
- `--self-test`: синтетический iframe с `allow-same-origin` И синтетический
  приёмник без origin-проверки → RED.

## Отвергнутые альтернативы

| Вариант | Почему нет |
| --- | --- |
| Добавить `allow-same-origin` «чтобы упростить замер высоты» | Прямое уничтожение sandbox (SI-1, red-line). Опаковый origin — вся суть задачи. |
| Доверять любому `postMessage` с `type==='fjs-height'` | Любой фрейм/расширение спамит height; нет источника/origin-проверки → origin-confusion. Отвергнуто (SI-2). |
| Резолвить реальный origin родителя в ребёнке и слать его как target | Ребёнок в опаковом origin не знает origin родителя надёжно; `'*'` + строгая родительская валидация безопаснее и проще. |
| Без верхней границы высоты | Скомпрометированная форма постит `h=1e9` → iframe раздут, DoS вёрстки. MAX-кламп обязателен (SI-3). |
| Слушать `message` без проверки `e.source` | Любой iframe на странице может ресайзить чужой viewer. Source-match обязателен. |
| Инлайнить проверку в каждый обработчик без общей функции | Дрейф двух копий логики, не тестируемо. Чистая `acceptFrameHeight` = single source + unit-покрытие. |

## Объектная модель

- **`acceptFrameHeight(evt, expectedSource) → number | null`** (`web/src/forms/frame-height.js`)
  — чистый приёмник. `evt`: `{ source, origin, data:{type,h} }`-подобный.
  Возврат: заклампленная высота или `null` (игнор).
- **`FRAME_MIN_HEIGHT = 280`, `FRAME_MAX_HEIGHT = 20000`** — границы клампа.
- **fjs-height message:** `{ type: 'fjs-height', h: number }` — единственная
  форма, принимаемая родителем.

## Fitness-функции

- **FF-FORMS2** (`ci/checks/forms-sandbox-iframe.sh`) — статические
  sandbox-инварианты (SI-1, origin-валидация, клампинг), `--self-test`.
- **FF-FORMS1** (`forms-schema-binding.sh`) — без изменений, остаётся зелёным
  (серверная валидация не тронута).
- **frozen-checks-immutable.sh** — byte-frozen не тронут.

## Трассируемость

| AC | Артефакт |
| --- | --- |
| AC-1 (SI-1 no allow-same-origin) | FF-FORMS2-1 + `frame-height.test.js` строка sandbox |
| AC-2 (SI-2 origin/source/shape) | `acceptFrameHeight` + `frame-height.test.js` |
| AC-3 (SI-3 clamp/finite) | `acceptFrameHeight` + `frame-height.test.js` |
| AC-4 (авто-высота применяется) | `FormViewer.jsx` onMessage + `frame-height.test.js` |
| AC-5 (гейт+self-test) | `ci/checks/forms-sandbox-iframe.sh` |
| AC-6 (валидация/frozen) | FF-FORMS1 + frozen-checks-immutable (unchanged) |
| AC-7 (гейты) | tsc/eslint/build/fitness/vitest |

## runtime_target

Браузер (web). Чистый приёмник тестируется в Node/vitest без DOM. Гейт —
статический bash-grep. Live-инфра не требуется.

## Эскалация

Нет. Изменение аддитивно, byte-frozen не трогается, infra не нужна.
