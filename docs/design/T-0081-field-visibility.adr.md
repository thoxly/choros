# T-0081 / E11.10 — Per-role field visibility: ONE canonical home (record-RBAC) + a most-restrictive UI-policy layer over ONE form (server-side redaction via the single PDP)

> Версия документа: 1.0 · Дата: 2026-06-16 · Статус: решение (ADR) — SPEC+DESIGN, машинно-проверяемый
> Источник (binding): `docs/design/extensibility-and-authoring.md` §3 (три ортогональные оси + гарантия §3), §6 (кросс-приложенческие данные / per-role видимость поля), §9.1 (Floor-1 полнота).
> Прецеденты (NF-1 — это ОБОБЩЕНИЕ существующего, не второй механизм): T-0021 grant-resolver (единый PDP), T-0033 data-classification (value-aware masking), T-0073/T-0074 Floor-1 editor/classifier.

---

## 1. Контекст и контракт

§6 фиксирует дословно: **«Канонический дом per-role видимости поля — ОДИН: record-level RBAC на JSONB, а форма накладывает UI-policy слой поверх ОДНОЙ формы (most-restrictive-wins), не N форкнутых форм.»** И: **«ACL форсится на КАЖДОМ hop… при нехватке прав кросс-ссылка возвращает РЕДАКТИРОВАННУЮ проекцию (label/id only) — прямая реализация гарантии §3: агент-„закупщик“ видит заявку, но НЕ финансовые поля контрагента.»**

T-0081 — это **Floor-1 детерминированный read-time гард** (§9.1), не продуктовая развилка. Он НЕ изобретает привилегий: он **связывает** §6-требование с уже существующим единым PDP и доводит до точной семантики ОДНУ недостающую деталь — **most-restrictive-wins** для зрителя с несколькими ролями над ОДНОЙ формой.

### 1.1 Несущий инвариант (security red-line)

**Поле, на которое у зрителя нет права, НИКОГДА не возвращается значением.** Редакция — серверная, в единственной точке проекции единого PDP (`resolveFor` → `projectFields`). Клиентское «hide» НЕ является гарантией (значение не должно покидать authority-границу). Решение должно позволять adversarial-ревьюеру ДОКАЗАТЬ: (а) нет второго authority-пути, (б) нет утечки значения, (в) композиция нескольких ролей может только СУЖАТЬ, никогда не РАСШИРЯТЬ видимость.

### 1.2 Что этот ADR НЕ делает (отложенные швы)

- **НЕ открывает второй store/authority.** Нет `field_visibility` / `record_rights` / `*_acl` таблицы или класса (запрещено `grant-resolver-isolation.sh` / `data-classification-isolation.sh`).
- **НЕ форкает формы по ролям.** ОДНА форма (`form-schema.ts` / `form_binding`), серверная проекция-слой.
- **НЕ реализует кросс-объектный traversal / dot-walking.** Это E11.9 / T-0080 (см. §6.2 ниже — шов). T-0081 = видимость полей на ОДНОЙ записи; редакция-проекция для кросс-ссылочного hop переиспользует ТУ ЖЕ pure-функцию, но сам traversal (lookup/rollup, hop-cap) строит T-0080.
- **НЕ трогает frozen-модули** `object-handle.ts` / `grant-lattice.ts` / `types.ts` (аддитивно).
- **НЕ добавляет миграцию** (см. §11).

---

## 2. Главное открытие: per-role видимость ПОЧТИ ВСЯ уже существует в едином PDP

Адекватный архитектурный вывод после чтения substrate: §6 «канонический дом = record-RBAC на JSONB» уже реализован — ДВУМЯ ортогональными осями, ОБЕ резолвятся одним PDP `resolveFor` и складываются в ОДНУ точку проекции `projectFields` (T-0021 §4.4, T-0033):

| Ось | Где живёт | Что решает | Функция |
|---|---|---|---|
| **A. Field-narrowing facet** | `Grant.resourceFacet = {fields:[...]}` (T-0018 opaque narrowing token) | КАКИЕ ключи записи роль вообще видит (whole-resource vs named-subset) | `visibleFields(covering, handleFacet, raw)` |
| **B. Sensitivity × clearance** | `data_classification(tenant, resource_type, facet_field, facet_schema_version → class)` + clearance, выведенный из covering-грантов | КАК показывается видимый ключ (reveal / partial / redact / hash / drop) по `(class × clearance)` | `maskFields(raw, visibleSet, maskCtx)` |

