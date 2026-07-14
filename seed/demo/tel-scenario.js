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
// Aligned with T-0233 DEMO_DEAL_CONTEXT (5_500_000, service_agreement, outbound).
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
/**
 * agent_card for a-intake — DORMANT by design (T-0219 FR-1): all llm_* NULL so the
 * runtime makes no network call (T-0233 FR-7 dormant gate) → ZERO paid LLM.
 */
export const DEMO_AGENT_CARD_INTAKE = {
    employee_slug: "a-intake",
    kc_client_id: "agent-intake",
    llm_endpoint: null,
    llm_model: null,
    llm_secret_handle: null,
    autonomy_threshold: null,
};
/** answer_form code for the intake-agent classifier output (T-0123). */
export const INTAKE_ANSWER_FORM = "intake_triage_v1";
/**
 * Classifier instruction for the intake-agent (T-0219 FR-3), seeded DRAFT-FIRST.
 * The competence text the agent applies at S2; the deterministic demonstrator is
 * src/runtime/intake/classify-intake.ts (this is the seed data side of T-0123).
 */
export const DEMO_INTAKE_INSTRUCTION = {
    employee_slug: "a-intake",
    tier: "draft",
    instruction_text: [
        "Вы — агент-классификатор заявок на расход/закупку (триаж, шаг S2 ТЭЛ).",
        "По поданной заявке (предмет, сумма, обоснование, инициатор) определите:",
        "1. Категорию: it_expense / aho / marketing (по ключевым словам предмета/обоснования).",
        "2. Бюджетную статью по справочнику категория→статья (it_expense→BUD-14, aho→BUD-21, marketing→BUD-33).",
        "3. Направление: для заявок на расход/закупку — buy.",
        "4. Маршрут согласования: всегда финконтролёр; при сумме ≥ 5 000 000 ₽ —",
        "   обязательны юротдел и финдиректор (порог ТЭЛ §1.4).",
        "Дайте reasoning-trace (почему категория/статья/маршрут). НЕ согласовывайте",
        "заявку — у вас нет права approve (это решение человека на шаге S4).",
        "Отвечайте строго в формате answer_form.",
    ].join("\n"),
    answer_form: INTAKE_ANSWER_FORM,
    instruction_meta: {
        category_article: { it_expense: "BUD-14", aho: "BUD-21", marketing: "BUD-33" },
        legal_threshold_rub: TEL_LEGAL_THRESHOLD_RUB,
    },
};
// ---------------------------------------------------------------------------
// Demo deal (the linear ТЭЛ instance payload) — ≥ 5M₽ so BOTH slots fire.
// dealContext aligned EXACTLY with T-0233 DEMO_DEAL_CONTEXT
// (src/__tests__/fixtures/demo-legal-precheck-contract.ts):
//   { amount: 5_500_000, kind: "service_agreement", direction: "outbound" }.
// This is the only dealContext T-0233 ships a contract body (DEMO_CONTRACT_BODY)
// AND a deterministic expected answer (DEMO_PRECHECK_ANSWER, 3 red flags) for, so
// the S3 legal-precheck has real clauses to flag. A договор оказания услуг
// (outbound service contract) is a procurement/expense ТЭЛ — a subset of the
// "заявка на расход/закупку" domain (T-0218 §2), not a different class.
// Closes T-0218 review-note (the slot comment was previously amount-only and the
// kind/direction (it_expense/buy) diverged from T-0233). Fictional fixture
// (NF-5), not real client data. [T-0234 S3-slot edit]
// ---------------------------------------------------------------------------
export const DEMO_DEAL = {
    subject: "Договор оказания услуг по разработке ПО (годовой)",
    amount: 5_500_000,
    justification: "Закупка услуг внешней разработки, контракт на 12 месяцев",
    requester: "e-orlov",
    // Produced by S2 intake (shown here as the expected triage output):
    category: "service_agreement",
    budget_article: "BUD-14",
    direction: "outbound",
};
/**
 * dealContext exactly as runLegalPrecheck (T-0233) expects it — and exactly
 * T-0233's DEMO_DEAL_CONTEXT { 5_500_000, "service_agreement", "outbound" }.
 */
export const DEMO_DEAL_CONTEXT = {
    amount: DEMO_DEAL.amount,
    kind: DEMO_DEAL.category,
    direction: DEMO_DEAL.direction,
};
/** Does the legal-precheck gate (S3) fire for this deal? (ТЭЛ §1.4) */
export function legalGateFires(amount) {
    return amount >= TEL_LEGAL_THRESHOLD_RUB;
}
