# ADR · T-0579 — Тип поля «Файл/Вложение»: сквозная разводка примитива в форму/карточку/список

**Status:** ready (no escalation — бэкенд/хранилище/права уже построены; развилки внутри DESIGN; prod-S3 = deploy-time за портом, GT-4)
**Phase:** DESIGN · **Date:** 2026-07-04
**Task:** T-0579 (product=choros, W2/файл)
**Spec consumed:** `docs/specs/T-0579-file-field.spec.md` (status: ready, AC-1..AC-16) · `docs/specs/T-0579.spec.contract.json`
**Реализованный фундамент (ground truth, НЕ переделывать):**
- `docs/design/T-0119-files-attachments.adr.md` — модель `file`/`file_version`, S3-порт, PDP-производность, immutable-версии, retention.
- `migrations/058_files_attachments.sql` — tenant-таблицы `choros.file` + `choros.file_version` (в `known_tenant_tables.txt`).
- `src/core/file-attachment.ts` — `buildObjectKey`, `authorizeFileOp`, `getFileContentUrl` (deny-reasons `no_grant|cross_tenant|not_found|content_erased`), `addVersion`, порты `ObjectStore`/`FileMetaSource`/`FileRecordResolver`.
- `src/adapters/s3-object-store.ts` — `InMemoryObjectStore`/`FsObjectStore`; `src/core/postgres/pgFileStore.ts` — метаданные.
- `src/http/files.ts` (T-0518) — `POST /api/records/:recordId/files`, `GET /api/records/:recordId/files`, `GET /api/files/:fileVersionId/download`; подключено в `src/server.ts` (`registerFileRoutes`, `FsObjectStore` rootDir=`FILE_STORE_ROOT`).
- `src/core/binding-contract-catalog.ts` + `web/src/forms/field-contract.js` — каталог привязок PD-18, **`file`-контракт уже объявлен заглушкой** на обоих слоях.

**Foundation (do NOT contradict):**
- `web/src/screens/apps-schema.js` — `FIELD_TYPES` + `buildRecordSchema`/`parseRecordSchema`, `x-*`-эмит-конвенция (x-money/x-person/x-url/x-date/x-relation/x-rollup/x-multi-select).
- `web/src/screens/records-form.js` — `schemaToFormFields`/`schemaToColumns`/`formatCellValue`/`validateRecordValues`/`recordDataToValues`/`blankRecordValues` (чистый модельный слой).
- `web/src/forms/field-renderer.jsx` — `FieldControl` (единый рендерер; структурные контракты `reference`/`range`/`table` → выделенные компоненты).
- `web/src/forms/field-contract.js` — `resolveFieldContract`/`contractKindForFieldType`/`getBindingContract` (единый catalog-driven dispatch).
- `src/core/record-schema-validator.ts` — `stripXExtensions` generic-стрипает ЛЮБОЙ `x-*` (root + property) до AJV-strict compile → `x-file` уже совместим без правки валидатора.
- `ci/checks/anti-case-lock.sh` (D-064) — денилист кейс-строк; label файл-типа обязан быть generic.

> **Ключевой факт разведки:** объём T-0579 — НЕ backend. Модель, хранилище, права, версии, API-маршруты файлов уже построены (T-0518/T-0201) и работают под PDP. T-0579 = **оживить объявленную-но-неразведённую заглушку контракта `file`** и провести примитив «файл-поле» через СУЩЕСТВУЮЩУЮ таксономию типов до формы/карточки/списка, плюс добавить inline-режим download-маршрута для превью. Ни одной новой permission-строки, ни второго рендерера, ни новой модели хранения.

---

## 1. Context

Карта примитивов §A4: тип «Файл» — единственный **блокер К2** (документооборот); в UI недостижим, потому что `file` **нет в `FIELD_TYPES`**. При этом весь низлежащий механизм есть: контракт `file` объявлен в каталоге привязок (обе стороны), бэкенд `POST/GET/download` работает, права выводятся из записи через PDP T-0021 (`makeFileRecordResolver` → `resolveFor(..., "read"|"update"|"delete")`), tenant-изоляция структурна (ключ `<tenant_id>/…`, RLS на `file`/`file_version`). Заглушка `file` в каталоге — **мёртвая**: `contractKindForFieldType` не имеет `case 'file'`, `resolveFieldContract.structuralKind` не перечисляет `file`, `buildRecordSchema`/`schemaToFormFields` не знают `x-file`, компоненты `FileField` нет.