**Это и есть «record-level RBAC на JSONB» из §6.** `data_classification` keyed на `facet_field` (имя JSONB-ключа в `registry_def.record_schema`) — это и есть схемный канонический дом per-field политики чувствительности. Никакого нового store не требуется. Гарантия §3 («закупщик видит заявку, но НЕ финансовые поля контрагента») реализуется так: финансовые поля классифицированы `confidential/restricted`; clearance закупщика их `drop`-ает (ключ ОТСУТСТВУЕТ — capability-not-text).

### 2.1 Что РЕАЛЬНО недостаёт (узкий day-1 инкремент T-0081)

§6 говорит **most-restrictive-wins** для зрителя с несколькими ролями над ОДНОЙ формой. Существующая семантика этого НЕ даёт по ДВУМ пунктам:

1. **`visibleFields()` ОБЪЕДИНЯЕТ field-set по covering-грантам** (`fromGrants.add` в цикле) — это most-PERMISSIVE по набору полей. Корректно для «какие поля роль ВПРАВЕ видеть в принципе», но §6 требует: если над ОДНОЙ формой одна роль зрителя поле СКРЫВАЕТ, а другая показывает — поле СКРЫТО (most-restrictive).
2. **`deriveClearance()` берёт МАКСИМУМ clearance** по covering-грантам (most-permissive). Это корректная RBAC-семантика для clearance зрителя (его роли в сумме дают суммарный допуск) и T-0081 её НЕ меняет. «Most-restrictive-wins» §6 — это про **per-role hide-policy слой формы**, а НЕ про clearance-лестницу (см. §5 — точная семантика и почему так безопасно).

T-0081 закрывает (1): добавляет **pure-функцию композиции per-role hide-policy как ПЕРЕСЕЧЕНИЕ (subtract-only)**, применяемую в ТОЙ ЖЕ единственной точке проекции, выводимую из ТЕХ ЖЕ covering-грантов. Это сужающий слой: он может только УБРАТЬ поле, никогда не добавить ⇒ не может расширить ни facet-narrowing (A), ни classification-floor (B).

---

## 3. Архитектура: чистое ядро + единственная точка проекции (зеркало codebase-конвенции)

```
                       ┌──────────────────────────────────────────────────┐
                       │  resolveFor(deps, handle, subject, op)  (T-0021)   │  ← ЕДИНСТВЕННЫЙ PDP
                       │  1 tenant-gate → 2 grants@now → 3 covering         │
                       │  → 5 record fetch → 6 PROJECT ONCE:                │
                       │       vis  = visibleFields(covering,…)      (A)    │
                       │       hide = roleHideSet(covering, fieldPolicy)    │  ← T-0081 (НОВОЕ, pure)
                       │       eff  = vis \ hide      (most-restrictive)     │  ← T-0081 пересечение
                       │       fields = projectFields(raw, eff, maskCtx)(B) │
                       └──────────────────────────────────────────────────┘
                                  │ ResolvedView { denied:false, ref, fields }
                                  ▼
   GET /records/:id (single-form read)  ──► serverProjectForm(formDef, resolvedView)  (T-0081 edge, server-side)
                                              UI-policy слой поверх ОДНОЙ формы; редакция УЖЕ произошла в PDP
```

- **Pure-ядро** (`src/core/field-visibility.ts`, НОВЫЙ): `roleFieldVisibility(...)` — чистая функция от (covering grants, field-policy, raw keys) → most-restrictive visible set. Без IO/DB/env. Зеркало purity-дисциплины `data-classification.ts` / `floor1-editor.ts`.
- **Аддитивная правка `grant-resolver.ts`**: ВНУТРИ существующего `resolveFor`, между шагом 6-`visibleFields` и `projectFields`, вставляется ОДИН вызов `roleFieldVisibility` — НЕ второй handle→fields edge, НЕ второй PDP. По умолчанию (политика отсутствует) — поведение byte-identical (NF-1).
- **Edge `serverProjectForm`** (HTTP-слой, НЕ в `src/core`): принимает `FormDef` (T-0102) + уже-редактированный `ResolvedView` от PDP и собирает ответ ОДНОЙ формы. Редакция уже случилась серверно в ядре — edge ничего не «прячет» клиентски, он лишь раскладывает уже-безопасную проекцию по полям формы.

