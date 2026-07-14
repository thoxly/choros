# T-0242 — Вендорский entitlement-слой: producer-сторона (SPEC)

> Фаза: SPEC (analyst). Задача: [design] Вендорский entitlement-слой
> (producer-сторона к T-0127/T-0198).
> Статус: **ready** (все блокирующие вопросы сняты ранее, нет новых).
> Зависимости: T-0127 (genesis-installer ADR, формат choros-key.v1),
> T-0198 (consumer-сторона: activation.ts, entitlement.ts, vendor-activation.ts).
> Шов: T-0244 (consumer-onboarding process, идёт параллельно) — вызывает
> `issueEntitlement()` как шаг, но сам процесс T-0244 не описывается здесь.

---

## 1. Что строим (одно предложение)

Единая ручка **`issueEntitlement()`** — единственный путь создания и обновления
license-записи — плюс инструменты подписи ключа `choros-key.v1` из этой записи
(issue/refresh/revoke) и тонкий CLI-адаптер для ручного пилотного выпуска;
вся остальная логика (billing, trial-форма, SaaS) присоединяется позже как
замена адаптера, без изменения самой ручки.

---

## 2. Контекст и опора (что уже есть)

### 2.1 Готовая consumer-сторона (T-0198, done)

Реализовано и живёт в продакшн-ветке:

- **`src/vendor/activation.ts`** — чистый, offline, zero-dep верификатор
  `verifyKey(envelope, vendorPubKey, now)`. Проверяет Ed25519-подпись,
  парсит `ActivationKey`-payload, возвращает `ActivationStatus`
  (`active` | `autonomous` | `invalid`).
- **`src/vendor/entitlement.ts`** — composition root: читает ключ из
  `CHOROS_ACTIVATION_KEY` env / `config/activation/activation.key`, читает
  `config/activation/vendor-pub.ed25519`, делегирует в `verifyKey`.
- **`src/http/vendor-activation.ts`** — HTTP-граница: `GET /vendor/activation`
  (всегда 200, отчёт), `POST /vendor/updates/check`, `POST /vendor/agentic-ops/run`,
  `GET /vendor/support/ticket` (отказ 402/403 при отсутствии entitlement).
- **CI-gate FF-T127-1** (`ci/checks/no-killswitch-in-core.sh`): статический
  grep-инвариант, что `src/core/**` не читает статус ключа и не импортирует
  `src/vendor/**`. RED-LINE.
- **CI-gate FF-T127-4** (`ci/checks/entitlement-gates-vendor-only.sh`):
  entitlement-лексика только в `src/vendor/**` и `src/http/vendor-*.ts`.

Публичный ключ вендора (`config/activation/vendor-pub.ed25519`) поставляется
с образом клиентского контура. **Приватный ключ** вендора — НЕ входит в клиентский
контур, хранится у вендора (операционная безопасность, OS-3, Stage-2 ADR).

### 2.2 Объектная модель ключа (из T-0127 ADR §3)

```
ActivationKey (payload) {
  key_version: "choros-key.v1"
  circuit_id:  string   // identity конкретной установки
  vendor:      "choros"
  entitlements: EntitlementSet {
    updates:     boolean  // право на self-upgrade / image pull от вендора
    agentic_ops: boolean  // право на fleet-ops от вендора
    support:     boolean  // право на вендорский канал поддержки
    tier:        string   // информационный label плана
  }
  issued_at:   RFC3339
  not_before:  RFC3339
  not_after:   RFC3339
}

KeyEnvelope (wire) = "choros1.<base64url(canonical-json payload)>.<base64url(ed25519-sig)>"
```

Подпись: Ed25519 по `canonicalPayloadBytes(key)` (sorted-key canonical JSON).
`canonicalPayloadBytes` уже экспортирована из `src/vendor/activation.ts`.

### 2.3 Чего нет (PRODUCER-сторона не построена)

