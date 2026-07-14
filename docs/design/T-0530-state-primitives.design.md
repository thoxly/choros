# T-0530 — Примитивы состояний: LoadingState / EmptyState / ErrorState + busy-submit

> Задача: UX-DEBT · Эпик: T-0525 (системный UX-аудит 2026-06-29)
> Статус: DESIGN-спека · Дата: 2026-06-29
> Зависимость входящая: T-0528 (глобальный ToastProvider — нужен для retry-toast)
> Блокирует: impl-задачи всех экранов, трогающих loading/empty/error ветки

---

## 1. Контекст и диагноз

UX-аудит 2026-06-29 зафиксировал **383 находки в 48 файлах**; класс «loading/empty/error
hand-rolled» вошёл в топ-6 приоритетов (§6 аудита). Полный диагноз:

- Async-ветки — бесплатные `<div>/<p>` (`'Загрузка…'`, `'Не удалось загрузить…'`, голые
  `'—'`/`'…'`) без `role=status/alert`, без `aria-busy`, без консистентного «Повторить».
- Несколько сбоев проглочены: cross-app-links и grant-trail ловят ошибки через
  `catch(() => {})`, ставят пустой массив и возвращают `null` — настоящий сбой выглядит как
  «ещё нет данных», пользователь не может ни понять причину, ни повторить.
- Empty конфликтует с error: одна и та же ветка закрывает и «0 результатов», и «сеть упала».
- Сабмит/экспорт-кнопки не используют `loading` prop кита → двойной сабмит возможен;
  `aria-busy` не выставляется.
- Auth-bootstrap в `shell.jsx:654` — `<div><p>Загрузка…</p></div>` без
  `role=status/aria-busy`; экранные ридеры не получают сигнала.

### 1.1 Что уже есть в кита

`web/src/components/components.jsx` содержит **полный набор** примитивов:

| Компонент | ARIA | Статус в кодовой базе |
|---|---|---|
| `LoadingState` | `role="status" aria-live="polite" aria-busy="true"` | Есть, не используется системно |
| `EmptyState` | `role="status"` | Есть, используется точечно |
| `ErrorState` | `role="alert"`, `onRetry` → `<Button>Повторить</Button>` | Есть, не используется системно |
| `Skeleton` | `aria-hidden="true"` (декор) | Есть, не используется |
| `Button` | `aria-busy={loading}`, `disabled={loading}` | Есть, `loading` prop не используется на сабмите |
| `Spinner` | `aria-hidden="true"` (внутри LoadingState/Button) | Есть |

Задача T-0530 — **адопция**, не новые примитивы. Ни одного нового компонента в кит не
добавляется. Вся работа — замена рукодельных async-веток на уже существующие kit-примитивы
и добавление `loading` prop на submit/export-кнопки.

---

## 2. Контракты примитивов

### 2.1 LoadingState

```jsx
<LoadingState label="Загрузка…" compact={false} />
```

**ARIA-контракт (уже реализован в кита):**
- `role="status"` — объявляет регион как «вежливое» live-обновление
- `aria-live="polite"` — AT анонсирует после завершения текущей речи
- `aria-busy="true"` — явный сигнал «контент ещё загружается»

**Правила применения:**
1. Заменяет любой `<div>/<p>` с текстом `'Загрузка…'`, `'Загружаю…'`, `'…'`.
2. Для маленьких inline-регионов (ячейка таблицы, аккордеон-секция) — `compact={true}`.
3. Для shell auth-bootstrap заменяет весь `<div className="chs-login-loading"><p>Загрузка…</p></div>`.
4. Если регион уже содержит данные и обновляется в фоне — использовать `aria-busy="true"` на
   контейнере, а не монтировать `<LoadingState>` поверх (данные не уходят из DOM).
5. Для BPMN-канваса (`bpmn-modeler-wrapper.jsx`) — до завершения `importXML` ставить
   `aria-busy="true"` на враппере + overlay `<LoadingState compact>`.

### 2.2 EmptyState

```jsx
<EmptyState
  icon={<KitIcon name="inbox" size={32} />}
  title="Задач пока нет"
  description="Когда появятся задачи, они отобразятся здесь."
  action={<Button variant="primary" onClick={...}>Создать запись</Button>}
  compact={false}
/>
```

