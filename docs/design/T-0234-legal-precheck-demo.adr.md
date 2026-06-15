# ADR T-0234 · DEMO-3 — Юр-предпроверка договора агентом на S3 линейного ТЭЛ-демо

> Статус: ready-for-review · Тип: impl
> spec: `docs/specs/T-0234-legal-precheck-demo.spec.md`
> Контракт сценария (НЕ пере-решаем): `docs/design/T-0218-demo-1-scenario.adr.md` §4.2
> Потребляемый рантайм (НЕ правим): `src/runtime/legal-precheck/run-precheck.ts` (T-0233)
> depends_on: T-0233 (DONE) · T-0218 (DONE) · T-0141 (DONE)

---

## 1. Контекст и напряжение

T-0218 разметил слот `agent_slot.legal_precheck` на **S3 «Юр-предпроверка»**
линейного ТЭЛ-демо: при сумме ≥ 5 млн ₽ срабатывает условный гейт, который
**живой мотор `runLegalPrecheck` (T-0233)** прогоняет за человека. T-0233 уже
смержен: инъектируемый `LlmPort`, dormant-by-default, fail-closed, ноль платных
LLM в CI. T-0234 — это **impl-задача**: заменить роль человека на S3 агентом,
прогнать его исход в демо детерминированно (stub-порт) и **показать исход +
reasoning-trace в кликабельном слайсе** — при этом агент **не может
согласовать** (moat).

Три напряжения формируют решения ниже:

1. **Никаких платных LLM** (openai=$0, run-лиза). → весь демо-прогон идёт через
   `StubLlmPort`/`dormantLlmPort` T-0233; ни одного сетевого вызова.
2. **Frozen-ядро T-0233 не трогаем** — мы его *потребитель*, не автор; правка
   `run-precheck.ts`/`agent-precheck-motor.ts`/`llm-port.ts` потребовала бы
   frozen-санкции (не наше решение). → демо-обвязка живёт в **новом** модуле.
3. **FF-PACK-2 (8 rights / 8 processes) жёсткий** — раздуть display-плоскость
   нельзя. → исход показываем через **аудит-инстанс** (`/api/audit/:id`),
   который в счётчики 8/8 не входит.

---

## 2. Решение по dealContext (закрывает review-note T-0218 S3)

Reviewer T-0218 пометил: комментарий «Aligned with T-0233 DEMO_DEAL_CONTEXT» был
только amount-точным — T-0233 использует `kind:"service_agreement"`,
`direction:"outbound"`, а `tel-scenario.ts` стоял на `it_expense`/`buy`.

**Выбран `{ amount: 5_500_000, kind: "service_agreement", direction: "outbound" }`**
(= T-0233 `DEMO_DEAL_CONTEXT`). Почему именно эта:

- это **единственная** dealContext, под которую у T-0233 есть **тело договора**
  (`DEMO_CONTRACT_BODY` — договор оказания услуг с клаузулами §4.2 односторонний
  перенос оплаты / §7.1 cap ответственности / §11.3 иностранная юрисдикция) и
  **детерминированный ожидаемый ответ** (`DEMO_PRECHECK_ANSWER` — 3 red-flags).
  `it_expense`/`buy` тела договора не имеет → юр-предпроверке нечего
  анализировать, red-flags возникли бы из ниоткуда (нечестно для демо-«moat»);
- договор оказания услуг (outbound) — это **закупка услуги** = подмножество
  домена «заявка на расход/закупку» (T-0218 §2), не уводит из ТЭЛ-эталона;
- review-note предписывал align-with-T-0233 unless «expense scenario truly needs
  otherwise» — не требует (тела договора у него нет). → выравниваем.

Правки `seed/demo/tel-scenario.ts` **локализованы в S3/legal-precheck-секции**
(`DEMO_DEAL.subject/kind/direction`, `DEMO_DEAL_CONTEXT`, S3-комментарий).
Секция S2/intake (`INTAKE_SLOT`, `DEMO_GRANTS_INTAKE`, `DEMO_ROLE_INTAKE`) —
**не трогается** (T-0219 строит S2 параллельно; мерж аддитивен).

---

## 3. Решение по проводке агента как S3-актора (demo-run модуль)

**Новый модуль `src/runtime/legal-precheck/demo-run.ts`** — типизированная
композиция, которая запускает `runLegalPrecheck` как S3-актор демо
детерминированно:

