# ADR · T-0233 — Агент-рантайм live-исполнение: мотор «инструкция + документ → модель → ответ в процесс» на навыке `legal_precheck`

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-15
**Product:** choros · **Type:** impl · **Branch:** `task/T-0233`
**Spec:** `docs/specs/T-0233-agent-runtime-live-precheck.spec.md` (16 AC, status ready) + `docs/specs/T-0233.spec.contract.json`
**adr_artifact_path:** `docs/design/T-0233-agent-runtime-live-precheck.adr.md`

**Foundation (do NOT contradict — проверено по коду на этой ветке):**
- `src/core/agent-instruction.ts` (T-0123/T-0230, PURE) — `AgentInstruction` { `instructionText`, `answerForm`, `instructionMeta` }; `src/db/agent-instruction-store.ts::readPublished(tx, employeeId)` — единственный read-путь к опубликованной инструкции.
- `src/core/grant-resolver.ts::resolveFor(deps, handle, subject, op, …)` (T-0021) — единый PDP; возвращает `ResolvedView | EffectDeniedView | SodDeniedView`; deny-форма `{ denied:true, reason }`, reason ∈ `{cross_tenant,no_grant,no_effect_grant,sod_violation}`. `ResolverDeps` — DI-паттерн ядра (`grants`/`records`/`ancestry`/optional ports + `now`).
- `src/db/audit-writer.ts::AuditWriter.appendAuditEvent(tx, input)` (T-0016) — единственный audit-sink; `audit_event.type` = open-vocab (`migrations/006`, без CHECK). `agent.deferred`/`agent.blocked` — open-vocab строки (T-0220 §5).
- `docs/design/T-0220-agent-step-outcomes.adr.md` — модель исходов `proceed`/`defer-to-human`/`fail-closed`, INV-DEFAULT (любая неопределённость → НЕ `proceed`); приоритет `fail-closed` > `defer` > `proceed`. **T-0220 — design-only; impl-функция `classifyOutcome` ещё НЕ построена** → T-0233 строит её (узко, для этого мотора) по контракту §3/§4 T-0220.
- `migrations/032_agent_card.sql` — `llm_endpoint`/`llm_model`/`llm_secret_handle` NULL = dormant; `autonomy_threshold numeric(5,4) NULL` = dormant порог.
- `src/core/secret-handle-validator.ts` (T-0025) — `validateSecretHandleShape`/`redactHandle`/`SecretResolverPort` (custody-порт RL-3).
- `ci/checks/agent-instruction-runtime-dormant.sh` (FF-COMP-6) — dormant-gate: runtime-пути (`src/core/engine`, `src/worker`, `src/adapters`, `src/bridge-*`) НЕ читают `agent_instruction`; allowlist через `ALLOWED_RE`.
- `ci/checks/budget-dormancy.sh` (FF-BUD-10) / `ci/checks/no-env-in-core.sh` (T-0163) — образцы dormancy- и env-boundary-чеков.
- `src/http/invoke.ts` (T-0024) — invoke/PDP-механика, dispatch = stub day-1 (`/api/invoke/command` → no-op `invocation_id`). **T-0233 заменяет dispatch-stub живым мотором РОВНО для навыка `legal_precheck`.**
- `src/http/inbox.ts` (E7) — **display-only seed-поверхность day-1**: in-memory `SEED_ITEMS`, НЕТ DB-backed task-таблицы (подтверждено: миграции 043–048 не вводят `choros.task`/`choros.inbox`). → `defer-to-human` материализуется в **audit-floor** (канонический DB-backed append-only), не в несуществующую task-таблицу (§5.3).

> Это **buildable** ADR: каждое «где это живёт» привязано к реальному файлу выше. Мотор **аддитивен** — НЕ трогает byte-frozen `grant-lattice.ts`/`object-handle.ts`, НЕ вводит новой таблицы, НЕ открывает generic-runtime-чтение `agent_instruction`.

---

## 1. Контекст и несущее напряжение

T-0233 — **первый ЖИВОЙ навык агента**: рантайм-мотор, который на ОДНОМ навыке `legal_precheck`
(юр-предпроверка договора при сумме ≥ 5 млн ₽, ТЭЛ §1/§3) берёт инструкцию агента (`instruction_text` +
`answer_form` через T-0123 read-путь) + документ договора, прогоняет через **инъектируемый порт модели
`LlmPort`** и возвращает структурированный red-flags-ответ обратно в процесс как `answer_form`-исход —
под единым PDP (`resolveFor`), единым аудитом (`appendAuditEvent`), моделью исходов T-0220 и D-139
(reasoning не утекает наружу).

