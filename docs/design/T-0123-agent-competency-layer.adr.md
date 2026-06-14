# ADR · T-0123 — Компетентностный слой агента (инструкция/промт при `agent_card`)

**Task:** T-0123 · **Phase:** DESIGN (architect) · **Status:** `needs_founder`
**Date:** 2026-06-14 (re-grounded на ратифицированный T-0087-механизм, см. §0.1)
**spec_ref:** `docs/specs/T-0123-agent-competence.spec.md`
**Authoritative inputs (НЕ переоткрываются):**
`playbooks/choros-product-gap-map.md` §2/§4б · `playbooks/choros-reference-process-tel.md` §5 ·
`CONCEPT.md` §3 · `docs/design/extensibility-and-authoring.md` §1/§4/§7/§8/§9 ·
`docs/design/T-0020-agent-card.adr.md` §1.5/§4.3 · `docs/design/T-0013-tenant-isolation.adr.md` ·
`docs/design/T-0021-grant-resolver-pdp.adr.md` · **`docs/design/T-0087-client-env-tiers.adr.md`** (РАТИФИЦИРОВАН, приземлён) ·
`migrations/032_agent_card.sql` (T-0020) · **`migrations/049_tier.sql` (T-0087, приземлён)** ·
`src/core/env-tier.ts` (T-0087) · `src/http/artifacts.ts` (T-0087 promote-сервис) ·
`src/db/agent-provision.ts` (T-0042) · `src/db/audit-writer.ts` (T-0016/T-0019 floor).

---

## 0. Контекст и связывающее ограничение

Спека T-0123 фиксирует ЧТО (FR/NF/AC) и оставляет architect-у форму хранения,
объектную модель и связь с единицей версионирования. Сверка ТЕКУЩЕЙ dev-кодовой
базы дала три несущих факта, которые формируют это решение.

1. **Сема T-0123 в `agent_card` уже зарезервирована.** `migrations/032_agent_card.sql`
   (комментарий «NO prompt/instruction column here — the competence layer (T-0123)
   adds it via additive migration. The table is deliberately narrow») и
   `T-0020-agent-card.adr.md` §1.5/§4.3 держат таблицу узкой, чтобы T-0123
   приходил аддитивно, не трогая 032-DDL и не ломая T-0042 write-path.

2. **Механизм версионирования-как-конфиг УЖЕ ратифицирован и приземлён — T-0087.**
   `migrations/049_tier.sql` (E12.6) ввёл два логических тира `draft → published`
   в одном silo как **колонку `tier text NOT NULL DEFAULT 'draft' CHECK (tier IN
   ('draft','published'))`** на каждой tier-несущей CONFIG-таблице, плюс
   fail-closed DB-триггер `tier_published_locked` (запрещает прямой UPDATE/DELETE
   published-строк, если транзакция не выставила `SET LOCAL choros.promoting='1'`,
   что делает ТОЛЬКО promote-сервис). App-слой: `src/core/env-tier.ts` —
   `assertWritable` (published-lock гард), `decidePromote` (чистое human-gated
   решение: agent-self-promote запрещён), `readTierScope` (дефолт-чтение
   published). Promote-сервис: `src/http/artifacts.ts::promoteTier` +
   `POST /api/artifacts/:id/promote`, атомарно флипает tier и пишет аудит
   `artifact.promoted` в одной транзакции; реестр промоутируемых таблиц —
   `CONFIG_TABLES = {application, registry_def, grant}`.
   **Это и есть «единый механизм версионирования», который T-0123 ПЕРЕИСПОЛЬЗУЕТ
   ПОЛНОСТЬЮ** (NF-1, инвариант gap-map §4б). T-0123 НЕ вводит своих тиров,
   своего promote-пути, своего lock-механизма и своего аудит-типа.

3. **Реестр когерентной связки (`bundle`, E12.1/T-0082) ещё НЕ приземлён.** Поиск
   по `migrations/` не нашёл таблицы `bundle`/`config_version` (последняя миграция
   — 055). Поэтому жёсткая привязка инструкции к единице связки невозможна day-1:
   T-0123 кладёт **forward-compat-указатель `bundle_id uuid NULL` без FK** (идиома
   032: `budget_policy_id`/`escalation_rule_id` uuid NULL, FK добавляет
   владелец-задача позже). Когда T-0082 приземлит реестр, он добавит FK аддитивно,
   и промоушн инструкции станет частью одного промоушна связки без второго потока.

