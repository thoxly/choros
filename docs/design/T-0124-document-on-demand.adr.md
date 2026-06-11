# ADR · T-0124 — Document-on-demand: рендер документа из живых справочников

**Status:** ready (без эскалации фаундеру — направление задано в gap-map §2/§4б инварианты 1–3, объём делегирован контрактами T-0122 `doc_mode` / T-0119 `is_snapshot`; открытые оси (набор форматов day-1, наполнение реестра зависимостей шаблона, представление прав рендера) — зона DESIGN, не меняют объём/поведение продукта)
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** T-0124 (product=choros, type=design, prio 50, deps: T-0122 DONE)
**Spec:** `docs/specs/T-0124-document-on-demand.spec.md` (status: ready, 00d2f0f; 15 AC, no blocking)

**Foundation (do NOT contradict) — каждый claim = file:line живого кода/миграции ЛИБО file:line чужого ADR-контракта с пометкой статуса:**

- `docs/design/T-0122-external-participant.adr.md` — внешняя поверхность УЖЕ спроектирована и **ждёт** рендер. Контракт делегирования (статус: DONE на dev; миграция внешней поверхности на ветке T-0124 ещё не материализована — цитируется как ADR-контракт):
  - `external_surface.doc_mode text NOT NULL DEFAULT 'snapshot'` CHECK ∈ `{snapshot, live}` — T-0122 ADR §4.1 (file:line `docs/design/T-0122-external-participant.adr.md:440`).
  - `verify` = `resolveFor(handle, subject, "read")` → `projectFields(raw, vis)`, `vis` = facet поверхности ∩ facet гранта; скрытые поля **физически отсутствуют** (не маскируются строкой) — T-0122 §2.5 (`:290`).
  - `download` = presign-after-allow снапшота (T-0119 `getFileContentUrl`) **либо** живого-документа-рендера: «T-0124 потребляет этот контракт, рендер — там» — T-0122 §2.5 (`:289`), §2.9 (`:392`), §4.4 step5 (`:563`–`:567`).
  - QR-кейс = `external_surface{ actions:["verify","download"], facet:<публичный срез>, max_uses:null }` — T-0122 §2.9 (`:388`–`:390`).
  - **T-0122 даёт поверхность доступа + токены + анти-абьюз; T-0124 — рендер** (T-0122 `:21`, `:392`). Токены/TTL/отзыв/одноразовость/остаточное окно presign — T-0122 §2.6/§2.7 (`:297`–`:313`), НЕ дублируются здесь.

- `docs/design/T-0119-files-attachments.adr.md` — **приёмная поверхность снапшота** (статус: DONE на dev; `file`/`file_version` на ветке T-0124 ещё не материализованы — цитируется как ADR-контракт):
  - `file_version.is_snapshot boolean NOT NULL DEFAULT false` — «document-on-demand снапшот (FR-9/T-0124)» — T-0119 §4.2 (`docs/design/T-0119-files-attachments.adr.md:181`).
  - `addVersion(store, file, body, { mime, cycleRef?, isSnapshot?, dataClass? })` — создаёт иммутабельную `file_version`-строку + новый S3-ключ + перевод `current_version`; старая версия читаема — T-0119 §4.3 (`:224`–`:227`), §3 step6 (`:98`–`:103`).
  - `file_version` **никогда не UPDATE/DELETE контентной части** (иммутабельность, FF-V) — T-0119 `:66`–`:67`.
  - presign-after-allow: ни байта без предшествующего allow PDP по записи-владельцу — T-0119 §3 step5 (`:89`–`:96`). «Здесь только приёмная поверхность снапшота, не рендер — T-0124» — T-0119 `:19`.

- `docs/design/T-0021-grant-resolver-pdp.adr.md` + **живой код** `src/core/grant-resolver.ts` (статус: DONE, код на ветке T-0124):
  - `resolveFor(handle, subject, op)` — единый PDP-чокпойнт, action-time, fail-closed; reason-union `"no_grant" | "cross_tenant" | "not_found"` — `src/core/grant-resolver.ts:489` (function); reason-returns `:499/:520/:614`.
  - `projectFields(rawFields, visibleFieldSet, maskCtx?)` → НОВЫЙ объект только из видимых полей; делегирует `maskFields` — `src/core/grant-resolver.ts:290`–`:298`.
  - `grantFacetFields` / facet-механика: strictly-absent facet ⇒ whole-resource; well-formed `{fields:[...]}` ⇒ narrow; malformed ⇒ `[]` (zero) — `src/core/grant-resolver.ts:321`–`:336`.
  - `maskFields` транс­форм `drop` = **омиссия ключа** (capability-not-text), не маскированная строка; null clearance / unknown class / fieldRank<0 ⇒ `drop` (fail-closed) — `src/core/data-classification.ts:127`,`:318`–`:322`,`:432`–`:433`.

- `docs/design/T-0016-audit-floor.adr.md` + **живая миграция** `migrations/006_audit_event.sql` (статус: DONE, на ветке T-0124):
  - единая append-only per-tenant hash-chained `audit_event`; **open-vocab `type`** (новые события = строки, не таблицы); `choros_app` имеет только `SELECT, INSERT` (no UPDATE/DELETE) — T-0016 §1/§3.1 (`:41`–`:51`).
  - прецедент open-vocab: T-0122 пишет `external.download`/`external.verify`/`external.upload` строкой типа (T-0122 §2.8 `:374`–`:381`).

