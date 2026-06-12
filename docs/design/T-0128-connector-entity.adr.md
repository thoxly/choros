# ADR · T-0128 — Сущность «коннектор/интеграция» (заглушка под драйверы)

**Phase:** DESIGN · **Status:** ready (no founder forks) · **Date:** 2026-06-12
**Task:** T-0128 (product=choros, type=design, prio 40)
**Spec:** `docs/specs/T-0128-connector-entity.spec.md` (16 AC) — терминальное направление
фаундера (gap-map §2 envelope + §3а: «коннекторы сейчас не делаем, сущность закладываем»).
**Base:** `dev` @ 94174bf (merge-base) · worktree branch `task/T-0128-connector-entity-design`.

---

## 1. Decision (один абзац)

Завести первокласс tenant-сущность **`connector`** (новая таблица, миграция **054**) как
**конфигурационную, несущую секрет, tenant-изолированную запись** — точную копию
архитектурного приёма уже живущего `email_channel_config`/T-0170, но с **закрытой осью
`kind`** (как `EffectKind` у T-0034) вместо «одна-строка-на-тенант email». Core-модуль
`src/core/connector.ts` — **pure/IO-free**: CRUD-функции (`setConnector`,
`rotateConnectorSecret`, `revokeConnector`, `getConnectorStatus`, `listConnectors`) принимают
инжектируемые порты (`ConnectorWritePort`, `AuditWriter`, `clock`), переиспользуют **verbatim**
custody-примитивы T-0025 (`validateSecretHandleShape`, `redactHandle`,
`SecretResolverPort`-совместимый seam) — **без передекларации**, точно как это делает
`notification-email.ts`. Право *вызвать* коннектор НЕ вводится: вызов = `invoke`-грант на
`effect_resource` (T-0034), а коннектор лишь **декларативно бэкит** effect_resource через
nullable-поле `backs_effect_resource_id` (логическая ссылка, не FK — см. §5). Управление
(мутации) гейтится грантом `mgmt_object:connector` через grant-resolver T-0021 (прецедент
`scoped-admin.ts` / `agent-hire.ts`). Драйверы НЕ пишутся: ADR фиксирует два пустых seam'а
(`ConnectorSecretResolverPort`, `ConnectorDriverPort`); day-1 в репо нет ни класса-драйвера,
ни единого реального внешнего вызова (`fetch`/`net`/SMTP/LDAP) из connector-пути.
`email_channel_config` **не трогается** — две сущности сосуществуют, конвергенция = Stage-2.

**Соразмерность (рубрика ось 5):** механизм = «ещё одна tenant-таблица + pure CRUD по
живому email-шаблону». Не вводится ни новый авторизатор, ни новый custody-механизм, ни
второй dispatch. Тонкое ядро (чистые функции), IO на границах (порты) — принцип продукта.

---

## 2. Контекст и опоры (живые file:line)

| Опора | Что переиспользуем | Живой якорь |
|---|---|---|
| **T-0025** custody | `validateSecretHandleShape` (shape-guard), `redactHandle`, `SecretResolverPort` (type) | `src/core/secret-handle-validator.ts:78` (validate), `:117` (redact), `:40` (port type) |
| **T-0034** effect_resource | вызов = `invoke`-грант на `effect_resource`; closed-`kind` приём | `src/core/effect-resource.ts:38` (EffectKind union), `:194` (verifyEffectGrants), `migrations/022_effect_resource.sql` |
| **T-0170** «коннектор-подобная» сущность | весь скелет: pure-core + порты + shape-guard + redact + audit-без-секрета | `src/core/notification-email.ts:160` (setEmailChannelConfig), `:273` (status+redact), `:441` (day-1 stub resolver); `src/core/postgres/pgEmailConfigStore.ts:60` (DAO) |
| **T-0013** RLS-канон | tenant_id ведущий PK, ENABLE+FORCE RLS, isolation-policy, GRANT choros_app, known_tenant_tables | `migrations/047_email_channel_config.sql:20-56` (verbatim шаблон), `ci/checks/known_tenant_tables.txt` |
| **T-0021** PDP/mgmt_object | gate мутаций на `mgmt_object:connector` | `src/core/scoped-admin.ts:54-57` (`mgmt_object:role/agent/process/grant`), `src/core/agent-hire.ts:179` (`mgmt_object:agent:create`), `src/core/grant-lattice.ts:33` (`mgmt_object:${string}`) |
| **Миграционный стиль** | слот 054 (последний = 053), `IF NOT EXISTS`, DO-guard policy, идемпотентность | `migrations/047_email_channel_config.sql`, `migrations/run.mjs` |

