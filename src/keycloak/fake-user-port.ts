/**
 * src/keycloak/fake-user-port.ts — T-0342 (E14): In-memory Keycloak User port fake.
 *
 * InMemoryKeycloakUserPort implements KeycloakUserPort with an in-memory
 * capture log for unit tests. No live Keycloak required (mirrors fake-admin-port.ts pattern).
 *
 * Failure injection switches:
 *   failOnCreate   — createHumanUser throws EMAIL_TAKEN immediately
 *   failOnAuth     — createHumanUser throws AUTH_UNAVAILABLE (KC unreachable)
 *   failAfterCreate — createHumanUser succeeds but caller's DB then fails;
 *                     deleteUser is called for orphan cleanup (FF-2).
 *
 * FAKE-FIDELITY (T-0625 fix, narrowed by T-0628): a real Keycloak realm
 * REJECTS createHumanUser when `spec.email` is not a valid email address — it
 * returns 400 error-invalid-email, which the live adapter (admin-port.ts
 * makeHttpKeycloakUserPort) maps to EMAIL_INVALID. Before the T-0625 fix, this
 * fake did NOT validate the email shape at all, so
 * `createHumanUser({username: 'plain-login', email: 'plain-login', ...})`
 * succeeded here while a real KC realm would 400 — a fake/real fidelity gap
 * that let the T-0583 non-email-login regression (503 on the real stand) ship
 * green through unit tests (T-0625 LIVE_PROOF root cause). This fake enforces
 * the SAME email-format check the live port enforces on `spec.email`.
 *
 * T-0628 fix: the ORIGINAL T-0625 fake also required `spec.username` to be
 * email-shaped. That mirrored this codebase's OWN choice at the time (caller
 * passed the same value for both fields) — it is not a real Keycloak realm
 * constraint (config/keycloak/realm-choros.json sets no
 * registrationEmailAsUsername/email-only flag), and T-0628's own spec
 * requires `username`/`login` to stay free-form. This fake now validates
 * ONLY `spec.email`, matching the live port and a real KC realm.
 *
 * This file lives OUTSIDE src/core/ so the live adapter and the fake are both
 * injectable substitutes — neither bleeds into the pure core (FF-HIRE-6).
 */

import type { KeycloakUserPort, KcHumanUserSpec } from "./admin-port.js";

// Mirrors the RFC-lite check register.ts/user-mgmt.ts use (EMAIL_RE) — kept
// as an independent literal here (not imported) so this fake has zero
// dependency on src/core/ or src/http/ (FF-HIRE-6 isolation).
const FAKE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Capture types
// ---------------------------------------------------------------------------

export interface CapturedUser {
  spec: KcHumanUserSpec;
  userId: string;
  deleted: boolean;
  /** T-0583: current KC `enabled` flag — mutated by setUserEnabled. Starts true (created enabled). */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// InMemoryKeycloakUserPort
// ---------------------------------------------------------------------------

export class InMemoryKeycloakUserPort implements KeycloakUserPort {
  /** All createHumanUser calls, in order. */
  readonly created: CapturedUser[] = [];

  /** userId strings passed to deleteUser, in order. */
  readonly deleteCalls: string[] = [];

  /**
   * If true, the NEXT createHumanUser call throws EMAIL_TAKEN (409 scenario).
   * Resets to false after each failed call (one-shot).
   */
  failOnCreate = false;

  /**
   * T-0633 round-3: if true, the NEXT createHumanUser call throws LOGIN_TAKEN
   * (409 USERNAME conflict — distinct from EMAIL_TAKEN). Models a real KC 409
   * whose errorMessage names the username. One-shot.
   */
  failOnLoginTaken = false;

  /**
   * If true, the NEXT createHumanUser call throws AUTH_UNAVAILABLE (KC unreachable).
   * Resets to false after each failed call (one-shot).
   */
  failOnAuth = false;

