# ADR · T-0119 — Файлы/вложения: S3-совместимое хранилище + модель файл↔запись

**Status:** ready (no escalation — провайдер S3 вынесен в deploy-time параметр; локальный дев-стек = MinIO, в рамках автономии)
**Phase:** DESIGN · **Date:** 2026-06-11
**Task:** T-0119 (product=choros, type=design, prio 60)
**Spec consumed:** `docs/specs/T-0119-files-attachments.spec.md` (status: ready, AC-1..AC-15) · `docs/specs/T-0119.spec.contract.json`
**Founder data (не развилка):** файлы → отдельное S3-совместимое объектное хранилище; права файла = производная прав записи; версии при циклах доработки; ретенция в архиве (gap-map §2, §3а).
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant-таблица: `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `current_setting('choros.tenant_id', true)`, DML только `choros_app`, занесение в `known_tenant_tables`.
- `docs/design/T-0014-registry-model.adr.md` — `record (tenant_id, id)`; запись = grant-target; composite tenant-leading FK ⇒ cross-tenant ссылка структурно невозможна.
- `docs/design/T-0015-object-handles.adr.md` — непрозрачные ручки; переменные процесса несут handle, не данные.
- `docs/design/T-0018-grant-authority.adr.md` §2 — единая grant-алгебра; «tools, masked fields, record-rights — производные проекции одной grant-таблицы; нет второго permission-подсистемы».
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — единый PDP-чокпойнт `grant-resolver`; права выводятся из grant-строк, action-time, fail-closed; reason-union `"no_grant" | "cross_tenant" | "not_found"`.
- `docs/design/T-0016-audit-floor.adr.md` — append-only per-tenant hash-chained `audit_event`; новые события = строки, не таблицы (open vocab `type`).
- `docs/design/T-0033-data-classification.adr.md` — `DataClass = "public"|"internal"|"confidential"|"restricted"` (закрытая ось, импорт из `src/core/data-classification.ts`).
- `docs/design/T-0041-egress-policy.adr.md` — egress-allowlist по DataClass (релевантно контенту файла, уходящему агенту).

**Связанные задачи (инварианты):**
- **T-0124 (document-on-demand) зависит от T-0119** — gap-map §4б инвариант 1: живой рендер фиксируется снапшотом-файлом; здесь — только приёмная поверхность (FR-9), не рендер.
- **T-0122/T-0126 (внешняя поверхность / headless)** — внешний принципал = производный ограниченный грант внутри grant-модели; скачивание файла внешним участником идёт тем же путём прав, не вторым механизмом.
- **T-0082 (единица версионирования источника)** — если документ-источник версионируется отдельной подсистемой, T-0119 ссылается, не дублирует (FR-5).
- **T-0118 (hash-oracle)** — контент-хэш файла согласуется с hash-oracle, если применимо (FR-8).

> Это ADR **design-only**. Choros имеет Postgres-в-compose (T-0053/T-0114) и S3-совместимый
> объект-стор только в дев-стеке как **MinIO** (см. §8); сам S3-адаптер, presign-сервис,
> миграция метаданных-таблицы и live-DB/live-S3 probes — **последующие impl-задачи**, не здесь.
> Следующая миграция — после `040_mcp_tool.sql` (свободный номер ≥ 041 по run-seam дисциплине;
> точный номер НЕ фиксируется — реальный свободный слот выбирает coder на момент impl).
> Каждая fitness-функция несёт конкретный `ci_check` + `gating`-ноту (**static-now** = лайнт/тип-чек/юнит
> в сегодняшнем `npm run ci`; **live-T-0053/impl** = проба, авторённая позже и активируемая при наличии
> Postgres+MinIO). Этот ADR — единый источник полей/типов/контрактов для `coder` и `tester`.

---

## 1. Context

Референс-процесс ТЭЛ показывает: файлы (проект договора, протокол разногласий, скан оригинала)
живут на **карточке записи** (договор-как-`record`), не на инстансе движка; запись имеет 0…N
вложений; при цикле доработки («внести правки» → сброс виз → маршрут заново) файл заменяется
**новой версией**, старая сохраняется; завершённые записи уходят «в архив» под политику ретенции.

Спека закрыла все продуктовые развилки решением фаундера (S3, производность прав, версии, ретенция)
и зафиксировала инварианты. Остались **четыре внутри-DESIGN развилки**, которые этот ADR обязан
решить с rejected-alternatives: (а) один bucket + tenant-префикс vs bucket-на-тенант; (б) presign
vs стриминг через бэкенд; (в) схема версий (immutable-версии + указатель current); (г) жизненный
цикл при архивации. Несущий принцип, как в T-0021: дизайн **негативен** не меньше, чем позитивен —
сделать неправильное **невозможным** (нет второго permission-механизма, нет перезаписи контента,
cross-tenant ключ структурно неконструируем), а не только покрытым тестом.

---

## 2. Decision

**Файл-вложение моделируется ДВУМЯ tenant-таблицами ядра + объектом в S3, при этом авторизация
полностью делегирована существующему PDP T-0021 — нового механизма прав не вводится.**

1. **Метаданные (две таблицы, T-0013-контракт verbatim):**
   - `file` — логический файл-вложение: `(tenant_id, id)` PK, composite tenant-leading FK
     `(tenant_id, record_id) → record(tenant_id, id)` (запись-владелец того же tenant; 1 запись ↔
     0…N файлов), `original_name`, `current_version` (указатель на актуальную версию), `retention_state`,
     `retention_policy_ref`, `created_by/at`. **Указатель current — атрибут `file`, а не вычисление по `max(version_no)`** (однозначность «актуальной версии», AC-5).
   - `file_version` — **иммутабельная** версия контента: `(tenant_id, id)` PK, FK
     `(tenant_id, file_id) → file(tenant_id, id)`, `version_no` (монотонный per-file), `object_key`
     (S3-ключ, уникален per-version), `mime_type`, `size_bytes`, `content_hash`, `is_snapshot`
     (для document-on-demand, FR-9), `data_class` (DataClass, FR-8/NF-6), `cycle_ref` (трассировка
     к событию цикла доработки, nullable), `uploaded_by/at`. Строки `file_version` **никогда не
     UPDATE/DELETE контентной части** на уровне приложения (иммутабельность; FF-V).
   - Бинарь в Postgres **запрещён** (FF-NB): ни `bytea`, ни `text`-base64.

2. **S3-ключ tenant-префиксован структурно:** `object_key = "<tenant_id>/<file_id>/<version_id>"`.
   `tenant_id`-сегмент — первый и не опционален; **cross-tenant ключ структурно неконструируем**
   (ключ собирается ЕДИНСТВЕННОЙ функцией `buildObjectKey(tenantId, fileId, versionId)`, которая
   берёт `tenantId` из tenant-контекста сессии, не из аргумента запроса; FF-KEY).

3. **Bucket: ОДИН bucket на дев-стек с tenant-префиксами** (не bucket-на-тенант — см. §3). Bucket
   **deny-by-default**, доступ только серверной ролью ядра (креды в env); прямых клиентских URL нет;
   публичный read запрещён политикой bucket. Изоляция тенантов держится на **двух независимых
   слоях**: (а) tenant-префикс ключа + (б) серверный allow-чек PDP по записи-владельцу до любого
   обращения к S3 — изоляция НЕ зависит только от дисциплины кода (NF-2).

4. **Право на файл = производная права на запись-владельца через PDP T-0021 — НЕ второй механизм:**
   любая файл-операция **транслируется в операцию над записью-владельцем** перед PDP. Чтение/скачивание
   файла ⇒ требует grant `read` на `record(tenant_id, record_id)`; добавление/замена ⇒ `update` (или
   `create`/`delete`) на запись. Резолвер тот же (`makeGrantResolver`), reason-union тот же. ADR **не
   вводит** `file_acl` / `attachment_rights` / `visibility`-поле — это нарушило бы единый источник
   истины (T-0018 §2, T-0021 FF-R6). Маппинг: handle файла → `ResourceRef` записи-владельца → scope
   записи; «кто видит файл» = «кто видит запись», вычисленное тем же резолвером (FF-NOACL).

5. **Выдача контента: presigned-URL короткого TTL, выпускаемый ТОЛЬКО после allow-решения PDP**
   (не стриминг-через-ядро — см. §3). Последовательность строго: (1) tenant-gate + PDP-allow
   `read` по записи-владельцу → (2) лишь при `{denied:false}` ядро вызывает `presignGet(object_key,
   ttl)` с коротким TTL (deploy-time параметр, дефолт ≤ 300 с) → (3) клиент скачивает напрямую из S3
   по подписанному URL до истечения TTL. **Presign никогда не выпускается до allow** (TOCTOU-граница:
   право проверяется в момент presign, не раньше; FF-NO-PRESIGN-BEFORE-ALLOW). Постоянных публичных
   URL объекта нет. Тот же путь — для внешнего принципала (T-0122/T-0126): производный ограниченный
   грант → presign, не второй механизм.

6. **Версии при циклах доработки:** замена контента = `addVersion(file)` — новая строка `file_version`
   (новый `version_no`, новый `object_key`, новый `content_hash`), `file.current_version` переводится
   на неё; **предыдущая версия остаётся читаемой по своему ключу** (контент иммутабелен, объект не
   перезаписывается; NF-3). `cycle_ref` связывает версию с событием возврата на доработку (трассируемость
   «эта версия — после такого-то возврата»). Если источник версионируется отдельной подсистемой (T-0082) —
   `file_version` ссылается, не дублирует механизм.

7. **Ретенция в архиве (deny-by-default к удалению):** `file.retention_state ∈ {active, archived,
   pending_deletion}` (схема — **day-1**); `retention_policy_ref` — декларативная политика (срок/класс),
   не хардкод. Переход в `archived` при уходе записи в терминальный статус (В архиве/Отказано/Отменён) —
   **сигнал из процесса/lifecycle**, не авто-магия здесь. Удаление контента (физическое стирание объекта
   S3) **разведено** с удалением метаданных-строки: контент стирается только после истечения политики и
   только из `pending_deletion`; строки `file`/`file_version` + аудит-след о существовании файла
   **переживают** стирание контента (T-0016 append-only; NF-5) — после стирания `object_key` помечается
   tombstone (`content_erased_at`), метаданные/хэш/история остаются. **Авто-применение ретенции (фоновый
   sweeper) = Stage-2**; схема статуса + ручной/lifecycle-триггер перехода = day-1 (FR-6 граница).

8. **Целостность и аудит:** `content_hash` считается при загрузке (целостность; согласуется с T-0118
   hash-oracle, если применимо). Аудит-события T-0016 (`type ∈ {file.upload, file.replace,
   file.download, file.delete}`, open vocab — **новых таблиц нет**, строки в `audit_event`) пишут
   `actor`, `subject = record_ref`, `payload = {file_id, version_id, version_no, content_hash, mime,
   size, data_class}`, tenant-scoped. Лимиты загрузки **declared** (макс. размер, allowlist MIME) —
   tenant-конфигурируемы либо фиксированы day-1 (deploy-time/`tenant_config`), не unbounded.

9. **Egress-граница (T-0041):** `file_version.data_class : DataClass` — контент/извлечённый текст файла,
   уходящий LLM-агенту, подпадает под egress-политику по DataClass. Классификационная граница
   зафиксирована схемой day-1; runtime-гейт egress = Stage-2 (как T-0041).

Тонкое ядро, логика на границах (CONCEPT §5): новый код — это adapter (S3-порт), сервис presign и
write-path версий; авторизация **переиспользует** T-0021 без единой новой permission-строки.

---

## 3. Rejected alternatives

| Развилка | Option | Why not |
|---|---|---|
| **Bucket-модель** | **Bucket-на-тенант** (отдельный S3-bucket каждому tenant) | На silo-дефолте (один контур = один tenant) это эквивалент, но в pooled-режиме (gap-map §4б отложен, но ретрофит запрещён) bucket-per-tenant = неограниченное число bucket-ов, упирающееся в лимиты провайдера, и провижн bucket-а становится частью genesis тенанта (новая операция, новый сбой-режим). **Один bucket + tenant-префикс ключа** даёт ту же структурную изоляцию (cross-tenant ключ неконструируем, §2.2), нулевой провижн-шаг на нового tenant, и pooled-готовность без ретрофита (FR-7, тз §9 п.9). Изоляция держится на префиксе ключа + PDP-allow, не на отдельном bucket. |
| **Выдача контента** | **Стриминг бинаря через ядро** (Node проксирует байты из S3 клиенту) | Каждый download проходит через процесс ядра → CPU/память/полоса ядра масштабируются с трафиком файлов (большие сканы/договоры), ядро становится узким местом и точкой отказа; дублирует то, что S3 делает нативно. **Краткоживущий presigned-URL после allow** даёт тот же инвариант безопасности (ни байта без предшествующего allow PDP; NF-4) при O(1)-нагрузке на ядро: ядро решает право и выпускает подпись, байты идут S3→клиент. TOCTOU закрыт коротким TTL + presign-строго-после-allow. Стриминг оставлен как точка расширения, если потребуется (напр. on-the-fly расшифровка), но не MVP. |
| **Версии** | **Перезапись объекта S3 + S3-native versioning** (один ключ, версии внутри S3) | Прячет историю в инфраструктуру: «актуальная версия» становится свойством S3-конфигурации, а не модели ядра; воспроизводимость и аудит зависят от того, включён ли versioning на bucket (дисциплина инфры, не структура). Трассировка версии к циклу доработки (`cycle_ref`) невыразима в S3-метаданных без второго реестра. **Immutable-версии = отдельные строки `file_version` + отдельные ключи + явный указатель `current_version`** делают «актуальную версию» однозначным фактом ядра, историю — запросом к tenant-таблице, иммутабельность — инвариантом приложения (объект не перезаписывается), независимым от S3-фич (NF-3, FR-5). |
| **Указатель current** | **`current = max(version_no)`** (вычислять актуальную версию) | «Актуальная» ≠ всегда «последняя по номеру»: откат к ранней версии, снапшот-ветвление (FR-9) ломают тождество. Явный `file.current_version` делает выбор актуальной версии **решением, записанным в строке**, однозначным и аудируемым (AC-5). |
| **Авторизация** | **`file_acl` / `attachment_rights` / `file.visibility`-поле** (отдельные права файла) | Второй источник истины «кто видит файл» дрейфует от «кто видит запись» → тихий leak или тихий отказ. Прямо запрещено T-0018 §2 / T-0021 FF-R6 / NF-1. Право файла **выводится** из права записи-владельца тем же PDP — ровно как T-0021 выводит masked-fields из grant-строк. (FF-NOACL.) |
| **Привязка** | **Файл как вложение к инстансу процесса** (файл живёт на движке) | Референс ТЭЛ: файлы на карточке договора (записи), не на инстансе; процесс несёт handle (T-0015), не файл. Привязка к инстансу разорвала бы файл от записи после завершения процесса (архив записи остался бы без файлов) и создала бы вторую точку истины. Точка истины — **запись** (FR-1). |
| **Хранение бинаря** | **Бинарь в Postgres (`bytea`/large object)** | Раздувает БД/бэкапы/WAL; не S3-совместимо (решение фаундера = S3); ломает FR-2. Бинарь только в S3. |

---

## 4. Object model & contracts

> Postgres-типы авторитетны; TS-зеркало следует конвенции T-0014. Обе таблицы — обычные T-0013
> tenant-таблицы (FORCE RLS, default-DENY, `tenant_id`-leading PK/FK, `choros_app` DML-only),
> заносятся в `ci/checks/known_tenant_tables.txt`: `file`, `file_version`. **Никаких новых
> isolation-кодпутей** — те же FF T-0013/T-0115 покрывают их.

### 4.1 `file` — логический файл-вложение (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity |
| `record_id` | `uuid NOT NULL` | FK `(tenant_id, record_id) → record(tenant_id, id)` — запись-владелец (T-0014); cross-tenant структурно невозможен |
| `original_name` | `text NOT NULL` | исходное имя файла (display) |
| `current_version` | `uuid NULL` | указатель на актуальную `file_version.id`; nullable до первой версии |
| `retention_state` | `text NOT NULL DEFAULT 'active'` | CHECK ∈ `{active, archived, pending_deletion}` |
| `retention_policy_ref` | `text NULL` | декларативная политика (срок/класс); не хардкод |
| `created_by` | `text NOT NULL` | актор |
| `created_at` | `bigint NOT NULL` | epoch ms |
| `updated_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; FK `(tenant_id, record_id)`; index `(tenant_id, record_id)` (листинг файлов записи) |