**Что НЕ существует сегодня (дыра, которую закрываем):** `effect_resource` отвечает на
вопрос *что вызвать* (грант-точка), но нет первокласса *«чем именно подключаемся»* — записи,
несущей *тип системы* (1С/AD/SMTP/…), *конфиг* (хост/порт/realm — opaque jsonb), *custody
секрета* и *статус*. Коннектор закрывает ровно эту дыру как заглушку-под-драйвер.

---

## 3. Object model

### 3.1 Таблица `connector` (миграция 054)

```sql
-- 054 · connector (T-0128 E-?.?) — per-tenant connector/integration stub entity.
-- Tenant-table contract (T-0013, verbatim as 047_email_channel_config.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, isolation policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT, listed in ci/checks/known_tenant_tables.txt.
-- Stub semantics: CRUD writes/reads config+handle+status; NO live driver, NO real call.
-- Migration slot: 054 (immediately follows 053_author_report_page_seed.sql).

CREATE TABLE IF NOT EXISTS choros.connector (
  tenant_id               uuid    NOT NULL,
  id                      uuid    NOT NULL,
  kind                    text    NOT NULL
    CHECK (kind IN ('1c', 'ad_ldap', 'smtp', 'http_generic')),
  display_name            text    NOT NULL,
  config                  jsonb   NOT NULL DEFAULT '{}'::jsonb, -- opaque; NOT used in authz
  secret_handle           text    NULL,                          -- RL-3 opaque handle (T-0025)
  status                  text    NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('configured', 'disabled', 'error')),
  backs_effect_resource_id uuid   NULL,    -- declarative link to effect_resource it backs (T-0034)
  created_by              text    NOT NULL,
  created_at              bigint  NOT NULL,
  updated_by              text    NOT NULL,
  updated_at              bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros.connector ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.connector FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros' AND tablename = 'connector'
      AND policyname = 'connector_tenant_isolation'
  ) THEN
    CREATE POLICY connector_tenant_isolation ON choros.connector
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.connector TO choros_app;
```

**Замечания по форме:**
- `PRIMARY KEY (tenant_id, id)` — `tenant_id` **ведущая колонка** (T-0013 канон; проходит
  `tenant_id_leading.sql`). Отличие от `email_channel_config` (там PK = только `tenant_id`,
  одна строка/тенант): у коннектора **много строк на тенант**, поэтому композитный PK.
- `backs_effect_resource_id` — **логическая ссылка, НЕ foreign key** (см. §5, rejected alt).
- `status` дефолт `'disabled'` — коннектор рождается выключенным (как `email_channel_config.is_enabled
  DEFAULT false`); явная CRUD/admin-команда переводит в `configured`. **Никакой живой пробы.**
- `config` — `jsonb`, **opaque**: хост/порт/БД/realm/base_url; fitness-инвариант — никогда не
  читается в решении авторизации (NF-4 / один механизм прав).
- `secret_handle` — `nullable`: коннектор может существовать без секрета (заглушка-под-драйвер).

### 3.2 TypeScript (`src/core/connector.ts`, pure-core)

```ts
/** Closed connector-kind axis (FR-2 / AC-2). Mirrors EffectKind closed-set приём (T-0034).
 *  Adding a kind = migration CHECK + union extension. Unknown kind → fail-closed. */
export type ConnectorKind = "1c" | "ad_ldap" | "smtp" | "http_generic";

/** Total predicate over the closed set (no string cast widens it). */
export function isConnectorKind(v: unknown): v is ConnectorKind {
  return v === "1c" || v === "ad_ldap" || v === "smtp" || v === "http_generic";
}

/** Declarative connector status (FR-4). Day-1 set by CRUD/admin, NOT by a live probe. */
export type ConnectorStatus = "configured" | "disabled" | "error";
export function isConnectorStatus(v: unknown): v is ConnectorStatus {
  return v === "configured" || v === "disabled" || v === "error";
}

/** Domain record mirroring choros.connector (migration 054). */
export interface Connector {
  readonly tenantId: string;
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>; // opaque jsonb
  /** Opaque RL-3 handle (T-0025). NOT a raw secret. null = no secret bound yet. */
  readonly secretHandle: string | null;
  readonly status: ConnectorStatus;
  /** Declarative link to the effect_resource this connector backs (T-0034). null = none. */
  readonly backsEffectResourceId: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedBy: string;
  readonly updatedAt: number;
}
```

