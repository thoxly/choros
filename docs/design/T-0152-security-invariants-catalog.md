# T-0152 · Каталог инвариантов безопасности Choros

**Эпик:** E-VRG / T-0151 («Враг» — adversarial security-gate).
**spec-ref:** `playbooks/enemy-redteam-backlog.md#4` (репо Demiurge).
**Тип:** design / консолидация. Этот документ **ничего не вводит нового** — он
сводит уже существующие CI-checks, fitness-проверки, миграции и adversarial-тесты
в один явный каталог «чего не должно случиться», привязывая каждый инвариант к
коду/проверке, которые его удерживают.

> Этот файл — артефакт-каталог. По §7 спеки он подлежит заморозке вместе с
> корпусом Врага (расширение `frozen-checks-immutable`, задача T-0155): правки
> только founder-gated, append-only. Сейчас он НЕ заморожен (frozen-мета-гейт
> `ci/checks/frozen-checks-immutable.sh` сторожит `ci/checks/*.sh`, не `docs/`);
> заморозка каталога — явная под-задача T-0155.

---

## 0. Как читать каталог

Каждая семья инвариантов описана как:

- **Инвариант** — точная формулировка «чего не должно случиться».
- **Enforced by** — конкретные файлы/проверки/тесты (с путями), удерживающие его.
- **Тип контроля** — `static` (grep/structure-линтер в `npm run fitness`),
  `runtime` (vitest против живого Postgres/Keycloak/Flowable), `both`, или
  `doc-only` (заявлено в ADR, но без активной проверки).
- **Gap / coverage** — честная оценка: где контроль сильный, где слабый,
  дублирующий или отсутствует. **Gap-строки — главный выход документа**: они
  становятся таргетами для adversarial-тестов Врага.

Условные обозначения покрытия: **STRONG** (static + runtime, есть негативный/
adversarial кейс), **PARTIAL** (только static ИЛИ только runtime, или нет
прямого negative-теста), **WEAK** (косвенно / дублирующе / только doc).

Реестр прогонов: `npm run fitness` (static-сюита, см. `package.json:13`),
`npm run fitness:db` (runtime DB, vitest `ci/checks/db/`),
`fitness:kc` / `fitness:flowable*` / `fitness:seed` / `fitness:demo*` (live-гейты).

---

## 1. TENANT-ISO — изоляция тенантов

**Инвариант.** Сессия/запрос в контексте тенанта A никогда не может прочитать,
изменить или удалить строки тенанта B (cross-tenant IDOR). Каждая
tenant-несущая таблица — под `FORCE ROW LEVEL SECURITY` с `tenant_id` ведущей
колонкой; роль приложения `choros_app` не имеет `BYPASSRLS`; только мигратор/
владелец таблицы видит сквозь RLS.

**Enforced by.**

- **RLS в DDL (static + structural):** 22 миграции с `FORCE ROW LEVEL SECURITY`,
  напр. `migrations/008_grant.sql`, `migrations/006_audit_event.sql`,
  `migrations/013_tenant.sql`, `migrations/017_data_classification.sql`,
  `migrations/038_egress_policy.sql`. Реестр tenant-несущих таблиц:
  `ci/checks/known_tenant_tables.txt`. SQL-инварианты:
  `ci/checks/db/force_rls.sql`, `ci/checks/db/tenant_id_leading.sql`.
- **Static fitness-гейт:** `ci/checks/cross-tenant-fitness.sh` (T-0115) — требует,
  чтобы runtime-тест читал `KNOWN_TENANT_TABLES` (анти-хардкод), использовал
  `appUrl()` для cross-tenant запросов и `migratorUrl()` для проверки (role
  discipline), и чтобы `fitness:db` был зарегистрирован блокирующим джобом в
  `.github/workflows/ci.yml`.
- **Runtime negative-тесты (vitest, живой PG):** `ci/checks/db/cross_tenant.test.ts`,
  `ci/checks/db/two_tenant.test.ts` — под ролью `choros_app` запрос из контекста A
  обязан вернуть 0 строк B; `ci/checks/db/schema.test.ts` проверяет, что каждая
  tenant-таблица реально `FORCE`-нута.
