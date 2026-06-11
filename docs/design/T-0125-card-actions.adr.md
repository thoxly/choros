# ADR · T-0125 — Card actions как примитив формы

**Date:** 2026-06-11
**Task:** T-0125 — E9: card action = декларативная кнопка на карточке = именованная операция над записью/инстансом процесса + грант через PDP + аудит + привязка к процессу; дефолт из объектной модели+статуса, кастом поверх.
**Phase:** DESIGN (architect). Реализацию НЕ пишем — это `coder`.
**Spec consumed:** `docs/specs/T-0125-card-actions.spec.md` + `docs/specs/T-0125.spec.contract.json` (FR-1..FR-9, NF-1..NF-7, AC-1..AC-15).

**Foundation (do NOT contradict) — статусы несущих опор, проверено в живом коде:**

| Опора | Статус | Доказательство (file:line) |
|---|---|---|
| Operation enum (закрытый) | **ЖИВОЙ** | `src/core/grant-lattice.ts:25-32` — `read\|create\|update\|delete\|approve\|transition\|invoke` |
| PDP `resolveFor` | **ЖИВОЙ** | `src/core/grant-resolver.ts:489` — `resolveFor(deps, handle, subject, op, invokeCtx?, guardCtx?)`; tenant-gate fail-closed :497-500 |
| Mutation-gateway (единственный writer) | **ЖИВОЙ (контракт + FF)** | T-0028 ADR §FF-G1/FF-G3; `ci/checks/mutation-gateway-isolation.sh`; единственный writer = `grant-resolver.ts` (T-0028 ADR §197) |
| Actor-event ledger / guarded transition | **ЖИВОЙ** | `src/core/actor-event.ts:87,98,132` — `AppendedActorEvent`/`ActorEventWriter`/`validateActorEventInput`; vocab pinned `ci/checks/actor_event_vocab_pinned.sh` |
| Invoke-effect | **ЖИВОЙ** | `src/core/effect-resource.ts` — закрытый effect-kind axis, verify at `invoke`-time (T-0024/T-0034) |
| Audit floor (open-vocab `audit_event`) | **ЖИВОЙ (контракт + FF)** | T-0016 ADR §3.1; одно семейство `audit_event`/`audit_head`; append-only `ci/checks/audit_append_only.sh`, `audit_writer_isolation.sh` |
| Named-binding согласованность | **ЖИВОЙ** | `src/core/binding-compat.ts:86` — `checkBindingCompat(...)`; `:149` `validateBindingFields` |
| Tenant-isolation (RLS) | **ЖИВОЙ (контракт)** | T-0013 GT-1; `withTenant` + `choros.tenant_id` GUC; `ci/checks/cross-tenant-fitness.sh` |
| **engine-bridge terminate / message correlation (T-0058)** | **⚠ НЕ DONE — ЧЕСТНО** | T-0058 ADR покрывает ТОЛЬКО `deployBpmn/startInstance/fetchAndLock/completeTask/failTask` (`src/core/flowable-client.ts:508-513`). REST-путей `deleteProcessInstance` (terminate) и `correlateMessage` (message) **НЕТ ни в коде, ни в ADR T-0058**. Единственные REST-обращения — `POST /runtime/process-instances` (start) и complete. → семантики terminate/message проектируются как **dormant-декларация с гейтом готовности**, см. §5. |
| **form-schema Floor-1 / модуль (T-0073 / T-0079)** | **⚠ НЕ DONE — ЧЕСТНО** | НЕТ живого src/-кода `formSchema`/`FormSchema`; T-0082-deferral-contract помечает `form-json-schema` и `form-code` как `kind=external` (нет `form_def` таблицы). → носитель кастомизации проектируется как **dormant-зона за тем же гейтом готовности form_def**, см. §4.2/§5. |
| **bundle единица версионирования (T-0082)** | **ЖИВОЙ как guard, но члены deferred** | `ci/checks/bundle-coherence.sh` + `bundle_members.txt` ЖИВЫЕ; но `form-json-schema`/`form-code` = `kind=external` (deferred). T-0082-bundle-deferral-contract §«Promotion rule»: член промотируется при создании таблицы. Card-action-конфиг наследует этот контракт — не вводит второй механизм версионирования. |
| **`process_instance` как адресуемый ResourceType / object_kind** | **⚠ НЕ DONE — ЧЕСТНО [iter-2, R-1]** | Закрытый `ResourceType` (`grant-lattice.ts:33-38`) = `application\|registry\|record\|mgmt_object:${string}\|effect_resource` — **`process_instance` ОТСУТСТВУЕТ**; `object_kind` CHECK (`T-0019 ADR:147,197`) = `IN ('application','registry','record')` — инстанс **НЕ адресуем** как ResourceRef day-1. Поэтому адресация инстанса процесса в решётке = **dormant аддитивное расширение** (новый ResourceType-член + миграция object_kind CHECK), а НЕ живое переиспользование. Разморозка идёт ВМЕСТЕ с terminate/message-путём (B-8), см. §2.2.1 и §7. |