### 4.2 `file_version` — иммутабельная версия контента (tenant-таблица)

| Field | Type | Note |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK; RLS-ключ |
| `id` | `uuid NOT NULL` | identity версии |
| `file_id` | `uuid NOT NULL` | FK `(tenant_id, file_id) → file(tenant_id, id)` |
| `version_no` | `integer NOT NULL` | монотонный per-file; UNIQUE `(tenant_id, file_id, version_no)` |
| `object_key` | `text NOT NULL` | S3-ключ `<tenant_id>/<file_id>/<version_id>`; UNIQUE `(tenant_id, object_key)` |
| `mime_type` | `text NOT NULL` | задекларированный MIME (из allowlist) |
| `size_bytes` | `bigint NOT NULL` | размер (≤ declared limit) |
| `content_hash` | `text NOT NULL` | хэш контента при загрузке (T-0118-совместимый) |
| `data_class` | `text NOT NULL DEFAULT 'internal'` | DataClass (T-0033); egress-граница (T-0041) |
| `is_snapshot` | `boolean NOT NULL DEFAULT false` | document-on-demand снапшот (FR-9/T-0124) |
| `cycle_ref` | `text NULL` | трассировка к событию цикла доработки процесса |
| `content_erased_at` | `bigint NULL` | tombstone: контент стёрт по ретенции, метаданные/хэш живут (NF-5) |
| `uploaded_by` | `text NOT NULL` | актор загрузки |
| `uploaded_at` | `bigint NOT NULL` | epoch ms |
| | PK `(tenant_id, id)`; FK `(tenant_id, file_id)`; UNIQUE `(tenant_id, file_id, version_no)`; UNIQUE `(tenant_id, object_key)` |

