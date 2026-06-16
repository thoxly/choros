# ADR T-0219 · DEMO-2 intake-agent — навык-классификатор в слот S2 ТЭЛ

> Статус: ready-for-review · Тип: impl
> spec_ref: `playbooks/v1-demo-and-trust-surface.md#A`
> Контракт-родитель (НЕ переопределять): `docs/design/T-0218-demo-1-scenario.adr.md#41` (`INTAKE_SLOT`)
> depends_on: T-0123 (competency layer) · T-0077 (seed pattern) · T-0218 (DEMO-1 слоты)
> Параллельно: T-0234 (слот S3 legal-precheck) — правки `tel-scenario.ts` держим в S2/intake-части.

---

## 1. Контекст и напряжение

T-0218 разметил слот **S2 «Триаж»** (`INTAKE_SLOT`) в линейном ТЭЛ: вход = поля
поданной заявки (`subject` / `amount` / `justification` / `requester`), выход =
`category` / `budget_article` / `direction` / `route` + reasoning-trace. Ревью
T-0218 пометило, что **форма `route` оставлена прозой** («список обязательных
согласующих»). Эта задача (а) **строит навык в слот** — agent_card + роль +
инструкция-классификатор как seed (draft-first по T-0123/T-0230), (б) **закрывает
review-флаг**, определив **конкретную типизированную форму `route`**, которая
кормит S3 `dealContext`.

Три ограничения формируют решение:
1. **Ноль платных LLM** (run = openai $0). Живой инференс intake-агента =
   deploy-time. Здесь навык демонстрируется **детерминированно** (чистая функция),
   а agent_card — **dormant** (llm_* NULL).
2. **Слой компетентности T-0123** требует инструкцию агента как
   `agent_instruction` (instruction_text + answer_form + meta), **draft-first**
   (tier='draft'; promote draft→published = отдельный человеко-гейт).
3. **dormant-гейт** `agent-instruction-runtime-dormant.sh` запрещает новым
   runtime-путям читать `agent_instruction`. Поэтому классификатор-демонстратор
   **pure-compute** и НЕ читает таблицу инструкций (инструкция = seed-данные).

---

## 2. Решение по типу `route` (закрытие review-флага «route = проза»)

`route` получает типизированную форму `IntakeRoute` (`src/runtime/intake/intake-types.ts`):

```ts
export type IntakeApproverRole = "fin_controller" | "legal" | "cfo";
export interface IntakeApprover {
  order: number;              // позиция в цепочке (1..N)
  role: IntakeApproverRole;   // обязательный согласующий
  reason: string;             // почему обязателен (несётся в trace)
  mandatory: true;            // демо-маршрут = только обязательные согласующие
}
export interface IntakeRoute {
  steps: readonly IntakeApprover[];      // упорядоченная цепочка S4-согласований
  legal_required: boolean;               // amount ≥ 5M₽ → S3 legal-precheck firing
  approver_chain: readonly string[];     // плоский упорядоченный список role-кодов (UI/audit)
}
```

### 2.1 Правило вывода (детерминированное, порог ТЭЛ §1.4)
- **Всегда**: `fin_controller` (order 1) — любой расход проходит финконтроль.
- **При `amount ≥ TEL_LEGAL_THRESHOLD_RUB` (5M₽)**: добавляются `legal` (order 2)
  и `cfo` (order 3) — «деньги → кто обязан согласовать» (ТЭЛ §1.4: ≥5млн →
  обязательный юротдел; крупная сумма → финдиректор).
- **Иначе**: только `fin_controller` (legal не обязателен).

### 2.2 Несущая связь S2 → S3 (review требовал: «выровнять с ≥5M legal-trigger»)
- `route.legal_required === (amount ≥ TEL_LEGAL_THRESHOLD_RUB)` — **по построению
  равно** `legalGateFires(amount)` из `tel-scenario.ts` и условию срабатывания
  слота legal-precheck (T-0234). Это поле — несущая связь «одного потока».
- Выход S2 формирует **S3 `dealContext`**: `{ amount, kind: category, direction }`
  (точная сигнатура `runLegalPrecheck`, T-0233). `route.legal_required` решает,
  firing ли гейт; `amount/kind/direction` производны от классификации S2.