- Нет `LicenseRecord` — DB-таблицы как источника истины на стороне вендора.
- Нет `issueEntitlement()` — единой ручки создания/обновления записи.
- Нет функции подписи ключа из записи (private-key операция).
- Нет `revoke`-пути, `refresh`-пути.
- Нет CLI для ручного pilot-выпуска.

---

## 3. Требования

### 3.1 Функциональные

**F-1. Единая ручка `issueEntitlement(params): LicenseRecord`**

Единственный путь создания или обновления license-записи:

```
issueEntitlement({
  circuit_id:   string          // identity конкретного контура-клиента
  plan:         PlanSpec        // какие флаги entitlement и label tier
  valid_from:   RFC3339         // start of validity window
  valid_until:  RFC3339         // end of validity window (not_after)
  source:       "pilot" | "billing" | "trial" | "saas"
  notes?:       string          // произвольный комментарий (ручной режим)
}): LicenseRecord
```

Ручка идемпотентна по `circuit_id`: повторный вызов с теми же params не
создаёт дубль — обновляет существующую запись (`circuit_id` = natural key).

**F-2. LicenseRecord — источник истины**

Запись хранит всё, что нужно для воспроизведения ключа и аудита:

```
LicenseRecord {
  id:           UUID (PK)
  circuit_id:   string (unique)
  status:       "active" | "revoked"
  plan:         PlanSpec (сериализован, исторически неизменяемый при revoke)
  valid_from:   timestamp
  valid_until:  timestamp
  source:       "pilot" | "billing" | "trial" | "saas"
  notes:        text | null
  issued_at:    timestamp (auto, immutable)
  last_signed:  timestamp | null   // когда последний раз подписывался ключ
  revoked_at:   timestamp | null
  revoked_by:   string | null
}
```

**F-3. Подпись ключа `signKey(record, vendorPrivKey): string`**

Функция принимает `LicenseRecord` с `status="active"` и вендорский приватный
ключ, возвращает wire-строку `choros-key.v1`. Для revoked-записи — НЕ подписывает
(возвращает ошибку, AC-7).

Signing-flow:
1. Построить `ActivationKey` из `LicenseRecord`.
2. Вычислить `canonicalPayloadBytes(key)` (переиспользовать экспорт из
   `src/vendor/activation.ts`).
3. Ed25519-подпись по этим байтам приватным ключом.
4. Вернуть `"choros1.<payload_b64>.<sig_b64>"`.

**F-4. Refresh: `refreshKey(circuit_id, vendorPrivKey): string`**

Загружает активную license-запись по `circuit_id`, вызывает `signKey`,
обновляет `last_signed`. Не изменяет `plan`, `valid_from`, `valid_until`.
Если `status="revoked"` — отказ (AC-7).

**F-5. Revoke: `revokeEntitlement(circuit_id, revokedBy): void`**

Устанавливает `status="revoked"`, `revoked_at=now`, `revoked_by` в записи.
Не уничтожает существующие физические ключи (те доживут до `not_after`
в автономном режиме — `revoke ≠ halt`, AC-8).

**F-6. CLI-адаптер `ctl/issue-key.ts` (pilot source)**

Тонкий адаптер для ручного pilot-выпуска. Принимает:
- `--circuit-id <uuid>`
- `--plan <tier-label>` (напр. `pilot`)
- `--valid-days <N>` (default 365)
- `--notes <text>`
- `--priv-key <path>` (путь к vendor private key PEM; НИКОГДА не коммитится)

Последовательность:
1. `issueEntitlement(...)` → `LicenseRecord`.
2. `signKey(record, privKey)` → wire-строка.
3. Печатает wire-строку в stdout (оператор копирует клиенту).
4. Опционально `--out <file>` — записывает в файл (gitignored по соглашению).

Адаптер — ТОНКИЙ: вся логика в `issueEntitlement` + `signKey`. Адаптер сам
не формирует payload, не подписывает — только маппирует CLI-args в params.