### 4.3 Contracts (signatures — impl-задача реализует; ADR фиксирует форму)

```ts
// S3-порт (адаптер; дев = MinIO). Инъектируется; ядро не знает конкретный провайдер.
export interface ObjectStore {
  // Загрузка контента под детерминированный ключ; объект НЕ перезаписывается (новый ключ per version).
  put(key: string, body: Uint8Array, meta: { mime: string; size: number }): Promise<void>;
  // Краткоживущая presigned GET-ссылка. Вызывается ТОЛЬКО после allow-решения PDP.
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  // Физическое стирание (ретенция). Метаданные-строка и аудит-след НЕ затрагиваются.
  erase(key: string): Promise<void>;
}

// ЕДИНСТВЕННая функция сборки ключа: tenantId берётся из tenant-контекста, не из запроса.
// Cross-tenant ключ неконструируем (FF-KEY).
export function buildObjectKey(tenantId: string, fileId: string, versionId: string): string;
// => `${tenantId}/${fileId}/${versionId}`

// Авторизация файл-операции = трансляция в операцию над записью-владельцем + PDP T-0021.
// НЕТ собственного permission-вычисления; reason-union наследуется от T-0021.
// op: "read" (download) | "update" (replace/add) | "delete".
export function authorizeFileOp(
  resolver: HandleResolver,      // makeGrantResolver(deps) — тот же резолвер, что для записи
  fileHandle: ObjectHandle,      // несёт ResourceRef записи-владельца (record)
  subject: ResolveSubject,
  op: Operation,
): Promise<ResolvedView>;         // {denied:true, reason} | {denied:false, ...}

// Выдача контента: allow → presign. Ни байта без предшествующего allow (NF-4).
export function getFileContentUrl(
  deps: { resolver: HandleResolver; store: ObjectStore; meta: FileMetaSource; ttl: number },
  fileVersionId: string,
  subject: ResolveSubject,
): Promise<{ denied: true; reason: string } | { denied: false; url: string; expiresAt: number }>;

// Замена контента = новая иммутабельная версия + перевод current_version. Старая версия читаема.
export function addVersion(
  deps: { resolver: HandleResolver; store: ObjectStore; meta: FileMetaSource },
  fileId: string, subject: ResolveSubject,
  body: Uint8Array, attrs: { mime: string; cycleRef?: string; isSnapshot?: boolean; dataClass?: DataClass },
): Promise<{ denied: true; reason: string } | { denied: false; versionId: string; versionNo: number }>;
```