---

## 4. Канонический дом per-field политики видимости (Decision 1)

**ОДИН дом, без дублирования в form-schema.** Per-field политика живёт на ДВУХ существующих схемных носителях, оба читаются единым PDP — НИ ОДИН не дублируется в `form-schema.ts`/`form_binding`:

1. **Чувствительность поля (sensitivity)** — `data_classification(tenant_id, resource_type, facet_field, facet_schema_version → class)` (migration 017, СУЩЕСТВУЕТ). Это канонический дом «насколько поле чувствительно» — keyed на имя JSONB-ключа record-схемы. T-0081 переиспользует его как есть.
2. **Per-role field-narrowing** — `Grant.resourceFacet = {fields:[...]}` (T-0018 opaque token, СУЩЕСТВУЕТ). Это канонический дом «какие поля даёт КОНКРЕТНЫЙ грант роли».

**Per-role HIDE-policy (most-restrictive слой, §6)** НЕ требует нового store: она ВЫВОДИМА из тех же covering-грантов как **дополнение field-narrowing к набору ключей записи**. Точная семантика (Decision 3, §5): для зрителя с несколькими ролями эффективный видимый набор = ПЕРЕСЕЧЕНИЕ per-role narrowing-наборов по ключам, помеченным как role-scoped в record-схеме, а НЕ их объединение.

> **Почему не новая таблица `field_role_visibility`.** Это был бы второй authority-store (запрещён `grant-resolver-isolation.sh` Check 2 / `data-classification-isolation.sh` DC8) и второй источник истины, расходящийся с грантами. Per-role видимость ДОЛЖНА выводиться из единого PDP-пути (бриф §«Derivation through the single PDP»). Грант роли уже несёт field-narrowing token — этого достаточно.

### 4.1 Data shape (pinned, аддитивно, без миграции)

- **Sensitivity**: уже `ClassificationRow { resourceType, facetField, facetSchemaVersion, class }` (T-0033).
- **Field-policy для most-restrictive композиции** — pure-вход функции, форму которого фиксируем здесь (НЕ новая таблица; собирается edge-слоем из record-схемы + classification-rows):

```ts
/** Какие ключи записи находятся под per-role видимостью (role-scoped),
 *  чтобы most-restrictive пересечение применялось ТОЛЬКО к ним, а не к
 *  whole-resource ключам (иначе union-семантика whole-resource сломалась бы). */
export interface FieldVisibilityPolicy {
  /** Имена JSONB-ключей record-схемы, видимость которых per-role-scoped.
   *  Производное от record_schema (поля с role-narrowing) + classification —
   *  НЕ новый authority-store, а проекция существующих схемных фактов. */
  readonly roleScopedFields: ReadonlySet<string>;
}
```

Когда `roleScopedFields` пуст (политика не задана) — most-restrictive слой no-op, поведение byte-identical к T-0021/T-0033 (NF-1 backward-compat).

---

## 5. Most-restrictive-wins — точная семантика (Decision 3, SECURITY-CRITICAL)

**Правило (pinned).** Для зрителя, чьи covering-гранты — `G = {g1..gk}`, и для ключа записи `f`:

- Если `f` **whole-resource** (есть covering-грант со strictly-absent facet) И `f` НЕ в `roleScopedFields` → `f` виден (это T-0021-floor, не трогаем).
- Если `f` ∈ `roleScopedFields` (поле под per-role видимостью): `f` виден зрителю **тогда и только тогда, когда КАЖДАЯ роль зрителя, релевантная этой записи, своим грантом конферит `f`** (через `resourceFacet.fields` ∋ `f` ИЛИ whole-resource). Иными словами — **ПЕРЕСЕЧЕНИЕ** per-role narrowing-наборов по role-scoped ключам, а не объединение.
- Эффективный видимый набор = `visibleFields(covering,…)` (ось A, union-floor) **МИНУС** `hideSet`, где `hideSet` = role-scoped ключи, которые конферит НЕ каждая релевантная роль.
- Дальше `projectFields(raw, eff, maskCtx)` применяет classification-маскинг (ось B) к уже-суженному `eff`.