- **Per-module isolation (static, десятки):** `*-isolation.sh` гарантируют, что
  модули не открывают второй путь к данным мимо RLS (напр.
  `effect-resource-isolation.sh`, `data-classification-isolation.sh`,
  `named-binding-isolation.sh`, `object-handle-isolation.sh`,
  `report-page-render-isolation.sh`, `notification-isolation.sh`).
- **known_tenant_tables реестр-гейты (additive-scope, T-0241):** следующие
  проверки верифицируют, что их соответствующая фича не добавляет новых
  tenant-таблиц (вторичная перекрёстная проверка реестра):
  `ci/checks/role-criticality-isolation.sh`,
  `ci/checks/docs-author-seed.sh`,
  `ci/checks/dual-control-isolation.sh`,
  `ci/checks/docpage-writeful-tools.sh`,
  `ci/checks/grant-trail-no-new-table.sh`,
  `ci/checks/tier-isolation.sh`,
  `ci/checks/isolated-env-isolation.sh` (T-0252: IE-8 verifies the 072 escalation
  is an additive ADD COLUMN, not a new tenant table),
  `ci/checks/defer-no-new-table.sh` (T-0252: Check-1/Check-2 verify the T-0221
  defer-inbox feature adds no new tenant table / migration).
- **Демо/seed cross-tenant:** `ci/checks/demo/no-cross-tenant-org.sh` (live DB),
  `ci/checks/demo/no-hardcoded-tenant.sh`.

**Тип контроля:** both. **Покрытие: STRONG.**

**Gap / coverage.**
- Сильнейшая семья: static-анти-хардкод + runtime negative-кейс + DDL-инвариант.
- **Gap-1 (для Врага):** runtime cross-tenant негатив есть только для горстки
  таблиц (`cross_tenant.test.ts` / `two_tenant.test.ts`), тогда как
  `FORCE RLS` объявлен на 22. Static-гейт проверяет *наличие* `FORCE` в DDL, но
  **не** прогоняет реальный cross-tenant запрос против каждой из 22 таблиц.
  Враг должен фаззить cross-tenant чтение/запись по **всем** строкам
  `known_tenant_tables.txt`, а не только по покрытым в двух тестах.
- **Gap-2:** изоляция на уровне HTTP-роутов (IDOR через API, а не через SQL)
  не имеет единого негативного корпуса — `*-isolation.sh` статичны (проверяют
  структуру модуля, не поведение). Кандидат на арена-атаку Врага.

---

## 2. PDP-DENY — deny-by-default авторизация

**Инвариант.** Решающий орган доступа (PDP) — единственный
`grant-resolver` — никогда не возвращает `allow` там, где должен `deny`;
`deny-all` остаётся дефолтом; безопасный `denyAllResolver` не подменяется
правкой кода (его место в композиционном корне свопится только через
объявленный T-0015 seam с неизменной сигнатурой порта).

**Enforced by.**

- **Источник (PDP-ядро):** `src/core/grant-resolver.ts` — чистый TS, deny-all
  дефолт, документированный seam «swaps in for `denyAllResolver`, never by
  editing» (строки 10, 735, 741–743).
- **Single-resolver chokepoint (static):** `ci/checks/single-resolver.sh`
  (FF-A5) — единственная точка резолюции.
- **Resolver isolation (static):** `ci/checks/grant-resolver-isolation.sh`
  (FF-R6 + аддитивность FF-R5) — «no-second-subsystem».
- **Registry-defs PDP-гейт (static):** `ci/checks/registry-defs-pdp-isolation.sh`
  (T-0191).
- **Runtime-тесты:** `src/__tests__/grant-resolver.test.ts` (поведение PDP),
  `src/__tests__/grant-lattice.adversarial.test.ts` (см. GRANT-ESCALATION).

**Тип контроля:** both. **Покрытие: PARTIAL.**

**Gap / coverage.**
- Static-броня против структурной подмены (single resolver, isolation) — сильная.
- **Gap-3 (для Врага):** нет выделенного `ci/checks/*` с именем PDP-DENY,
  который прогонял бы **матрицу negative-решений** (для каждой пары
  subject×resource, где политика обязана `deny`, PDP вернул `deny`). Поведенческое
  покрытие живёт в `grant-resolver.test.ts` как обычный unit-тест, не как
  frozen-инвариант. Это первая цель корпуса Врага: deny-матрица + фаззинг
  правил, в т.ч. «правка кода ослабила дефолт на allow».