- T-0234 читает **только** `IntakeRoute.legal_required` + (amount/kind/direction)
  — никакой связи через прозу. Контракт типизирован → мержи аддитивны.

---

## 3. Как заведён intake-agent (agent_card + роль + инструкция, draft-first)

Навык поставляется как **additive demo-seed в actor-плоскости** (T-0218 §6.2),
расширяя уже существующий demo actor-seed `tel-scenario.ts`. НЕ display-плоскость
(FF-PACK-2 8/8 не трогаем). Применяется через **importer / публичный API**, НЕ
прямой PG (правки локализованы в S2/intake-части `tel-scenario.ts`).

| артефакт | форма | плоскость |
|---|---|---|
| **роль** `role-intake-agent` | уже есть в `DEMO_ROLE_INTAKE` (T-0218). Гранты `read`(заявка)+`update`(классификация). **НЕТ approve/exec/invoke** (moat). | actor-seed (existing) |
| **сотрудник** `a-intake` (kind=agent) | уже есть в `DEMO_EMPLOYEE_INTAKE` (T-0218). | actor-seed (existing) |
| **agent_card** `DEMO_AGENT_CARD_INTAKE` (НОВОЕ) | форма migration-032: `kc_client_id='agent-intake'`, `llm_endpoint/llm_model/llm_secret_handle = null` (**dormant** — ноль платных LLM), `autonomy_threshold=null`. | actor-seed (new) |
| **инструкция** `DEMO_INTAKE_INSTRUCTION` (НОВОЕ) | T-0123 `AgentInstructionDraft`: `instruction_text` (правила классификации/маршрута), `answer_form='intake_triage_v1'`, `instruction_meta` (категория→статья справочник), `tier='draft'` (draft-first; promote = отдельный гейт). | actor-seed (new) |

**Почему draft-first:** T-0123 `saveDraft` всегда пишет tier='draft'; promote
draft→published — привилегия `promoteTier` (человеко-гейт). Day-1 beachhead-агент
заводится черновиком — публикация = осознанное действие админа, не побочный
эффект seed (NF-2 T-0123). Поэтому seed несёт **только draft**.

**Почему agent_card dormant:** без `llm_endpoint/model/secret_handle` живой
мотор не делает сетевой вызов (T-0233 FR-7). Это гарантирует **ноль платных LLM**
в CI. Реальный live-провод (ключ/среда) = deploy-time T-0234/founder, НЕ блокер.

---

## 4. Детерминированный классификатор (демонстратор навыка)

`src/runtime/intake/classify-intake.ts` :: `classifyIntake(input): IntakeClassification`
— **чистая функция** (ноль pg / сети / LLM / чтения agent_instruction). Это
демо-демонстратор навыка: показывает, ЧТО агент производит, детерминированно
(demo-deal → стабильный выход), без платного инференса.

```ts
export interface IntakeInput {
  subject: string; amount: number; justification: string; requester: string;
}
export interface IntakeReasoningStep { claim: string; basis: string; }
export interface IntakeClassification {
  answer: {                                   // safe external answer (answer_form=intake_triage_v1)
    category: string; budget_article: string; direction: "buy" | "sell"; route: IntakeRoute;
  };
  reasoning_trace: readonly IntakeReasoningStep[];  // структурированный «почему» (in-process)
  answer_form: "intake_triage_v1";
}
```

- **Классификация** (детерминированная эвристика, demo-grade): по ключевым словам
  `subject`/`justification` → `category` (`it_expense` / `aho` / `marketing`);
  `category` → `budget_article` (справочник в `instruction_meta`: it→BUD-14);
  направление по умолчанию `buy`.
- **route** = `buildIntakeRoute(amount, category)` по §2.1.
- **reasoning_trace** = упорядоченные шаги `{ claim, basis }`: «category=it_expense
  (basis: ключевое слово 'лицензии ПО')», «budget_article=BUD-14 (basis:
  справочник it_expense→BUD-14)», «route += legal,cfo (basis: amount 5.5M ≥ порог
  5M₽)». **D-139**: trace — это in-process structured «почему», safe-уровень
  (claim+basis, без chain-of-thought-verbatim); поверхность answer её НЕ содержит
  как сырой reasoning — она параллельна answer и предназначена audit/UI-показу.

