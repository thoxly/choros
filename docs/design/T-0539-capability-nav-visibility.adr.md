# ADR · T-0539 — Capability-driven Nav Visibility + Screen Registry

**Status:** ready (no founder escalation — founder policy already given)
**Phase:** DESIGN (architect)
**Date:** 2026-06-29
**Task:** T-0539 [NAV-IA / Ф2] — навигация показывает пункт ТОЛЬКО при наличии права, как ПРОЕКЦИЯ grant-модели + реестр экранов с гардом «новый экран обязан объявить зону+capability».
**Block:** E-NAV-IA (родитель T-0537). Потребляет: **T-0538** (мета-поля `{zone,audience,capability,frequency,order}` на `NavItem` — каркас). Заземлён на: **T-0018** (единая grant-таблица), **T-0021** (резолвер/PDP — read-path), **T-0409** (owner-only SoD/структурное), **PD-7/PD-17/PD-21** (продуктовые решения).
**Foundation (НЕ противоречит):** `web/src/app-shell/nav-config.js` (модель `NavItem`/`ZONES` из T-0538), `web/src/app-shell/active-tenant.js` (единственный сегодняшний identity-fetch `GET /api/my-tenant`), `src/db/org.ts` §`loadAdminContext` (`{isGenesisOwner, adminGrants, adminOrgScope}` — готовый шов), `src/core/capability-authz.ts` (прецедент capability-токенов: `authoring_draft`, `llm_connection:configure`, `system_agent:operate`).
**Runtime target:** дизайн — локально; нов. серверная способность `GET /api/me/nav-capabilities` — impl-зависимость (T-0053-territory: реальный PG), зафиксирована, НЕ блокирует дизайн (§11).

---

## 1. Контекст и проблема

T-0538 пересобрал nav в 4 операционные зоны (РАБОТА · КОНСТРУКТОР · НАБЛЮДАЕМОСТЬ · АДМИНИСТРИРОВАНИЕ) и объявил на каждом `NavItem` поле `capability` (+`audience`), но фильтрацию **не реализовал**: дефолт `capability:null ⇒ видно всем`. Сегодня фронт **вообще не знает о правах** — единственный identity-fetch на бут это `GET /api/my-tenant` (`active-tenant.js`), он возвращает только `{tenantId, tenant}`. То есть конечный пользователь видит «Доступ», «LLM-подключение», «Аудит» — весь системный/админский инвентарь — потому что нав показывает всё всем.

Сервер при этом уже держит **реальную** авторитетную модель: единая `grant`-таблица (T-0018), резолвер `loadAdminContext` отдаёт `{isGenesisOwner, adminGrants (mgmt_object:*), adminOrgScope}`, capability-токены (`authoring_draft`, `llm_connection:configure`, `system_agent:operate`) — `src/core/capability-authz.ts`. Каждый защищённый роут уже гейтится `isGenesisOwner || holds<Capability>(grants)`. **Права есть — нав про них не спрашивает.**

Цель T-0539: сделать нав-видимость **ещё одной проекцией того же резолвера** (НЕ второй слой прав), завести **реестр экранов** с гардом «экран без объявления `{zone,capability}` не рендерится», и зафиксировать маппинг 4 зон → требуемый грант по карте фаундера. Owner-only/SoD НЕ переоткрываем (T-0409 решил).

---

## 2. Решение (load-bearing)