- **Gap-4:** «`denyAllResolver` не подменён» гарантируется *дисциплиной seam*,
  а не проверкой — нет гейта, который бы падал, если композиционный корень
  начнёт отдавать `allow`-резолвер по умолчанию. Кандидат на frozen-инвариант.

---

## 3. DEV-AUTH-PROD — dev-аутентификация не доезжает в prod

**Инвариант.** В production `CHOROS_AUTH_MODE != 'dev'`; заголовок-заглушка
`x-dev-user` не принимается; prod-стек поднимает Keycloak в режиме `start`
(не `start-dev`); единственная точка ветвления на режим — `authenticate()` в
`src/http/auth.ts`.

**Enforced by.**

- **Источник:** `src/http/auth.ts` — один branching point `authenticate()` на
  `CHOROS_AUTH_MODE`; в `keycloak`-режиме `x-dev-user` игнорируется, требуется
  Bearer JWT (строки 393–403, 476+); `DEV_USER_HEADER` объявлен явно.
- **Single-branch (static):** `ci/checks/worker-auth-single-branch.sh` (FF-3,
  AC-17) — `grep CHOROS_AUTH_MODE` ≤ 2 совпадений; внешний воркер не ветвится.
- **Seam-гейт (static):** `ci/checks/kc/auth-mode-seam.sh` (FF-10) — переменная
  читается в `auth.ts`, дефолт `dev`.
- **Prod-конфиг (static):** `ci/checks/compose-prod-config.sh` (T-0061,
  FF-T61-1..11) — prod-overlay Keycloak использует `start` (FF-T61-9, AC-9),
  prod volumes с суффиксом `_prod`, нет `${VAR:-default}` для секретов.
- **Прочее:** `ci/checks/worker-auth-config-failfast.sh` (fail-fast валидация),
  `ci/checks/worker-auth-public-surface.sh`, `ci/checks/worker-auth-zero-dep.sh`,
  `ci/checks/worker-auth-env-docs.sh`.
- **Live-KC (runtime):** `fitness:kc` — `ci/checks/kc/realm-ready.sh`,
  `kc/human-token.sh`, `kc/agent-token.sh`, `kc/jwt-claims.sh`: реальный OIDC,
  токены и claims против живого Keycloak.

**Тип контроля:** both. **Покрытие: PARTIAL.**

**Gap / coverage.**
- Static-цепочка вокруг compose/seam/single-branch — сильная; live-KC доказывает,
  что keycloak-путь реально работает.
- **Gap-5 (для Врага):** нет **runtime negative**-теста «сервер в
  `CHOROS_AUTH_MODE=keycloak` получает запрос с `x-dev-user` и без JWT → 401».
  Игнор dev-заголовка в prod-режиме держится чтением исходника, не поведенческим
  кейсом. Первичная цель арены Врага: поднять стек в keycloak-режиме и попытаться
  залогиниться dev-заголовком.
- **Gap-6:** инвариант «в *prod* mode != dev» проверяется только косвенно (через
  compose-overlay `start` и отсутствие dev-дефолтов). Нет проверки, которая бы
  падала, если prod-overlay явно выставит `CHOROS_AUTH_MODE=dev`.

---

## 4. AUDIT-APPEND — append-only аудит с целостной hash-chain

**Инвариант.** `audit_event` пишется только через `INSERT` (никаких
`UPDATE`/`DELETE`); hash-chain цела и непрерывна; нет глобального seq (порядок
per-tenant); канонический writer сериализует запись per-tenant (`FOR UPDATE`);
тот же контракт для `actor_event` ledger.

**Enforced by.**

- **Источник:** `src/db/audit-writer.ts` (только INSERT, hash-chain, per-tenant
  `FOR UPDATE`); DDL `migrations/006_audit_event.sql`, `migrations/007_audit_head.sql`,
  `migrations/018_actor_event.sql`.
- **Static (audit):** `ci/checks/audit_append_only.sh` (FF-APPEND, AC-12 / T-0016 §4.6),
  `ci/checks/audit_no_global_seq.sh` (FF-2, per-tenant сериализация),
  `ci/checks/audit_actor_type_set.sh` (FF-8, проекция actorType = {human,agent,service}),
  `ci/checks/audit_writer_isolation.sh` (FF-11, ядро аудита PURE).