- `docs/design/T-0014-registry-model.adr.md` + **живые миграции** `migrations/004_registry_def.sql`, `migrations/005_record.sql` (статус: DONE, на ветке T-0124):
  - `record(tenant_id, id, registry_id, data jsonb, …)` — tenant-таблица, FORCE RLS, policy `record_tenant_isolation` (`migrations/005_record.sql:9`–`:30`); `registry_def.record_schema jsonb NOT NULL` (`migrations/004_registry_def.sql:15`). «Живые справочники» = эти строки; рендер читает их как источник.

- `docs/design/T-0013-tenant-isolation.adr.md` — все источники рендера читаются под `choros.tenant_id` GUC / FORCE-RLS; cross-tenant источник невозможен на уровне БД (`migrations/005_record.sql:21`–`:30` — живая policy).

- `docs/design/T-0033-data-classification.adr.md` + **живой код** `src/core/data-classification.ts` — `DataClass` + clearance-транс­форм; срез полей в рендере проходит тот же транс­форм, что обычное чтение (`maskFields`).

**Подсистема согласованности «производный артефакт ↔ поля схемы» (FR-8) — НЕ четвёртый механизм:**
- T-0072 (named-binding): **живой код** `src/core/binding-compat.ts` — `checkBindingCompat` (чистая функция, `BindingViolation`, типы `missing_in_schema`/`missing_in_bpmn`) — `src/core/binding-compat.ts:37`–`:47`,`:66`+.
- T-0082 (bundle-coherence): **живой реестр** `ci/checks/bundle_members.txt` (TSV, FROZEN CONTRACT: «добавить член = одна строка + pass `bundle-coherence.sh`»); `bundle-coherence.sh` = единая исполняемая точка fail-closed — T-0082 ADR §2 (`docs/design/T-0082-bundle-coherence.adr.md:42`–`:51`). (Статус: реестр-файл и `bundle-coherence.sh`-скрипт **[ЖИВОЙ ci/checks/bundle-coherence.sh]** — расширение check-report-page-deps от T-0121 — КОНТРАКТ-DONE; `check-template-deps`-расширение для T-0124 = `[НОВАЯ работа]`.)
- T-0121 (отчёты-как-UI): `report_page_dep` (реестр зависимостей страница↔`field_key` схемы, `dep_kind ∈ {read,aggregate}`, `stale boolean`) + **`checkReportPageDepFields`** из `src/core/report-page-compat.ts` (расширение T-0072, «один control plane согласованности», NF-1); деструктив-дисциплина: drop/rename `field_key` при активном non-stale dep → `409 destructive_schema_change`, не применяется; force → `stale=true` + депромоут + один audit-event — T-0121 ADR §2.1/§5 (`docs/design/T-0121-reports-pages.adr.md:25`,`:33`,`:135`–`:143`). (Статус: T-0121 DONE на dev; `report_page_dep`-миграция и `report-page-compat.ts` НЕ на ветке T-0124, цитируются как контракт-прецедент.)

> **Легенда статусов claim'ов в этом ADR:** `[ЖИВОЙ]` = file:line кода/миграции на ветке T-0124; `[КОНТРАКТ-DONE]` = file:line чужого ADR/реестра, механизм DONE на dev (этой ветке предшествует merge-base, миграция/код придёт с rebase на dev перед impl); `[НОВАЯ работа]` = строит coder T-0124. Прошлые blocking случались именно из claim'ов про «существующий» механизм без кода — здесь каждый помечен.

---

## 0. Контекст и проблема

Choros сегодня умеет хранить **загруженные файлы** (T-0119) и отдавать **внешний срез записи** (T-0122 verify/download). Чего нет: документа, которого **нет как файла** — он собирается из текущего состояния справочников в момент запроса. Два кейса фаундера (gap-map §2, ТЭЛ §5/§1):

1. **QR-валидация** (ТЭЛ §5): контрагент сканирует QR на договоре/справке → видит «валидно/невалидно» + узкий публичный срез, выводимый **из живых данных** (запись существует и в нужном статусе), может скачать. Нет «архивного файла» — истина в справочнике.
2. **Генерация реестра** (ТЭЛ §1): «реестр договоров за период» — табличная выгрузка из справочника по фильтру; «Прошлые реестры» — зафиксированные снапшоты, воспроизводимые задним числом.

Несущее ограничение (gap-map §4б инвариант 1, non-negotiable): любой живой рендер **может быть зафиксирован снапшотом** в файловое хранилище; «вчерашний реестр» воспроизводим байт-в-байт; ссылка/QR недвусмысленно указывает либо на иммутабельный снапшот, либо явно на «живой документ».

Три инварианта-границы делают это **тонким ядром** (CONCEPT §5): один механизм прав (PDP T-0021, NF-1), один канал внешнего доступа (T-0122), одна приёмная поверхность снапшота (T-0119), одна подсистема согласованности шаблон↔схема (T-0072/T-0082/T-0121). T-0124 — **производитель байтов**, всё остальное потребляется.

---

## 1. Decision (механизм одним абзацем)