**Нав-видимость становится ПРОЕКЦИЕЙ существующего резолвера грантов (T-0021/`loadAdminContext`), а не новым permission-слоем. Сервер отдаёт новый read-only эндпоинт `GET /api/me/nav-capabilities` → `NavCapabilitySet` = `{ isGenesisOwner, capabilities: string[], zones: NavZoneId[] }`, выведенный ИСКЛЮЧИТЕЛЬНО из грантов актора через тот же резолвер; фронт НЕ принимает решений о правах — он лишь скрывает зону/пункт, чьё объявленное `capability` отсутствует в наборе. Каждый экран SPA регистрируется в едином `SCREEN_REGISTRY` (расширение `nav-config.js`), объявляя `{ id, zone, capability, audience, frequency, order, path }`; CI-гард `screen-registry-declares.sh` валит сборку, если экран-маршрут (`<Route>`) не имеет записи в реестре с непустыми `zone` И `capability`-полем (capability может быть `null` ТОЛЬКО для зоны РАБОТА-пола). Маппинг зона→грант системно-фиксирован MVP: РАБОТА=пол (нет capability, видна всем участникам тенанта; пункты по app/process гейтятся реальными ресурс-грантами на read), КОНСТРУКТОР=`authoring_draft`, НАБЛЮДАЕМОСТЬ=новый складываемый грант `observability:read` (заводится как capability-токен по прецеденту `authoring_draft`), АДМИНИСТРИРОВАНИЕ=любой `mgmt_object:grant`/`mgmt_object:role`/оргструктурный грант (= `adminGrants.length>0`); owner-only ломтики внутри (SoD-редактор, free-form «всё», смена суперпользователя) рендерятся под `isGenesisOwner` — НЕ под отдельным grant-checkом (T-0409). Первый вход нового тенанта: пол = только зона РАБОТА (Мои задачи); прочие зоны скрыты, пока актор не держит соответствующий грант — honest-empty (E14/T-0306, PD-7). Деградация fail-closed: резолвер/эндпоинт недоступен ⇒ фронт показывает ТОЛЬКО зону РАБОТА (минимальный пол), НИКОГДА не открывает админ/наблюдаемость по умолчанию.**

Решение **пропорционально** (rubric ось 5): один новый read-only эндпоинт (тонкая обёртка над уже существующим `loadAdminContext` + один новый capability-токен `observability:read`), один реестр-объект в существующем `nav-config.js` + один CI-гард-скрипт, и чистый клиентский фильтр `visibleZones(navSet)`/`visibleItems(zone, navSet)`. Никакого policy-движка на фронте, никакой второй grant-таблицы, никакого дублирования RBAC-логики в SPA — фронт получает РЕШЕНИЕ резолвера и применяет его как presentational-фильтр.

### 2.1 Почему проекция, а не второй слой (крус)

Доктрина T-0018 §2 / T-0021 §1: tools, masked fields, record-rights — **производные проекции** grant-строк; второго permission-подсистемы НЕТ (NF-1, FF-A4 линтит параллельный store). Нав-видимость обязана быть **той же природы**: набор зон/пунктов, которые видит пользователь, выводится из ОДНОГО резолвера, без отдельной таблицы «кому какие пункты меню». Если бы нав-видимость хранилась/решалась отдельно (своя таблица «nav_acl» или хардкод `role==='admin'` в SPA), она бы **дрейфовала** от реальных грантов: пункт виден, но роут 403 (мёртвый пункт — нарушение FF-UX-DEAD T-0538), или пункт скрыт, но право есть (тихая потеря функции). Единственный честный инвариант: **видно ⟺ резолвер подтверждает грант**. Поэтому эндпоинт возвращает не «список разрешённых пунктов» как первичную истину, а `capabilities[]` (набор грантов-проекций) + удобный производный `zones[]`, из которого фронт детерминированно выводит видимость — точно так же, как `loadAdminContext` возвращает `adminGrants`, а роуты выводят из них allow/deny.

### 2.2 Два «слоя видимости», которые НЕ конфликтуют

- **Зона** гейтится **capability-классом** (грубый грант: «есть ли вообще `authoring_draft` / `observability:read` / любой `mgmt_object:*`»). Это решает «показать ли вход в режим».
- **Пункт-по-ресурсу внутри зоны РАБОТА** (конкретное приложение/процесс «Финансы», E16/T-0349 динамические разделы) гейтится **ресурс-грантом** на read через резолвер T-0021 (`isNarrowerOrEqual(handleScope, grant.scope)`). Это решает «какие именно объекты в поле».