**ARIA-контракт (уже реализован в кита):**
- `role="status"` — «ничего нет» — это информационное состояние, не ошибка

**Правила применения:**
1. Только для «0 результатов при успешном запросе». Никогда не используется как fallback
   для сетевой ошибки (это `ErrorState`, даже если данные пусты).
2. Обязателен `title`. `description` — опционален, `action` — добавляется когда есть явный
   следующий шаг (CTA).
3. Заменяет: голые `return null`, `'—'`, `'Нет данных'`, `'Пусто'`, hand-rolled
   `<div className="...empty">` без `role`.
4. Для palette no-results (`shell.jsx`): `<EmptyState compact title="Ничего не найдено" />`.

### 2.3 ErrorState

```jsx
<ErrorState
  title="Не удалось загрузить данные"
  message="Проверьте подключение к сети и попробуйте снова."
  onRetry={handleLoad}
  retryLabel="Повторить"
  compact={false}
/>
```

**ARIA-контракт (уже реализован в кита):**
- `role="alert"` — немедленное объявление AT; использовать только для ошибок
- Без `aria-live` на самом компоненте (role=alert уже подразумевает assertive)

**Правила применения:**
1. Всегда при сетевой/серверной ошибке — независимо от того, есть ли старые данные.
   Никогда возвращать `null` из catch-ветки.
2. `onRetry` — **обязателен**, кроме единственного исключения: 401 без возможности
   переаутентификации (в этом случае CTA — «Войти» через `action` prop EmptyState-стиль или
   навигация на `/login`, не повторный fetch, который снова 401нётся).
3. Сообщение — человеческий текст, не HTTP-код. Маппинг:
   - 401 → «Войдите в систему, чтобы продолжить.» + CTA «Войти» (не «Повторить»)
   - 403 → «Нет прав на просмотр этих данных.»
   - 404 → «Объект не найден или был удалён.»
   - 5xx / сетевая ошибка → «Не удалось загрузить данные. Попробуйте ещё раз.»
4. `onRetry` вызывает тот же fetch-хандлер, что и первоначальная загрузка (без
   дублирования логики). Паттерн: `const load = useCallback(async () => { ... }, [...])`
   → `onRetry={load}`.
5. Проглоченные ошибки (любой `catch(() => {})` с `setData([])`) — это **баг**:
   обязательно `setError(err)` + рендер `<ErrorState onRetry={load}>`.

### 2.4 Skeleton

```jsx
<Skeleton variant="line" count={3} />
<Skeleton variant="block" width="100%" height={120} />
```

**Применение:**
- Для контента с известной структурой (таблицы записей, списки задач) — `<Skeleton>`
  предпочтительнее `<LoadingState>`, т.к. не вызывает layout-jump.
- `aria-hidden="true"` уже стоит в кита — декоративный плейсхолдер, не нужен тег роли.
- `prefers-reduced-motion` гасит shimmer через CSS (уже в ките).

---

## 3. Busy-state на submit/export-кнопках (анти-double-submit)

### 3.1 Паттерн

Все кнопки основного действия (сабмит формы, экспорт, публикация) обязаны использовать
`loading` prop кита `<Button>`:

```jsx
const [submitting, setSubmitting] = useState(false);

async function handleSubmit() {
  setSubmitting(true);
  try {
    await api.doAction();
  } finally {
    setSubmitting(false);
  }
}

<Button
  variant="primary"
  loading={submitting}
  disabled={submitting}
  onClick={handleSubmit}
>
  Создать
</Button>
```

**Что даёт `loading` prop** (уже реализовано в кита):
- Визуально: spinner заменяет glyph; кнопка остаётся размером, не прыгает раскладка.
- `disabled={isDisabled}` — клик физически заблокирован.
- `aria-busy={loading}` — AT объявляет «загружается».
- `aria-disabled={isDisabled}` — AT объявляет «неактивно».

### 3.2 Таблица сайтов (текущий дефект)

