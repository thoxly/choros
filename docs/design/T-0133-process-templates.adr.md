# ADR · T-0133 — Каталог шаблонных процессов (template-pack)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-12
**Spec:** `docs/specs/T-0133-process-templates.spec.md` (status: ready, 14 AC, no blocking)
**Raw model:** `playbooks/choros-implementation-loop.md` §5 п.5 («Каталог стартовых
шаблонов: договоры / заявки в IT / командировки, адаптируемые интервью») — рамка
**подтверждена фаундером 2026-06-11**, не переоткрывается.
**Опоры (read-only, не переизобретаются):** T-0140 seed-pack (`seed/pack.schema.json`,
`seed/importer.ts`, `seed/cli.ts`, `src/http/seed-write.ts` — пакет-как-данные через
публичные API), T-0082 bundle-coherence (`docs/design/T-0082-bundle-coherence.adr.md` —
реестр-как-данные + fail-closed гард + deferral-контракт), T-0129 implementation-loop
(FR-4 интервью против живой оргструктуры, FR-11 human-gate, FR-14 карточка внедрения),
T-0130 simulation-gate (прогон до promote), `extensibility-and-authoring.md` §7
(когерентная связка/атомарный коммит), §8 (логические тиры draft→published, «агент
предлагает — человек подтверждает»), §11 (managed-solution / vendor-documented cliff),
T-0031 (`appendAuditEvent` — единый аудит).

---

## 1. Контекст и центральное напряжение

Рамка требует, чтобы внедрение начиналось **из каталога стартовых шаблонов**, а не «с
нуля» (T-0129 FR-4: старт из каталога когнитивно проще). Спека (FR-1..FR-10, 14 AC)
жёстко фиксирует: каталог обязан быть **продуктовым сиблингом уже принятого
seed-pack-механизма** (T-0140), а шаблон — **тем же пятичленным бандлом**, что T-0082,
а не новой сущностью. Центральное напряжение: спроектировать формат пакета шаблона,
точки параметризации, инстанцирование, версионирование и vendor-update **без
переизобретения** seed-pack-хранилища, второй модели «что есть процесс», новой модели
сред и второго аудита.

Опорный факт репо (сверено): seed-pack = декларативный `pack.json` (манифест
`meta.{name, version, description}` + секции-данные tenant/departments/positions/
employees/roles/grants/…), применяемый `applyPack`/`resetPack` (`seed cli apply|reset`),
которые бьют **только в публичные write-эндпойнты** `POST /api/{tenants,departments,
positions,employees,roles,…}` (`src/http/seed-write.ts`) — **никакого прямого SQL**.
Идемпотентность и `reset` — встроены. Это и есть прецедент формата хранения и
инстанцирования (FR-2/AC-2). T-0082-бандл материализован периметром: реестр-как-данные
(`bundle_members.txt`) + fail-closed bash-гард + **deferral-контракт** для ещё-не-
материализованных членов (form-def/bpmn-def-таблиц нет). Шаблон каталога наследует **ту
же дисциплину**: то, что не материализовано day-1, фиксируется явным deferral-контрактом,
а не молчаливой дырой.

**Соразмерность (рубрика ось 5).** Day-1 — это НЕ git-под-капотом three-way-merge и НЕ
новые таблицы-хранилища шаблонов. Day-1 — это **формат пакета-как-данные (расширение
seed-pack), машинно-читаемый контракт точек параметризации, инстанциатор поверх
публичных authoring-API, манифест provenance и vendor-документированный cliff с
human-gate**. Полная git-машинерия vendor-update отложена в Stage-2 явным deferral-
контрактом (§11 секвенирует «инкрементально», паттерн T-0082).

---

## 2. Решение (механизм)

**Template-pack = расширение seed-pack-пакета новой декларативной секцией
`process_templates`, инстанцируемой тем же importer-over-public-API путём в draft-тир
клиента; шаблон = пятичленный bundle (T-0082) + машинно-читаемый манифест
параметризации; provenance и vendor-update — слой managed-solution поверх вендорской
базы под human-gate.** Конкретно, пять решений:

