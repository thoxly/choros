# ADR T-0574 — LLM-ключ тенанта до места в UI (BYO, secret-handle, замыкание разрыва)

Статус: **ready** · DESIGN · 2026-07-02 · слой E-AGENTS (L2/L3/L5 достроены; это последнее звено).
runtime_target: `web/` (экран) + `src/core/register.ts` + `migrations/` + `src/http/agents.ts` (расширение адресации).

---

## 1. Контекст и разрыв (что уже построено, чего физически нет)

Инфраструктура BYO-ключа построена (T-0474…T-0498, миграции 093/094/106):

- Экран `web/src/screens/screen-llm-connections.jsx` (`/llm-connections`, `status: "live"`) —
  создание профиля, `ConnectionKeyBinder` (write-only `POST /api/llm-connections/:id/key`,
  шифр в `app_secret`, отдаёт только `secret_bound:bool`), `ConnectionTester`
  (`POST /api/llm-connections/:id/test`, живой вызов + `sanitizeProviderError`).
- Резолвер `src/db/agent-provision.ts:readConfiguredAgentLlmConfig` уже
  `LEFT JOIN choros.llm_connection` + `COALESCE(lc.*, ac.*)` и **сортирует
  `assistant-agent` первым** (`ORDER BY CASE WHEN e.slug='assistant-agent' THEN 0 ELSE 1`),
  а `loadTenantLlmConfig` (`server.ts:makeLlmPortFactory`) читает свежую конфигурацию из БД
  на каждый вызов → рестарт не нужен.
- `PUT /api/agents/:id/llm-connection` (`src/http/agents.ts:handleSetAgentLlmConnection`)
  + DAO `setAgentLlmConnection` пишут `agent_card.llm_connection_id`, **адресуя по
  `agent_card.employee_id`**.

**Разрыв (подтверждён кодом).** `src/core/register.ts` создаёт `assistant-agent`
тенанта как `employee(kind='agent', slug='assistant-agent')` (шаг 3f) **без строки
`agent_card`** (явно зафиксировано в комментарии `migrations/093_..._nullable.sql`:
«assistant-agent … writes NO agent_card row today»). Единственный писатель
`agent_card` — `insertAgentRows` (найм РАБОЧЕГО агента). Следствие цепочкой:

1. `GET /api/agents` (`agents-list.ts`) селектит `FROM choros.agent_card ac` (registry-driven,
   LEFT JOIN employee) → без `agent_card`-строки ассистента его **нет в списке агентов**.
2. `setAgentLlmConnection` делает `UPDATE choros.agent_card ... WHERE employee_id = $1` →
   для ассистента совпадений **ноль** → возвращает `null` → хендлер отдаёт
   **`404 AGENT_NOT_FOUND`** — ровно анти-кейс AC-4.
3. Владелец создаёт профиль и вставляет ключ на `/llm-connections`, но **привязать его
   к ассистенту неоткуда** — UI-цепочка обрывается на последнем шаге (D-064: обход/тупик = P0).

Ограничение схемы для любой починки: `agent_card.kc_client_id` — **глобально UNIQUE**
(миграция 092, `agent_card_kc_client_id_global_uq`) + per-tenant UNIQUE (032). Значит
строка карты ассистента обязана нести per-tenant-детерминированный, глобально
уникальный `kc_client_id` — и его нельзя хардкодить (много тенантов).

---

## 2. Решение

**Дать `assistant-agent` каждого тенанта строку `agent_card` (as-a-system-agent,
`agent_type='assistant'`, `employee_id`=его employee, `kc_client_id='assistant-agent-<tenantId>'`),
адресуемую существующим `employee_id`-путём — так, что весь существующий контур
(`GET /api/agents` → селектор → `PUT /api/agents/:id/llm-connection` → `setAgentLlmConnection`
→ резолвер `assistant-agent-first`) начинает работать БЕЗ переписывания.** Плюс на экране
`/llm-connections` — минимальная прямая аффорданс-связка «назначить ассистенту» на карточке
профиля (соразмерность: LIVE_PROOF-путь владельца не должен уходить на экран агентов).

Механизм — три дельты, ни одна не перестраивает контур:

### 2.1 Создание для НОВЫХ тенантов (register.ts, шаг 3f-bis)

В ту же транзакцию онбординга, сразу после 3f (INSERT employee assistant-agent),
добавить INSERT строки `agent_card` для этого employee:

