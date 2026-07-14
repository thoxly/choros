# T-0127 — Genesis-инсталлятор + активационный ключ (ADR)

> Фаза: DESIGN (architect). Статус: **ready**.
> Вход: `docs/specs/T-0127-genesis-installer.spec.md` (status был needs_founder,
> Q-1..Q-4 BLOCKING).
> Решения фаундера (2026-06-13, T-0127) сняли все четыре блока — проектируем в их
> рамках, не переоткрываем (см. §0).
> Spec_ref продукта: `playbooks/choros-product-gap-map.md` §3а.

---

## 0. Решения фаундера, в рамках которых проектируем (НЕ re-litigate)

Лицензионная модель Choros, зафиксированная фаундером 2026-06-13:

- **Ключ ПРОДАЁТ СЕРВИС** (апдейты + агентное сопровождение + поддержка), а НЕ
  держит инсталляцию заложником. → закрывает **Q-1**: entitlement = именованный
  набор service-флагов; гейтит ТОЛЬКО обращения к вендорским сервисам.
- **Истёкший/отсутствующий ключ = АВТОНОМНЫЙ режим**: контур работает полноценно,
  БЕЗ kill-switch в ядре (red-line). → подтверждает NF-1/NF-2.
- **MVP-скоуп: online, x86_64, self-upgrade.** Air-gapped и ARM — Stage-2. →
  закрывает **Q-2** (только linux/amd64 в MVP, оффлайн-образы вынесены) и **Q-3**
  (инсталлятор = ещё и апгрейдер: online self-upgrade в скоупе MVP).
- **Ключ = identity + entitlement контура для control-plane** (что разрешено по
  подписке), НЕ enforcement-рычаг над работой инсталляции. → закрывает **Q-4**:
  identity несёт сам подписанный ключ; control-plane проверяет подпись при
  предъявлении; bootstrap доверия = офлайн-проверяемая подпись вендора, не
  call-home.

## 1. Решение (decision)

Поставляем T-0127 как **обёртку над уже существующими примитивами** (compose +
overlay + `migrations/run.mjs` + миграция 026), плюс тонкий вендорский слой
проверки ключа НА ГРАНИЦЕ обращения к сервисам вендора — и НИГДЕ в ядре.

**(A) Genesis-инсталлятор `install.sh`** — один POSIX-bash скрипт в `ops/install.sh`,
идемпотентный, fail-closed, online/linux-amd64 (MVP):

1. **Preflight** (до любой мутации системы): проверяет `docker` + `docker compose`
   v2, свободу дефолтных host-портов (55432/8180/9000/8082/3000), место на диске;
   при провале — exit ≠ 0, печать упавшего предусловия, НИЧЕГО не поднято (F-7/AC-5).
2. **Один конфиг**: если `.env.prod` отсутствует — генерирует его из
   `.env.prod.example`, заполняя КАЖДЫЙ `REPLACE_WITH_*` безопасным случайным
   значением (`openssl rand`), и согласованно проставляет общий пароль Postgres в
   `DATABASE_URL`. Если `.env.prod` уже есть — НЕ трогает его (F-2/F-5/AC-3/AC-4).
   Единственный обязательный источник конфигурации = `.env.prod` (нет второго).
3. **Активационный ключ — опционально**: если человек передал ключ
   (`--key <path|value>` или `CHOROS_ACTIVATION_KEY` в `.env.prod`) — кладёт его в
   `config/activation/activation.key` (gitignored). ЕСЛИ КЛЮЧА НЕТ — установка
   продолжается без ошибки (F-10): контур встаёт в автономном режиме.
4. **Bring-up**: `docker compose -f docker-compose.yml -f docker-compose.prod.yml
   --env-file .env.prod up -d --wait` — поднимает Postgres/Keycloak/Flowable/app,
   ждёт healthcheck'и (F-3). Миграции (включая 026 genesis-owner) гоняет штатный
   `ops/docker-entrypoint.sh` → `migrations/run.mjs` ДО старта app — без второго
   пути создания владельца (F-4, §5-инвариант SPEC).
5. **Verify**: `GET /health` = 200; иначе fail-closed (F-6/AC-1) — никакого
   ложно-зелёного контура.
6. **Self-upgrade (тот же скрипт, MVP)**: повторный прогон с `--upgrade` или с
   уже существующим `.env.prod` делает `docker compose pull` (online) + `up -d
   --wait`; миграции догоняются энтрипойнтом идемпотентно (silo-upgrade семантика
   `docker-entrypoint.sh`). Air-gapped (предзагруженные образы) и ARM — Stage-2,
   явно вне MVP (см. §7).
7. **Итог**: структурированный отчёт — endpoint, как войти первым владельцем
   (`e-owner`/`tenant-owner`), версия образа, **статус активации**
   (`active` / `autonomous`) (F-6/AC-10).

**(B) Формат активационного ключа** — `choros-key.v1`, **detached-signature
envelope**, офлайн-проверяемый:

- Транспорт: одна строка `choros1.<base64url(payload)>.<base64url(sig)>`.
- `payload` = канонический JSON `ActivationKey` (см. object_model): `circuit_id`
  (identity), `entitlements[]` (service-флаги), `not_before`/`not_after` (срок),
  `issued_at`, `vendor`, `key_version`.