Оба — проекции одного резолвера, на разных гранулярностях; в MVP T-0539 строится только зональный слой (грубый), ресурс-слой пунктов РАБОТЫ — задел под E16 (§9 non-goal 2).

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Отдельная таблица/конфиг «nav_acl» (role→visible-items)** | Второй источник истины о видимости. Дрейфует от реальных грантов: пункт виден ⇒ роут 403 (мёртвый пункт), или пункт скрыт ⇒ право есть (тихая потеря). Нарушает T-0018 NF-1 (одна authority-подсистема) и FF-UX-DEAD T-0538. Видимость ОБЯЗАНА быть проекцией резолвера, не отдельным store. |
| **Хардкод role-checков в SPA (`if user.role==='admin'`)** | (а) роли в Choros = СКЛАДЫВАЕМЫЕ наборы грантов (нет enum-роли на фронте), (б) дублирует RBAC-логику в клиенте, который её авторитетно решать НЕ может (фронт-проверка = advisory UI-фильтр, не enforcement — T-0021 §1 caveat «без gateway field-projection degrades to advisory UI filter and the thesis is theater»). Решает сервер; фронт лишь применяет. FF-NAV-PROJ линтит отсутствие хардкод role-string в nav-фильтре. |
| **Эндпоинт возвращает готовый отрендеренный список пунктов меню** | Связывает серверный контракт с конкретной IA фронта (зоны/пункты T-0538). При каждой правке nav-IA пришлось бы менять серверный ответ. Эндпоинт отдаёт **capability-проекцию** (грант-набор + производные зоны) — стабильный контракт; маппинг capability→пункт живёт в `nav-config.js` (там, где IA). |
| **Клиент сам резолвит гранты (тянет сырые `grant`-строки + лес иерархии на фронт)** | Утечка авторитетной модели и иерархии в недоверенный клиент; нав-фильтр стал бы реимплементацией lattice-алгебры (`isNarrowerOrEqual`) в JS — два резолвера, которые разойдутся. Резолвинг — на сервере (T-0021), фронт получает РЕШЕНИЕ. |
| **Нав-видимость на отдельном permission-axis (свой `nav:see` грант на каждый пункт)** | Плодит N грантов-зеркал реальных capability (грант «видеть пункт Аудит» ⊥ грант «читать аудит»). Видимость зоны и есть «у меня есть класс грантов этой зоны» — без зеркального гранта. Owner-only ломтики — через `isGenesisOwner`, не через зеркальный `nav:`-грант. |
| **Fail-OPEN при недоступном резолвере (показать всё, потом фильтровать)** | Нав показал бы админ/наблюдаемость пользователю без права на доли секунды/при деградации — security-театр и UX-дефект (мёртвые пункты → 403). Fail-CLOSED обязателен: резолвер down ⇒ только пол РАБОТА (§8). |
| **Гард реестра как runtime-исключение (экран без объявления падает в браузере)** | Поздно и хрупко (ловится только при заходе пользователя). Гард — **CI-static** (`screen-registry-declares.sh`): экран-`<Route>` без записи реестра с `{zone,capability}` ⇒ сборка красная ДО деплоя (FF-SCREEN-DECL). |

Ни один из них не переоткрывает решение фаундера; это стандартные альтернативы capability-видимости, записаны для аудита.

---

## 4. Object model

### 4.1 `NavCapabilitySet` — ответ `GET /api/me/nav-capabilities` (проекция резолвера)

| Field | Type | Meaning / constraint |
|---|---|---|
| `isGenesisOwner` | `boolean` | актор — генезис-владелец тенанта (un-parented root, T-0018 §4.3). Источник: `loadAdminContext.isGenesisOwner` (резолвится из DB, НЕ из заголовка — T-0030 NF-3). Включает owner-only ломтики. |
| `capabilities` | `string[]` | плоский набор capability-токенов, которыми актор реально владеет (in-window, confirmed), выведенный из его грантов: подмножество `{ 'authoring_draft', 'observability:read', 'mgmt_object:grant', 'mgmt_object:role', ... }`. Сырые ресурс-гранты (app/process scope) сюда НЕ кладутся — только capability-классы, гейтящие ЗОНЫ. Genesis-owner: сервер отдаёт полный набор (owner держит всё по короткому замыканию). |
| `zones` | `NavZoneId[]` | производное от `capabilities`+`isGenesisOwner`: `['work']` всегда (пол); `+'constructor'` если `authoring_draft`; `+'observability'` если `observability:read`; `+'admin'` если любой `mgmt_object:*` ИЛИ `isGenesisOwner`. Удобство для фронта; фронт МОЖЕТ вывести это сам из `capabilities` — `zones` это та же проекция, материализованная сервером (единый маппинг §6). |
| `degraded` | `boolean=` | опц. флаг: `true`, если сервер не смог полностью резолвить (частичная деградация) — фронт трактует как fail-closed (§8). Отсутствует ⇒ нормальный ответ. |