```
-- 3f-bis. agent_card для assistant-agent: делает его АДРЕСУЕМЫМ для
--         PUT /api/agents/:id/llm-connection (иначе 404 AGENT_NOT_FOUND).
--         employee_id = agentEmployeeId (адресация по employee_id, как у workforce).
--         agent_type = 'assistant' (таксономия 093).
--         kc_client_id = 'assistant-agent-' || tenantId  — per-tenant детерминирован,
--           глобально уникален (092), НЕ Keycloak service-account (ассистент не
--           логинится как сервис — это внутритенантный chat-helper). НЕ хардкод.
--         llm_endpoint/llm_model/llm_secret_handle/llm_connection_id = NULL (dormant),
--           autonomy_threshold = NULL. id = gen_random_uuid() (surrogate, 093).
INSERT INTO choros.agent_card
  (tenant_id, id, employee_id, employee_kind, agent_type, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, llm_connection_id,
   autonomy_threshold, created_at, updated_at)
VALUES
  ($tenantId, gen_random_uuid(), $agentEmployeeId, 'agent', 'assistant',
   'assistant-agent-' || $tenantId::text,
   NULL, NULL, NULL, NULL, NULL, $ts, $ts)
ON CONFLICT DO NOTHING;
```

`id`-переменную генерирует `randomUUID()` в TS рядом с прочими id (как `agentEmployeeId`),
чтобы вставка была детерминированной в тесте. `ON CONFLICT DO NOTHING` (PK `(tenant_id,id)`
+ уникальный `(tenant_id,employee_id)` из 093) держит идемпотентность.

### 2.2 Бэкфилл для СУЩЕСТВУЮЩИХ тенантов (новая миграция)

Новая миграция `migrations/115_assistant_agent_card_backfill.sql` (следующий свободный
слот после 114): для КАЖДОГО тенанта, у которого есть `employee(slug='assistant-agent',
kind='agent')`, но НЕТ соответствующей `agent_card`-строки — вставить её. Набор-driven
(`INSERT … SELECT … FROM employee e LEFT JOIN agent_card ac … WHERE ac.id IS NULL`),
`kc_client_id = 'assistant-agent-' || e.tenant_id`, **без единого литерального tenant-UUID**
(правило «бэкфилл без хардкода»; check `demo/no-hardcoded-tenant` + `no-hardcoded-fixture-ids`):

```
INSERT INTO choros.agent_card
  (tenant_id, id, employee_id, employee_kind, agent_type, kc_client_id,
   autonomy_threshold, created_at, updated_at)
SELECT e.tenant_id, gen_random_uuid(), e.id, 'agent', 'assistant',
       'assistant-agent-' || e.tenant_id::text,
       NULL, <ts>, <ts>
  FROM choros.employee e
  LEFT JOIN choros.agent_card ac
       ON ac.tenant_id = e.tenant_id AND ac.employee_id = e.id
 WHERE e.slug = 'assistant-agent' AND e.kind = 'agent'
   AND ac.id IS NULL;
```

Идемпотентно (`WHERE ac.id IS NULL` + `ON CONFLICT DO NOTHING`); повторный прогон — no-op.
`llm_*` = NULL (dormant), не трогает `secret-handle-isolation` FF-25-5 (seed unchanged —
эта миграция не seed-плоскости, а бэкфилл структуры; `llm_secret_handle` остаётся NULL).

### 2.3 Прямая связка на экране (F4/AC-4, LIVE_PROOF владельца)

На карточке профиля в `screen-llm-connections.jsx` (рядом с `ConnectionKeyBinder`/`ConnectionTester`)
добавить действие **«Назначить ассистенту»** (kit `Button`, вторичный вид). Оно:

1. Резолвит employee_id ассистента: `GET /api/agents` → элемент с `agent_type==='assistant'`
   (либо `slug==='assistant-agent'`), берёт `.id` (это employee_id по контракту serializeAgent).
2. `PUT /api/agents/<assistantId>/llm-connection` с `{ llm_connection_id: c.id }`.
3. По `200` — тост/чип «профиль назначен ассистенту» + рефетч. По `403` — честное
   «недостаточно прав» (N6). По `404` — не должно случаться после 2.1/2.2 (это и есть anti-regression).

Показывать на карточке чип **«ассистент использует этот профиль»**, когда
`assistantConnectionId === c.id` (сравнение с текущей привязкой из `GET /api/agents`) —
чтобы владелец видел исход без ухода на другой экран. Кнопка «назначить» скрыта/дизейблится
на уже-назначенном профиле (нет мёртвых enabled-аффордансов, G-правило).

**Никаких новых серверных эндпоинтов.** F4 переиспользует `PUT /api/agents/:id/llm-connection`
как есть — после 2.1/2.2 он резолвит ассистента по `employee_id`. Разрыв закрыт данными,
а не переписыванием адресации.