### 2.1 Формат: template-pack — это seed-pack с секцией шаблонов (FR-1/FR-2)

Каталог поставляется как **версионируемый pack-каталог той же формы, что seed-pack**:
директория `templates/<template-slug>/pack.json` (плюс файлы-члены бандла рядом). Манифест
переиспользует `meta.{name, version, description}` (вендор-версия шаблона = `meta.version`,
FR-7) и добавляет **одну новую декларативную секцию** `process_templates[]` — пятичленный
бандл шаблона + его манифест параметризации. **Никакой новой сущности-хранилища**: это
тот же `pack.schema.json`-семейство, расширенное аддитивно (как T-0082 расширил реестр,
а не переписал). Каталог процессов и `showcase`/`blank` — **один механизм шаблонов
тенанта** (стык E11/E12): `showcase` = демо-наполнение, каталог = поставляемые **процессы**.

### 2.2 Шаблон = bundle T-0082, не вторая модель процесса (FR-1/FR-9)

Член секции `process_templates[]` несёт пятичленную связку **BPMN ↔ форма-код ↔
form-JSON-Schema ↔ object-schema ↔ role/agent/MCP-grants** — дословно bundle T-0082.
Шаблон **обязан проходить bundle-coherence гард T-0082** при загрузке в каталог (как
бандл, рождённый интервью). Каталожный шаблон и draft-бандл интервью — **один тип
артефакта**, различны только полем `origin` (`vendor-template` vs `interview`).

### 2.3 Точки параметризации = машинно-читаемый контракт, проверяемый при загрузке (FR-4)

Каждый шаблон несёт `parameters[]` — **явный машинно-читаемый перечень** (не свободный
текст), минимум трёх классов-`kind`:
- `role-binding` — абстрактная роль шаблона (напр. «юротдел») → параметр, привязываемый
  интервью (T-0129 FR-4) к **узлу живой оргструктуры тенанта**. Несоответствие «нет узла»
  → явный вопрос человеку (T-0129 FR-4), не молчаливая подстановка;
- `threshold` — числовой параметр маршрутизации (напр. порог ≥5 млн ₽ → юротдел) —
  значение, не зашитая константа;
- `sla` — временно́й параметр (срок/дедлайн), где есть — значение, не константа.
`parameters[]` — **часть контракта шаблона**, валидируется при загрузке каталога (FR-9):
шаблон без перечня параметризации или со ссылкой на несуществующий узел BPMN/роль —
невалиден, **fail-closed** (не попадает в каталог).

### 2.4 Инстанцирование = draft-бандл в draft-тире через публичные API (FR-5/FR-6)

Инстанцирование (выбор шаблона → старт внедрения) = **`applyPack`-аналог**, который
через **те же публичные authoring-API** (T-0129/T-0077, путь importer-over-HTTP, не SQL)
создаёт **draft-бандл в draft-тире клиента** (extensibility §8 логические тиры), НЕ сразу
published-процесс. Дальше — **петля T-0129**: интервью заполняет `parameters[]` против
живой оргструктуры → симуляция T-0130 (обязательный шлюз) → **human-gated promote**
(FR-11). Шаблон **не может миновать прогон/гейт**. Адаптация — зона T-0129 (как
заполняется); T-0133 даёт лишь контракт (что параметризуемо) — граница явная, механика
интервью не дублируется.

### 2.5 Provenance + vendor-update = managed-solution-слой под human-gate (FR-7/FR-8)

Инстанцированный draft-бандл хранит **манифест происхождения** `provenance.{catalog_version,
template_slug, template_version, instantiated_at}` (FR-7/NF-3) — либо явный
`origin: "scratch"` для «с нуля». Это делает будущее обновление **адресуемым**.
Vendor-update = **managed-solution** (extensibility §11 vendor-documented cliff /
Power-Platform): локальные правки клиента — **отдельный слой поверх вендорской базы**;
новая вендор-версия предъявляется как **предложение к промоушну под human-gate** (T-0129
FR-11), конфликт «вендор изменил то же, что клиент» — **явный, не тихий**. Day-1 этого
потока = **детект+уведомление** (provenance + сравнение версий → флаг «доступно
обновление шаблона vX→vY, затронуты локально-изменённые члены: [...]»); полный
**three-way-merge git-под-капотом отложен в Stage-2** явным deferral-контрактом (паттерн
T-0082, §11 «инкрементально»). Затирание локальных правок молча — **запрещено** на day-1
(достигается тем, что апдейт не применяется автоматически, а только через human-gate).