**Несущее напряжение:** «live = реальный LLM», но **OpenAI-бюджет прогона = $0** и фабрика НЕ оплачивает
product-runtime LLM choros. Приёмка обязана быть детерминированной без платного вызова. **Разрешение:**
модель зовётся ТОЛЬКО через интерфейс-порт `LlmPort`; тесты/CI инжектят детерминированную стаб-фикстуру
(ноль сети/кредла); живой провод — отдельная реализация порта, **config-gated + dormant-by-default**
(`agent_card.llm_*` NULL = dormant, как сегодня). Реальный ключ флипает live ПОЗЖЕ на среде фаундера
(deploy-time, не impl-блокер) → задача `ready` без кредла.

---

## 2. Решение (один абзац)

Вводим **тонкий pure-core мотор** `src/core/agent-precheck-motor.ts` (IO-free, без SDK/env/pg/fetch),
который реализует ФУНКЦИЮ навыка `legal_precheck`: на вход `PrecheckRequest` (инструкция из T-0123 +
демо-договор + контекст сделки + PDP-вердикт), на выход — детерминированный `PrecheckOutcome` (один из
трёх исходов T-0220). Мотор зависит от **инъектируемого порта `LlmPort`** (как `ResolverDeps`/
`SecretResolverPort`/`AncestryOracle` — DI-паттерн ядра): production-провод и тест-стаб — РАЗНЫЕ
реализации порта, мотор НЕ импортирует конкретный SDK. **Оркестрация** (PDP-проверка через `resolveFor`,
чтение `answer_form` через `readPublished`, выбор live-vs-dormant порта, эмиссия аудита) живёт на тонкой
границе `src/runtime/legal-precheck/` (новый узкий runtime-путь — единственное место, которому FF-COMP-6
разрешает читать `agent_instruction`, через явный узкий allowlist). Исход классифицирует
`classifyOutcome` (impl контракта T-0220, узко для этого мотора): `fail-closed` (PDP-deny / LLM-ошибка /
timeout / egress-блок / dormant-без-проба) → `agent.blocked`; `defer-to-human` (низкая уверенность /
неоднозначность / dormant-by-default) → `agent.deferred` с `doubtReason`; `proceed` (PDP-allow И обе
confidence-калитки) → структурированный red-flags-`answer` в форме `answer_form`. **Reasoning-trace** (если
порт его вернул) пишется ТОЛЬКО во внутренний `audit_event.payload` под T-0139-маскированием; тип
`PrecheckAnswer` структурно НЕ несёт reasoning-полей (D-139). Живой LLM-вызов происходит ТОЛЬКО когда
`agent_card.llm_*` сконфигурированы И включён live-флаг; иначе порт = `dormantLlmPort` (бросает при любой
сетевой попытке) → исход `defer`/`fail-closed`, никогда не оптимистичный `proceed`.

---

## 3. Объектная модель и контракты

### 3.1 `LlmPort` — инъектируемый порт модели (PURE TYPE, ядро)
**Где живёт:** `src/core/llm-port.ts` — **только TYPE + dormant-стаб**, БЕЗ env/SDK/fetch/pg
(зеркалит `SecretResolverPort` в `secret-handle-validator.ts`: ядро владеет деклорацией порта, адаптер —
отдельно). Production-адаптер (OpenAI/совместимый) — `src/adapters/openai-llm-port.ts` (Stage-deploy,
единственное место, где живёт SDK/fetch/ключ). Тест-стаб — `src/core/__tests__/stub-llm-port.ts`.