---

## 3. Отклонённые альтернативы

| Опция | Почему нет |
|---|---|
| **Lazy-create `agent_card` при чтении/привязке** (в `setAgentLlmConnection` делать INSERT-if-missing) | Прячет запись в DAO, помеченном «writes ONLY the connection-id FK, never …»; ломает контракт кастодии и `named-binding-isolation`; двойная семантика UPDATE-или-INSERT непрозрачна и не идемпотентна под гонкой. Данные должны существовать до привязки. |
| **Расширить адресацию `setAgentLlmConnection`/route на employee-slug без agent_card** (UPSERT по slug) | Требует переписать addressing-контракт (сегодня строго employee_id → agent_card), затрагивает audit payload и `GET /api/agents` (ассистент всё равно не появится в списке → селектор пуст). Больше поверхности, тот же результат. |
| **Только backfill-миграция, без вставки в register.ts** | Новые тенанты снова родятся без карты → регресс через один онбординг. Нужны ОБА (новые + существующие). |
| **Хардкод известного dev-tenant UUID в бэкфилле** | Прямое нарушение «бэкфилл без хардкода» (D-064) и `demo/no-hardcoded-tenant`/`no-hardcoded-fixture-ids`; молчаливо пропустит прод-тенанты. Set-driven `SELECT … FROM employee` — единственно верно. |
| **Отдельный новый эндпоинт `POST /api/assistant/llm-connection`** | Дублирует существующий `PUT /api/agents/:id/llm-connection`; лишняя поверхность аутентификации/аудита ради того, что уже есть. Соразмерность нарушена. |
| **F4 только на экране агентов** (не трогать `/llm-connections`) | LIVE_PROOF-путь владельца («настройки → ключ → проверка → ассистент отвечает») разорвался бы уходом на другой экран искать ассистента среди рабочих агентов; когнитивный обход. Минимальная связка на том же экране дешевле и целостнее. |
| **Anthropic-совместимый адаптер порта в этой задаче** (BQ-1) | Вне scope (O3). Критерии провайдер-агностичны (AC-6 допускает любой реально работающий OpenAI-совместимый провайдер); протокол-несовместимость Anthropic — отдельный блокер импла, не дизайна. |

---

## 4. Объектная модель (единый контракт полей/типов)

### agent_card (существующая; ADR фиксирует НАБОР значений для строки ассистента — новых колонок НЕТ)

| Поле | Тип | Значение для строки assistant-agent |
|---|---|---|
| tenant_id | uuid | тенант |
| id | uuid | `gen_random_uuid()` (surrogate, 093) |
| employee_id | uuid | = employee ассистента (`kind='agent', slug='assistant-agent'`) — АДРЕС привязки |
| employee_kind | text | `'agent'` |
| agent_type | text | `'assistant'` (таксономия 093; НЕ в оргструктуре, `GET /api/org` его не покажет) |
| kc_client_id | text | `'assistant-agent-' || tenant_id` — per-tenant детерминирован, глобально UNIQUE (092), не Keycloak-сервис, НЕ хардкод |
| llm_endpoint / llm_model / llm_secret_handle | text NULL | NULL (dormant; резолв идёт ЧЕРЕЗ llm_connection_id) |
| llm_connection_id | uuid NULL | NULL при создании; проставляется `PUT /api/agents/:id/llm-connection` (F4) |
| autonomy_threshold | numeric NULL | NULL |
| created_at / updated_at | bigint | ts |

### Наблюдаемое (не хранимое) — контракт экрана

| Поле | Тип | Источник |
|---|---|---|
| assistantEmployeeId | string(uuid) | `GET /api/agents` → `.id` элемента с `agent_type==='assistant'` |
| assistantConnectionId | string(uuid) \| null | `GET /api/agents` → `.llm_connection_id` того же элемента (текущая привязка) |

---

## 5. Контракты (совместимость public-поверхности)

- **C1.** `agent_card`: **новых колонок нет** — только новая СТРОКА для существующего employee.
  Читатели `agents-list.ts` / `readConfiguredAgentLlmConfig` / `readAgentCardLlmConfigById`
  (LEFT JOIN, COALESCE) уже толерантны к `agent_type='assistant'` и NULL `llm_*`. Импортёры
  `serializeAgent`: ассистент выходит с `has_org_place:false`, `id=employee_id` (не surrogate,
  т.к. employee_id задан), `agent_type:'assistant'` — совместимо с текущим типом `AgentPublic`.