### 2.6 Загрузка/инстанцирование — governed, fail-closed, аудируемые (FR-9)

Поставка/обновление каталога и каждое инстанцирование — **governed-операция** (§8 «агент
предлагает — человек подтверждает»): шаблон до доступности проходит bundle-coherence гард
T-0082 + валидацию `parameters[]`; невалидный → fail-closed. Каждая поставка и
инстанцирование пишется в **единый аудит-лог** через `appendAuditEvent` (T-0031) —
**второго аудита не вводится**.

### 2.7 Two-floor сохранён (FR-10)

Клиент выбирает шаблон по **человеко-понятному `meta.description`** («Согласование
договоров») и отвечает на вопросы интервью о `parameters[]` — **не обязан читать**
BPMN/DMN/form-JSON-Schema/гранты. Бандл (включая каталожный) — машинный слой под карточкой
внедрения (T-0129 FR-14). Инвариант two-floor для каталога утверждается явно.

### 2.8 Состав day-1 каталога (FR-3, AC-3, AC-11)

**Механизм каталога = day-1; исчерпывающее наполнение = Stage-2** (контент BPMN/форм/DMN
каждого процесса — отдельные content-задачи). Day-1 каталог несёт **три template-slug** из
рамки §5 п.5 как опорные:
- `contracts` («Согласование договоров») — состав, роли (Инициатор, Менеджер по
  договорной работе, SSD, LGM, юротдел), маршрут по тип/сумма/направление, порог ≥5 млн ₽
  → юротдел, циклы доработки, статусы/отказ — **из референса ТЭЛ**
  (`playbooks/choros-reference-process-tel.md`, зафиксирован фаундером). Это **единственный
  шаблон с проработанным контентом day-1** (есть авторитетный источник состава).
- `it-requests` («Заявки в IT / ITSM») и `trips` («Командировки») — **slug + manifest +
  контракт параметризации зарезервированы в каталоге day-1, контент-наполнение = Stage-2**
  (нет founder-зафиксированного референса состава; наполнение = контент, §5/T-0129
  out-of-scope). Spec FR-3/AC-11 это допускают: механизм day-1, наполнение Stage-2.

> Развилка состава контента `it-requests`/`trips` (нужен ли founder-референс по аналогии
> с ТЭЛ перед наполнением) — **не решается здесь** (контент = Stage-2, вне T-0133); поднимется
> отдельной content-задачей. Это не меняет объём MVP-механизма.

---

## 3. Объектная модель (контракт полей между ролями)

> Все сущности — **декларативные** (в `pack.json` / draft-бандле), не новые таблицы day-1.
> Это контракт формата, который `coder` материализует в схему пакета и инстанциатор.

### 3.1 `TemplatePack` (расширение seed-pack pack.json)
- `meta.name: string` — slug каталога/пакета.
- `meta.version: string` — **версия каталога** (provenance-якорь, FR-7).
- `meta.description: string` — человеко-понятное описание (two-floor, FR-10).
- `process_templates: ProcessTemplate[]` — **новая аддитивная секция**.

### 3.2 `ProcessTemplate`
- `slug: string` — стабильный идентификатор шаблона (`contracts`/`it-requests`/`trips`).
- `version: string` — **версия шаблона** (вендор-артефакт, FR-7; когерентна версии бандла).
- `display_name: string` — человеко-понятное имя (two-floor выбор, FR-10).
- `bundle: BundleRef` — пятичленная связка T-0082 (см. 3.3).
- `parameters: TemplateParameter[]` — манифест параметризации (см. 3.4).
- `stage: enum("mvp-content","stage2-content")` — наполнение day-1 vs Stage-2 (FR-3).