**F-7. PlanSpec — фиксированные pilot-пресеты**

Для MVP достаточно двух пресетов, задаваемых кодом (не конфигом):

| plan label  | updates | agentic_ops | support | tier     |
|-------------|---------|-------------|---------|----------|
| `pilot`     | true    | false       | true    | "pilot"  |
| `pro`       | true    | true        | true    | "pro"    |

Пресеты встроены в `issueEntitlement()` — выбираются по `plan.tier`. Добавление
нового пресета = code change, не конфиг (соразмерный MVP-скоуп).

**F-8. SaaS-seam (design-only, Stage-2)**

`LicenseRecord` — единый источник истины для обеих проекций:
- **silo/on-prem** (MVP): вендор запускает `refreshKey` → отдаёт клиенту
  wire-строку вне полосы (email/manual).
- **SaaS** (Stage-2): клиент читает `LicenseRecord` напрямую через
  authenticated-вызов; физический wire-ключ не нужен.

Seam: `issueEntitlement` + `LicenseRecord` одинаковы в обоих режимах. Разница
только в transport (как ключ доставляется клиенту). Seam НЕ строится в MVP —
только должен быть учтён в структуре `LicenseRecord` (поле `source`).

---

### 3.2 Нефункциональные

**NF-1. `revoke ≠ halt` (red-line наследован от T-0127)**

`revokeEntitlement()` меняет `status` в записи. Это НЕ вызывает никакого
kill-signal, не инвалидирует ключи на стороне клиента немедленно. Физические
wire-ключи, уже выданные клиенту, доживают до `not_after` в автономном режиме.
Следующий `refreshKey` после revoke — отказывает (AC-7). Нельзя «удалить» ключ
с клиентского контура изнутри вендорского слоя.

**NF-2. Приватный ключ вендора — НЕ в клиентском контуре**

Вендорский приватный ключ (`vendor-priv.ed25519`) НИКОГДА не попадает в
`config/activation/`, не коммитится в репозиторий choros, не входит в Docker-образ.
Он хранится у вендора (ноутбук/HSM/секрет-хранилище). `signKey` вызывается
только на стороне вендора.

**NF-3. Offline-верифицируемость (наследован от T-0127)**

Выданный ключ верифицируется клиентом локально, без call-home. Это свойство
consumer-стороны (уже реализовано), но producer-строна его не должна нарушить:
`signKey` не добавляет online-зависимостей в wire-формат.

**NF-4. Zero-dep в signing-util**

`signKey` использует только `node:crypto` (Ed25519). Никакого нового runtime-dep.

**NF-5. Аудитируемость**

Каждый вызов `issueEntitlement`, `revokeEntitlement`, `refreshKey` логируется
(минимально: timestamp, circuit_id, source, who). Лог — часть `LicenseRecord`
через `issued_at`, `last_signed`, `revoked_at`, `revoked_by`.

**NF-6. Идемпотентность `issueEntitlement`**

Повторный вызов с теми же `circuit_id` + `plan` + `valid_until` не создаёт
дублирующую запись и не изменяет `issued_at`.

**NF-7. Изоляция от ядра Choros**

Producer-сторона живёт в `src/vendor/issuance.ts` (+ `ctl/`). Она не является
частью клиентского контура. Она не импортируется из `src/core/**`. FF-T127-1
продолжает держать — `src/core/**` не видит issuance.

---

## 4. Скоуп (явно)

### В скоупе MVP

- `LicenseRecord` — DB-таблица на стороне вендора (отдельная БД или выделенный
  namespace; архитектор определит в ADR).
- `issueEntitlement()` — функция с unit-тестами.
- `signKey(record, privKey)` — функция с unit-тестами.
- `refreshKey(circuit_id, privKey)` — функция с unit-тестами.
- `revokeEntitlement(circuit_id, revokedBy)` — функция с unit-тестами.
- CLI-адаптер `ctl/issue-key.ts` для ручного pilot-выпуска.
- CI-gate `FF-T242-1` (`ci/checks/vendor-private-not-committed.sh`): никакого
  приватного ключа в git-tracked файлах (дополнение к FF-T198-config).