- **C2.** `PUT /api/agents/:id/llm-connection` — сигнатура/тело/ответ БЕЗ изменений. После
  бэкфилла для `:id = assistantEmployeeId` возвращает `200` вместо `404`. Grep импортёров
  `setAgentLlmConnection`: единственный вызыватель — `handleSetAgentLlmConnection` (agents.ts);
  контракт возврата (`employee_id|null`) не меняется.
- **C3.** `readConfiguredAgentLlmConfig` уже `ORDER BY assistant-agent-first` → как только у
  ассистента появляется резолвимый `llm_connection_id`, `loadTenantLlmConfig`/`makeLlmPortFactory`
  выбирает именно его на СЛЕДУЮЩЕМ чат-запросе (AC-5, без рестарта). Изменений в резолвере нет.
- **C4.** **env-fallback НЕ ломается.** COALESCE-цепочка `COALESCE(lc.*, ac.llm_*)` и
  server-level fallback на env-конфиг сохранены: пока `llm_connection_id` не привязан,
  ассистент остаётся dormant/env-fallback ровно как сегодня; привязка лишь ДОБАВЛЯЕТ путь,
  не удаляя старый. Ни одна COALESCE-ветка не удаляется.
- **C5.** Секрет-кастодия: ни `agent_card`-строка ассистента, ни F4-поток, ни аудит
  `set_agent_llm_connection` (payload = только FK + redacted summary) не несут сырого ключа —
  ключ живёт на `llm_connection`/`app_secret`, резолвится только в памяти сервера (N1–N4).

---

## 6. Fitness-функции (ОБЯЗАТЕЛЬНЫ)

### Функциональные / инвариантные

- **FF-1 (AC-7, N1)** — *Секрет не в HTTP-ответе.* Интеграционный прогон бьёт
  `POST /api/llm-connections/:id/key` известной тестовой строкой ключа, затем собирает тела
  ВСЕХ ответов маршрутов `/api/llm-connections/*`, `/api/agents/:id/llm-connection`,
  `/api/agents/:id/secret-handle*` (список/статус/тест/привязка/ошибки) — тестовая строка
  не встречается ни в одном.
  `ci_check`: `vitest run test/http/llm-key-no-leak.integration.test.ts`
- **FF-2 (AC-8, N2)** — *Секрет не в логах/аудите.* После прогона AC-2/AC-3/привязки —
  греп серверного stdout-лога И `audit_event.payload` на тестовую строку ключа: ноль совпадений
  (в т.ч. в санитайзенном тексте ошибки провайдера).
  `ci_check`: `bash ci/checks/precheck-secret-custody.sh && vitest run test/http/llm-key-no-log-leak.integration.test.ts`
- **FF-3 (AC-4)** — *Ассистент адресуем.* Тест: свежий тенант (registerTenant) → `GET /api/agents`
  содержит элемент `agent_type==='assistant'`; `PUT /api/agents/<его id>/llm-connection`
  с валидным `llm_connection_id` возвращает `200` (НЕ `404 AGENT_NOT_FOUND`).
  `ci_check`: `vitest run test/http/assistant-llm-binding.integration.test.ts`
- **FF-4 (AC-5, C3)** — *Резолв ассистента без рестарта.* После FF-3-привязки к профилю с
  рабочим handle: `loadTenantLlmConfig(tenant)` (или HTTP-эквивалент) возвращает non-null с
  endpoint/model этого профиля в ТОЙ ЖЕ серверной сессии.
  `ci_check`: `vitest run test/db/tenant-llm-resolve.integration.test.ts`
- **FF-5 (бэкфилл без хардкода, §2.2)** — миграция `115_*` НЕ содержит литерального tenant-UUID
  (`[0-9a-f]{8}-…`) и driven по `SELECT … FROM choros.employee` (set-driven).
  `ci_check`: `bash ci/checks/demo/no-hardcoded-tenant.sh && bash ci/checks/seed/no-hardcoded-fixture-ids.sh`
- **FF-6 (идемпотентность миграции)** — двойной прогон `115_*` не создаёт дублей
  `agent_card` для одного (tenant_id, employee_id).
  `ci_check`: `bash ci/checks/acceptance/seed-idempotent.sh && npm run migrate -- --dry-check`
- **FF-7 (AC-10, N6)** — привязка/сохранение/удаление под непривилегированным членом тенанта →
  `403`, не `500`/тихо. Тест на `PUT /api/agents/:id/llm-connection` без гранта →
  `403 ADMIN_GATE_REJECTED`.
  `ci_check`: `vitest run test/http/agents-llm-connection-authz.integration.test.ts`