---

## 4. Контракты (сигнатуры — источник правды для coder/tester)

Структура **дословно** по `notification-email.ts` (pure-core, deps-объект с портами).

```ts
// ----- Ports (IO behind injection — NF-5) -----------------------------------

/** Write port for choros.connector. Postgres DAO = PgConnectorStore (mirrors
 *  pgEmailConfigStore.ts). In tests: fake. Caller MUST have SET choros.tenant_id GUC. */
export interface ConnectorWritePort {
  insert(c: Connector): Promise<void>;
  update(c: Connector): Promise<void>;
  get(tenantId: string, id: string): Promise<Connector | null>;
  list(tenantId: string): Promise<Connector[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

/** Seam #1 — secret resolver (Stage-2). Structurally compatible with T-0025
 *  SecretResolverPort (compile-time _assert as in notification-email.ts:453).
 *  Day-1: NO production impl wired into any connector code-path. */
export interface ConnectorSecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}

/** Seam #2 — driver port (Stage-2). Mirrors SmtpSenderPort (T-0170) /
 *  ChannelDriver shape. Day-1: NO implementing class in the repo. */
export interface ConnectorDriverPort {
  readonly kind: ConnectorKind;
  /** Stage-2 only. Day-1 there is NO class implementing this. */
  invoke(req: ConnectorInvokeRequest, ctx: { tenantId: string }): Promise<ConnectorInvokeResult>;
}

// ----- CRUD result -----------------------------------------------------------
export type SetConnectorResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

// ----- Inputs ----------------------------------------------------------------
export interface SetConnectorInput {
  readonly id?: string;                 // absent → create (new uuid); present → update
  readonly kind: ConnectorKind;         // validated by isConnectorKind → fail-closed
  readonly displayName: string;
  readonly config?: Record<string, unknown>;
  readonly secretHandle?: string;       // if present → validateSecretHandleShape before write
  readonly status?: ConnectorStatus;    // declarative; default 'disabled' on create
  readonly backsEffectResourceId?: string | null;
  readonly actor: string;               // for audit
}

// ----- CRUD functions (pure-core; IO via deps ports) -------------------------

/** Create/update a connector. fail-closed on unknown kind; shape-guard on secretHandle;
 *  emits audit_event 'connector.set' (NO secret_handle in payload). */
export function setConnector(
  deps: { store: ConnectorWritePort; auditWriter: AuditWriter; tx: PgClientLike; clock: { now(): number } },
  tenantId: string, input: SetConnectorInput,
): Promise<SetConnectorResult>;

/** Rotate the connector secret. shape-guard on new handle; emits 'connector.rotate'. */
export function rotateConnectorSecret(
  deps: { store: ConnectorWritePort; auditWriter: AuditWriter; tx: PgClientLike; clock: { now(): number } },
  tenantId: string, id: string, newSecretHandle: string, actor: string,
): Promise<SetConnectorResult>;

/** Revoke (delete) a connector. emits 'connector.revoke'. {ok:false,reason:'not_found'} if absent. */
export function revokeConnector(
  deps: { store: ConnectorWritePort; auditWriter: AuditWriter; tx: PgClientLike; clock: { now(): number } },
  tenantId: string, id: string, actor: string,
): Promise<SetConnectorResult>;

/** Status view with REDACTED handle (redactHandle) — never the raw handle. */
export interface ConnectorStatusView {
  readonly id: string; readonly kind: ConnectorKind; readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly handleRedacted: string | null;   // redactHandle(secretHandle) | null if unbound
  readonly secretBound: boolean;
  readonly status: ConnectorStatus;
  readonly backsEffectResourceId: string | null;
  readonly updatedBy: string; readonly updatedAt: number;
}
export function getConnectorStatus(store: ConnectorWritePort, tenantId: string, id: string): Promise<ConnectorStatusView | null>;
export function listConnectors(store: ConnectorWritePort, tenantId: string): Promise<ConnectorStatusView[]>;
```

### 4.1 PDP-gate мутаций (HTTP-граница, не core)