```ts
// src/core/llm-port.ts — PURE: no pg / node:http / https / net / fetch / child_process / process.env

/** Запрос к модели. Маскирование D-139: запрос несёт ТОЛЬКО инструкцию+документ+форму,
 *  никаких сырых секретов (ключ резолвится в адаптере через SecretResolverPort, не здесь). */
export interface LlmRequest {
  /** system-инструкция навыка — из agent_instruction.instructionText (T-0123). */
  readonly instruction: string;
  /** Тело документа (демо-договор) + контекст сделки (сумма/тип/направление). */
  readonly document: string;
  readonly dealContext: { amount: number; kind: string; direction: string };
  /** Применяемая форма ответа — agent_instruction.answerForm (T-0123); порт обязан вернуть в ней. */
  readonly answerForm: string;
}

/** Структурированный исход вызова модели. РАЗДЕЛЕНИЕ D-139:
 *   - `answer`  = безопасное тело (форма answerForm) — уходит в процесс/человеку;
 *   - `reasoning` = НЕОБЯЗАТЕЛЬНЫЙ сырой trace — пишется ТОЛЬКО во внутренний audit под маскированием,
 *                   НИКОГДА в тело ответа/исход наружу. */
export interface LlmResult {
  /** Самооценка модели [0,1] — второй confidence-сигнал B.5 (T-0220 §5.1). */
  readonly confidence: number;
  /** Структурированный ответ в форме answerForm (напр. список red-flags). Безопасно наружу. */
  readonly answer: PrecheckAnswer;
  /** Сырой reasoning — INTERNAL ONLY. Маскируется при записи в audit (T-0139). Опционально. */
  readonly reasoning?: string;
}

export interface LlmPort {
  /** Единственный метод. Production-адаптер делает сетевой вызов; стаб — детерминированную фикстуру;
   *  dormantLlmPort — БРОСАЕТ (LlmDormantError), чтобы любой сетевой путь в dormant был невозможен. */
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** Dormant-by-default порт: бросает при ЛЮБОМ вызове (FR-7/AC-4). Это default, когда live не сконфигурирован. */
export const dormantLlmPort: LlmPort; // complete() → throw new LlmDormantError("llm runtime dormant")
export class LlmDormantError extends Error {} // cause='dormant' → fail-closed/defer, не proceed
```

### 3.2 `PrecheckAnswer` — форма ответа (D-139: НЕ несёт reasoning)
**Где живёт:** `src/core/agent-precheck-motor.ts`. Тип СТРУКТУРНО не содержит `reasoning`/`trace`/`raw`
(AC-9 проверяется tsc на типе + grep по чеку). Форма привязана к `answerForm` из T-0123.

```ts
export interface RedFlag { clause: string; risk: string; severity: "low"|"med"|"high"; }
export interface PrecheckAnswer {
  readonly answerForm: string;          // эхо применённой agent_instruction.answerForm (AC-10)
  readonly redFlags: readonly RedFlag[];
  readonly summary: string;             // безопасное резюме (НЕ reasoning)
  // НЕТ полей reasoning/trace/raw/chainOfThought — D-139 (AC-9).
}
```

### 3.3 `PrecheckOutcome` — исход шага (T-0220)
```ts
export type PrecheckOutcome =
  | { kind: "proceed";        answer: PrecheckAnswer }
  | { kind: "defer-to-human"; doubtReason: string; signal: "threshold"|"model"|"ambiguity"|"dormant";
      inboxTaskRef: string /* = id материализованного defer-аудита; см. §5.3 */ }
  | { kind: "fail-closed";    cause: "pdp_deny"|"llm_error"|"llm_timeout"|"egress_block"|"dormant_no_probe";
      denyReason?: string /* для pdp_deny = reason из resolveFor */ };
```

### 3.4 `classifyOutcome` — классификатор (impl контракта T-0220 §3/§4, узко для мотора)
**Где живёт:** `src/core/agent-precheck-motor.ts` (pure). Тотальна, default-to-human (INV-DEFAULT):
приоритет `fail-closed` > `defer` > `proceed`; `proceed` — ТОЛЬКО остаток при ВСЕХ зелёных.

```ts
export interface OutcomeSignals {
  pdpDenied: boolean; pdpReason?: string;          // resolveFor deny → fail-closed (приоритет 1)
  llmError?: "llm_error"|"llm_timeout"|"egress_block"|"dormant_no_probe"; // → fail-closed
  llmDormant: boolean;                              // live не сконфигурирован → defer/fail (не proceed)
  modelConfidence?: number;                         // < threshold → defer (приоритет 2)
  thresholdFailed: boolean;                         // autonomy_threshold/DMN порог нарушен → defer
  ambiguous: boolean;                               // неоднозначность → defer
  answer?: PrecheckAnswer;
}
// classifyOutcome(s): PrecheckOutcome — proceed достижим ИСКЛЮЧИТЕЛЬНО когда
//   !pdpDenied && !llmError && !llmDormant && !thresholdFailed && conf>=threshold && !ambiguous && answer!=null.
//   Любой undefined/неполный сигнал → defer (мягкий дефолт), структурный отказ → fail-closed.
```