Из (1)+(2) следует ключевой архитектурный выбор. T-0087 крепит `tier` КОЛОНКОЙ на
саму версионируемую CONFIG-таблицу (`application`/`registry_def`/`grant`). `agent_card`
сознательно НЕ получила `tier` в 049 (это карточка идентичности агента, не
версионируемый конфиг-артефакт). Инструкция же — именно версионируемый
конфиг-артефакт. Значит инструкция живёт **в отдельной additive-таблице
`agent_instruction`, несущей `tier`-колонку по контракту T-0087**, а не столбцом на
`agent_card`. Это (а) аддитивно к `agent_card` (032-DDL не трогается, карточка
остаётся узкой — §1.5/§4.3 соблюдены); (б) делает инструкцию первоклассным
tier-артефактом, который promote-ится тем же endpoint-ом, что и остальной конфиг.

### 0.1 Чем это решение отличается от первой редакции (re-grounding)

Первая редакция ADR (2026-06-13) была написана ДО приземления T-0087 и опиралась
на PDP-seam миграции 044 (`resource_type='authoring_draft'/'authoring_published'`
+ `request_promote`) как на «механизм версионирования». С тех пор на dev
приземлился T-0087 (`migrations/049_tier.sql` + `src/core/env-tier.ts` +
`src/http/artifacts.ts`), который и есть ратифицированный versioning-механизм.
Эта редакция переориентирована на него:

| Ось | Первая редакция (стейл) | Эта редакция (на T-0087) |
|---|---|---|
| Тир-значения | `'authoring_draft'`/`'authoring_published'` (из 044) | `'draft'`/`'published'` (T-0087 канон, `env-tier.ts::Tier`) |
| Где тир | в составе PK `(tenant_id, employee_id, tier)` | колонка `tier` (контракт 049), PK `(tenant_id, employee_id)` как у `agent_card` |
| Published-lock | write-path гард в DAO + PDP zero-grant | **DB-триггер `tier_published_locked`** (049) + app `assertWritable` (env-tier.ts) |
| Promote | свой `promote()` через `request_promote` (044) | существующий `promoteTier` / `POST /api/artifacts/:id/promote`; `agent_instruction` вносится в `CONFIG_TABLES` |
| Аудит promote | новый тип `agent.instruction.promoted` | существующий `artifact.promoted` (один тип на все артефакты, NF-3) |
| Решение promote | свой human-gate | существующий `decidePromote` (agent-self-promote forbidden) |

Это строго усиливает NF-1/NF-3 (один механизм версионирования и аудита, не
параллельный) и сокращает объём impl. Содержательная часть (что хранит инструкция,
изоляция, не-расширение прав, дормантность, эскалация Q-1) сохранена.

---

## 1. Decision (что решаем)

Ввести компетентностный слой агента как **отдельную тенант-изолированную CONFIG-
таблицу `choros.agent_instruction`** (additive-миграция, следующий свободный слот
**057**), привязанную к `employee(kind='agent')` тем же composite-FK-идиомом, что и
`agent_card`, и **полностью встроенную в ратифицированный tier-механизм T-0087**:

- **Содержание инструкции (AC-1).** `instruction_text` (основной текст компетенции
  — «должностная инструкция»: как агент трактует задачу и формирует ответ) +
  `answer_form` (машинно-различимый параметр формы ответа банк-кейса, напр.
  `'sum'` / `'sum_with_breakdown'`) + `instruction_meta jsonb` (расширяемый конверт
  будущих параметров формы — чтобы не плодить миграции на каждый банк-кейс).

- **Версионирование как конфиг через T-0087 (AC-4/AC-5/AC-6, NF-1).** Таблица
  несёт **колонку `tier text NOT NULL DEFAULT 'draft' CHECK (tier IN
  ('draft','published'))`** по точному контракту `migrations/049_tier.sql`. На
  таблицу вешается триггер `tier_published_locked` (fail-closed: прямой
  UPDATE/DELETE published-строки запрещён вне promote-транзакции). App-слой
  использует `assertWritable` (env-tier.ts) перед правкой. **Своего тира,
  lock-механизма, promote и аудит-типа T-0123 НЕ вводит.**

