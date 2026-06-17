# T-0242 — Vendor entitlement layer: producer-side (ADR)

> Фаза: DESIGN (architect). Статус: **ready**.
> Вход: `docs/specs/T-0242-vendor-entitlement.spec.md` (status=ready, AC-1..AC-15).
> Зависимости: T-0127 (genesis-installer ADR — формат `choros-key.v1`, red-line
> «revoke ≠ halt»), T-0198 (consumer-сторона: `src/vendor/activation.ts`
> `verifyKey`/`canonicalPayloadBytes`, FF-T127-1, FF-T127-4).
> Публичный шов: T-0244 (consumer-onboarding process) вызывает `issueEntitlement`.
> Память: `choros-licensing-model.md` (фаундер: «ключ = сервис, не заложник»).

---

## 0. Решения фаундера, в рамках которых проектируем (НЕ re-litigate)

- Ключ продаёт СЕРВИС (updates + agentic_ops + support), не держит заложником.
- `revoke ≠ halt`: отзыв = смена `status` в записи; физические wire-ключи доживают
  `not_after` в автономном режиме. Kill-switch запрещён (red-line T-0127).
- Единый chokepoint `issueEntitlement` + тонкие адаптеры (CLI сейчас, billing/SaaS
  потом — заменой адаптера, не правкой ручки).
- Dogfood: пилоты через НАСТОЯЩИЙ механизм с day-1 (не байпас).
- Product-feature/seat-гейтинг — ВНЕ скоупа (противоречит red-line).

Эти развилки сняты; дизайн их не переоткрывает.

---

## 1. Решение (decision)

Строим producer-половину как **тонкое вендорское ядро** `src/vendor/issuance.ts`
с четырьмя чистыми функциями над одним источником истины `LicenseRecord` и
тонким CLI-адаптером. Подпись переиспользует уже экспортированный
`canonicalPayloadBytes` из `src/vendor/activation.ts` — байт-в-байт тот же
canonical-JSON, что верифицирует consumer; signing = `node:crypto` Ed25519,
zero-dep. Источник истины `LicenseRecord` хранится в **отдельном вендорском
datastore-порте** (НЕ в multi-tenant `migrations/`-субстрате choros) —
инъектируемый `LicenseStore`-порт, чтобы CLI/тест ходили в file/SQLite-бэкенд,
а Stage-2 SaaS — в свой стор, без изменения ручки.

### 1.1 Ключевое архитектурное решение: vendor-store ВНЕ tenant-migrations

**Проблема, найденная в дизайне (отклонение от §5 спеки):** спека предлагает
`migrations/073_vendor_license_record.sql` с `CREATE TABLE`. Но в choros живёт
ратифицированный freeze-инвариант **FF-0031-06** (`grant-trail-no-new-table.sh`,
Check-2): любая миграция ≥031 с `CREATE TABLE` = FAIL. Плюс `known_tenant_tables.txt`
+ Check-1 (FF-0031-05) фиксируют реестр **tenant-таблиц** под RLS. `LicenseRecord`
семантически **НЕ tenant-таблица**: у неё нет `tenant_id`, нет per-tenant RLS, она
живёт в вендорском контуре, а не в клиентском силосе. Класть её в `migrations/073`
значит либо нарушить FF-0031-06 (CREATE TABLE), либо протащить вендорскую запись
в tenant-реестр (ложная классификация, размывает RLS-инвариант).

**Решение:** `LicenseRecord` — это **вендорский ledger вне клиентского контура**
(NF-2/NF-7). Он НЕ кладётся в `choros/migrations/` и НЕ регистрируется в
`known_tenant_tables.txt`. Producer-слой обращается к нему через инъектируемый
порт `LicenseStore` (интерфейс CRUD по `circuit_id`). MVP-реализация порта —
файловый JSON-ledger (`InMemory`/`FileLicenseStore`) под путь, заданный
оператором (gitignored, вендорская машина); схема store — вне tenant-DDL.
Stage-2 SaaS подменит реализацию порта своим стором. Это:
- сохраняет FF-0031-05/06 зелёными без правки чужих чеков (AC-12/AC-13 косвенно,
  и не ломает T-0031-владельца);