### 3.5 Оркестратор навыка (тонкая граница, новый runtime-путь)
**Где живёт:** `src/runtime/legal-precheck/run-precheck.ts` (новый каталог — единственный runtime-путь,
которому FF-COMP-6 узко разрешает читать `agent_instruction`). Контракт:

```ts
export interface PrecheckDeps {
  llm: LlmPort;                 // инъектируется: production-адаптер | стаб | dormantLlmPort
  resolverDeps: ResolverDeps;   // T-0021 — для resolveFor (единственный PDP)
  auditWriter: AuditWriter;     // T-0016 — единственный audit-sink
  liveEnabled: boolean;         // live-флаг (deploy-time); false ⇒ порт принудительно dormantLlmPort
}
/** Один прогон навыка под tenant-tx (RLS уже SET LOCAL). Возвращает исход + пишет ровно один аудит. */
export async function runLegalPrecheck(
  tx: PgClientLike, deps: PrecheckDeps,
  args: { tenantId: string; agentEmployeeId: string; documentHandle: ObjectHandle;
          subject: ResolveSubject; dealContext: {amount:number;kind:string;direction:string}; nowMs: number },
): Promise<PrecheckOutcome>;
```
Поток `runLegalPrecheck` (см. §4).

---

## 4. Поток мотора (FR-3/4/5/6)

```
runLegalPrecheck(tx, deps, args):
  1. PDP (T-0021, единственный): resolveFor(deps.resolverDeps, documentHandle, subject, "read", …)
       → denied ⇒ classifyOutcome({pdpDenied:true, pdpReason}) = fail-closed
                  → appendAuditEvent(agent.blocked{cause:"pdp_deny", denyReason}) → return
       → allowed: получили поля договора (fields) под tenant-RLS (NF-5).
  2. Live-калитка (FR-7): port = (deps.liveEnabled && llmConfigured(agent_card)) ? deps.llm : dormantLlmPort
       где llmConfigured = (llm_endpoint!=null && llm_model!=null && llm_secret_handle!=null).
       deps.liveEnabled=false ИЛИ NULL llm_* ⇒ dormantLlmPort.
  3. Инструкция (T-0123, узкий allowlist FF-COMP-6): instr = readPublished(tx, agentEmployeeId)
       → instr==null ⇒ defer-to-human{signal:"dormant", doubtReason:"no published instruction"}
                       → appendAuditEvent(agent.deferred) → return  (missing-instruction ветка)
       req = { instruction: instr.instructionText, document: fields.body, dealContext,
               answerForm: instr.answerForm }
  4. Вызов модели через ПОРТ:
       try result = await port.complete(req)
       catch e:  e instanceof LlmDormantError ⇒ signals.llmDormant=true (→ defer/fail, не proceed)
                 timeout ⇒ llmError="llm_timeout"; egress ⇒ "egress_block"; иначе "llm_error"
                                                  ⇒ fail-closed (приоритет 1)
  5. Confidence-калитки (T-0220 §5.1, ОБА сигнала B.5):
       thresholdFailed = (autonomy_threshold!=null && result.confidence < autonomy_threshold)  // каркас
       modelConfidence = result.confidence                                                     // самооценка
       ambiguous = (result.answer пуст/маркирован неоднозначным)
  6. classifyOutcome(signals) → ровно один исход:
       fail-closed ⇒ appendAuditEvent(agent.blocked{cause, denyReason?})         // ноль success-аудита
       defer       ⇒ inboxTaskRef = appendAuditEvent(agent.deferred{doubtReason,signal,reasoningTraceRef})
                       (def-материализация = audit-floor; inbox-UI — существующий seam, §5.3)
       proceed     ⇒ governed-эффект/actor_event (T-0019/T-0220 §3.3) + answer (форма answerForm)
                       наружу; reasoning (result.reasoning) пишется ТОЛЬКО в audit под T-0139-маскированием.
```
**Fail-closed/defer ветки явно:** dormant-card → `defer` (signal=`dormant`) ИЛИ `fail-closed`
(`dormant_no_probe`, если зовущий процесс требует решения, не предложения) — выбор по `args` зовущего;
day-1 default = `defer` (мягче, default-to-human). Missing-instruction → `defer`. LLM error/timeout/egress
→ `fail-closed`. Low-confidence/ambiguity → `defer`. PDP-deny → `fail-closed`. **Ни одна ветка не ведёт к
`proceed` без PDP-allow И обеих калиток** (INV-DEFAULT, AC-4).

---

## 5. Ключевые seam-решения

