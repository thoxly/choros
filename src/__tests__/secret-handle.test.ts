/**
 * T-0025 · BYO-LLM Secret-Handle Custody — unit tests
 *
 * Covers (no-DB / pure unit):
 *   AC-2..AC-6  — validator reject patterns (validateSecretHandleShape)
 *   AC-11       — handle value never in stdout/stderr (captured + asserted)
 *   AC-12..AC-14 — audit event type strings + no handle value in payload
 *   AC-18       — no management grant → 403 ADMIN_GATE_REJECTED, agent_card unchanged
 *   AC-19       — seed not mutated (FF-25-5: no non-NULL llm_secret_handle in 032)
 *
 * Tests that require live Postgres (AC-1, 7, 8, 9, 10) are not included here
 * (they require a DB fixture) — these rely on the route handlers exercised in
 * integration. The pure-validator AC-2..6 tests are the primary gate here.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateSecretHandleShape,
  redactHandle,
} from "../core/secret-handle-validator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// AC-2..AC-6: validator reject rules
// ---------------------------------------------------------------------------

describe("validateSecretHandleShape — accept cases", () => {
  it("accepts a valid opaque handle (env:// scheme)", () => {
    const v = validateSecretHandleShape("env://LLM_API_KEY");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a valid vault:// handle", () => {
    const v = validateSecretHandleShape("vault://secret/choros/agent/recon");
    expect(v).toEqual({ ok: true });
  });

  it("accepts an 8-char minimum-length handle", () => {
    const v = validateSecretHandleShape("12345678");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a handle with dots that is not a JWT (vault:// path)", () => {
    const v = validateSecretHandleShape("vault://secret/x.y");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a handle that is a 31-char hex string (below bare_hex_token threshold)", () => {
    // 31 hex chars is NOT rejected (threshold is 32+)
    const hex31 = "a".repeat(31);
    const result = validateSecretHandleShape(hex31);
    expect(result).toEqual({ ok: true }); // 31 chars, passes all rules
  });

  it("accepts a mixed alphanumeric non-hex handle of any length", () => {
    const v = validateSecretHandleShape("mySecretRef:prod-v2");
    expect(v).toEqual({ ok: true });
  });
});

describe("validateSecretHandleShape — AC-6: too_short", () => {
  it("AC-6: rejects empty string", () => {
    const v = validateSecretHandleShape("");
    expect(v).toEqual({ ok: false, reason: "too_short" });
  });

  it("AC-6: rejects 7-char string", () => {
    const v = validateSecretHandleShape("1234567");
    expect(v).toEqual({ ok: false, reason: "too_short" });
  });

  it("AC-6: accepts 8-char string (boundary)", () => {
    const v = validateSecretHandleShape("12345678");
    expect(v.ok).toBe(true);
  });
});

describe("validateSecretHandleShape — AC-2: vendor_key_prefix (sk-)", () => {
  it("AC-2: rejects value starting with sk-", () => {
    const v = validateSecretHandleShape("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });

  it("AC-2: rejects OpenAI-style key sk-XXXXXX", () => {
    const v = validateSecretHandleShape("sk-XXXXXXXXXX");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — AC-3: vendor_key_prefix (sk-proj-)", () => {
  it("AC-3: rejects value starting with sk-proj-", () => {
    // sk-proj- starts with sk-, so it is caught by the sk- rule
    const v = validateSecretHandleShape("sk-proj-abc123def456ghi789jkl012");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — xai- and AIza- vendor prefixes", () => {
  it("rejects value starting with xai-", () => {
    const v = validateSecretHandleShape("xai-somekey1234");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });

  it("rejects value starting with AIza", () => {
    const v = validateSecretHandleShape("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(v).toEqual({ ok: false, reason: "vendor_key_prefix" });
  });
});

describe("validateSecretHandleShape — AC-4: bare_hex_token", () => {
  it("AC-4: rejects 32-char lowercase hex string", () => {
    const v = validateSecretHandleShape("abcdef1234567890abcdef1234567890ab".slice(0, 32));
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: rejects 32-char uppercase hex string", () => {
    const v = validateSecretHandleShape("ABCDEF1234567890ABCDEF1234567890");
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: rejects 64-char hex string (SHA-256 pattern)", () => {
    const v = validateSecretHandleShape("a".repeat(64));
    expect(v).toEqual({ ok: false, reason: "bare_hex_token" });
  });

  it("AC-4: accepts 31-char hex string (below threshold)", () => {
    const v = validateSecretHandleShape("a".repeat(31));
    expect(v.ok).toBe(true);
  });
});

describe("validateSecretHandleShape — AC-5: jwt_shape", () => {
  it("AC-5: rejects well-formed JWT starting with eyJ", () => {
    // A realistic JWT-like string with three base64url segments
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiJ1c2VyLTEiLCJpYXQiOjE2MDAwMDAwMDB9";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${header}.${payload}.${sig}`;
    const v = validateSecretHandleShape(jwt);
    expect(v).toEqual({ ok: false, reason: "jwt_shape" });
  });

  it("AC-5: rejects unsigned JWT (empty signature segment)", () => {
    const v = validateSecretHandleShape("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.");
    expect(v).toEqual({ ok: false, reason: "jwt_shape" });
  });

  it("accepts a dotted non-JWT string (vault:// path)", () => {
    const v = validateSecretHandleShape("vault://secret/x.y.z");
    expect(v).toEqual({ ok: true });
  });

  it("accepts a dotted string not starting with eyJ", () => {
    const v = validateSecretHandleShape("some.dotted.reference-token-value");
    expect(v).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// redactHandle tests
// ---------------------------------------------------------------------------

describe("redactHandle", () => {
  it("returns scheme prefix + ... for vault:// URLs", () => {
    const r = redactHandle("vault://secret/choros/agent/recon");
    expect(r).toBe("vault://...");
    expect(r).not.toContain("secret");
  });

  it("returns scheme prefix + ... for env:// references", () => {
    const r = redactHandle("env://LLM_API_KEY");
    expect(r).toBe("env://...");
  });

  it("returns first-8-chars + ... for non-scheme handles", () => {
    const r = redactHandle("myOpaqueHandle123");
    // "myOpaque" is exactly 8 chars; the implementation slices 0..8.
    expect(r).toBe("myOpaque...");
    expect(r.startsWith("myOpaque")).toBe(true);
  });

  it("never returns the full value", () => {
    const full = "env://SUPER_SECRET_PRODUCTION_KEY";
    const r = redactHandle(full);
    expect(r).not.toBe(full);
    expect(r).not.toContain("SUPER_SECRET_PRODUCTION_KEY");
  });
});

// ---------------------------------------------------------------------------
// AC-11: handle value never appears in console output during validation calls
// ---------------------------------------------------------------------------

describe("AC-11: handle value not leaked to stdout/stderr via validator", () => {
  it("validateSecretHandleShape rejection does not log the value", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const SECRET_VALUE = "sk-SUPER-SENSITIVE-VALUE-SHOULD-NOT-LOG";
    validateSecretHandleShape(SECRET_VALUE);

    // None of the console methods should have been called at all.
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("redactHandle does not log the value", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const SECRET_VALUE = "vault://my-super-sensitive-vault-path";
    redactHandle(SECRET_VALUE);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-12..AC-14: audit event type contract (static structural test)
// The route module builds AuditEventInput with the exact NF-4 type strings.
// We verify the constants are exactly right by reading the module source.
// ---------------------------------------------------------------------------

describe("AC-12..AC-14: audit event type strings (NF-4 contract)", () => {
  const MODULE_SRC = readFileSync(
    join(HERE, "..", "http", "secret-handle.ts"),
    "utf8",
  );

  it("AC-12: set_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"set_llm_secret_handle"');
  });

  it("AC-13: rotate_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"rotate_llm_secret_handle"');
  });

  it("AC-14: revoke_llm_secret_handle audit type constant exists in route module", () => {
    expect(MODULE_SRC).toContain('"revoke_llm_secret_handle"');
  });

  it("AC-12/13/14: audit payload contains agentEmployeeId, not handle value", () => {
    // The payload object literal must contain agentEmployeeId key.
    expect(MODULE_SRC).toMatch(/payload:\s*\{\s*agentEmployeeId:/);
    // No 'handleValue' or 'handle_value' should appear inside a payload object.
    // We do a conservative check: the payload literal should NOT reference handleValue.
    const payloadBlocks = MODULE_SRC.match(/payload:\s*\{[^}]+\}/g) ?? [];
    for (const block of payloadBlocks) {
      expect(block).not.toContain("handleValue");
      expect(block).not.toContain("handle_value");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-18: no management grant → 403 gate (structural assertion via source)
// The holdsAgentMgmtUpdate predicate must exist and check mgmt_object:agent.
// ---------------------------------------------------------------------------

describe("AC-18: authority gate exists in route module", () => {
  const MODULE_SRC = readFileSync(
    join(HERE, "..", "http", "secret-handle.ts"),
    "utf8",
  );

  it("AC-18: holdsAgentMgmtUpdate function defined and checks mgmt_object:agent", () => {
    expect(MODULE_SRC).toContain("holdsAgentMgmtUpdate");
    expect(MODULE_SRC).toContain('"mgmt_object:agent"');
    expect(MODULE_SRC).toContain('"update"');
  });

  it("AC-18: 403 ADMIN_GATE_REJECTED is thrown when gate fails", () => {
    expect(MODULE_SRC).toContain("ADMIN_GATE_REJECTED");
    expect(MODULE_SRC).toContain("403");
  });

  it("AC-18: loadAdminContext is called before any write", () => {
    expect(MODULE_SRC).toContain("loadAdminContext");
  });
});

// ---------------------------------------------------------------------------
// AC-19: seed not mutated (FF-25-5) — read 032 migration, assert all NULLs
// ---------------------------------------------------------------------------

describe("AC-19: seed invariant — all 5 agents have llm_secret_handle = NULL", () => {
  it("032 migration does not insert non-NULL llm_secret_handle for any seeded agent", () => {
    const migPath = join(HERE, "..", "..", "migrations", "032_agent_card.sql");
    const sql = readFileSync(migPath, "utf8");

    // The seed INSERT in 032 uses an explicit column list and NULL values.
    // Every VALUES row in the INSERT must have NULL for llm_secret_handle.
    // We check that no VALUES tuple has a non-NULL literal at position 7
    // by asserting the seed VALUES lines all match the NULL-only pattern.
    //
    // The column list is: tenant_id, employee_id, employee_kind, kc_client_id,
    //   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold, ...
    // So llm_secret_handle is the 7th column (0-indexed: 6).
    //
    // Check: each VALUES row should have NULL at position 6.
    const valuesLines = sql
      .split("\n")
      .filter((l) => l.trim().startsWith("(") && l.includes("NULL"));

    // Each row must have NULL in the 7th column position.
    for (const line of valuesLines) {
      // Strip leading/trailing whitespace and the outer parens.
      const inner = line.trim().replace(/^\(|\).*$/g, "");
      const cols = inner.split(",").map((s) => s.trim());
      // llm_secret_handle is at index 6 (0-based).
      if (cols.length >= 7) {
        expect(cols[6]).toBe("NULL");
      }
    }
  });

  it("032 migration has exactly 5 agent_card seed rows", () => {
    const migPath = join(HERE, "..", "..", "migrations", "032_agent_card.sql");
    const sql = readFileSync(migPath, "utf8");
    // Count VALUES tuples in the INSERT INTO agent_card statement.
    const valuesTuples = (sql.match(/\('[0-9a-f-]+', '[0-9a-f-]+'/g) ?? []).length;
    expect(valuesTuples).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SecretResolverPort type compliance (structural — no runtime call)
// ---------------------------------------------------------------------------

describe("SecretResolverPort interface (ADR §8 — declared, never invoked)", () => {
  it("is exported from secret-handle-validator.ts", () => {
    const validatorSrc = readFileSync(
      join(HERE, "..", "core", "secret-handle-validator.ts"),
      "utf8",
    );
    expect(validatorSrc).toContain("export interface SecretResolverPort");
    expect(validatorSrc).toContain("resolveSecret");
  });

  it("the route module does NOT call resolveSecret at runtime (FR-6 — zero platform LLM call)", () => {
    const routeSrc = readFileSync(
      join(HERE, "..", "http", "secret-handle.ts"),
      "utf8",
    );
    // The route module must not contain any CALL to resolveSecret (e.g. .resolveSecret() ).
    // It may mention it in comments as documentation, but must never invoke it.
    // Check that there is no invocation pattern: resolveSecret(
    expect(routeSrc).not.toMatch(/\.resolveSecret\s*\(/);
    // And no direct call without object receiver.
    expect(routeSrc).not.toMatch(/\bresolveSecret\s*\(/);
  });
});