### 4.4 Авторизационная последовательность (несущая)

1. **Tenant-gate first (fail-closed):** tenant-контекст сессии обязателен; отсутствует (async/фон) ⇒
   отказ, не глобальное действие (tenancy §9 п.7; FF-FAILCLOSED). Handle файла tenant-несовпадение ⇒
   `cross_tenant` до любого чтения метаданных/S3 (AC-10).
2. **PDP-allow по записи-владельцу:** `authorizeFileOp` транслирует операцию файла в op над
   `record(tenant_id, record_id)` и зовёт **тот же** `resolveHandle`/`resolveFor`. `{denied:true}` ⇒
   стоп, ни presign, ни put, ни erase.
3. **Только при allow** — обращение к `ObjectStore` (presign/put). Никакого S3 до allow (NF-4).
4. **Аудит** (T-0016) пишется на upload/replace/download/delete.

---

## 5. Build plan & что defers

**BUILD (последующая impl-задача ≥ 041) создаёт:**
- Миграцию `0NN_files_attachments.sql` (свободный номер ≥ 041) — `file` + `file_version` по §4.1/§4.2,
  FORCE RLS + default-DENY policy + `choros_app` GRANT DML; **добавляет `file`, `file_version` в
  `known_tenant_tables.txt`** (это единственное легитимное изменение фикстуры — оно ожидаемо и
  покрыто FF-T13).