**Почему most-restrictive именно для HIDE, а не для clearance (обоснование, §6 «security»).** §6-инвариант: «пермиссивная роль не должна РАСШИРЯТЬ ограничительную для поля, помеченного чувствительным». Если бы мы объединяли (union) — зритель с пермиссивной ролью увидел бы поле, скрытое его же ограничительной ролью на ЭТОЙ форме ⇒ нарушение §3-гарантии. Поэтому над ОДНОЙ формой композиция ролей **может только сужать**. Это монотонно-fail-closed (зеркало `selectTransform`-лестницы и `governed`-fail-closed T-0033): сомнение (роль не конферит поле явно) ⇒ скрыть.

**Что НЕ меняется (и почему это корректно, не противоречие).** `deriveClearance` берёт МАКСИМУМ clearance — это про «какой класс чувствительности зритель в принципе допущен видеть» (RBAC-допуск складывается). Это ось B, ортогональная hide-слою (ось A). Они не конфликтуют: hide-слой работает над НАБОРОМ ключей (most-restrictive пересечение), clearance — над УЖЕ-видимыми ключами (классовая лестница). Поле, убранное hide-слоем, до classification вообще не доходит (ключ отсутствует). Поле, оставленное hide-слоем, маскируется по `(class × max-clearance)`. **Single-form гарантия §6 держится: ни одна роль не может через clearance вернуть значение поля, скрытого hide-слоем другой ролью зрителя.**

> Adversarial-нота: hide-слой применяется ПЕРЕД `projectFields` к набору ключей; classification-маскинг — ВНУТРИ `projectFields`. Порядок (`vis \ hide`, потом mask) гарантирует: ключ, убранный hide-слоем, физически отсутствует в `eff` ⇒ `maskFields` его не итерирует ⇒ значение не может «вернуться» через `reveal`-транзит более пермиссивной роли.

### 5.1 Pure-функция (Decision 2 — деривация через единый PDP)

```ts
// src/core/field-visibility.ts  (НОВЫЙ pure-модуль)

/** Per-role most-restrictive видимый набор поверх T-0021 union-floor.
 *  Чистая; без IO/DB/env. Выводит ВСЁ из covering-грантов (тот же PDP-вход,
 *  что у visibleFields) + FieldVisibilityPolicy (проекция record-схемы).
 *  Никакого второго authority-пути: гранты — единственный источник.
 *
 *  @param coveringGrants  гранты, которые resolveFor уже отфильтровал как
 *                         covering (tenant ∧ op ∧ effective ∧ scope) — те же.
 *  @param unionVisible    результат visibleFields(covering, handleFacet, raw)
 *                         (ось A union-floor) — most-restrictive только сужает его.
 *  @param policy          какие ключи role-scoped (most-restrictive применяется
 *                         ТОЛЬКО к ним; пустой набор ⇒ no-op, byte-identical NF-1).
 *  @returns { effectiveVisible, redactedFields } — eff = unionVisible \ hideSet.
 */
export function roleFieldVisibility(
  coveringGrants: Grant[],
  unionVisible: ReadonlySet<string>,
  policy: FieldVisibilityPolicy,
): { effectiveVisible: Set<string>; redactedFields: string[] };
```

Сигнатура верхнеуровневой проекции (Decision 2, бриф-форма):

```ts
// конце-к-концу форма, реализованная внутри resolveFor (НЕ новый export edge):
//   projectRecordForViewer(record, schemaFieldPolicy, viewerGrants)
//     → { visibleFields, redactedFields }
// где redactedFields → REDACTED projection (label/id only) на edge-слое.
```

---

## 6. Редакция-проекция (Decision 4) + single-form слой (Decision 5) + кросс-ref шов (Decision 6)

### 6.1 Форма редакции — label/id only, НЕ present-but-null (Decision 4)

Поле, которое зритель не вправе видеть, представляется так, чтобы его **нельзя было спутать с present-but-null**:

- **В ядре (PDP):** скрытый ключ **ФИЗИЧЕСКИ ОТСУТСТВУЕТ** в `fields` (capability-not-text — `drop`-семантика T-0033; ключ омитится). Значение НЕ покидает authority-границу. Это первичная гарантия.
- **На edge-слое (single-form ответ):** для UI-связности форма помечает поле как редактированное явным сентинелом, НЕ значением:

