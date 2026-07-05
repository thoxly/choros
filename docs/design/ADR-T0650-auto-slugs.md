# ADR · T-0650 — Авто-слаги: серверный генератор + SlugField

**Phase:** DESIGN → BUILD · **Status:** implemented · **Date:** 2026-07-05
**Task:** T-0650 [W4-UX] (родитель T-0647 E-UX-HUMAN)
**Source:** `docs/design/ux-study-2026-07-05.md` §7
**Foundation:** `src/core/slugify-process-key.ts` (T-0377, генератор ключей процессов —
прототип, УНИФИЦИРОВАН на новый общий модуль), `src/core/register.ts::slugifyOrgName` (T-0140,
self-reg — НЕ тронут, держит свою копию карты), `web/src/forms/relation-cascade.js::slugFromName`
(фронтовый дубль транслита — НЕ тронут, держит свою копию), `src/http/applications.ts` /
`registry-defs.ts` / `seed-write.ts` (`SLUG_RE`, `UNIQUE(tenant_id[, scope], slug)` + catch
23505 → 409 — уже канонический паттерн, переиспользован для авто-генерации).

---

## 1. Контекст

Три независимые транслит-карты кириллица→латиница уже существуют в кодовой базе
(`slugify-process-key.ts`, `register.ts`, `relation-cascade.js`) — намеренно продублированные
(комментарии в коде явно говорят «duplicated to avoid circular deps»), но их ГРАММАТИКА
идентична и совпадает с канонической `SLUG_RE` (`^[a-z0-9][a-z0-9-]{0,63}$`), которая тоже
продублирована в 6+ файлах. Генератор транслита фактически СУЩЕСТВУЕТ и уже применяется
(ключ процесса в модельере авто-генерится — источник `novyy-protsess-N`, когда автор не
назвал процесс); проблема — он не применён к остальным 10 местам создания.

**Область унификации в T-0650 (честно, F2 из ревью):** новый канонический модуль
`src/core/slug-generator.ts` вводится как единственный источник транслит-карты + грамматики,
и на него мигрирован ТОЛЬКО backend-путь ключей процессов (`slugify-process-key.ts` стал
тонкой обёрткой). Две другие копии карты — `register.ts::slugifyOrgName` (self-reg тенанта)
и `web/src/forms/relation-cascade.js::slugFromName` (клиентский каскад) — **НЕ мигрированы**
осознанно: их выход не должен меняться этой задачей (self-reg использует свой fallback
«org» и SLUG_MAX=80; клиентский каскад — свой fallback «app»), а без-регрессионная миграция
их обоих — отдельная работа вне скоупа T-0650. Т.е. дубликат карты остаётся в 2 из 3 мест;
T-0650 не претендует их устранить, только унифицировать process-key путь и дать всем НОВЫМ
create-эндпоинтам единый серверный генератор.

## 2. Решение: канонический генератор + опциональность на существующих unique-констрейнтах

### 2.1 `src/core/slug-generator.ts` — новый канонический модуль

```ts
export function transliterate(input: string): string        // кириллица → латиница, без grammar-фильтра
export function generateSlugFromName(name: string): string   // полный слаг: translit → lower → [a-z0-9-] → collapse → trim → cap(60)
export async function generateUniqueSlug(
  name: string,
  existsFn: (candidate: string) => Promise<boolean>,
  opts?: { maxNumberedAttempts?: number },
): Promise<string>                                            // base, base-2 … base-10, затем base-<uuid8>
export const SLUG_GENERATOR_RE: RegExp                        // = каноническая грамматика (единственный источник)
```

Заменяет транслит-карту ВНУТРИ `slugify-process-key.ts` (и только его — см. §1 про
`register.ts`/`relation-cascade.js`, которые НЕ тронуты) — **`slugify-process-key.ts`
теперь тонкая обёртка** над `generateSlugFromName`/`generateUniqueSlug`. Ни один существующий
импорт не сломан, и вывод **байт-в-байт неизменен**, ВКЛЮЧАЯ fallback-слово: обёртка
коэрсит generic-fallback генератора (`"item"`, экспорт `GENERIC_SLUG_FALLBACK`) обратно
в исторический `"process"` на своей границе — для ЛЮБОГО имени, дающего пустой слаг (пустое,
из пробелов, ИЛИ символ-онли типа `"!!!###"`/`"ъъъ"`/`"---"`, которое фильтруется в пустоту).
Это точечно исправлено в F1 (изначальный рефактор регрессировал `"process"→"item"` на
символ-онли входах; закреплено pin-тестом `process-defs.test.ts`, мутационно проверено).
`generateUniqueProcessKey` использует `generateUniqueSlug` с сохранённой формой
fallback-суффикса — байт-в-байт совместимо с существующими тестами `process-defs.test.ts`.

