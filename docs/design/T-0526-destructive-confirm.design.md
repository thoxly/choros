# T-0526 — Политика гейтинга деструктивных действий: ConfirmDialog + undo-тосты

> Задача: UX-DEBT/safety · Эпик: T-0525 (системный UX-аудит)
> Статус: DESIGN-спека · Дата: 2026-06-29
> Зависимость: T-0528 (глобальный ToastProvider — undo-тост)

---

## 1. Контекст и проблема

UX-аудит 2026-06-29 зафиксировал (~15 файлов, 5 зон):

- Деструктивные/необратимые действия исполняются на один клик без ConfirmDialog.
- В одном месте (`ra-sod.jsx:90`) стоит запрещённый `window.confirm()`.
- `Toast` с `action` (undo) нигде не используется для обратимых bulk-удалений.
- `ConfirmDialog` kit-компонент существует и полностью функционален — используется только в `screen-org.jsx` и `screen-assistant.jsx`.
- Кнопки «Опубликовать» и «Сохранить» визуально не разделены — публикация в живой движок выглядит как рядовое сохранение.

Принцип §4 `principles.md`: «опасное действие = модал».

---

## 2. Политика гейтинга

### 2.1 Классификация действий

| Класс | Определение | Гейт |
|-------|------------|------|
| **CONFIRM-DANGER** | Необратимое сервер-сайд изменение ИЛИ высокий blast-radius (затрагивает >1 объекта без возможности отмены) | `<ConfirmDialog tone="danger">` с ConsequenceSummary |
| **CONFIRM-WARNING** | Обратимо, но последствия широкие / требует явного намерения | `<ConfirmDialog tone="default">` (primary-кнопка) |
| **UNDO-TOAST** | Обратимое bulk-действие: результат можно немедленно откатить через Toast action | `push({ tone:"success", action:<UndoButton> })` через T-0528 ToastProvider |
| **NO-GATE** | Мелкое обратимое локальное действие (удалить пустую строку в таблице, убрать поле в черновике) | без дополнительного гейта; стандартный success-тост |

### 2.2 Таблица сайтов (~15 находок из аудита)

| # | Файл | Действие (UI-текст) | Текущий гейт | Класс | Целевой гейт |
|---|------|---------------------|-------------|-------|-------------|
| 1 | `rights/ra-intents.jsx` | «Уволить» — атомарный revoke ВСЕХ прав сотрудника + переназначение задач | нет | **CONFIRM-DANGER** | ConfirmDialog danger + ConsequenceSummary (см. §3) |
| 2 | `rights/ra-intents.jsx` | «Срочно отозвать» — убрать право сейчас; для агента — остановка активных шагов (fail-closed) | нет | **CONFIRM-DANGER** | ConfirmDialog danger |
| 3 | `rights/ra-sod.jsx:90` | «Удалить правило разделения обязанностей» | `window.confirm()` — ЗАПРЕЩЕНО | **CONFIRM-DANGER** | ConfirmDialog danger (replace window.confirm) |
| 4 | `rights/ra-role-editor.jsx` | «Удалить грант» — убрать право из роли | нет (instant) | **CONFIRM-WARNING** | ConfirmDialog warning (если роль опубликована) / UNDO-TOAST (если черновик) |
| 5 | `canvas/bpmn-properties-panel.jsx` | «Удалить исход» — удалить выход из BPMN-узла | нет | **CONFIRM-DANGER** | ConfirmDialog danger (исход связан с потоками; каскадное удаление соединений) |
| 6 | `screen-process-editor.jsx` | «Опубликовать» — lint + деплой в Flowable (живой движок) | нет | **CONFIRM-DANGER** | ConfirmDialog danger + визуальное разделение Save/Publish (§5) |
| 7 | `screen-dmn-editor.jsx` | «Опубликовать» — публикация таблицы правил ветвления | нет | **CONFIRM-DANGER** | ConfirmDialog danger + визуальное разделение |
| 8 | `screen-dmn-editor.jsx` | «Удалить правило» (`removeRule`) — удаляет строку из таблицы решений | нет | **UNDO-TOAST** (если есть несохранённый черновик) / **CONFIRM-WARNING** (если таблица опубликована) | undo-тост 5 с / ConfirmDialog |
| 9 | `screen-reports.jsx` | «Опубликовать» (`promote`) — черновик → опубликован (необратимо) | нет | **CONFIRM-DANGER** | ConfirmDialog danger |
| 10 | `screen-reports.jsx` | «Удалить метрику» | нет | **UNDO-TOAST** | undo-тост 5 с |
| 11 | `screen-llm-connections.jsx` | «Отвязать» — DELETE `/api/llm-connections/:id/key` — удаляет зашифрованный API-ключ; ломает зависимых агентов | нет | **CONFIRM-DANGER** | ConfirmDialog danger + ConsequenceSummary |
| 12 | `screen-assistant.jsx` | «Опубликовать решение» (`bundlePromote`) — bulk-публикация N элементов одним действием | нет | **CONFIRM-DANGER** | ConfirmDialog danger (blast-radius = N элементов) |
| 13 | `screen-assistant.jsx` | «Удалить разговор» | ConfirmDialog (УЖЕ DONE) | — | уже закрыто |
| 14 | `screen-org.jsx` | «Удалить» сотрудника / отдела / должности | ConfirmDialog (УЖЕ DONE) | — | уже закрыто |
| 15 | `screen-app-schema.jsx` | «Удалить колонку» / «Удалить поле» (в черновике схемы) | нет | **UNDO-TOAST** | undo-тост 5 с; если схема опубликована → CONFIRM-WARNING |

