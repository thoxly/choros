# T-0219 · DEMO-2 intake-agent — классификатор-триаж в слот S2 ТЭЛ

> Тип: impl · spec_ref: `playbooks/v1-demo-and-trust-surface.md#A`
> depends_on: T-0123 (DONE — competency layer: agent_instruction draft→promote) ·
>             T-0077 (DONE — seed pattern) · T-0218 (DONE — DEMO-1 сценарий/слоты)
> Слот-контракт (НЕ переопределять): `docs/design/T-0218-demo-1-scenario.adr.md#41` (`INTAKE_SLOT`)
> Параллельно: T-0234 строит слот S3 (legal-precheck) — правки `tel-scenario.ts` держим в S2/intake-части.

## 0. Что эта спека фиксирует

Машинно-проверяемые приёмочные критерии **первого живого агент-навыка триажа**
(intake-agent), вписанного в **заранее размеченный слот S2** линейного ТЭЛ
(T-0218). Агент по поданной заявке (`subject` / `amount` / `justification` /
`requester`) производит **классификацию + маршрут**
(`category` / `budget_article` / `direction` / **типизированный `route`**) с
**reasoning-trace** на шаге S2. Навык поставляется как **seed-данные**
(agent_card + роль + инструкция-классификатор, **draft-first** по слою
компетентности T-0123/T-0230) плюс **детерминированный классификатор-демонстратор**
(чистая функция, ноль платных LLM).

**Граница задачи:** это impl-задача слота **S2**. Слот S3 (legal-precheck,
T-0234) НЕ трогаем кроме чтения контракта `route.legal_required` как его триггера.

## 1. Решение по типу `route` (review-flagged: «route был прозой»)

ADR T-0218 §4.1 описывал `route` как «список обязательных согласующих» прозой.
Эта спека фиксирует **конкретную типизированную форму** `IntakeRoute`:

```ts
type IntakeApprover = {
  order: number;                                   // позиция в цепочке (1..N)
  role: "fin_controller" | "legal" | "cfo";        // обязательный согласующий
  reason: string;                                  // почему обязателен (для trace)
  mandatory: true;                                 // демо-маршрут = только обязательные
};
type IntakeRoute = {
  steps: readonly IntakeApprover[];                // упорядоченная цепочка S4-согласований
  legal_required: boolean;                         // amount ≥ 5M₽ → S3 legal-precheck firing
  approver_chain: readonly string[];               // плоский упорядоченный список role-кодов (UI/audit)
};
```

- **FR-route-1.** `route` выводится **детерминированно** из `amount` + `category`
  по правилам порога ТЭЛ §1.4: всегда `fin_controller`; при `amount ≥ 5M₽` —
  добавляется `legal` (перед `cfo`) и `cfo`; иначе `legal` не добавляется.
- **FR-route-2.** `route.legal_required === (amount ≥ TEL_LEGAL_THRESHOLD_RUB)` —
  **это поле и есть несущая связь S2→S3**: оно равно условию срабатывания слота
  legal-precheck (T-0234) и согласовано с `legalGateFires(amount)` из
  `tel-scenario.ts`.
- **FR-route-3.** Выход S2 кормит **S3 `dealContext`**: `{ amount, kind: category,
  direction }` (точная сигнатура `runLegalPrecheck`, T-0233). `route.legal_required`
  решает, срабатывает ли гейт; `amount/kind/direction` производны от выхода S2.

## 2. Функциональные требования

- **FR-1.** **agent_card** intake-agent заведён как seed: LLM-поля
  (`llm_endpoint` / `llm_model` / `llm_secret_handle`) = NULL (**dormant** — живой
  провод = deploy-time, НЕ в этой задаче, ноль платных LLM в CI). Совместим с
  формой `agent_card` (migration 032).
- **FR-2.** **Роль `role-intake-agent`** + сотрудник-агент `a-intake` заведены в
  **additive actor-плоскости** (НЕ display-плоскость — FF-PACK-2 8/8 не трогаем),
  применяются через **importer / публичный API**, НЕ прямым PG.
- **FR-3.** **Инструкция-классификатор** заведена **draft-first** по слою
  компетентности (T-0123: `instruction_text` + `answer_form` + `instruction_meta`).
  Tier='draft' (promote draft→published = отдельный человеко-гейт, НЕ здесь).
  `answer_form` = `intake_triage_v1` (машинно-различимый код формы выхода).
- **FR-4.** **Детерминированный классификатор** `classifyIntake(input)` — чистая
  функция (ноль pg/сети/LLM), производит `{ category, budget_article, direction,
  route, reasoning_trace }`. Демонстрирует навык **детерминированно** (demo-deal →
  стабильный выход). Это демо-демонстратор; живой LLM-инференс = deploy-time.