| # | Файл | Кнопка | Текущее состояние | Целевое |
|---|------|--------|-------------------|---------|
| 1 | `shell.jsx:316` | «Экспорт лога» (downloadAuditLog) | нет busy/loading | `loading={exporting}` + `finally setExporting(false)` |
| 2 | `screen-register.jsx` | «Зарегистрироваться» | форма уходит → `<LoadingState>` flash | `<Button loading={submitting}>` форма остаётся смонтированной |
| 3 | `screen-login.jsx` | «Войти» (keycloak redirect) | нет loading | `<Button loading={submitting}>` до redirect |
| 4 | `forms/form-document-renderer.jsx` | submit в iframe | нет busy | postMessage `'submitting'` → runtime дизейблит submit |
| 5 | `screen-process-editor.jsx` | «Опубликовать» | нет busy | `loading={publishing}` |
| 6 | `screen-dmn-editor.jsx` | «Опубликовать» | нет busy | `loading={publishing}` |
| 7 | `screen-reports.jsx` | «Опубликовать» (promote) | нет busy | `loading={promoting}` |
| 8 | `screen-llm-connections.jsx` | «Подключить»/«Привязать» | нет busy | `loading={connecting}` |
| 9 | `screen-spend.jsx` / `screen-process-analytics.jsx` / `screen-ops-overview.jsx` | «Обновить» | нет busy; данные сбрасываются → LoadingState flash | `loading={refreshing}`; данные остаются видимыми с `aria-busy` на контейнере |

**Правило для «Обновить»** (строки 9): данные **не уходят** из DOM во время refresh.
Контейнер получает `aria-busy="true"` overlay, кнопка — `loading={refreshing}`. После
получения новых данных `aria-busy` снимается. Это устраняет и UX-провал «пустой экран»,
и double-submit.

---

## 4. Паттерн «4 состояния списка/детали»

Каждый список или детальная страница обязаны покрывать все 4 состояния:

```jsx
function MyListScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.fetchItems();
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingState />;
  if (error)   return <ErrorState title="Не удалось загрузить" onRetry={load} />;
  if (!data || data.length === 0) return <EmptyState title="Нет элементов" action={...} />;
  return <DataTable rows={data} />;
}
```

**Инвариант конечного автомата:**

```
IDLE ──load()──→ LOADING
LOADING ──ok──→ DATA
LOADING ──err──→ ERROR
ERROR ──retry()──→ LOADING
DATA ──refresh()──→ LOADING (данные видимы, aria-busy=true)
```

Запрещены переходы: `ERROR → null` (возврат null из catch), `LOADING → EMPTY` без
смены флага (perpetual spinner).

---

## 5. Таблица типовых сайтов → примитив

Карта полного охвата из аудита (48 файлов, топ-приоритеты):

