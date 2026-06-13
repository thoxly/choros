# ADR · T-0123 — Компетентностный слой агента (инструкция при `agent_card`)

**Task:** T-0123 · **Phase:** DESIGN (architect) · **Status:** `needs_founder`
**Date:** 2026-06-13
**spec_ref:** `docs/specs/T-0123-agent-competence.spec.md`
**Authoritative inputs (НЕ переоткрываются):**
`playbooks/choros-product-gap-map.md` §2/§3#4/§4б · `playbooks/choros-reference-process-tel.md` §5 ·
`CONCEPT.md` §3 · `docs/design/extensibility-and-authoring.md` §1/§4/§7/§8/§9 ·
`docs/design/T-0020-agent-card.adr.md` §1.5/§1.6/§4.3 · `docs/design/T-0013-tenant-isolation.adr.md` ·
`docs/design/T-0021-grant-resolver-pdp.adr.md` · `migrations/032_agent_card.sql` (T-0020) ·
`migrations/044_config_agent_seed.sql` (T-0077 `authoring_draft`/`authoring_published` seam) ·
`src/db/agent-provision.ts` (T-0042) · `src/db/audit-writer.ts` (T-0016/T-0019 floor).

---

## 0. Контекст и связывающее ограничение

Спека T-0123 фиксирует ЧТО (FR/NF/AC) и оставляет architect-у форму хранения,
объектную модель и связь с единицей версионирования. Реальная сверка кодовой
базы дала два несущих факта, которые формируют это решение:

1. **Сема T-0123 в `agent_card` уже зарезервирована.** `migrations/032_agent_card.sql`
   (комментарий «EXTENSIBILITY (product-audit 2026-06-11 seam): NO prompt/instruction
   column here — the competence layer (T-0123) adds it via additive migration») и
   `T-0020-agent-card.adr.md` §1.5/§4.3 явно держат таблицу узкой, чтобы T-0123
   приходил аддитивной миграцией, не трогая 032-DDL и не ломая T-0042 write-path.

2. **Таблицы единицы версионирования (E12.1/T-0082) ещё НЕТ в БД.** Поиск по
   `migrations/` не нашёл `bundle`/`config_version`/`draft`/`published` таблицы
   (последняя миграция — 044). Зато **есть ратифицированный draft/promote-примитив
   на уровне PDP**: `migrations/044_config_agent_seed.sql` вводит `resource_type =
   'authoring_draft'` / `'authoring_published'` и MCP-tool `request_promote`
   (`draft → published, human-gated`). Это и есть «один механизм версионирования»,
   который T-0123 ПЕРЕИСПОЛЬЗУЕТ. Сам реестр когерентной связки (`bundle`) —
   downstream-объект T-0082; T-0123 ссылается на него **forward-compat-указателем
   без живого FK** (идиома 032: `budget_policy_id`/`escalation_rule_id` uuid NULL,
   FK добавляется владельцем-задачей позже).

Из (2) следует ключевой архитектурный выбор: инструкция — **не один столбец на
`agent_card`** (столбец не может одновременно нести DRAFT- и PUBLISHED-редакцию,
а двухтировая модель extensibility §8 требует сосуществования тиров), а
**отдельная additive-таблица `agent_instruction`**, ключ которой несёт `tier`.
Это аддитивно к `agent_card` (032-DDL не трогается, `agent_card` остаётся узкой —
§1.5/§4.3 соблюдены), и одновременно даёт двухтировую модель из extensibility §8.

---

## 1. Decision (что решаем)

Ввести компетентностный слой агента как **отдельную тенант-изолированную таблицу
`choros.agent_instruction`** (additive-миграция, слот `045`), привязанную к
`employee(kind='agent')` тем же composite-FK-идиомом, что и `agent_card` (FK в
`employee(tenant_id, id, kind)`), со следующими осями:

- **Хранение тира в ключе.** PK `(tenant_id, employee_id, tier)`, где
  `tier ∈ {'authoring_draft','authoring_published'}` — РОВНО те же два значения,
  что уже несёт PDP-seam миграции 044. Не новый enum: тир инструкции = тот же
  resource-type, под которым PDP авторизует правку (NF-1, AC-4).
- **Содержание (AC-1).** `instruction_text` (основной текст компетенции) +
  `answer_form` (параметр формы ответа банк-кейса, напр. `'sum'` /
  `'sum_with_breakdown'`) + `instruction_meta jsonb` (расширяемый конверт для
  будущих параметров формы, чтобы не плодить миграции на каждый банк-кейс).