Задача — типовая для этого продукта: новый тип поля добавляется по **инвариантному паттерну x-*-аннотированного примитива** (как money/person/url/date прошли до нас). Несущий принцип: **переиспользовать, а не размножать** — тот же каталог привязок, тот же `FieldControl`, тот же бэкенд-API. Отклонение от паттерна (параллельный `inputKind`, клиентский file-URL, второй ACL) = регресс корня A (OBLIK/PD-18) или дыра tenant-изоляции.

Развилки внутри DESIGN (решаются здесь, §3): (а) что хранить в `record.data` (versionId vs fileId); (б) inline-превью — query-параметр на download vs отдельный `/preview`-маршрут; (в) резолв имени файла в списке (async-cell vs из листинга); (г) `x-file`-config (пустой объект vs mime/лимит day-1).

---

## 2. Decision

**Тип «Файл» вводится как x-file-аннотированный СТРУКТУРНЫЙ примитив, разведённый через существующий каталог привязок к выделенной компоненте `FileField`, которая говорит ТОЛЬКО с уже-построенными маршрутами файлов. Значение поля в `record.data` — строковый `fileVersionId`. Бэкенд не трогается, кроме добавления inline-режима download-маршрута для превью.**

### 2.1 Слой схемы (round-trip) — `web/src/screens/apps-schema.js`
- `FIELD_TYPES` получает `{ value: "file", label: "Файл" }` (generic label; anti-case). Автоматически попадает в `FIELD_TYPE_VALUES` → `validateField` принимает `file`. **Не** добавляется в `COLLECTION_SUB_FIELD_TYPES` (файл — верхнеуровневый примитив, как relation/computed; depth-cap соблюдён).
- `buildRecordSchema`: ветка `else if (f.type === "file")` эмитит `prop = { type: "string", "x-file": {} }` (пустой config day-1 — расширяемо до `{ mime_allow?: string[], max_bytes?: number }` без ретрофита). Строковый слот — по прямой аналогии `x-person`/`x-url` (значение = строка-идентификатор). Файловое поле МОЖЕТ быть `required` (хранит реальное значение — как person, в отличие от computed).
- `parseRecordSchema`/`schemaToFormFields`: детект `const xFile = def?.["x-file"]` ДО generic-string-fallthrough (порядок как у `x-date`/`x-money`/`x-person`); при наличии → `{ key, type: "file", … }`. Схема без `x-file` не детектится как file (backward-compatible; NF-3).
- Серверный `validateRecordSchemaDefinition` — **без изменений**: `stripXExtensions` уже снимает `x-file` перед AJV-strict compile (§ record-schema-validator.ts §174). AC-5 покрыт существующим кодом.

### 2.2 Слой контракта (единый каталог) — `web/src/forms/field-contract.js`
- `contractKindForFieldType`: `case "file": return "file";`.
- `resolveFieldContract`: `structuralKind` расширяется на `file` (в списке `relation|collection|computed|money|multi-select|person`) → `contractKind:"file"`, `presentation:"file"` (из уже-объявленного `BINDING_CONTRACT_CATALOG.file.defaultPresentation`).
- Каталог `BINDING_CONTRACT_CATALOG.file` (клиент) и `binding-contract-catalog.ts` `file` (сервер) уже существуют — **не дублируются, не переопределяются**; заглушка оживает. Инвариант «один клиентский render-модуль + один серверный каталог» сохранён (field-contract.js §11–18).