- **Static (actor_event ledger):** `ci/checks/actor_event_append_only.sh` (FF-4),
  `ci/checks/actor_event_no_global_seq.sh` (FF-6, per-tenant ordinal),
  `ci/checks/actor_event_vocab_pinned.sh` (FF-16 + структурные линты).
- **Runtime (vitest):** `ci/checks/db/audit-writer.chain.test.ts` (целостность
  hash-chain против живого PG), `ci/checks/db/actor-event.test.ts`.

**Тип контроля:** both. **Покрытие: STRONG.**

**Gap / coverage.**
- Семья с двойным контролем (static DDL + runtime chain) и явным ledger-зеркалом.
- **Gap-7 (для Врага):** runtime-кейс проверяет *построение* цепи; нет
  adversarial-кейса «попытка `UPDATE`/`DELETE` под ролью `choros_app` →
  отклонено правами/триггером» и «вставка с подделанным prev-hash → детектится
  при чтении». Враг должен атаковать tamper-detection, а не только happy-path
  построения цепи.

---

## 5. GRANT-ESCALATION — нет прав сверх выданной решётки

**Инвариант.** Субъект не получает прав сверх явно выданной grant-lattice
(confused-deputy, обход scoped-admin, эскалация через grant-editor/propose/preset
или через grant-trail с BYPASSRLS-ролью). Делегирование админ-прав проходит
gate-order до выдачи; identity невидима слою прав.

**Enforced by.**

- **Источник:** `src/core/grant-lattice.ts`, `src/core/scoped-admin.ts`,
  `src/core/grant-resolver.ts`; DDL `migrations/008_grant.sql`,
  `migrations/020_role_assignment.sql`, `migrations/027_sod_constraint.sql`.
- **Adversarial runtime (vitest):**
  `src/__tests__/grant-lattice.adversarial.test.ts`,
  `src/__tests__/scoped-admin.adversarial.test.ts`,
  `src/__tests__/grant-trail.adversarial.test.ts`,
  `ci/checks/db/grant-editor.adversarial.test.ts`.
- **Static isolation:** `ci/checks/scoped-admin-isolation.sh` (T-0029,
  no-second-subsystem), `ci/checks/grant-editor-isolation.sh`,
  `ci/checks/grant-propose-isolation.sh` (T-0039),
  `ci/checks/grant-presets-isolation.sh`, `ci/checks/sod-isolation.sh` (T-0032),
  `ci/checks/role-criticality-isolation.sh` (T-0040),
  `ci/checks/invoke-grant-isolation.sh` (T-0024),
  `ci/checks/substitution-isolation.sh` (T-0035, `grant-resolver.ts` import-
  surface + migration-seam guard for the Tier-2 substitution grant path).
- **Grant-trail BYPASSRLS guard:** `ci/checks/grant-trail-bypassrls-predicate.sh`
  (T-0184) — `queryGrantTrail` обязан нести явный `WHERE tenant_id = $N` (защита
  от того, что pool-роль с BYPASSRLS читает чужой trail); источник
  `src/db/audit-grant-trail.ts`; runtime `ci/checks/db/grant-trail-pool-role.test.ts`.
- **Agent-hire gate-order:** `ci/checks/agent-hire-gate-order.sh` (FF-HIRE-1,
  `validateAdminDelegation` до выдачи), `ci/checks/agent-hire-no-second-authority.sh`,
  `ci/checks/agent-hire-identity-isolation.sh`.
- **Dual-control / SoD:** `ci/checks/dual-control-isolation.sh` (T-0044),
  `ci/checks/db/sod.test.ts`, `ci/checks/db/dual-control.gate.e2e.test.ts`.

**Тип контроля:** both. **Покрытие: STRONG** (единственная семья с
существующим adversarial-корпусом — 4 `.adversarial.test.ts`).

**Gap / coverage.**
- Лучше всех укомплектована: уже есть adversarial-тесты + статическая
  no-second-subsystem броня + BYPASSRLS-предикат.
- **Gap-8 (для Врага):** adversarial-кейсы фиксированы (написаны вручную под
  известные классы). Это идеальный seed-корпус для coverage-guided мутации Врага
  (§6 спеки) — варьировать существующие атаки и искать соседние непокрытые
  классы (напр. эскалация через цепочку delegation→preset→propose).

---

## 6. NO-SECRET — секреты не утекают в код/конфиг/seed