Мутирующие HTTP-эндпоинты (`POST/PATCH/DELETE /api/connectors`) гейтятся **перед** вызовом
core-функции грантом на `mgmt_object:connector` через grant-resolver T-0021 — паттерн
`agent-hire.ts:179` (`{ resourceType: "mgmt_object:agent"; operation: "create" }`) и
`seed-write.ts:405` (`validateAdminDelegation` для `mgmt_object:role:create`). Маппинг операций:

| Операция | Capability (resourceType / operation) |
|---|---|
| create/update | `mgmt_object:connector` / `create` (create) · `update` (update) |
| rotate secret | `mgmt_object:connector` / `update` |
| revoke | `mgmt_object:connector` / `delete` |
| get/list (status) | `mgmt_object:connector` / `read` |

`mgmt_object:connector` укладывается в открытый шаблон `mgmt_object:${string}`
(`grant-lattice.ts:33`) — **новый CHECK/enum в БД НЕ нужен**, grant-резолюция уже умеет
такие resourceType. Это и есть ответ на развилку «какой mgmt_object kind» — прецедент
T-0171/T-0191/scoped-admin даёт `mgmt_object:<entity>` напрямую.

### 4.2 Custody — verbatim T-0025 (один механизм)

`setConnector`/`rotateConnectorSecret` вызывают `validateSecretHandleShape(input.secretHandle)`
**до** любой записи (как `notification-email.ts:171`). Reject (`sk-…`/bare-hex-32+/JWT) →
`{ok:false, reason}`, **без записи, без аудита**. `getConnectorStatus`/`listConnectors`
возвращают `redactHandle(secretHandle)` (как `:288`). Импорт — из
`secret-handle-validator.ts`, **без передекларации** (FF — см. §6).

### 4.3 Audit — без секрета (T-0025 NF-1 / T-0170 §2.8)

Каждая мутация эмитит `audit_event` через канонический `AuditWriter` (T-0016) с
`subject = <connector id>`, `payload = { kind, display_name, status, backs_effect_resource_id }`.
`secret_handle` и любой resolved-секрет **НИКОГДА** не попадают в payload (точно как
`notification-email.ts:203-211` опускает `smtp_handle`). Типы событий:
`connector.set` / `connector.rotate` / `connector.revoke`.

---

## 5. Связь connector ↔ effect_resource (FR-6) и почему так

**Решение:** `connector.backs_effect_resource_id` — **nullable логическая ссылка** (uuid), **НЕ
foreign key**, и **НЕ участвует в авторизации**. Право вызвать = `invoke`-грант на
`effect_resource` (T-0034 `verifyEffectGrants`, `effect-resource.ts:194`) — этот механизм НЕ
дублируется и НЕ оборачивается. Коннектор — конфигурационная запись «чем подключаемся»;
effect_resource — грант-точка «что вызвать». Ссылка лишь декларативно фиксирует, какой
effect_resource данный коннектор бэкит (для будущего драйвера, который по `effect_resource.id`
найдёт свой коннектор).

**Почему НЕ FK:** (1) effect_resource и connector — обе tenant-RLS-таблицы; cross-table FK с
композитным `(tenant_id, id)` тянул бы составной FK и усложнял миграционный порядок без выгоды
day-1 (драйверов нет, целостность не нужна для заглушки). (2) FK создаёт жёсткую связь, тогда как
спека (§0) допускает «один или несколько effect_resource» и обратную картину — логическая ссылка
не запирает кардинальность. (3) Прецедент T-0034 сам хранит `scope`/`metadata` как opaque без
cross-FK. **Инвариант, который держим:** НЕТ `connectorRights`/`connectorAcl`/`connector_visibility`/
`_acl` — никакой второй авторизатор (fitness-бан, §6 FF-CONN-1).

---

## 6. Fitness-функции (обязательны — рубрика ось 6)

Новый чек: **`ci/checks/connector-isolation.sh`** (по образцу `effect-resource-isolation.sh` /
`notification-isolation.sh`; игнорирует комментарии, различает grep rc=1 vs rc≥2 — урок T-0143).

