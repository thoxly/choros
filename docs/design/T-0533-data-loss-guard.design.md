# DESIGN · T-0533 — Data-Loss Guard: несохранённые правки + optimistic-расхождение

> **status:** ready (DESIGN-фаза, architect)
> **эпик:** T-0525 (системный UX-аудит)
> **связи:** T-0526 (ConfirmDialog — переиспользуется для guard-диалога), T-0544 (canvas undo/redo → dirty-источник), T-0528 (Toast — undo-тост)
> **severity исходного аудита:** medium (§топ-14, охват ~6 файлов)

---

## 1. Контекст и проблема

UX-аудит 2026-06-29 §14 зафиксировал несколько взаимосвязанных проблем потери данных:

1. **BPMN-редактор** (`screen-process-editor.jsx`): `isDirty` уже отслеживается через EventBus `commandStack.changed`, но **ничто не блокирует** уход со страницы — ни `beforeunload`, ни react-router route-guard. Индикатор «несохранённые изменения» в тулбаре декоративен.

2. **Дизайнер форм** (`FormDesigner.jsx`): нет флага `isDirty` вовсе. `setDoc(...)` меняет `doc` в стейте, но нет сравнения с последним сохранённым состоянием. Уход — немая потеря работы.

3. **Ассистент, prompt-редактор** (`screen-assistant.jsx`, T-0361): при смене провайдера/перезагрузке данных typed-but-unsaved текст перезаписывается — «overwrite despite edit».

4. **Отчёты / promote** (`screen-reports.jsx`, строки ~798–813): при ошибке промоута (не 401/403) код всё равно вызывает `onSaved({ tier: 'published' })` — **оптимистичное «опубликован»** оседает в UI несмотря на серверный отказ. Строитель (`ReportBuilder`) размонтируется и пользователь не видит ошибки.

5. **Ассистент bundlePromote** (`screen-assistant.jsx`, `handleBundlePromote`): частично закрыто (207-partial честно обрабатывается), но при сетевых ошибках `setPromoted` не ставится — это уже корректно. Доработка не требуется.

---

## 2. Dirty-State модель

### 2.1 Откуда берётся isDirty

| Редактор | Источник isDirty | Сброс |
|----------|-----------------|-------|
| BPMN-модельер (`screen-process-editor.jsx`) | Уже есть: `commandStack.changed` → `setIsDirty(true)` | `setIsDirty(false)` после успешного `handleSave` |
| Дизайнер форм (`FormDesigner.jsx`) | **Нужно добавить**: снимать snapshot `savedDocRef` при инициализации и после успешного `persistLayout`; `isDirty = !deepEqual(doc, savedDocRef.current)` | Обновлять `savedDocRef` + `setIsDirty(false)` в колбэке `persistLayout` при статусе `saved` |
| Prompt-редактор / screen-llm-connections | isDirty = typed text !== last loaded text | Сброс при успешном save или явном «Отменить» |

**Важно:** Дизайнер форм использует иммутабельные операции (`form-document-ops.js`), поэтому `deepEqual` достаточно для обнаружения изменений. Нет смысла строить отдельный stack — T-0544 добавит undo/redo историю; до T-0544 — простое сравнение с `savedDoc`.

### 2.2 Хранение «последнего сохранённого» состояния

```
// FormDesigner.jsx
const savedDocRef = useRef(initialDocument ?? null);

// при успешном persistLayout:
savedDocRef.current = doc;

// вычисление isDirty (мемо):
const isDirty = useMemo(() => {
  if (!doc || !savedDocRef.current) return false;
  return JSON.stringify(doc) !== JSON.stringify(savedDocRef.current);
}, [doc]);
```

Для BPMN: `isDirty` уже вычисляется через `commandStack.changed` — изменений не требуется.

### 2.3 Граница с T-0544 (undo-история / dirty-tracking)

T-0544 перестраивает канвас и добавляет undo/redo стек (`pushHistory`/`undo`/`redo`). После T-0544 `isDirty` для `FormDesigner` можно вычислять как `historyIndex > savedHistoryIndex`, что точнее. Граница:

- **T-0533** реализует `isDirty` через `deepEqual` (JSON-сравнение) — это корректная и достаточная заглушка до T-0544.
- **T-0544** при внедрении undo-стека ДОЛЖЕН обновить `isDirty`-вычисление, заменив deepEqual на сравнение позиции в стеке. Контракт: `FormDesigner` экспортирует `isDirty` как вычисляемое значение (не хранит его в состоянии явно), реализация может быть заменена.

---

## 3. Guard-механика: beforeunload + route-guard

### 3.1 beforeunload (закрытие вкладки / F5 / Ctrl-W)

```js
useEffect(() => {
  if (!isDirty) return;
  const handler = (e) => {
    e.preventDefault();
    e.returnValue = ''; // Браузер показывает стандартный диалог
  };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, [isDirty]);
```

