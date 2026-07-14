/**
 * src/__tests__/fixtures/demo-legal-precheck-contract.ts — T-0233 AC-15.
 *
 * Demo contract fixture for the legal_precheck skill (TEL §1/§3, amount ≥ 5M₽).
 *
 * Used by:
 *   - stub-llm-port.ts (via DEMO_PRECHECK_ANSWER)
 *   - run-precheck.test.ts (DEMO_DEAL deal context)
 *   - precheck-secret-custody / legal-precheck-unpark-narrow fitness checks
 *
 * This is a FICTIONAL contract for testing purposes only — not real client data (NF-5).
 * The fixture is demo-tenant scoped (T-0141 demo tenant concept).
 */

/** Demo deal context: service agreement ≥ 5M₽ (TEL §1/§3 trigger). */
export const DEMO_DEAL_CONTEXT = {
  amount: 5_500_000,        // ≥ 5M₽ trigger threshold
  kind: "service_agreement",
  direction: "outbound",
} as const;

/** Fiction contract body for the demo tenant legal precheck fixture. */
export const DEMO_CONTRACT_BODY = `
ДОГОВОР ОКАЗАНИЯ УСЛУГ №2026-TEL-0042
г. Москва, 15 июня 2026 г.

Стороны:
  Исполнитель: ООО «ДемоТех» (ИНН 7701234567)
  Заказчик:    ООО «ДемоКлиент» (ИНН 7709876543)

§1. ПРЕДМЕТ ДОГОВОРА
Исполнитель оказывает услуги по разработке программного обеспечения.
Общая стоимость: 5 500 000 (пять миллионов пятьсот тысяч) рублей.

§4. ОПЛАТА И РАСЧЁТЫ
§4.2. Заказчик вправе в одностороннем порядке перенести срок оплаты
      на 90 (девяносто) рабочих дней при уведомлении за 3 дня.

§7. ОТВЕТСТВЕННОСТЬ
§7.1. Совокупная ответственность Исполнителя ограничена 10% от стоимости договора.

§11. ПРОЧИЕ УСЛОВИЯ
§11.3. Споры разрешаются в Арбитражном суде г. Гааги (иностранная юрисдикция).

Договор составлен в 2 экземплярах.
`.trim();

/** Demo agent_instruction for the legal_precheck skill. */
export const DEMO_AGENT_INSTRUCTION = {
  instructionText: [
    "Вы — юридический аналитик по рискам договоров. Ваша задача:",
    "1. Определить проблемные клаузулы в предоставленном договоре.",
    "2. Оценить уровень риска каждой клаузулы (low/med/high).",
    "3. Дать краткое резюме по договору в целом.",
    "Отвечать строго в формате JSON answerForm.",
  ].join("\n"),
  answerForm: "legal_precheck_v1",
} as const;
