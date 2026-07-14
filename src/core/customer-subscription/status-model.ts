/**
 * src/core/customer-subscription/status-model.ts — T-0244 B-1
 *
 * Pure status-machine for the "customer-subscription" registry (dogfood CRM).
 * PURE: no pg / http / fetch / fs / env. IO-free.
 *
 * Consumed by:
 *  - defaultCardActions (T-0125) to generate guarded-transition buttons.
 *  - runIssueKey (src/runtime/customer-onboarding/issue-key.ts) for the
 *    guarded transition to "active" after key issuance.
 *
 * FF-2: CustomerStatus enum == record_schema status enum (grep-fence in
 *   ci/checks/vendor-crm-seed-idempotent.sh).
 * FF-3: availableTransitions / isAllowedTransition cover ALL states; archived
 *   is terminal (returns []).
 *
 * NOTE: no reference to activation / entitlement / not_after / verifyKey on
 * code lines — this file is in src/core/ and is guarded by
 * ci/checks/no-killswitch-in-core.sh. The word "entitlement" appears only in
 * this comment, which the check's code_lines() filter strips.
 */

// ---------------------------------------------------------------------------
// Status type (AC-3 / FF-2)
// ---------------------------------------------------------------------------

/** Closed set — mirrors the `status` enum in seed/vendor-crm/customer-subscription.schema.json. */
export type CustomerStatus =
  | "draft"
  | "trial"
  | "active"
  | "expired"
  | "custom"
  | "archived";

export const CUSTOMER_STATUS_VALUES: ReadonlyArray<CustomerStatus> = [
  "draft",
  "trial",
  "active",
  "expired",
  "custom",
  "archived",
];

export function isCustomerStatus(v: unknown): v is CustomerStatus {
  return CUSTOMER_STATUS_VALUES.includes(v as CustomerStatus);
}

// ---------------------------------------------------------------------------
// Transition table (FF-3 / AC-4 / AC-5)
// ---------------------------------------------------------------------------

/**
 * Closed map of allowed guarded transitions.
 * archived = terminal (empty array, AC-5).
 */
export const CUSTOMER_TRANSITIONS: Readonly<Record<CustomerStatus, readonly CustomerStatus[]>> = {
  draft:    ["trial", "active", "archived"],
  trial:    ["active", "expired", "custom", "archived"],
  active:   ["expired", "custom", "archived"],
  expired:  ["active", "custom", "archived"],
  custom:   ["active", "expired", "archived"],
  archived: [],
};

// ---------------------------------------------------------------------------
// AvailableTransition shape (mirrors card-action.ts AvailableTransition)
// ---------------------------------------------------------------------------

export interface AvailableTransition {
  readonly id: string;
  readonly label: string;
  readonly bindings?: readonly never[];
}

/** Human-readable labels for each target status. */
const TRANSITION_LABELS: Readonly<Record<CustomerStatus, string>> = {
  draft:    "В черновик",
  trial:    "Начать пилот",
  active:   "Активировать",
  expired:  "Пометить истёкшей",
  custom:   "Индивидуальный режим",
  archived: "Архивировать",
};

/**
 * Returns the guarded transitions available from the current status.
 * Feeds defaultCardActions(recordHandle, availableTransitions(status), bound).
 * archived ⇒ [] (terminal, AC-5).
 */
export function availableTransitions(current: CustomerStatus): readonly AvailableTransition[] {
  const targets = CUSTOMER_TRANSITIONS[current];
  return targets.map((target) => ({
    id: `to_${target}`,
    label: TRANSITION_LABELS[target],
    bindings: [],
  }));
}

/**
 * Total predicate: is the transition from→to in the allowed set?
 * Used by runIssueKey before writing the guarded transition.
 */
export function isAllowedTransition(from: CustomerStatus, to: CustomerStatus): boolean {
  return (CUSTOMER_TRANSITIONS[from] as readonly string[]).includes(to);
}