| компонент | источник | роль |
|---|---|---|
| `runLegalPrecheck` | T-0233 `run-precheck.ts` (потребляем) | сам мотор-агент |
| `StubLlmPort` / `dormantLlmPort` | T-0233 stub / `llm-port.ts` (потребляем) | LLM-порт, **ноль сети** |
| `InMemoryAuditWriter` + `inMemoryTx` | T-0016 `audit-writer.ts` (потребляем) | единственный audit-сток, без БД |
| `ResolverDeps` (in-memory allow) | T-0021 `grant-resolver.ts` (потребляем) | единственный PDP, fail-closed |
| `DEMO_DEAL_CONTEXT` / `DEMO_CONTRACT_BODY` / `DEMO_AGENT_INSTRUCTION` | T-0233 fixture (потребляем) | demo-deal ≥5млн₽ |

Модуль экспортирует:

- `runDemoLegalPrecheck(opts)` → `{ outcome: PrecheckOutcome; auditRows; ... }` —
  один прогон мотора с выбранным режимом (`live-stub` → proceed,
  `dormant` → defer);
- `buildLegalPrecheckSliceView(outcome)` → **сериализуемый, D-139-safe** объект
  для слайса (`kind`, red-flags, summary, **opaque** `reasoning_trace_ref`,
  безопасные метаданные). НИКОГДА не включает сырой reasoning.

Модуль лежит в `src/runtime/legal-precheck/` — это путь, уже narrowly-allowed
для legal-precheck (FF-LP-4 / FF-COMP-6); он **не** называется `run-precheck.ts`,
поэтому FF-LP-2/FF-LP-3 (которые таргетят конкретно `run-precheck.ts`) не задеты.
Сети нет → FF-LP-3 зелёный и для нового файла.

### 3.1 Почему in-memory, а не БД

Демо-цель — показать **исход агента**, детерминированно и без инфраструктуры.
БД-наполнение `process_instances` = отдельная infra-тропа (`seed-apply-smoke`,
T-0218 §8, infra-bound). Мотор T-0233 спроектирован под инъекцию портов
(ResolverDeps/AuditWriter) — мы используем in-memory дубли (ровно как
`run-precheck.test.ts`), получая байт-идентичный исход без Postgres.

---

## 4. Решение по видимости в слайсе (audit read-API)

**Добавляем демо-аудит-инстанс `INS-TEL-DEMO`** в in-memory `AUDIT_SEED`
(`src/http/audit.ts`), обслуживаемый существующим `GET /api/audit/:instanceId`.
Его трейс — 5 узлов линейного ТЭЛ (S1..S5); **S3-узел** рендерит
**фактический** исход `runLegalPrecheck`, полученный из `runDemoLegalPrecheck` +
`buildLegalPrecheckSliceView` на этапе загрузки модуля:

- событие `agent` «провёл юр-предпроверку» с payload `call`=dealContext-сводка,
  `out`=red-flags-сводка (из `answer`, безопасно);
- событие `agent` «попытка перейти Согласовано → PDP-deny» (moat, tag=esc) —
  показывает, что агент **не может** approve;
- событие `human` «ожидает согласования» (S4 — человеческий card-action).

reasoning-trace surface = **opaque** `reasoning_trace_ref` в метаданных события
(D-139): фаундер видит, что reasoning **записан** (есть ссылка), но сырой текст
в слайс НЕ уходит — он лишь во внутреннем audit-payload мотора.

**Почему audit-инстанс, а не process_instances-строка:** FF-PACK-2 считает
`GET /api/rights`(=8) и `GET /api/processes`(=8) из пак-файла; аудит-инстансы
в эти счётчики не входят (проверено: `pack-serve-counts.sh` читает только
rights/processes). Новых React-экранов нет — переиспользуется экран audit
слайса (T-0218 §5).

---

## 5. Решение по moat (агент не может approve)

`role-intake-agent` (T-0218 §6.2, `DEMO_GRANTS_INTAKE`) имеет гранты
`read`(request) + `update`(request-classification), и **намеренно НЕ имеет**
гранта `approve`. Это выражается так:

- **PDP-уровень (единственный арбитр):** `resolveFor(deps, handle, agentSubject,
  "approve")` при grant-source без approve-гранта → `{ denied: true }`. Тест
  AC-4 утверждает именно это (operation `"approve"` из закрытого `Operation`-enum
  grant-lattice).
- **card-action-уровень:** approve-кнопка = `CardActionDecl{ operation:"approve",
  semantics:"transition" }`; `fireCardAction` маршрутизирует на тот же
  `resolveFor` (single arbiter, FF-CA-1) → `{ ok:false, reason:"no_grant" }`.
  (Демо может показать любой из двух — оба честно отражают одну дырку-в-решётке.)