### 2.3 Слой рендера формы — `web/src/forms/field-renderer.jsx`
- `FieldControl`: раннее структурное ветвление (рядом с `presentation === 'reference'|'range'|'table'`) добавляет `if (presentation === 'file') return <FileField … />;`. `file` **НЕ** попадает в `isScalarish` (структурный контракт с fetch/состоянием, не inline-input) — заменяет honest-degradation readout, который иначе бы отрисовался.
- `FileField` — новая компонента в `field-renderer.jsx` (или co-located модуль `web/src/forms/file-field.jsx`, импортируемый сюда — как `RelationPickerField`). Пропсы того же контракта: `{ field, value, onChange, error, idPrefix, isRequired, readOnly }`. Поведение:
  - `value` пусто + не readOnly → `<input type="file">` «Загрузить файл»; при выборе → загрузка (§2.4), по успеху `onChange(versionId)`;
  - `value` есть → имя файла (резолв через листинг записи) + «Скачать» (ссылка на `/api/files/:value/download`) + «Заменить» (повторная загрузка → новая версия);
  - `readOnly` → имя + «Скачать», без загрузки/замены;
  - `isRequired` + пусто → визуальная отметка обязательности (валидацию делает `validateRecordValues`, §2.5);
  - honest-states (NF-5): Loading (upload in-flight, disabled), Error (сообщение по reason: `size_exceeded`/`mime_not_allowed`/сеть), Empty (аффорданс загрузки).

### 2.4 Загрузка — ТОЛЬКО через существующий маршрут
`FileField` грузит через `POST /api/records/:recordId/files` (тело = raw bytes выбранного файла, заголовки `Content-Type` = `file.type`, `X-File-Name` = `file.name`). Маршрут атомарно вставляет `choros.file` + первую версию (`addVersion` → `store.put` → `insertVersion` → `setCurrentVersion`) под PDP-`update`-гейтом записи, возвращает `201 { fileId, versionId, versionNo }`. `FileField` кладёт **`versionId`** в значение поля. `recordId` берётся из контекста записи (карточка/форма уже знают, какую запись правят). Замена = повторный `POST` (новая версия; `current_version` переводится в бэкенде). **Фронт не конструирует S3-URL, не пресайнит сам, не знает bucket** (NF-2).

> **Инвариант значения:** храним `fileVersionId` (не `fileId`), потому что download-маршрут адресуется версией (`GET /api/files/:fileVersionId/download`) и карточка обязана показывать КОНКРЕТНУЮ загруженную версию. При замене поле указывает на новую версию (значение обновляется через `onChange`). `fileId` резолвится из версии на бэкенде при необходимости; листинг записи (`GET …/files`) отдаёт `currentVersionId` для сверки.

### 2.5 Модельный слой (значение/валидация) — `web/src/screens/records-form.js`
- `blankRecordValues`/`recordDataToValues`: файловое поле — простая строка (пусто = `""`), ветка как для `person`/`url` (не boolean/collection/multi-select). `computed`-исключение не касается — файл хранит значение.
- `validateRecordValues`: ветка `if (f.type === "file")` — `required` + пусто → ошибка; иначе строка/пусто ок. (AC-8)
- `schemaToColumns`: файловое поле пробрасывается как колонка `{ key, label, type: "file" }` (наследуется из `schemaToFormFields`; никаких доп. пропов, как у money).
- `formatCellValue(value, "file")`: возвращает имя файла (если резолвлено) либо строковый идентификатор как fallback (по паттерну `person`, который отдаёт pre-resolved имя или id) и «—» при пустом. Резолв имени — §2.6.

### 2.6 Карточка + список (отображение имени/превью) — `screen-app-records.jsx` / детальный экран
- **Список:** колонка файла показывает имя файла. Резолв: клетка загружает метаданные записи (`GET /api/records/:recordId/files` уже отдаёт `[{fileId, originalName, currentVersionId, mime, sizeBytes, createdAt}]`) и матчит по значению-`versionId`. Для async-резолва — паттерн `RelationCell`/`RELATION_CELL_ASYNC` (клетка = компонента, которая тянет имя); пустое значение → «—». Никогда не показывать сырой uuid (как `deriveRecordLabel` для relation).
- **Карточка (детальный экран):** файловое поле → имя файла как **ссылка «Скачать»** (`/api/files/:versionId/download`). Для превью-совместимого mime (`image/*`, `application/pdf`) — inline-превью (`<img src>`/`<embed>`/`<iframe src>` на inline-URL `/api/files/:versionId/download?disposition=inline`). mime берётся из листинга метаданных. Прочие mime — только ссылка (без inline).