```ts
// ответ ОДНОЙ формы: каждое поле либо present-with-value, либо redacted-marker.
type FieldProjection =
  | { key: string; visible: true;  value: unknown }
  | { key: string; visible: false; redacted: true; label: string /* schema label/id only */ };
```

`redacted: true` + `label` (из record-схемы, не из значения) — это §6 «label/id only, never the value». `present-but-null` исключён конструктивно: редактированное поле НИКОГДА не несёт `value`-ключ; видимое-но-пустое поле несёт `value: null`. Два состояния структурно различимы.

### 6.2 Single-form / server-side enforcement (Decision 5)

- ОДНА форма (`form-schema.ts` `FormDef` / `form_binding`), НЕ N форкнутых форм. UI-policy слой = **серверная проекция** `serverProjectForm(formDef, resolvedView)`: для каждого поля формы смотрит, присутствует ли ключ в `resolvedView.fields` (PDP уже отредактировал) → `visible` или `redacted`-marker.
- **Редакция — серверная, в authority-границе.** Клиентский hide НЕДОПУСТИМ как гарантия: значение скрытого поля НЕ кладётся в ответ (его нет в `ResolvedView.fields`). Это прямая реализация брифа: «the value never leaves the authority boundary».
- `FieldUiMeta.hidden` (T-0073 floor1-editor) — это КОСМЕТИЧЕСКИЙ authoring-toggle (скрыть поле из отображения формы равномерно), НЕ security-гард, и T-0081 его НЕ использует для enforcement. Граница пинится явно: per-role security-видимость идёт через PDP-редакцию; `FieldUiMeta.hidden` — это «убрать поле из формы для всех» на authoring-этаже.

### 6.3 Кросс-ref hop ACL — day-1 граница (Decision 6)

**Day-1 scope T-0081 = видимость полей на ОДНОЙ записи.** Кросс-объектный traversal (dot-walking, lookup/rollup, hop-cap §6) — отдельная задача **T-0080 / E11.9**.

Обоснование границы: §6 описывает ДВЕ вещи — (1) per-role видимость поля на записи [T-0081] и (2) ACL на КАЖДОМ traversal-hop при dot-walking [T-0080]. Реализация (2) требует механизма обхода ссылок (`reference хранит ID` → live lookup), hop-cap, eventually-consistent агрегатов — это самостоятельный объём, который раздул бы T-0081 и смешал бы read-time field-redaction с reference-resolution.

**Шов к T-0080 (pinned).** Когда T-0080 строит dot-walking, КАЖДЫЙ hop вызывает ТОТ ЖЕ `resolveFor` для связанной записи и переиспользует ТУ ЖЕ `roleFieldVisibility` + `serverProjectForm` для редакции. Кросс-ссылка на запись без прав возвращает `{ visible:false, redacted:true, label }` — идентичная §6.1 форма. T-0081 экспортирует `roleFieldVisibility` / `FieldProjection` как переиспользуемый pure-кирпич ровно для этого; T-0080 НЕ изобретает второй редактор. Таким образом гарантия §3 («закупщик НЕ видит финансовые поля контрагента») реализуется композицией: T-0081 редактирует поля заявки + (через T-0080) тот же слой редактирует кросс-ссылку на контрагента.

---

## 7. Машинно-проверяемые fitness-критерии (F-1 .. F-11)

Зеркало строгости T-0211 §9 / T-0213 §7. Тиры: **pure** (юнит, без DB), **db** (fresh-tenant, T-0205-дисциплина), **static** (grep-гард).

