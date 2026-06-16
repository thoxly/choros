# T-0234 · DEMO-3 — Юр-предпроверка договора агентом в линейном ТЭЛ-демо (SPEC)

> Тип: impl · spec_ref: `playbooks/v1-demo-and-trust-surface.md#A` (Доказ. 2 — moat)
> depends_on: T-0233 (DONE — живой мотор `runLegalPrecheck`) · T-0218 (DONE —
> сценарий демо + слот S3) · T-0141 (DONE — демо-тенант)
> Контракт сценария: `docs/specs/T-0218-demo-1-scenario.spec.md` (FR-5/FR-6/FR-7),
> `docs/design/T-0218-demo-1-scenario.adr.md` §4.2 — **не пере-решаем сценарий**.

## 0. Что эта спека фиксирует

Машинно-проверяемые приёмочные критерии **третьего демо-акта (DEMO-3)**: на
**S3 «Юр-предпроверка»** упрощённого линейного ТЭЛ-демо (T-0218) роль человека
**заменяет агент** — живой мотор `runLegalPrecheck` (T-0233). Агент **производит
исход предпроверки** (`PrecheckOutcome`: proceed / defer-to-human / fail-closed)
и **не может согласовать** (нет гранта `approve` — moat); исход и
reasoning-trace **видны фаундеру в кликабельном слайсе**. Прогон
**детерминирован, без платных LLM** (stub-порт T-0233, openai=$0).

Это **impl-задача**, вписывающая навык в РАЗМЕЧЕННЫЙ T-0218 слот
`agent_slot.legal_precheck` (S3). Сам мотор уже смержен (T-0233) — мы его
**потребляем** через инъектируемый порт, ничего во frozen-ядре не правим.

## 1. Решение по dealContext (review-note T-0218: выбрать ОДИН)

**Выбран `{ amount: 5_500_000, kind: "service_agreement", direction: "outbound" }`**
— ровно фикстура T-0233 (`src/__tests__/fixtures/demo-legal-precheck-contract.ts`
`DEMO_DEAL_CONTEXT`). Обоснование:

- Это **единственная** dealContext, под которую у T-0233 есть **тело договора**
  (`DEMO_CONTRACT_BODY` — договор оказания услуг №2026-TEL-0042 с клаузулами
  §4.2/§7.1/§11.3) и **детерминированный ожидаемый ответ** (`DEMO_PRECHECK_ANSWER`,
  3 red-flags). Без него юр-предпроверке нечего анализировать — red-flags
  взялись бы из ниоткуда.
- Договор оказания услуг (outbound) — это **закупка услуги** = подмножество
  домена «заявка на расход/закупку» (T-0218 §2), не уводит из ТЭЛ-эталона.
- review-note T-0218 (S3) предписывал: «align with T-0233's fixture unless the
  expense scenario truly needs otherwise». Расходный сценарий ничего не требует
  иного (тело договора у него отсутствует) → выравниваем на T-0233.

`seed/demo/tel-scenario.ts` правится **только в S3/legal-precheck-секции**
(`DEMO_DEAL.kind/direction/subject`, `DEMO_DEAL_CONTEXT`, S3-комментарий) —
секция S2/intake (T-0219, параллельная) НЕ трогается; правки аддитивны.

## 2. Функциональные требования

- **FR-1.** На S3 актором является **агент** `runLegalPrecheck` (мотор T-0233),
  а не человек. Демо-прогон вызывает мотор с инъектированным **stub-портом** и
  детерминированными in-memory-зависимостями (PDP allow + InMemoryAuditWriter),
  без БД и без сети.
- **FR-2.** Агент **производит** `PrecheckOutcome`. Для demo-deal (контракт
  ≥5млн с red-flags + live-сконфигурированный stub) исход = **proceed** с
  `answer` (3 red-flags по форме `legal_precheck_v1`). Dormant-вариант
  (liveEnabled=false) детерминированно даёт **defer-to-human(dormant)**.
- **FR-3 (moat).** Агент **не может approve**. Роль `role-intake-agent` (она же
  актор S2/S3 на демо) **не имеет** гранта `approve`/transition; попытка
  агента перейти «Согласовано» → **PDP-deny**, выразимо через
  `src/core/card-action.ts`. Approve остаётся человеческим card-action (S4).
- **FR-4 (видимость в слайсе).** Исход агента + reasoning-trace surface видны в
  кликабельном слайсе: добавляется **демо-аудит-инстанс ТЭЛ** (`INS-TEL-DEMO`)
  в read-API `/api/audit/:instanceId` (in-memory fixture в `src/http/audit.ts`),
  чей S3-узел рендерит **фактический** исход `runLegalPrecheck` (red-flags +
  безопасные метаданные + masked reasoning-trace-ref), вычисленный демо-модулем.
  Новых React-экранов нет (T-0218 §5) — переиспользуется экран audit слайса.
- **FR-5 (D-139).** Наружу/в слайс уходит **только** `answer` (red-flags +
  summary) + безопасные метаданные + **opaque** `reasoning_trace_ref`. Сырой
  reasoning НЕ surfaced (он лишь во внутреннем audit-payload, как делает мотор).
  Никакого нового egress-канала.