- **Promote через существующий endpoint (AC-6).** `agent_instruction` вносится в
  реестр `CONFIG_TABLES` (`src/http/artifacts.ts`). Переход draft→published идёт
  ТОЛЬКО через существующий `POST /api/artifacts/:id/promote` →
  `promoteTier` → `decidePromote` (human-gated: agent-self-promote → 403; уже
  published → 409; human+draft → флип tier + аудит `artifact.promoted` атомарно).
  «deploy ≠ active» и one-click для нетехничного админа наследуются от T-0087 «как
  есть».

- **Двухтировая сосуществующая редакция (extensibility §8).** Поскольку T-0087
  крепит tier колонкой (одна строка артефакта несёт свой tier, не две строки
  draft+published на сущность), модель T-0123 идентична остальным CONFIG-артефактам:
  одна строка инструкции на агента, её `tier` либо `draft` (правится), либо
  `published` (locked). Это снимает потребность в двухстрочном PK из первой
  редакции и точно совпадает с тем, как версионируются `application`/`grant`.

- **Forward-compat-связь с единицей версионирования (AC-4).** Колонка `bundle_id
  uuid NULL` **без FK** — указатель на когерентную связку E12.1/T-0082. Пока
  T-0082 не приземлил реестр `bundle`, `bundle_id` дормантен (NULL); T-0082
  добавит FK аддитивно (идиома 032 `budget_policy_id`).

- **Семантический changelog (AC-7, NF-6).** Наружу клиент видит семантическую
  строку (`answer_form: sum → sum_with_breakdown`; `instruction_text: изменён`), не
  raw text-diff и не «bundle vN→vN+1». Источник — детерминированный пофолевой
  диффер `diffInstruction(published, draft)` (сравнение published-строки с
  draft-редакцией по полям). Это симметрично extensibility §9 («независимый
  детерминированный валидатор changelog»).

- **Аудит (AC-9, NF-3).** Promote инструкции аудируется существующим типом
  `artifact.promoted` (тот же, что для `application`/`grant`) — один аудит-механизм,
  не параллельный. Правки draft аудируются дотированным типом
  `agent.instruction.draft_saved` через существующий `AuditWriter.appendAuditEvent`
  (T-0016/T-0019 floor); очистка/удаление — `agent.instruction.cleared`
  (RED-LINES, AC-14, актор-человек). Аудит draft-правок отдельным типом оправдан:
  T-0087 endpoint аудирует только promote-переход; create/edit draft-контента —
  доменное событие T-0123, не покрытое promote-аудитом.

- **Дормантность рантайма (AC-11, FR-7).** Day-1 ни один рантайм-путь
  (HTTP-хендлеры ответа, PDP, движок, external-task worker) не читает
  `agent_instruction` для формирования ответа агента. Реальное «агент отвечает по
  инструкции» — Stage-2 (E5.6–E5.10, запаркован). Слой
  хранится/версионируется/правится/аудируется, как `autonomy_threshold` в 032
  дормантен. (Чтение в authoring-DAO, в changelog-диффере и в promote-пути —
  допустимо: это авторинг, не рантайм-ответ.)