- **F-1 — видит при гранте (pure).** Зритель с грантом, конферящим `f` (whole-resource ИЛИ facet ∋ `f`), и достаточным clearance → `f` ∈ `effectiveVisible`, значение присутствует.
- **F-2 — РЕДАКЦИЯ без гранта (pure).** Зритель без права на `f` (role-scoped, не конферится) → `f` ∉ `effectiveVisible`, `f` ∈ `redactedFields`; в `projectFields`-выходе ключ `f` ФИЗИЧЕСКИ ОТСУТСТВУЕТ (не `null`). Проверяется `!(f in fields)`.
- **F-3 — редакция ≠ present-but-null (pure).** Edge `FieldProjection`: редактированное поле НЕ несёт `value`-ключ, видимое-пустое несёт `value:null`. Два состояния структурно различимы (тест на отсутствие `value` у `redacted`).
- **F-4 — most-restrictive-wins для multi-role (pure).** Зритель с двумя ролями: роль X конферит role-scoped `f`, роль Y — нет → `f` СКРЫТО (пересечение, не объединение). Зеркальный тест: обе конферят → видно.
- **F-5 — пермиссивная роль НЕ расширяет (pure, security).** Роль с whole-resource (union-floor дал бы `f`), но `f` role-scoped и вторая роль зрителя его не конферит → `f` всё равно СКРЫТО. Доказывает: hide-слой сужает union-floor.
- **F-6 — clearance ортогонален hide (pure).** Поле, убранное hide-слоем, отсутствует в `eff` ДО `maskFields` ⇒ classification `reveal` более пермиссивной роли НЕ возвращает значение (нет ключа для итерации).
- **F-7 — деривация через ЕДИНЫЙ grant-resolver (static).** `field-visibility.ts` выводит видимость ТОЛЬКО из covering-грантов; нет второго authority-store. Гард `ci/checks/field-visibility-isolation.sh` (зеркало `grant-resolver-isolation.sh` Check 2 / `data-classification-isolation.sh` DC8): запрет токенов `field_visibility`/`record_rights`/`_acl`/`recordAcl`/`fieldVisibility` как СТОРА (вне комментов) + запрет второго `resolveFor`-подобного edge.
- **F-8 — единственная точка проекции (static).** `roleFieldVisibility` вызывается ВНУТРИ единственного `resolveFor` между `visibleFields` и `projectFields`; нет второго handle→fields export. Гард: `single-resolver.sh` остаётся зелёным (object-handle.ts не правится); новый гард проверяет, что `field-visibility.ts` НЕ экспортирует функцию, читающую запись напрямую.
- **F-9 — чистое ядро (static).** `field-visibility.ts` не импортирует pg/fs/net/http/jobStore, не читает `process.env`. Зеркало `data-classification-isolation.sh` DC9.
- **F-10 — tenant-изоляция (db).** Если db-backed путь задействован (политика читается через инжектируемый порт, RLS DAO → T-0053): fresh-tenant тест (рандомные UUID, T-0205), редакция применяется per-tenant, нет cross-tenant утечки. Tenant-gate `resolveFor` (шаг 1) уже fail-closed ПЕРЕД любым чтением.
- **F-11 — аддитивно: нет нового гранта/тула/resource_type/миграции (static).** Нет новой migration; `grant-lattice.ts`/`object-handle.ts`/`types.ts` не правятся (frozen, `grant-resolver-isolation.sh` Check 3); нет нового MCP-тула; `known_tenant_tables.txt` не меняется.

**Итого: 11 критериев** (6 pure, 1 db, 4 static).

---

## 8. План сборки (для кодера)

| Артефакт | Что |
|---|---|
| `src/core/field-visibility.ts` (НОВЫЙ, pure) | `FieldVisibilityPolicy`, `FieldProjection`, `roleFieldVisibility(coveringGrants, unionVisible, policy) → {effectiveVisible, redactedFields}`. Без IO. Зеркало `data-classification.ts`. |
| `src/core/grant-resolver.ts` (аддитивная правка ВНУТРИ `resolveFor`) | После шага 6 `visibleFields`, до `projectFields`: опциональный `deps.fieldPolicy?` (инжектируемый порт, mirrors `classifications?`); когда present — `eff = roleFieldVisibility(covering, vis, policy)`, иначе `eff = vis` (NF-1 byte-identical). `projectFields(raw, eff, maskCtx)`. НЕ новый edge. |
| edge (HTTP-слой, НЕ `src/core`) | `serverProjectForm(formDef, resolvedView) → FieldProjection[]` для single-form ответа GET /records/:id. |
| тесты | `src/core/__tests__/field-visibility.test.ts` (F-1..F-6 pure), `field-visibility.redaction.test.ts` (F-3), при db-пути — `ci/checks/db/field-visibility.tenant.test.ts` (F-10, fresh-tenant). |
| static-гард | `ci/checks/field-visibility-isolation.sh` (F-7/F-8/F-9: forbidden imports + no parallel store + no second resolver edge). |
| fitness wiring | добавить новый гард в общий fitness-раннер рядом с `grant-resolver-isolation.sh` / `data-classification-isolation.sh`; pure-тесты — в существующий `vitest` core-тир; db-тест — в `fitness:db` тир (shared-DB → fresh random tenant UUID, T-0205). |