**Инвариант.** Секреты (пароли prod, токены, приватные ключи) не попадают в
коммит — ни в compose, ни в миграции, ни в seed/realm/TS-источник; разрешены
только явные dev-дефолты-плейсхолдеры.

**Enforced by.**

- **Static (корень):** `ci/checks/no-committed-secret.sh` (FF-1, AC-1 / RL-1 /
  NF-5) — compose использует env-дефолты, разрешены только `choros_dev_pw` /
  `choros_app_dev_pw`; миграции не несут не-dev паролей.
- **Static (prod compose):** `ci/checks/compose-prod-config.sh` — `.env.prod` в
  `.gitignore`, `.env.prod.example` только с `REPLACE_*`, нет
  `${VAR:-default}` для PASSWORD/SECRET/TOKEN/KEY.
- **Static (Keycloak):** `ci/checks/kc/no-prod-secret.sh` (FF-11) — нет prod-
  credential в TS, `DEV ONLY` метка в realm JSON, compose в форме `${VAR:-default}`.
- **Static (seed):** `ci/checks/seed/no-seed-secret.sh` (FF-3).
- **Secret-custody / handle (BYO-LLM):** `ci/checks/secret-handle-isolation.sh`
  (T-0025, FF-25-1..6) + runtime `ci/checks/db/secret-handle.test.ts`,
  `ci/checks/keyed-digest-core-purity.sh` (T-0143, нет `process.env` в маскирующих
  модулях), `ci/checks/no-env-in-core.sh` (T-0163, нет `process.env` в `src/core/`).

**Тип контроля:** both (static-сканеры + runtime secret-handle). **Покрытие: PARTIAL.**

**Gap / coverage.**
- Сильно по *committed* секретам (несколько перекрывающих сканеров) и по
  custody-модели секрет-хэндлов.
- **Gap-9 (для Врага):** покрыт «секрет в коммите», но **не** «секрет утёк в
  лог / в API-ответ / в сообщение об ошибке» в рантайме (спека §4: «не утекают
  в код/логи/ответы»). Нет проверки, которая ловит секрет в выводе. Цель Врага:
  фаззить ответы/логи на признаки секрет-материала.
- **Gap-10:** сканеры эвристические (списки allowed-дефолтов, regex по ключам
  password/secret) — обходятся нестандартным именованием поля. Кандидат на
  усиление + adversarial-проверку обхода.

---

## 7. Дополнительные инварианты, найденные в коде (за рамками 6 названных)

Эти семьи реально энфорсятся и должны войти в корпус Врага:

### 7.1 OBJECT-HANDLE-ISO — хэндлы привязаны к UUID, не пересекают тенанты
- **Инвариант:** хэндл биндится к UUID (не slug) и никогда не cross-tenant;
  payload записи не лежит в process-переменной движка.
- **Enforced by:** `ci/checks/handle-uuid-binding.sh` (FF-A6),
  `ci/checks/object-handle-isolation.sh` (FF-A3),
  `ci/checks/no-record-in-variable.sh` (FF-A4); DDL `migrations/009_object_handle.sql`.
- **Покрытие: PARTIAL** (static only; нет runtime cross-tenant handle-теста).

### 7.2 AUDIT-NO-GLOBAL-SEQ / SINGLE-RESOLVER — единые чокпоинты
- Покрыто внутри AUDIT-APPEND (§4) и PDP-DENY (§2); вынесено как отдельные
  frozen-инварианты `single-resolver.sh`, `audit_no_global_seq.sh`,
  `actor_event_no_global_seq.sh`.

### 7.3 NO-KILLSWITCH-IN-CORE — нет kill-switch в ядре (RED-LINE)
- **Инвариант:** в `src/core/` нет kill-switch/«заложника»; entitlement-гейты
  только на vendor-эндпоинтах; активация offline и zero-dep.
- **Enforced by:** `ci/checks/no-killswitch-in-core.sh` (T-0198, FF-T127-1,
  RED-LINE, есть `--self-test`), `ci/checks/entitlement-gates-vendor-only.sh`,
  `ci/checks/activation-verifier-offline.sh`, `ci/checks/activation-config-pubkey-only.sh`.