- **Версионирование как конфиг (AC-4/AC-5/AC-6).** Правка пишет/обновляет ТОЛЬКО
  строку `tier='authoring_draft'`. Строка `tier='authoring_published'` —
  managed/locked: прямой UPDATE/INSERT в неё из авторинг-пути запрещён (write-path
  гард + PDP `authoring_published` zero-grant из 044). Переход draft→published —
  ТОЛЬКО через существующий `request_promote` human-gate (deploy ≠ active): promote
  атомарно копирует draft-строку в published-строку под актором-человеком. Своего
  versioning/promote-механизма T-0123 НЕ вводит.
- **Forward-compat-связь с единицей версионирования (AC-4).** Колонка `bundle_id
  uuid NULL` **без FK** — указатель на когерентную связку E12.1/T-0082. Пока
  T-0082 не приземлил реестр `bundle`, `bundle_id` дормантен (NULL); T-0082
  добавляет FK аддитивно (идиома 032 `budget_policy_id`). Так промоушн инструкции
  становится частью одного промоушна связки, как только связка существует, не
  создавая второй поток сейчас.
- **Семантический changelog (AC-7).** Наружу клиент видит семантическую строку
  (`answer_form: sum → sum_with_breakdown`, `instruction_text: изменён`), не
  raw-diff и не «bundle vN→vN+1». Источник changelog — сравнение draft-строки с
  published-строкой по полям (детерминированный диффер полей, не текст-diff).
- **Аудит (AC-9).** Каждое событие (`draft_saved`, `promoted`, `cleared`) пишется
  через существующий `AuditWriter.appendAuditEvent` (T-0016/T-0019 floor),
  дотированными типами `agent.instruction.*`; `promoted` несёт актора-человека
  (`actor.type='human'`), `draft_saved` может нести config-агента
  (`actor.type='agent'`).
- **Дормантность рантайма (AC-11).** Day-1 ни один рантайм-путь (HTTP-хендлеры,
  PDP, движок, external-task worker) не читает `agent_instruction` для
  формирования ответа агента. Реальное «агент отвечает по инструкции» — Stage-2
  (E5.6–E5.10). Слой хранится/версионируется/правится/аудируется, как
  `autonomy_threshold` в 032 дормантен.
- **Изоляция (AC-2).** `agent_instruction` — T-0013-таблица: `tenant_id` ведущий
  в PK, `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy на
  `current_setting('choros.tenant_id', true)::uuid`, `GRANT … TO choros_app`,
  внесена в `ci/checks/known_tenant_tables.txt`.
- **Права не расширяются (AC-8).** `agent_instruction` НЕ участвует в PDP-решении.
  Содержание инструкции не читается grant-resolver-ом; ссылка инструкции на
  инструмент/данные вне грантов агента не даёт доступа (fail-closed остаётся в
  T-0021). Правка инструкции не трогает таблицу `grant`.

**Право/путь авторинга инструкции у клиента (Q-1) НЕ решается этим ADR** — это
продуктовый выбор фаундера (см. §7 Escalation). Всё остальное (хранение,
двухтировость, promote-механика, аудит, изоляция, дормантность) спроектировано в
рамках ратифицированных решений и не зависит от ответа на Q-1.

---

## 2. Object model

### Таблица `choros.agent_instruction` (новая, миграция 045, additive)

| Колонка | Тип | Назначение |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | T-0013 ведущий ключ; RLS-якорь |
| `employee_id` | `uuid NOT NULL` | агент-владелец инструкции |
| `employee_kind` | `text NOT NULL DEFAULT 'agent'` | FK-дискриминатор; `CHECK (employee_kind='agent')` (идиома 032) |
| `tier` | `text NOT NULL` | `CHECK (tier IN ('authoring_draft','authoring_published'))` — тот же набор, что PDP-seam 044 |
| `instruction_text` | `text NOT NULL` | основной текст компетенции (AC-1) |
| `answer_form` | `text NULL` | параметр формы ответа банк-кейса (`'sum'`/`'sum_with_breakdown'`/…); NULL = форма не задана |
| `instruction_meta` | `jsonb NOT NULL DEFAULT '{}'` | расширяемый конверт доп-параметров формы (без миграции на каждый кейс) |
| `bundle_id` | `uuid NULL` | forward-compat указатель на связку E12.1/T-0082; **NO FK** day-1 (дормантен) |
| `created_at` | `bigint NOT NULL` | |
| `updated_at` | `bigint NOT NULL` | |

**Ключи / гарды:**
- `PRIMARY KEY (tenant_id, employee_id, tier)` — draft и published сосуществуют по одному агенту.
- `FOREIGN KEY (tenant_id, employee_id, employee_kind) REFERENCES choros.employee(tenant_id, id, kind)` — переиспользует UNIQUE из 032; указывает только на `kind='agent'`.
- `CHECK (tier IN ('authoring_draft','authoring_published'))`.
- `CHECK (employee_kind = 'agent')`.
- RLS: `ENABLE`+`FORCE`, policy `tenant_id = current_setting('choros.tenant_id', true)::uuid`, `WITH CHECK` симметрично.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_instruction TO choros_app`.