### 2.7 Inline-режим download-маршрута (единственная backend-добавка) — `src/http/files.ts`
`GET /api/files/:fileVersionId/download` получает опциональный `?disposition=inline`. При нём и ТОЛЬКО для preview-safe mime (`image/*`, `application/pdf` — allowlist в коде маршрута) ответ ставит `Content-Disposition: inline` вместо `attachment`. Всё остальное **неизменно**: тот же PDP-гейт (`getFileContentUrl` → `read` на запись-владельца), тот же tenant/actor-резолв из identity (`resolveActorTenant(actor)`, НЕ header/body), тот же `X-Content-Type-Options: nosniff`, тот же presign/stream. Без параметра или для не-allowlist mime (в т.ч. `image/svg+xml`, `text/html`) → `attachment` как сейчас (анти-XSS: svg/html никогда не inline). Дефолтное поведение и существующие тесты не меняются (аддитивно).

> Тонкое ядро, логика на границах (CONCEPT §5): новый код — фронт-компонента `FileField` + ~10 строк разводки типа в 4 существующих dispatch-точках + inline-ветка в 1 маршруте. Авторизация, хранение, версии, tenant-изоляция — **переиспользуются целиком** без единой новой permission-строки.

---

## 3. Rejected alternatives

| Развилка | Option | Why not |
|---|---|---|
| **Механизм типа** | **Новый параллельный `inputKind`/словарь файлов вне каталога привязок** | Размножение рендереров — ровно антипаттерн, который PD-18/OBLIK устранили (4 клиентских словаря → 1 каталог). `file`-контракт УЖЕ в каталоге (обе стороны) как заглушка; правильно — оживить её через `resolveFieldContract`, а не завести второй путь. FF-CATALOG. |
| **Значение в record.data** | **Встроенный объект `{fileId,name,mime,size}` в record.data** | Дублирует метаданные, которые уже живут в `choros.file_version` (единый источник истины); рассинхронизируется при замене; ломает `x-file→type:"string"` (пришлось бы `type:"object"` + под-схема, чего flat-форма избегает). Строка-идентификатор (как person=id, relation=uuid) + резолв метаданных из листинга = один источник истины. |
| **fileId vs versionId в значении** | **Хранить `fileId` (логический файл)** | download-маршрут и превью адресуются ВЕРСИЕЙ; хранение `fileId` заставило бы клиент отдельно резолвить current_version перед каждым скачиванием и создало бы гонку «какая версия показана». `versionId` = конкретная показанная версия; замена явно двигает указатель через `onChange`. |
| **Загрузка** | **Клиент пресайнит и грузит напрямую в S3/bucket** | Разрывает PDP-инвариант (байты/ключ мимо `authorizeFileOp`), клиент узнаёт bucket/креды, tenant-префикс уходит под дисциплину клиента → дыра изоляции (NF-2). Загрузка ТОЛЬКО через `POST …/files`, который гейтит `update` на запись и строит ключ серверной `buildObjectKey`. |
| **Права файла** | **Клиентский file-ACL / поле видимости файла на фронте** | Второй источник истины «кто видит файл» ≠ «кто видит запись» → leak/тихий отказ. Прямо запрещено T-0018 §2 / T-0021 FF-R6 / NF-2. Видимость = производная записи через уже-подключённый PDP; фронт лишь честно показывает 403/пусто. |
| **Превью** | **Всегда inline-отдача (убрать `attachment`)** | `image/svg+xml`/`text/html`, отданные inline с origin приложения = stored-XSS (svg со скриптом исполнится в контексте сессии). Inline — allowlist `image/*`(кроме svg)/`pdf`; всё прочее — `attachment` + `nosniff`. Дефолт остаётся `attachment` (не ломает текущее). |
| **Превью-маршрут** | **Отдельный `GET /api/files/:id/preview`** | Дублировал бы весь PDP+tenant+stream-код download-маршрута (второй кодпуть авторизации файла — то, чего FF-NOACL избегает). `?disposition=inline` на существующем маршруте = один авторизационный путь, ветвление только в заголовке Content-Disposition. |
| **Хранилище (dev)** | **Поднять MinIO как docker-compose сервис под эту задачу** | Не нужно: бэкенд использует `FsObjectStore` (файловая система, `FILE_STORE_ROOT`), которого достаточно для загрузки/скачивания/превью на dev-стенде. MinIO/prod-S3 — deploy-time за `ObjectStore`-портом (T-0119 §8, GT-4). Добавлять сервис = лишний провижн/сбой-режим вне объёма. |
| **collection sub-field** | **Разрешить файл внутри «Списка строк»** | `stripXExtensions` не рекурсирует в `items.properties` (nested `x-file` сломал бы AJV-strict — тот же запрет, что для nested `x-date`); depth-cap=1 как relation/computed. Файл-в-коллекции = отдельная задача при необходимости. |