**Итого по классам:**
- CONFIRM-DANGER (новых): 8 сайтов (1, 2, 3, 5, 6, 7, 9, 11, 12)
- CONFIRM-WARNING (новых): 2 сайта (4, 15 при опубл.)
- UNDO-TOAST: 3 сайта (8, 10, 15 при черновике)
- Уже закрыты: 2 (13, 14)

---

## 3. Контракт ConsequenceSummary

`ConsequenceSummary` — именованный блок внутри `message` prop ConfirmDialog, описывающий:

```
Кто затронут:  <субъект(ы) — имя / тип / кол-во>
Что произойдёт: <конкретное действие>
Обратимость:   Необратимо | Обратимо через <способ>
```

Реализуется как компонент-хелпер (no-kit — pure JSX), передаваемый в `message`:

```jsx
function ConsequenceSummary({ who, what, reversibility }) {
  return (
    <div className="chs-consequence">
      <dl>
        <dt>Затронуто</dt><dd>{who}</dd>
        <dt>Действие</dt><dd>{what}</dd>
        <dt>Обратимость</dt><dd>{reversibility}</dd>
      </dl>
    </div>
  );
}
```

### Примеры по сайтам

**«Уволить» (сайт 1):**
```
Кто затронут:  Иван Петров (сотрудник)
Что произойдёт: Отзыв всех N назначений и M грантов. Активные задачи переназначаются/прерываются.
Обратимость:   Необратимо. Восстановление — ручное создание новых назначений.
```

**«Срочно отозвать» (сайт 2):**
```
Кто затронут:  Роль / ресурс <название>
Что произойдёт: Право немедленно отзывается. Агент останавливается (fail-closed).
Обратимость:   Необратимо. Новый грант выдаётся через Rights Admin.
```

**«Отвязать API-ключ» (сайт 11):**
```
Кто затронут:  LLM-соединение «<название>» и все агенты, использующие его
Что произойдёт: Зашифрованный ключ удаляется. Агенты теряют доступ к LLM.
Обратимость:   Необратимо. Новый ключ нужно ввести повторно.
```

**«Опубликовать» процесс (сайт 6):**
```
Кто затронут:  Процесс «<название>» (живой движок Flowable)
Что произойдёт: Черновик деплоится в движок. Запущенные экземпляры мигрируют на новую версию.
Обратимость:   Необратимо в рамках этой версии. Откат — публикация предыдущей версии.
```

**«Удалить исход» (сайт 5):**
```
Кто затронут:  Исход «<название>» и все связанные с ним потоки управления
Что произойдёт: Исход и входящие/исходящие соединения удаляются из диаграммы.
Обратимость:   Необратимо в текущей сессии (Ctrl+Z пока не реализован).
```

---

## 4. Встроенное обоснование (dual-control reject reason)

Для действий с критическими ролями (атрибут `crit: true` из `ra-data.jsx`) или для интентов «Уволить» / «Срочно отозвать», ConfirmDialog должен включать опциональное поле ввода причины:

```jsx
<ConfirmDialog
  ...
  reason={reason}                  // строка
  onReasonChange={setReason}       // setState
  reasonRequired={true}            // блокирует Подтвердить если пустое
  reasonPlaceholder="Причина отзыва прав"
/>
```

**Изменение контракта ConfirmDialog (extends текущий):**

| Проп | Тип | Описание |
|------|-----|---------|
| `reason` | string | текущее значение поля причины |
| `onReasonChange` | fn(string) | callback изменения |
| `reasonRequired` | bool | если true — кнопка «Подтвердить» disabled пока reason пустая |
| `reasonPlaceholder` | string | placeholder текстового поля |

Поле `<Field label="Причина" ...>` рендерится внутри ConfirmDialog между `message` и футером, только если `onReasonChange` передан.

---

## 5. Визуальное разделение Publish / Save

Проблема: «Сохранить» и «Опубликовать» — рядом стоящие кнопки одного визуального веса, хотя операции принципиально разные по последствиям.

**Решение:**

```
[Сохранить черновик]   [Опубликовать в движок ▸]
   (primary)                  (danger outline)
```

- `Сохранить` → `Button variant="primary"` (существующий стиль)
- `Опубликовать` → `Button variant="danger"` с иконкой `upload`/`rocket` и ConfirmDialog danger при клике
- Визуальный разделитель (`<hr>` или `divider` из kit) между группой редактирования и группой публикации в тулбаре/панели действий
- Статус-бейдж рядом: «Черновик» (StatusChip paused) / «Опубликован» (StatusChip done) — уже реализовано в `screen-process-editor.jsx:210`