| ID | Правило (нарушаемая граница) | ci_check |
|---|---|---|
| **FF-CONN-1** | Нет параллельной connector-ACL / visibility-поверхности (один механизм прав = effect-грант T-0034). | `connector-isolation.sh`: grep банит токены `_acl`, `connector_visibility`, `connectorRights`, `connectorAcl` в non-comment строках `src/core/connector.ts` → 0 совпадений (AC-7). |
| **FF-CONN-2** | Pure-core / no live effects: connector core не импортирует `pg`/`fs`/`net`/`http(s)`/`fetch`/`child_process` и не делает SMTP/LDAP-вызовов. | `connector-isolation.sh`: forbidden-import grep по `src/core/connector.ts` = 0 (AC-8, AC-14, NF-5). |
| **FF-CONN-3** | Custody не передекларирована: `validateSecretHandleShape`/`redactHandle` **импортируются** из `secret-handle-validator.ts`, не объявлены заново. | `connector-isolation.sh`: `grep -E '^(export )?function (validateSecretHandleShape\|redactHandle)' connector.ts` = 0 И `grep 'from .*secret-handle-validator' connector.ts` ≥ 1 (AC-3, NF-4). |
| **FF-CONN-4** | Seam без драйвера: `ConnectorSecretResolverPort` структурно совместим с T-0025 `SecretResolverPort` под `tsc`; нет ни одного класса, implements `ConnectorDriverPort`. | `tsc --noEmit` зелёный (compile-time `_assert` как `notification-email.ts:453`); `connector-isolation.sh`: `grep 'implements ConnectorDriverPort'` в `src/` (вне типа) = 0 (AC-8). |
| **FF-CONN-5** | Closed-kind fail-closed: единственный источник истины множества `kind` — `isConnectorKind` + CHECK; нет строкового расширения. | unit-тест `setConnector({kind:'__bogus__'})` → reject, no write (AC-2); `connector-isolation.sh` проверяет, что CHECK в `migrations/054_*.sql` и union в `connector.ts` перечисляют один и тот же набор (AC-2). |
| **FF-CONN-6** | Tenant-таблица T-0013: `tenant_id` ведущий PK, ENABLE+FORCE RLS, isolation-policy, GRANT choros_app, имя в списке. | существующие `ci/checks/db/force_rls.sql` + `tenant_id_leading.sql` = 0 строк; `connector` присутствует в `ci/checks/known_tenant_tables.txt` (AC-12). |
| **FF-CONN-7** | Cross-tenant изоляция: коннектор tenant B невидим сессии tenant A. | существующий `ci/checks/db/cross_tenant.test.ts` (читает `KNOWN_TENANT_TABLES`) покрывает `connector` автоматически после добавления в список (AC-13). |
| **FF-CONN-8** | Audit без секрета: ни одно поле `audit_event`-payload в connector-пути не содержит `secret_handle`/resolved-секрет. | unit-тест по образцу T-0170 AC-6: захват `appendAuditEvent`-инпута, assert `payload` не содержит handle (AC-5, NF-1). |
| **FF-CONN-9** | T-0170 нетронут: коммит не меняет `email_channel_config`-схему, `notification-email.ts`, `notification-router.ts`, миграцию 047/T-0168. | CI/локально: `git diff dev -- migrations/047_email_channel_config.sql src/core/notification-email.ts src/core/notification-router.ts migrations/046_notification.sql` пуст (AC-9, AC-10, NF-3). |
| **FF-CONN-10** | Без driver-зависимостей: `package.json` не получает SDK 1С/AD/LDAP/SMTP/HTTP. | `git diff dev -- package.json` не добавляет driver-пакетов; `package-json-no-dup-keys.sh` зелёный (AC-15, NF-6). |

Регистрация: `connector-isolation.sh` добавляется в `npm run fitness` (как остальные
`*-isolation.sh`); `connector` дописывается в `ci/checks/known_tenant_tables.txt`. Оба — зона
`coder`/`tester`, ADR фиксирует контракт чеков.

---

## 7. Сосуществование с `email_channel_config` (AC-9..11) — почему НЕ мигрируем day-1

**Решение: сосуществование, миграция отвергнута day-1.** `connector` и `email_channel_config`
живут параллельно; T-0128 НЕ изменяет схему/код email-канала.

**Почему принудительная миграция отвергается сейчас:**
1. **Red-line задачи** (спека §6, FR-7): «НЕ ломать T-0170». T-0170 в dev, его суит зелёный;
   принудительная миграция = риск регресса работающей доставки ради косметической унификации.