### 5.1 Единый PDP, единый audit, единая форма (NF-2)
Data-access ТОЛЬКО через `resolveFor` (T-0021) — никакого второго резолвера/authority на пути навыка
(AC-7, `single-resolver.sh` + новый `legal-precheck-single-resolver.sh`). Аудит ТОЛЬКО через
`appendAuditEvent` (T-0016) — никакого второго audit-writer (AC-8). Форма ответа ТОЛЬКО из
`agent_instruction.answerForm` через `readPublished` — никакого локального `responseFormat`-стора (AC-10).

### 5.2 Reasoning не утекает (D-139, AC-9)
Разделение в `LlmResult`: `answer` (наружу) vs `reasoning?` (internal-only). `PrecheckAnswer` структурно
не несёт reasoning-полей. Оркестратор пишет `result.reasoning` ТОЛЬКО в `appendAuditEvent`-payload под
T-0139-маскированием; в тело исхода/`res.json`/процесс reasoning не попадает. Fitness-чек грепает: нет
присвоения `reasoning` в `answer`/исход/response, есть только в audit-payload.

### 5.3 `defer-to-human` материализуется в audit-floor (не в task-таблицу — её НЕТ day-1)
Подтверждено по коду: `src/http/inbox.ts` — display-only seed, DB-backed task-таблицы нет (миграции
043–048). T-0220 §6.2 называл inbox-task seam'ом — day-1 канонический DB-backed append-only носитель =
**audit_event** (T-0016). Поэтому `defer` пишет `agent.deferred` с `doubtReason`+`signal`+
`reasoningTraceRef`; `inboxTaskRef` = id этого аудит-события (стабильная ссылка). Полная DB-инбокс-задача
(claim/SLA) — существующий E7-seam (Stage), НЕ вводится здесь (T-0233 не создаёт новой таблицы,
честно по §4 OOS спеки). Это удовлетворяет AC-6 (defer материализует запись «нужна проверка» с
`doubt_reason` + пишет `agent.deferred`) без изобретения task-таблицы.

### 5.4 RL-3 custody (T-0025, NF-3, AC-13)
Day-1 (dormant) секрет-путь НЕ активен: `dormantLlmPort` не резолвит секрет. Когда live включается,
ключ резолвится ТОЛЬКО в `src/adapters/openai-llm-port.ts` через `SecretResolverPort`
(`agent_card.llm_secret_handle` = opaque handle), `redactHandle` для логов; `validateSecretHandleShape`
гарантирует, что в столбце не сырой ключ. Сырого секрета нет в `console.*`/`appendAuditEvent`/`res.json`/
exception (fitness-грэп). Ядро (`src/core/llm-port.ts`) секрет НЕ видит (no-env-in-core).

---

## 6. Dormant→live гейт (FR-7, NF-4)

**Dormant-by-default — три замка:**
1. **Конфиг:** `agent_card.llm_*` NULL (как сегодня, `migrations/032`) ⇒ `llmConfigured=false` ⇒ `dormantLlmPort`.
2. **Live-флаг:** `deps.liveEnabled` (deploy-time, из composition root, НЕ из ядра) `false` ⇒ принудительно `dormantLlmPort`.
3. **Порт-инвариант:** `dormantLlmPort.complete()` БРОСАЕТ — структурно невозможен сетевой вызов в dormant.

**Флип в live** = deploy-time действие фаундера на его среде: задать `agent_card.llm_endpoint/model/
secret_handle` + поднять live-флаг в composition root. Это **не** impl/приёмочный шаг (OQ-1/OQ-2 §7 спеки).

**Узость разморозки (NF-4, AC-11):** FF-COMP-6 (`agent-instruction-runtime-dormant.sh`) сегодня FAIL'ит
любой runtime-путь, читающий `agent_instruction`. T-0233 добавляет ЕДИНСТВЕННЫЙ новый runtime-путь
`src/runtime/legal-precheck/` и **узко** расширяет `ALLOWED_RE` гейта РОВНО на этот путь (allowlist =
`src/runtime/legal-precheck/`), не открывая generic-runtime. Все прочие пути (`src/core/engine`,
`src/worker`, `src/adapters`, `src/bridge-*`) ПО-ПРЕЖНЕМУ FAIL'ят при чтении инструкции — проверяется
негативным self-test нового/расширенного гейта. Новый чек `legal-precheck-unpark-narrow.sh` дополнительно
утверждает: `agent_instruction`-чтение в runtime присутствует ТОЛЬКО под `src/runtime/legal-precheck/`.

---