- честно отражает red-line: вендорская запись физически вне клиентского контура;
- делает ручку тестируемой без поднятия Postgres (чистый порт + фейк).

Если фаундер позже захочет именно Postgres-таблицу для вендор-ledger — это
ОТДЕЛЬНАЯ вендорская БД/схема со своим миграционным трактом (НЕ `choros/migrations/`,
которые суть tenant-субстрат). Это Stage-2 store-адаптер, не MVP.

### 1.2 Поверхность (src/vendor/issuance.ts)

```
// порт стора (инъектируется — composition root передаёт реализацию)
interface LicenseStore {
  getByCircuit(circuit_id: string): LicenseRecord | null;
  upsert(rec: LicenseRecord): LicenseRecord;   // natural key = circuit_id
}

issueEntitlement(params: IssueParams, store: LicenseStore, now: Date): LicenseRecord
signKey(record: LicenseRecord, vendorPrivKeyPem: string | Buffer, now: Date): string
refreshKey(circuit_id: string, vendorPrivKeyPem, store, now): string
revokeEntitlement(circuit_id: string, revokedBy: string, store, now): LicenseRecord
```

- `now: Date` инъектируется (как в `verifyKey`) — функции чистые/тестируемые,
  никакого `Date.now()` внутри.
- `vendorPrivKey` передаётся **аргументом** (PEM-байты), читается из файла
  ТОЛЬКО в CLI-адаптере / composition root — никогда не зашит, не в config/.
- `PlanSpec`-пресеты (`PILOT_PLAN`, `PRO_PLAN`) — константы в модуле; маппинг
  `plan.tier → EntitlementSet` встроен (F-7).

### 1.3 signKey-flow (переиспользует consumer-canonicalize)

1. Из `LicenseRecord` собрать `ActivationKey` (тип импортируется из
   `src/vendor/activation.ts`): `key_version="choros-key.v1"`, `vendor="choros"`,
   `circuit_id`, `entitlements=record.plan.entitlements`,
   `issued_at=record.issued_at`, `not_before=record.valid_from`,
   `not_after=record.valid_until`.
2. `bytes = canonicalPayloadBytes(key)` — **тот же** экспорт, что у верификатора
   (signer/verifier хешируют идентичные байты).
3. `sig = crypto.sign(null, bytes, privateKeyObject)` (Ed25519, `node:crypto`).
4. Вернуть `"choros1." + b64url(bytes) + "." + b64url(sig)`.
5. Если `record.status==="revoked"` — бросить ошибку ДО шага 1 (AC-7).

Тип `ActivationKey`, `EntitlementSet`, `canonicalPayloadBytes` импортируются из
`src/vendor/activation.ts` (vendor→vendor — разрешено; consumer-файл НЕ меняется,
§5 спеки).

### 1.4 CLI-адаптер (src/cli/issue-key.ts)

Тонкий: парсит `--circuit-id/--plan/--valid-days/--notes/--priv-key/--out`,
читает PEM из `--priv-key`-пути (единственное место чтения приватного ключа),
вызывает `issueEntitlement` → `signKey`, печатает wire-строку в stdout
(опц. `--out` файл, gitignored по соглашению). Сам payload не строит, не подписывает.
Store-путь для MVP — файловый ledger (флаг/env, gitignored).

### 1.5 Runtime-target

**Локально / вендорская машина** (оператор). Producer-слой НЕ входит в
клиентский Docker-образ (NF-2): `signKey`/CLI исполняются у вендора. Это
исполнимо проверяется FF-T242-2 (ниже).

---

## 2. Отклонённые альтернативы

