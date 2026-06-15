/**
 * seed/demo/tel-scenario.ts — T-0218 DEMO-1
 *
 * Executable representation of the first-demo scenario: ONE linear ТЭЛ
 * (straight-through, no cycles/exceptions) walked in 5 named screens, with two
 * agent slots (T-0219 intake on S2, T-0234 legal-precheck on S3) left as clean
 * markup for later tasks to build into.
 *
 * DESIGN-task scope: this module is the canonical, type-checked data shape of
 * the scenario (slots + demo actor-seed deltas + linear step list). It is
 * imported by scripts/demo-tel-walkthrough.ts which drives it THROUGH the
 * importer / public API (I-1, T-0140) — NOT direct PG.
 *
 * This module is pure data + types: zero pg / src/db / network imports.
 * The agent SKILLS are NOT built here (T-0219 / T-0234) — only their SLOTS.
 */
// ---------------------------------------------------------------------------
// ТЭЛ threshold (reference-tel §1.4) — ≥ 5M₽ requires legal review.
// Aligned with T-0233 DEMO_DEAL_CONTEXT.amount (5_500_000).
// ---------------------------------------------------------------------------
export const TEL_LEGAL_THRESHOLD_RUB = 5_000_000;
export const INTAKE_SLOT = {
    id: "intake",
    screen: "S2",
    built_by: "T-0219",
    actor: "intake-agent (role-intake-agent, персона a-intake)",
    consumes: ["subject", "amount", "justification", "requester"],
    produces: ["category", "budget_article", "direction", "route"],
    reasoning_surface: "reasoning-trace «почему категория=X, почему сумма≥порога→финконтролёр, почему статья=BUD-14»; наружу answer+метаданные, raw reasoning в audit (D-139)",
    outcomes: ["proceed", "defer-to-human", "fail-closed"],
};
export const LEGAL_PRECHECK_SLOT = {
    id: "legal_precheck",
    screen: "S3",
    built_by: "T-0234",
    actor: "legal-precheck agent (живой мотор T-0233 runLegalPrecheck)",
    // Exact signature of runLegalPrecheck dealContext (src/runtime/legal-precheck/run-precheck.ts).
    consumes: ["dealContext.amount", "dealContext.kind", "dealContext.direction", "document"],
    produces: ["PrecheckOutcome(proceed|defer-to-human|fail-closed)"],
    reasoning_surface: "reasoning во внутренний audit под T-0139-маскированием (мотор уже делает это, T-0233 FR-6); наружу answer (red-flags)+метаданные",
    outcomes: ["proceed", "defer-to-human", "fail-closed"],
    trigger: `intake.amount >= ${TEL_LEGAL_THRESHOLD_RUB} (ТЭЛ §1.4)`,
    engine: "src/runtime/legal-precheck/run-precheck.ts :: runLegalPrecheck (T-0233, уже смержен)",
};
export const AGENT_SLOTS = [INTAKE_SLOT, LEGAL_PRECHECK_SLOT];
export const DEMO_SCREENS = [
    {
        id: "S1",
        title: "Подача",
        slice: "forms (FormViewer)",
        persona: "e-orlov",
        shows: "Форма заявки: предмет, сумма, обоснование; серверная валидация",
        proof: "сцена-подготовка",
    },
    {
        id: "S2",
        title: "Триаж",
        slice: "inbox / карточка",
        persona: "a-intake",
        shows: "Агент заполнил категорию/статью/направление/маршрут; reasoning-trace «почему»",
        proof: "Доказ.1 (агент делает работу) + reasoning-trace",
        slot: "intake",
    },
    {
        id: "S3",
        title: "Юр-предпроверка",
        slice: "inbox / карточка",
        persona: "legal-precheck agent",
        shows: "При сумме ≥ 5 млн агент выдаёт red-flags до юротдела; moat: попытка агента «Согласовать» → PDP-deny",
        proof: "Доказ.2 (moat) + reasoning-trace",
        slot: "legal_precheck",
    },
    {
        id: "S4",
        title: "Согласование",
        slice: "processes / карточка",
        persona: "e-larina",
        shows: "Человек жмёт «Согласовать» (card action = transition + грант + audit)",
        proof: "card action + человек-гейт",
    },
    {
        id: "S5",
        title: "Аудит-floor",
        slice: "audit",
        persona: "e-owner",
        shows: "Вся цепочка (intake + legal-precheck + люди), tamper-evident; reasoning агентов в audit_event",
        proof: "аудит-floor (T-0139)",
    },
];
/** Role for the intake-agent. NO approve grant (moat). */
export const DEMO_ROLE_INTAKE = {
    slug: "role-intake-agent",
    display_name: "Агент-классификатор заявок",
    description: "Читает заявку, заполняет классификацию/маршрут. НЕ может approve (moat structural).",
};
/** The intake agent staff unit. */
export const DEMO_EMPLOYEE_INTAKE = {
    slug: "a-intake",
    display_name: "Заявка-агент",
    kind: "agent",
    position_slug: "fin-ctrl",
};
/**
 * Grants for role-intake-agent: read the request, write the classification.
 * Deliberately NO {operation:"exec"|"invoke"} on the approve transition —
 * the agent cannot self-approve (moat, FR-6 / S3→S4).
 */
export const DEMO_GRANTS_INTAKE = [
    {
        role_slug: "role-intake-agent",
        resource_type: "request",
        operation: "read",
        scope: { skill: "intake" },
        delegable: false,
    },
    {
        role_slug: "role-intake-agent",
        resource_type: "request-classification",
        operation: "update",
        scope: { skill: "intake" },
        delegable: false,
    },
];
// ---------------------------------------------------------------------------
// Demo deal (the linear ТЭЛ instance payload) — ≥ 5M₽ so BOTH slots fire.
// Aligned with T-0233 DEMO_DEAL_CONTEXT. Fictional fixture (NF-5), not real
// client data.
// ---------------------------------------------------------------------------
export const DEMO_DEAL = {
    subject: "Закупка лицензий ПО для отдела ИТ (годовая)",
    amount: 5_500_000,
    justification: "Продление корпоративных лицензий, истекают 30.06.2026",
    requester: "e-orlov",
    // Produced by S2 intake (shown here as the expected triage output):
    category: "it_expense",
    budget_article: "BUD-14",
    direction: "buy",
};
/** dealContext exactly as runLegalPrecheck (T-0233) expects it. */
export const DEMO_DEAL_CONTEXT = {
    amount: DEMO_DEAL.amount,
    kind: DEMO_DEAL.category,
    direction: DEMO_DEAL.direction,
};
/** Does the legal-precheck gate (S3) fire for this deal? (ТЭЛ §1.4) */
export function legalGateFires(amount) {
    return amount >= TEL_LEGAL_THRESHOLD_RUB;
}