- **Изоляция (AC-2, NF-4).** `agent_instruction` — T-0013-таблица: `tenant_id`
  ведущий в PK, `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy на
  `current_setting('choros.tenant_id', true)::uuid`, `GRANT … TO choros_app`,
  внесена в `ci/checks/known_tenant_tables.txt`.

- **Права не расширяются (AC-8, FR-4/NF-2).** `agent_instruction` НЕ участвует в
  PDP-решении. Содержание инструкции не читается grant-resolver-ом; ссылка
  инструкции на инструмент/данные вне грантов агента не даёт доступа (fail-closed
  T-0021). Правка инструкции не трогает таблицу `grant`.

**Право/путь авторинга инструкции у клиента (Q-1) НЕ решается этим ADR** — это
продуктовый выбор фаундера (см. §7 Escalation). Всё остальное (хранение,
tier-механика через T-0087, promote, аудит, изоляция, дормантность, не-расширение
прав) спроектировано в рамках ратифицированных решений и от ответа на Q-1 НЕ
зависит — coder может строить миграцию 057, DAO, аудит draft-типов, регистрацию в
`CONFIG_TABLES` и fitness-чеки немедленно.

---

## 2. Object model

### Таблица `choros.agent_instruction` (новая, миграция 057, additive, CONFIG-класс)

| Колонка | Тип | Назначение |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | T-0013 ведущий ключ; RLS-якорь |
| `id` | `uuid NOT NULL` | id артефакта инструкции (target для `POST /api/artifacts/:id/promote`) |
| `employee_id` | `uuid NOT NULL` | агент-владелец инструкции |
| `employee_kind` | `text NOT NULL DEFAULT 'agent'` | FK-дискриминатор; `CHECK (employee_kind='agent')` (идиома 032) |
| `tier` | `text NOT NULL DEFAULT 'draft'` | `CHECK (tier IN ('draft','published'))` — РОВНО контракт `049_tier.sql` (T-0087) |
| `instruction_text` | `text NOT NULL` | основной текст компетенции (AC-1) |
| `answer_form` | `text NULL` | параметр формы ответа банк-кейса (`'sum'`/`'sum_with_breakdown'`/…); NULL = форма не задана |
| `instruction_meta` | `jsonb NOT NULL DEFAULT '{}'` | расширяемый конверт доп-параметров формы (без миграции на каждый кейс) |
| `bundle_id` | `uuid NULL` | forward-compat указатель на связку E12.1/T-0082; **NO FK** day-1 (дормантен) |
| `created_at` | `bigint NOT NULL` | |
| `updated_at` | `bigint NOT NULL` | |

**Ключи / гарды:**
- `PRIMARY KEY (tenant_id, id)` — идиома промоутируемого артефакта (promote-сервис
  адресует строку по `(tenant_id, id)`, см. `artifacts.ts::promoteTier`).
- `UNIQUE (tenant_id, employee_id)` — один артефакт инструкции на агента (одна
  строка несёт свой tier; draft↔published — это значение колонки, не вторая строка).
- `FOREIGN KEY (tenant_id, employee_id, employee_kind) REFERENCES choros.employee(tenant_id, id, kind)` — переиспользует UNIQUE из 016/032; указывает только на `kind='agent'`.
- `CHECK (tier IN ('draft','published'))` — контракт T-0087.
- `CHECK (employee_kind = 'agent')`.
- **Триггер** `tier_published_locked BEFORE UPDATE OR DELETE` — переиспользует
  существующую функцию `choros.tier_published_locked()` (049); вешается на
  `agent_instruction` тем же `CREATE TRIGGER … EXECUTE FUNCTION
  choros.tier_published_locked()`, что и на `application`/`grant`.
- RLS: `ENABLE`+`FORCE`, policy `tenant_id = current_setting('choros.tenant_id', true)::uuid`, `WITH CHECK` симметрично.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_instruction TO choros_app`.

«Нет инструкции» (AC-10) = отсутствие строки для агента — валидное дормантное
состояние. Миграция 057 НЕ сидит инструкции для dev-агентов (они остаются без
инструкции); ни одна существующая строка `agent_card`/`employee` не меняется.

### Реестр промоутируемых таблиц (правка, не новый механизм)

`CONFIG_TABLES` в `src/http/artifacts.ts` расширяется: `{application, registry_def,
grant}` → `{application, registry_def, grant, agent_instruction}`. Это единственная
правка promote-инфраструктуры; сам `promoteTier`/`decidePromote`/триггер не
меняются.

### Аудит-типы

| `type` | Когда | Механизм | `actor.type` |
|---|---|---|---|
| `artifact.promoted` | draft→published инструкции | **существующий** `promoteTier` (T-0087); НЕ новый | `human` (human-gate `decidePromote`) |
| `agent.instruction.draft_saved` | create/edit draft-контента инструкции | `AuditWriter.appendAuditEvent` в DAO | `human` или `agent` (config-агент) |
| `agent.instruction.cleared` | удаление/очистка инструкции (RED-LINES, AC-14) | `AuditWriter.appendAuditEvent` в DAO | `human` (default-DENY на необратимость) |