## 7. Fitness-функции (load-bearing — машинные границы)

Все новые чеки следуют паттерну `ci/checks/*.sh` + `--self-test`, регистрируются в `package.json` `fitness`.
`static-now` (репозиторий zero-runtime-dep), кроме AC-2/3/14 (vitest unit/db).

| id | rule | ci_check |
|---|---|---|
| **FF-LP-1** (AC-1) | `LlmPort` экспортирован из `src/core/llm-port.ts`; мотор/оркестратор принимают порт как инъектируемую зависимость (deps/конструктор); НИ ОДИН SDK-импорт (`openai`/`@anthropic`/`fetch`-к-провайдеру) в `src/core/**` и `src/runtime/legal-precheck/**`. | new `ci/checks/llm-port-injectable.sh --self-test`: (a) `src/core/llm-port.ts` экспортирует `LlmPort`+`dormantLlmPort`; (b) grep — нет `from "openai"`/`from "@anthropic*"`/`import.*-sdk` в `src/core/**`+`src/runtime/legal-precheck/**`; (c) `runLegalPrecheck` принимает `llm: LlmPort` в deps. |
| **FF-LP-2** (AC-9, D-139) | `PrecheckAnswer`/`PrecheckOutcome` структурно НЕ несут `reasoning`/`trace`/`raw`/`chainOfThought`; `reasoning` присваивается ТОЛЬКО в `appendAuditEvent`-payload, не в `answer`/исход/`res.json`. | new `ci/checks/precheck-no-reasoning-egress.sh --self-test`: grep — в типах ответа нет reasoning-полей; единственное упоминание `result.reasoning`/`.reasoning` на write-стороне — внутри `appendAuditEvent(...)` аргумента; tsc подтверждает форму типа. |
| **FF-LP-3** (AC-4/AC-12, dormant+$0) | Ядро+оркестратор не делают прямого сетевого вызова к LLM (нет `fetch`/`https`/SDK вне адаптера); `dormantLlmPort` бросает; CI зелёный без `OPENAI_API_KEY`. | new `ci/checks/precheck-no-network-in-core.sh --self-test`: grep — нет `fetch(`/`https.request`/`new OpenAI` в `src/core/**`+`src/runtime/legal-precheck/**`; ассерт `dormantLlmPort` бросает; (runtime-сторона: npm test зелёный без LLM-env, см. FF-LP-7). |
| **FF-LP-4** (AC-11/NF-4) | Runtime-чтение `agent_instruction` допущено РОВНО на `src/runtime/legal-precheck/`; прочие runtime-пути по-прежнему FAIL. | extend `ci/checks/agent-instruction-runtime-dormant.sh` (`ALLOWED_RE` += `src/runtime/legal-precheck/`) + new `ci/checks/legal-precheck-unpark-narrow.sh --self-test`: ассерт runtime-`agent_instruction`-хиты ⊆ `src/runtime/legal-precheck/`; негативный self-test: хит в `src/worker`/`src/core/engine` ⇒ FAIL. |
| **FF-LP-5** (AC-7) | Data-access навыка ТОЛЬКО через `resolveFor`; нет второго резолвера/authority на пути. | new `ci/checks/legal-precheck-single-resolver.sh --self-test`: grep в `src/runtime/legal-precheck/`+`src/core/agent-precheck-motor.ts` — есть `resolveFor`, нет иной `*resolve*`/`*authorize*`/`covers*`-функции, выдающей allow/deny; existing `single-resolver.sh` остаётся зелёным. |
| **FF-LP-6** (AC-8) | Аудит навыка ТОЛЬКО через `appendAuditEvent`; нет второго audit-writer; success/deferred/blocked эмитят ожидаемый `audit_event`. | new `ci/checks/legal-precheck-single-audit.sh --self-test`: grep — на пути навыка единственный writer = `appendAuditEvent`; присутствуют строки `agent.blocked`/`agent.deferred`; нет прямого `INSERT INTO ... audit_event`. |
| **FF-LP-7** (AC-12/AC-16/NF-1) | Полный `npm run ci`/`npm test`/`npm run fitness` зелёный без `OPENAI_API_KEY`/LLM-секрета и без сети к провайдеру (стаб-порт); tsc exit 0. | existing `npm run ci` (tsc+vitest+fitness) выполняется в окружении без LLM-env; unit-тесты мотора инжектят `stub-llm-port`; AC-2/AC-3/AC-5/AC-6/AC-14 vitest-кейсы — часть `npm test`. |
| **FF-LP-8** (AC-13/NF-3) | Сырого LLM-секрета нет в `console.*`/`appendAuditEvent`/`res.json`/exception; ядро не читает секрет; live-адаптер резолвит через `SecretResolverPort`+`redactHandle`. | new `ci/checks/precheck-secret-custody.sh --self-test`: grep — нет `llm_secret_handle` сырого в логах/audit/response на пути навыка; `src/core/llm-port.ts` не импортирует секрет/env; existing `no-env-in-core.sh` остаётся зелёным. |
| **FF-LP-9** (AC-1/AC-16) | Мотор `src/core/agent-precheck-motor.ts` PURE: нет `pg`/`node:http`/`https`/`net`/`fetch`/`child_process`/`process.env`. | extend coverage via `no-env-in-core.sh` (мотор под `src/core/`) + FF-LP-1(b)/FF-LP-3 grep; tsc `--noEmit` exit 0. |