«Нет инструкции» (AC-10) = отсутствие строк для агента — валидное дормантное
состояние. Миграция 045 НЕ сидит инструкции для 5 dev-агентов (они остаются без
инструкции); ни одна существующая строка `agent_card`/`employee` не меняется.

### Новые аудит-типы (дотированный namespace, T-0016 vocab открыт)

| `type` | Когда | `actor.type` |
|---|---|---|
| `agent.instruction.draft_saved` | create/edit draft-строки | `human` или `agent` (config-агент) |
| `agent.instruction.promoted` | draft→published через `request_promote` | `human` (human-gate, AC-9) |
| `agent.instruction.cleared` | удаление/очистка инструкции (RED-LINES, AC-14) | `human` (default-DENY на необратимость) |

`payload` событий несёт семантический changelog (изменённые поля), не raw-text.

---

## 3. Contracts (единый контракт полей/типов для coder и tester)

1. **Миграция** `migrations/045_agent_instruction.sql` — DDL таблицы §2; FORCE
   RLS; `bundle_id` без FK (комментарий-сема для T-0082); без сид-инструкций; все
   возможные `INSERT` сидов (если появятся) — `ON CONFLICT DO NOTHING`.
2. **Тип TS** `AgentInstruction` (новый, напр. `src/core/agent-instruction.ts`):
   `{ tenantId: string; employeeId: string; employeeKind: 'agent'; tier:
   'authoring_draft' | 'authoring_published'; instructionText: string;
   answerForm: string | null; instructionMeta: Record<string, unknown>;
   bundleId: string | null; createdAt: number; updatedAt: number }`.
3. **DAO** (новый, напр. `src/db/agent-instruction-store.ts`), всё под открытой
   `withTenantTx` (паттерн `agent-provision.ts`, `tenant_id` ведущий):
   - `saveDraft(tx, instr)` — UPSERT строки `tier='authoring_draft'` ТОЛЬКО;
     попытка writer-а тронуть `tier='authoring_published'` → typed error
     `published_tier_immutable` (AC-5).
   - `promote(tx, {tenantId, employeeId, actor})` — копирует draft→published
     атомарно; вызывается ТОЛЬКО из `request_promote`-пути (human-gated, AC-6).
   - `readPublished(tx, …)` / `readDraft(tx, …)` — read-only.
   - `clear(tx, …)` — удаление; путь идёт через RED-LINES human-confirm (AC-14).
   Каждый мутирующий метод вызывает `AuditWriter.appendAuditEvent` в той же `tx`
   (атомарность audit+DB, паттерн T-0042 §FR-2).
4. **Changelog-функция** `diffInstruction(published, draft): SemanticChange[]` —
   детерминированный пофолевой диффер (`answer_form`, `instruction_text` (только
   признак «изменён», не текст), `instruction_meta`); НЕ raw code-diff (AC-7,
   симметрично extensibility §9 «независимый детерминированный валидатор
   changelog ↔ diff»).
5. **PDP-инвариант (контракт для tester, нет нового кода в PDP).** Авторинг
   инструкции авторизуется существующим `resource_type='authoring_draft'`
   (миграция 044). `agent_instruction` НЕ читается grant-resolver-ом
   (`src/core/grant-resolver.ts`) — этот файл остаётся frozen (§4 FF-3).