| option | why_not |
|--------|---------|
| `LicenseRecord` как `migrations/073` CREATE TABLE в choros/migrations | Нарушает ратифицированный freeze FF-0031-06 (no CREATE TABLE в миграциях ≥031) и/или ложно классифицирует вендор-запись как tenant-таблицу в `known_tenant_tables.txt` (размыв RLS-инварианта). Vendor-ledger принадлежит вендорскому контуру, не клиентскому силосу. |
| Прямой `pg.Pool` внутри issuance.ts | Делает ручку непереносимой (привязка к tenant-Postgres), тянет приватный ключ ближе к клиентскому контуру, ломает тестируемость. Порт `LicenseStore` развязывает store от логики (silo/SaaS — один шов F-8). |
| `signKey` читает приватный ключ из `config/activation/` или env внутри функции | Грубо нарушает NF-2 (приватный ключ в клиентском контуре) и чистоту. Ключ — аргумент; чтение файла только в CLI. |
| Своя canonicalize в issuance.ts | Дрейф байтов signer↔verifier → подпись не верифицируется. Переиспользуем экспортированный `canonicalPayloadBytes` (AC-3). |
| `revoke` = DELETE записи / отзыв-CRL клиенту | Нарушает `revoke ≠ halt` (NF-1): нельзя дотянуться до клиентского ключа. Revoke = только смена `status`; следующий `refreshKey` отказывает (AC-7), старый ключ доживает `not_after` (AC-8). |
| JWT/PKI-библиотека для подписи | Тащит runtime-dep (NF-4). `node:crypto` Ed25519 — zero-dep, симметрично верификатору. |
| Толстый CLI (формирует payload сам) | Дублирует логику ручки, расходится при правках. Адаптер тонкий — только маппинг args→params (F-6). |

---

## 3. Object model

```
PlanSpec {
  tier: string                 // 'pilot' | 'pro' (label, расширяется кодом)
  entitlements: EntitlementSet // {updates, agentic_ops, support, tier}
}

LicenseRecord {
  id:           string (UUID, PK)
  circuit_id:   string (unique, natural key для идемпотентности)
  status:       'active' | 'revoked'
  plan:         PlanSpec       // сериализован; исторически неизменяем при revoke
  valid_from:   string (RFC3339)  // → not_before в ключе
  valid_until:  string (RFC3339)  // → not_after в ключе
  source:       'pilot' | 'billing' | 'trial' | 'saas'
  notes:        string | null
  issued_at:    string (RFC3339, auto, immutable при повторном issue)
  last_signed:  string | null     // обновляется signKey/refreshKey
  revoked_at:   string | null
  revoked_by:   string | null
}

IssueParams {                  // 🔒 ПУБЛИЧНЫЙ КОНТРАКТ с T-0244 — стабилен
  circuit_id:  string
  plan:        PlanSpec        // или label, резолвится в пресет
  valid_from:  string (RFC3339)
  valid_until: string (RFC3339)
  source:      'pilot' | 'billing' | 'trial' | 'saas'
  notes?:      string
}

LicenseStore (port) { getByCircuit(circuit_id): LicenseRecord|null;
                      upsert(rec): LicenseRecord }

// reused from src/vendor/activation.ts (НЕ переопределяем):
ActivationKey, EntitlementSet, canonicalPayloadBytes
```

Пресеты (F-7):

| plan tier | updates | agentic_ops | support |
|-----------|---------|-------------|---------|
| `pilot`   | true    | false       | true    |
| `pro`     | true    | true        | true    |

---

## 4. Контракты

- `issueEntitlement(params, store, now) -> LicenseRecord` — единственный путь
  создания/обновления; идемпотентен по `circuit_id` (upsert natural key);
  `issued_at` не меняется при повторе (AC-1/AC-2/NF-6); статус нового = `active`.
  **🔒 публичная сигнатура `issueEntitlement({circuit_id, plan, valid_from,
  valid_until, source, notes?}) -> LicenseRecord` стабильна для T-0244** (store/now
  — инъектируемые параметры composition-root; BPMN-шаг вызывает через порт, не
  зная про Ed25519).
