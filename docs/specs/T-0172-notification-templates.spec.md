# Spec · T-0172 — Notifications E-N.5: code-bundled шаблоны event_kind→{title,body} + server-side render {{var}} с HTML-escape

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0172 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2.9 (шаблонизация), §4.4 (`renderTemplate` contract), §5 E-N.5 (декомпозиция), §6 FF-TEMPLATE-NO-LLM/FF-HTML-ESCAPE/FF-TEMPLATE-CLASS
**Foundations:** T-0033 (`DataClass` — импорт, не редекларация), T-0169 (notification-router: `TemplateRendererPort`, `NotificationEvent.payload`)
**Deps done:** T-0169 (notification-router с `TemplateRendererPort`-портом — render-шов в fanout), T-0171 (DEFAULT_PREFERENCES с 5 event_kind)

---

## 1. Summary

Реализует E-N.5: модуль `src/core/notification-templates.ts` — code-bundled Map `event_kind → {title: string, body: string}` для 5 day-1 event_kind из DEFAULT_PREFERENCES T-0171 (`task.assigned`, `approval.requested`, `sla.warning`, `sla.breach`, `escalation.raised`), плюс функция `renderTemplate` — server-side string-подстановка `{{var}}` из payload с обязательным HTML-escape при `html=true`. Без LLM, без внешних зависимостей, без eval. Модуль подключается как реализация `TemplateRendererPort` в `publishNotificationEvent` (render-шов в fanout). Отсутствующая переменная — тихий пропуск (fail-closed: raw-объект не попадает в рендер). Неизвестный `event_kind` — возвращает fallback-шаблон.

---

## 2. Functional requirements

- **FR-1** Экспортируется константа `NOTIFICATION_TEMPLATES: ReadonlyMap<string, { title: string; body: string }>` — code-bundled Map `event_kind → {title, body}` для всех 5 event_kind из T-0171 `DEFAULT_PREFERENCES`. Шаблоны живут в коде, НЕ в БД (ADR §2.9: вендор-owned, tenant-override = Stage-2).

- **FR-2** Шаблоны содержат `{{var}}`-плейсхолдеры, ссылающиеся на поля из `NotificationEvent.payload`. Используются ТОЛЬКО переменные `≤ internal` data-class (фильтрация `confidential`/`restricted` — обязанность fanout T-0169, в шаблонах ключи не классифицируются явно).

- **FR-3** Экспортируется функция `renderTemplate(tmpl, payload, opts): { title: string; body: string }`:
  - Принимает: `tmpl: { title: string; body: string }` (code-bundled шаблон), `payload: Record<string, unknown>` (переменные), `opts: { html: boolean }` (`html=true` → HTML-escape переменных).
  - Возвращает: `{ title: string; body: string }` — результирующие строки с подставленными переменными.
  - Реализация: простая именованная string-подстановка `{{var}}` → значение из payload. Без eval, без template-engine, без LLM.

- **FR-4** HTML-escape (XSS-защита): при `opts.html = true` каждое substituted значение проходит через `escapeHtml` перед вставкой. Минимум 5 символов: `&`, `<`, `>`, `"`, `'` → соответствующие HTML-entities. Функция `escapeHtml` экспортируется для независимого тестирования.

- **FR-5** Отсутствующая переменная: если `payload[var]` — `undefined` или ключ отсутствует, плейсхолдер `{{var}}` заменяется на пустую строку (fail-closed: raw-объект в рендер не попадает, runtime не падает). ADR §2.9: «отсутствует обязательная переменная → body рендерится с плейсхолдером/пропуском».

- **FR-6** Неизвестный `event_kind`: если `event_kind` отсутствует в `NOTIFICATION_TEMPLATES`, `renderTemplate` использует fallback-шаблон: `title = event_kind`, `body = ''`. Система не падает, не раскрывает внутренние данные.

- **FR-7** Экспортируется функция `renderNotification(eventKind, payload, opts): { title: string; body: string }` — удобная обёртка: ищет шаблон в `NOTIFICATION_TEMPLATES` (с fallback по FR-6), затем вызывает `renderTemplate`. Это функция, реализующая `TemplateRendererPort.render`.