> Byte-frozen `grant-lattice.ts`/`object-handle.ts` НЕ трогаются — `frozen-checks-immutable.sh` /
> `grant-resolver-isolation.sh` / `object-handle-isolation.sh` остаются зелёными без изменений (мотор аддитивен).

---

## 8. Реконсиляция seam: MODIFY vs CREATE

**CREATE (аддитивно):**
- `src/core/llm-port.ts` — `LlmPort` type + `dormantLlmPort` + `LlmDormantError` (PURE).
- `src/core/agent-precheck-motor.ts` — `PrecheckAnswer`/`PrecheckOutcome`/`OutcomeSignals`/`classifyOutcome` (PURE).
- `src/runtime/legal-precheck/run-precheck.ts` — оркестратор `runLegalPrecheck` (новый runtime-путь).
- `src/adapters/openai-llm-port.ts` — production-адаптер (SDK/секрет; Stage-deploy, не в приёмке).
- `src/core/__tests__/stub-llm-port.ts` + `src/runtime/legal-precheck/__tests__/*.test.ts` — стаб + unit/db-тесты (AC-2/3/4/5/6/14).
- Демо-фикстура: демо-договор(ы) ≥ 5 млн ₽ как seed/фикстура демо-тенанта (AC-15) — в существующем seed-pack/фикстурном механизме (не новая таблица).
- Новые `ci/checks/`: `llm-port-injectable.sh`, `precheck-no-reasoning-egress.sh`, `precheck-no-network-in-core.sh`, `legal-precheck-unpark-narrow.sh`, `legal-precheck-single-resolver.sh`, `legal-precheck-single-audit.sh`, `precheck-secret-custody.sh` (+ `--self-test` каждому).

**MODIFY (узко, аддитивно):**
- `ci/checks/agent-instruction-runtime-dormant.sh` — `ALLOWED_RE` += `src/runtime/legal-precheck/` (узкий allowlist, FF-COMP-6 остаётся зелёным для всего прочего).
- `package.json` `fitness`-скрипт — добавить новые чеки + их `--self-test`.
- `src/http/invoke.ts` — ОПЦИОНАЛЬНО: для навыка `legal_precheck` dispatch-stub вызывает `runLegalPrecheck` вместо no-op (если зовущий путь — invoke). Аддитивно, не ломает coversInvoke/PDP-механику; existing `invoke-grant-isolation.sh` зелёный.

**НЕ ТРОГАЕТСЯ (byte-frozen / границы):** `src/core/grant-lattice.ts`, `src/core/object-handle.ts`,
`src/core/grant-resolver.ts` (используется как есть), `src/core/agent-instruction.ts`,
`src/db/agent-instruction-store.ts` (читается как есть), `src/db/audit-writer.ts`, `migrations/032`
(llm_* остаются NULL/dormant), `constitution/`, `agents/`. **touches_frozen = false.**

---

## 9. Rejected alternatives

1. **Конкретный SDK (`openai`) прямо в ядре мотора** — ломает $0-приёмку (NF-1) и тестируемость; делает
   CI зависимым от кредла/сети. Порт + DI (как `ResolverDeps`/`SecretResolverPort`) — обязателен.
2. **Generic agent-runtime (читает `agent_instruction` для ЛЮБОГО навыка)** — нарушает FF-COMP-6 узость
   (NF-4) и OOS спеки; T-0233 размораживает РОВНО один навык. Узкий allowlist `src/runtime/legal-precheck/`.