Браузер по стандарту показывает свой текст (кастомизация `returnValue` игнорируется в современных браузерах) — это допустимо: `beforeunload` нужен только как последний барьер.

### 3.2 React-Router route-guard (внутренняя навигация)

React-Router v6 предоставляет `useBlocker` (стабильный, доступен с v6.4).

```js
const blocker = useBlocker(isDirty);
```

`blocker.state` принимает значения: `'unblocked'` | `'blocked'` | `'proceeding'`.

При `blocker.state === 'blocked'` показываем `<UnsavedChangesDialog>`:

```jsx
<ConfirmDialog
  open={blocker.state === 'blocked'}
  title="Несохранённые правки"
  message={
    <>
      <p>В редакторе есть несохранённые изменения.</p>
      <ConsequenceSummary
        who="Текущий сеанс редактирования"
        what="Все несохранённые правки будут потеряны"
        reversibility="Необратимо — восстановить из браузера невозможно"
      />
    </>
  }
  confirmLabel="Уйти без сохранения"
  cancelLabel="Остаться"
  tone="danger"
  onConfirm={() => blocker.proceed()}
  onClose={() => blocker.reset()}
/>
```

`ConsequenceSummary` — хелпер из T-0526 (`web/src/components/confirm-helpers.jsx`).

### 3.3 Алгоритм guard

```
isDirty?
  Нет → навигация проходит немедленно
  Да  → useBlocker блокирует навигацию
        → открывается ConfirmDialog
           Остаться  → blocker.reset() → пользователь остаётся
           Уйти      → blocker.proceed() → навигация продолжается
           (опционально) Сохранить и уйти → persistLayout().then(proceed)
```

Вариант «Сохранить и уйти» добавляется только в BPMN-редакторе (где `handleSave` уже реализован). В дизайнере форм до T-0544 — только бинарный выбор «Остаться/Уйти».

---

## 4. Optimistic-паттерн: применить → при ошибке откатить → реконсиляция

### 4.1 Общий паттерн

```
// Псевдокод
const prevSnapshot = currentState;
setCurrentState(optimisticState);           // немедленно в UI

try {
  const result = await apiCall();
  setCurrentState(reconcile(optimisticState, result)); // сверка с сервером
} catch (err) {
  setCurrentState(prevSnapshot);           // откат к snapshot
  showError(err.message);
}
```

**Принцип:** оптимистичный апдейт показывается сразу (feedback без задержки), но при любой ошибке (сетевой или серверной) состояние ОТКАТЫВАЕТСЯ к snapshot. Нельзя залипать в ложном финальном состоянии.

### 4.2 Сайт: screen-reports.jsx (promote/publish)

**Текущий баг (строки 798–813):** при ошибке promote (status != 200/401/403) код устанавливает `submitErr`, но НЕ делает `return` — далее вызывается `onSaved({ tier: 'published' })`. Строитель размонтируется, пользователь видит «опубликовано».

**Исправление:**

```js
if (promote && pageId) {
  const res = await fetch(`.../promote`, { method: 'POST', ... });
  if (!res.ok) {
    if (res.status === 401) { setSubmitErr('...'); return; }
    if (res.status === 403) { setSubmitErr('...'); return; }
    setSubmitErr(await apiErr(res, 'Отчёт сохранён, но не опубликован'));
    return; // ← ДОБАВИТЬ: не вызывать onSaved с tier='published'
  }
}

if (pageId) {
  onSaved({
    id: pageId,
    app_id: appId,
    title: title.trim(),
    floor: '1',
    tier: promote ? 'published' : 'draft',
  });
}
```

**Реконсиляция:** при ошибке промоута строитель ОСТАЁТСЯ открытым (нет `onSaved`), отображает `submitErr`. Пользователь видит честное состояние «черновик» и может повторить публикацию.

### 4.3 Сайт: screen-assistant.jsx bundlePromote

Уже частично корректен: `setPromoted(true)` вызывается только при `data.promoted === true`. Однако нет явного сброса `promoted` при повторной попытке — если пользователь попал в ошибку (promoteError) и хочет попробовать снова, кнопка должна оставаться доступной. Это UX-исправление, не откат.

**Дополнение:** добавить кнопку «Попробовать снова» при `promoteError && !promoted`.

### 4.4 Сайт: patchThread (rename/pin) в screen-assistant.jsx

```js
const handleRename = useCallback((id, newTitle) => {
  const prevTitle = threads?.find(t => t.id === id)?.title;
  // optimistic update:
  setActiveThread((prev) => (prev?.id === id ? { ...prev, title: newTitle } : prev));
  patchThread(id, { title: newTitle })
    .catch(() => {
      // rollback:
      setActiveThread((prev) => (prev?.id === id ? { ...prev, title: prevTitle } : prev));
      // toast error через T-0528
    });
}, [patchThread, threads]);
```

Сейчас `patchThread` вызывает `load()` при успехе, но при ошибке — ничего. Оптимистичный апдейт `activeThread.title` остаётся, даже если сервер вернул 500.