Moat **структурен** (write-time отсутствие гранта), не пост-фактум фильтр.
approve остаётся человеческим card-action на S4 (`e-larina`).

---

## 6. Отклонённые альтернативы

| Альтернатива | Почему нет |
|---|---|
| Оставить `it_expense`/`buy` в tel-scenario.ts | Нет тела договора/детерминированного ответа под эту dealContext у T-0233 → red-flags из ниоткуда; review-note предписал align-with-T-0233 (§2). |
| Править `run-precheck.ts`, чтобы «вшить» demo-deal | Frozen-ядро T-0233; правка требует frozen-санкции (governance, не наше). Композиция в новом модуле — аддитивна. |
| Показать исход новой `process_instances`-строкой | Ломает FF-PACK-2 (8/8) → красный dev (§4). |
| Реальный live-вызов OpenAI в демо | Нарушает openai=$0; live-провод = deploy-time founder (RL-3). Stub детерминирован и достаточен. |
| Surface сырого reasoning в слайс (нагляднее) | Нарушает D-139 (no-reasoning-egress); surface только answer + opaque ref. |
| Новый React-экран под исход агента | T-0218 §5: новых экранов не вводим; переиспользуем audit. |
| Второй PDP/audit-канал под демо | Нарушает single-resolver / single-audit T-0233; переиспользуем runLegalPrecheck. |

---

## 7. Fitness-функции (что удостоверяем)

| id | проверка | плоскость |
|---|---|---|
| **FF-DEMO3-1** (новая, static, self-test) | `ci/checks/demo/demo3-legal-precheck.sh`: (a) demo-run-модуль зовёт `runLegalPrecheck` и инъектирует stub/dormant-порт (agent-is-S3-actor); (b) `role-intake-agent` гранты НЕ содержат `approve`/exec/invoke на transition (no-approve-grant moat); (c) demo-run-модуль НЕ делает сетевых вызовов (no-paid-LLM: нет `fetch(`/`new OpenAI`/`https.request`); (d) dealContext = T-0233-фикстура. Имеет `# SELF-TEST:` + `--self-test`. | static (в `fitness`) |
| AC-2/3/5/6 (vitest) | demo-run → proceed+red-flags (stub) / defer (dormant); slice-view S3 рендерится; D-139 нет сырого reasoning. | unit (vitest) |
| AC-4 (vitest) | `resolveFor(..., "approve")` для агента → denied (moat). | unit (vitest) |
| FF-PACK-2 (существующая, не ломать) | rights→8, processes→8. | static |
| FF-LP-2/3/4, precheck-no-* (существующие) | новый модуль их не нарушает (не run-precheck.ts, без сети, под legal-precheck/). | static |
| tsc/eslint/build | demo-run + audit-fixture типизированы, lint-clean. | static |

---

## 8. Трассируемость

- T-0218 §4.2 (слот legal_precheck S3, trigger ≥5млн, dealContext) → §3/§5.
- T-0218 FR-6 (moat S3→S4, PDP-deny) → §5.
- T-0218 FR-7 / D-139 (reasoning в audit, answer наружу) → §4 (opaque ref).
- T-0233 `runLegalPrecheck`/`StubLlmPort`/`InMemoryAuditWriter` → §3 (потребление).
- T-0233 fixture `DEMO_DEAL_CONTEXT`/`DEMO_CONTRACT_BODY`/`DEMO_PRECHECK_ANSWER` → §2/§4.
- review-note T-0218 (dealContext amount-only) → §2 (выбор service_agreement/outbound).
- FF-PACK-2 → §4 (audit-инстанс, не display-строка).
- grant-lattice `Operation."approve"` → §5 (moat выразим точечно).

## 9. Runtime target / эскалации

- **runtime_target:** dev-стенд showcase-тенанта (T-0141), кликабельный слайс
  (экран audit). Публичный стенд (T-0142) — Stage-2 founder-gated.
- **escalation:** нет founder-only форка. Единственное «под фаундера в будущем»
  — реальный live-провод LLM (OPENAI-ключ/среда, RL-3) для legal-precheck на
  проде; это deploy-time, НЕ блокер демо (день-1 использует stub/dormant).
- **touched_frozen:** false (потребляем T-0233, не правим).

## 10. adr_artifact_path

`docs/design/T-0234-legal-precheck-demo.adr.md`
