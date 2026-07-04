/**
 * src/__tests__/fake-user-port-fidelity.test.ts — T-0625.
 *
 * Unit-level (no DB, no live Keycloak) proof that InMemoryKeycloakUserPort
 * (src/keycloak/fake-user-port.ts) now REJECTS a non-email username/email the
 * same way a real Keycloak realm does — this is the "fake-fidelity" half of
 * the T-0625 fix.
 *
 * ROOT CAUSE this guards against: before the fix, the fake accepted ANY
 * string as username/email, so `createHumanUser({username: 'liveproof-835201',
 * email: 'liveproof-835201', ...})` succeeded in every unit/db test — even
 * though a real Keycloak realm rejects that value with 400
 * error-invalid-email (T-0583 LIVE_PROOF diagnosis). That gap is why the
 * "ordinary login" 503 bug shipped green through the entire test suite and
 * was only caught by a real-browser + real-Keycloak LIVE_PROOF run.
 *
 * This test intentionally bypasses src/http/user-mgmt.ts (which now ALSO
 * validates the login before ever calling the port — see
 * ci/checks/db/user-mgmt.db.test.ts "T-0625: ... honest 400" for that half)
 * to prove the port itself, in isolation, no longer trusts its caller to
 * have validated the shape.
 */

import { describe, it, expect } from "vitest";
import { InMemoryKeycloakUserPort } from "../keycloak/fake-user-port.js";

describe("T-0625 — InMemoryKeycloakUserPort email-format fidelity", () => {
  it("rejects a non-email username/email with EMAIL_INVALID (mirrors real KC 400 error-invalid-email)", async () => {
    const kc = new InMemoryKeycloakUserPort();
    await expect(
      kc.createHumanUser({
        username: "liveproof-835201",
        email: "liveproof-835201",
        password: "password12345",
        actorType: "human",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_INVALID" });
    // No phantom user captured on a rejected create.
    expect(kc.created).toHaveLength(0);
    expect(kc.createCallCount).toBe(1);
  });

  it("accepts a well-formed email username/email (the happy path is unaffected)", async () => {
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

  it("EMAIL_INVALID check runs before the EMAIL_TAKEN / AUTH_UNAVAILABLE injection switches (a bad shape is always rejected)", async () => {
    const kc = new InMemoryKeycloakUserPort();
    kc.failOnCreate = true; // would normally force EMAIL_TAKEN
    await expect(
      kc.createHumanUser({
        username: "not-an-email",
        email: "not-an-email",
        password: "password12345",
        actorType: "human",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_INVALID" });
  });
});