`payload` draft/cleared-событий несёт семантический changelog (изменённые поля), не
raw-text.

---

## 3. Contracts (единый контракт полей/типов для coder и tester)

1. **Миграция** `migrations/057_agent_instruction.sql` — DDL таблицы §2; колонка
   `tier` по контракту 049; `CREATE TRIGGER tier_published_locked … EXECUTE
   FUNCTION choros.tier_published_locked()`; FORCE RLS; `bundle_id` без FK
   (комментарий-сема для T-0082); без сид-инструкций; любой будущий сид-INSERT —
   `ON CONFLICT DO NOTHING`.
2. **Тип TS** `AgentInstruction` (новый, `src/core/agent-instruction.ts`):
   `{ tenantId: string; id: string; employeeId: string; employeeKind: 'agent';
   tier: import('./env-tier.js').Tier; instructionText: string; answerForm:
   string | null; instructionMeta: Record<string, unknown>; bundleId: string |
   null; createdAt: number; updatedAt: number }`. Поле `tier` ПЕРЕИСПОЛЬЗУЕТ тип
   `Tier` из `env-tier.ts` (не объявляет свой union).
3. **DAO** (новый, `src/db/agent-instruction-store.ts`), всё под открытой
   `withTenantTx` (паттерн `agent-provision.ts`/`artifacts.ts`, `tenant_id` ведущий):
   - `saveDraft(tx, instr)` — UPSERT строки инструкции в `tier='draft'`; ПЕРЕД
     записью вызывает `assertWritable(currentTier)` (env-tier.ts) и при
     `PUBLISHED_LOCKED` бросает typed error → 409 (AC-5). DAO НЕ пишет
     `tier='published'` (это делает только `promoteTier`).
   - `readPublished(tx, …)` / `readDraft(tx, …)` — read-only; дефолт-чтение через
     `readTierScope` (env-tier.ts).
   - `clear(tx, …)` — удаление через RED-LINES human-confirm путь (AC-14).
   Каждый мутирующий метод вызывает `AuditWriter.appendAuditEvent` в той же `tx`
   (атомарность audit+DB, паттерн T-0042/T-0087 `promoteTier`).
   **Promote НЕ реализуется в этом DAO** — он идёт через существующий
   `artifacts.ts::promoteTier` (инструкция зарегистрирована в `CONFIG_TABLES`).
4. **Changelog-функция** `diffInstruction(published, draft): SemanticChange[]` —
   детерминированный пофолевой диффер (`answer_form`, `instruction_text` — только
   признак «изменён», не тело, `instruction_meta`); НЕ raw code-diff (AC-7).
5. **Promote-контракт (НЕТ нового кода в promote-инфраструктуре).** Promote
   инструкции = `POST /api/artifacts/:id/promote` с `artifact_table:
   "agent_instruction"`; обслуживается существующим `promoteTier`/`decidePromote`
   (T-0087). Единственная правка — добавление `"agent_instruction"` в
   `CONFIG_TABLES`.
6. **PDP-инвариант (контракт для tester, НЕТ нового кода в PDP).** `agent_instruction`
   НЕ читается grant-resolver-ом (`src/core/grant-resolver.ts`) — этот файл остаётся
   frozen (FF-COMP-5). Авторизация авторинга/promote — через существующую
   authority-проверку promote-endpoint-а (T-0087 §4.5
   `mgmt_object:tier_promote`), не через содержание инструкции.

**Импортёры/совместимость (рефактор public-поверхности, правило architect §7):**
- `src/http/artifacts.ts` — расширяется ТОЛЬКО множество `CONFIG_TABLES` (additive:
  добавляется элемент, существующие не трогаются). Сигнатуры `promoteTier`,
  `registerArtifactRoutes`, route-контракт не меняются → потребители стабильны,
  frozen-тесты T-0087 на `application`/`grant` не затрагиваются.
- `src/core/env-tier.ts` — НЕ меняется (T-0123 только импортирует `Tier`,
  `assertWritable`, `readTierScope`); файл остаётся frozen-как-был.