Document-on-demand вводится как **одна чистая render-операция** `render(template, params, subject) → { bytes, format, meta }`, где источник данных — `record`-строки реестров `[ЖИВОЙ]` (`migrations/005_record.sql`), прочитанные **под субъектом запроса через тот же `resolveFor`/`projectFields`** `[ЖИВОЙ]` (`src/core/grant-resolver.ts:290`), а НЕ предзаписанный файл. Право рендера = производная прав чтения записей-источников (никакого `render_acl`, NF-1): недоступная субъекту запись/поле **физически отсутствует** в документе (транс­форм `drop` = омиссия ключа, `src/core/data-classification.ts:127` `[ЖИВОЙ]`), не маскированная строка. Движок рендера **един для всех форматов** — формат есть атрибут шаблона/запроса (`renderer` выбирается по `template.format`), не код per-кейс. Day-1 закрытый набор форматов = **{`csv`, `html`}** (табличный для реестра + человекочитаемый для QR; PDF отвергнут в Stage-2 — §3). Режимы развязаны через контракт T-0122 `doc_mode` `[КОНТРАКТ-DONE]`: **`live`** — каждый запрос рендерит из текущих данных, не воспроизводим; **`snapshot`** — рендер один раз зафиксирован как иммутабельная `file_version` через `addVersion(..., isSnapshot=true)` (T-0119 `:224` `[КОНТРАКТ-DONE]`), воспроизводим. QR-кейс питается **через поверхность T-0122** без своего канала: `verify` отдаёт facet-срез из render-проекции, `download` зовёт render (live) или presign (snapshot). Шаблон — **производный артефакт от `registry_def.record_schema`**; его зависимость от полей схемы регистрируется/проверяется **той же подсистемой**, что `report_page_dep` (T-0121) / `bundle_members.txt` (T-0082) / `checkBindingCompat` (T-0072) — `template_dep` + `checkTemplateDepFields` (расширение, не четвёртый механизм). Каждый рендер (успех И отказ) — строка `audit_event` open-vocab `type` (`doc.render`/`doc.render_denied`/`doc.snapshot_fixed`), T-0016 `[ЖИВОЙ]` `migrations/006_audit_event.sql`. Шаблон авторится config-агентом (T-0077) как DRAFT + human-gated promote; рантайм-агентная генерация шаблона — Stage-2 (gap-map §4б инвариант 3).

---

## 2. Архитектура

### 2.1 Слои и границы (тонкое ядро, логика на границах)

```
                    render(template, params, subject)
                                 │
          ┌──────────────────────┼───────────────────────┐
          ▼                      ▼                        ▼
  [resolve template]   [batch-read records via PDP]   [audit_event]
  registry_def +       resolveFor(handle,subject,read) doc.render /
  template_def         → projectFields (drop=omit)     doc.render_denied
  (version, format)    T-0021 [ЖИВОЙ]                  T-0016 [ЖИВОЙ]
          │                      │
          └──────────┬───────────┘
                     ▼
         [format engine: renderers{csv,html}]   ← формат = атрибут шаблона
                     │
        ┌────────────┴─────────────┐
        ▼ live                     ▼ snapshot
  bytes → caller            addVersion(..,isSnapshot=true)  ← T-0119 [КОНТРАКТ-DONE]
  (doc_mode='live')         → file_version  +  doc.snapshot_fixed event
                            (doc_mode='snapshot' указывает на file_version)
                     │
        внешний путь (T-0122) [КОНТРАКТ-DONE], НЕ свой канал:
          verify   → projectFields-срез (facet поверхности ∩ facet гранта)
          download → live: render | snapshot: presignGet(file_version.key)
```

**Зоны ответственности (NF-5 «потребляет, не достраивает»):**

| Слой | Кто владеет | T-0124 делает |
|---|---|---|
| Чтение записей + право + проекция полей | T-0021 PDP `[ЖИВОЙ]` | **вызывает** `resolveFor`+`projectFields` per-запись; не вводит второго резолвера |
| Файл-хранилище / presign / версии / иммутабельность | T-0119 `[КОНТРАКТ-DONE]` | **вызывает** `addVersion(isSnapshot=true)`; не достраивает store |
| Внешний канал / токены / TTL / анти-абьюз | T-0122 `[КОНТРАКТ-DONE]` | **питает** verify/download проекцией/байтами; не вводит свой токен |
| Аудит | T-0016 `[ЖИВОЙ]` | **пишет** open-vocab строки; не вводит audit-таблицу |
| Согласованность шаблон↔схема | T-0072/T-0082/T-0121 | **расширяет** реестром `template_dep` + чистой функцией; не четвёртый механизм |
| Tenant-изоляция | T-0013 RLS `[ЖИВОЙ]` | читает только свой tenant; внешний tenant из токена T-0122 |
| **Шаблон-модель + движок рендера + render-операция** | **T-0124 `[НОВАЯ работа]`** | `template_def`, renderers, `render(...)`, `renderAndFix(...)` |

### 2.2 Контракт рендера (FR-1) — `[НОВАЯ работа]`

**Вход:** `(templateRef, params, subject)`.
- `templateRef` → `template_def`-строка (версия, формат, привязка к `registry_id`).
- `params` — параметры выборки: для справки (QR) = `{ recordRef }` (одна запись-цель); для реестра = `{ registryId, filter }` (выборка).
- `subject : ResolveSubject = { tenantId, subjectId }` (T-0021 identity-only; внешний — `external_role_id`, T-0122).

**Выход:** `RenderResult = { bytes: Uint8Array, format: 'csv'|'html', meta: RenderMeta }`.
- `RenderMeta = { templateId, templateVersion, format, renderedAt: bigint, sourceDigest: string, recordCount: number }` — `sourceDigest` = детерминированный хэш отобранного (после projection) набора, для трассировки «из каких данных» (NF-2 воспроизводимость снапшота: тот же digest ⇒ тот же документ).

**Инвариант детерминизма (NF-2):** при фиксированных `(templateVersion, projected-rows, renderedAt)` `render` производит байт-идентичный выход (renderer чист, сортировка строк реестра детерминирована — `ORDER BY (tenant_id,id)`). Это и есть воспроизводимость «вчерашнего реестра»: снапшот хранит байты в `file_version`, повторный download отдаёт те же байты независимо от изменения исходных `record`.

### 2.3 Право рендера = производная прав чтения (FR-5, NF-1, NF-3) — потребление T-0021