- **TS-зеркало (фронт, JSDoc):** `{ isGenesisOwner: boolean, capabilities: string[], zones: NavZoneId[], degraded?: boolean }`.
- **Инвариант проекции:** `zones` ВСЕГДА содержит `'work'` (пол для любого участника тенанта — PD-7/T-0538). Пустой `capabilities` + не-owner ⇒ `zones === ['work']` (honest-empty первого входа, §7).

### 4.2 `ScreenRegistryEntry` — запись реестра экранов (расширение `nav-config.js`)

| Field | Type | Meaning / constraint |
|---|---|---|
| `id` | `string` | стабильный screen-id (== `NavItem.id`, основа маршрута). PK реестра. |
| `zone` | `NavZoneId \| null` | зона экрана (`'work'|'constructor'|'observability'|'admin'`); `null` ТОЛЬКО для over-zone home (`overview`). |
| `capability` | `string \| null` | capability-токен, гейтящий видимость. `null` ⇒ видно всем участникам тенанта — ДОПУСТИМО ТОЛЬКО для `zone:'work'` (пол) и home. Не-work зона с `capability:null` ⇒ CI-fail (FF-SCREEN-DECL). |
| `audience` | `NavAudience` | семантический ярлык (`end-user|builder|manager|admin`) — из T-0538, информативно. |
| `frequency` | `NavFrequency` | `daily|weekly|rare` — из T-0538, информативно. |
| `order` | `number` | порядок (из T-0538). |
| `path` | `string=` | переопределение маршрута (инвариант T-0538 §6: маршруты не меняются). |
| `ownerOnly` | `boolean=` | `true` ⇒ ломтик виден ТОЛЬКО при `isGenesisOwner` (SoD-редактор, free-form «всё», смена суперпользователя — T-0409). НЕ отдельный грант; фронт сверяет `navSet.isGenesisOwner`. |
| `hidden` | `boolean=` | скрыт из nav (маршрут жив) — из T-0538 (`forms`). |
| `requestable` | `boolean=` | задел: мощная функция может показать «запросить доступ» вместо скрытия (фаундер: «мощные функции могут запросить»). MVP — `false`/отсутствует (скрываем зону); поле объявлено под будущее. |

- **Гард-инвариант (FF-SCREEN-DECL):** каждый экран-`<Route>` в `shell.jsx` ОБЯЗАН иметь `ScreenRegistryEntry` с непустым `zone` И определённым `capability`-полем (значение может быть `null` лишь для `zone:'work'`/home). Экран-маршрут без записи ИЛИ с `zone:'admin'/'constructor'/'observability'` и `capability:null` ⇒ CI-fail. Так «новый экран обязан объявить зону+capability» становится механическим гейтом, а не дисциплиной.
- **Где живёт:** `SCREEN_REGISTRY` — производная карта в `web/src/app-shell/nav-config.js` (тот же файл, что `ZONES` T-0538), построенная как `Object.fromEntries(allItems.map(i => [i.id, entry]))`. Реестр и nav — **одна модель** (`NavItem` уже несёт `{zone,capability,audience,frequency,order}`); реестр — это индекс по `id` + гард полноты против `<Route>`-множества.

### 4.3 `observability:read` — новый складываемый capability-грант (НУЖНО ЗАВЕСТИ)