### 3.3 `BundleRef` (форма T-0082, не вторая модель процесса)
- `bpmn: ref` — процесс BPMN.
- `form_code: ref` — форма-код.
- `form_schema: ref` — form-JSON-Schema.
- `object_schema: ref` — object-schema.
- `grants: ref` — role/agent/MCP-grants.
- `coherence: { guard: "T-0082", version: string }` — версия связки, проверяемая гардом T-0082.

### 3.4 `TemplateParameter` (машинно-читаемый контракт точек параметризации, FR-4)
- `id: string` — стабильный ключ параметра.
- `kind: enum("role-binding","threshold","sla")` — класс (минимум три, FR-4).
- `label: string` — человеко-понятный текст вопроса интервью (T-0129 FR-4).
- `target: string` — что параметр привязывает: для `role-binding` — абстрактная роль
  шаблона; для `threshold` — узел/шлюз маршрутизации BPMN; для `sla` — узел с дедлайном.
- `required: boolean` — обязателен ли для promote.
- `default: string|number|null` — значение по умолчанию (для `threshold`/`sla`; для
  `role-binding` — обычно `null`, маппинг даёт интервью против живой оргструктуры).

### 3.5 `InstanceProvenance` (происхождение draft-бандла, FR-7/NF-3)
- `origin: enum("vendor-template","scratch")`.
- `catalog_version: string|null` — версия каталога (если `vendor-template`).
- `template_slug: string|null`.
- `template_version: string|null` — версия шаблона, из которой порождён draft.
- `instantiated_at: string` — ISO-8601.

### 3.6 `VendorUpdateProposal` (managed-solution, FR-8; day-1 = детект+уведомление)
- `template_slug: string`.
- `from_version: string` / `to_version: string`.
- `locally_modified_members: string[]` — какие члены бандла клиент изменил (конфликт-риск).
- `disposition: enum("notify-only")` — day-1; `three-way-merge` = **Stage-2 (deferral)**.

---

## 4. Контракты (API/интерфейсы — псевдокод, реализует `coder`)

```text
# Инстанцирование шаблона — поверх ПУБЛИЧНЫХ authoring-API (T-0129/T-0077),
# тот же importer-over-HTTP путь, что applyPack (T-0140). НЕ прямой SQL.
instantiateTemplate(tenantSlug, templateSlug, catalogVersion) -> { draftBundleId, provenance }
  # создаёт draft-бандл в draft-тире (§8); далее петля T-0129 (адаптация→T-0130→promote)

# Загрузка/обновление каталога — governed, fail-closed (FR-9)
loadCatalogPack(pack) -> { accepted: ProcessTemplate[], rejected: {slug, reason}[] }
  # каждый шаблон: bundle-coherence гард T-0082 + валидация parameters[]; иначе rejected
  # пишет appendAuditEvent (T-0031) на каждую поставку

# Детект vendor-update (managed-solution day-1, FR-8)
detectVendorUpdates(tenantSlug) -> VendorUpdateProposal[]   # notify-only; merge = Stage-2

# Расширение manifest-валидатора каталога (fitness)
validateTemplatePack(pack) -> errors[]
  # process_templates[].bundle проходит T-0082; parameters[] непустой, kind ∈ {role-binding,threshold,sla}
```

Псевдокод; реализация — зона `coder` производных build-задач (§7).

---

## 5. Fitness-функции (исполнимые правила для CI)

Все гарды — **аддитивные bash-fitness** в стиле T-0082 (реестр-как-данные, fail-closed),
живут как CI-чек; ноль изменений существующих гардов. На фазе DESIGN артефакт — текст;
FF-self здесь проверяет **структуру самого ADR** (спека: большинство AC manual/fitness над
структурой ADR). Гарды над будущим кодом перечислены для наследования build-задачами.