> Несущая честность ADR: card action как **примитив** (контракт + отображение на op + PDP + аудит + генерация дефолта из ЖИВЫХ опор) проектируется полностью day-1. Семантики и хранилища, чьи нижележащие пути ещё НЕ построены (terminate/message REST; form_def-таблица), объявляются **dormant** с машинно-проверяемым гейтом готовности — примитив НЕ блокируется отсутствием этих путей, но и НЕ делает вид, что они есть.

---

## 1. Decision

Card action — **декларативная типизированная кнопка** на карточке записи: именованная декларация `{ id, label, operation∈closed-enum, target, params-schema, bindings }`, которая на каждом рендере и на каждом срабатывании проходит через **тот же PDP-резолв** (`resolveFor`, `grant-resolver.ts:489`), что и любая мутация, и исполняется **исключительно по уже спроектированным путям**: `transition` → mutation-gateway (T-0028, через `resolveFor` op=`transition` + guarded-transition writer `appendActorEvent` T-0019); `invoke` → invoke-effect (T-0024/T-0034); `terminate`/`message` → engine-bridge REST (T-0058) — **за гейтом готовности**, пока REST-пути не построены. Каждое срабатывание (executed И denied) пишет одну строку `audit_event` (T-0016 open-vocab, не новая таблица); guarded transition дополнительно пишет `actor_event` (T-0019, две таблицы как в T-0019 §2).

**Ключевые инварианты-границы (каждый = fitness-функция):**

1. **Операция — только из закрытого Operation enum** (`grant-lattice.ts:25-32`). Card action НЕ вводит новый тип права и НЕ расширяет enum (NF-1, AC-2). Декларация ссылается на op через тот же тип `Operation`, что и весь PDP.
2. **Видимость = исполнимость = PDP.** И рендер кнопки, и её клик решает `resolveFor`, а не UI-флаг. Нет гранта → `{ denied }` → кнопка невидима/отклонена fail-closed (NF-2, AC-1). Никакого второго пути авторизации.
3. **Один механизм исполнения над движком.** terminate/message — только через engine-bridge REST (T-0058); Java движка не пишем (external-task контракт). Пока REST-путей нет — dormant (NF-3, AC-3, §5). **[iter-2, R-1]** terminate/message адресуют инстанс через **новый ResourceType `process_instance`** (§2.2.1), структурно дизъюнктный с record-transition: обычный transition-грант на статус карточки НЕ даёт права убийства инстанса (FF-CA-10). ResourceType-член day-1 dormant, размораживается вместе с REST-путём в B-8.
4. **Один механизм согласованности ссылок.** Связь action↔поля/переменные = `checkBindingCompat` (T-0072, `binding-compat.ts:86`), не четвёртый механизм (NF-4, AC-6).
5. **Один механизм версионирования.** Кастом-действия версионируются внутри bundle (T-0082), наследуя deferral-контракт form_def — не отдельный механизм (AC-6).
6. **Tenant fail-closed.** `resolveFor` tenant-gate (`grant-resolver.ts:497`) применяется ДО любого чтения — cross-tenant адресация инстанса/записи невозможна (NF-5, AC-14).

**Декомпозиция на два слоя (соразмерность, рубрика ось 5):**

- **Декларативный слой (примитив, полностью day-1):** объектная модель card_action + генератор дефолта + слой кастома + контракт исполнения (op→путь) + аудит-контракт. Не зависит от REST terminate/message и form_def — оперирует тем, что ЖИВО.
- **Исполнительные пути (переиспользуются как есть):** transition/invoke → ЖИВЫЕ day-1; terminate/message → dormant за гейтом; кастом-хранилище → dormant за гейтом form_def.

---

## 2. Object model

Сущности — **дизайн-контракт полей** (coder/tester читают как источник правды). Конкретное хранение (TS-тип, колонка form_def, поле bundle-конфига) — зона coder; здесь фиксируются имена/типы/семантика.

### 2.1 `CardActionDecl` — декларация действия

| Поле | Тип | Семантика |
|---|---|---|
| `id` | `string` (стабильный slug, tenant-уникальный в пределах формы) | Идентификатор действия; ключ для аудита и для override кастомом. |
| `label` | `string` | Человекочитаемая подпись кнопки (i18n-ключ допустим). |
| `operation` | `Operation` (= `grant-lattice.ts` enum, закрытый) | На какую существующую op резолвится грант. Day-1: `transition`/`invoke` (+ `approve` как частный guarded), `terminate`/`message` (см. `engineVerb`). НЕ расширяется. |
| `semantics` | `"transition" \| "terminate" \| "message" \| "invoke"` (закрытый) | Целевая семантика действия (ось B спеки). Отображается на `operation` + путь исполнения. `transition`→op `transition`; `terminate`/`message`→op `transition` над инстансом (guarded, см. §2.4) ИЛИ `invoke` — фиксируется маппинг-таблицей §2.3; `invoke`→op `invoke`. |
| `target` | `CardActionTarget` (см. §2.2) | На что направлено: запись (`record`) или привязанный инстанс процесса (`process_instance`). |
| `paramsSchema` | `ParamSchemaRef \| null` | Ссылка на схему параметров действия (напр. «причина» для «Прервать»). Параметры пишутся в audit subject + actor_event payload, не новый механизм. |
| `bindings` | `BindingField[]` (= `binding-compat.ts` `BindingField`) | Ссылки действия на поля/переменные схемы; согласуются `checkBindingCompat` (T-0072). |
| `visibilityHint` | `null` (зарезервировано) | НЕ источник истины видимости. Видимость ВСЕГДА = `resolveFor`. Поле существует только чтобы структурно запретить UI-флаг как авторизатор (его отсутствие проверяется FF-CA-2). |
| `origin` | `"default" \| "custom"` | Сгенерировано из модели+статуса (`default`) или авторено кастомом (`custom`). Влияет на хранение/версионирование, НЕ на авторизацию. |
| `readiness` | `"live" \| "dormant"` | `live` для transition/invoke; `dormant` для семантик, чей нижележащий путь не построен (terminate/message пока нет REST; кастом пока нет form_def). Гейт §5. |

