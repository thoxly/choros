# ADR · T-0651 — Сайдбар как рабочее место (collapsible-группы + per-user + DnD)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-07-05
**Task:** T-0651 [W4-UX] (родитель T-0647 E-UX-HUMAN)
**Source:** `docs/design/ux-study-2026-07-05.md` §1
**Foundation (не противоречит, дорабатывает):** `web/src/app-shell/shell.jsx`,
`web/src/app-shell/nav-config.js`, `web/src/app-shell/nav-sections.js`,
`src/http/sections.ts` (T-0551, migration 113), `src/http/applications.ts` (T-0540/T-0551),
`web/src/screens/screen-apps.jsx` (`RenameAppModal`/`SetSectionModal`/`buildAppMenuItems`),
`web/src/screens/kanban-board.jsx` (T-0582, ручной HTML5 DnD prece­dent),
`web/src/screens/screen-sections.jsx` (▲/▼ index-swap PATCH prece­dent).
**Runtime target:** добавляет таблицу `choros.user_pref` + колонку
`choros.application.sort_order` → миграция против container/dev PG.

---

## 1. Контекст

Исследование фаундера (§1) диагностировало сайдбар как «свалку» — 43 пункта одной
колонкой, разделы-сущность (T-0551) существуют в БД, но управлять ими можно только со
страниц `/sections` и `/apps`, не из самого сайдбара. Плюс: **никакого user-prefs
хранилища в продукте нет вообще** (диагноз №2, тот же корень стоит за §4 «личная глубина
представлений списков» — нужен один переиспользуемый механизм, не два).

## 2. Решение: `choros.user_pref` — общий per-actor key/value store

### 2.1 Модель

```sql
CREATE TABLE choros.user_pref (
  tenant_id   uuid    NOT NULL,
  id          uuid    NOT NULL,
  actor       text    NOT NULL,   -- employee slug (человек ИЛИ агент)
  key         text    NOT NULL,   -- открытый namespace, напр. "sidebar.collapsed_groups"
  value       jsonb   NOT NULL,   -- открытая форма — семантику решает читатель
  created_at  bigint  NOT NULL,
  updated_at  bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, actor, key)
);
```

Tenant-table contract T-0013 verbatim (RLS FORCE + default-DENY policy на
`current_setting('choros.tenant_id')`), как `section`/`list_view`.

### 2.2 Почему flat key/value, не одна таблица на фичу

- **Меньше миграций.** Каждая будущая «настройка под себя» (свёрнутые группы сайдбара
  сегодня; личные сохранённые виды/плотность таблиц §4 завтра) не требует новой таблицы
  — просто новый `key` и своя форма `value` JSON.
- **Один API, один фронт-хук.** `GET /api/user-prefs` отдаёт ВСЕ настройки актора одним
  запросом (сайдбар при монтировании читает раз, не по одному ключу) — дёшево для
  малого числа ключей на актора (десятки, не тысячи).
- **UNIQUE(tenant_id, actor, key)** — обновление это upsert (`ON CONFLICT DO UPDATE`),
  не growing лог: у настройки нет ценности истории (в отличие от `audit_event`, который
  уже существует для «кто/когда» если это когда-нибудь понадобится).
- **НЕ FK на employee.** `actor` — мягкая ссылка (тот же принцип, что `audit_event.actor`
  /`list_view.created_by`): устаревший ключ безвреден, он просто никогда больше не
  резолвится. Разрывать FK-цепочку ради UI-предпочтения было бы неверной ценой.

### 2.3 Переиспользуемость для §4 (личные виды)

Эта задача потребляет ОДИН ключ: `sidebar.collapsed_groups` → `value: string[]` (id зон,
которые актор свернул). Форма `value` для будущего потребителя §4 (view-примитив
`source: records|inbox|processes`, `owner_actor`) — **другой вопрос той задачи** (скорее
всего свои ключи `views.<source>.saved` или отдельные `list_view.owner_actor` строки —
ADR T-0581 уже предусматривал это поле на самой view-сущности, не здесь). `user_pref`
здесь — только фундамент-примитив: hosting store, ничего специфичного для списков.
Любая будущая фича на «под себя» получает store бесплатно, без новой миграции.

### 2.4 API

```
GET    /api/user-prefs             → 200 { prefs: { [key]: value, ... } }
PUT    /api/user-prefs/:key  { value } → 200 { key, value, updated_at }  (upsert)
DELETE /api/user-prefs/:key        → 204  (idempotent — reset-to-default)
```

Без отдельной привилегии сверх auth+tenant-членства (мирroring theme-toggle's
localStorage trust model) — настройка стоит нолиь и трогает только свою строку.