**Импортёры/совместимость (рефактор public-поверхности):** T-0123 НЕ меняет
public-сигнатуры. `insertAgentRows` (`src/db/agent-provision.ts`) НЕ расширяется —
инструкция NULL-at-hire (строк `agent_instruction` при найме не создаётся), так
что T-0042 write-path и его frozen-checks (`agent-hire-frozen-additive.sh`,
`agent-hire-migration-seam.sh`) не затрагиваются. `agent_card`-DDL (032) не
трогается; его потребители стабильны.

---

## 4. Fitness functions (исполнимые CI-правила)

Каждое нарушаемое кодом архитектурное решение — отдельный shell-чек в
`ci/checks/` (идиома `agent-hire-*.sh`).

| id | rule | ci_check |
|---|---|---|
| FF-COMP-1 | Additive к T-0020: миграция 045 не трогает `032_agent_card.sql` и не добавляет колонок в `agent_card`/`employee`; новая таблица — отдельная. | `ci/checks/agent-instruction-additive.sh`: `git diff --name-only "$BASE" -- migrations/032_agent_card.sql` пусто; `grep -L "ALTER TABLE choros.agent_card" migrations/045_agent_instruction.sql`; `grep -q "CREATE TABLE choros.agent_instruction" migrations/045_agent_instruction.sql`. |
| FF-COMP-2 | T-0013 изоляция: `agent_instruction` несёт `tenant_id` ведущим в PK, `FORCE ROW LEVEL SECURITY`, tenant-policy, и внесена в `known_tenant_tables.txt`. | `ci/checks/agent-instruction-rls.sh`: `grep -q "FORCE ROW LEVEL SECURITY"` и `grep -q "current_setting('choros.tenant_id'"` в 045; `grep -q "^agent_instruction$" ci/checks/known_tenant_tables.txt`; PK начинается с `tenant_id`. |
| FF-COMP-3 | Один тир-набор (NF-1): `tier`-CHECK содержит РОВНО `authoring_draft`/`authoring_published` (значения PDP-seam 044), без нового версионного enum. | `ci/checks/agent-instruction-tier-reuse.sh`: `grep -qE "tier IN \('authoring_draft', ?'authoring_published'\)"` в 045; отсутствие иных тир-значений; перекрёстная сверка, что эти строки есть в `migrations/044_config_agent_seed.sql`. |
| FF-COMP-4 | Published managed/locked (AC-5): writer не UPSERT-ит `tier='authoring_published'` напрямую — только `promote` пишет published. | `ci/checks/agent-instruction-published-locked.sh`: в `src/db/agent-instruction-store.ts` метод `saveDraft` не содержит литерала `'authoring_published'`; единственный writer published — `promote`; присутствует typed error `published_tier_immutable`. |
| FF-COMP-5 | Права не расширяются (AC-8): `src/core/grant-resolver.ts` не импортирует/не читает `agent_instruction`; файл frozen (0 diff к base). | `ci/checks/agent-instruction-no-pdp.sh`: `git diff --name-only "$BASE" -- src/core/grant-resolver.ts` пусто; `grep -rL "agent_instruction\|agent-instruction" src/core/grant-resolver.ts src/core/grant-lattice.ts`. |
| FF-COMP-6 | Дормантность рантайма (AC-11): ни один рантайм-модуль вне Stage-2-парковки не читает `agent_instruction` для ответа; чтение допустимо только в authoring-DAO/audit/тестах. | `ci/checks/agent-instruction-runtime-dormant.sh`: `grep -rl "agent_instruction" src/http src/core/engine src/worker` (любой такой хит — FAIL); allowlist = `src/db/agent-instruction-store.ts`, тесты. |
| FF-COMP-7 | Promote — human-gated audit-событие (AC-9): тип `agent.instruction.promoted` пишется с `actor.type='human'`; промоушн идёт через `request_promote`-путь. | `ci/checks/agent-instruction-promote-human.sh`: в store-коде `promote` вызывает `appendAuditEvent` с type `agent.instruction.promoted`; нет пути, пишущего этот тип с `actor.type='agent'`. |
| FF-COMP-8 | Семантический changelog (AC-7): наружу — `SemanticChange[]` из `diffInstruction`, не raw text-diff; человеко-facing слой не сериализует `instruction_text` целиком в changelog. | `ci/checks/agent-instruction-semantic-changelog.sh`: существует `diffInstruction`; changelog-builder не эмитит полный `instruction_text` (эвристика: changelog несёт флаг изменения, не тело). |