### 2.2 `CardActionTarget`

| Поле | Тип | Семантика |
|---|---|---|
| `kind` | `"record" \| "process_instance"` | Адресуемый объект. `record` — ЖИВОЙ ResourceRef day-1; `process_instance` — **dormant** ResourceType (см. §2.2.1, [iter-2, R-1]). |
| `resourceRef` | `ResourceRef` | Для `record` — **ЖИВОЙ** ResourceRef записи (`grant-lattice.ts` ResourceType `record`). Для `process_instance` — ResourceRef над **dormant** ResourceType `process_instance`, которого в закрытой решётке day-1 НЕТ (§2.2.1); PDP резолвит грант над ним ТОЛЬКО после разморозки лат­тицы (B-8). |
| `processInstanceId` | `string \| null` | Для `kind=process_instance` — id инстанса в движке; используется engine-bridge при готовности. |

#### 2.2.1 Адресация инстанса процесса в решётке — РАЗВИЛКА РАЗРЕШЕНА [iter-2, R-1]

**Проблема (review R-1, blocking).** Прежняя редакция объявляла `target.kind="process_instance"`
с `resourceRef = существующий тип PDP`. Это **неверно по живому коду**: закрытый
`ResourceType` (`grant-lattice.ts:33-38`) не содержит `process_instance`, а `object_kind`
CHECK (`T-0019 ADR:147,197`) = `IN ('application','registry','record')`. Инстанс **НЕ
адресуем** как ResourceRef. Следствие: если бы `terminate` резолвился над **record**-ref
с op=`transition`, то держатель обычного гранта «сменить статус карточки»
(`op=transition, resourceType=record, scope`) удовлетворял бы **тот же** PDP-чек, что и
«убить привязанный инстанс» — «право transition статуса» структурно == «право убийства
инстанса». Это эскалация привилегии по умолчанию.

**Сверка с живым PDP (как грант параметризуется).** `Grant` (`grant-lattice.ts:62-76`)
ключится на **`resourceType` (закрытый ResourceType) ∧ `operation` (закрытый Operation)
∧ `scope` (containment)** + опц. `resourceFacet` (несёт ТОЛЬКО имена полей для masking —
`grant-resolver.ts:305,321`). Covering-фильтр (`grant-resolver.ts:508-516`) различает грант
ровно по `g.operation === op` **и** scope-containment записи. **Целевой статус в covering-
предикат НЕ входит**: `GuardContext.verb` (`grant-resolver.ts:411-417`) — это `ActorEventVerb`
∈ `{request,prepare,submit,approve,release}` (`actor-event.ts:36-44`, закрытый GT-1-set, БЕЗ
«terminate»), он **записывается на акт**, но в covering-чек гранта НЕ участвует.

**Выбранная ветвь — (а): новый `ResourceType` `process_instance` как минимальное аддитивное
расширение решётки.**

| Свойство | (а) новый ResourceType `process_instance` | (б) различитель над op=transition (грант на target-статус «terminated») |
|---|---|---|
| Выразимо ЖИВЫМ covering-алгоритмом? | **ДА** — грант уже ключится на `resourceType`; добавление члена в union + миграция object_kind CHECK не меняют covering-алгоритм (`g.operation===op ∧ containment`). | **НЕТ** — covering-фильтр НЕ параметризуется статусом; грант на «конкретный target-статус» НЕвыразим без **нового grant-предиката** (изменение covering-алгоритма). |
| NF-1 («не новый тип права/механизм») | **НЕ нарушает** — это новый *ResourceType* под ТЕМ ЖЕ закрытым Operation enum и ТЕМ ЖЕ covering-алгоритмом; не новый тип ПРАВА и не вторая authority-подсистема (см. ниже точную формулировку NF). | **Нарушает** — статус-дискриминированный covering-предикат = новый *механизм* авторизации (NF-1 запрещает). |
| Не-эскалация (обычный transition-грант ≠ убийство) | **ДА, структурно** — `(op=transition, resourceType=process_instance)` ДИЗЪЮНКТЕН с `(op=transition, resourceType=record)`: covering требует containment, а record-handle никогда не содержит instance-ref. Обычный статус-грант над record **не покрывает** terminate инстанса. Машинно-проверяемо (FF-CA-10). | Зависит от корректности нового предиката; по умолчанию (без него) — эскалация. |
| Объём аддитивного расширения | 1 член ResourceType + 1 миграция object_kind CHECK (+ VOCAB bump) | изменение covering-алгоритма resolveFor + новая колонка/предикат гранта |