---

## 4. Object model & contracts

> Новых сущностей БД НЕТ. `choros.file`/`choros.file_version` уже существуют (T-0119/058). Ниже — schema-контракт файлового поля и сигнатуры фронт/маршрут-разводки (единый источник полей для `coder`/`tester`).

### 4.1 Файловое поле в `record_schema` (эмит-контракт, PINNED)
```jsonc
// в registry_def.record_schema.properties[<ключ>]:
{ "type": "string", "x-file": {}, "title": "<label>" }
// day-1 config пуст; расширяемо (без ретрофита, additive):
// "x-file": { "mime_allow"?: ["image/*","application/pdf"], "max_bytes"?: 26214400 }
// значение в record.data[<ключ>] = fileVersionId (string) | "" (пусто)
```

### 4.2 In-memory дескриптор поля (records-form / apps-schema)
| Field | Type | Note |
|---|---|---|
| `type` | `"file"` | редакторный тип; в `FIELD_TYPES`/`FIELD_TYPE_VALUES` |
| `key` | `string` | ключ поля (FIELD_KEY_RE) |
| `title`/`label` | `string` | «Договор» и т.п. (пользовательский, не кейс) |
| `required` | `boolean` | файл-поле может быть обязательным |
| (значение) | `string` | `fileVersionId` в `record.data`; пусто = `""` |

### 4.3 Контракты (сигнатуры — coder реализует; форма зафиксирована)
```jsonc
// apps-schema.js
FIELD_TYPES += { value: "file", label: "Файл" }
buildRecordSchema:  f.type==="file"  → { type:"string", "x-file":{}, title }
schemaToFormFields: def["x-file"] present → { key, type:"file", label, required }

// field-contract.js
contractKindForFieldType("file") === "file"
resolveFieldContract({type:"file"}) === { contractKind:"file", presentation:"file", editable:true }

// field-renderer.jsx  (единый рендерер — новая структурная ветка)
FieldControl: presentation==="file" → <FileField {field,value,onChange,error,idPrefix,isRequired,readOnly} />
// FileField использует ТОЛЬКО:
//   POST /api/records/:recordId/files  (body=bytes, headers: Content-Type=mime, X-File-Name=name) → 201 {fileId,versionId,versionNo}
//   GET  /api/records/:recordId/files  → [{fileId, originalName, currentVersionId, mime, sizeBytes, createdAt}]
//   GET  /api/files/:versionId/download[?disposition=inline]

// records-form.js
validateRecordValues: f.type==="file" && required && value==="" → error[key]
formatCellValue(value,"file") → resolved originalName | "—"

// src/http/files.ts  (единственная backend-правка — inline-ветка)
GET /api/files/:fileVersionId/download?disposition=inline
  → если version.mimeType ∈ {image/* (кроме svg), application/pdf} : Content-Disposition: inline
  → иначе : Content-Disposition: attachment
  (PDP getFileContentUrl, tenant/actor из identity, nosniff — БЕЗ изменений)
```

### 4.4 Авторизационная последовательность (наследуется, не переписывается)
1. Загрузка: `POST …/files` → `resolveActorTenant(actor)` (identity) → `addVersion` под `authorizeFileOp(... "update")` PDP по записи → `store.put(buildObjectKey(tenantId,…))`. Deny → 4xx, 0 записи.
2. Скачивание/превью: `GET …/download[?inline]` → `getFileContentUrl` → PDP `read` по записи → presign/stream. Deny reasons `no_grant|cross_tenant|not_found|content_erased` (без новых). Cross-tenant → до S3 (FF-FAILCLOSED).
3. Фронт никогда не обходит эти маршруты.

---

## 5. Build plan & что defers