Рендер НЕ вводит permission-механизма. Для каждой записи-источника:
1. `resolveFor(deps.resolver, handleOf(recordRef), subject, "read")` `[ЖИВОЙ src/core/grant-resolver.ts:489]`.
2. `{denied:true}` ⇒ запись **не попадает** в документ (для реестра — отсутствует строка; не «строка-прочерк», раскрывающая существование). Для одиночной справки нулевой доступ ⇒ render-операция возвращает `{ denied:true, reason }` (отказ, не пустой частичный документ с утечкой — NF-3).
3. `{denied:false, fields}` ⇒ в документ идёт **только `projectFields`-результат** `[ЖИВОЙ :290]`: невидимое поле физически отсутствует (транс­форм `drop` = омиссия ключа `[ЖИВОЙ data-classification.ts:127]`), не маскированная строка.

**Шаблон не повышает привилегию (FF-NO-RENDER-ACL):** рендер под субъектом X не показывает больше, чем X видит при обычном чтении тех же записей. Внешний субъект (T-0122) предъявляется тому же `resolveFor` под производным ограниченным грантом — идентичный путь (T-0122 §2.5 `:290`).

### 2.4 Форматы day-1 и движок (FR-2, NF-6) — `[НОВАЯ работа]`

Закрытый набор day-1: **`csv`, `html`** (см. rejected_alternatives для PDF). Формат — атрибут шаблона (`template_def.format`), запрос может его не переопределять. Движок един:

```
type DocFormat = 'csv' | 'html';
interface Renderer { format: DocFormat; render(tmpl, rows, meta) → { bytes, mime }; }
const RENDERERS: Record<DocFormat, Renderer>;   // closed map
```

Расширение набора (PDF, XLSX) = добавить `Renderer` + строку в closed-set CHECK `template_def.format`, **не новый примитив** (FF-FORMAT-CLOSED). `render(...)` для всех форматов проходит один путь resolve→read→project→renderer; никакого кода per-кейс (per-template = данные шаблона, не ветка кода).

### 2.5 Режимы live / snapshot и операция фиксации (FR-3, NF-2) — потребление T-0122 `doc_mode` + T-0119 `addVersion`

- **`live`** (`doc_mode='live'` на поверхности T-0122 `[КОНТРАКТ-DONE :440]`): каждый запрос = `render(...)` из текущих `record`; не воспроизводим задним числом; явно помечен «живой документ».
- **`snapshot`** (`doc_mode='snapshot'`): рендер **один раз** зафиксирован.

**Операция фиксации `renderAndFix(templateRef, params, subject) → versionId`** `[НОВАЯ работа]` = тонкая композиция, **не достройка хранилища**:
1. `r = render(templateRef, params, subject)` (§2.2).
2. `versionId = addVersion(store, fileOwner, r.bytes, { mime: mimeOf(r.format), isSnapshot: true, dataClass })` `[КОНТРАКТ-DONE T-0119 :224]` — иммутабельная `file_version`, `is_snapshot=true` `[:181]`.
3. `doc.snapshot_fixed` audit-event связывает `(templateId, templateVersion, sourceDigest, renderedAt)` ↔ `versionId` (§2.6).

После фиксации `download` (`doc_mode='snapshot'`) = `presignGet(file_version.key)` (T-0119 §3 step5 `[КОНТРАКТ-DONE :89]`) — отдаёт **те же байты** даже после изменения исходных `record` (NF-2). «Когда что» (атрибут конфигурации поверхности, недвусмысленно): **юридический артефакт** (договор-согласование, «Прошлые реестры») фиксируется снапшотом; **оперативная справка/живой реестр** = `live`. Выбор — это `external_surface.doc_mode` (для внешнего) либо параметр операции (для внутреннего); никакого «то ли живой, то ли архивный».

### 2.6 Аудит рендеров (FR-7) — потребление T-0016 open-vocab `[ЖИВОЙ]`

Каждый рендер (успех И отказ) — строка `audit_event` `[ЖИВОЙ migrations/006_audit_event.sql]`, open-vocab `type` (новые строки, не таблица):

| `type` | когда | payload |
|---|---|---|
| `doc.render` | успешный рендер | `actor` (subjectId / для внешнего — `external_role_id`+`surface_id`), `subject={templateId, templateVersion, params/filter}`, `via`, `format`, `record_count`, `source_digest` |
| `doc.render_denied` | отказ по правам | то же + `reason` (`no_grant`/`cross_tenant`/`not_found`, из `resolveFor`) |
| `doc.snapshot_fixed` | фиксация снапшота | то же + `version_id` + `is_snapshot=true` (связь рендер↔файл-версия для «какой снапшот когда из каких данных») |

Tenant-scoped (T-0013). **Секрет токена внешнего пути не пишется** — наследует T-0122 §2.8 (`:374`–`:381`). Аудит — append-only, `choros_app` без UPDATE/DELETE (T-0016 `[:50]`).

### 2.7 QR-кейс через поверхность T-0122 (FR-4) — потребление, НЕ свой канал

T-0124 НЕ вводит внешний канал/токен/лендинг. Питает уже спроектированные op-отображения T-0122 `[КОНТРАКТ-DONE]`:
- **verify** (T-0122 §2.5 `:290`): `resolveFor(handle, external_subject, "read")` → `projectFields(raw, vis)`, `vis` = facet поверхности ∩ facet гранта. T-0124 предоставляет проекцию «валидно/невалидно» = **производная живых данных**: «валидно» ⟺ запись-цель существует И в нужном статусе (поле статуса видимо в facet), а не «файл присутствует». Скрытые поля физически отсутствуют; verify не раскрывает их существование.
- **download** (T-0122 §2.5 `:289`): `doc_mode='snapshot'` ⇒ `presignGet(file_version)` (T-0119); `doc_mode='live'` ⇒ `render(...)` под производным грантом — T-0124 предоставляет рендер, T-0122 его вызывает.
- Токены / TTL / отзыв / max_uses / остаточное окно presign / anti-oracle — **целиком T-0122** (§2.6/§2.7), не дублируются.