2. **Разная кардинальность и форма.** `email_channel_config` = одна строка/тенант (PK=tenant_id)
   с богатой типизированной схемой (`smtp_host/port/tls/from_address/from_name/is_enabled`).
   `connector` = много строк/тенант с **opaque `config jsonb`**. Загнать email в `kind='smtp'`-
   коннектор означает либо потерять типизированные колонки (регресс валидации), либо тащить их в
   jsonb (регресс — расшатывание контракта). Это самостоятельная **дизайн-работа**, не побочный
   эффект заглушки.
3. **Принцип фаундера** (founder-autonomy: реконсиляция — шаг DoD производителя, не «агент
   заметил»): конвергенция — отдельная задача с собственным DoD/тестами миграции данных, а не
   тихий рефактор внутри T-0128.

**Путь будущей конвергенции (Stage-2 not-now, зафиксирован):** ввести `kind='smtp'` как
первокласс-коннектор, мигрировать строки `email_channel_config` → `connector` (config jsonb с
host/port/tls/from_*), переключить `EmailChannelDriver` на чтение из `connector` за тем же
`SmtpSecretResolverPort`, удалить `email_channel_config` после dual-write окна. Это **отдельная
Stage-2 задача** с миграцией данных и собственными AC — НЕ day-1.

---

## 8. Rejected alternatives

| Опция | Почему отвергнута |
|---|---|
| **Расширить `effect_resource` полями config/secret/status** (не вводить новую таблицу) | effect_resource — грант-точка «что вызвать» (T-0034), её ось `kind` (`integration_endpoint`/`messaging_channel`/`external_account`) — про *тип эффекта*, не про *тип системы* (1С/AD/SMTP). Смешение двух осей в одной таблице сломало бы closed-`EffectKind` и грант-семантику. Спека §0 прямо разделяет ответственность. |
| **FK `connector.backs_effect_resource_id → effect_resource(tenant_id,id)`** | составной cross-RLS-table FK без выгоды day-1 (драйверов нет); запирает кардинальность; усложняет миграционный порядок. Логическая ссылка достаточна для заглушки (§5). |
| **Новый тип права `connectorRights`/`connector` как объект вызова** | прямой запрет спеки (FR-6, NF-4) и инвариант gap-map §4б.2 «один механизм прав». Вызов = `invoke`-грант на effect_resource. Введение второй ACL-поверхности — fitness-бан FF-CONN-1. |
| **Принудительная миграция `email_channel_config` под коннектор day-1** | red-line «не ломать T-0170»; разная кардинальность/типизация; конвергенция = самостоятельная Stage-2 работа с миграцией данных (§7). |
| **Новый custody-механизм для connector-секрета** | спека FR-3/NF-4 «один механизм custody». Переиспользуем T-0025 verbatim (shape-guard/redact/resolver-port), как уже сделал T-0170. |
| **Postgres DAO в скоупе T-0128 (немедленно)** | спека §4 допускает отложить (T-0053-паттерн). Решение: **DAO `PgConnectorStore` в скоупе** (тонкий, по `pgEmailConfigStore.ts`) — заглушка должна реально писать/читать (AC-13 cross-tenant требует живой таблицы+DAO под RLS-тестом). Это НЕ драйвер и НЕ внешний вызов; стоимость низкая, выгода — реальная проверка изоляции. |
| **`status` с живой пробой связи day-1** | FR-4/AC-6 — статус декларативный; health-check = Stage-2. Проба = внешний вызов = нарушение NF-2. |
| **Открытый `kind` (свободный текст)** | FR-2 fail-closed; неизвестный `kind` → deny. Закрытый CHECK+union (приём T-0034 EffectKind). |

---

## 9. Decomposition (для coder/tester — порядок реализации)