- `signKey(record, vendorPrivKeyPem, now) -> wireString` — чистая, `node:crypto`
  Ed25519, переиспользует `canonicalPayloadBytes`; `status==='revoked'` → throw
  (AC-7); wire = `choros1.<b64url>.<b64url>`, верифицируется `verifyKey` как
  `active` в сроке (AC-3/AC-4/AC-5).
- `refreshKey(circuit_id, vendorPrivKeyPem, store, now) -> wireString` — грузит
  active-запись, `signKey`, апдейтит `last_signed`; `plan/valid_from/valid_until`
  не трогает; revoked → throw (AC-6/AC-7).
- `revokeEntitlement(circuit_id, revokedBy, store, now) -> LicenseRecord` —
  `status='revoked'`, `revoked_at=now`, `revoked_by`; НЕ шлёт kill-signal, не
  трогает выданные ключи (AC-8/AC-9/NF-1).
- `LicenseStore` порт инъектируется; приватный ключ — аргумент, читается из файла
  только в CLI (NF-2).
- `src/core/**` НЕ импортирует `src/vendor/issuance.ts` (FF-T127-1 держит);
  entitlement-лексика остаётся в `src/vendor/**` (FF-T127-4 держит).

---

## 5. Fitness-функции

Все исполнимые (`ci/checks/*.sh`, `--self-test` где уместно), ownership-header
`# T-0242 · …` на строке 2 (FF-FCI-конвенция). Регистрируются в `npm run fitness`.

- **FF-T242-1** (`ci/checks/vendor-private-not-committed.sh`, AC-11): grep по
  git-tracked файлам на `BEGIN PRIVATE KEY` / `BEGIN OPENSSH PRIVATE KEY` /
  `BEGIN EC PRIVATE KEY` во всём дереве → ноль попаданий. `--self-test`: planted
  файл с PEM-маркером ДОЛЖЕН ловиться; benign-упоминание в комментарии/доке
  (строка-комментарий) НЕ должно тripать (исключение own ADR/spec строк, где
  токен встречается как пример). Exit 0/1/2.
- **FF-T242-2** (`ci/checks/vendor-priv-not-in-client-circuit.sh`, NF-2):
  статически — `signKey`/чтение приватного ключа не появляется в клиентском
  контуре. (a) grep: `config/activation/**` не содержит `*priv*`/`PRIVATE KEY`;
  (b) `signKey` определён только в `src/vendor/issuance.ts`, не импортируется в
  `src/http/**`/`src/core/**`/composition-root клиентского образа; (c) приватный
  ключ читается (`readFileSync`/`createPrivateKey`) только в `src/cli/issue-key.ts`.
  `--self-test`: planted import `signKey` в `src/http` → FAIL.
- **FF-T242-3** (`ci/checks/issuance-zero-dep.sh`, NF-4/AC-15): `src/vendor/issuance.ts`
  для крипто использует только `node:crypto`; никаких `http`/`https`/`axios`/
  `fetch`/`node-fetch`/`undici`/`pg`-импортов в issuance (store — через
  инъектируемый порт, не прямой драйвер). Позитивно требует наличие `node:crypto`.
  `--self-test`: planted `import axios` → FAIL.
- **FF-T242-4** (`ci/checks/issuance-store-not-tenant-table.sh`, §1.1): инвариант
  «vendor-ledger вне tenant-субстрата» — (a) нет новой `*license*`/`*entitlement*`
  записи в `ci/checks/known_tenant_tables.txt`; (b) нет `CREATE TABLE` с
  `license_record`/`entitlement` в `choros/migrations/`. Делает архитектурное
  решение §1.1 исполнимым и предотвращает регресс в tenant-DDL. `--self-test`:
  planted `license_record` в known_tenant_tables → FAIL.