- `insertAgentRows` (`src/db/agent-provision.ts`) НЕ расширяется — инструкция
  NULL-at-hire (строки `agent_instruction` при найме не создаётся), так что T-0042
  write-path и его frozen-checks (`agent-hire-frozen-additive.sh`,
  `agent-hire-migration-seam.sh`) не затрагиваются.
- `agent_card`-DDL (032) не трогается; его потребители стабильны.

---

## 4. Fitness functions (исполнимые CI-правила)

Каждое нарушаемое кодом архитектурное решение — отдельный shell-чек в `ci/checks/`
(идиома `agent-hire-*.sh` / `env-tier-*.sh`). Базовая линия (`$BASE`) и стиль
PASS/FAIL — как в `agent-hire-frozen-additive.sh` (merge-base с `dev`,
`set -euo pipefail`).

| id | rule | ci_check |
|---|---|---|
| FF-COMP-1 | Additive к T-0020: миграция 057 не трогает `032_agent_card.sql` и не добавляет колонок в `agent_card`/`employee`; новая таблица — отдельная. | `ci/checks/agent-instruction-additive.sh`: `git diff --name-only "$BASE" -- migrations/032_agent_card.sql` пусто; `! grep -q "ALTER TABLE choros.agent_card" migrations/057_agent_instruction.sql`; `grep -q "CREATE TABLE choros.agent_instruction" migrations/057_agent_instruction.sql`. |
| FF-COMP-2 | T-0013 изоляция: `agent_instruction` несёт `tenant_id` ведущим в PK, `FORCE ROW LEVEL SECURITY`, tenant-policy, и внесена в `known_tenant_tables.txt`. | `ci/checks/agent-instruction-rls.sh`: `grep -q "FORCE ROW LEVEL SECURITY"` и `grep -q "current_setting('choros.tenant_id'"` в 057; `grep -q "^agent_instruction$" ci/checks/known_tenant_tables.txt`; PK начинается с `tenant_id`. |
| FF-COMP-3 | Версионирование = T-0087 как есть (NF-1): `tier`-CHECK содержит РОВНО `draft`/`published` (контракт 049), и таблица несёт триггер `tier_published_locked`; своего версионного enum/механизма нет. | `ci/checks/agent-instruction-tier-reuse.sh`: `grep -qE "tier IN \('draft', ?'published'\)"` в 057; `grep -q "EXECUTE FUNCTION choros.tier_published_locked()"` в 057; перекрёстная сверка, что функция определена в `migrations/049_tier.sql`; отсутствие литералов `authoring_draft`/`authoring_published` в артефактах T-0123. |
| FF-COMP-4 | Promote — общий механизм T-0087, не свой (NF-1/NF-3): `agent_instruction` зарегистрирован в `CONFIG_TABLES`; в коде T-0123 нет своего `UPDATE … SET tier='published'` и нет своего promote-эндпоинта/типа. | `ci/checks/agent-instruction-promote-shared.sh`: `grep -q '"agent_instruction"' src/http/artifacts.ts` (в CONFIG_TABLES); `! grep -rq "SET tier = 'published'\|tier='published'" src/db/agent-instruction-store.ts`; `! grep -rq "agent.instruction.promoted" src/`. |
| FF-COMP-5 | Права не расширяются (AC-8): `src/core/grant-resolver.ts` не импортирует/не читает `agent_instruction`; файл frozen (0 diff к base). | `ci/checks/agent-instruction-no-pdp.sh`: `git diff --name-only "$BASE" -- src/core/grant-resolver.ts` пусто; `! grep -q "agent_instruction\|agent-instruction" src/core/grant-resolver.ts src/core/grant-lattice.ts`. |
| FF-COMP-6 | Дормантность рантайма (AC-11): ни один рантайм-модуль ответа вне Stage-2-парковки не читает `agent_instruction`; чтение допустимо только в authoring-DAO/changelog/audit/тестах. | `ci/checks/agent-instruction-runtime-dormant.sh`: `grep -rl "agent_instruction" src/core/engine src/worker` — любой хит FAIL; в `src/http` хит допустим ТОЛЬКО в authoring-маршрутах и `artifacts.ts` CONFIG_TABLES (allowlist), запрещён в response-формирующих хендлерах. |
| FF-COMP-7 | Published-lock fail-closed (AC-5): writer (`saveDraft`) вызывает `assertWritable` из `env-tier.ts` перед правкой и не обходит триггер (`SET LOCAL choros.promoting` не выставляется нигде в T-0123-коде — это привилегия promote-сервиса). | `ci/checks/agent-instruction-published-locked.sh`: `grep -q "assertWritable" src/db/agent-instruction-store.ts`; `! grep -q "choros.promoting" src/db/agent-instruction-store.ts`. |
| FF-COMP-8 | Семантический changelog (AC-7): наружу — `SemanticChange[]` из `diffInstruction`, не raw text-diff; человеко-facing слой не сериализует `instruction_text` целиком в changelog. | `ci/checks/agent-instruction-semantic-changelog.sh`: существует `diffInstruction`; changelog-builder не эмитит полный `instruction_text` (эвристика: changelog несёт флаг изменения, не тело). |