**BUILD (coder):**
- `web/src/screens/apps-schema.js` — `FIELD_TYPES += file`; `buildRecordSchema` file-ветка (`x-file`); `parseRecordSchema`/`schemaToFormFields` `x-file`-детект.
- `web/src/forms/field-contract.js` — `contractKindForFieldType` `case file`; `resolveFieldContract` `structuralKind += file`.
- `web/src/forms/field-renderer.jsx` (+ возможно `file-field.jsx`) — `FileField` компонента + `presentation==='file'` ветка в `FieldControl`.
- `web/src/screens/records-form.js` — `validateRecordValues`/`blankRecordValues`/`recordDataToValues` file-ветки; `formatCellValue` `type==='file'`.
- `web/src/screens/screen-app-records.jsx` (+ детальный экран) — файл-клетка в списке (имя/async-резолв) + файл-блок в карточке (ссылка + inline-превью).
- `src/http/files.ts` — `?disposition=inline` ветка (allowlist mime) в download-маршруте.
- Тесты: `apps-schema.test.js`/`records-form.test.js` (round-trip, contract, validate — AC-1..AC-5,AC-8,AC-10), компонентный/e2e для `FileField` (AC-6,AC-7,AC-9), маршрут-тест inline+PDP+cross-tenant (AC-11,AC-12,AC-13), UX-journey (AC-15), anti-case-lock (AC-14).

**Defers (НЕ здесь):** UI истории версий/отката; ретенция/архивация из UI + sweeper; document-on-demand генерация (T-0124); файл-в-коллекции; prod-S3-провайдер (GT-4); MinIO-сервис; антивирус/thumbnails/полнотекст.

---

## 6. Fitness functions (CI gating)

`gating`: **static-now** = лайнт/тип-чек/юнит в `npm run ci`; **ux-gate** = `ci/checks/ux/*` / e2e ux-journey; **live-api** = маршрут-проба на live-стеке (Postgres+FsObjectStore).

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-FIELDTYPE** | `file` — первоклассный тип: `FIELD_TYPES` содержит `{value:"file"}`, `FIELD_TYPE_VALUES.includes("file")`, `validateField` принимает file. | `vitest run web/src/screens/apps-schema.test.js -t "file"`: assert FIELD_TYPES entry + validateField no error. (AC-1) | static-now |
| **FF-XFILE-ROUNDTRIP** | Round-trip x-file: `buildRecordSchema` file→`{type:"string","x-file":…}`; `schemaToFormFields`/`schemaToColumns` `x-file`→`type:"file"`; поле без x-file не детектится как file. | `vitest run` apps-schema/records-form tests: build→parse идентичность типа; negative без x-file. (AC-2,AC-3) | static-now |
| **FF-CATALOG** | Единый каталог, не размножение: `contractKindForFieldType("file")==="file"`, `resolveFieldContract({type:"file"}).presentation==="file"`; НЕТ нового `inputKind`-словаря файлов (grep: файл-dispatch идёт через `resolveFieldContract`, не через bespoke switch в screen-app-records/field-renderer вне каталога). | `vitest run` field-contract test + `grep` guard: нет второго file-dispatch-словаря. (AC-4) | static-now |
| **FF-SCHEMA-VALID** | Файловое поле проходит серверный AJV-strict (generic x-strip): `validateRecordSchemaDefinition({type:"object",properties:{f:{type:"string","x-file":{}}}}).valid===true`. | `vitest run` record-schema-validator test с x-file property. (AC-5) | static-now |
| **FF-RENDER-FILE** | `FieldControl` при `presentation:'file'` рендерит `FileField` (не readout, не text-input). | компонентный тест: render FieldControl с file-полем → присутствует file-контрол (input[type=file] или его wrapper), отсутствует «пока заполняется в другом месте». (AC-6) | static-now |
| **FF-UPLOAD-ROUTE-ONLY** | Загрузка ТОЛЬКО через `POST /api/records/:recordId/files`: `FileField`/фронт не содержит прямых S3/bucket/presign-вызовов, не строит object_key. | `grep` guard в web/src: нет `s3://`/`bucket`/`presign`/`PutObject`/aws-sdk в клиенте; upload идёт на `/api/records/.*/files`. (NF-2/FR-7) | static-now |
| **FF-VALUE-STRING** | Значение файл-поля — строка-идентификатор: `validateRecordValues` для required-file+пусто → ошибка; непусто = строка; `blankRecordValues` file → `""`. | `vitest run` records-form test file branches. (AC-8) | static-now |
| **FF-CELL-NO-UUID** | Список/карточка не показывают сырой uuid: `formatCellValue(v,"file")` → имя или «—», никогда голый uuid; карточка резолвит имя из листинга. | `vitest run` formatCellValue test + компонентный тест карточки. (AC-9,AC-10) | static-now |
| **FF-INLINE-SAFE** | Inline только для safe-mime: `?disposition=inline` даёт `Content-Disposition:inline` для `image/*`(не svg)/`application/pdf`; svg/html/прочее → `attachment`; всегда `nosniff`; PDP-`read` и tenant/actor-из-identity сохранены; без параметра — attachment (регресс существующих тестов зелёный). | маршрут-тест: inline для png/pdf, attachment для svg/html/txt; deny без гранта; дефолт attachment. (AC-11) | static-now + live-api |
| **FF-DERIVED-AUTHZ** | Права файла = производная записи (регресс): субъект без `read` на запись → 403 download/inline, 0 байт; с `read` — контент. Тот же PDP T-0021. | существующая file-attachment проба + inline-вариант. (AC-12) | live-api |
| **FF-CROSS-TENANT** | Cross-tenant недостижим (регресс): файл записи tenant B из контекста tenant A → `cross_tenant`/404, 0 байт; фронт не конструирует cross-tenant путь. | существующая cross-tenant file проба, покрывает inline-маршрут. (AC-13) | live-api |
| **FF-ANTICASE** | D-064: ни одной кейс-строки денилиста в добавленном/изменённом `src/`+`web/src/`; label файл-типа = «Файл». | `bash ci/checks/anti-case-lock.sh` зелёный. (AC-14) | static-now |
| **FF-UX-FILE** | UX honest-gate G1–G7: файл-контрол имеет Empty/Loading/Error, контраст ≥ WCAG AA (обе темы), нет мёртвых enabled-аффордансов («Скачать» без файла отсутствует/disabled), `data-theme`-совпадение, нет дев-жаргона, слой/kit без хардкода цветов. | `ci/checks/ux/*` + `e2e/journeys/*.ux.journey.ts` для файл-поля. (AC-15) | ux-gate |
| **FF-BACKCOMPAT** | Наборы полей без файловых полей и схемы до T-0579 не меняют поведения (файл детектится только по x-file). | существующий apps-schema/records-form test-корпус зелёный без правок ожиданий не-file кейсов. (NF-3) | static-now |