- **FR-6 (no paid LLM).** Демо-прогон использует **stub-порт** T-0233
  (`StubLlmPort`) или dormant-порт. Ни одного `fetch`/SDK-вызова к OpenAI.
  CI/dev = openai $0. Реальный live-провод (OPENAI-ключ) = deploy-time за
  фаундером (RL-3), НЕ часть демо.
- **FR-7 (один аудит-сток / один PDP).** Демо-прогон НЕ вводит второй резолвер
  / вторую audit-таблицу / второй LLM-канал — он переиспользует
  `runLegalPrecheck`, который уже зовёт единственный `resolveFor` (T-0021) и
  единственный `appendAuditEvent` (T-0016).
- **FR-8 (идемпотентность/lint).** Демо-модуль типизирован (tsc), lint-clean,
  детерминирован (один и тот же исход на повторном вызове — NF-6 T-0233).

## 3. Нефункциональные требования

- **NF-1.** Ни один байт-frozen security-файл не тронут (`touched_frozen=false`):
  не правим grant-lattice / object-handle / frozen-checks / ядро мотора T-0233
  (`run-precheck.ts`, `agent-precheck-motor.ts`, `llm-port.ts`). Потребляем их.
- **NF-2.** dev остаётся ЗЕЛЁНЫМ: FF-PACK-2 (8 rights / 8 processes) не ломается
  — мы добавляем **аудит-инстанс**, не `process_instances`/`rights_cards`-строку.
- **NF-3.** Роль/гранты агента seed-ятся через importer/публичный API
  (T-0218 §6.2 уже завёл `role-intake-agent` без approve в
  `seed/demo/tel-scenario.ts`), НЕ прямым PG. T-0234 потребляет ту же роль.
- **NF-4.** Детерминизм: demo-run даёт байт-идентичный исход на повторе
  (NF-6 T-0233) — surface в слайсе воспроизводим.
- **NF-5.** dealContext = T-0233-фикстура (§1) — согласован порог ≥5млн₽
  (ТЭЛ §1.4).

## 4. Acceptance criteria (machine-checkable где возможно)

| id | критерий | verifiable_as |
|----|----------|---------------|
| AC-1 | SPEC + ADR + pr-handoff присутствуют и валидны по контракту (`docs/specs/T-0234*`, `docs/design/T-0234*`). | fitness (FF-DEMO3-1) |
| AC-2 | Демо-прогон вызывает `runLegalPrecheck` со stub-портом и даёт **proceed** + ≥1 red-flag (форма `legal_precheck_v1`) для demo-deal ≥5млн₽; ноль сетевых вызовов. | vitest |
| AC-3 | Тот же demo-run при `liveEnabled=false` даёт **defer-to-human(dormant)**, НЕ proceed (INV-DEFAULT). | vitest |
| AC-4 | **Moat:** роль `role-intake-agent` НЕ имеет гранта `approve`/exec/invoke на transition; demo-run + card-action PDP отказывает агенту в approve. | vitest |
| AC-5 | Исход + reasoning-trace-ref агента видны в слайсе: `GET /api/audit/INS-TEL-DEMO` возвращает трейс с S3-узлом legal-precheck (red-flags + masked trace-ref). | vitest |
| AC-6 | **D-139:** сериализованный slice-view S3 НЕ содержит сырого reasoning (нет полей `reasoning`/`chainOfThought`/`raw`/`trace` с текстом chain-of-thought) — только answer + opaque ref. | vitest |
| AC-7 | dealContext демо = `{5_500_000, "service_agreement", "outbound"}` единообразно в `seed/demo/tel-scenario.ts` И демо-модуле (выровнено с T-0233). | vitest/grep |
| AC-8 | `touched_frozen=false` — frozen-ядро T-0233 и security-файлы не правлены. | review |
| AC-9 | Новая статическая fitness-проверка FF-DEMO3-1 (`ci/checks/demo/demo3-legal-precheck.sh`) имеет `# SELF-TEST:` и `--self-test` ветку; ассертит agent-is-S3-actor + no-approve-grant + no-paid-LLM-в-демо. | fitness |
| AC-10 | FF-PACK-2 остаётся 8/8 — display-плоскость не раздута. | fitness |
| AC-11 | `tsc --noEmit` exit 0; `eslint src` clean; `npm run build` ok; `npm run fitness` зелёный (статические); `vitest run` зелёный. | fitness |

## 5. Out of scope

- Реальный live-провод OpenAI для legal-precheck (deploy-time, RL-3, founder-gated).
- Навык S2 intake-агента (T-0219, параллельная задача — её правки в
  `tel-scenario.ts` аддитивны к нашим).
- Полная БД-исполнимость демо-инстанса в `process_instances` (демо показывает
  исход через audit read-API; БД-наполнение инстанса = seed-apply-smoke, infra).
- Публичный демостенд / деплой (T-0142, founder-gated).
- Новый UI-экран — переиспользуем экран audit слайса (T-0218 §5).

## 6. spec_artifact_path

`docs/specs/T-0234-legal-precheck-demo.spec.md`