| Файл / область | Текущий anti-pattern | Целевой примитив | Примечание |
|---|---|---|---|
| `shell.jsx:654` | `<div><p>Загрузка…</p></div>` | `<LoadingState label="Инициализация…" />` | auth-bootstrap; нет role=status |
| `shell.jsx:455` | palette empty — `<li>Ничего не найдено</li>` | `<EmptyState compact title="Ничего не найдено" />` | нет role=status |
| `shell.jsx: tenant resolve catch` | «—» (пустая строка) | `<ErrorState compact>` или Toast warning | сбой ≠ пустое значение |
| `rights/ra-grant-trail.jsx` | loading-флаг игнорируется; catch = `[]`; seed как live | `<LoadingState>` / `<ErrorState onRetry>` / банер «демо-данные» | критичный сбой |
| `rights/ra-role-editor.jsx` | `<div style>` с raw `{error}` | `<ErrorState onRetry>` с маппингом кодов | |
| `rights/ra-intents.jsx` | `<div style color=(green|red)>` без role=alert | `<ErrorState onRetry>` | |
| `rights/ra-sod.jsx` | inline raw string ошибки | `<ErrorState compact onRetry>` | |
| `screen-app-records.jsx` | `'Загрузка…'` / `'Не удалось загрузить…'` | `<LoadingState>` / `<ErrorState onRetry={load}>` | |
| `screen-processes.jsx` | бесплатный `<p>` | `<LoadingState>` / `<ErrorState onRetry={load}>` | |
| `screen-record-detail.jsx` | cross-app-links: `catch(() => { setLinks([]) })` | `<ErrorState compact onRetry>` | критичный: null-return на сбое |
| `canvas/bpmn-properties-panel.jsx` | `'Загрузка ролей…'` голый `<p>` | `<LoadingState compact>` / `<EmptyState compact>` | |
| `canvas/gateway-condition-panel.jsx` | `'Роли недоступны'` голый `<p>` | `<EmptyState compact>` / `<ErrorState compact onRetry>` | |
| `canvas/timer-deadline-panel.jsx` | `'Загрузка ролей…'` голый `<p>` | `<LoadingState compact>` | |
| `canvas/bpmn-modeler-wrapper.jsx` | нет индикатора до importXML | `aria-busy` на враппере + `<LoadingState compact>` overlay | |
| `canvas/agent-task-panel.jsx` | ошибки fetch агентов — нет retry | `<ErrorState compact onRetry={fetchAgents}>` | |
| `forms/form-builder.jsx` | каталог — hand-rolled retry; apps/defs — kit (ok) | `<LoadingState compact>` / `<ErrorState compact onRetry>` для каталога | |
| `forms/form-viewer.jsx` | save/load errors — нет Повторить | `<ErrorState compact onRetry>` | |
| `forms/form-designer.jsx` | save/load errors — нет Повторить | `<ErrorState compact onRetry>` | |
| `forms/person-picker.jsx` | /api/org fail → блокирует навсегда | `<ErrorState compact onRetry={fetchOrg}>` | критичный |
| `screen-llm-config.jsx` | EmptyState импортируется, не используется; ad-hoc `<p>` | `<EmptyState title="Нет подключённого агента" action=...>` | dead import |
| `screen-spend.jsx` / `screen-process-analytics.jsx` / `screen-ops-overview.jsx` | «Обновить» сбрасывает данные → LoadingState flash | `aria-busy` на данных + `loading` на кнопке | |
| `screen-notifications.jsx` | row-action ошибка обрушивает весь список в ErrorState | локальный `<ErrorState compact>` на строке, не на всём списке | scope |
| `screen-audit.jsx` | load-more error — голый `<div>` без role | `<ErrorState compact onRetry={loadMore}>` | |

---

## 6. Связь с UX honest-gate G4 и T-0314

**D-062 UX honest-gate G4** (из `docs/decisions.md:810`):
> «есть Empty/Loading/Error» — детерминированное правило в `ci/checks/ux/*`

Текущий CI-гейт `ci/checks/ux/` содержит только:
- `ux-g2-theme-pairing.sh` (тема)
- `ux-g5-jargon-denylist.sh` (жаргон)
- `ux-g6-no-new-hardcode.sh` (инлайн-хардкод)

**T-0530 добавляет** `ci/checks/ux/ux-g4-state-primitives.sh` — машинный гейт G4.

**T-0314** (динамический UX-гейт, открытый T-0525-эпик): цель T-0314 — расширить
`G4` до e2e-проверки в journey-тестах (runtime рендер LoadingState/ErrorState).
T-0530 закладывает статический grep-гейт (G4 через CI-скрипт) как промежуточный шаг.
T-0314 достраивает поверх journey-тест, который проверяет реальный рендер.

**Связь как зависимость:**
- T-0530 DESIGN → T-0530 impl: замена hand-rolled → kit-примитивы + `ux-g4-state-primitives.sh`
- T-0530 impl → T-0314 impl: journey-тест «все списки рендерят LoadingState при fetch» строится на гарантии T-0530

---

## 7. Аудит-граница: что НЕ входит в T-0530

| Тема | Почему не здесь |
|---|---|
| Глобальный ToastProvider | T-0528 (зависимость, идёт параллельно) |
| ConfirmDialog политика | T-0526 (уже DESIGN-спека) |
| Деструктивные действия | T-0526 |
| Навигационная IA | T-0538/T-0539 |
| ARIA keyboard-access таблиц/строк (tabIndex, onKeyDown) | T-0531 (отдельный UX-DEBT) |
| Валидация форм / aria-describedby на полях | T-0532 (отдельный UX-DEBT) |
| Жаргон / dev-text (G5) | `ux-g5-jargon-denylist.sh` уже гейтит |
