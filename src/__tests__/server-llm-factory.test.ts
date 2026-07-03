/**
 * src/__tests__/server-llm-factory.test.ts — T-0600 (AC-1).
 *
 * A live acceptance run showed a tenant WITHOUT its own assigned LLM profile
 * (llm_connection_id NULL) silently answered via the server's global
 * DEEPSEEK_API_KEY env key instead of the honest dormant 503 — a BYO-doctrine
 * violation. This unit test asserts the REAL composition-root factory
 * (src/server.ts::makeLlmPortFactory, exported for this purpose) returns
 * dormantLlmPort when there is no per-tenant config, EVEN WHEN
 * DEEPSEEK_API_KEY is present in process.env — proving the removed
 * env-fallback step cannot silently reappear.
 *
 * ZERO NETWORK / ZERO DB: grantsPool is passed as `null`, which makes
 * loadTenantLlmConfig (src/db/agent-card-llm.ts) return null immediately
 * (`if (!pool) return null;`) without ever touching Postgres — the exact
 * "no per-tenant config resolvable" case this factory must answer honestly.
 * The live-Postgres counterpart (a REAL registered tenant, AC-2) lives in
 * ci/checks/db/assistant-llm-unavailable.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeLlmPortFactory } from "../server.js";
import { dormantLlmPort } from "../core/llm-port.js";

const ENV_KEY = "DEEPSEEK_API_KEY";
const originalValue = process.env[ENV_KEY];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }
});

describe("T-0600 (AC-1) — makeLlmPortFactory: no env-fallback for a real tenant path", () => {
  it("returns dormantLlmPort for a tenant with no per-tenant config, even when DEEPSEEK_API_KEY is set", async () => {
    process.env[ENV_KEY] = "sk-test-would-have-been-used-as-a-shared-fallback-key";

    const port = await makeLlmPortFactory("a0000000-0000-0000-0000-000000000001", null);

    // dormantLlmPort is a fixed singleton (structurally impossible to make a
    // network call through it) — identity equality proves NO OpenAILlmPort
    // wired against the env key was constructed instead.
    expect(port).toBe(dormantLlmPort);
  });

  it("still returns dormantLlmPort when DEEPSEEK_API_KEY is entirely unset (baseline, no regression)", async () => {
    delete process.env[ENV_KEY];

    const port = await makeLlmPortFactory("a0000000-0000-0000-0000-000000000002", null);

    expect(port).toBe(dormantLlmPort);
  });

  it("dormantLlmPort.chat() throws LlmDormantError (fail-closed — no live call is reachable)", async () => {
    process.env[ENV_KEY] = "sk-test-should-be-ignored";
    const port = await makeLlmPortFactory("a0000000-0000-0000-0000-000000000003", null);
    await expect(port.chat({ system: "x", messages: [] })).rejects.toThrow(/dormant/i);
  });
});