---

## 7. Traceability (FR/AC → design)

| AC / FR | covered_by |
|---|---|
| AC-1 / FR-1 | §2.1 (FIELD_TYPES += file); FF-FIELDTYPE |
| AC-2 / FR-2 | §2.1 (buildRecordSchema x-file); §4.1; FF-XFILE-ROUNDTRIP |
| AC-3 / FR-2 / NF-3 | §2.1 (schemaToFormFields x-file детект, backward-compat); FF-XFILE-ROUNDTRIP, FF-BACKCOMPAT |
| AC-4 / FR-3 / NF-1 | §2.2 (contractKindForFieldType/resolveFieldContract, каталог оживает); §3 (rejected: параллельный inputKind); FF-CATALOG |
| AC-5 | §2.1 (generic x-strip, валидатор не трогается); §4 (record-schema-validator §174); FF-SCHEMA-VALID |
| AC-6 / FR-4 | §2.3 (FieldControl presentation:file → FileField); §4.3; FF-RENDER-FILE |
| AC-7 / FR-4 | §2.4 (загрузка через POST …/files, versionId в значении); §4.3/§4.4; FF-UPLOAD-ROUTE-ONLY |
| AC-8 | §2.5 (validateRecordValues file-ветка); §4.2; FF-VALUE-STRING |
| AC-9 / FR-5 | §2.6 (карточка: имя-ссылка + inline-превью safe-mime); FF-CELL-NO-UUID, FF-INLINE-SAFE |
| AC-10 / FR-6 | §2.5/§2.6 (schemaToColumns + formatCellValue + async-cell); FF-CELL-NO-UUID |
| AC-11 / FR-8 | §2.7 (inline-режим маршрута, allowlist, PDP/tenant/nosniff сохранены); §3 (rejected: всегда inline / отдельный /preview); FF-INLINE-SAFE |
| AC-12 / FR-7 / NF-2 | §2.4/§4.4 (PDP-производность, download-гейт); §3 (rejected: client file-ACL); FF-DERIVED-AUTHZ |
| AC-13 / FR-9 / NF-2 | §2.7/§4.4 (tenant/actor из identity, cross_tenant до S3); FF-CROSS-TENANT |
| AC-14 / FR-9 / NF-6 | §2.1 (generic label «Файл»); FF-ANTICASE |
| AC-15 / NF-5 | §2.3 (FileField honest-states); FF-UX-FILE |
| AC-16 | §3 (все rejected обоснованы против инвариантов); §6 (FF-CATALOG/FF-UPLOAD-ROUTE-ONLY/FF-DERIVED-AUTHZ гарантируют отсутствие второго механизма/рендерера); ревью-гейт архитектора |