---

## 5. Traceability (AC → чем покрыт)

| AC | covered_by |
|---|---|
| AC-1 | object_model `agent_instruction` (`instruction_text` + `answer_form` + `instruction_meta`) — §2 |
| AC-2 | FF-COMP-2 + §1 «Изоляция» |
| AC-3 | FF-COMP-1 + §3 «Импортёры/совместимость» (frozen seams как BUILD-фиксы) |
| AC-4 | FF-COMP-3 (tier = контракт T-0087/049) + `bundle_id` forward-compat без FK §1/§2 |
| AC-5 | FF-COMP-7 (`assertWritable` + DB-триггер `tier_published_locked`; promote не обходится) |
| AC-6 | §1/§3 promote через существующий `POST /api/artifacts/:id/promote` → `decidePromote` human-gate (deploy≠active) |
| AC-7 | FF-COMP-8 + `diffInstruction` §3 |
| AC-8 | FF-COMP-5 (grant-resolver frozen, не читает инструкцию) |
| AC-9 | §1/§2 аудит: promote → существующий `artifact.promoted`; draft/clear → `agent.instruction.draft_saved`/`cleared` через AuditWriter |
| AC-10 | §2 «Нет инструкции = отсутствие строки»; миграция без сидов, без потери данных |
| AC-11 | FF-COMP-6 (runtime-dormant grep-guard) |
| AC-12 | §1 авторинг через tier-draft-поверхность + config-агент draft-only; **точная роль/путь — Q-1, §7** |
| AC-13 | §6 «Что НЕ делает» с владельцами |
| AC-14 | §2 аудит-тип `agent.instruction.cleared` + §3 `clear` через RED-LINES human-confirm |

---

## 6. Что НЕ делает (явные не-цели, AC-13)

- **Рантайм-исполнение инструкции** (LLM-вызов с инструкцией как system-prompt) —
  Stage-2 E5.6–E5.10 (запаркован за решением фаундера №6 о разморозке).
- **Headless/программная поверхность** (внешний запрос → ответ агента) — **T-0126**
  (design-only до разморозки Stage-2).
- **Сам механизм когерентной связки `bundle` / FK `bundle_id`** — **T-0082** (E12.1);
  T-0123 кладёт forward-compat-указатель, не реестр.
- **Сам tier-механизм (draft→published, триггер, promote-сервис)** — **T-0087**
  (E12.6, приземлён); T-0123 его ПЕРЕИСПОЛЬЗУЕТ, не строит.
- **Системный config-агент** (роль/MCP-tools авторинга) — **T-0077**; T-0123 лишь
  добавляет инструкцию в перечень draft-only артефактов, что он авторит.
- **Грант-модель / PDP / роли** — **T-0018/T-0021/T-0022**; не трогаются.
- **BYO-LLM endpoint/model/secret/бюджет/порог автономии** — **T-0020/T-0023/T-0025**.
- **Каталог шаблонных инструкций как ассортимент** — **T-0133** (механизм каталога)
  + путь появления агента (Q-1); здесь не материализуется.
- **A/B инструкций на сценариях** — петля внедрения / симуляция **T-0130**.

---