### Вне скоупа

- Billing-интеграция (webhook / Stripe / ЮKassa) — Stage-2 адаптер.
- Trial-форма / SaaS-логин как входная дверь — Stage-2 адаптер.
- Product-feature/seat-гейтинг (gating самого Choros-контура, а не вендор-сервисов) —
  принципиально ВНЕ скоупа (решение фаундера: ключ = сервис, не заложник).
- HSM / KMS интеграция для vendor private key — Stage-2.
- Авто-refresh по расписанию (fleet-ops-driven) — Stage-2.
- Клиентский pull (SaaS-seam live-чтение) — Stage-2.
- Air-gapped delivery ключей — Stage-2.
- Web-UI управления лицензиями — Stage-2.
- Ротация вендорского keypair — Stage-2 (OS-3, упоминается как Stage-2 в T-0127 ADR §7).

---

## 5. Зоны записи (write-zones)

Только в клиентском репозитории choros:

- `src/vendor/issuance.ts` — новый файл: `issueEntitlement`, `signKey`,
  `refreshKey`, `revokeEntitlement`, типы `LicenseRecord`, `PlanSpec`.
- `src/cli/issue-key.ts` — CLI-адаптер (ctl тонкий).
- Миграция `073_vendor_license_record.sql` — DDL для `LicenseRecord`
  (в vendor-namespace или отдельная схема; архитектор определит).
- `src/__tests__/issuance.test.ts` — unit-тесты всех четырёх функций.
- `ci/checks/vendor-private-not-committed.sh` — FF-T242-1.
- `docs/design/T-0242-vendor-entitlement.adr.md` — downstream ADR (не эта задача).

НЕ трогать:
- `src/core/**`
- `src/vendor/activation.ts` (consumer-верификатор, менять нельзя)
- `src/vendor/entitlement.ts`
- `constitution/`, `agents/`
- Существующие CI-чеки FF-T127-1, FF-T127-4

---

## 6. Шов с T-0244 (consumer-onboarding)

T-0244 проектирует процесс онбординга клиента. Один из шагов этого процесса —
«выпустить activation key». Этот шаг должен вызвать:

```
issueEntitlement({ circuit_id, plan, valid_from, valid_until, source: "pilot" })
  → LicenseRecord
signKey(record, vendorPrivKey)
  → wire-string   // передаётся клиенту вне полосы
```

T-0244 НЕ определяет payload-формат, НЕ знает про Ed25519. T-0244 знает только:
«есть функция `issueEntitlement`, вот её параметры, вот что она возвращает».

T-0242 определяет именно этот интерфейс. T-0244 потребляет его.

Синхронизация: T-0242-spec должна выйти раньше или одновременно с T-0244-spec.

---

## 7. Критерии приёмки