- **FF-self (DESIGN-гард, исполним сейчас):** ADR содержит обязательные именованные секции
  и поимённые ссылки на все опоры; отсутствуют запрещённые конструкции.
  `ci_check`: `bash ci/checks/T-0133-adr-shape.sh` — grep, что в
  `docs/design/T-0133-process-templates.adr.md` присутствуют все из {T-0082, T-0140,
  T-0129, T-0130, T-0031, §7, §8, §11, ТЭЛ, draft-тир, managed-solution, two-floor,
  fail-closed} И отсутствуют запрещённые маркеры новой сущности-хранилища/прямого-SQL-пути
  (regex `новая.{0,20}сущность-хранилищ`, `прям\w* SQL`-как-инстанцирование без «НЕ/не»);
  exit≠0 → красный. (Покрывает AC-2/AC-5/AC-13/AC-14 fitness.)
- **FF-1 (build-наследуемая):** каждый член `process_templates[]` проходит bundle-coherence
  гард T-0082 (пятичленная связка когерентна по версиям).
  `ci_check`: расширить `ci/checks/*bundle-coherence*.sh` (T-0082) обходом
  `templates/*/pack.json::process_templates[].bundle`; рассинхрон версий → exit 1. (AC-1/AC-7/AC-9.)
- **FF-2 (build-наследуемая):** каждый шаблон каталога несёт непустой `parameters[]`, и
  каждый параметр имеет `kind ∈ {role-binding, threshold, sla}` и `target`, резолвящийся в
  существующий узел/роль бандла.
  `ci_check`: `bash ci/checks/T-0133-template-params.sh` — JSON-обход pack.json, fail-closed
  если перечень пуст или `target` висячий. (AC-4/AC-9.)
- **FF-3 (build-наследуемая):** инстанциатор не содержит прямого SQL-пути — инстанцирование
  идёт только через публичные `/api/*` (как seed importer).
  `ci_check`: `grep -L` по коду инстанциатора на наличие драйвера БД/`INSERT INTO`; любой
  прямой SQL вне публичного API → красный. (AC-2/AC-12.)
- **FF-4 (build-наследуемая):** каждый инстанцированный draft-бандл имеет `provenance` с
  `origin ∈ {vendor-template, scratch}`; `vendor-template` обязан нести непустые
  `catalog_version/template_slug/template_version`.
  `ci_check`: `bash ci/checks/T-0133-provenance.sh` — fail-closed на отсутствие provenance.
  (AC-7/NF-3.)
- **FF-5 (build-наследуемая):** vendor-update day-1 — `disposition: "notify-only"`; значение
  `three-way-merge` запрещено в коде day-1 (Stage-2 deferral-гард, паттерн T-0082).
  `ci_check`: `grep` запрет `three-way-merge`/`autoMerge` в инстанциаторе до снятия
  Stage-2-флага. (AC-8/AC-11.)

> FF-self исполним на этой фазе; FF-1..FF-5 — контракт CI-гардов, который **обязаны
> реализовать build-задачи** (§7) — это deferral-контракт в стиле T-0082: недостающий
> гард = зафиксированное обязательство, не молчаливая дыра.

---

## 6. Трассировка (AC → место в дизайне)

| AC | Покрыто |
|---|---|
| AC-1 (шаблон = bundle T-0082) | §2.2, 3.3 BundleRef, FF-1 |
| AC-2 (пакет-как-данные через публичные API, seed-pack T-0140, один механизм) | §2.1, 2.4, контракты §4, FF-3 |
| AC-3 (состав day-1 + ТЭЛ + механизм vs наполнение) | §2.8, 3.2 `stage` |
| AC-4 (машинно-читаемый перечень параметризации, 3 класса) | §2.3, 3.4 TemplateParameter, FF-2 |
| AC-5 (граница T-0133↔T-0129, не дублируем интервью) | §2.4, FF-self |
| AC-6 (инстанцирование = draft-бандл §8, петля→T-0130→promote, не миновать) | §2.4, контракты §4 |
| AC-7 (версионирование вендор-артефакта + provenance, когерентно бандлу §7) | §2.5, 3.2/3.5, FF-1/FF-4 |
| AC-8 (vendor-update managed-solution §11, не затирать молча, deferral) | §2.5, 3.6, FF-5 |
| AC-9 (governed, fail-closed, bundle-гард + валидация параметризации, аудит T-0031) | §2.6, контракты §4, FF-1/FF-2 |
| AC-10 (two-floor: выбор по описанию, не читать BPMN) | §2.7, 3.2 display_name/description |
| AC-11 (MVP vs Stage-2: механизм day-1, наполнение+merge Stage-2) | §2.8, 3.2 `stage`, §2.5, FF-5, §7 |
| AC-12 (не переизобретает основы: нет новой сущности/2-й модели/SQL/2-го аудита) | §2.1, 2.2, 2.6, FF-3 |
| AC-13 (раздел трассировки, всё → playbook/основа) | этот §6 |
| AC-14 (design-only граница + список build-задач) | §7 |