## 7. Escalation (Q-1 — продуктовый выбор фаундера)

**Status = `needs_founder`.** Все инженерные оси (хранение, версионирование через
T-0087, promote, аудит, изоляция, дормантность, не-расширение прав) решены в рамках
ратифицированных решений и от ответа Q-1 НЕ зависят — coder может строить миграцию
057, таблицу, DAO, регистрацию в `CONFIG_TABLES`, аудит draft-типов и fitness-чеки
немедленно.

Открыт ровно один продуктовый вопрос (gap-map §3#4, не зафиксирован фаундером для
инструкции):

> **Q-1.** Дефолтный путь появления и правки инструкции у клиента и **роль/право**
> на правку: (а) self-service промт клиент-админом; (б) config-агент (T-0077)
> предлагает в draft, человек promote; (в) каталог вендорских инструкций (T-0133)
> + донастройка. Аудит рекомендовал **(в)+(б)**; чистый (а) аудит назвал «почти
> гарантированно даёт плохих агентов и подрывает доверие на первом клиенте».
> Плюс: отдельное право «авторинг компетенции» или существующее mgmt-право
> (например, переиспользовать authority-гейт promote-endpoint-а T-0087
> `mgmt_object:tier_promote`)?

**Почему именно это эскалируется, а не угадывается:** ответ меняет объём
авторинг-поверхности (FR-3) и приёмку AC-12 — (а) требует полного draft-UI
свободного текста клиентом, (б)/(в) сдвигают первичный авторинг на
config-агента/каталог, а клиент-админ получает только review+promote. Это разные
DESIGN-объёмы фронтенда и разный набор прав; «попробуем self-service» прямо
противоречит выводу аудита (red-lines «правило при сомнении»). Лицензионное
решение фаундера 2026-06-13 (T-0127) касалось Genesis/entitlement и Q-1 по
инструкции НЕ закрыло.

**Что разблокирует ответ:** выбор a/b/в → объём авторинг-UI и роль/право →
финализация AC-12 и (при варианте с отдельным правом) одна additive-строка
seed-роли/гранта. Архитектура хранения и версионирования от этого не меняется.

`runtime_target`: home-server silo (`/srv/choros`, tenancy silo-only); слой
day-1 dormant, рантайм-потребитель — Stage-2.

`adr_artifact_path`: `docs/design/T-0123-agent-competency-layer.adr.md`.

---

## 8. Decomposition hint (impl child-tasks, ориентир для backlog)

DESIGN-only; impl приземляется детьми (точный split — за CP/founder):

1. **T-0123a · миграция + изоляция.** `migrations/057_agent_instruction.sql` (DDL
   §2, tier-колонка по 049, триггер `tier_published_locked`, FORCE RLS, `bundle_id`
   без FK, без сидов) + строка в `known_tenant_tables.txt`. Покрывает
   FF-COMP-1/2/3. Зависит от: ничего (T-0087/049 уже на dev).
2. **T-0123b · тип + DAO + аудит.** `src/core/agent-instruction.ts` (тип,
   переиспользует `Tier`), `src/db/agent-instruction-store.ts` (`saveDraft` с
   `assertWritable`, `readDraft`/`readPublished`, `clear`; аудит `draft_saved`/
   `cleared` в той же tx). Покрывает FF-COMP-7. Зависит от: T-0123a.
3. **T-0123c · регистрация promote + changelog.** Добавить `"agent_instruction"` в
   `CONFIG_TABLES` (`src/http/artifacts.ts`); `diffInstruction` +
   semantic-changelog builder. Покрывает FF-COMP-4/8. Зависит от: T-0123a/b.
4. **T-0123d · fitness-чеки.** Все `ci/checks/agent-instruction-*.sh` (§4) +
   проводка в gate. Покрывает FF-COMP-5/6 и валидирует 1–3. Зависит от: T-0123a–c.
5. **T-0123e · авторинг-UI/право (БЛОКИРОВАН Q-1).** Объём зависит от ответа
   фаундера: (а) полный draft-UI; (б)/(в) review+promote-поверхность; плюс
   роль/право. НЕ стартует до решения Q-1.

Дети 1–4 разблокированы немедленно; ребёнок 5 ждёт Q-1.
