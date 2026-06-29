# T-0528 — Единая система обратной связи: ToastProvider + один app-root ToastViewport

> Статус: DESIGN (architect) · Дата: 2026-06-29
> Задача: T-0528 · Эпик: T-0525 UX-debt

---

## 1. Контекст и проблема

UX-аудит 2026-06-29 (§Топ-15 #3, §Пробелы дизайн-системы) зафиксировал:

- **Нет ToastProvider/контекста** — каждый экран вынужден сам вызывать `useToasts()+<ToastViewport>`, большинство этого не делает.
- Последствия распределены по всем 6 областям (~30+ файлов):
  - Успешные операции (сохранение, создание, публикация) не дают обратной связи.
  - Ошибки выводятся через блокирующий `window.alert()` (shell/audit-export, ra-sod).
  - Ошибки только в `console.error` — никогда не видны пользователю (screen-assistant.jsx CRUD тредов).
  - Баннеры «Сохранено» зависают и устаревают после редактирования.
  - Авто-гашение 4000ms без паузы на ховер — error-тосты пропадают до прочтения.
  - Двойные `<ToastViewport>` в разных ветках дерева (showcase.jsx, screen-org.jsx, ra-criticality.jsx) — нарушение «один вьюпорт».

Kit в `components.jsx` **уже содержит** `Toast`, `ToastViewport`, `useToasts` — примитивы готовы. Задача: добавить провайдер/контекст ПОВЕРХ них, не изменяя сами примитивы.

---

## 2. Решение — архитектура

### 2.1 Новые файлы (создаёт impl)

```
web/src/app-shell/
  toast-context.jsx      ← ToastProvider + ToastContext + useToastContext
```

### 2.2 ToastProvider и ToastContext

`toast-context.jsx` создаёт `React.Context` с API:

```js
// Контракт контекста
const ToastContext = React.createContext(null);

// Хук для потребителей
function useToastContext() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToastContext: нет ToastProvider в дереве');
  return ctx; // { push, dismiss }
}
```

`ToastProvider` вызывает **один раз** `useToasts({ duration: 4000 })` из kit и:
1. Кладёт `{ push, dismiss }` в `ToastContext`.
2. Рендерит **единственный** `<ToastViewport>` в самом конце своего JSX (ниже `{children}`), чтобы тосты плавали над всем деревом.

### 2.3 Точка монтирования — AppShell (shell.jsx)

`ToastProvider` оборачивает `<CrumbContext.Provider>` в `AppShell`:

```jsx
// shell.jsx — authenticated branch
return (
  <ToastProvider>
    <CrumbContext.Provider value={crumbCtx}>
      <div className="chs-shell">
        ...
      </div>
      {/* ToastViewport монтируется ВНУТРИ ToastProvider, СНАРУЖИ chs-shell,
          чтобы тосты не обрезались overflow:hidden боковой панели */}
    </CrumbContext.Provider>
  </ToastProvider>
);
```

Портал не нужен: `chs-toast-viewport` имеет `position:fixed`, он выходит из stacking context.

### 2.4 Как любой компонент пушит тост

```js
// в любом экране/компоненте:
import { useToastContext } from '../app-shell/toast-context.jsx';

function MyScreen() {
  const { push } = useToastContext();

  async function handleSave() {
    try {
      await api.save(data);
      push({ tone: 'success', title: 'Сохранено', duration: 4000 });
    } catch (err) {
      push({ tone: 'error', title: 'Ошибка сохранения', message: err.message, duration: 0 });
    }
  }
}
```

Никакой локальной обвязки (`useToasts`, `<ToastViewport>`) не нужно.

---

## 3. Политика severity и a11y live-regions

| Tone | `role` | `aria-live` | Авто-гашение | Условие |
|------|--------|-------------|--------------|---------|
| `success` | `status` | `polite` | 4000ms (дефолт) | Гасится, pause-on-hover опционален |
| `info` | `status` | `polite` | 5000ms | — |
| `warning` | `alert` | `assertive` | **нет** (duration:0) | Требует ручного закрытия |
| `error` | `alert` | `assertive` | **нет** (duration:0) | Требует ручного закрытия |

**Pause-on-hover/focus**: `ToastProvider` расширяет `useToasts` — для тостов с `duration > 0` подвешивает таймер через `clearTimeout` при `pointerenter`/`focus` на viewport и возобновляет при `pointerleave`/`blur`. Это решает проблему «error исчезает до прочтения».

Реализация в `ToastProvider`:

```js
// В ToastProvider:
const pausedRef = useRef(false);
const timersRef = useRef({}); // id → timerId

function scheduleAutoDismiss(id, duration) {
  timersRef.current[id] = setTimeout(() => dismiss(id), duration);
}

function pauseAll() { 
  pausedRef.current = true;
  Object.values(timersRef.current).forEach(clearTimeout);
}
function resumeAll(toastList) { 
  pausedRef.current = false;
  toastList.forEach(t => {
    if (t.remainingMs > 0) scheduleAutoDismiss(t.id, t.remainingMs);
  });
}
```

`<ToastViewport>` получает пропы `onPointerEnter`/`onPointerLeave` → вызывает `pauseAll`/`resumeAll`.

**Contiguous live-region**: `ToastViewport` — единственный live-region в дереве. Двойные вьюпорты запрещены (FF-TOAST-ONE-VIEWPORT).

**Контраст AA**: цвета тостов через `--chs-color-success`, `--chs-color-danger`, `--chs-color-warning` (токены, обе темы проверены).

---

## 4. Паттерн адопции — чем заменять

### 4.1 `window.alert()` → `push({ tone: 'error', duration: 0 })`

**Файлы с `window.alert()`:**
- `web/src/app-shell/shell.jsx` — `downloadAuditLog()` (3 вызова)
- `web/src/screens/rights/ra-sod.jsx` — `window.confirm(...)` + flow

**Замена `downloadAuditLog` (shell.jsx ~248–274):**

```js
// БЫЛО:
if (res.status === 401) { alert('Войдите в систему…'); return; }
if (!res.ok)            { alert(`Ошибка экспорта: HTTP ${res.status}`); return; }
// при catch:            alert('Не удалось выполнить экспорт…');

// СТАНЕТ:
// downloadAuditLog принимает push из контекста (или передаётся колбэком из Topbar)
async function downloadAuditLog(push) {
  try {
    const res = await fetch('/api/audit/export', { headers: devHeaders() });
    if (res.status === 401) {
      push({ tone: 'error', title: 'Сессия истекла', message: 'Войдите в систему снова.', duration: 0 });
      return;
    }
    if (!res.ok) {
      push({ tone: 'error', title: 'Ошибка экспорта', message: `Сервер вернул ${res.status}.`, duration: 0 });
      return;
    }
    // ... blob download ...
    push({ tone: 'success', title: 'Лог экспортирован' });
  } catch {
    push({ tone: 'error', title: 'Не удалось экспортировать лог', duration: 0 });
  }
}
```

`Topbar` и `screen-audit.jsx` вызывают `downloadAuditLog(push)`, где `push = useToastContext().push`.

**Замена `window.confirm` (ra-sod.jsx ~90):**

```js
// БЫЛО: if (!window.confirm('Удалить правило…?')) return;
// СТАНЕТ: открыть kit <ConfirmDialog> (tone="danger")
// При подтверждении — выполнить DELETE и:
push({ tone: 'success', title: 'Правило SoD удалено' });
// При ошибке:
push({ tone: 'error', title: 'Не удалось удалить', message: err.message, duration: 0 });
```

### 4.2 `console.error` → `push({ tone: 'error', duration: 0 })`

**Файл:** `web/src/screens/screen-assistant.jsx:789`

```js
// БЫЛО:
console.error('Failed to create thread:', err);

// СТАНЕТ:
push({ tone: 'error', title: 'Не удалось создать тред', message: err.message, duration: 0 });
```

### 4.3 Inline sticky-баннеры → push + очистка при редактировании

Паттерн: `const [saved, setSaved] = useState(false)` → баннер «Сохранено» зависает.

```js
// Замена:
// 1. Убрать saved/setSaved
// 2. При успехе:
push({ tone: 'success', title: 'Черновик сохранён', duration: 4000 });
// 3. При редактировании — никаких дополнительных действий: тост авто-гаснет
```

Если inline-баннер остаётся (технически нужен для контекста внутри формы) — очищать при первом изменении поля: `onChange={() => { setSaved(false); ... }}`.

---

## 5. Очистка stale success на редактировании

Единое правило: **success тост не «застревает»** — он авто-гасится через 4000ms. Это само по себе решает проблему stale-баннеров при переходе к ToastProvider.

Для inline-элементов (progress-banner внутри формы, не через тост):
- Компонент формы сам сбрасывает свой `savedState` при любом `onChange` поля.
- ToastProvider **не управляет** inline-состоянием экранов — это ответственность экрана.

---

## 6. Undo-тост (задел для T-0526 reversible bulk)

Контракт action-тоста с кнопкой отмены:

```js
// Сигнатура push() — расширяет kit Toast.action:
push({
  tone: 'info',
  title: 'Роли назначены (3)',
  duration: 6000,
  action: (
    <button
      type="button"
      className="chs-toast__undo"
      onClick={() => {
        dismiss(toastId);
        undoBulkAssign();
      }}
    >
      Отменить
    </button>
  ),
});
```

`action` — уже поддерживаемый проп `<Toast action={...}>` (components.jsx:519). Реализация undo-логики — в экране T-0526, не в ToastProvider.

`push()` возвращает `id` тоста:
```js
const toastId = push({ ... });
```

Это уже есть в текущем `useToasts` (idRef). Контекст проксирует `id`.

---

## 7. Существующие импортёры useToasts — совместимость

Три места сейчас самостоятельно используют `useToasts` + `<ToastViewport>`:

| Файл | Строки | Статус после T-0528 |
|------|--------|---------------------|
| `web/src/design/showcase.jsx` | 346, 476 | Оставить (showcase — изолированный стенд вне AppShell, свой viewport допустим) |
| `web/src/screens/screen-org.jsx` | 520, 650 | Мигрировать: убрать локальный `useToasts`/`<ToastViewport>`, использовать `useToastContext()` |
| `web/src/screens/rights/ra-criticality.jsx` | 167, 276 | Мигрировать: аналогично |

**Правило:** showcase.jsx — единственное исключение (живёт вне AppShell, standalone стенд). Все остальные файлы с `useToasts` мигрируются на `useToastContext`.

**Обратная совместимость `useToasts`**: сам хук `useToasts()` и `<ToastViewport>` из `components.jsx` **не меняются**. `ToastProvider` использует их внутри. Это гарантирует, что showcase.jsx продолжает работать без изменений.

---

## 8. Точки проверки (для impl и CI)

1. **Grep-гард**: ни один коммит не вводит новые `window.alert(` / `window.confirm(` в `web/src` (кроме тестов).
2. **Grep-гард**: ни один `console.error(` / `console.warn(` в screen-файлах не является конечным исходом операции для пользователя — допустим только как дополнение к `push(...)`.
3. **Единственность viewport**: `grep -rn "ToastViewport" web/src --include="*.jsx"` должен давать ровно 2 вхождения: `toast-context.jsx` (рендер) + `components.jsx` (определение). Showcase — исключение-константа.
4. **Контраст AA**: тосты tone=error/warning — `--chs-color-danger` / `--chs-color-warning` дают >= 4.5:1 на `--chs-color-bg-overlay`.
5. **role=alert на error/warning**: `<Toast tone="error">` рендерит `role="alert" aria-live="assertive"` — уже в kit (components.jsx:521).

---

## 9. Ограничения и исключения

- **Login/Register экраны** (перед AppShell) — тосты недоступны; там используется inline `authError` state (существующий паттерн, не меняется).
- **Formы в iframe** (screen-forms.jsx) — sandbox разрывает контекст; форма общается с хостом через `postMessage`; хост (AppShell) получает событие и вызывает `push()` сам.
- **showcase.jsx** — изолированный стенд дизайн-системы, имеет право на собственный `useToasts` + `<ToastViewport>`.

---

*Спека готова для impl (T-0528-impl). Контракт-хэндофф: `docs/design/T-0528.adr.contract.json`.*