- **FR-8** Экспортируется объект `defaultTemplateRenderer: TemplateRendererPort` — реализация порта для инъекции в `publishNotificationEvent` deps. Вызывает `renderNotification(eventKind, payload, { html: false })` (plain-text рендер для in-app; email-рендер с `html=true` можно запросить отдельно через `renderNotification` напрямую).

- **FR-9** `DataClass` — импорт из `data-classification.ts`, не редекларация (ADR NF-8 / T-0033). Комментарий в коде фиксирует, что переменные ≤ `internal` фильтруются на уровне fanout T-0169.

- **FR-10** Модуль — pure-core: нет `import pg`, нет `node:http`, нет `node:net`, нет `fetch`, нет LLM-вызовов, нет `eval` (FF-TEMPLATE-NO-LLM / ADR §2.9). Тестируется без DATABASE_URL.

---

## 3. Non-functional requirements

- **NF-1** HTML-escape обязателен (FF-HTML-ESCAPE / ADR §2.9): payload-переменные, содержащие `<script>`, `&`, `"`, `'`, `>`, при `html=true` экранируются в HTML-entities. `<script>alert(1)</script>` в payload → `&lt;script&gt;alert(1)&lt;/script&gt;` в HTML-body. XSS-данные записей попадают в email — HTML-escape является барьером безопасности, НЕ опциональной фичей.

- **NF-2** Нет внешних зависимостей (FF-TEMPLATE-NO-LLM): рендер — stdlib-only, нет import Handlebars/EJS/mustache/marked/любого template-engine. Нет LLM-вызовов. Нет `eval`. Grep-проверяемо.