- **Покрытие: PARTIAL** (static + self-test; политический red-line из
  лицензионной модели, держится grep'ом).

### 7.4 EGRESS-POLICY-ISO — исходящий трафик под политикой
- **Enforced by:** `ci/checks/egress-policy-isolation.sh` (T-0041, FF-EP1..7);
  DDL `migrations/038_egress_policy.sql`. **Покрытие: PARTIAL** (static).

### 7.5 FROZEN-CHECKS-IMMUTABLE — мета-инвариант (конституция не ослабляется)
- **Инвариант:** task-ветка не может править/удалять *чужой* `ci/checks/*.sh`;
  ослабление гейта = FAIL; исключение только через append-only founder-санкции.
- **Enforced by:** `ci/checks/frozen-checks-immutable.sh` (T-0146, FF-FCI1..FF-FCI12),
  founder-санкции `ci/checks/data/frozen-sanctions.jsonl` (T-0199, append-only).
- **Покрытие: STRONG** (есть hostile-probe self-tests FF-FCI9/10).
- **Связь с Врагом:** именно сюда T-0155 подвесит **сам этот каталог + корпус
  Врага**, чтобы Демиург (который пишет и Choros, и Врага) не мог Врага ослабить.

---

## 7.6 T-0253 · ВРАГ — 6 in-process adversarial-семей (STRICTLY ADDITIVE)

Шесть новых семей, которые детерминированный Враг (T-0154) теперь фаззит
**в процессе** (seeded LCG, без DB/часов/сети) против НАСТОЯЩИХ Choros-предикатов,
закрывая gap'ы §2/§5/§6/§7.3. Все они аддитивны: Враг становится только сильнее
(ни один существующий предикат/self-test/frozen-check не ослаблен). Каждая семья
несёт свой broken-surface self-test (Враг обязан укусить) и ≥1 вечный
corpus-кейс (`src/__tests__/enemy/corpus/corpus.jsonl`, append-only).

### 7.6.1 PRECHECK-DEFAULT — classifyOutcome не «proceed» при сомнении
- **Инвариант:** `classifyOutcome` (`src/core/agent-precheck-motor.ts`) возвращает
  `proceed` ТОЛЬКО когда ВСЕ гейты зелёные (INV-DEFAULT: fail-closed > defer >
  proceed никогда не схлопывается в proceed при сомнении).
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья
  PRECHECK-DEFAULT), `ci/checks/precheck-no-reasoning-egress.sh`. **Покрытие: STRONG**
  (fuzz + broken self-test = классификатор, который «proceed» при сомнении).

### 7.6.2 REASONING-EGRESS — reasoning не утекает наружу (D-139)
- **Инвариант:** для любого `LlmResult` с reasoning-текстом возвращаемый
  `PrecheckOutcome` из `src/runtime/legal-precheck/run-precheck.ts` НЕ содержит
  ни одной подстроки reasoning (reasoning только как opaque `reasoning_trace_ref`).
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья
  REASONING-EGRESS), `ci/checks/precheck-no-reasoning-egress.sh`. **Покрытие: STRONG**
  (inject LlmPort-stub + substring-scan; broken self-test = egress, утекающий reasoning).

### 7.6.3 FIELD-MASK — системные поля не пишутся vendor-admin'ом
- **Инвариант:** любой casing/whitespace/alias/duplicate-вариант `circuit_id` или
  `activation_key_issued_at`, разрешающийся в system-only поле, отклоняется
  `checkWriteMask` (`src/runtime/customer-onboarding/field-mask-guard.ts`,
  `SYSTEM_ONLY_FIELDS`).
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья FIELD-MASK),
  `ci/checks/field-mask-hookpoint.sh`. **Покрытие: STRONG** (fuzz-варианты +
  broken self-test = маска, разрешающая по substring).

### 7.6.4 STATUS-TRANSITION — замороженная таблица переходов; archived терминален
- **Инвариант:** `isAllowedTransition`/`CUSTOMER_TRANSITIONS`
  (`src/core/customer-subscription/status-model.ts`) совпадает с замороженной
  таблицей на ВСЕХ парах from×to; `archived→*` всегда false.
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья
  STATUS-TRANSITION), `ci/checks/no-killswitch-in-crm.sh`. **Покрытие: STRONG**
  (полный from×to + broken self-test = таблица, переоткрывающая archived).