**Почему (а) НЕ нарушает NF-1 — сверка с точной формулировкой спеки.** Spec §1 (стр. 70)
запрещает «**новый тип права/новая authority-подсистема** (один механизм прав)»; §4 (стр. 171)
— «**Новый тип права / расширение Operation enum** — запрещено». Формулировка NF закрывает
**Operation enum** (типы ПРАВ) и **authority-подсистемы (механизмы)**, а НЕ набор
**ResourceType**. `process_instance` — новый *ресурс-тип под тем же закрытым Operation enum*
и тем же covering-алгоритмом: card action по-прежнему резолвится на существующую op
`transition` (NF-1/AC-2 соблюдены), просто над ресурсом нового типа. Расширение **решётки**
(ResourceType union + object_kind CHECK) — легальная **новая работа с миграцией и FF**
(аналог любого нового registry-типа), не запрещённое спекой расширение типов прав/механизмов.
**Ветвь (б) отвергнута**: статус-дискриминированный грант НЕвыразим живой решёткой без
изменения covering-алгоритма resolveFor — то есть требовал бы именно нового авторизационного
механизма, что NF-1 прямо запрещает.

**Статус разморозки.** `process_instance` ResourceType помечен **dormant** наравне с REST
terminate/message (T-0058): пока ResourceType-член и object_kind CHECK не добавлены миграцией,
любая `process_instance`-адресация попадает в тот же гейт §5 (`isReady=false`,
`audit_event(denied, reason="path_not_ready")`). Разморозка латтицы идёт **вместе с B-8**
(см. §7): один аддитивный шаг строит и REST-путь, и адресуемость инстанса. Декларация
примитива при этом НЕ меняется (FF-CA-5).

### 2.3 Маппинг семантика → (op, путь исполнения) — закрытая таблица

| `semantics` | `operation` (PDP) | Путь исполнения | Статус пути |
|---|---|---|---|
| `transition` | `transition` (или `approve` для guarded-approve) | mutation-gateway → `resolveFor` op=transition → guarded-transition writer `appendActorEvent` (T-0019/T-0028) | **ЖИВОЙ** |
| `invoke` | `invoke` | invoke-effect verify (T-0024/T-0034, `effect-resource.ts`) | **ЖИВОЙ** |
| `terminate` | `transition` над `resourceType=process_instance` (см. §2.2.1) | engine-bridge REST `deleteProcessInstance` (T-0058) | **DORMANT** — REST-путь И ResourceType-член не построены (B-8) |
| `message` | `transition` над `resourceType=process_instance` (см. §2.2.1) | engine-bridge REST message-correlation (T-0058) | **DORMANT** — REST-путь И ResourceType-член не построены (B-8) |

> `terminate`/`message` НЕ получают новый тип права — они резолвятся на существующую op
> `transition` (NF-1/AC-2: «Прервать» = `transition`, gap-map §4б, не новая операция).
> **[iter-2, R-1] Ключевое различение прав:** terminate/message адресуют **новый ResourceType
> `process_instance`** (§2.2.1, dormant-аддитив), а НЕ record-ref. Поэтому грант
> `(op=transition, resourceType=process_instance)` **структурно дизъюнктен** с грантом
> `(op=transition, resourceType=record)`: обычный transition-грант на смену статуса карточки
> **НЕ покрывает** terminate привязанного инстанса (covering-фильтр требует resourceType-match,
> `grant-resolver.ts:508-516`; record-handle не содержит instance-ref). «Право сменить статус»
> ≠ «право убить инстанс» — теперь это разделено живым примитивом решётки, не имитацией
> (FF-CA-10). Ветвь «terminate над record-ref op=transition» **отвергнута** как
> grant-эскалация (детали и rejected_alternatives — §2.2.1).

### 2.4 `CardActionAuditRecord` — контракт аудита (не новая таблица)

Каждое срабатывание → одна строка `audit_event` (T-0016, open-vocab `type`, напр. `card_action.executed` / `card_action.denied`):

| Поле audit_event | Источник |
|---|---|
| `type` | `card_action.executed` \| `card_action.denied` (open-vocab — не схема-расширение) |
| `actor` | субъект (`resolveFor` subject) |
| `subject` | `{ recordOrInstanceRef, actionId, params }` — запись/инстанс + имя действия + параметры |
| `via` | грант, по которому разрешено (или попытка op при denied) |
| `result` | `executed` \| `denied` + `reason` (для denied — причина из `resolveFor`: `cross_tenant`/`sod_violation`/нет гранта) |
| `processInstanceId` | привязка к инстансу при наличии |
| `tenant_id` | из `withTenant` GUC (T-0013) — tenant-scoped |

Дополнительно (только семантика `transition`): guarded-transition writer пишет `actor_event` (T-0019) — две таблицы как в T-0019 §2.

---

