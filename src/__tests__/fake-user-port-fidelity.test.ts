/**
 * src/__tests__/fake-user-port-fidelity.test.ts — T-0625, narrowed by T-0628.
 *
 * Unit-level (no DB, no live Keycloak) proof that InMemoryKeycloakUserPort
 * (src/keycloak/fake-user-port.ts) rejects a non-email `email` the same way a
 * real Keycloak realm does — the "fake-fidelity" half of the T-0625 fix.
 *
 * ROOT CAUSE this guards against: before the T-0625 fix, the fake accepted
 * ANY string as email, so `createHumanUser({username: 'liveproof-835201',
 * email: 'liveproof-835201', ...})` succeeded in every unit/db test — even
 * though a real Keycloak realm rejects a non-email `email` with 400
 * error-invalid-email (T-0583 LIVE_PROOF diagnosis). That gap is why the
 * "ordinary login" 503 bug shipped green through the entire test suite and
 * was only caught by a real-browser + real-Keycloak LIVE_PROOF run.
 *
 * T-0628 NARROWING: the ORIGINAL T-0625 fix also required `username` to be
 * email-shaped (this codebase's own choice at the time — the caller passed
 * the same value for both fields). T-0628's own spec makes `username`/`login`
 * free-form again (a real Keycloak realm — config/keycloak/realm-choros.json —
 * does not require it to look like an email); ONLY `email` is validated here,
 * matching the live port (src/keycloak/admin-port.ts).
 *
 * This test intentionally bypasses src/http/user-mgmt.ts (which now ALSO
 * validates the email before ever calling the port — see
 * ci/checks/db/user-mgmt.db.test.ts "T-0628 (AC-2): ... honest 400" for that
 * half) to prove the port itself, in isolation, no longer trusts its caller
 * to have validated the shape.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKeycloakUserPort } from "../keycloak/fake-user-port.js";

describe("T-0625/T-0628 — InMemoryKeycloakUserPort email-format fidelity", () => {
  it("rejects a non-email `email` with EMAIL_INVALID (mirrors real KC 400 error-invalid-email)", async () => {
    const kc = new InMemoryKeycloakUserPort();
    await expect(
      kc.createHumanUser({
        username: "ivan.petrov",
        email: "liveproof-835201",
        password: "password12345",
        actorType: "human",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_INVALID" });
    // No phantom user captured on a rejected create.
    expect(kc.created).toHaveLength(0);
    expect(kc.createCallCount).toBe(1);
  });

  it("T-0628: accepts a free-form (non-email) `username` paired with a valid `email` — login no longer forced to be email-shaped", async () => {
    const kc = new InMemoryKeycloakUserPort();
    const { userId } = await kc.createHumanUser({
      username: "ivan.petrov",
      email: "ivanov@company.ru",
      password: "password12345",
      actorType: "human",
    });
    expect(userId).toBeTruthy();
    expect(kc.created).toHaveLength(1);
    expect(kc.created[0].spec.username).toBe("ivan.petrov");
    expect(kc.created[0].spec.email).toBe("ivanov@company.ru");
    expect(kc.isAlive(userId)).toBe(true);
  });

  it("accepts a well-formed email for both username and email (the historical happy path is unaffected)", async () => {
    const kc = new InMemoryKeycloakUserPort();
    const { userId } = await kc.createHumanUser({
      username: "ivanov@company.ru",
      email: "ivanov@company.ru",
      password: "password12345",
      actorType: "human",
    });
    expect(userId).toBeTruthy();
    expect(kc.created).toHaveLength(1);
    expect(kc.isAlive(userId)).toBe(true);
  });

  it("EMAIL_INVALID check runs before the EMAIL_TAKEN / AUTH_UNAVAILABLE injection switches (a bad email is always rejected)", async () => {
    const kc = new InMemoryKeycloakUserPort();
    kc.failOnCreate = true; // would normally force EMAIL_TAKEN
    await expect(
      kc.createHumanUser({
        username: "ivan.petrov",
        email: "not-an-email",
        password: "password12345",
        actorType: "human",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_INVALID" });
  });
});