- **FR-5.** **reasoning-trace** на S2: структурированный список шагов «почему
  категория=X / почему статья=BUD-14 / почему сумма≥порога→добавлен legal+cfo».
  Наружу — безопасный answer + метаданные; **сырой reasoning остаётся внутри**
  (D-139: ноль внешнего egress reasoning). Демо-trace — это in-process audited
  trace, не сетевой вывод.
- **FR-6.** **Moat (нет approve-гранта).** Роль `role-intake-agent` получает
  гранты только `read` (заявка) + `update` (классификация). **НИ ОДНОГО** гранта
  на approve-переход (структурный moat, PDP-deny). Агент классифицирует — НЕ
  согласовывает.
- **FR-7.** **Idempotent / lint-clean / typed.** Seed применяется повторно как
  no-op (наследует idempotency importer-а / ON CONFLICT). Классификатор и seed —
  типизированы (tsc), eslint-clean. Никакой сети к LLM, никаких платных вызовов.

## 3. Нефункциональные требования

- **NF-1.** Ни один байт-frozen security-файл не тронут (`touched_frozen=false`):
  grant-lattice, object-handle, frozen-checks, grant-resolver, mcp-tool-registry,
  agents.ts, grants.ts, audit-writer.ts.
- **NF-2.** Классификатор НЕ читает таблицу `agent_instruction` из рантайма (не
  трогает narrow allowlist dormant-гейта `agent-instruction-runtime-dormant.sh`).
  Он pure-compute; инструкция-классификатор живёт как seed-данные (T-0123-способ).
- **NF-3.** Один источник правды: правки `tel-scenario.ts` локализованы в S2/intake
  части (T-0234 строит S3 параллельно — мержи аддитивны).
- **NF-4.** dev остаётся ЗЕЛЁНЫМ: FF-PACK-2 (8/8) не ломается; `fitness:seed`
  статические проходят.

## 4. Acceptance criteria (machine-checkable где возможно)

| id | критерий | verifiable_as |
|----|----------|---------------|
| AC-1 | SPEC+ADR+impl+pr-handoff присутствуют и валидны по контракту. | fitness (FF-INTAKE-1) |
| AC-2 | agent_card intake-agent — LLM-поля NULL (dormant): ноль платных LLM. | fitness (FF-INTAKE-1) |
| AC-3 | Роль `role-intake-agent` имеет гранты read+update, **НИ ОДНОГО** approve/exec/invoke на переход (moat). | fitness (FF-INTAKE-1) |
| AC-4 | Инструкция-классификатор заведена tier='draft' (draft-first); `answer_form='intake_triage_v1'`. | fitness (FF-INTAKE-1) |
| AC-5 | `route` типизирован (`IntakeRoute`): `steps[]` упорядочены, `legal_required` ⇔ `amount≥5M`, `approver_chain` плоский. | tsc + fitness |
| AC-6 | `classifyIntake(DEMO_DEAL)` детерминирован: стабильный `category=it_expense`, `budget_article=BUD-14`, `direction=buy`, `route.legal_required=true`, цепочка `[fin_controller, legal, cfo]`. | vitest |
| AC-7 | reasoning-trace присутствует на выходе классификатора, структурирован; сырой reasoning НЕ утекает наружу answer (D-139). | vitest |
| AC-8 | Правки `tel-scenario.ts` ограничены S2/intake (slot intake, demo agent_card, demo instruction) — слот legal_precheck (S3) не изменён. | doc-review/diff |
| AC-9 | `route.legal_required === legalGateFires(amount)` для demo-deal и для суммы < 5M (граничная проба). | vitest |
| AC-10 | Новая статическая fitness-проверка FF-INTAKE-1 имеет `# SELF-TEST:` и `--self-test` ветку. | fitness |
| AC-11 | `tsc --noEmit` exit 0; `eslint src` clean; `npm run build` ok; `npm run fitness` зелёный (статические); `vitest run` зелёный. | fitness |

## 5. Out of scope

- Живой LLM-инференс / провод ключа intake-агента — deploy-time (founder-gated).
- Promote инструкции draft→published — отдельный человеко-гейт (T-0123 path).
- Слот S3 legal-precheck (T-0234) — параллельная задача.
- Новый UI-экран — переиспользуем существующий слайс (inbox/карточка + audit).
- Реальные клиентские данные — demo-deal = фикстура (NF-5 T-0218).

## 6. spec_artifact_path

`docs/specs/T-0219-intake-agent.spec.md`