- `src/core/file-attachment.ts` — `buildObjectKey`, `authorizeFileOp`, `getFileContentUrl`, `addVersion`,
  типы `ObjectStore`/`FileMetaSource`; **импортирует** `HandleResolver`/`ResolveSubject`/`ObjectHandle`/
  `Operation` (T-0015/T-0018) и `DataClass` (T-0033); **не вводит** собственного permission-вычисления.
- `src/adapters/s3-object-store.ts` — реализация `ObjectStore` поверх S3-совместимого SDK (дев = MinIO).
- compose-фрагмент дев-стека: сервис MinIO + bucket-init + env-креды серверной роли (deny-by-default
  bucket policy) — в рамках автономии (§8).
- `ci/checks/file-attachment-isolation.sh` — статические fitness-лайнты (FF-NB, FF-NOACL, FF-KEY,
  FF-V ниже).
- `src/__tests__/file-attachment.test.ts` — юнит-фитнес (presign-после-allow, версии, fail-closed).
- live-DB/live-S3 probes (AC-9/10/11), активируемые при наличии Postgres+MinIO.

**Defers (НЕ здесь):**
- **T-0124** — рендер document-on-demand; здесь только приёмная поверхность снапшота (`is_snapshot`).
- **T-0122/T-0126** — механизм внешнего принципала/токена; путь прав файла обязан быть производным грантом.
- **T-0082** — версионирование документа-источника как подсистемы; `file_version` ссылается, не дублирует.
- **Stage-2:** фоновый sweeper авто-ретенции; runtime-гейт egress (T-0041); полнотекст/превью/антивирус-скан;
  pooled-режим S3 (tenant-префикс уже pooled-готов, ретрофита не требует).
