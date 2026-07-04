# Spec · T-0579 — Тип поля «Файл/Вложение»: сквозная интеграция примитива в форму/карточку/список

**Status:** ready
**Phase:** SPEC (impl-задача W2 · продукт=choros)
**Date:** 2026-07-04
**Task:** T-0579 ([W2/файл] тип поля «Файл/Вложение»)
**spec_ref:** `demiurge/docs/choros-primitives-map-2026-07-02.md` §A4 (A4 Файл/Вложение — ⛔ нет в FIELD_TYPES и схеме, блокер К2) + дизайн T-0119 (готов).
**business_summary:** [столп 3] [кейс К2: документооборот — договор как файл на записи] Без типа «Файл» кейс К2 несобираем из UI.

## 0. Ground truth разведки кода (НЕ верь только докам — проверено на ветке)

Разведка `src/` и `web/src/` вскрыла картину, отличную от буквального ТЗ («реализации нет»):

**Бэкенд + HTTP API файлов уже ПОСТРОЕН и подключён** (доставлено T-0518/T-0201, не T-0579):
- Миграция `migrations/058_files_attachments.sql` — tenant-таблицы `choros.file` + `choros.file_version` (T-0013-контракт, FORCE RLS, занесены в `ci/checks/known_tenant_tables.txt`).
- `src/core/file-attachment.ts` — `buildObjectKey`, `authorizeFileOp`, `getFileContentUrl`, `addVersion`, порт `ObjectStore`, `FileRecordResolver` (авторизация делегирована PDP T-0021 через `makeFileRecordResolver` в `grant-resolver.ts` — FF-NOACL соблюдён).
- `src/adapters/s3-object-store.ts` — `InMemoryObjectStore` + `FsObjectStore` (dev-стенд без S3-SDK); `src/core/postgres/pgFileStore.ts` — метаданные.
- `src/http/files.ts` — маршруты **`POST /api/records/:recordId/files`** (raw-body upload, заголовки `Content-Type`→mime, `X-File-Name`→имя, лимит 25 МиБ, 201 `{fileId, versionId, versionNo}`), **`GET /api/records/:recordId/files`** (листинг метаданных записи), **`GET /api/files/:fileVersionId/download`** (PDP read-gated, стрим с `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, presign TTL 300с). Подключено в `src/server.ts` (`registerFileRoutes`, `FsObjectStore` rootDir=`FILE_STORE_ROOT`).

**Что РЕАЛЬНО отсутствует (и есть настоящий объём T-0579):** тип поля «Файл» **не подключён к таксономии типов полей** и, следовательно, недостижим из продукта:
- `web/src/screens/apps-schema.js` `FIELD_TYPES` (стр. 107–122) **НЕ содержит** `file` (проверено: `grep -c '"file"'` = 0) → конструктор поля не предлагает тип «Файл».
- `x-file`-аннотации **нет нигде** в `records-form.js`/`apps-schema.js` (проверено: 0 вхождений) → `buildRecordSchema`/`schemaToFormFields` не эмитят и не распознают файловое поле.
- Компонента `FileUploadField`/`FileField` **не существует** (проверено: 0 вхождений) → `field-renderer.jsx` не умеет рисовать загрузку/превью.
- Контракт `file` в каталоге привязок **уже объявлен как заглушка** на обоих слоях (`src/core/binding-contract-catalog.ts` `BindingContractKind` включает `"file"`; `web/src/forms/field-contract.js` `BINDING_CONTRACT_CATALOG.file` есть), но **не разведён** ни в `contractKindForFieldType`, ни в `resolveFieldContract` (`structuralKind`-ветка `file` не перечисляет) → мёртвая заглушка.

**Вывод по объёму:** T-0579 = **сквозное подключение примитива «файл-поле» к СУЩЕСТВУЮЩЕЙ таксономии типов и единому рендереру форм** поверх готового бэкенда, плюс режим **inline-превью** в карточке (маленькая добавка к готовому download-маршруту). НЕ создаём: ни новую модель хранения, ни второй механизм прав, ни параллельный рендерер.

## 1. Summary

Тип поля «Файл/Вложение» становится **первоклассным типом** в конструкторе набора полей: владелец добавляет поле типа «Файл» так же, как «Сумма»/«Дата»/«Сотрудник». Поле эмитится в `record_schema` как `{ type: "string", "x-file": {…} }` (та же `x-*`-конвенция, что `x-money`/`x-person`/`x-url`; бэкенд AJV-валидатор уже generic-стрипает любые `x-*`). В форме записи поле рендерится единым рендерером (`FieldControl` → `presentation:'file'` → выделенная компонента `FileField`) как контрол «загрузить/заменить файл»; загрузка идёт на существующий `POST /api/records/:recordId/files`, а в `record.data[<ключ>]` хранится **строковая ссылка на файл** (`fileVersionId` — тот же паттерн, что person хранит id, relation хранит uuid). В карточке записи поле показывает имя файла как ссылку «скачать» и **inline-превью** для картинок/PDF; в списке — колонку с именем/иконкой файла (или «—»). Все чтения/скачивания проходят PDP-контроль записи-владельца (уже реализованный `getFileContentUrl`); tenant-изоляция файлов уже структурна (ключ `<tenant_id>/…`). Кросс-тенант доступ = P0-запрет, обеспечен готовым бэкендом — задача обязана **не разорвать** его (использовать identity-резолв tenant/actor маршрутов, не header/body-аргумент).

## 2. Функциональные требования

### FR-1 — «Файл» в таксономии типов полей (конструктор)
`FIELD_TYPES` (`apps-schema.js`) получает запись `{ value: "file", label: "Файл" }`; `FIELD_TYPE_VALUES`/`validateField` принимают `file` как валидный тип. Тип «Файл» доступен в редакторе поля наравне с другими; НЕ является collection-sub-field (глубина как у relation/computed — верхнеуровневый).

### FR-2 — Эмит/парс схемы (round-trip, `x-file`)
`buildRecordSchema` эмитит файловое поле как `{ type: "string", "x-file": {…} , title }` (по конвенции `x-person`/`x-url`; значение в `record.data` — строка). `schemaToFormFields` (и `schemaToColumns`) распознаёт `x-file` и восстанавливает `type: "file"` (детект ДО generic-string-fallthrough, как `x-date`/`x-money`). Поле переживает save→reload. `x-file`-config (при наличии, напр. allowlist mime/лимит) — сериализуемый объект; отсутствие config = базовый файл-контрол (backward-compatible).

### FR-3 — Разводка контракта `file` (единый каталог привязок)
`contractKindForFieldType('file') → 'file'` и `resolveFieldContract` классифицирует `type:'file'` как структурный контракт (`structuralKind`) → `presentation:'file'`. Клиентский `field-contract.js` и серверный `binding-contract-catalog.ts` остаются синхронны (оба уже объявляют `file` — заглушка оживает, второй каталог НЕ вводится).

### FR-4 — Рендер в форме записи (единый рендерер, не параллельный)
`FieldControl` (`field-renderer.jsx`) для `presentation:'file'` рисует выделенную компоненту `FileField` (по паттерну `RelationPickerField`/`CollectionField` — структурный контракт с fetch/локальным состоянием, а не inline-scalar). `FileField`:
- если значение пусто → контрол «Загрузить файл» (`<input type="file">`), при выборе → `POST /api/records/:recordId/files` (raw body, `Content-Type`=mime, `X-File-Name`=имя), по 201 сохраняет `versionId` (или `fileId`) в значение поля через `onChange`;
- если значение есть → показывает имя загруженного файла + действия «Скачать» и «Заменить» (замена = новая загрузка → новая версия через тот же POST/`addVersion`);
- поддерживает `readOnly` (шаг read-only / карточка) и `required` (обязательное поле не заполнено → ошибка валидации);
- честные состояния: загрузка (progress/disabled), ошибка (превышен лимит/тип/сеть — сообщение), пусто (аффорданс загрузки).

### FR-5 — Отображение в карточке записи + inline-превью
Карточка записи (детальный экран) для файлового поля показывает **имя файла как ссылку «скачать»** (не сырой uuid). Для превью-совместимых типов (изображение `image/*`, `application/pdf`) карточка показывает **inline-превью** (`<img>`/`<embed>`/`<iframe>` на inline-URL). Превью требует режима **inline-disposition** у download-маршрута (сейчас маршрут всегда `Content-Disposition: attachment` — форсирует скачивание, картинку не покажет). См. FR-8.

### FR-6 — Колонка в списке записей
Реестр записей (`screen-app-records.jsx` через `schemaToColumns`/`formatCellValue`) рендерит файловое поле как колонку: имя файла (ссылка) либо «—» при отсутствии. Резолв имени по значению (fileVersionId → метаданные) — как relation резолвит label (`RELATION_CELL_ASYNC`-паттерн) ИЛИ синхронно, если имя доступно из уже загруженного листинга. Колонка не роняет таблицу при пустом значении.

### FR-7 — Права = производная прав записи (НЕ второй механизм)
Ни один фронт-путь не обходит PDP: загрузка/листинг/скачивание идут ТОЛЬКО через существующие `/api/records/:recordId/files` и `/api/files/:id/download`, которые уже гейтят через `makeFileRecordResolver` (PDP T-0021 по записи-владельцу). Фронт НЕ конструирует S3-URL, НЕ обращается к bucket напрямую, НЕ вводит клиентского file-ACL. Субъект без `read` на запись не видит/не скачивает её файлы (обеспечено бэкендом; фронт обязан честно показать 403/пусто).

### FR-8 — Inline-disposition для превью (добавка к download-маршруту)
`GET /api/files/:fileVersionId/download` получает опциональный режим inline-выдачи (напр. `?disposition=inline` или отдельный `/preview`-маршрут), отдающий `Content-Disposition: inline` для превью-совместимых mime (`image/*`, `application/pdf`) при СОХРАНЕНИИ той же PDP-проверки, `X-Content-Type-Options: nosniff` и tenant-резолва. Дефолт (без параметра) — `attachment` (без изменения текущего поведения/тестов). Никакой другой mime не отдаётся inline (защита от XSS через html/svg-контент — svg/html → attachment).

### FR-9 — Tenant-изоляция и anti-case (сохранить, не разорвать)
Задача не ослабляет tenant-изоляцию: все маршруты продолжают резолвить tenant/actor из identity (не из header/body). Никакого кейс-контента (D-064): в `FIELD_TYPES`/`FileField`/схема — только generic-примитив «файл-поле» (label «Файл»), ни слагов, ни персон, ни бизнес-имён кейса К2. Кейс живёт в seed.

## 3. Нефункциональные требования

- **NF-1 — Единый рендерер, не размножение.** Файл-поле дисpatchится через тот же каталог привязок (`resolveFieldContract`) и тот же `FieldControl`, что relation/collection/money — НЕ через параллельный `inputKind`-словарь (иначе регресс корня A OBLIK/PD-18).
- **NF-2 — Единый механизм прав (несущий).** Ноль клиентских file-ACL; видимость/скачивание файла = производная права записи через уже-подключённый PDP-бэкенд. Один cross-tenant leak файла = смерть GTM (tenancy §5).
- **NF-3 — Backward-compatible round-trip.** Наборы полей БЕЗ файловых полей не меняют поведения; схемы, сохранённые до T-0579, парсятся как прежде (файл детектится только по `x-file`).
- **NF-4 — Пропорциональность (ось 5).** Переиспользует готовый бэкенд/API/PDP/хранилище; новый код — только фронт-компонента + разводка типа + inline-режим маршрута. Не переизобретает модель файлов (T-0119).
- **NF-5 — UX honest-gate (D-062/OBLIK).** Файл-контрол имеет Empty/Loading/Error состояния; контраст ≥ WCAG AA в обеих темах; нет мёртвых enabled-аффордансов (кнопка «Скачать» без файла отсутствует/disabled); бейдж ≡ контент; нет дев-жаргона; потребление слоя/kit без хардкода цветов.
- **NF-6 — Anti-case (D-064).** Ни одной кейс-строки денилиста карты §5 в добавленном/изменённом коде (`src/`, `web/src/`); label — generic «Файл».
- **NF-7 — Egress-граница (наследуется).** `file_version.data_class` уже фиксирует классификацию; если превью/контент уходит агенту — граница egress T-0041 (runtime-гейт Stage-2). Фронт-задача её не двигает, но и не обходит.

## 4. Out of Scope (явные не-цели T-0579)

1. **Модель хранения файлов, S3-адаптер, presign, миграция метаданных** — доставлено (T-0119 дизайн → T-0518/T-0201 impl). НЕ переделывается.
2. **Второй механизм прав / file-ACL** — запрещён (NF-2); PDP-производность уже есть.
3. **Prod-S3-провайдер (AWS/Yandex/MinIO self-hosted) и его оплата/152-ФЗ** — deploy-time параметр за `ObjectStore`-портом, гейт фаундера GT-4 (T-0119 §8). Dev = `FsObjectStore` достаточно.
4. **Версионирование как UI-история версий** (список версий, откат) — базовая замена создаёт новую версию (уже в `addVersion`), но экран истории версий — Stage-2/отдельная задача.
5. **Ретенция/архивация файлов из UI** (перевод в archived/pending_deletion, sweeper) — Stage-2 (T-0119 FR-6).
6. **Автонумерация / скаляр-формулы / другие A-примитивы карты** (A8/A9) — отдельные задачи.
7. **Антивирус-скан, полнотекст, thumbnails-генерация** — не MVP (T-0119 out-of-scope §6).
8. **Файл как sub-field коллекции** (файл внутри «Списка строк») — depth-cap как у relation/computed; не в этой задаче.
9. **document-on-demand снапшот (`is_snapshot`)** — приёмная поверхность есть в бэкенде; UI генерации — T-0124.
10. **MinIO как docker-compose сервис** — dev использует `FsObjectStore` (файловая система), MinIO-сервис не требуется для этой задачи (см. ADR runtime_target).

## 5. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| **AC-1** | `FIELD_TYPES` (`web/src/screens/apps-schema.js`) содержит запись со `value:"file"` и непустым `label`; `FIELD_TYPE_VALUES.includes("file")`; `validateField({key,type:"file",…})` НЕ ставит `errors.type`. | test |
| **AC-2** | `buildRecordSchema([{key:"doc",type:"file",title:"Договор"}])` эмитит `properties.doc = { type:"string", "x-file":{…}, title:"Договор" }` (строковый слот, x-file-аннотация присутствует). | test |
| **AC-3** | `schemaToFormFields`/`schemaToColumns` на схеме с `{type:"string","x-file":{…}}` восстанавливают поле с `type:"file"` (round-trip save→reload сохраняет тип); поле без `x-file` НЕ детектится как file (backward-compatible). | test |
| **AC-4** | `contractKindForFieldType("file") === "file"`; `resolveFieldContract({type:"file"}).contractKind === "file"` и `.presentation === "file"`. | test |
| **AC-5** | `record_schema` с файловым полем (`{type:"string","x-file":…}`) проходит серверный `validateRecordSchemaDefinition` (AJV-strict) валидным (generic x-strip уже покрывает x-file) — сохранение набора полей с файловым полем не отклоняется. | test |
| **AC-6** | Компонента `FileField` существует и `FieldControl` при `presentation:'file'` рендерит именно её (не generic «пока заполняется в другом месте» readout, не text-input). | test |
| **AC-7** | В форме записи: выбор файла → `POST /api/records/:recordId/files` с raw-body, `X-File-Name`=имя, `Content-Type`=mime; по 201 значение поля = возвращённый идентификатор (versionId/fileId) строкой; повторная загрузка = замена (новая версия). | test (компонентный/e2e с mock/live API) |
| **AC-8** | Обязательное файловое поле без значения → `validateRecordValues` возвращает ошибку по ключу; необязательное пустое → без ошибки; сохранённое значение — строка. | test |
| **AC-9** | Карточка записи для файлового поля показывает имя файла как ссылку «скачать» (не сырой uuid) и, для `image/*`/`application/pdf`, inline-превью; для прочих mime — только ссылку. | test / manual (UX) |
| **AC-10** | Список записей: `formatCellValue(value,"file")` возвращает имя файла/иконку (не uuid) при наличии значения и «—» при отсутствии; колонка присутствует в `schemaToColumns`. | test |
| **AC-11** | `GET /api/files/:fileVersionId/download?disposition=inline` (или `/preview`) отдаёт `Content-Disposition: inline` + `X-Content-Type-Options: nosniff` ТОЛЬКО для `image/*`/`application/pdf` при пройденном PDP-`read`; без параметра — `attachment` как прежде; svg/html → attachment (не inline). Tenant/actor резолвятся из identity. | test |
| **AC-12** | Субъект без `read`-гранта на запись-владельца получает 403 при `GET /api/files/:id/download` (и inline), 0 байт; с грантом — контент. (PDP-производность; уже покрыто бэкендом — задача не разрывает.) | test (регресс существующего FF) |
| **AC-13** | Попытка скачать файл записи tenant B из контекста tenant A → отказ (`cross_tenant`/404), 0 байт; фронт не конструирует cross-tenant путь. | test (регресс) |
| **AC-14** | Anti-case (D-064): `bash ci/checks/anti-case-lock.sh` зелёный после изменений; в добавленном/изменённом коде нет кейс-строк денилиста; label файл-типа = «Файл» (generic). | fitness |
| **AC-15** | UX honest-gate (D-062): файл-контрол проходит G1–G7 — Empty/Loading/Error присутствуют, контраст ≥ WCAG AA (обе темы), нет мёртвых enabled-аффордансов, `data-theme`-совпадение, нет дев-жаргона; реализация через слой/kit, не хардкод цветов. | fitness (`ci/checks/ux/*` / e2e ux-journey) |
| **AC-16** | Трассируемость: каждое FR-1..FR-9 покрыто ≥1 решением ADR (таблица AC→design); ни одно решение не вводит второй permission-подсистемы/параллельный рендерер и не ослабляет tenant-изоляцию (ревью-гейт архитектора). | manual |

## 6. Снятые неоднозначности (резолюции без эскалации)

- **Бэкенд/хранилище/права/версии/ретенция** — закрыты T-0119 (S3-порт, PDP-производность, immutable-версии, retention-state) и уже реализованы (T-0518). Не переоткрываются.
- **Значение в `record.data`** — строка-идентификатор файла (`x-file` → `type:"string"`), по прямой аналогии с person (id), relation (uuid), url (строка). Конкретно `fileVersionId` vs `fileId` — деталь DESIGN (FR-2/FR-4), не меняет продуктовый объём (оба резолвятся в имя/download через существующие маршруты).
- **Превью vs скачивание** — обе поверхности нужны (FR-5/FR-8); inline только для безопасных mime (image/pdf), прочее — attachment. Точный механизм (query-параметр vs отдельный `/preview`) — DESIGN.
- **Резолв имени файла в списке** (async-cell vs из листинга) — DESIGN (FR-6), обе опции совместимы; выбор не меняет объём.

**Blocking questions:** нет. Бэкенд, хранилище, права, модель — данность (T-0119/T-0518). Объём T-0579 — фронт-интеграция примитива + inline-режим маршрута, все развилки внутри зоны DESIGN. Статус спеки = `ready`.