## 3. Generation of the default card (FR-4, AC-4, AC-13)

Дефолтный набор `CardActionDecl[]` для карточки **генерится** функцией-проекцией из двух ЖИВЫХ источников, без ручного авторинга:

```
defaultCardActions(handle, subject, deps) → CardActionDecl[]
  // (а) объектная модель записи: T-0014 registry_def/record_schema
  //     → какие операции над типом записи вообще определены
  // (б) статусная модель: T-0019 — какие guarded transitions доступны
  //     из ТЕКУЩЕГО статуса карточки/инстанса
  // (в) для каждого кандидата: origin="default", semantics из (а)/(б),
  //     readiness по §2.3
```

**Содержимое дефолта day-1 (зафиксировано):**
- по одному `transition`-действию на каждый **доступный из текущего статуса** guarded transition (источник — статусная модель T-0019); `readiness=live`;
- одно `terminate`-действие на **привязанный инстанс процесса** при его наличии; `readiness=dormant` (пока нет REST T-0058), но декларация присутствует — карточка её показывает как disabled-with-reason или скрывает по гейту §5;
- `invoke`-действия в дефолт НЕ входят (это эффект конкретной конфигурации, не базовый жизненный цикл) — только через кастом.

**Видимость дефолтного действия = PDP:** даже сгенерированное действие отрисовывается, только если `resolveFor(subject, op)` ≠ denied. Дефолт = «что определено», PDP = «что доступно этому субъекту». Базовая карточка ТЭЛ работает «из коробки» без авторинга (AC-13).

---

## 4. Customisation on top (FR-5, FR-6, AC-5, AC-6)

### 4.1 Семантика наложения

Кастом-действия лежат **поверх** дефолта в декларативной форме-схеме (Floor-1 T-0073 / модуль T-0079). Слияние: `merge(defaults, customs)` по `id` — кастом **добавляет** новое действие или **переопределяет** существующее (label/params/bindings/target).

**Структурные запреты (не пожелания — fitness):**
- кастом НЕ может задать `operation`/`semantics` вне закрытых enum (валидируется при загрузке схемы) → невозможно расширить Operation enum (AC-5);
- кастом НЕ имеет поля-авторизатора: `resolveFor` остаётся единственным арбитром, кастом не может пометить действие «всегда доступно» → повышение привилегии через кастом структурно невозможно (AC-5, NF-1).

### 4.2 Хранение и версионирование (наследует deferral-контракт)

Кастомизация хранится как **конфиг внутри носителя формы-схемы** и версионируется как член **bundle** (T-0082, E12.1), НЕ отдельным механизмом (AC-6).

> ⚠ **Честный гейт:** живой таблицы `form_def`/`form-json-schema` ещё нет — T-0082-bundle-deferral-contract помечает оба как `kind=external` (deferred). Поэтому card-action-кастом-конфиг **наследует тот же deferral-контракт**: пока form_def-таблица не создана, кастом-слой `dormant`. Когда coder создаёт `form_def`, он по promotion-rule T-0082 промотирует член bundle И добавляет card-action-конфиг в тот же член — **не вводя второй механизм версионирования** (FF-CA-6).

### 4.3 Согласованность ссылок

`bindings` действия проверяются **тем же** `checkBindingCompat` (T-0072, `binding-compat.ts:86`), что named-binding и report-page-dep (T-0121) — не четвёртый механизм (AC-6, NF-4).

---

## 5. Execution pipeline + dormant-гейт готовности

```
[клик кнопки]
   → собрать (actionDecl, target, params)
   → resolveFor(deps, handle, subject, op=map(semantics), guardCtx?)   // PDP, единственный арбитр
        ├─ denied  → audit_event(card_action.denied, reason) ; СТОП (fail-closed, мутации нет)
        └─ allowed →
              switch semantics:
                transition → mutation-gateway (T-0028) → appendActorEvent (T-0019)
                               → audit_event(card_action.executed)
                invoke     → invoke-effect verify+call (T-0024/T-0034)
                               → audit_event(card_action.executed)
                terminate  → [ГЕЙТ §5] engine-bridge deleteProcessInstance (T-0058)
                message    → [ГЕЙТ §5] engine-bridge message-correlation (T-0058)
```

**Видимость на рендере карточки = batch-PDP.** Карточка вызывает `resolveFor` для каждого кандидат-действия. Чтобы не делать N синхронных round-trip, ADR фиксирует **batch-резолв**: одна проекция набора `(op, target)` через `resolveFor` за рендер карточки (PDP уже принимает handle+subject; batch = цикл по op над тем же subject/handle, без второго edge авторизации — то же тело `resolveFor`). Результат — список **исполнимых** действий; неисполнимые не рендерятся (fail-closed, AC-1).