Базовая линия (`$BASE`) и стиль PASS/FAIL — как в `agent-hire-frozen-additive.sh`
(merge-base с `dev`, `set -euo pipefail`).

---

## 5. Traceability (AC → чем покрыт)

| AC | covered_by |
|---|---|
| AC-1 | object_model `agent_instruction` (`instruction_text` + `answer_form` + `instruction_meta`) — §2 |
| AC-2 | FF-COMP-2 + §1 «Изоляция» |
| AC-3 | FF-COMP-1 + §3 «Импортёры/совместимость» (frozen seams как BUILD-фиксы) |
| AC-4 | FF-COMP-3 (тир = PDP-seam 044) + `bundle_id` forward-compat без FK §1/§2 |
| AC-5 | FF-COMP-4 (`saveDraft` не пишет published; `published_tier_immutable`) |
| AC-6 | §1/§3 `promote` через `request_promote` human-gate (deploy≠active) |
| AC-7 | FF-COMP-8 + `diffInstruction` §3 |
| AC-8 | FF-COMP-5 (grant-resolver frozen, не читает инструкцию) |
| AC-9 | FF-COMP-7 + аудит-типы §2 (`draft_saved`/`promoted`/`cleared`) |
| AC-10 | §2 «Нет инструкции = отсутствие строк»; миграция без сидов, без потери данных |
| AC-11 | FF-COMP-6 (runtime-dormant grep-guard) |
| AC-12 | §1 авторинг через `authoring_draft`-seam + config-агент draft-only (444); **точная роль/путь — Q-1, §7** |
| AC-13 | §6 «Что НЕ делает» с владельцами |
| AC-14 | §2 аудит-тип `agent.instruction.cleared` + §3 `clear` через RED-LINES human-confirm |

---

## 6. Что НЕ делает (явные не-цели, AC-13)

- **Рантайм-исполнение инструкции** (LLM-вызов с инструкцией как system-prompt) —
  Stage-2 E5.6–E5.10 (запаркован).
- **Headless/программная поверхность** (внешний запрос → ответ агента) — **T-0126**.
- **Сам механизм когерентной связки `bundle` / FK `bundle_id`** — **T-0082** (E12.1);
  T-0123 кладёт forward-compat-указатель, не реестр.
- **Реализация draft→published тиров как сред** — **T-0087** (E12.6); T-0123
  переиспользует PDP-seam `authoring_draft/published` (044), не строит среды.
- **Системный config-агент** (роль/MCP-tools авторинга) — **T-0077**; T-0123 лишь
  добавляет инструкцию в перечень draft-only артефактов, что он авторит.
- **Грант-модель / PDP / роли** — **T-0018/T-0021/T-0022**; не трогаются.
- **BYO-LLM endpoint/model/secret/бюджет/порог автономии** — **T-0020/T-0023/T-0025**.
- **Каталог шаблонных инструкций как ассортимент** — **T-0133** (механизм каталога)
  + путь появления агента (Q-1); здесь не материализуется.

---

## 7. Escalation (Q-1 — продуктовый выбор фаундера)

**Status = `needs_founder`.** Все инженерные оси (хранение, двухтировость,
promote-механика, аудит, изоляция, дормантность, не-расширение прав) решены в
рамках ратифицированных решений и от ответа Q-1 НЕ зависят — coder может строить
миграцию 045, таблицу, DAO, аудит-типы и fitness-чеки немедленно.

Открыт ровно один продуктовый вопрос (gap-map §3#4, не зафиксирован фаундером для
инструкции):

> **Q-1.** Дефолтный путь появления и правки инструкции у клиента и **роль/право**
> на правку: (а) self-service промт клиент-админом; (б) config-агент (T-0077)
> предлагает в draft, человек promote; (в) каталог вендорских инструкций (T-0133)
> + донастройка. Аудит рекомендовал **(в)+(б)**; чистый (а) аудит назвал «почти
> гарантированно даёт плохих агентов и подрывает доверие на первом клиенте».
> Плюс: отдельное право «авторинг компетенции» или существующее mgmt-право?

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
seed-роли/гранта в духе 044. Архитектура хранения от этого не меняется.

`runtime_target`: home-server silo (`/srv/choros`, tenancy silo-only); слой
day-1 dormant, рантайм-потребитель — Stage-2.

`adr_artifact_path`: `docs/design/T-0123-agent-competence.adr.md`.