| Аспект | Значение |
|---|---|
| **Зачем** | Зона НАБЛЮДАЕМОСТЬ (`ops-overview`/`reports`/`process-analytics`/`audit`/`spend`) — отдельная аудитория «менеджер»: должна видеть зону БЕЗ админ-грантов (`mgmt_object:*`) и без `authoring_draft`. Сегодня такого складываемого права нет — менеджер либо owner/admin (видит всё), либо ничего. Заводим точечный capability-токен. |
| **Тип ресурса / операция** | `resource_type = 'observability:read'`, `operation = 'read'`. Capability-токен (НЕ org-scoped, НЕ в closed lattice `ResourceType`-union) — хранится verbatim в `choros."grant".resource_type` (free text, нет DB CHECK), ТОЧНО как `authoring_draft` / `llm_connection:configure` / `system_agent:operate` (`capability-authz.ts` прецедент). `scope` для capability-токена — конвенционально `BOTTOM`/whole-tenant (capability не ресурс-scoped). |
| **Предикат** | Новый `holdsObservabilityRead(grants): boolean = grants.some(g => g.resourceType === 'observability:read')` в `src/core/capability-authz.ts` (рядом с `holdsLlmConnectionConfigure`). Owner-короткое-замыкание (`isGenesisOwner ||`) — у вызывающего. |
| **Кто выдаёт** | Тот же путь, что прочие capability-гранты: владелец (genesis-owner) ИЛИ scoped-admin с `mgmt_object:grant` через редактор грантов (`/rights`). Владелец держит по короткому замыканию (видит зону всегда). Выдача = обычная grant-выдача (T-0018 audit-emit обязателен). |
| **Граница** | НЕ переоткрывает owner-only/SoD (T-0409): `observability:read` — обычный складываемый грант (как `authoring_draft`), НЕ owner-only. Это read-only зона; никаких структурных мутаций. |

> **Impl-зависимость (НЕ блокирует дизайн, §11):** заведение токена = (1) константа `OBSERVABILITY_READ` + предикат в `capability-authz.ts`, (2) включение `'observability:read'` в SELECT capability-грантов нового эндпоинта, (3) выдаваемость через grant-редактор (`resource_type` free-text — миграция не нужна, как `authoring_draft`). Это runtime/impl-зона; дизайн фиксирует контракт.

### 4.4 Серверный шов эндпоинта (контракт; impl — §11)

```
GET /api/me/nav-capabilities
  → 200 NavCapabilitySet { isGenesisOwner, capabilities[], zones[], degraded? }
  → 401 UNAUTHENTICATED (нет валидной identity — fail-closed, фронт → пол РАБОТА)

Реализация (тонкая обёртка, НЕ новый резолвер):
  actorSlug ← resolveActorSlugFromAuth(authCtx)        // как /api/my-tenant
  tenantId  ← resolveActorTenant(actorSlug)            // как /api/my-tenant
  admin     ← loadAdminContext(pool, tenantId, actorSlug, now)   // СУЩЕСТВУЮЩИЙ резолвер
  capGrants ← SELECT grant WHERE role∈actorRoles
                AND resource_type IN ('authoring_draft','observability:read')   // capability-токены
                AND in-window AND confirmed                                       // тот же фильтр, что DAO
  capabilities ← [...capGrants.map(resType)]
                 ⋃ admin.adminGrants.map(resType)        // mgmt_object:* классы
  isGenesisOwner ← admin.isGenesisOwner
  zones ← projectZones(capabilities, isGenesisOwner)     // единый маппинг §6
  → { isGenesisOwner, capabilities, zones }
```

`projectZones` — ЕДИНСТВЕННОЕ место маппинга capability→зона (§6), переиспользуемо фронтом и сервером (общий чистый хелпер; на фронте дублируется как presentational-вывод, контракт один). dev-no-db / резолвер-fail ⇒ `degraded:true` + `zones:['work']` (§8).

---

## 5. Клиентская проекция (presentational-фильтр)

```js
// web/src/app-shell/nav-config.js — additive helpers (zero-dep, plain JS)

/** Зоны, видимые актору, из ответа эндпоинта. */
export function visibleZones(navSet /* NavCapabilitySet */) {
  if (!navSet) return ['work'];                 // fail-closed: нет данных → только пол
  return navSet.zones && navSet.zones.length ? navSet.zones : ['work'];
}

/** Пункты зоны, видимые актору (zone-гейт + owner-only ломтики). */
export function visibleItems(zoneId, navSet) {
  if (!visibleZones(navSet).includes(zoneId)) return [];   // зона скрыта целиком
  const zone = ZONES.find((z) => z.id === zoneId);
  return (zone ? zone.items : [])
    .filter((it) => !it.hidden)                            // T-0538 hidden
    .filter((it) => !it.ownerOnly || (navSet && navSet.isGenesisOwner)); // T-0409 ломтики
}
```