| # | Артефакт | Содержание | AC |
|---|---|---|---|
| **D1** | `migrations/054_connector.sql` | таблица + CHECK(kind) + CHECK(status) + ENABLE/FORCE RLS + isolation-policy + GRANT choros_app (§3.1, verbatim шаблон 047) | AC-1, AC-12 |
| **D2** | `ci/checks/known_tenant_tables.txt` | дописать строку `connector` | AC-12, AC-13 |
| **D3** | `src/core/connector.ts` | pure-core: типы (`ConnectorKind`/`Status`/`Connector`), `isConnectorKind`/`isConnectorStatus`, порты (`ConnectorWritePort`/`ConnectorSecretResolverPort`/`ConnectorDriverPort`), CRUD-функции, импорт custody из `secret-handle-validator.ts`, compile-time `_assert` resolver-совместимости (§3.2/§4) | AC-1..AC-8 |
| **D4** | `src/core/postgres/pgConnectorStore.ts` | DAO по `pgEmailConfigStore.ts` (insert/update/get/list/delete, параметризованный SQL, GUC-RLS) | AC-13 |
| **D5** | `src/http/connectors.ts` | HTTP CRUD + PDP-gate `mgmt_object:connector` через grant-resolver T-0021 (§4.1); status-эндпоинт отдаёт `redactHandle` | AC-4, AC-5 (gate) |
| **D6** | `ci/checks/connector-isolation.sh` | FF-CONN-1..5 (ACL-бан, purity, custody-не-передекларация, seam-no-driver, closed-kind) + регистрация в `npm run fitness` | AC-7, AC-8, AC-14 |
| **D7** | `src/__tests__/connector.test.ts` | unit: closed-kind reject (AC-2), shape-guard reject raw (AC-3), redact в status/list (AC-4), audit-без-секрета (AC-5/FF-CONN-8), status декларативный + 0 внешних вызовов (AC-6) | AC-2..AC-6 |
| **D8** | cross-tenant + diff-чистота | `cross_tenant.test.ts` подхватывает `connector` авто (AC-13); проверить `git diff dev` по T-0170-путям пуст (AC-9/AC-10/FF-CONN-9) и `package.json` без driver-deps (AC-15) | AC-9, AC-10, AC-13, AC-15 |

**Driver-seam НЕ реализуется** (D-нет): `ConnectorDriverPort` — только тип; ни одного
implements, ни одного реального вызова (FR-8, NF-2, AC-8, AC-14).

---

## 10. Runtime / deploy target

**Локально / контейнер (dev-стек choros на /srv/choros)** — внешний ресурс НЕ требуется.
T-0128 = чистая модель+CRUD+миграция; никаких новых сервисов, портов, кредов, провижна. GT-4
не задействован. Миграция 054 применяется обычным `migrations/run.mjs` на dev-БД (coder/тестер).

---

## 11. Traceability (AC → место в дизайне)

| AC | Покрыто |
|---|---|
| AC-1 | §3.1 DDL + §3.2 типы (tenant_id ведущий PK, все колонки) |
| AC-2 | §3.2 `isConnectorKind` + §3.1 CHECK(kind); FF-CONN-5; D7 |
| AC-3 | §4.2 custody verbatim T-0025; FF-CONN-3; D7 |
| AC-4 | §4 `ConnectorStatusView.handleRedacted` = `redactHandle`; D5/D7 |
| AC-5 | §4.3 audit-без-секрета (типы событий); FF-CONN-8; D7 |
| AC-6 | §3.1 status декларативный (default disabled, no probe); §4 нет внешних вызовов; D7 |
| AC-7 | §5 единый механизм (invoke-грант T-0034); FF-CONN-1; D6 |
| AC-8 | §4 два seam-порта + compile-time assert; FF-CONN-2/4; D6 |
| AC-9 | §7 + FF-CONN-9 (git diff чист по T-0170); D8 |
| AC-10 | §7 + FF-CONN-9 (T-0170-суит без изменений); D8 |
| AC-11 | §7 (почему миграция отвергнута + путь конвергенции Stage-2) |
| AC-12 | §3.1 RLS-канон T-0013; FF-CONN-6; D1/D2 |
| AC-13 | §3.1 FORCE RLS + §3.2 DAO; FF-CONN-7 (cross_tenant.test.ts); D4/D8 |
| AC-14 | §4 заглушка без эффектов; FF-CONN-2; D6 |
| AC-15 | §8 без driver-deps; FF-CONN-10; D8 |
| AC-16 | §6 `tsc --noEmit` + новый чек + существующий фитнес зелёный (NF-7) |

---

## 12. Развилки фаундера

**Нет.** Спека §7 терминальна; все развилки (начальный список `kind`, форма ссылки
connector↔effect_resource, номер миграции, mgmt-объект гранта, отложить ли DAO) — зона
архитектора и решены выше из живых прецедентов T-0034/T-0025/T-0170/T-0021 без изменения
объёма/поведения продукта. Эскалация фаундеру не требуется. `status: ready`.