### 2.8 Генерация реестра (FR-6) — частный случай одного примитива

Реестр = `render(templateReestr, { registryId, filter }, subject)` с `format='csv'`:
- Вход — фильтр по реестру (тип/период/статус — «реестр договоров» ТЭЛ §1). Выборка читается RLS-scoped (T-0013), per-row через `resolveFor` (§2.3): только видимые субъекту строки попадают; невидимая = **отсутствует** (не строка-прочерк, FF-NO-MASK-ROW).
- Режимы (§2.5): `live` = «реестр сейчас»; `snapshot` = «Прошлые реестры» (воспроизводимый, ТЭЛ §1).
- **Граница с T-0121** (FF-NOT-T0121): T-0124 = документ-**артефакт** (CSV/HTML-файл по шаблону, для скачивания/внешней стороны/снапшота); T-0121 = отчётная **UI-страница** руководителю (React над агрегацией). Разные поверхности. Общий — только слой согласованности шаблон↔поля (§2.9), и тот переиспользуется, не дублируется.

### 2.9 Шаблон: модель, авторинг, версионирование, согласованность (FR-8) — расширение T-0072/T-0082/T-0121

**Модель `template_def`** `[НОВАЯ работа]` (tenant-таблица, T-0013-контракт: FORCE RLS, policy, `known_tenant_tables.txt`):

| поле | тип | смысл |
|---|---|---|
| `tenant_id, id` | `uuid` | PK |
| `registry_id` | `uuid` | FK `(tenant_id, registry_id)→registry_def`; реестр-источник (one primary; реестр может джойнить — Stage-2) |
| `format` | `text NOT NULL` | CHECK ∈ closed-set `{csv, html}` (имя CHECK `template_def_format_chk`, расширение = аддитивная миграция, как T-0121 `dep_kind`) |
| `body` | `text NOT NULL` | тело шаблона (плейсхолдеры `field_key`); НЕ код, декларативные плейсхолдеры (Stage-2 — сложная верстка) |
| `version` | `integer NOT NULL` | монотонная версия шаблона; часть `RenderMeta` и снапшота (трассировка «каким шаблоном») |
| `tier` | `text NOT NULL` | `{draft, published}` (T-0087-дисциплина; config-агент создаёт draft, human-gated promote) |
| created_by/at, updated_at | | стандарт |

**Реестр зависимостей `template_dep`** `[НОВАЯ работа]` — **расширение T-0121 `report_page_dep`-модели, не четвёртый механизм** (один control plane согласованности, NF-1): одна строка = шаблон зависит от одного `field_key` одной `registry_def.record_schema`, `dep_kind ∈ {read, aggregate}`, `stale boolean`. Floor-1 авто-вывод: deps выводятся синтаксическим разбором `template_def.body` (каждый плейсхолдер `field_key` → строка `template_dep`), как T-0121 §2.1 (`docs/design/T-0121-reports-pages.adr.md:28`).

**Чистая функция согласованности `checkTemplateDepFields`** `[НОВАЯ работа]` в `src/core/template-compat.ts` — **зеркало `checkBindingCompat`** `[ЖИВОЙ src/core/binding-compat.ts]` / `checkReportPageDepFields` (T-0121): `(template_deps, record_schema) → { ok } | { ok:false, violations:[{templateId, fieldKey, type}] }`, no-I/O, `type ∈ {missing_in_schema}`. **Дисциплина деструктива идентична T-0121 §5** (`docs/design/T-0121-reports-pages.adr.md:135`–`:143`):
- **Мягкое** (relabel, add field, enum widening, toggle required) → применяется + `warnings`.
- **Деструктивное** (drop/rename `field_key` при активном non-stale `template_dep`) → `409 destructive_schema_change`, не применяется.
- **Escape** (`force:true` + grant `mgmt_object:schema_destructive`) → применяется, dep `stale=true`, шаблон депромоут `tier='draft'`, один audit-event. Никогда тихое удаление.

**CI-гард:** `template_dep`-член добавляется строкой в `ci/checks/bundle_members.txt` `[ЖИВОЙ-реестр]` (T-0082 FROZEN CONTRACT «один TSV + pass `bundle-coherence.sh`»); `bundle-coherence.sh` (T-0082 `[КОНТРАКТ-DONE]`) расширяется проверкой `template_dep.field_key ∈ record_schema.properties` (как T-0121 §5 `:143`), fail при stale dep в репозитории конфигов.

**Кто авторит:** config-агент (T-0077) производит `template_def` как DRAFT-артефакт; **human-gated promote** в `published` (ось governance — та же, что T-0121/T-0087). Рантайм-агентная генерация/правка шаблона — **Stage-2** (gap-map §4б инвариант 3, §3 ниже).

### 2.10 Tenant-изоляция (NF-4) — потребление T-0013 RLS `[ЖИВОЙ]`

Все `record`-чтения рендера идут под `choros.tenant_id` GUC (FORCE RLS, `migrations/005_record.sql:21`–`:30`). Cross-tenant источник в шаблоне невозможен на уровне БД. Внешний путь: tenant выводится из токена (T-0122), не из запроса (NF-4). `template_def`/`template_dep` — tenant-таблицы, та же policy.

---

## 3. MVP vs Stage 2 (FR-9, NF-6)