- **FF-8 (AC-1/AC-2/AC-3, кастодия реестра)** — статические инварианты секрет-хендла
  сохранены (handle только в T-0025-файлах, нет LLM-SDK, seed llm_secret_handle=NULL).
  `ci_check`: `bash ci/checks/secret-handle-isolation.sh && bash ci/checks/named-binding-isolation.sh`

### FF-UX (гейт G1–G7, D-062)

- **FF-UX-1 (AC-12, G2/G7 — контраст обе темы)** — новые/изменённые узлы экрана (кнопка
  «назначить ассистенту», чип «ассистент использует профиль») читаемы в light И dark:
  тема через `data-theme`, LIGHT в `:root`, DARK — явный блок; контраст статус-чипов
  AA (≥4.5:1 для текста).
  `ci_check`: `bash ci/checks/ux/ux-g2-theme-pairing.sh`
- **FF-UX-2 (AC-12, G6 — токены, не инлайн-хардкод)** — все НОВЫЕ строки экрана используют
  `--chs-*` токены/kit-компоненты; нет вновь добавленных hardcoded-цветов/оверлеев.
  `ci_check`: `bash ci/checks/ux/ux-g6-no-new-hardcode.sh`
- **FF-UX-3 (AC-11, G5 — нет дев-жаргона)** — статический блок-инструкция (§F6: где взять
  ключ Anthropic, что вставить) и подписи действий не содержат `endpoint`/`handle`/`resolve`/
  `llm_connection_id`/UUID/HTTP-кодов в видимом тексте.
  `ci_check`: `bash ci/checks/ux/ux-g5-jargon-denylist.sh`
- **FF-UX-4 (AC-9 — Empty/Loading/Error)** — экран рендерит видимые `EmptyState` (0 профилей,
  призыв к действию), `LoadingState`, `ErrorState` (сеть/5xx при загрузке ИЛИ сохранении) с
  повтором; нет белого экрана/uncaught. (Уже частично есть на 666–677 — не регресс.)
  `ci_check`: `vitest run web/src/screens/__tests__/screen-llm-connections.states.test.jsx`
- **FF-UX-5 (AC-12 — label/aria + нет мёртвых аффордансов)** — поле ключа несёт
  `label`/`aria-*` (`autoComplete="off"`, `type="password"` — N5, не регресс); кнопка
  «назначить ассистенту» дизейблена/скрыта на уже-назначенном профиле (нет enabled-no-op).
  `ci_check`: `vitest run web/src/screens/__tests__/screen-llm-connections.a11y.test.jsx`

---

## 7. Трассировка AC → покрытие

| AC | Покрыто |
|---|---|
| AC-1 | Существующий `POST /api/llm-connections` + пресет Anthropic (F1); FF-8 (кастодия реестра не тронута) |
| AC-2 | Существующий `POST /:id/key` + `GET` без ключа; FF-1 |
| AC-3 | Существующий `POST /:id/test` + `sanitizeProviderError`; FF-1 |
| **AC-4** | §2.1 register.ts 3f-bis + §2.2 миграция 115 + §2.3 F4-связка; **FF-3** |
| AC-5 | C3 (резолвер assistant-first, свежая конфигурация); **FF-4** |
| AC-6 (LIVE_PROOF) | Весь путь §2 замкнут в UI; ручная приёмка на dev-стенде (D-064) |
| AC-7 | C5/N1; **FF-1** |
| AC-8 | C5/N2; **FF-2** |
| AC-9 | §2.3 состояния; **FF-UX-4** |
| AC-10 | Существующий гейт `holdsAgentMgmtUpdate`; **FF-7** |
| AC-11 | §F6 статический недев-текст; **FF-UX-3** |
| AC-12 (UX_REVIEW) | design-steward + **FF-UX-1/2/3/5** |

---

## 8. Границы и эскалация

- **Нет эскалации к фаундеру** (нет денег/секретов-платформы/необратимого; ключ вставляет
  сам владелец на dev-стенде — это и есть LIVE_PROOF-шаг AC-6, не решение фаундера).
- BQ-1 (Anthropic protocol) — вне scope (O3), провайдер-агностичные критерии; если на импле
  подтвердится несовместимость адаптера — отдельный блокер импла, не этой задачи/ADR.
- Соразмерность соблюдена: 0 новых эндпоинтов, 0 новых колонок, 0 новых таблиц; дельта =
  1 INSERT в онбординге + 1 идемпотентная миграция-бэкфилл + минимальная UI-связка на
  существующем экране.