### 2.2 Атомарность коллизии — ДВА слоя, не read-then-write race

`generateUniqueSlug`'s `existsFn`-паттерн (унаследован от `generateUniqueProcessKey`) сам по
себе **не** гарантирует атомарность — между "проверили, слага нет" и "вставили" есть окно
гонки при двух параллельных запросах с одинаковым названием. T-0650 закрывает это ВТОРЫМ
слоем на каждом create-эндпоинте, тем же паттерном, что уже используют
`createApplication`/`createRegistryDef`/`seed-write.ts`'s `isConflict`:

```
1. Если slug передан явно → use as-is (валидация SLUG_RE, INSERT, 23505 → 409 как раньше).
2. Если slug НЕ передан:
     candidate = generateSlugFromName(displayName)
     for attempt in 0..MAX_SUFFIX_ATTEMPTS:
       try INSERT with candidate (or candidate-N for attempt>0)
       on success → done
       on 23505 (unique_violation) → candidate = `${base}-${attempt+2}`; retry
     if all numbered attempts collide → candidate = `${base}-${randomUUID8}` (INSERT once more; this
       is practically guaranteed unique — no further retry needed)
```

Ключевое свойство: **уникальность проверяется РОВНО ТАМ, где её проверяет БД** — сам INSERT
под существующим `UNIQUE(tenant_id[, scope], slug)` констрейнтом внутри `withTenantTx`. Нет
отдельного SELECT-для-проверки шага, значит нет TOCTOU-окна: если два конкурентных запроса
с названием «Закупки» стартуют одновременно, ровно один получит `zakupki` (кто первый
закоммитит), второй поймает 23505 на `zakupki` и повторит INSERT с `zakupki-2` — атомарно,
никакого advisory-lock не требуется, потому что retry происходит на настоящем write-конфликте,
не на предварительном чтении.

Это ОТЛИЧАЕТСЯ от старого `generateUniqueProcessKey` (process-defs.ts), где `existsFn`
делает отдельный SELECT перед INSERT (гонка теоретически возможна, хоть и практически
маловероятна при одном авторе/один клик) — T-0650 не трогает process-defs.ts (не в скоупе
задачи, вне 11 мест §7), но новые эндпоинты используют более строгий retry-on-conflict
паттерн.

### 2.3 Почему не advisory-lock

`pg_advisory_xact_lock` потребовал бы стабильного numeric-ключа на (tenant, scope, base-slug)
и держал бы лок на всю транзакцию — накладные расходы ради случая, который и так закрывается
существующим unique-индексом с O(1) retry (максимум 10 занумерованных попыток + 1
гарантированно уникальная uuid-suffix попытка = не более 11 INSERT в вырожденном случае
массовой конкурентной коллизии, а в реальности — 1 INSERT почти всегда). Unique-индекс уже
есть на каждой из 6 таблиц (migrations 003/004/014/015/016/019) — использовать его как
арбитр дешевле и надёжнее, чем городить второй механизм блокировки поверх него.

## 3. Опциональность на create-эндпоинтах (список из T-0650.spec.md)

| Эндпоинт | Файл | База слага | Уникальность |
|---|---|---|---|
| `POST /api/applications` | `src/http/applications.ts` | `display_name` | `UNIQUE(tenant_id, slug)` |
| `POST /api/registry-defs` | `src/http/registry-defs.ts` | `display_name` | `UNIQUE(tenant_id, application_id, slug)` |
| `POST /api/departments` | `src/http/seed-write.ts` | `display_name` | `UNIQUE(tenant_id, slug)` |
| `POST /api/positions` | `src/http/seed-write.ts` | `title` | `UNIQUE(tenant_id, department_id, slug)` |
| `POST /api/employees` | `src/http/seed-write.ts` | `display_name` | `UNIQUE(tenant_id, slug)` |
| `POST /api/roles` | `src/http/seed-write.ts` | `display_name` | `UNIQUE(tenant_id, slug)` |