---

## 8. Compatibility notes (architect rule 7)

- **Оживляет, не меняет, каталог привязок PD-18.** `file`-контракт уже объявлен в `binding-contract-catalog.ts` (`BindingContractKind`, `BINDING_CONTRACT_KINDS`) и `field-contract.js` (`BINDING_CONTRACT_CATALOG.file`) — T-0579 разводит его в `contractKindForFieldType`/`resolveFieldContract`, не добавляя нового kind и не трогая существующие. Клиент/сервер остаются синхронны (оба уже несут `file`).
- **Реализует, не меняет, T-0021/T-0119/T-0518.** Файл-авторизация переиспользует `makeFileRecordResolver`/`getFileContentUrl`/`addVersion` и reason-union `no_grant|cross_tenant|not_found|content_erased` verbatim; новых permission-функций/reasons/таблиц НЕТ. Маршруты `POST/GET/download` не переписываются — download получает аддитивную inline-ветку (дефолт неизменен).
- **Honors record-schema-validator (T-0444/T-0510).** `x-file` покрыт существующим generic `stripXExtensions` (root+property) — валидатор не правится; `x-file` персистится и возвращается as-is, как `x-money`/`x-relation`.
- **Honors T-0013/T-0115.** Ни одной новой tenant-таблицы; `file`/`file_version` уже в `known_tenant_tables.txt`. Изменений фикстуры нет.
- **Public-поверхность:** новые экспорты — `FileField` (компонента) и file-ветки чистых функций; существующие сигнатуры `buildRecordSchema`/`schemaToFormFields`/`resolveFieldContract`/`formatCellValue`/`FieldControl` расширяются аддитивно (новый case), их контракт для существующих типов не меняется → замороженные тесты не ломаются.

---

## 9. Runtime target

**Дев-стек / контейнер.** Метаданные — Postgres-в-compose (уже провижн). Контент файлов — **`FsObjectStore`** (файловая система контейнера, `FILE_STORE_ROOT`, дефолт `/app/uploads`) — уже подключён в `src/server.ts`; **достаточно для загрузки/скачивания/превью** на dev-стенде. Фронт — Vite/React (`web/`), собирается в тот же образ.

**MinIO-сервис в compose НЕ требуется** для этой задачи (dev-контент живёт на ФС; MinIO/S3 — prod-деталь за `ObjectStore`-портом).

**Развилка уровня фаундера (deploy-time, НЕ здесь):** prod-S3-провайдер (AWS/Yandex/MinIO self-hosted) + 152-ФЗ-локация + оплата — гейт GT-4 (T-0119 §8), инъектируется как адаптер+env, не меняет ядро/фронт. `FILE_STORE_ROOT` на dev эфемерен (том/рестарт) — приемлемо для стенда; долговечность prod-хранилища = тот же GT-4.

## 10. Escalation

None. Бэкенд/модель/права/хранилище — данность (T-0119/T-0518). Объём — фронт-разводка объявленного примитива + аддитивный inline-режим маршрута; все четыре DESIGN-развилки решены (§3). Единственная развилка уровня фаундера (prod-S3) вынесена за `ObjectStore`-порт как deploy-time параметр (GT-4), не блокирует impl (dev=FsObjectStore). Высоколеверажности/кросс-вендор-петли нет — это доведение существующего примитива до пользователя строго по инвариантному паттерну продукта.