- **FF-T127-1 / FF-T127-4 продолжают проходить** (AC-12/AC-13): добавление
  `src/vendor/issuance.ts` не трогает `src/core/`, лексика только в vendor —
  существующие чеки (НЕ редактируем) остаются зелёными. Гарантия: issuance в
  `src/vendor/`, CLI в `src/cli/` (CLI не `src/http/*` → FF-T127-4 не задет).

Unit-тесты (`src/__tests__/issuance.test.ts`) покрывают AC-1..AC-9, AC-14
round-trip через настоящий сгенерённый Ed25519-keypair + реальный `verifyKey`.

---

## 6. Traceability

| AC | covered_by |
|----|-----------|
| AC-1 | §1.2/§4 issueEntitlement → LicenseRecord status=active; unit-test |
| AC-2 | §3 natural key circuit_id + upsert; issued_at immutable; unit-test (NF-6) |
| AC-3 | §1.3 canonicalPayloadBytes reuse → verifyKey active; unit round-trip |
| AC-4 | §1.3 circuit_id в payload = record.circuit_id; unit round-trip |
| AC-5 | §1.3 entitlements=plan.entitlements; unit round-trip |
| AC-6 | §4 refreshKey: last_signed апдейт, plan/срок неизменны; unit-test |
| AC-7 | §1.3 revoked → throw в signKey/refreshKey; unit-test |
| AC-8 | §0/§4 revoke≠halt: старый wire верифицируется в сроке; unit-test |
| AC-9 | §4 revokeEntitlement: status/revoked_at/revoked_by; unit-test |
| AC-10 | §1.4 CLI печатает wire, verifyKey active; FF (CLI smoke) |
| AC-11 | FF-T242-1 vendor-private-not-committed.sh |
| AC-12 | §5 FF-T127-1 держит (issuance вне core); ci |
| AC-13 | §5 FF-T127-4 держит (лексика в vendor; CLI не src/http); ci |
| AC-14 | §3 PILOT_PLAN preset {updates:t,agentic_ops:f,support:t,tier:pilot}; unit |
| AC-15 | FF-T242-3 issuance-zero-dep.sh (node:crypto only) |

---

## 7. Скоуп

**MVP (эта задача):** `issueEntitlement`/`signKey`/`refreshKey`/`revokeEntitlement`
в `src/vendor/issuance.ts`; `LicenseStore` порт + файловый MVP-бэкенд; CLI
`src/cli/issue-key.ts`; unit-тесты; FF-T242-1..4.

**Stage-2 (вне MVP, зафиксировано):** billing/trial/SaaS-адаптеры; Postgres/
SaaS-store как реализация порта (своя вендор-БД, НЕ tenant-migrations); HSM/KMS
для приватного ключа; авто-refresh по расписанию; SaaS live-чтение записи;
air-gapped delivery; ротация keypair; product-feature/seat-гейтинг —
ПРИНЦИПИАЛЬНО вне (red-line); дизайн онбординга — T-0244.

**Отклонение от спеки §5 (зафиксировано, не эскалация):** спека называет
`migrations/073_vendor_license_record.sql`; дизайн заменяет его на инъектируемый
vendor `LicenseStore`-порт ВНЕ tenant-migrations (см. §1.1). Причина —
ратифицированный freeze FF-0031-06 + семантика «vendor-ledger ≠ tenant-table».
Это уточнение реализации в духе спеки (источник истины сохранён, шов T-0244
не тронут), а не продуктовая развилка → founder-judgment не требуется.

---

## 8. Escalation

Пусто. Публичный шов `issueEntitlement(...)` с T-0244 сохранён байт-в-байт.
Все продуктовые развилки сняты решениями фаундера (см. §0). Единственное
архитектурное уточнение (store вне tenant-migrations) продиктовано существующим
ратифицированным CI-инвариантом и не вводит новый продуктовый выбор.
