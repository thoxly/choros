# Spec: Реестр агентов, BYO-LLM ключи (app://) и учёт стоимости

Статус: DRAFT (дизайн, штурман). Заведено: 2026-06-25 по итогам полевого прогона.
Решения фаундера зафиксированы (см. §2). Реализация — отдельными задачами (см. §8), не в этой спеке.

## 1. Проблема (что сейчас не так)

Сегодня **любой** агент = `employee(kind='agent')` на позиции в оргструктуре:
- `agent_card` (migration 032) жёстко FK-привязан к `employee(tenant_id, id, kind='agent')` — агент **не может существовать без оргместа**. Чтобы завести «DeepSeek-агента», пришлось выдумывать отдел/должность/роль — искусственно.
- LLM-конфиг (`agent_card.llm_endpoint/llm_model/llm_secret_handle`) ≈ один на агента, и ключ хранится только как `env://`-хэндл (operator-only) — **самозарегистрированный тенант не может принести свой ключ из UI** (полевой прогон 2026-06-25).
- Системные агенты (конфигуратор `config-agent-seed`/`role-configurator`, `docs-author`, `implementation-agent`) тоже засижены как employee — у них **нет осмысленной роли в оргструктуре**, они действуют над платформой.
- Учёт стоимости не виден пользователю (`migration 034` со схемой бюджета **существует, но спит**; runtime её не читает).

Три ортогональных вопроса слиты в одну сущность: **(A) оргместо**, **(B) подключение LLM + ключ**, **(C) учёт стоимости**. Спека их разводит.

## 2. Решения фаундера (зафиксировано)

1. **Хранение ключа: `app://` зашифрованный стор (self-serve).** Тенант пастит ключ в UI → шифруется at-rest → в БД только шифртекст → расшифровка только в момент вызова, наружу никогда. (`env://` остаётся операторским fallback; `vault://` — энтерпрайз-опция позже.)
2. **Системные агенты и ассистент — ВНЕ оргструктуры**, в capability-реестре (адресуются грантом, не оргузлом). В оргструктуре остаются только рабочие агенты.
3. **Стоимость: сейчас — учёт + показ расхода. Потолки/лимиты/отсечка — позже** (схема `migration 034` уже готова под это).

## 3. Таксономия агентов

`agent_card` получает дискриминатор функции `agent_type`:

| agent_type | назначение | оргместо | пример |
|---|---|---|---|
| `workforce` | исполнитель задач внутри бизнес-процессов | **ДА** (employee+position+candidateGroups, autonomy_threshold) | агент-согласующий, сверка-агент |
| `system` | действует над платформой (строит приложения/процессы, доки) | **НЕТ** (capability/грант) | конфигуратор, docs-author, implementation-agent |
| `assistant` | общий чат-помощник тенанта | **НЕТ** (сервис тенанта) | ассистент |

**Следствие для FK:** `agent_card.employee_id` становится NULLable; рабочий агент имеет `employee_id` (оргместо), системный/ассистент — `employee_id IS NULL`. FK-дискриминатор `employee_kind` сохраняется только когда `employee_id` задан (partial). Это ключевая развязка корня §1.

## 4. Модель данных (изменения)

Аддитивно, поверх существующего (032 agent_card, 034 budget, 057 agent_instruction):

1. **`agent_card.agent_type text NOT NULL DEFAULT 'workforce'`** + CHECK in (`workforce`,`system`,`assistant`). Бэкфилл сидов: configurator/docs/implementation → `system`; assistant-agent → `assistant`.
2. **`agent_card.employee_id` → NULLable** (+ перестроить FK-дискриминатор как partial: проверять `employee_kind='agent'` только при заданном employee_id). Реестр = `agent_card`, оргместо опционально.
3. **`llm_connection`** (новая, tenant-isolated, RLS как все): именованные профили подключений.
   - `(tenant_id, id)`, `name text`, `provider text` (`deepseek|openai|anthropic|self-hosted`), `endpoint text`, `model text`, `secret_handle text` (опаковый, `app://`/`env://`/`vault://`), `price_input_per_1k numeric NULL`, `price_output_per_1k numeric NULL`, `currency text`, `created_by`, timestamps.
   - `agent_card.llm_connection_id uuid NULL` → FK на `llm_connection`. (Старые `llm_endpoint/llm_model/llm_secret_handle` депрекейтятся в пользу ссылки на профиль; миграция переносит существующие в профиль.)
   - Ассистент тенанта ссылается на профиль `assistant` дефолтно.
4. **`app_secret`** (новая, tenant-isolated, RLS, append-by-version): зашифрованный стор ключей для `app://`.
   - `(tenant_id, id)`, `ciphertext bytea`, `nonce bytea`, `key_version int`, `created_by`, `created_at`. Сырой ключ НЕ хранится; `app://<id>` — это хэндл.
   - Шифрование: envelope — мастер-ключ из env/KMS (`APP_SECRET_MASTER_KEY`) шифрует per-tenant DEK (или прямой AEAD libsodium/pgcrypto v1). Решение по KMS — implementation-time, но контракт: расшифровка только в `resolveSecret`, никогда не в ответе API/аудите/логе.

## 5. Ключи: `app://` (B)