> **[iter-2, R-2] Амортизация record-fetch в batch-PDP.** `resolveFor` (`grant-resolver.ts:489`)
> на шаге 5 (`grant-resolver.ts:611-615`) делает `getRecord(handle.ref)`. В batch над одной
> карточкой все кандидат-действия делят **один и тот же target** (record/instance), поэтому
> batch = **K grant-резолвов (шаги 1-4: tenant-gate ∧ covering ∧ scope) над одним уже-
> загруженным target**, а record-fetch выполняется **один раз на target**, НЕ per-op.
> Coder обязан амортизировать fetch на карточку (не растиражировать N+1 `resolveFor`-с-fetch
> на рендере списка карточек): grant-резолв per-op, record-fetch один на target. Это
> калибровка impl (B-2), не изменение авторизационного edge — тот же `resolveFor`,
> та же fail-closed семантика.

**Dormant-гейт готовности (несущая честность):** семантики `terminate`/`message` и кастом-слой объявлены, но их нижележащие пути не построены (нет REST T-0058; нет form_def). Гейт — **машинно-проверяемый readiness-предикат**:

```
isReady(semantics) :=
  transition | invoke           → true (ЖИВЫЕ пути)
  terminate  | message          → engineBridgeSupports(semantics)        // [iter-2,R-1] false, пока (а) flowable-client не экспортирует deleteProcessInstance/correlateMessage И (б) ResourceType `process_instance` не добавлен в решётку + object_kind CHECK (§2.2.1). ОБА условия снимаются вместе в B-8.
customReady() := formDefTableExists()                                    // false, пока нет form_def
```

`dormant`-действие: (а) присутствует в декларации (примитив не блокирован); (б) НЕ исполняется — попытка клика fail-closed с `audit_event(denied, reason="path_not_ready")`; (в) при рендере либо скрыто, либо disabled-with-reason (выбор UI, не авторизация). Когда coder строит REST-путь/таблицу — `isReady` становится true **без изменения декларации** (FF-CA-5: dormant-декларация не исполняется, пока путь не объявлен готовым).

> Это прямая реализация требования промпта: «для НЕ-готовых путей — dormant-декларация с гейтом готовности, не блокируй примитив».

---

## 6. Приёмочный прогон — кейс «Прервать согласование» (ТЭЛ §1, AC-8, AC-15)

Карточка договора, привязанный инстанс согласования активен. Кнопка «Прервать согласование»:

1. **Декларация** = `CardActionDecl { id:"abort_approval", semantics:"terminate", operation:"transition", target:{kind:"process_instance", resourceRef:<инстанс, resourceType=process_instance>}, paramsSchema:<reason>, readiness:"dormant" }` + сопутствующее `CardActionDecl { semantics:"transition", target:{kind:"record", resourceRef:<запись>}, цель="Отказано" }`.
2. **Право [iter-2, R-1]** = **два РАЗНЫХ гранта над РАЗНЫМИ ResourceType**: terminate инстанса требует `resolveFor(subject, op=transition, handle=<инстанс, resourceType=process_instance>)`; transition карточки в «Отказано» — `resolveFor(subject, op=transition, handle=<запись, resourceType=record>)`. Они **структурно дизъюнктны** (covering-фильтр `grant-resolver.ts:508-516` различает по resourceType-match): держатель гранта только на смену статуса карточки **НЕ может прервать инстанс** — для этого нужен отдельный грант на `process_instance`. Нет соответствующего гранта → действие невидимо/отклонено fail-closed (`grant-resolver.ts:489`, tenant-gate :497). Это существующий PDP над аддитивным ResourceType (§2.2.1), не новая модель прав.
3. **«Фиксирует причину»** = `params.reason` → пишется в `audit_event.subject.params` + (для transition-части) `actor_event` payload. Не новый механизм.
4. **Исполнение:** terminate инстанса = engine-bridge `deleteProcessInstance` (T-0058) — **за гейтом §5** (dormant: REST-путь `flowable-client.ts` экспортирует только start/complete/fail, И ResourceType `process_instance` ещё не в решётке — оба снимаются в B-8); + transition карточки в «Отказано» = mutation-gateway (T-0028) + actor_event (T-0019) над `resourceType=record` — **ЖИВОЙ путь day-1**.
5. **«Уведомления участникам»** = НЕ card action; card action эмитит переход/событие, доставку реализует T-0120 (граница, не дублируется).
6. **«Переназначить»** (ТЭЛ §1) размещён явно: `CardActionDecl { semantics:"message" (сигнал инстансу сменить assignee) или "transition" (смена поля исполнителя записи), operation:"transition" }`; право «кто может переназначить» дожимается в E7 (gap-map §2 🟡) — card action **потребляет** грант, не определяет ролевую модель.

**Сборка показана без второго механизма:** одно право (PDP T-0021), одна audit-таблица (T-0016), один канал к движку (engine-bridge T-0058), один механизм согласованности (T-0072). Терминальная часть — за честным гейтом готовности, не имитируется.

---

## 7. MVP day-1 / Stage-2 (FR-9, AC-9)

**Day-1 (примитив целиком, поверх ЖИВЫХ опор):**
- объектная модель `CardActionDecl`/`Target`/маппинг-таблица §2.3;
- отображение на закрытый Operation enum + видимость/исполнимость через `resolveFor` (batch на рендере);
- закрытый набор семантик: `transition`/`invoke` **исполнимы**; `terminate`/`message` **объявлены dormant** (гейт §5);
- генерация дефолта из объектной модели (T-0014) + статуса (T-0019);
- контракт кастом-поверх + версионирование как член bundle (T-0082) — слой dormant до form_def;
- аудит каждого срабатывания (executed/denied) — T-0016 + actor_event для transition;
- прогон «Прервать согласование» (transition-часть исполнима, terminate-часть за гейтом).

