/**
 * src/runtime/intake/classify-intake.ts — T-0219 DEMO-2 intake-agent classifier.
 *
 * The deterministic DEMONSTRATOR of the intake-agent skill for the S2 «Триаж»
 * slot. Given a submitted request it produces { category, budget_article,
 * direction, route } + a structured reasoning-trace.
 *
 * WHY DETERMINISTIC (not a live LLM): this run is openai=$0 — no paid LLM. The
 * live inference path is deploy-time (the agent_card is seeded DORMANT, llm_*
 * NULL). This pure function shows WHAT the agent produces, deterministically
 * (demo-deal → stable output), so the demo + tests run with zero network.
 *
 * PURE: zero pg / src/db / network / fetch / process.env / competence-instruction
 * table read. It does NOT touch the runtime-dormant allowlist (that narrow gate
 * admits only src/runtime/legal-precheck/). The classifier rules are the seed
 * instruction's content (data); this module is the demo computation.
 *
 * D-139: `answer` is the safe external form; `reasoning_trace` is in-process
 * structured «why» (claim + basis, never chain-of-thought verbatim) — it stays
 * inside the boundary, never egresses to an external API.
 */

import type {
  IntakeApprover,
  IntakeCategory,
  IntakeClassification,
  IntakeInput,
  IntakeReasoningStep,
  IntakeRoute,
} from "./intake-types.js";

// ---------------------------------------------------------------------------
// ТЭЛ threshold (reference-tel §1.4) — ≥ 5M₽ requires legal review.
// Canonical in src; seed/demo/tel-scenario.ts mirrors it as TEL_LEGAL_THRESHOLD_RUB
// (both === 5_000_000). src cannot import seed/ (rootDir=src), so the value is
// declared in both places and kept in sync manually; the boundary tests pin this
// value independently (4_999_999 / 5_000_000 / 5_500_000), so any drift between
// the two copies surfaces as a test failure rather than passing silently.
// ---------------------------------------------------------------------------

export const TEL_LEGAL_THRESHOLD_RUB = 5_000_000 as const;

// ---------------------------------------------------------------------------
// Demo category dictionary (the instruction_meta справочник, demo-grade).
// category → budget_article.  Deterministic keyword routing.
// ---------------------------------------------------------------------------

const CATEGORY_ARTICLE: Readonly<Record<IntakeCategory, string>> = {
  it_expense: "BUD-14",
  aho: "BUD-21",
  marketing: "BUD-33",
};

/** Keyword sets (lowercased) per category — first match wins, deterministic order. */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [IntakeCategory, readonly string[]]> = [
  ["it_expense", ["лиценз", "по ", "софт", "software", "сервер", "облач", "saas", "it", "ит"]],
  ["aho", ["канцел", "мебел", "ремонт", "уборк", "ахо", "хозяйств"]],
  ["marketing", ["реклам", "маркетинг", "promo", "промо", "бренд", "smm"]],
];

/**
 * Deterministic category classification by keyword scan over subject+justification.
 * Falls back to it_expense (the demo-deal domain) when no keyword matches — the
 * fallback is recorded honestly in the reasoning-trace basis.
 */
function classifyCategory(input: IntakeInput): { category: IntakeCategory; matched: string | null } {
  const haystack = `${input.subject} ${input.justification}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        return { category, matched: kw };
      }
    }
  }
  return { category: "it_expense", matched: null };
}

// ---------------------------------------------------------------------------
// Route builder — the typed answer to «route = prose» (ADR §2).
// ---------------------------------------------------------------------------

/**
 * Build the typed route from amount (deterministic, ТЭЛ §1.4):
 *   - always fin_controller (any spend passes financial control);
 *   - amount ≥ threshold → add legal (ТЭЛ §1.4 mandatory legal) then cfo.
 *
 * `legal_required` === (amount ≥ TEL_LEGAL_THRESHOLD_RUB) — the load-bearing
 * S2→S3 link (≡ legalGateFires(amount) ≡ legal-precheck slot trigger, T-0234).
 */
export function buildIntakeRoute(amount: number): IntakeRoute {
  const legalRequired = amount >= TEL_LEGAL_THRESHOLD_RUB;

  const steps: IntakeApprover[] = [
    {
      order: 1,
      role: "fin_controller",
      reason: "любой расход проходит финансовый контроль",
      mandatory: true,
    },
  ];

  if (legalRequired) {
    steps.push({
      order: 2,
      role: "legal",
      reason: `сумма ${amount}₽ ≥ порога ${TEL_LEGAL_THRESHOLD_RUB}₽ → обязателен юротдел (ТЭЛ §1.4)`,
      mandatory: true,
    });
    steps.push({
      order: 3,
      role: "cfo",
      reason: "крупная сумма → обязателен финдиректор",
      mandatory: true,
    });
  }

  return {
    steps,
    legal_required: legalRequired,
    approver_chain: steps.map((s) => s.role),
  };
}

// ---------------------------------------------------------------------------
// classifyIntake — the demonstrator entry point.
// ---------------------------------------------------------------------------

/**
 * Classify a submitted request deterministically (the S2 demonstrator).
 *
 * Returns the safe external `answer` (answer_form=intake_triage_v1) + an
 * in-process structured `reasoning_trace`. The agent classifies/triages — it
 * never approves (the role has NO approve grant; moat is structural, FR-6).
 */
export function classifyIntake(input: IntakeInput): IntakeClassification {
  const { category, matched } = classifyCategory(input);
  const budgetArticle = CATEGORY_ARTICLE[category];
  const direction: "buy" | "sell" = "buy"; // demo domain: spend/procurement = buy
  const route = buildIntakeRoute(input.amount);

  const trace: IntakeReasoningStep[] = [
    {
      claim: `category=${category}`,
      basis:
        matched != null
          ? `ключевое слово '${matched}' в предмете/обосновании`
          : "нет совпадения ключевых слов → fallback it_expense (демо-домен)",
    },
    {
      claim: `budget_article=${budgetArticle}`,
      basis: `справочник category→статья: ${category}→${budgetArticle}`,
    },
    {
      claim: `direction=${direction}`,
      basis: "домен demo = заявка на расход/закупку (buy)",
    },
    {
      claim: `route.legal_required=${route.legal_required}`,
      basis: route.legal_required
        ? `сумма ${input.amount}₽ ≥ порога ${TEL_LEGAL_THRESHOLD_RUB}₽ → +legal,+cfo (ТЭЛ §1.4)`
        : `сумма ${input.amount}₽ < порога ${TEL_LEGAL_THRESHOLD_RUB}₽ → legal не обязателен`,
    },
    {
      claim: `approver_chain=[${route.approver_chain.join(", ")}]`,
      basis: "выведено детерминированно из суммы и категории",
    },
  ];

  return {
    answer: { category, budget_article: budgetArticle, direction, route },
    reasoning_trace: trace,
    answer_form: "intake_triage_v1",
  };
}