Опора на рамку/основы (NF-4): §5 п.5 (FR-3/§2.8), §1 two-floor (FR-10/§2.7), T-0082
(§2.2/3.3/FF-1), T-0140 (§2.1/2.4), T-0129 (§2.4 FR-4/FR-11/FR-14), T-0130 (§2.4),
ext §7 (§2.5 когерентность версий), §8 (§2.4 тиры/§2.6 governance), §11 (§2.5
managed-solution), T-0031 (§2.6 аудит). Требований «из ниоткуда» нет.

---

## 7. Декомпозиция implementation (design-only граница, AC-14)

T-0133 — **design-only**: формат файла/миграции/код/MCP-tool строки — **зона производных
build-задач**. Из ADR вытекают (предлагаемые, materialize+approve — гейт фаундера):

1. **BUILD-A — формат template-pack:** расширить `seed/pack.schema.json` секцией
   `process_templates[]` (схема `ProcessTemplate`/`BundleRef`/`TemplateParameter` §3) +
   `validateTemplatePack`. Наследует FF-2.
2. **BUILD-B — импортёр-инстанциатор:** `instantiateTemplate` поверх публичных authoring-API
   (importer-over-HTTP путь T-0140), draft-бандл в draft-тир (§8); provenance §3.5; аудит
   T-0031. Наследует FF-3/FF-4.
3. **BUILD-C — catalog-load гард:** расширить bundle-coherence гард T-0082 на
   `templates/*/pack.json` + `loadCatalogPack` fail-closed. Наследует FF-1.
4. **BUILD-D — vendor-update детект (managed-solution day-1):** `detectVendorUpdates`,
   `disposition: notify-only`, предъявление под human-gate (T-0129 FR-11). Наследует FF-5.
   Полный three-way-merge — **Stage-2 (deferral-контракт)**.
5. **CONTENT-1 — шаблон `contracts` (day-1 контент):** наполнение бандла из референса ТЭЛ.
6. **CONTENT-2/3 — `it-requests`/`trips` (Stage-2 контент):** наполнение — Stage-2,
   возможно с отдельным founder-референсом состава (как ТЭЛ).

**Stage-2 (явный deferral-контракт, паттерн T-0082):** полный git-под-капотом
three-way-merge vendor-update vs local-edit; исчерпывающее наполнение каталога.

---

## 8. Развилки (НЕ решаются архитектором — для протокола)

Несущих founder-развилок нет (спека §6: рамка подтверждена, основы приняты). Зафиксированы
как контекст, не как решения:
- **Контент `it-requests`/`trips`** — нужен ли отдельный founder-референс состава (по аналогии
  с ТЭЛ для `contracts`) перед наполнением. Day-1 не затрагивает (контент = Stage-2); поднимется
  content-задачей. Объём MVP-механизма не меняет.
- **Глубина managed-solution day-1** — design-owned: консервативный дефолт `notify-only`
  (детект+human-gate), three-way-merge → Stage-2. Не founder-input (§11 уже секвенирует).
- **Маппинг роли шаблона на узел при неоднозначности** (несколько кандидатов) — design-owned:
  дефолт «поднять вопрос человеку» (T-0129 FR-4), не молчаливая подстановка.

**runtime_target:** локально / контейнер (часть Choros-стека, тот же silo-Postgres и
публичные API; внешнего ресурса нет — провижн не требуется).