---

## 5. Таблица сайтов: какой guard/паттерн

| # | Файл | Ситуация | Guard/паттерн | Приоритет |
|---|------|----------|--------------|-----------|
| 1 | `screen-process-editor.jsx` | Уход с несохранённой BPMN-диаграммой | `beforeunload` + `useBlocker` + ConfirmDialog («Уйти/Сохранить и уйти/Остаться») | **P0** |
| 2 | `FormDesigner.jsx` | Уход с несохранённым дизайном формы | `beforeunload` + `useBlocker` + ConfirmDialog («Уйти/Остаться») | **P0** |
| 3 | `screen-reports.jsx` | `promote` возвращает ошибку → оптимистичный «published» | Откат: не вызывать `onSaved` при провале промоута; держать builder открытым | **P0** |
| 4 | `screen-assistant.jsx` | `patchThread` (rename/pin) ошибка | Optimistic rollback: восстановить предыдущий title/pin + toast ошибки | P1 |
| 5 | `screen-assistant.jsx` | `bundlePromote` при ошибке | Кнопка «Попробовать снова»; `setPromoted` только при явном успехе (уже так) | P1 |
| 6 | `screen-llm-connections.jsx` | Изменение провайдера перезаписывает typed endpoint/key | isDirty = typed !== loaded; warn перед перезаписью | P1 |

---

## 6. Граница с T-0526 (ConfirmDialog)

T-0526 поставляет:
- Готовый `<ConfirmDialog>` (kit, `components.jsx`)
- `ConsequenceSummary` хелпер (`web/src/components/confirm-helpers.jsx`)
- `useDestructiveConfirm` хук (open/target двух-фазный паттерн)

T-0533 **переиспользует** всё это без модификации. Guard-диалог «Несохранённые правки» — не «деструктивное действие пользователя», а системный guard, поэтому:
- Tone: `"danger"` (потеря данных — необратимо)
- `useBlocker` хуком управляем напрямую, не через `useDestructiveConfirm` (у него другая семантика — target-объект)

### Разграничение T-0526 / T-0533

| Задача | Ответственный |
|-------|--------------|
| ConfirmDialog при деструктивных действиях (Уволить, Опубликовать, Удалить) | T-0526 |
| ConfirmDialog при уходе с несохранёнными правками | T-0533 |
| ConsequenceSummary компонент | T-0526 (экспортирует); T-0533 импортирует |
| beforeunload hook | T-0533 |
| useBlocker route-guard | T-0533 |

---

## 7. Граница с T-0544 (canvas rebuild / undo-история)

| Аспект | T-0533 | T-0544 |
|-------|--------|--------|
| isDirty в FormDesigner | JSON.stringify deepEqual (snapshot) | Заменить на historyIndex vs savedHistoryIndex |
| Undo/redo в FormDesigner | Не строится (вне scope) | Полный undo-стек (pushHistory, undo, redo) |
| Route-guard | useBlocker (isDirty-источник не важен) | Route-guard не меняется; isDirty-source swap прозрачен |
| Сброс isDirty после save | savedDocRef.current = doc | savedHistoryIndex = historyIndex |

**Контракт:** T-0533 использует `isDirty` как локальную переменную внутри `FormDesigner`; T-0544 может заменить алгоритм вычисления без изменения guard-логики.

---

## 8. Реализационные примечания

### useBlocker в react-router v6

```js
import { useBlocker } from 'react-router-dom'; // стабильный в v6.4+
```

`useBlocker(shouldBlock)` — принимает boolean или функцию `(transition) => boolean`.

Для BPMN-редактора и дизайнера форм — простой boolean `isDirty`.

### Расположение хука

Создать разделяемый хук `web/src/hooks/useDirtyGuard.js`:

```js
/**
 * useDirtyGuard — beforeunload + useBlocker + ConfirmDialog state.
 * @param {boolean} isDirty
 * @returns {{ blockerState, proceed, reset }}
 */
export function useDirtyGuard(isDirty) {
  const blocker = useBlocker(isDirty);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  return {
    blockerState: blocker.state,
    proceed: () => blocker.proceed?.(),
    reset: () => blocker.reset?.(),
  };
}
```

Использование в обоих редакторах — единая точка.

### DeepEqual стратегия для FormDesigner

`JSON.stringify(doc) !== JSON.stringify(savedDocRef.current)` достаточно: `form-document-ops.js` гарантирует детерминированный порядок полей (иммутабельные объекты, не случайный порядок ключей). Если будут вложенные Map/Set — заменить на `fast-deep-equal`, но пока не нужно.

---

## 9. Что НЕ входит в T-0533

- Undo/redo история в FormDesigner → T-0544
- Toast-провайдер для error-тостов → T-0528
- Keyboard accessibility drag-drop → T-0529
- Overlay focus management → T-0532 (или T-0526 доработка Modal)