**Сигнатура pure-fn (pinned):** `roleFieldVisibility(coveringGrants: Grant[], unionVisible: ReadonlySet<string>, policy: FieldVisibilityPolicy) → { effectiveVisible: Set<string>; redactedFields: string[] }`.

---

## 9. Authority-аргумент (no second path, no value-leak — для adversarial-ревью)

1. **Единственный PDP.** Видимость выводится из тех же covering-грантов, что уже отфильтровал `resolveFor` (tenant ∧ op ∧ effective ∧ scope). `field-visibility.ts` НЕ резолвит гранты, НЕ читает запись, НЕ читает БД — он получает уже-проверенные `covering` и `unionVisible`. Доказуемо гардом F-7/F-8/F-9.
2. **Только сужает.** `eff = unionVisible \ hideSet` ⊆ `unionVisible`. Композиция нескольких ролей НЕ может расширить ни facet-narrowing, ни classification-floor (F-5). Монотонно fail-closed: сомнение → скрыть.
3. **Нет утечки значения.** Скрытый ключ омитится в `projectFields` (физическое отсутствие, не null) ДО любого clearance-маскинга (F-2/F-6). Значение не попадает в `ResolvedView.fields` ⇒ не попадает в HTTP-ответ. Edge отдаёт `redacted`-marker с label/id, не значением (F-3).
4. **Аддитивно / NF-1.** Без `deps.fieldPolicy` поведение byte-identical к T-0021/T-0033 (F-11). Frozen-модули не тронуты.

---

## 10. §11 founder-decision — НЕ затронут

T-0081 — Floor-1 детерминированный read-time гард (§9.1). Он НЕ открывает ни одну точку решения фаундера из §11 (Floor-2 SPOF-порог, review-trust, round-trip-decay, git-секвенирование, ELMA-trap). Семантика most-restrictive-wins взята ДОСЛОВНО из §6 (binding-спека), не интерпретирована — расширяющая композиция запрещена самим §6 («пермиссивная роль не расширяет ограничительную»). Red-line (server-side редакция, no value-leak) реализуется конструктивно. **Статус: done, не blocked.**

---

## 11. Решение по миграции: **НЕ требуется**

- Sensitivity-дом уже есть — `data_classification` (migration 017).
- Per-role field-narrowing уже есть — `Grant.resourceFacet` (T-0018).
- Most-restrictive композиция выводится из грантов — нет нового store, нет колонки, нет таблицы.
- `FieldVisibilityPolicy.roleScopedFields` — pure-вход, проекция существующей record-схемы; собирается edge-слоем, не хранится отдельно.

Если будущий профиль покажет, что role-scoped-разметку полей нужно хранить явно (а не выводить из record-схемы), следующий свободный слот — **066** (065 = install-runbook). День-1 этого НЕ требует: разметка выводима из `record_schema` + `data_classification`. `needs_migration: false`.

---

## 12. Сводка решений

1. **Канонический дом** = `data_classification` (sensitivity, m.017) + `Grant.resourceFacet` (per-role narrowing). ОДИН дом на record-RBAC, без дублирования в form-schema. Нового store нет.
2. **Деривация через единый PDP** = `roleFieldVisibility(covering, unionVisible, policy)` вызывается ВНУТРИ единственного `resolveFor`, между `visibleFields` и `projectFields`. Не новый authority-путь.
3. **most-restrictive-wins** = `eff = unionVisible \ hideSet`; role-scoped поле видно ⟺ его конферит КАЖДАЯ релевантная роль зрителя (пересечение, не объединение). Только сужает. Clearance (max) ортогонален и не трогается.
4. **Редакция** = ключ физически отсутствует в ядре (capability-not-text); edge отдаёт `{visible:false, redacted:true, label}` — label/id only, структурно отличимо от present-but-null.
5. **Server-side enforcement** = редакция в authority-границе PDP; клиентский hide НЕ гарантия; ОДНА форма + серверный UI-policy слой `serverProjectForm`.
6. **Day-1 граница** = видимость полей на ОДНОЙ записи; кросс-ref hop traversal = T-0080 (шов: переиспользует `roleFieldVisibility` + `FieldProjection`).