Каждый маршрут: `slug` меняется с обязательного на `slug?: string` — если `undefined`/пустая
строка/отсутствует ключ, генерируем; если непустая строка передана, старая ветка валидации
работает БЕЗ ИЗМЕНЕНИЙ (byte-for-byte та же проверка `SLUG_RE`/`length===0`, что и раньше) —
старые вызовы (существующие тесты, сид-импортёр, скрипты) не видят разницы в поведении.

## 4. `SlugField` — контракт UI-компонента

`web/src/components/slug-field.jsx`:

```jsx
<SlugField
  name={displayName}          // «Название» — источник авто-превью
  value={slug}                // текущий слаг (controlled)
  onChange={setSlug}           // (nextSlug: string) => void
  locked={false}               // true после создания (immutable) — рендерит MonoId, не input
  error={fieldErrors.slug}     // серверная 409/400 ошибка
/>
```

Поведение:
- Пока пользователь НЕ трогал слаг руками — компонент держит внутренний `dirty=false` и
  зеркалит `generateSlugFromName(name)` в live-подпись под полем: **«будет создан как
  `zakupki-oborudovaniya` · изменить»**. Слаг НЕ отправляется на сервер, пока пользователь не
  нажмёт «изменить» (сворачивание в explicit input) ИЛИ пока форма не сабмитится — сервер
  сам сгенерирует финальный (с учётом коллизии), клиентское превью — только для UX-ожидания,
  не источник истины.
- «изменить» разворачивает обычный `<Field mono>` с текущим авто-превью как начальным
  значением; дальнейший ввод названия больше НЕ перезаписывает слаг (`dirty=true`,
  необратимо для этой сессии формы).
- `locked=true` (после создания сущности) — рендерит `<MonoId>{value}</MonoId>` без инпута
  (слаг неизменяем после создания — не новое поведение, просто явный визуальный контракт
  вместо "поля с disabled").
- Токены: `--chs-color-text-muted` для подписи-превью, `--chs-text-xs`; кнопка «изменить» —
  `<Button variant="ghost" size="sm">`. Ноль хардкод-цвета (UX-гейт G6).

## 5. Ассистент (столп 5)

`src/core/assistant-configurator.ts`'s `create_application` tool-handler: когда `appSlug`
отсутствует ИЛИ не проходит `CONFIGURATOR_SLUG_RE`, вместо немедленной блокировки
(`pending_human_confirm`) вызывается `generateSlugFromName(appDisplayName)` — тот же модуль,
что видит человек в UI. Блокировка на невалидный slug остаётся ТОЛЬКО если `appDisplayName`
тоже пуст (нечего транслитерировать) — это уже отдельная существующая ветка. Коллизия на
уровне ассистента разрешается на том же create_application HTTP-пути
(`POST /api/applications`), который уже делает retry-on-conflict (§3) — ассистенту не нужен
отдельный existsFn, он просто не присылает slug и получает готовый уникальный слаг в ответе.

## 6. Обратная совместимость / анти-регресс

- Все существующие тесты, отправляющие `slug` явно, продолжают проходить без изменений
  (ветка "explicit slug" не тронута).
- `slugify-process-key.ts` публичный API (`slugifyProcessName`, `generateUniqueProcessKey`)
  не меняет сигнатуры — внутренняя реализация делегирует в `slug-generator.ts`.
- Клиентские мирроры `SLUG_RE` (org-crud.js, apps-validate.js, agents-form.js) НЕ удаляются —
  они остаются клиентской UX-подсказкой (источник истины — сервер); `SlugField` их
  переиспользует для live-валидации при ручном редактировании.

## 7. Покрытые места (см. T-0650.spec.md §«Не в обязательном скоупе» для отложенных)

Ядро + 6 create-эндпоинтов (applications/registry-defs/departments/positions/employees/roles)
+ `SlugField` применён в UI этих 6 форм (`screen-apps.jsx` CreateAppModal,
`screen-app-schema.jsx` FieldEditor-create, `screen-org.jsx` через `org-crud.js`
data-driven config для department/position/employee/role) + ассистент `create_application`.