- **Новая схема хэндла `app://<secret_id>`** в `secret-handle-validator.ts` (рядом с `env://`/`vault://`).
- **`resolveSecret('app://<id>', {tenantId})`** → читает `app_secret` (tenant-scoped, RLS), расшифровывает AEAD в памяти, возвращает строку. Никогда не возвращается клиенту; `GET …/status` отдаёт только `secret_bound:bool` + `redactHandle` (`app://...`).
- **UI «вставить ключ»**: на экране подключения LLM — поле «API-ключ» (write-only). PUT → шифрует → пишет `app_secret` → ставит `secret_handle='app://<id>'` в `llm_connection`. Ключ из БД наружу не читается (как `llm_secret_handle` сейчас — `secret_bound:bool`).
- `env://` остаётся: операторский fallback (allow-list, уже содержит `DEEPSEEK_API_KEY`). `vault://` — энтерпрайз, позже.

## 6. Авторизация (кто заводит / кто пользуется)

Поверх существующей грант-решётки (`grants-dao`, `scoped-admin`):
- **Завести/править подключение и ключ** = грант `llm_connection:configure` → владелец/админ (или делегируемый mgmt_object — связать с T-0469 «конструктор-админ»).
- **Болтать с ассистентом** = любой член тенанта (подключение компанейское; использование открыто). Никакого оргместа не требует.
- **Настраивать/запускать системного агента** (строить приложения/процессы) = отдельный грант (`system_agent:operate`), не всем — связать с грантом `authoring_draft` конфигуратора (T-0462).
- **Завести рабочего агента** (оргместо) = как сейчас (admin-delegation на позицию, agent-hire), после фикса провижининга (T-0470).

## 7. Стоимость (C) — учёт + показ сейчас

Опереться на существующее (`migration 034`, `llm-port.usage`):
1. **Прайс**: `llm_connection.price_input_per_1k / price_output_per_1k` (+ currency). Дефолты-пресеты по провайдеру (редактируемы).
2. **Запись траты**: на каждом `port.chat()` (адаптер уже отдаёт `{promptTokens, completionTokens, totalTokens}`) считать стоимость и писать в `spend_ledger` (append-only, уже есть): `employee_id`/`agent_card`, `llm_connection_id`, токены, сумма, описание. (Расширить `spend_ledger` ссылкой на `llm_connection_id` если нужно — аддитивно.)
3. **Экран «Расход»**: агрегаты `spend_ledger` по агенту / подключению / окну (день/месяц/всего) — read-only витрина. Заменяет nav-заглушку «Бюджеты — скоро».
4. **НЕ сейчас (decision 3, отдельный слой позже):** жёсткие потолки/отсечка — `agent_budget` (окна instance/daily/monthly/total) + `reservation` + gate `budget.exhausted` в `run-agent-step.ts` (раннер уже умеет defer). Схема готова, включение — Stage-2.

## 8. Слои реализации (нарезка задач)

Эпик E-AGENTS-REGISTRY. Слои (последовательность по зависимостям):
- **L1 Таксономия + развязка оргместа**: `agent_type` + `employee_id` NULLable + бэкфилл сидов; «Агенты» = реестр (показывает тип), оргструктура — только workforce.
- **L2 Реестр подключений LLM**: таблица `llm_connection` (именованные профили) + `agent_card.llm_connection_id`; миграция текущего конфига в профиль; UI списка/создания подключений.
- **L3 `app://` зашифрованный стор**: `app_secret` + AEAD + `resolveSecret('app://')` + схема хэндла; UI «вставить ключ» (write-only) на подключении.
- **L4 Авторизация**: гранты `llm_connection:configure` / `system_agent:operate`; ассистент-чат открыт членам; вынос системных агентов под capability (связать T-0462/T-0469).
- **L5 Учёт+показ стоимости**: прайс на подключении + запись `spend_ledger` на каждом LLM-вызове + экран «Расход».
- **L6 (позже, decision 3)**: потолки/лимиты/отсечка — `agent_budget` + `reservation` + Gate-C wiring.

Связанные/предусловия: T-0470 (KC admin-клиент для провижининга рабочих агентов), T-0471 (secret-handle keycloak+tenant фикс), T-0462 (configurator create_application), T-0469 (конструктор-админ==owner), T-0382 (assistant BYO-LLM).

## 9. Acceptance (на задеплоенном dev, реальный тенант)

- Владелец заводит подключение «DeepSeek» (endpoint+model) и **вставляет ключ в UI** → ключ зашифрован, в БД нет сырого ключа (`SELECT` показывает только ciphertext), `GET status` = `secret_bound:true`, наружу ключ не отдаётся.
- Системный агент/ассистент существует в реестре **без оргструктуры** (`employee_id IS NULL`), оргструктура его не показывает.
- Любой член тенанта может открыть чат ассистента; не-админ не может править подключение/ключ (403).
- Рабочий агент — в оргструктуре, ссылается на подключение.
- После N вызовов экран «Расход» показывает токены и сумму по агенту/подключению (из `spend_ledger`).

## 10. Non-goals / отложено

- Жёсткие потолки и отсечка по бюджету (L6, позже — decision 3).
- `vault://` энтерпрайз-резолвер.
- Биллинг/выставление счетов (только внутренний учёт расхода).
- Ротация мастер-ключа шифрования (key_version заложен, ротация — отдельно).