Фронт НЕ принимает grant-решений — он применяет РЕШЕНИЕ сервера (`navSet.zones`/`isGenesisOwner`). Никаких `role`-строк, никакого резолвинга lattice. Командная палитра (`paletteDestinations`) фильтруется тем же `visibleZones`/`visibleItems` (скрытый пункт не всплывает в палитре — иначе обход видимости). Бут: shell тянет `nav-capabilities` рядом с `my-tenant`; до ответа — пол РАБОТА (fail-closed-by-default, не мигание всего меню).

---

## 6. Маппинг 4 зон → требуемый грант (карта фаундера, системно-фиксировано MVP)

| Зона | Требование видимости (capability) | Источник в `NavCapabilitySet` | Owner-only ломтики внутри |
|---|---|---|---|
| **РАБОТА** | ПОЛ — нет capability; видна ВСЕМ участникам тенанта. Пункты по конкретному app/process гейтятся реальным ресурс-грантом на read (T-0021, задел E16). | всегда в `zones` | — |
| **КОНСТРУКТОР** | грант `authoring_draft` (PD-21: песочница/draft = админ/владелец) | `'authoring_draft' ∈ capabilities` | — |
| **НАБЛЮДАЕМОСТЬ** | НОВЫЙ складываемый грант `observability:read` (§4.3) — менеджер видит зону без админки | `'observability:read' ∈ capabilities` | — |
| **АДМИНИСТРИРОВАНИЕ** | любой `mgmt_object:grant`/`mgmt_object:role`/оргструктурный грант (= `adminGrants.length>0`) ИЛИ `isGenesisOwner` | `capabilities ∋ mgmt_object:*` ∨ `isGenesisOwner` | SoD-редактор · free-form «всё» · смена суперпользователя ⇒ `ownerOnly:true` ⇒ только `isGenesisOwner` (T-0409, НЕ переоткрываем) |

**Складываемость (данность фаундера):** роли = наборы грантов. Владелец=`isGenesisOwner` ⇒ все зоны + owner-only. Админ=`scoped-admin` (`authoring_draft` + `mgmt_object:grant/role` + оргструктура) ⇒ РАБОТА+КОНСТРУКТОР+АДМИНИСТРИРОВАНИЕ (минус owner-only ломтики). Пользователь = держатель выданных грантов ⇒ РАБОТА + зоны, чьи capability ему выданы (напр. менеджер с `observability:read` ⇒ РАБОТА+НАБЛЮДАЕМОСТЬ). Дефолт role→zones MVP системно-фиксирован этим маппингом; админ-настройка видимости — позже (§9 non-goal).

`projectZones(caps, owner)` (§4.4) кодирует ровно эту таблицу — одно место истины маппинга.

---

## 7. Honest first-run (новый тенант / новый юзер)

Пол нового юзера = ТОЛЬКО зона РАБОТА (Мои задачи) — PD-7 (овнер из коробки = полный доступ — для НЕГО `isGenesisOwner` ⇒ все зоны; для приглашённого пользователя без грантов ⇒ `zones:['work']`). Новый тенант до настройки оргструктуры: участник без грантов видит пустую РАБОТУ (honest-empty E14/T-0306 — интерфейс показывает СОСТОЯНИЕ тенанта, не демо). Зоны КОНСТРУКТОР/НАБЛЮДАЕМОСТЬ/АДМИНИСТРИРОВАНИЕ **отсутствуют в сайдбаре**, пока актор не получит грант — не серым-disabled, а скрыты (фаундер: «нет доступа → ЗОНУ прятать»). Owner на первом входе видит всё (его `isGenesisOwner` ⇒ полный `zones`), что согласуется с PD-7 «настраивает систему сам». Связь: пустая РАБОТА не должна выглядеть сломанной — honest-empty состояние (T-0306) внутри зоны.

---

## 8. Деградация (fail-closed)

| Сбой | Поведение |
|---|---|
| `GET /api/me/nav-capabilities` недоступен / сеть / 5xx | Фронт показывает ТОЛЬКО зону РАБОТА (`visibleZones(null) → ['work']`). НИКОГДА не открывает админ/наблюдаемость/конструктор по умолчанию. |
| Эндпоинт вернул `degraded:true` (сервер не смог полностью резолвить) | Трактуется как fail-closed: `zones:['work']`. |
| `401 UNAUTHENTICATED` | Пол РАБОТА (или редирект на логин — существующий поток). |
| dev-no-db | Сервер отдаёт `degraded:true`+`zones:['work']` (минимальный пол; dev-стек без PG не симулирует гранты). |
| До ответа на буте (loading) | Пол РАБОТА (не мигание полного меню → не fail-open). |