**Критерий разморозки terminate/message [iter-2, R-1] — ДВА аддитивных условия, снимаются вместе в B-8:**
1. **REST-путь:** `flowable-client.ts` экспортирует `deleteProcessInstance`/`correlateMessage` (REST `DELETE/POST /runtime/process-instances/{id}` и message-correlation) под mutation-guard контрактом T-0028 FF-G3;
2. **Адресуемость инстанса в решётке (§2.2.1):** ResourceType `process_instance` добавлен в `grant-lattice.ts` union + миграция `object_kind` CHECK (`IN ('application','registry','record','process_instance')`) + VOCAB bump, под FF-CA-10 (доказывает дизъюнктность с record-transition-грантом — обычный статус-грант НЕ терминирует инстанс).

Когда ОБА условия выполнены — `isReady(terminate|message)` → true, декларация card action НЕ меняется (FF-CA-5). (Отдельная build-задача — потребляет T-0058/T-0064 + аддитивную миграцию решётки.)

**Критерий разморозки кастом-слоя:** создана таблица `form_def`; член bundle промотирован `external→choros_table` (promotion-rule T-0082-deferral); card-action-конфиг добавлен в тот же член.

**Stage-2 (с критерием разморозки):**
- действия, зависящие от агент-рантайма (E5.6–E5.10) — разморозка при готовности agent-runtime;
- сложные UI-холсты действий — граница с T-0121 (two-floor report pages); card action ≠ конструктор UI.

---

## 8. Fitness functions (машинно-проверяемые границы)

| ID | Правило | CI-проверка |
|---|---|---|
| **FF-CA-1** | Видимость/исполнимость card action выводится из `resolveFor` (PDP). Ни один модуль card-action не отрисовывает/не исполняет действие на основании UI-флага вместо PDP-резолва. | `bash ci/checks/card-action-pdp-arbiter.sh` — grep: каждый исполнитель/рендерер card-action ссылается на `resolveFor`; запрет токенов `actionEnabled/canShow/allowedFlag` как авторизаторов вне PDP. (AC-1, NF-2) |
| **FF-CA-2** | `CardActionDecl.operation`/`.semantics` — только из закрытых enum; нет расширения Operation enum и нет нового типа права. | `bash ci/checks/card-action-closed-enum.sh` — статическая проверка: `operation` ⊆ `grant-lattice.ts` Operation; `semantics` ⊆ `{transition,terminate,message,invoke}`; запрет новых `*Operation*`/`*Right*` токенов в card-action-модуле. (AC-2, AC-5, NF-1) |
| **FF-CA-3** | terminate/message исполняются ТОЛЬКО через engine-bridge (T-0058); нет своего HTTP-клиента/Java к движку в card-action-модуле. | `bash ci/checks/card-action-engine-single-channel.sh` — grep: card-action-модуль не содержит `fetch`/`http`/`axios` к движку напрямую; engine-семантики идут через flowable-client/externalTaskBridge symbol. (AC-3, NF-3) |
| **FF-CA-4** | Связь action↔поля/переменные использует `checkBindingCompat` (T-0072); нет второго/четвёртого механизма согласованности. | `bash ci/checks/card-action-binding-single-mechanism.sh` — grep: bindings card-action валидируются `checkBindingCompat`; запрет дублирующих `*bindingCheck*`/`*depResolve*` функций в модуле. (AC-6, NF-4) |
| **FF-CA-5** | Dormant-действие не исполняется, пока его путь не объявлен готовым: попытка исполнения `dormant`-семантики без `isReady` → denied+audit, мутации/вызова движка нет. | `card-action-dormant-gate.test.ts` (unit) — кейс: `semantics=terminate`, `isReady=false` ⇒ результат `denied(reason=path_not_ready)`, нет вызова engine-bridge. (AC-3, §5) |
| **FF-CA-6** | Кастом card-action версионируется как член bundle (T-0082), не отдельным механизмом; до form_def — наследует deferral (`kind=external`), не вводит второй store/версионер. | `bash ci/checks/bundle-coherence.sh` (расширяется) + grep: нет `card_action_version`/отдельной version-таблицы; card-action-конфиг регистрируется в `bundle_members.txt`. (AC-6) |
| **FF-CA-7** | Каждое срабатывание (executed И denied) пишет `audit_event` (T-0016 open-vocab), не новую таблицу; transition дополнительно `actor_event`. | `card-action-audit.test.ts` (unit) — executed ⇒ 1 `audit_event` (+actor_event для transition); denied-by-PDP ⇒ 1 `audit_event(denied,reason)`; запрет новой audit-таблицы (`audit_writer_isolation.sh`). (AC-7, AC-14) |
| **FF-CA-8** | Tenant fail-closed: card action над инстансом/записью другого tenant ⇒ `resolveFor` cross_tenant deny до любой мутации/вызова. | `cross-tenant-fitness.sh` (расширяется кейсом card-action) + unit: `handle.tenantId != subject.tenantId` ⇒ denied, нет эффекта. (AC-14, NF-5) |
| **FF-CA-9** | Дефолтный набор генерится из T-0014 + T-0019 без ручного авторинга: `defaultCardActions` не читает кастом-схему для базового набора; базовая карточка отдаёт доступные transitions из текущего статуса. | `card-action-default-gen.test.ts` (unit) — карточка без кастом-схемы ⇒ дефолт = guarded transitions из статуса (+terminate при инстансе), все под PDP. (AC-4, AC-13) |
| **FF-CA-10** **[iter-2, R-1]** | **Различение прав terminate-инстанса vs transition-статуса:** грант `(op=transition, resourceType=record)` НЕ покрывает terminate привязанного инстанса; terminate требует отдельного гранта `(op=transition, resourceType=process_instance)`. Обычный transition-грант на смену статуса карточки структурно НЕ даёт права убийства инстанса. | `card-action-terminate-authority.test.ts` (unit, **за гейтом B-8 / activates при разморозке решётки**) — субъект с грантом только на `(transition, record, scope⊇карточка)`, БЕЗ гранта на `(transition, process_instance, …)`: `resolveFor` над instance-handle ⇒ `denied(no_grant)`, нет вызова engine-bridge; обратно — грант на инстанс НЕ покрывает запись. До разморозки решётки покрыто FF-CA-5 (dormant denied=path_not_ready). (AC-3, AC-8, AC-12, NF-1, security-линза) |