## 3. `application.sort_order` — недостающий move-primitive

UX-study (§1, эхо §6 «у оргструктуры НЕТ move-API») подтвердилось и здесь при разведке:
`choros.section` уже имеет `sort_order` (migration 113, ▲/▼ реализован в
`screen-sections.jsx`), но **`choros.application` не имел `sort_order` вовсе** —
`listApplications()`/`APP_READ_SELECT` сортировали только `created_at DESC, slug ASC`,
без ручного хука. DnD/▲/▼ приложений ВНУТРИ раздела не на чем было бы держать.

**Найдено, не выдумано заново**: `PATCH /api/applications/:id` уже существовал
(section_id/display_name/description) — минимальное дополнение: одна колонка
(`sort_order integer NOT NULL DEFAULT 0`, additive) + один новый `if ("sort_order" in
body)` блок в существующем PATCH-хендлере. Никакой новой таблицы/роута.

Группировка `groupAppsBySection()` (`nav-sections.js`) теперь сортирует ВНУТРИ каждой
группы по `app.sort_order` (ties → `display_name`, ru-локаль) — обратно совместимо: все
существующие приложения имеют `sort_order=0` (DEFAULT), поэтому для тенантов, которые
никогда не переупорядочивали, видимый порядок — по имени (было — по `created_at`;
единственное поведенческое отличие, безвредное — ни один живой сценарий не полагается
на "новое приложение сверху списка сайдбара").

## 4. DnD-паттерн — переиспользован из канбана (T-0582), не изобретён

`kanban-board.jsx` уже доказал паттерн "ручной HTML5 DnD + кнопочная альтернатива,
optimistic + rollback, без библиотеки" (T-0582 ADR, NF-6). Сайдбар копирует ту же форму:

- `draggable` на строке приложения / заголовке раздела; `onDragStart` кладёт id в
  `dataTransfer` + локальный state `draggingId`.
- Заголовок раздела и корень группы — drop targets (`onDragOver` preventDefault +
  подсветка через `dragOverId`, `onDrop` вычисляет целевой section_id/sort_order).
- **Optimistic UI + rollback**: локальный reorder применяется немедленно, PATCH летит
  в фоне; неудача (не-2xx) откатывает локальный state к предыдущему (тот же
  `handleMove`-паттерн, что `kanban-board.jsx`).
- **Кнопки ▲/▼ остаются первоклассными**, не "запасным вариантом за фичефлагом" —
  ровно то, что уже сделано в `screen-sections.jsx`/`list-view-panel.jsx`. DnD
  добавляется ПОВЕРХ, никогда не заменяет: те же PATCH-вызовы, тот же результат,
  разный триггер (drag или клик).
- Логика "куда именно падает и что это значит" (индекс/section_id) живёт в чистом
  `sidebar-dnd.js` — тестируется в node vitest без DOM (тот же принцип разделения
  "логика в тестируемом соседе", что `kanban-board.js`/`apps-manage-api.js`).

## 5. Collapsible-группы — что персистится, что нет

- **Персистится (per-user, user_pref key `sidebar.collapsed_groups`)**: какие ЗОНЫ
  (Конструктор/Наблюдаемость/Администрирование) свёрнуты. Дефолт при полном отсутствии
  prefs (первый визит) — ВСЕ ТРИ свёрнуты (спека §2A) — сайдбар инициализируется
  локальным дефолтом ДО того, как asynch-загрузка `/api/user-prefs` вернётся, чтобы не
  мигать "всё развёрнуто → сворачивается" на каждой загрузке.
- **Не персистится**: РАБОТА (постоянный домашний слой — никогда не сворачивается,
  спека §2A — "always visible", это не опция).
- **Деградация без сервера**: если `/api/user-prefs` недоступен (сеть/пере-деплой),
  сайдбар держит collapse-состояние в React state сессии (не переживает reload) —
  тот же honest-degrade принцип, что остальные best-effort GET в `shell.jsx`
  (`navApps`/`navSections` подгрузка).

## 6. Явно вне scope (наследует границы T-0551 §6 + собственные)

- Вложенные разделы (T-0551 §6, повторно подтверждено).
- Access-control "кто видит раздел" — не трогается.
- Личные (per-user) сохранённые ВИДЫ списков — тот отдельный §4-примитив; здесь только
  общий store, на котором он МОЖЕТ быть построен.
- Реордер зон навигации (Работа/Конструктор/...) между собой — зоны — платформенная
  структура, не пользовательский контент; порядок зон фиксирован (`nav-config.js`
  `ZONES[].order`).