### 4.1 reasoning-surface на S2 (D-139, ноль egress)
- **Наружу answer** (`answer.*`) — безопасная классификация + типизированный route.
- **reasoning_trace** — структурированные пары claim/basis, показываются на шаге S2
  как «почему агент решил X» (audited in-process trace). Это **не** сетевой вывод
  reasoning наружу — никакого нового egress-канала (D-139 соблюдён: trace остаётся
  внутри границы, не уходит во внешний API).

---

## 5. Fitness-функции

| id | проверка | плоскость |
|---|---|---|
| **FF-INTAKE-1** (новая, static, self-test) | (1) SPEC+ADR+impl+pr-handoff присутствуют; (2) `route` типизирован (`IntakeRoute` с `legal_required`/`steps`/`approver_chain`); (3) роль `role-intake-agent` НЕ имеет approve/exec/invoke-гранта (moat) в seed; (4) agent_card intake dormant (llm_* null); (5) инструкция tier='draft' + answer_form='intake_triage_v1'. | static (в `fitness`) |
| FF-PACK-2 (существующая, не ломать) | GET /api/rights→8, GET /api/processes→8 — display не раздут. | static (server+sentinel DB) |
| fitness:seed (существующие) | pack-schema-valid, single-source, display-plane-no-write — после demo actor-seed добавок. | static |
| agent-instruction-runtime-dormant (существующая) | классификатор НЕ читает agent_instruction из рантайма (не в allowlist) → не нарушает narrow gate. | static |
| tsc/eslint/vitest | классификатор+seed типизированы; детерминизм classifyIntake; граничная проба route.legal_required. | static + unit |

FF-INTAKE-1 имеет `# SELF-TEST:` маркер и `--self-test` ветку (good+bad фикстуры).

---

## 6. Отклонённые альтернативы

| Альтернатива | Почему нет |
|---|---|
| Живой LLM-инференс intake-агента в этой задаче | Нарушает «ноль платных LLM» (run=$0); live-провод = deploy-time founder. agent_card dormant + детерминированный демонстратор закрывают демо. |
| Промоут инструкции draft→published в seed | Promote = человеко-гейт (T-0123); seed несёт черновик, публикация — осознанное действие, не побочный эффект. |
| `route` оставить прозой / `string[]` без типа | Ревью T-0218 явно пометило это; типизированный `IntakeRoute` нужен, чтобы T-0234 читал `legal_required` машинно (мерж-стабильность). |
| Классификатор читает agent_instruction из рантайма | Триггерит dormant-гейт (narrow allowlist = только legal-precheck). Демо-классификатор pure-compute; инструкция = seed-данные. |
| Новая таблица под классификацию | OOS — демо переиспользует actor-плоскость; навык = seed + pure-функция, без новой DDL (NF-1). |
| Грант approve роли intake | Ломает moat (FR-6). Роль только read+update. |
| Раздуть showcase pack новой rights-card/process_instance | Ломает FF-PACK-2 (8/8) → красный dev (T-0218 §6.1). |

---

## 7. Трассируемость

- T-0218 `INTAKE_SLOT` (consumes/produces/reasoning) → §2 (`route` тип) + §4 (классификатор).
- review-флаг «route = проза» → §2 (`IntakeRoute` типизирован) + §2.2 (кормит S3 dealContext).
- T-0123/T-0230 agent_instruction (instruction_text + answer_form, draft→promote) → §3 (инструкция draft-first).
- migration 032 agent_card (llm_* NULL = dormant) → §3 (agent_card dormant).
- T-0233 `runLegalPrecheck` dealContext {amount,kind,direction} → §2.2 (S2→S3 связь).
- reference-tel §1.4 (≥5млн→юротдел) → §2.1 (route правило).
- D-139 (no reasoning egress) → §4.1 (reasoning-trace in-process, safe-уровень).
- T-0218 §6.2 (actor-seed через importer, не PG) + FF-PACK-2 → §3 (плоскость seed).

## 8. Runtime target / эскалации

- **runtime_target:** dev-стенд showcase-тенанта (T-0141), кликабельный слайс; agent_card dormant.
- **escalation:** нет founder-only форка. Единственное «решение под фаундера в
  будущем» — реальный live-провод LLM intake-агента на проде (ключ/среда) =
  deploy-time, НЕ блокер этой impl-задачи.

## 9. adr_artifact_path

`docs/design/T-0219-intake-agent.adr.md`