- `sig` = Ed25519-подпись `payload` приватным ключом вендора. Проверяется
  встроенным **публичным** ключом вендора (`config/activation/vendor-pub.ed25519`,
  поставляется с образом) — БЕЗ обращения к сети (NF-2: офлайн-проверяемость; иначе
  обязательный call-home = скрытый kill-switch).
- Подделка/просрочка определяется локально по подписи и `not_after` — но это
  меняет ТОЛЬКО `entitlement`-вывод, не запускает ничего в ядре (см. C).

**(C) Где entitlement влияет, а где — НЕТ:**

- Парсер/верификатор ключа живёт в **`src/vendor/activation.ts`** —
  ОТДЕЛЬНЫЙ модуль вне `src/core/`, читается ТОЛЬКО из вендорского слоя
  `src/vendor/` и вендорских HTTP-границ (`src/http/vendor-*`). Эта граница
  совпадает с «контур ↔ control-plane вендора» из fleet-ops ADR §2.
- При `expired`/`missing`/`forged` ключе вендорский слой возвращает отказ ИМЕННО
  на вызове вендорского сервиса (обновления / агент-сопровождение / sync с
  control-plane) → HTTP 402/403 на `vendor-*` эндпоинтах (F-11/AC-8).
- Ядро (`src/core/`: PDP, grant-resolver, процессы/bridge, таймеры, аудит,
  actor-event, RLS) **не импортирует и не читает** статус/срок ключа. Это
  red-line, проверяемый статически (FF-T127-1, см. §fitness).
- `activation_status` для итог-отчёта инсталлятора вычисляется в `src/vendor/`,
  а НЕ в ядре; ядро его не знает.

**Зона записи (write-zones):** `ops/install.sh`, `ops/install.lib.sh`,
`src/vendor/activation.ts`, `src/vendor/entitlement.ts`,
`src/http/vendor-activation.ts` (новый эндпоинт статуса/проверки), `config/activation/`
(+`.gitignore` для `*.key`), `.env.prod.example` (доп. строки активации),
`ci/checks/genesis-installer.sh`, `ci/checks/no-killswitch-in-core.sh`,
`docs/runbooks/install.md`. НЕ трогаем: `src/core/*`, `agents/`, `constitution/`,
control-plane, миграцию 026 (переиспользуем как есть).

## 2. Отклонённые альтернативы

См. contract `rejected_alternatives`. Кратко:
- **Лицензионный демон / runtime-таймер в ядре** — прямой kill-switch, нарушает
  red-line. Отвергнут.
- **Обязательный online-activation при установке** (call-home как условие старта)
  — скрытый kill-switch (нет сети = нет контура), нарушает NF-2. Отвергнут.
- **JWT (RS256) как формат ключа** — тащит JWT-библиотеку и зоопарк claim'ов;
  detached Ed25519-envelope = ~40 строк zero-dep на `node:crypto`, соразмернее.
- **Чтение ключа в middleware всех запросов** (даже «только для телеметрии») —
  ставит чтение статуса ключа в горячий путь ядра, делает FF-T127-1 нечестным и
  создаёт соблазн будущего gating. Отвергнут: ключ только в `src/vendor/`.
- **Отдельный инсталлятор-форк стека** (свой compose в дереве инсталлятора) —
  нарушает NF-4 (один артефакт); инсталлятор параметризует существующий compose.

## 3. Object model

См. contract `object_model`: `ActivationKey` (payload), `KeyEnvelope` (wire),
`EntitlementSet`, `ActivationStatus`, `InstallerConfig`, `InstallResult`.

## 4. Контракты

См. contract `contracts`. Ключевое:
- `verifyKey(envelope, vendorPubKey, now): {status, key?}` — чистая функция в
  `src/vendor/activation.ts`, zero-dep (`node:crypto` Ed25519), без сети, без БД,
  без `process.env` в самом верификаторе (env-граница — в composition root).
- `src/core/**` НЕ импортирует `src/vendor/**` (однонаправленная зависимость:
  vendor → core допустимо, core → vendor ЗАПРЕЩЕНО) — это и есть исполнимая форма
  red-line.
- `install.sh` использует ТОЛЬКО `docker compose`, `migrations/run.mjs` (через
  энтрипойнт), миграцию 026 — без второго пути genesis-owner и без форка `src/`.

## 5. Fitness-функции

См. contract `fitness_functions`. **RED-LINE-чек = FF-T127-1**
(`ci/checks/no-killswitch-in-core.sh`): статический grep-инвариант, что `src/core/`
не читает статус/срок ключа и не импортирует вендорский слой — с self-test'ами по
образцу `no-env-in-core.sh`.

## 6. Traceability

См. contract `traceability` (AC-1..AC-12 → §/FF).

## 7. Скоуп MVP и Stage-2 (из решения фаундера)

- **MVP (эта задача):** online, linux/amd64, self-upgrade в том же `install.sh`.
- **Stage-2 (вне MVP, отмечено):** air-gapped поставка с предзагруженными образами
  (`docker save/load`, оффлайн-реестр для регулируемого РФ-сегмента); ARM64-матрица;
  выпуск/ротация/отзыв ключей на стороне control-plane (OS-3 SPEC); подписанный
  бинарь-инсталлятор вместо bash. Эти пункты НЕ проектируются здесь — только
  зафиксированы как граница.

## 8. Escalation

Пусто. Все продуктовые развилки SPEC (Q-1..Q-4) сняты решениями фаундера от
2026-06-13 (см. §0); новых нерешённых продуктовых выборов дизайн не вводит.