**MVP day-1:**
- Контракт `render(template, params, subject)` (§2.2) + ≥1 формат — day-1 **два**: `csv` (реестр) + `html` (QR-справка).
- Режимы `live`/`snapshot` (§2.5) + операция `renderAndFix` → `addVersion(isSnapshot=true)`.
- Питание T-0122 `verify`/`download` (QR-кейс, §2.7).
- Генерация реестра (§2.8).
- Права-производность (§2.3, PDP T-0021) + аудит (§2.6, T-0016).
- `template_def` + `template_dep` + `checkTemplateDepFields` + расширение `bundle-coherence.sh` (§2.9); config-агент DRAFT + human-gated promote.

**Stage-2 (явно отложено, критерий разморозки):**
- **Агентная генерация/правка шаблона как рантайм-ответ агента** — за разморозкой E5.6–E5.10 (gap-map §4б инвариант 3). Критерий: эпик E5.6+ approved фаундером. Day-1 — только config-агент DRAFT + human promote.
- **PDF / сложная верстка / брендирование** сверх `{csv,html}` — добавляется `Renderer` + closed-set CHECK строкой (FF-FORMAT-CLOSED), не новый примитив. Критерий: запрос клиента/демо требует PDF.
- **Docgen-модуль по первому клиенту** (брендирование, ЭДО, подпись) сверх поглощённого ядра (gap-map §2 🔵). Критерий: контракт с клиентом.
- **Multi-registry join в шаблоне** (реестр из нескольких реестров) — day-1 один primary `registry_id`.

---

## 4. Развилки фаундера

**Нет новых развилок уровня фаундера.** Объём определён gap-map §2 + инвариантами §4б 1–3 (данность) и контрактами делегирования T-0122 `doc_mode` / T-0119 `is_snapshot`. Открытые оси решены в DESIGN с обоснованием (форматы day-1 = `{csv,html}`, §3 rejected; наполнение `template_dep` = Floor-1 авто-вывод + расширение T-0121-модели, §2.9; представление прав = производность PDP, §2.3). Анти-DoS / rate-limit / TTL внешней ссылки — **наследуется как deploy-time параметр от T-0122** (T-0122 §8/§10), T-0124 не вводит свой — потому не эскалируется здесь. `runtime_target` = контейнер dev-стека (Postgres + Node-ядро + MinIO для T-0119-снапшота), как T-0119/T-0122; новый внешний ресурс не требуется.

---

## 5. Rejected alternatives

(в contract JSON; ключевые — здесь.)

1. **PDF в day-1.** Отвергнут: PDF-движок (верстка, шрифты, headless-рендер) = тяжёлая зависимость и поверхность для рендер-DoS, несоразмерная day-1 (NF-6). `html` покрывает человекочитаемый QR-кейс (браузер контрагента рендерит), `csv` — реестр; PDF добавляется Stage-2 одним `Renderer` без смены примитива. (FF-FORMAT-CLOSED гарантирует, что добавление — данные, не новый код-путь.)
2. **`render_acl` / document-visibility поле на шаблоне.** Отвергнут (NF-1, gap-map §4б инвариант 2): второй authority-механизм рядом с grant-таблицей; шаблон мог бы повысить привилегию. Производность от `resolveFor` (§2.3) даёт право бесплатно, через единый PDP. (FF-NO-RENDER-ACL.)
3. **Свой внешний канал/токен для QR.** Отвергнут (NF-5): дублировал бы T-0122-поверхность (токены/TTL/анти-абьюз). T-0124 питает существующие `verify`/`download` (§2.7).
4. **Своё файл-хранилище для снапшота.** Отвергнут (NF-5): T-0119 `addVersion(isSnapshot=true)` — приёмная поверхность; T-0124 = производитель байтов.
5. **Своя audit-таблица `render_log`.** Отвергнут (NF-5, T-0016 «ровно одна audit-таблица-семья»): open-vocab `type` = строки `doc.render*`.
6. **Четвёртый механизм согласованности шаблон↔схема** (свой линтер/реестр). Отвергнут (NF-1): `template_dep` зеркалит `report_page_dep` (T-0121), `checkTemplateDepFields` зеркалит `checkBindingCompat` (T-0072), гард — расширение `bundle-coherence.sh` (T-0082). Один control plane.
7. **Маскированная строка-прочерк для недоступных записей/полей.** Отвергнут (NF-3, capability-not-text): транс­форм `drop` = омиссия ключа `[ЖИВОЙ data-classification.ts:127]`; строка-прочерк раскрывала бы существование (анти-oracle). Невидимое **физически отсутствует**.
8. **Кэш живого рендера.** Отвергнут (FR-1 «из живых данных»): кэш ломает AC-11 (изменение между двумя `live`-рендерами обязано отразиться). Воспроизводимость даёт **снапшот** (явная фиксация), не кэш.

---

## 6. Fitness-функции