Принцип: **отсутствие подтверждённого гранта ⇒ скрыто**. Резолвер down ≠ «покажем на всякий случай» — это security-театр (мёртвые пункты → 403 + утечка инвентаря функций). Зеркалит T-0021 FR-5 (default-deny / fail-closed) на нав-слое.

---

## 9. Non-goals (НЕ строится в T-0539)

1. **Ресурс-гранулярный фильтр пунктов внутри РАБОТЫ** (конкретные приложения/процессы по read-гранту, динамические «Разделы» Финансы/HR) — задел E16/T-0349; T-0539 строит зональный (грубый) слой.
2. **Админ-настраиваемая видимость** (владелец кастомизирует role→zones) — дефолт MVP системно-фиксирован (§6); кастом позже.
3. **«Запросить доступ»-поток** (`requestable`) — поле объявлено (§4.2), UX/бэкенд запроса — позже; MVP скрывает зону.
4. **Серверный enforcement роутов** — НЕ задача T-0539: роуты УЖЕ гейтятся (`isGenesisOwner||holds*`, T-0018/T-0021). Нав-видимость — UI-проекция поверх существующего enforcement, НЕ замена ему (фронт-фильтр ≠ enforcement — T-0021 §1 caveat).
5. **Переоткрытие owner-only/SoD** — T-0409 решил; owner-only ломтики через `isGenesisOwner`, НЕ новый axis.
6. **Изменение маршрутов/`<Route>`** — запрещено инвариантом T-0538 §6.
7. **DDL/миграция для `observability:read`** — не нужна (capability-токен = free-text `resource_type`, прецедент `authoring_draft`); только константа+предикат+выдаваемость (§4.3, §11).

---

## 10. Fitness-функции (CI-gating)

| FF | Правило (assert) | ci_check | gating |
|---|---|---|---|
| **FF-NAV-PROJ** | Нав-видимость выводится ТОЛЬКО из ответа резолвера (`NavCapabilitySet`): нет хардкод role-string-checков в нав-фильтре (`if role==='admin'`, `slug==='owner'` и т.п.); единственные источники видимости — `navSet.zones` / `navSet.isGenesisOwner` / `it.ownerOnly`. | `ci/checks/ux/nav-projection-only.sh` (grep nav-фильтра на role-string-литералы → fail) | static-now |
| **FF-SCREEN-DECL** | Каждый экран-`<Route>` в `shell.jsx` имеет `ScreenRegistryEntry` с непустым `zone` И определённым `capability`-полем; не-`work`/не-home зона с `capability:null` ⇒ fail; `<Route>` без записи реестра ⇒ fail. | `ci/checks/ux/screen-registry-declares.sh` (сверка множества `<Route path>` ↔ `SCREEN_REGISTRY` ключей + проверка полей) | static-now |
| **FF-FAILCLOSED** | `visibleZones(null)` и `visibleZones({degraded:true})` возвращают РОВНО `['work']`; никакой путь деградации не возвращает админ/наблюдаемость/конструктор. | `vitest web/src/app-shell/nav-visibility.test.js` (юнит на фильтр) | static-now |
| **FF-NAV-ZONEMAP** | `projectZones` детерминированно кодирует карту §6: `authoring_draft⇒constructor`, `observability:read⇒observability`, `mgmt_object:*∨owner⇒admin`, всегда `work`; пустой+не-owner ⇒ `['work']`. | `vitest` (фикстура capability→zones, обе стороны: фронт-хелпер == сервер-хелпер) | static-now |
| **FF-OWNERONLY** | Пункт с `ownerOnly:true` НЕ виден при `isGenesisOwner:false` (SoD-редактор/free-form/смена суперпользователя скрыты не-владельцу); виден при `true`. | `vitest` (фикстура `visibleItems` owner/не-owner) | static-now |
| **FF-NAV-NODEAD** (наследует T-0538 FF-UX-DEAD) | Видимый (после фильтра) пункт ведёт на роут, к которому у актора есть право (нет видимого-но-403): пересечение `visibleItems` × серверный gate непусто для каждого видимого пункта в фикстуре ролей (владелец/админ/менеджер/пользователь). | `e2e/journeys/nav-capability.ux.journey.ts` (4 персоны против собранного `web/dist`+живой эндпоинт) | activates-on-deploy (journey; static-фикстура сейчас) |