- **UI вложений** (зона 7, T-0137/T-0138).

---

## 6. Fitness functions (CI gating — impl acceptance contract)

`gating`: **static-now** = лайнт/тип-чек/юнит, runnable в `npm run ci` после impl; **live-impl** =
проба, авторённая в impl-задаче, активируемая при Postgres+MinIO.

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-NOACL** | Нет второго механизма авторизации файлов: код не содержит `file_acl`/`attachment_rights`/`file_visibility`/`*.visibility`-токенов; `file-attachment.ts` не вычисляет права сам, а зовёт `resolveHandle`/`resolveFor` (T-0021). | `bash ci/checks/file-attachment-isolation.sh`: grep forbidden tokens (`file_acl`, `attachment_rights`, `visibility`) в `migrations/0NN_*.sql` + `src/core/file-attachment.ts`; assert вызов `resolveHandle\|resolveFor` присутствует, собственного grant-фильтра нет. | static-now |
| **FF-NB** | Бинарь не в Postgres: миграция `file`/`file_version` не содержит `bytea`/`text`-base64-контент-колонки; только `object_key`. | `grep -iE '\b(bytea|largeobject|lo_)\b' migrations/0NN_files_attachments.sql` ⇒ 0 matches; assert `object_key text` присутствует. | static-now |
| **FF-KEY** | Tenant-префикс ключа структурен: `buildObjectKey` — единственный конструктор ключа, ключ начинается с `tenant_id`-сегмента, `tenantId` не приходит из недоверенного аргумента запроса. | `bash ci/checks/file-attachment-isolation.sh`: assert ровно один `export function buildObjectKey`; нет конкатенации S3-ключа в обход (`grep` на `\.put(\|presignGet(` с inline-ключом без `buildObjectKey`). | static-now |
| **FF-V** | Иммутабельность контента per-версия: write-path не UPDATE/DELETE `object_key`/контент существующей `file_version`; замена = INSERT новой строки + UPDATE `file.current_version`. | unit: `addVersion` дважды ⇒ две строки `file_version`, разные `object_key`/`version_no`/`content_hash`, старая строка не мутирована; `ObjectStore.put` не вызывает overwrite того же ключа. `vitest run … -t "immutable-version"`. | static-now |
| **FF-PRESIGN-AFTER-ALLOW** | Presign только после allow: `getFileContentUrl` при `{denied:true}` от резолвера НЕ вызывает `store.presignGet`; при allow — вызывает с `ttl ≤ maxTtl`. | unit: мок-резолвер deny ⇒ `presignGet` не вызван, результат `{denied:true}`; allow ⇒ `presignGet(key, ttl)` вызван, `ttl ≤ 300`. `vitest run … -t "presign-after-allow"`. | static-now |
| **FF-FAILCLOSED** | Fail-closed по tenant-контексту в async/фоне: без tenant-контекста presign/put/erase отказывают, не выполняются глобально. | unit: вызов без tenant-контекста ⇒ отказ (reason `cross_tenant`/`no_grant`), ноль обращений к `ObjectStore`. `vitest run … -t "fail-closed"`. | static-now |
| **FF-DERIVED-AUTHZ** | Право файла = производная права записи: субъект без grant `read` на запись-владельца получает `{denied}` на download любого её файла; с grant `read` — `{denied:false, url}`; решение принимает PDP T-0021 (тот же резолвер). | live-impl probe (AC-9): seed запись + файл, grant/no-grant субъекту, assert allow/deny через `makeGrantResolver`. | live-impl |
| **FF-CROSS-TENANT** | Cross-tenant контент недостижим: попытка получить файл tenant B из контекста tenant A ⇒ `cross_tenant`, ни байта; S3-ключ tenant B не presign-уется из tenant A. | live-impl probe (AC-10), стиль `ci/checks/db/cross_tenant.test.ts` (appUrl/migratorUrl); + assert presign отказан. | live-impl |
| **FF-VERSION-READABLE** | Старая версия читаема после замены: `addVersion` оставляет предыдущую `file_version` читаемой по её ключу; `current_version` указывает на новую; `content_hash` версий различны и совпадают с фактическим контентом. | live-impl probe (AC-11): upload v1, replace→v2, assert v1 GET ок по object_key, current=v2, hash(v1)≠hash(v2), hash совпадает с байтами. | live-impl |
| **FF-RETENTION-DENY** | Deny-by-default к удалению: контент стирается только из `pending_deletion` после истечения политики; стирание ставит `content_erased_at`, строки `file`/`file_version` и аудит-след сохраняются (T-0016 append-only). | unit + live-impl: попытка `erase` файла в `active`/`archived` ⇒ отказ; после `pending_deletion`+истечения ⇒ `erase` + `content_erased_at` set, метаданные/аудит живы. `vitest run … -t "retention-deny"`. | static-now + live-impl |
| **FF-AUDIT-EVENTS** | Аудит на upload/replace/download/delete: каждое = строка `audit_event` (open vocab `file.*`, новых таблиц нет) с `actor`, `subject=record_ref`, `payload={file_id, version_id, content_hash, …}`, tenant-scoped. | unit: каждая операция эмитит ожидаемое `audit_event` (фикстура); assert `known_tenant_tables` не получает audit-таблицу-дубль. `vitest run … -t "audit-events"`. | static-now |
| **FF-T13** | T-0013-контракт метаданных-таблиц: `file`/`file_version` — `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY policy на `choros.tenant_id` GUC, `choros_app` DML-only, занесены в `known_tenant_tables.txt`. | существующие T-0013/T-0115 пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) применяются к новым таблицам после внесения в фикстуру. | live-impl (T-0013 apparatus) |
| **FF-EGRESS-CLASS** | Egress-граница зафиксирована: `file_version.data_class : DataClass` (импорт из `src/core/data-classification.ts`, не редекларация); тип-контракт под `tsc --noEmit`. | `tsc --noEmit` на тип-фикстуре `file_version.data_class ↔ DataClass`; grep что `DataClass` импортирован, не переопределён. | static-now |

---

## 7. Traceability (FR/AC → design)

| AC / FR | covered_by |
|---|---|
| AC-1 / FR-1 | §2.1 (`file`, FK `(tenant_id, record_id)→record`, 1↔0..N); §4.1; §3 (rejected: вложение к инстансу) |
| AC-2 / FR-2 | §2.1 (две таблицы, поля); §4.1/§4.2; FF-NB; §3 (rejected: бинарь в Postgres) |
| AC-3 / FR-3 / NF-1 | §2.4 (производность через T-0021, нет ACL); §4.3 `authorizeFileOp`; §4.4; FF-NOACL; §3 (rejected: file_acl) |
| AC-4 / FR-4 / NF-4 | §2.3/§2.5 (presign после allow, bucket deny-by-default); §4.3 `getFileContentUrl`; FF-PRESIGN-AFTER-ALLOW; §3 (rejected: стриминг) |
| AC-5 / FR-5 / NF-3 | §2.6 (immutable-версии, `current_version`); §4.2; FF-V, FF-VERSION-READABLE; §3 (rejected: S3-versioning, max(version_no)) |
| AC-6 / FR-6 / NF-5 | §2.7 (retention_state, декларативная политика, deny-by-default, tombstone, sweeper=Stage-2); FF-RETENTION-DENY |
| AC-7 / FR-7 / NF-2 | §2.2/§2.3 (один bucket + tenant-префикс, структурный ключ); §4.1/§4.2 (T-0013-контракт, known_tenant_tables); FF-KEY, FF-T13; §3 (rejected: bucket-per-tenant) |
| AC-8 | §2.5 step1, §4.4 step1 (tenant-gate fail-closed в async/фоне); FF-FAILCLOSED |
| AC-9 | §2.4, §4.4 (PDP T-0021 тот же резолвер); FF-DERIVED-AUTHZ |
| AC-10 | §2.2 (структурный ключ), §4.4 step1 (cross_tenant до S3); FF-CROSS-TENANT |
| AC-11 | §2.6 (immutable, новый ключ/хэш); FF-VERSION-READABLE |
| AC-12 / FR-9 | §2.1 (`is_snapshot`), §2 (приёмная поверхность), §4.2; не дублирует права/версии |
| AC-13 / FR-8 | §2.8 (content_hash, declared-лимиты, аудит-события); §4.2; FF-AUDIT-EVENTS |
| AC-14 / NF-6 | §2.9 (`data_class : DataClass`, egress-граница T-0041, runtime-гейт Stage-2); FF-EGRESS-CLASS |
| AC-15 | §3 (все rejected обоснованы против инвариантов); §6 (FF-NOACL/FF-NB/FF-KEY гарантируют отсутствие второго механизма); ревью-гейт архитектора (этот §) |

---

## 8. Runtime target

**Дев-стек / контейнер.** Метаданные — Postgres-в-compose (T-0053/T-0114, уже провижн на dev,
homeserver-vm). Объектное хранилище — **S3-совместимый MinIO как docker-compose сервис дев-стека**
(один bucket, deny-by-default policy, креды серверной роли в env) — **в рамках автономии** (локальный
дев-стек, аналог Postgres/Keycloak compose; не требует денег/внешних ресурсов).

**Развилка уровня фаундера (НЕ решается здесь, зафиксирована как deploy-time параметр):** выбор
конкретного **облачного S3-провайдера для prod** (AWS S3 / Yandex Object Storage / MinIO self-hosted
на сервере фаундера / иной) — это деньги + внешний ресурс + 152-ФЗ-локация данных (РФ-рынок). ADR
закладывает **`ObjectStore`-порт** (§4.3), так что provider — инъектируемая деталь конфигурации:
`endpoint`/`bucket`/`region`/`credentials`/`presign_ttl` = deploy-time env, не код. Смена провайдера
= смена адаптера+env, без изменения ядра. Provision prod-хранилища — гейт фаундера (GT-4), как и
prod-сервер; здесь не запрашивается (дев = MinIO достаточно для impl+тестов).

## 9. Compatibility notes (architect rule 7)

- **Implements, does not change, T-0021.** Файл-авторизация переиспользует `makeGrantResolver`/
  `resolveHandle`/`resolveFor` и reason-union `"no_grant"|"cross_tenant"|"not_found"` verbatim;
  новых reason-значений, новой permission-функции, нового handle→fields-ребра НЕ вводится (honors
  `single-resolver.sh`, T-0021 FF-R5/R6).
- **Honors T-0018 §2 / NF-1:** record-rights файла = производная одной grant-таблицы; FF-NOACL греп-лайнтит
  параллельный authority-store (`file_acl`/`attachment_rights`/`visibility`), как T-0021 FF-R6.
- **Honors T-0013/T-0115:** `file`/`file_version` — обычные tenant-таблицы; внесение в
  `known_tenant_tables.txt` — единственное (ожидаемое) изменение фикстуры, выполняемое impl-миграцией,
  покрытое существующими T-0013-пробами. Это легитимное добавление, не нарушение
  `grant-trail-no-new-table.sh` (та проба специфична T-0031, не общий запрет новых таблиц).
- **Honors T-0016:** файл-аудит = строки `audit_event` с open-vocab `type` (`file.*`); новых
  аудит-таблиц нет (как `grant.*`-события — строки, не таблицы).
- **Honors T-0033/T-0041:** `data_class` импортирует закрытую `DataClass`, не редекларирует (как T-0041);
  egress-граница помечена, runtime-гейт = Stage-2.

## 10. Escalation

None для DESIGN-объёма. Все четыре внутри-DESIGN развилки решены (§3). Единственная развилка уровня
фаундера — **выбор/оплата prod-S3-провайдера** — вынесена как **deploy-time параметр** за `ObjectStore`-порт
(§8), не блокирует impl (дев = MinIO в рамках автономии). Provision prod-хранилища = GT-4 (как prod-сервер),
не открывает продуктовую развилку и не требует кросс-вендор-петли.