---

## 9. Декомпозиция impl (для materialize → coder)

| # | Под-задача | Зависит от | Статус пути |
|---|---|---|---|
| **B-1** | Объектная модель `CardActionDecl`/`Target`/маппинг §2.3 (TS-типы + валидатор закрытых enum) + FF-CA-2 | grant-lattice (ЖИВ) | day-1 |
| **B-2** | PDP-исполнитель card-action: `resolveFor`-обёртка op=map(semantics), batch-резолв на рендере, fail-closed + FF-CA-1, FF-CA-8 | grant-resolver:489 (ЖИВ), T-0013 | day-1 |
| **B-3** | Путь `transition`: wiring в mutation-gateway (T-0028) + actor_event (T-0019) + audit_event (T-0016) + FF-CA-7 | T-0028/T-0019/T-0016 (ЖИВ) | day-1 |
| **B-4** | Путь `invoke`: wiring в invoke-effect (T-0024/T-0034) + audit | effect-resource (ЖИВ) | day-1 |
| **B-5** | Генератор дефолта `defaultCardActions` из T-0014 + статуса T-0019 + FF-CA-9 | T-0014 (ADR), T-0019 (ЖИВ) | day-1 |
| **B-6** | Dormant-гейт `isReady`/`engineBridgeSupports`/`customReady` + FF-CA-5 | — | day-1 |
| **B-7** | Аудит-контракт card_action.* (open-vocab type) + FF-CA-7 | T-0016 (ЖИВ) | day-1 |
| **B-8** | **Разморозка terminate/message [iter-2, R-1]:** (1) `deleteProcessInstance`+`correlateMessage` в flowable-client (REST) под T-0028 FF-G3 + FF-CA-3; (2) аддитивная миграция решётки — ResourceType `process_instance` в `grant-lattice.ts` + object_kind CHECK + VOCAB bump + FF-CA-10 (дизъюнктность terminate-инстанса от record-transition) | **T-0058 (НЕ DONE)** + аддитив решётки (§2.2.1) | за гейтом §7 |
| **B-9** | **Разморозка кастом-слоя:** таблица `form_def`, promotion члена bundle (T-0082-deferral), card-action-конфиг в bundle + FF-CA-4, FF-CA-6 | **T-0073/T-0079/T-0082 form_def (НЕ DONE)** | за гейтом §7 |
| **B-10** | Прогон кейса «Прервать согласование» как интеграционный (transition-часть day-1; terminate-часть после B-8) | B-1..B-7 | day-1 (terminate после B-8) |

---

## 10. Runtime / deploy target

Card action — серверная логика Choros (TS, поверх существующего Postgres-substrate + Flowable). Никакого нового внешнего ресурса не требуется: PDP/audit/actor_event = существующий Postgres (T-0013); engine-операции = существующий Flowable-сервис (T-0058). **`runtime_target`: контейнер** (тот же стек choros, дополнительного провижна нет). Деплой — существующий dev-стек, GT-4 не требуется этой задачей.

---

## 11. Развилки фаундера (НЕ решаю — фиксирую)

Спека §6 объявляет BLOCKING-вопросов нет; направление фаундера зафиксировано (gap-map §3а). В рамках инвариантов проектных развилок, **требующих решения фаундера, не обнаружено** — все развилки разрешены в рамках зафиксированных инвариантов (см. §12 итогового отчёта). `escalation` пуст. Решения, которые остаются за будущими задачами (не за фаундером сейчас): право «кто может переназначить/прервать» (E7), готовность REST terminate/message (build-задача поверх T-0058), создание form_def (T-0073/T-0079 impl).