  /**
   * T-0748: if true, the NEXT createHumanUser call throws
   * NAME_INVALID_CHARACTERS — models a real KC 400 whose body carries a
   * firstName/lastName `person-name-prohibited-characters` validator failure
   * (e.g. displayName="Bot #1"/"A&B", see admin-port.ts
   * isPersonNameCharacterError). One-shot, mirrors failOnLoginTaken.
   */
  failOnNameInvalid = false;

  /** Counter incremented on each call — useful for asserting call count. */
  createCallCount = 0;

  /** Counter incremented on each deleteUser call. */
  deleteCallCount = 0;

  /** T-0583: userId args passed to setUserEnabled, in order (call-count assertions). */
  readonly setEnabledCalls: Array<{ userId: string; enabled: boolean }> = [];

  /** T-0583: counter incremented on each setUserEnabled call. */
  setEnabledCallCount = 0;

  /**
   * T-0583: if true, the NEXT setUserEnabled call throws AUTH_UNAVAILABLE
   * (KC unreachable during a deactivate/reactivate attempt). One-shot.
   */
  failOnSetEnabled = false;

  /** T-0702: userId args passed to revokeUserSessions, in order. */
  readonly revokeSessionsCalls: string[] = [];

  /** T-0702: counter incremented on each revokeUserSessions call. */
  revokeSessionsCallCount = 0;

  /**
   * T-0702: if true, the NEXT revokeUserSessions call degrades to
   * {revoked:false} (models KC being unreachable for THAT specific call —
   * mirrors the live port's never-throw contract, so this switch does NOT
   * make the fake throw; it makes it return the degraded outcome). One-shot.
   */
  failOnRevokeSessions = false;