| ID | Правило | ci_check |
|---|---|---|
| **FF-NO-RENDER-ACL** | Нет второго механизма прав рендера: render-путь не вводит `render_acl`/`document_visibility`/own permission-store; право = `resolveFor`. | `grep -REn 'render_acl\|document_visibility\|renderPermission\|canRender' src/ migrations/` ⇒ ∅ (ноль совпадений); + unit: `render` под subject без `read`-гранта ⇒ запись/поле отсутствует. |
| **FF-RENDER-VIA-PDP** | Каждое чтение записи-источника в рендере проходит `resolveFor`+`projectFields` (нет прямого `SELECT … FROM record` в render-модуле мимо PDP). | `grep -REn 'from .*record' src/core/document-render*` ⇒ только через PDP-порт; AST/lint-правило: render-модуль импортирует `resolveFor`, не сырой record-репозиторий. |
| **FF-NO-MASK-ROW** | Недоступная запись/поле **отсутствует** (омиссия ключа `drop`), не маскированная строка/строка-прочерк. | unit: реестр под частичным грантом ⇒ невидимые строки **отсутствуют** (count = видимые), невидимые поля — ключ отсутствует в объекте (а не `null`/`"***"`). |
| **FF-FORMAT-CLOSED** | Набор форматов закрыт: `template_def.format` CHECK ∈ `{csv,html}`; `RENDERERS` — closed map; расширение = миграция CHECK + Renderer, не ветка кода per-кейс. | `grep` CHECK-имя `template_def_format_chk` в миграции; тест: неизвестный формат ⇒ reject; число ключей `RENDERERS` = число элементов CHECK-set. |
| **FF-SNAPSHOT-IMMUTABLE** | Снапшот = `addVersion(isSnapshot=true)` (T-0119); render-модуль не пишет в файл-store напрямую и не UPDATE/DELETE `file_version`. | `grep -REn 'INSERT INTO .*file_version\|UPDATE .*file_version\|DELETE .*file_version' src/core/document-render*` ⇒ ∅; снапшот только через `addVersion`-порт; тест воспроизводимости (AC-13). |
| **FF-REPRODUCIBLE** | Повторный download снапшота отдаёт байт-идентичный документ после изменения исходных `record`; `live` отражает новые. | integration (AC-13): fix snapshot → mutate record → re-download snapshot = байт-идентичен; `live`-render = новые данные. |
| **FF-AUDIT-EVERY-RENDER** | Каждый рендер (успех И отказ) ⇒ ровно одна `audit_event` (`doc.render`/`doc.render_denied`/`doc.snapshot_fixed`); токен-секрет отсутствует в payload. | integration (AC-14): render+denied+fix ⇒ 1 event каждый, tenant-scoped; `grep` payload на отсутствие token/secret-ключей; type ∈ open-vocab (строка, не новая таблица — `grep` миграций на отсутствие `CREATE TABLE .*render_log`). |
| **FF-NO-DUP-SUBSYSTEM** | T-0124 не вводит дублей: ни file-store, ни внешний канал/токен, ни audit-таблица, ни 4-й coherence-механизм. | `grep -REn 'CREATE TABLE' migrations/` для T-0124 ⇒ только `template_def`/`template_dep` (+ опц. join-табл), НЕ `file*`/`*_token`/`render_log`/`external_*`; `template_dep`-гард = расширение `bundle-coherence.sh`, не новый скрипт (член в `bundle_members.txt`). |
| **FF-TEMPLATE-COHERENCE** | Зависимость шаблон↔`field_key` схемы проверяется `checkTemplateDepFields` (зеркало `checkBindingCompat`/`checkReportPageDepFields`); деструктивное изменение поля при активном non-stale dep → default-DENY (`409`), force → `stale` + депромоут + audit. | unit `checkTemplateDepFields` (no-I/O, как `binding-compat.test.ts`); `bundle-coherence.sh` fail при `template_dep.field_key ∉ record_schema.properties`; integration: drop field без force ⇒ `409`, не применяется. |
| **FF-TENANT-SCOPED-RENDER** | Рендер читает только свой tenant; внешний tenant из токена, не из запроса. | integration: cross-tenant `recordRef` в params ⇒ `not_found`/deny (RLS, T-0013); внешний путь — tenant из surface-токена. |
| **FF-LIVE-NO-CACHE** | `live`-рендер не кэшируется: два последовательных `live`-рендера через мутацию отражают новое состояние. | integration (AC-11): render live → mutate record → render live ⇒ второй отличается. |

---

## 7. Traceability (AC → дизайн)

| AC | covered_by |
|---|---|
| AC-1 (операция из живых данных) | §1, §2.2 (вход/выход/RenderMeta), §2.10; FF-RENDER-VIA-PDP, FF-LIVE-NO-CACHE |
| AC-2 (форматы day-1, движок един) | §2.4, §3, §5 rej-1; FF-FORMAT-CLOSED |
| AC-3 (live vs snapshot + операция фиксации) | §2.5 (`renderAndFix`→`addVersion`), §2.2 (детерминизм); FF-SNAPSHOT-IMMUTABLE, FF-REPRODUCIBLE |
| AC-4 (QR через T-0122) | §2.7 (verify/download op-отображение, «валидно» из живых данных); §5 rej-3 |
| AC-5 (право = производность чтения) | §2.3 (resolveFor/projectFields, drop=omit), §5 rej-2/rej-7; FF-NO-RENDER-ACL, FF-NO-MASK-ROW |
| AC-6 (генерация реестра + граница T-0121) | §2.8; FF-NOT-T0121 (в §2.8), FF-NO-MASK-ROW |
| AC-7 (аудит) | §2.6 (три open-vocab type, секрет не пишется); §5 rej-5; FF-AUDIT-EVERY-RENDER |
| AC-8 (шаблон: согласованность/авторинг/версия) | §2.9 (`template_dep`/`checkTemplateDepFields` зеркало T-0072/T-0121, деструктив-дисциплина, config-агент DRAFT+promote, version в RenderMeta); §5 rej-6; FF-TEMPLATE-COHERENCE |
| AC-9 (MVP/Stage-2) | §3 |
| AC-10 (потребляет, не достраивает) | §2.1 (таблица зон), §5 rej-3/4/5/6; FF-NO-DUP-SUBSYSTEM |
| AC-11 (post-impl: живой рендер) | §2.2 детерминизм, §2.10; FF-LIVE-NO-CACHE |
| AC-12 (post-impl: без read-гранта отсутствует) | §2.3; FF-NO-RENDER-ACL, FF-NO-MASK-ROW |
| AC-13 (post-impl: снапшот воспроизводим) | §2.5; FF-SNAPSHOT-IMMUTABLE, FF-REPRODUCIBLE |
| AC-14 (post-impl: аудит) | §2.6; FF-AUDIT-EVERY-RENDER |
| AC-15 (трассируемость + прогон кейсов) | §0 (два кейса), §8 (прогон); ревью-гейт архитектора |