### 7.6.5 DORMANT-GATE — liveEnabled=false выбирает dormant-порт
- **Инвариант:** `runIssueKey` (`src/runtime/customer-onboarding/issue-key.ts`) с
  LIVE-успешным entitlement-адаптером, но `liveEnabled=false`, ВЫБИРАЕТ dormant-порт
  (нет live-issuance; audit=`customer.key_issue_failed`, никогда `key_issued`).
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья
  DORMANT-GATE), `ci/checks/entitlement-gates-vendor-only.sh`. **Покрытие: STRONG**
  (inject ports + in-memory audit; broken self-test = gate, чтущий live при dormant).

### 7.6.6 PDP-DENY-MATRIX — deny-матрица + denyAll-дефолт (Gap-4)
- **Инвариант:** для каждой ячейки subject×resource×op без покрывающего гранта PDP
  (`resolveFor`) отдаёт `no_grant`; композиционный дефолт-резолвер identity-равен
  `denyAllResolver` (`src/core/object-handle.ts`) — нет allow-by-default подмены.
- **Enforced by:** `src/__tests__/enemy/enemy.adversarial.test.ts` (семья
  PDP-DENY-MATRIX), `ci/checks/single-resolver.sh`,
  `ci/checks/grant-resolver-isolation.sh`. **Покрытие: STRONG** (exhaustive deny-matrix
  + root-identity; broken self-test = allow-by-default матрица + не-denyAll дефолт).

### 7.7 ACTOR-ACTIVE — деактивированный сотрудник теряет authority на READ-путях
- **Инвариант:** ни один employee actor-slug lookup, питающий grant/role/owner/
  admin-решение, не возвращает результат для деактивированного сотрудника
  (`employee.deactivated_at IS NOT NULL`) — держатель уже живого access-JWT
  (offline-JWKS, остаточное окно ~300s, T-0702) теряет ЛЮБУЮ ролевую/грантовую
  authority сразу после деактивации, а не только после истечения токена.