> Минимум контракта выполнен: FF-NAV-PROJ (нав только через резолвер, нет хардкод role-checks) + FF-SCREEN-DECL (экран без `{zone,capability}` → CI-fail) + FF-FAILCLOSED (резолвер down → только РАБОТА). Новые `*.sh` — additive в `ci/checks/ux/`; новый journey — additive в `e2e/journeys/` (zero runner-change).

---

## 11. Impl-зависимости (runtime — НЕ блокируют дизайн)

1. **Новый эндпоинт `GET /api/me/nav-capabilities`** — тонкая обёртка над `loadAdminContext` + SELECT capability-грантов (`authoring_draft`,`observability:read`). Живёт рядом с `/api/my-tenant` (`src/http/org.ts`-territory). Требует реального PG (T-0053-стек, founder-gated deploy). Контракт зафиксирован §4.4.
2. **Capability-токен `observability:read`** — константа `OBSERVABILITY_READ` + предикат `holdsObservabilityRead` в `src/core/capability-authz.ts`; включение в SELECT эндпоинта; выдаваемость через grant-редактор (`resource_type` free-text — миграция НЕ нужна). §4.3.
3. **Клиентский фетч на буте** — shell тянет `nav-capabilities` рядом с `resolveActiveTenant()` (`active-tenant.js`-паттерн), кэширует; `visibleZones`/`visibleItems` читают кэш. До ответа — пол РАБОТА.

Всё это — impl-зона следующего прогона (coder); дизайн фиксирует контракты, объект-модель, fitness. Высоколеверажных НОВЫХ продуктовых развилок не всплыло (фаундер дал политику: складываемые гранты, прятать зону, пол=РАБОТА, owner-only=T-0409). Status: **ready**.

---

## 12. Traceability (требование → дизайн)

| Требование (промпт/политика фаундера) | Покрыто |
|---|---|
| Нав-видимость = проекция существующей grant-модели, НЕ второй слой | §2, §2.1, §3 (rejected: nav_acl / hardcode role) |
| API/селектор «что видит пользователь», заземлён на резолвер T-0021 | §2, §4.1, §4.4 (`GET /api/me/nav-capabilities` обёртка над `loadAdminContext`) |
| Возвращает набор грантов, из которого фронт выводит зоны | §4.1 (`capabilities[]`+`zones[]`), §5, §6 (`projectZones`) |
| Реестр экранов: экран объявляет `{zone,capability,audience,frequency,order}` | §4.2 (`ScreenRegistryEntry`, в `nav-config.js`) |
| Гард: экран без объявления не рендерится | §4.2 (FF-SCREEN-DECL, CI-static), §10 |
| Маппинг 4 зон → грант (РАБОТА пол / КОНСТРУКТОР authoring_draft / НАБЛЮДАЕМОСТЬ observability:read / АДМИН mgmt_object:*) | §6 |
| Owner-only ломтики через isGenesisOwner (T-0409, не переоткрывать) | §4.2 (`ownerOnly`), §6, §3, §9 non-goal 5 |
| НУЖЕН-новый-грант observability:read — как заводится, кто выдаёт | §4.3, §11 |
| Honest first-run: пол нового тенанта = только РАБОТА (E14/T-0306, PD-7) | §7 |
| Деградация: резолвер down → fail-closed (только РАБОТА), не fail-open | §8, §3 (rejected fail-open), FF-FAILCLOSED §10 |
| FF: нав только через резолвер, нет хардкод role-checks | §10 FF-NAV-PROJ |
| FF: экран без {zone,capability} → CI-fail | §10 FF-SCREEN-DECL |
| FF: резолвер down → только РАБОТА | §10 FF-FAILCLOSED |
| Новая серверная способность зафиксирована как impl-зависимость, не блокирует | §11 |
```