Применяется к:
- `screen-process-editor.jsx` — `PublishBar` компонент
- `screen-dmn-editor.jsx` — кнопка Опубликовать в `EditorToolbar`

---

## 6. Undo-тост: паттерн для обратимых bulk

Зависит от **T-0528** — глобальный `ToastProvider` (контекст) + `useAppToast()` хук, доступный в любом screen без prop-drilling.

**Паттерн до T-0528:**
```jsx
// Локально через useToasts (уже в kit) — временный паттерн
const { push, dismiss } = useToasts();

function handleDeleteMetric(id) {
  const backup = metrics.find(m => m.id === id);
  setMetrics(ms => ms.filter(m => m.id !== id));  // оптимистично
  const toastId = push({
    tone: 'success',
    title: 'Метрика удалена',
    duration: 5000,
    action: (
      <button onClick={() => { setMetrics(ms => [...ms, backup]); dismiss(toastId); }}>
        Отменить
      </button>
    ),
  });
}
```

**Паттерн после T-0528 (целевой):**
```jsx
const { push } = useAppToast();  // глобальный хук из T-0528

function handleDeleteMetric(id) {
  // ... та же логика, но через глобальный контекст
}
```

**Правило:** для undo-тостов `duration = 5000` мс (5 с), `tone = "success"`, кнопка внутри `action` — «Отменить».

---

## 7. Замена window.confirm()

**Единственный файл с `window.confirm`:** `web/src/screens/rights/ra-sod.jsx:90`

Текущий код:
```js
if (!window.confirm('Удалить правило разделения обязанностей?')) return;
```

Целевой паттерн — стандартный двух-фазный confirm:
```jsx
const [deleteTarget, setDeleteTarget] = useState(null);

function SodRuleRow({ rule, onDelete }) {
  return (
    <>
      <button onClick={() => setDeleteTarget(rule.id)}>Удалить</button>
      <ConfirmDialog
        open={deleteTarget === rule.id}
        title="Удалить правило разделения обязанностей?"
        message={
          <ConsequenceSummary
            who={`Правило «${rule.name}»`}
            what="Ограничение ролевых конфликтов будет снято немедленно."
            reversibility="Необратимо. Правило нужно создать заново."
          />
        }
        tone="danger"
        confirmLabel="Удалить"
        onConfirm={() => { onDelete(rule.id); setDeleteTarget(null); }}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}
```

---

## 8. Граница / зависимость T-0528

| Что | Где | Статус |
|----|-----|-------|
| `useToasts` / `ToastViewport` (локальный) | `components.jsx` | ГОТОВО — используется сейчас |
| Глобальный `ToastProvider` (context) | T-0528 | ЗАВИСИМОСТЬ — impl blocker для undo-тостов cross-screen |
| `useAppToast()` хук | T-0528 | ЗАВИСИМОСТЬ |

Все ConfirmDialog-гейты (сайты 1–9, 11–12) **не зависят** от T-0528 и могут быть реализованы немедленно.

Undo-тосты (сайты 8, 10, 15) — **зависят от T-0528**. До доставки T-0528 — локальный `useToasts` как временный паттерн.

---

## 9. Компонентная модель (summary)

```
ConfirmDialog (kit, components.jsx) — расширить:
  + props: reason, onReasonChange, reasonRequired, reasonPlaceholder

ConsequenceSummary (новый хелпер, util/confirm-helpers.jsx):
  props: who, what, reversibility

useDestructiveConfirm (новый хук, util/confirm-helpers.jsx):
  state: { open, target, loading }
  methods: request(target), confirm(fn), cancel()
  // Инкапсулирует двух-фазный open/confirm паттерн

PublishBar (новый компонент или изменение существующего тулбара):
  визуальное разделение Save / Publish
  Publish кнопка → variant="danger" + ConfirmDialog
```

---

## 10. Гейт «нет window.confirm в web/src»

Реализуется как CI-grep-гард (в `ci/checks/` или ESLint rule):

```bash
# ci/checks/no-window-confirm.sh
if grep -rn "window\.confirm" web/src/ --include="*.jsx" --include="*.js" --include="*.tsx" --include="*.ts"; then
  echo "ERROR: window.confirm() запрещён. Используй <ConfirmDialog> из kit."
  exit 1
fi
echo "OK: window.confirm не найден."
```

---

## 11. Открытые вопросы (без эскалации к фаундеру)

Все вопросы закрываемы на уровне дизайна:
- Поле «причина» в диалоге — опционально для dual-control (только для `crit:true` ролей); не обязательно для деплоя процесса.
- «Удалить грант» в ra-role-editor — если роль в черновике, то undo-тост; если опубликована → CONFIRM-WARNING. Граница: `role.status === 'published'`.
- `removeRule` в DMN editor — исходит из localStorage/черновика, значит undo-тост достаточен (нет server-side DELETE).

Эскалаций к фаундеру нет. `status: "ready"`.