| ID    | Текст | Верифицируется как |
|-------|-------|--------------------|
| AC-1  | `issueEntitlement({ circuit_id, plan, valid_from, valid_until, source })` создаёт `LicenseRecord` с `status="active"` и корректными полями. | test |
| AC-2  | Повторный `issueEntitlement` с тем же `circuit_id` обновляет существующую запись (не дублирует), `issued_at` остаётся неизменным. | test |
| AC-3  | `signKey(activeRecord, privKey)` возвращает wire-строку формата `choros1.<b64>.<b64>`, которую `verifyKey(wire, pubKey, now)` верифицирует с verdict `active`. | test |
| AC-4  | `signKey(activeRecord, privKey)` + `verifyKey` → `circuit_id` в payload совпадает с `record.circuit_id`. | test |
| AC-5  | `signKey(activeRecord, privKey)` + `verifyKey` → `entitlements` в payload соответствуют `record.plan` (значения `updates`, `agentic_ops`, `support`, `tier`). | test |
| AC-6  | `refreshKey(circuit_id, privKey)` → обновляет `last_signed`, возвращает новую wire-строку, которую `verifyKey` принимает. `plan`, `valid_from`, `valid_until` не изменяются. | test |
| AC-7  | После `revokeEntitlement(circuit_id)` вызов `signKey(revokedRecord, privKey)` завершается ошибкой (не возвращает ключ). | test |
| AC-8  | После `revokeEntitlement(circuit_id)` ранее выданный wire-ключ с `not_after` в будущем остаётся верифицируемым (`verifyKey` → `active`, если в сроке). Revoke НЕ инвалидирует физический ключ немедленно. | test |
| AC-9  | `revokeEntitlement(circuit_id)` устанавливает `record.status="revoked"`, `revoked_at` — ненулевой timestamp, `revoked_by` — переданный аргумент. | test |
| AC-10 | CLI-адаптер `ctl/issue-key.ts --circuit-id X --plan pilot --priv-key P` печатает wire-строку в stdout; `verifyKey` принимает её с verdict `active`. | fitness |
| AC-11 | Новый CI-check `FF-T242-1` (`ci/checks/vendor-private-not-committed.sh`): grep по git-tracked файлам на `BEGIN PRIVATE KEY` / `BEGIN OPENSSH PRIVATE KEY` во всём дереве — ни одного попадания. Проходит `--self-test`. | fitness |
| AC-12 | FF-T127-1 (`ci/checks/no-killswitch-in-core.sh`) продолжает проходить после изменений этой задачи (добавление `src/vendor/issuance.ts` не трогает `src/core/`). | fitness |
| AC-13 | FF-T127-4 (`ci/checks/entitlement-gates-vendor-only.sh`) продолжает проходить. | fitness |
| AC-14 | `issueEntitlement` с `plan="pilot"` создаёт `EntitlementSet{ updates: true, agentic_ops: false, support: true, tier: "pilot" }`. | test |
| AC-15 | `signKey` использует только `node:crypto` — статический grep на `node:crypto` в `src/vendor/issuance.ts`, никакого bare-http/axios/fetch. | fitness |

---

## 8. Вне скоупа — явный список

1. Billing/payment-интеграция (Stripe, ЮKassa, webhook) — Stage-2.
2. Trial-форма и SaaS-логин как входные двери — Stage-2.
3. Product-feature или seat-гейтинг внутри клиентского контура — ПРИНЦИПИАЛЬНО
   вне скоупа (решение фаундера 2026-06-16: «ключ = сервис, не заложник»;
   противоречит red-line).
4. HSM / KMS для хранения vendor private key — Stage-2.
5. Авто-refresh по расписанию и fleet-ops-driven push — Stage-2.
6. Web-UI управления лицензиями — Stage-2.
7. Ротация вендорского keypair и multi-key — Stage-2.
8. Air-gapped и ARM delivery ключей — Stage-2 (из T-0127 ADR §7).
9. SaaS live-чтение `LicenseRecord` клиентом — Stage-2 seam.
10. Дизайн самого процесса онбординга клиента — T-0244.

---

## 9. Нерешённых продуктовых вопросов нет

Все принципиальные развилки сняты:
- Лицензионная модель (ключ = сервис, не заложник, red-line) — решение фаундера
  2026-06-13.
- Единый chokepoint `issueEntitlement` + тонкие адаптеры — решение фаундера
  2026-06-16.
- Dogfood (пилоты через настоящий механизм с day-1) — решение фаундера
  2026-06-16.
- Product-feature/seat-гейтинг вне скоупа — решение фаундера 2026-06-16.
- revoke ≠ halt (физические ключи доживают not_after) — решение фаундера
  2026-06-16 + T-0127.

Статус: **ready**. Blocking_questions: [].