---

## 8. Прогон кейсов (AC-15, требование фаундера)

**QR-кейс (ТЭЛ §5)** — собирается из `document-on-demand` + T-0122 (поверхность) + T-0119 (снапшот) **без** второго механизма:
1. Админ/config-агент создаёт `template_def{format:'html', registry_id:<договоры>, body:<плейсхолдеры статус/№/дата>}`, promote в `published` (§2.9). `template_dep` авто-выведен; `bundle-coherence.sh` зелёный.
2. Поверхность T-0122 `external_surface{ actions:["verify","download"], facet:<статус,№>, doc_mode:'snapshot', max_uses:null }` `[КОНТРАКТ-DONE :388]`; токен в QR (T-0015 handle).
3. `renderAndFix(template, {recordRef}, granter)` фиксирует снапшот (§2.5) → `file_version{is_snapshot:true}`; `doc.snapshot_fixed` (§2.6).
4. Контрагент сканирует → **verify** (T-0122 §2.5): `resolveFor`+`projectFields` отдаёт `{статус:'действует', №}` = «валидно» **из живых данных** (запись существует + статус); скрытые поля (сумма, контрагент) физически отсутствуют (§2.3 drop).
5. **download** (`doc_mode='snapshot'`): `presignGet(file_version)` — байт-идентичный снапшот.
   *Вариант «живой»:* `doc_mode='live'` ⇒ download = `render(...)` сейчас (§2.7), помечен «живой документ».
   → Один примитив рендера, один PDP, один канал (T-0122), одна приёмная поверхность снапшота (T-0119), один аудит. **Ноль дублей.**

**Генерация реестра (ТЭЛ §1):**
1. `template_def{format:'csv', registry_id:<договоры>}`.
2. **Живой реестр сейчас:** `render(template, {filter:{период,статус}}, subject)` (`doc_mode='live'`) → CSV только из видимых субъекту строк (§2.3 per-row PDP; невидимые **отсутствуют**, не прочерк §2.8). `doc.render` (§2.6).
3. **«Прошлые реестры»:** `renderAndFix(...)` на момент закрытия периода → снапшот `file_version{is_snapshot:true}`, воспроизводим (NF-2; FF-REPRODUCIBLE). Изменение `record` потом не меняет снапшот (AC-13).
4. Граница T-0121 (§2.8): это **файл-артефакт**, не UI-страница руководителю. Согласованность шаблон↔поля — общий слой (§2.9), переиспользован.
   → Тот же примитив `render`, тот же PDP, тот же снапшот-механизм. **Ноль второго механизма прав, ноль второго канала, инвариант снапшот↔живой соблюдён.**

---

## 9. Runtime target

**Контейнер dev-стека** (Postgres + Node-ядро + MinIO для T-0119-снапшота), идентично T-0119/T-0122. Новый внешний ресурс не требуется (снапшот пишется в уже-провиженную T-0119-поверхность). Prod-промоут — гейт фаундера (GT-2/GT-4), как весь стек.

---

## 10. Декомпозиция impl (для materialize → coder)

`[НОВАЯ работа]` T-0124 (порядок = FK/зависимости):
1. **Миграция:** `template_def` (tenant-таблица, FORCE RLS, policy, `format` CHECK `{csv,html}`, `tier`), `template_dep` (зеркало `report_page_dep`), занести в `known_tenant_tables.txt` + `bundle_members.txt`. Номер слота — coder (run-seam, следующий свободный).
2. **`src/core/template-compat.ts`:** `checkTemplateDepFields` (чистая, зеркало `binding-compat.ts`) + типы `TemplateDep`/`TemplateDepViolation`.
3. **`src/core/document-render.ts`:** `render(template, params, subject)` — resolve template → batch `resolveFor`+`projectFields` per-record → renderer; `RENDERERS{csv,html}` closed map; `RenderMeta`+`sourceDigest`.
4. **`renderAndFix`:** композиция `render` → `addVersion(isSnapshot=true)` (T-0119-порт) → `doc.snapshot_fixed` audit.
5. **Аудит-эмиссия:** `doc.render`/`doc.render_denied`/`doc.snapshot_fixed` в `audit_event` (T-0016-порт), секрет токена исключён.
6. **Питание T-0122:** реализация `download`(live→render)/`verify`(facet-срез из проекции) хуков, которые T-0122-поверхность вызывает.
7. **Расширение `bundle-coherence.sh`:** `check-template-deps` (`template_dep.field_key ∈ record_schema.properties`) + деструктив-гард (`409`/force/депромоут/audit, зеркало T-0121 §5).
8. **Авторинг:** config-агент (T-0077) `author_template` → DRAFT; human-gated promote.
9. **Тесты:** FF-* (§6) + AC-11..AC-14 (§7).

**Контракт совместимости (architect.md §7):** T-0124 не меняет/не удаляет существующих экспортов; `checkBindingCompat`/`resolveFor`/`projectFields`/`addVersion`/`maskFields` потребляются как есть. Новые символы (`render`, `renderAndFix`, `checkTemplateDepFields`, `RENDERERS`) — аддитивны.