3. **Новая таблица `agent_step_outcome` / DB-backed inbox-task для defer** — нарушает «ничего нового сверх
   envelope» (T-0220 §9.2) и OOS «не вводит новой таблицы»; audit-floor (open-vocab `agent.deferred`) —
   канонический DB-backed носитель day-1; inbox-UI — существующий E7-seam.
4. **`reasoning` в теле ответа-исхода** — прямое нарушение D-139 (red-line). Разделение `answer` vs
   `reasoning?` в `LlmResult`; `PrecheckAnswer` структурно без reasoning.
5. **Live-провод включён по умолчанию** — нарушает dormant-by-default (FR-7); жжёт бюджет, делает приёмку
   недетерминированной. Три замка (NULL-конфиг / live-флаг / бросающий dormant-порт).
6. **`proceed` как default-ветвь классификатора при неполноте сигнала** — ломает INV-DEFAULT (T-0220 §4);
   неопределённость → `defer`/`fail`, не «агент додумал».
7. **Свой `responseFormat`-стор в моторе** — дублирует T-0123 `answer_form`; форма читается из
   `agent_instruction.answerForm` через `readPublished` (NF-2/AC-10).
8. **Второй резолвер прав для read договора** — нарушает единый PDP (T-0021/NF-2); `resolveFor` — единственный.

---

## 10. Traceability (AC → дизайн)

| AC | covered_by |
|---|---|
| AC-1 | §3.1 `LlmPort` (PURE type, DI) + §3.5 deps; FF-LP-1, FF-LP-9 |
| AC-2 | §4 поток + §8 `stub-llm-port` unit-тест (демо-договор ≥5 млн); FF-LP-7 |
| AC-3 | §3.4 `classifyOutcome` детерминизм + стаб-фикстура; FF-LP-7 (vitest golden) |
| AC-4 | §6 dormant-замки + §3.1 `dormantLlmPort` бросает → §3.4 не `proceed`; FF-LP-3 |
| AC-5 | §4 ветки fail-closed (pdp_deny/llm_error/egress) + §3.3 `cause`; FF-LP-6 (`agent.blocked`) |
| AC-6 | §5.3 defer → `agent.deferred` с `doubtReason`+`inboxTaskRef`; FF-LP-6 |
| AC-7 | §5.1 единый `resolveFor`; FF-LP-5 + existing `single-resolver.sh` |
| AC-8 | §5.1 единый `appendAuditEvent`; FF-LP-6 |
| AC-9 | §3.2 `PrecheckAnswer` без reasoning + §5.2; FF-LP-2 |
| AC-10 | §3.2/§4 форма из `answerForm` через `readPublished`; FF-LP-2/частично FF-LP-6 (эхо формы) |
| AC-11 | §6 узкий allowlist; FF-LP-4 (extend FF-COMP-6 + `legal-precheck-unpark-narrow.sh`) |
| AC-12 | §1/§6 стаб-порт, $0; FF-LP-3, FF-LP-7 |
| AC-13 | §5.4 RL-3 custody; FF-LP-8 |
| AC-14 | §4 шаг 1 (RLS/tenant под `resolveFor`+`SET LOCAL`); vitest cross-tenant probe (FF-LP-7) |
| AC-15 | §8 демо-договор ≥5 млн как seed/фикстура; FF-LP-7 (фикстура присутствует) |
| AC-16 | §7/§8 tsc/test/fitness зелёные; FF-LP-7, FF-LP-9 |

---

## 11. Runtime / deploy target

**Runtime:** существующий choros dev-стек (single-Postgres + node:http) на home-сервере фаундера
(`/srv/choros`, deploy founder-gated). **Приёмка** (стаб-порт) исполняется локально/в CI без внешнего
ресурса, без `OPENAI_API_KEY`. **Live-провод** (реальный LLM) — deploy-time действие фаундера на его
среде (config `agent_card.llm_*` + live-флаг + бюджет) = **GT-4 граница фаундера** (D-060: бюджет/секреты/
необратимое = фаундер; механизм = автономно). **Нет founder-gate на impl/приёмку** — мотор строится и
приёмается на порту+стабе независимо (OQ-1/OQ-2 §7 спеки — не блокирующие). **Нет новой миграции, новой
таблицы, нового внешнего ресурса** (мотор аддитивен).

**Status:** `ready`. Все инженерные оси решены в рамках ратифицированных решений (T-0021/T-0016/T-0123/
T-0220/T-0025/T-0139/D-139/D-060); open questions — deploy/бюджет-граница фаундера, impl/приёмку не блокируют.