- **Enforced by:** `ci/checks/actor-authority-deactivation-gate.sh` (T-0662,
  FF-0662-1 предикат-покрытие 7 зарегистрированных `AUTHORITY_RESOLVERS` +
  FF-0662-2 accounting-скан ВСЕХ employee actor-lookup'ов в `src/db`+`src/http`),
  `ci/checks/actor-active-route-coverage.sh` (T-0726, FF-726-1, informational —
  route→resolver reachability на ВСЕХ GET-роутах); источник предиката
  `src/db/actor-authority-gate.ts` (`ACTOR_ACTIVE_SQL = "deactivated_at IS NULL"`).
- **Runtime (vitest, живой PG):** `ci/checks/db/org-admin-deactivation.db.test.ts`,
  `ci/checks/db/grants-dao-deactivated.db.test.ts`,
  `ci/checks/db/grants-dao-subject-deactivation.db.test.ts`,
  `ci/checks/db/grants-dao-role-slug-deactivation.db.test.ts` (T-0738 —
  `getRoleSlugsForActor`, обе выборки: primary + T-0366 fallback),
  `ci/checks/db/rights-change-requests-deactivated-approver.db.test.ts`,
  `ci/checks/db/audit-route-deactivation-gate.db.test.ts`,
  `ci/checks/db/org-tree-deactivated.db.test.ts`.
- **Покрытие: STRONG** (static registry + accounting-скан двойного слоя + 7
  независимых live-PG adversarial файлов, каждый со своим позитив-контролем).
- **История / gap:** T-0658 нашёл 5 bespoke-резолверов без предиката
  (whack-a-mole, grep-ripple по одному имени пропускает остальные); T-0662
  механизировал реестр (структурный анти-рецидив, FF-0662-1/2); T-0721/T-0736/
  T-0737/T-0738/T-0739 закрыли READ-поверхность роут-за-роутом (находки
  обнаруживал T-0726); T-0740 реконсилировал маркер-реестр `ACTIVE_MARKERS`
  (T-0726) с `AUTHORITY_RESOLVERS`/предикатом (T-0662) — см.
  `docs/tasks/T-0740.adr.md`. **Остаточный known gap:** `GET /api/inbox/:id`
  (T-0738 ADR §4) не вызывает authority-резолвер вовсе — tenant-open-by-
  construction для ЛЮБОГО актора (не специфично для деактивации), отдельный
  вопрос от этой семьи, не закрыт.

---

## 8. Сводная таблица покрытия

| # | Семья | Static | Runtime | Adversarial-кейс | Покрытие | Главный gap → задача Врага |
|---|-------|:------:|:-------:|:----------------:|----------|----------------------------|
| 1 | TENANT-ISO | ✅ много | ✅ (2 табл.) | — | STRONG | runtime cross-tenant по ВСЕМ 22 таблицам + HTTP-IDOR (Gap-1/2) |
| 2 | PDP-DENY | ✅ | ✅ unit | частично | PARTIAL | deny-матрица как frozen-инвариант + «denyAll не подменён» (Gap-3/4) |
| 3 | DEV-AUTH-PROD | ✅ | ✅ live-KC | — | PARTIAL | runtime «x-dev-user в keycloak-mode → 401» (Gap-5/6) |
| 4 | AUDIT-APPEND | ✅ | ✅ chain | — | STRONG | tamper-detection: UPDATE/DELETE + подделка prev-hash (Gap-7) |
| 5 | GRANT-ESCALATION | ✅ много | ✅ | ✅ 4 теста | STRONG | мутация существующих adversarial-кейсов (seed-корпус, Gap-8) |
| 6 | NO-SECRET | ✅ много | ✅ handle | — | PARTIAL | секрет в логах/ответах (рантайм) + обход эвристик (Gap-9/10) |
| 7.1 | OBJECT-HANDLE-ISO | ✅ | — | — | PARTIAL | runtime cross-tenant handle-резолв |
| 7.3 | NO-KILLSWITCH | ✅ + self-test | — | — | PARTIAL | red-line, проверяется grep'ом |
| 7.4 | EGRESS-POLICY | ✅ | — | — | PARTIAL | runtime-проверка политики egress |
| 7.5 | FROZEN-CHECKS | ✅ + probe | — | hostile-probe | STRONG | держит конституцию; T-0155 вешает сюда каталог |
| 7.7 | ACTOR-ACTIVE | ✅ registry+accounting | ✅ 7 live-PG | — | STRONG | route-coverage (T-0726) informational остаток (`GET /api/inbox/:id`, T-0738 ADR §4) — отдельный follow-up |

---

## 9. Выводы для эпика Врага

**Что реально защищено сегодня (не трогать, использовать как регрессию):**
GRANT-ESCALATION (4 adversarial-теста), TENANT-ISO (static анти-хардкод +
runtime), AUDIT-APPEND (static + chain), FROZEN-CHECKS (hostile-probe).

**Где «заявлено, но энфорс слабый» — приоритет корпуса Врага (по убыванию ценности):**

1. **DEV-AUTH-PROD (Gap-5):** нет runtime-кейса, что prod игнорирует `x-dev-user`.
   Самый опасный класс из §1 спеки («оставляет dev-auth включённым в prod»).
2. **PDP-DENY (Gap-3/4):** поведенческая deny-матрица — обычный unit, не
   frozen-инвариант; «denyAll не подменён» держится дисциплиной, не проверкой.
3. **TENANT-ISO (Gap-1):** runtime cross-tenant негатив покрывает 2 из 22 таблиц;
   HTTP-IDOR не покрыт негативным корпусом.
4. **AUDIT-APPEND (Gap-7):** нет tamper-detection кейса (UPDATE/DELETE/подделка hash).
5. **NO-SECRET (Gap-9):** утечка в логи/ответы рантайма не покрыта.

Эти пять gap'ов — прямой seed для append-only корпуса Врага (T-0154) и его арены
(T-0153). Каждый закрытый gap → новый вечный регрессионный кейс (§6 спеки).

---

## Приложение A — реестр прогона проверок

- Static-сюита: `package.json` → `npm run fitness` (один длинный `&&`-конвейер).
- Runtime DB: `npm run fitness:db` → `vitest run --dir ci/checks/db`.
- Live-гейты: `fitness:kc`, `fitness:flowable`, `fitness:flowable:ext`,
  `fitness:flowable:bridge`, `fitness:seed`, `fitness:demo`, `fitness:demo:db`.
- Полный CI: `npm run ci` = `tsc --noEmit && eslint src && npm run fitness && vitest run`.
- Adversarial-тесты (vitest, в общем прогоне `vitest run`):
  `src/__tests__/*.adversarial.test.ts`, `ci/checks/db/grant-editor.adversarial.test.ts`.
