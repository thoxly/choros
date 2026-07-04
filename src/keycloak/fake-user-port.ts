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
 * This file lives OUTSIDE src/core/ so the live adapter and the fake are both
 * injectable substitutes — neither bleeds into the pure core (FF-HIRE-6).
 */

import type { KeycloakUserPort, KcHumanUserSpec } from "./admin-port.js";

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
   * If true, the NEXT createHumanUser call throws AUTH_UNAVAILABLE (KC unreachable).
   * Resets to false after each failed call (one-shot).
   */
  failOnAuth = false;

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

  async createHumanUser(spec: KcHumanUserSpec): Promise<{ userId: string }> {
    this.createCallCount++;

    if (this.failOnAuth) {
      this.failOnAuth = false;
      const err = new Error("AUTH_UNAVAILABLE");
      (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
      throw err;
    }
    if (this.failOnCreate) {
      this.failOnCreate = false;
      const err = new Error("EMAIL_TAKEN");
      (err as NodeJS.ErrnoException).code = "EMAIL_TAKEN";
      throw err;
    }

    // Generate a deterministic fake KC UUID from the username
    const userId = `kc-user-${this.created.length + 1}-${spec.username.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 64);
    const entry: CapturedUser = { spec, userId, deleted: false, enabled: true };
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

  /** Reset the capture log and failure switches. */
  reset(): void {
    this.created.length = 0;
    this.deleteCalls.length = 0;
    this.setEnabledCalls.length = 0;
    this.failOnCreate = false;
    this.failOnAuth = false;
    this.failOnSetEnabled = false;
    this.createCallCount = 0;
    this.deleteCallCount = 0;
    this.setEnabledCallCount = 0;
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
