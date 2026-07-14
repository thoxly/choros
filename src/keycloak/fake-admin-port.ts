/**
 * src/keycloak/fake-admin-port.ts — T-0042 (E5.2): In-memory Keycloak Admin port fake.
 *
 * InMemoryKeycloakAdminPort implements KeycloakAdminPort with an in-memory
 * capture log for unit tests. No live Keycloak required (NF-7, AC-16, FF-HIRE-6).
 *
 * Failure injection switches:
 *   failOnCreate   — createServiceAccountClient throws immediately (AC-6)
 *   failAfterCreate — createServiceAccountClient succeeds but caller's DB then
 *                     fails; deleteClient is called for orphan cleanup (AC-7).
 *                     This switch makes the fake track the delete call so tests
 *                     can assert the attempt.
 *
 * This file lives OUTSIDE src/core/ so the live adapter and the fake are both
 * injectable substitutes — neither bleeds into the pure core (FF-HIRE-6).
 */

import type { KeycloakAdminPort, KcClientSpec } from "../core/agent-hire.js";

// ---------------------------------------------------------------------------
// Capture types
// ---------------------------------------------------------------------------

export interface CapturedClient {
  spec: KcClientSpec;
  clientId: string;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// InMemoryKeycloakAdminPort
// ---------------------------------------------------------------------------

export class InMemoryKeycloakAdminPort implements KeycloakAdminPort {
  /** All create calls, in order. */
  readonly created: CapturedClient[] = [];

  /** clientId strings passed to deleteClient, in order. */
  readonly deleteCalls: string[] = [];

  /**
   * If true, the NEXT createServiceAccountClient call throws immediately
   * (simulates Keycloak unreachable or quota exceeded). Resets to false
   * after each failed call (one-shot). Set to a persistent true for
   * all-calls-fail behaviour.
   */
  failOnCreate = false;

  /**
   * If a string, createServiceAccountClient records the client in the capture log
   * BUT the caller's DB is expected to fail. The test verifies that deleteClient
   * was subsequently called with this clientId (AC-7 orphan-cleanup assertion).
   * Set to null (default) for normal behaviour.
   */
  expectOrphanCleanup: string | null = null;

  async createServiceAccountClient(spec: KcClientSpec): Promise<{ clientId: string }> {
    if (this.failOnCreate) {
      this.failOnCreate = false; // one-shot reset
      throw new Error(`InMemoryKeycloakAdminPort: failOnCreate=true for clientId=${spec.clientId}`);
    }
    const entry: CapturedClient = { spec, clientId: spec.clientId, deleted: false };
    this.created.push(entry);
    return { clientId: spec.clientId };
  }

  async deleteClient(clientId: string): Promise<void> {
    this.deleteCalls.push(clientId);
    // Mark the corresponding created entry as deleted (if found).
    for (const c of this.created) {
      if (c.clientId === clientId) {
        c.deleted = true;
      }
    }
  }

  /** Reset the capture log and failure switches. */
  reset(): void {
    this.created.length = 0;
    this.deleteCalls.length = 0;
    this.failOnCreate = false;
    this.expectOrphanCleanup = null;
  }

  /** True iff a client with the given clientId was created and NOT deleted. */
  isAlive(clientId: string): boolean {
    return this.created.some((c) => c.clientId === clientId && !c.deleted);
  }

  /** True iff a client with the given clientId was created (regardless of deletion). */
  wasCreated(clientId: string): boolean {
    return this.created.some((c) => c.clientId === clientId);
  }

  /**
   * True iff the created client has serviceAccountsEnabled=true, actor_type='agent',
   * standardFlowEnabled=false, and directAccessGrantsEnabled=false (AC-4).
   */
  hasCorrectSpec(clientId: string): boolean {
    const c = this.created.find((x) => x.clientId === clientId);
    if (!c) return false;
    return (
      c.spec.serviceAccountsEnabled === true &&
      c.spec.actorType === "agent" &&
      c.spec.standardFlowEnabled === false &&
      c.spec.directAccessGrantsEnabled === false
    );
  }

  /** Returns the realm role mappings for the service account user (always empty — no roles assigned, AC-10). */
  getRealmRoleMappings(_clientId: string): string[] {
    return []; // No realm roles ever assigned by the fake (FR-8 / AC-10)
  }
}