- **NF-3** Нет switch/enum по `event_kind` для routing в `renderNotification` (симметрично FF-NO-SWITCH-CHANNEL router'а): доступ к шаблону — исключительно `NOTIFICATION_TEMPLATES.get(eventKind)`, не `if/else if/switch`.

- **NF-4** plain-text-часть (`html=false`) — без HTML-escape (ADR §2.9: «plain-text-часть — без экранирования»). `opts.html` явно управляет режимом.

- **NF-5** Fail-closed по data-class: шаблоны не ссылаются явно на `confidential`/`restricted` поля payload. Все `{{var}}`-плейсхолдеры в code-bundled шаблонах используют только `≤ internal` ключи (comment-guaranteed — coder-контракт).

- **NF-6** Модуль не пишет `audit_event` (FF-NO-DELIVERY-AUDIT: рендер — pure-function, не side-effect).

---

## 4. Template vocabulary (day-1)

Шаблоны для 5 event_kind из `DEFAULT_PREFERENCES` (T-0171). Переменные `{{var}}` ссылаются на поля `NotificationEvent.payload` — ≤ `internal`:

| event_kind | title template | body template |
|---|---|---|
| `task.assigned` | `Вам назначена задача: {{taskName}}` | `Задача «{{taskName}}» назначена вам{{#assignedBy}} пользователем {{assignedBy}}{{/assignedBy}}.` |
| `approval.requested` | `Запрос на подтверждение: {{taskName}}` | `По задаче «{{taskName}}» запрошено ваше подтверждение.` |
| `sla.warning` | `Предупреждение SLA: {{taskName}}` | `Задача «{{taskName}}» приближается к дедлайну SLA.` |
| `sla.breach` | `Нарушение SLA: {{taskName}}` | `Задача «{{taskName}}» нарушила дедлайн SLA.` |
| `escalation.raised` | `Эскалация: {{taskName}}` | `По задаче «{{taskName}}» создана эскалация.` |

Примечание: плейсхолдеры `{{taskName}}`, `{{assignedBy}}` — ожидаемые ключи в `NotificationEvent.payload`. При отсутствии ключа — замена на `""` (FR-5). `{{#assignedBy}}…{{/assignedBy}}` — упрощённая optional-секция (если нужна): coder может реализовать простым условием или опустить условную секцию, оставив только `{{var}}`-подстановку.

> Coder-note: если «conditional section» (`{{#var}}…{{/var}}`) не реализуется day-1, шаблон body для `task.assigned` упрощается до `Задача «{{taskName}}» назначена вам.`. Это допустимо — main invariant: простая `{{var}}`-подстановка + HTML-escape.

---

## 5. Out of scope

- Tenant-configurable шаблоны (`notification_template` таблица, брендинг/локализация) — Stage-2 (ADR §2.9/§5 defers).
- Полноценный template-engine с выражениями (Handlebars/EJS) — отклонён (ADR §3 rejected alternatives).
- Conditional sections (`{{#var}}…{{/var}}`) — опционально (coder-решение); main invariant — `{{var}}`-подстановка.
- LLM-генерация текстов уведомлений — не-MVP (ADR §2.9 явно).
- Egress runtime-гейт DataClass → Stage-2 (как T-0041/T-0119); day-1 фиксирует контракт.
- REST API notification center, email-channel config CRUD, outbox-wiring — E-N.6/E-N.3/E-N.7.

---

## 6. Acceptance criteria

| id | text | verifiable_as |
|---|---|---|
| AC-1 | `NOTIFICATION_TEMPLATES` — `ReadonlyMap`, содержит ровно 5 записей для `task.assigned`, `approval.requested`, `sla.warning`, `sla.breach`, `escalation.raised`; каждая запись — `{ title: string; body: string }` | test |
| AC-2 | `renderTemplate({title:'Hello {{name}}', body:'Body {{val}}'}, {name:'Alice', val:'X'}, {html:false})` → `{title:'Hello Alice', body:'Body X'}` | test |
| AC-3 | `renderTemplate` при отсутствующем ключе payload: `{{missing}}` → `''` (пустая строка, не `{{missing}}`, не `undefined`, не throw) | test |
| AC-4 | `renderTemplate(..., {html:true})` с payload `{name: '<script>alert(1)</script>'}` → title/body содержит `&lt;script&gt;alert(1)&lt;/script&gt;` (XSS-проба) | test |
| AC-5 | `escapeHtml('<>&"\'')`  → `'&lt;&gt;&amp;&quot;&#39;'` (все 5 опасных символов экранированы) | test |
| AC-6 | `renderNotification('task.assigned', {taskName: 'MyTask'}, {html:false})` → `{title}` содержит `'MyTask'`; `{body}` содержит `'MyTask'` | test |
| AC-7 | `renderNotification('unknown.event_kind', {}, {html:false})` → fallback: `{title: 'unknown.event_kind', body: ''}`, не throw | test |
| AC-8 | `defaultTemplateRenderer.render('task.assigned', {taskName: 'T'})` → `{title, body}` без HTML-escape (plain-text) | test |
| AC-9 | XSS-проба сквозная: `renderNotification('task.assigned', {taskName: '<img src=x onerror=alert(1)>'}, {html:true})` → title/body НЕ содержат `<img` (содержат `&lt;img`) | test |
| AC-10 | `tsc --noEmit` без ошибок: `DataClass` импортирован из `data-classification.ts`, не редекларирован; `defaultTemplateRenderer` структурно совместим с `TemplateRendererPort` | fitness |
| AC-11 | `notification-templates.ts` не содержит `import … from 'pg'`, `eval(`, LLM/template-engine импортов; grep-проверяемо | fitness |
| AC-12 | `renderTemplate({title:'Hello {{name}}', body:'{{name}} & {{name}}'}, {name:'A'}, {html:false})` → каждое вхождение `{{name}}` заменяется (все вхождения одного var в строке) | test |
| AC-13 | `renderTemplate(..., {html:false})` с payload `{val: '<b>text</b>'}` → результат содержит `<b>text</b>` без экранирования (plain-text: НЕ escaped) | test |
| AC-14 | `npm test` (vitest без DATABASE_URL) — все тесты зелёные; `npm run fitness` — fitness-скрипты проходят | fitness |