  async createHumanUser(spec: KcHumanUserSpec): Promise<{ userId: string }> {
    this.createCallCount++;

    // T-0625 fix (fake-fidelity), narrowed by T-0628: a real KC realm
    // validates the REQUEST BODY SHAPE (is `email` a valid email?) before it
    // ever gets to per-realm-state outcomes like "already taken" or being
    // unreachable. This check runs FIRST, unconditionally — NOT gated by the
    // failOnCreate/failOnAuth one-shot switches below — so a caller passing a
    // non-email `email` is rejected the same way regardless of what other
    // failure the test also armed, matching a real Keycloak realm's own
    // request-validation-before-state-check ordering. T-0628: `username` is
    // NOT checked here — a real KC realm (this product's realm config) does
    // not require the username to be email-shaped, and callers may now pass a
    // free-form login distinct from email.
    if (!FAKE_EMAIL_RE.test(spec.email)) {
      const err = new Error("EMAIL_INVALID");
      (err as NodeJS.ErrnoException).code = "EMAIL_INVALID";
      throw err;
    }

    // T-0748 (fake-fidelity): a real KC realm's declarative user-profile
    // validates firstName/lastName's characters (person-name-prohibited-
    // characters, realm-choros.json) in the SAME structural pass as the
    // email-format check above — before any state-based outcome. This is a
    // test-controlled switch rather than a re-implementation of KC's
    // person-name regex (that would risk drifting from the real validator;
    // admin-port.ts's own doc says KC itself is the authority on legal
    // characters, not this codebase).
    if (this.failOnNameInvalid) {
      this.failOnNameInvalid = false;
      const err = new Error("NAME_INVALID_CHARACTERS");
      (err as NodeJS.ErrnoException).code = "NAME_INVALID_CHARACTERS";
      throw err;
    }

    if (this.failOnAuth) {
      this.failOnAuth = false;
      const err = new Error("AUTH_UNAVAILABLE");
      (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
      throw err;
    }
    if (this.failOnLoginTaken) {
      this.failOnLoginTaken = false;
      const err = new Error("LOGIN_TAKEN");
      (err as NodeJS.ErrnoException).code = "LOGIN_TAKEN";
      throw err;
    }
    if (this.failOnCreate) {
      this.failOnCreate = false;
      const err = new Error("EMAIL_TAKEN");
      (err as NodeJS.ErrnoException).code = "EMAIL_TAKEN";
      throw err;
    }

    // FAKE-FIDELITY (T-0633 round-3): a real Keycloak 25.0.6 LOWERCASES a
    // username at creation (proven live). Before this, the fake captured
    // `spec.username` verbatim — so a mixed-case username stored 'E-Config'
    // here while a real KC realm would store 'e-config'. That fidelity gap is
    // exactly what let the case-collision privilege-escalation slip past unit
    // tests: the production anti-collision guard could pass a mixed-case login
    // (byte-exact SQL miss) that a real KC then folded into a seed-persona
    // slug, and no fake-backed test could observe the fold. The fake now folds
    // `username` to lowercase in the CAPTURED spec, matching real KC, so
    // (a) any future regression that removes the production case-normalization
    // is caught by a test asserting the captured username, and (b) the
    // deterministic userId derives from the same folded form. `email` is left
    // as-passed (a real KC realm preserves the email attribute's case even
    // while folding the username — the two are distinct fields).
    const foldedUsername = spec.username.toLowerCase();
    const captured: KcHumanUserSpec = { ...spec, username: foldedUsername };

    // Generate a deterministic fake KC UUID from the (folded) username
    const userId = `kc-user-${this.created.length + 1}-${foldedUsername.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 64);
    const entry: CapturedUser = { spec: captured, userId, deleted: false, enabled: true };
    this.created.push(entry);
    return { userId };
  }

  async deleteUser(userId: string): Promise<void> {
    this.deleteCallCount++;
    this.deleteCalls.push(userId);
    for (const u of this.created) {
      if (u.userId === userId) {
        u.deleted = true;
      }
    }
  }

  /** T-0583: enable/disable a captured user (mirrors PUT user {enabled} on the live port). */
  async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
    this.setEnabledCallCount++;
    this.setEnabledCalls.push({ userId, enabled });
    if (this.failOnSetEnabled) {
      this.failOnSetEnabled = false;
      const err = new Error("AUTH_UNAVAILABLE");
      (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
      throw err;
    }
    for (const u of this.created) {
      if (u.userId === userId) {
        u.enabled = enabled;
      }
    }
  }

  /** True iff the given userId is currently enabled (defaults true if unknown — mirrors KC's default). */
  isEnabled(userId: string): boolean {
    const u = this.created.find((c) => c.userId === userId);
    return u ? u.enabled : true;
  }

  /**
   * T-0702: revoke all sessions for a user — mirrors the live port's
   * never-throw, best-effort contract (ADR-T0702 §2.2). `failOnRevokeSessions`
   * models KC being unreachable for this call specifically.
   */
  async revokeUserSessions(userId: string): Promise<{ revoked: boolean }> {
    this.revokeSessionsCallCount++;
    this.revokeSessionsCalls.push(userId);
    if (this.failOnRevokeSessions) {
      this.failOnRevokeSessions = false;
      return { revoked: false };
    }
    return { revoked: true };
  }

  /** Reset the capture log and failure switches. */
  reset(): void {
    this.created.length = 0;
    this.deleteCalls.length = 0;
    this.setEnabledCalls.length = 0;
    this.revokeSessionsCalls.length = 0;
    this.failOnCreate = false;
    this.failOnLoginTaken = false;
    this.failOnAuth = false;
    this.failOnNameInvalid = false;
    this.failOnSetEnabled = false;
    this.failOnRevokeSessions = false;
    this.createCallCount = 0;
    this.deleteCallCount = 0;
    this.setEnabledCallCount = 0;
    this.revokeSessionsCallCount = 0;
  }

  /** True iff a user with the given userId was created and NOT deleted. */
  isAlive(userId: string): boolean {
    return this.created.some((u) => u.userId === userId && !u.deleted);
  }

  /** True iff the last created user has actor_type="human" and a password credential (FF-3). */
  lastCreatedHasCorrectSpec(): boolean {
    if (this.created.length === 0) return false;
    const last = this.created[this.created.length - 1];
    return last.spec.actorType === "human" && typeof last.spec.password === "string" && last.spec.password.length >= 8;
  }
}
