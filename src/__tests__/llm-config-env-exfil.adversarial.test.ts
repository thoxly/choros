/**
 * T-0417 · ADVERSARY (Враг red-team) — BYO LLM env-resolver exfiltration suite.
 *
 * Surface under attack: T-0382 BLOCKER-1.
 *   - src/core/env-secret-allowlist.ts (decideEnvHandle — the pure allow-list)
 *   - src/server.ts tenantSecretResolver.resolveSecret (the live composition root)
 *   - src/http/llm-config.ts PUT /api/llm-config endpoint policy (https-only)
 *
 * THREAT MODEL (from env-secret-allowlist.ts header): a tenant admin controls
 * BOTH the secret-handle (env://VARNAME) AND the llm_endpoint. An unrestricted
 * env:// resolver lets them set handle="env://DATABASE_URL" +
 * endpoint="https://attacker" and the server env value ships as a bearer token —
 * arbitrary server-environment exfiltration.
 *
 * GOAL of this suite: try EVERY trick to make decideEnvHandle / resolveSecret
 * return a server env value other than the single allow-listed DEEPSEEK_API_KEY,
 * and prove every one is DENIED. This is the partner adversarial suite to
 * llm-config-security.test.ts (the happy/headline cases live there).
 *
 * Pure unit — no live Postgres. Runnable NOW.
 */

import { describe, it, expect } from "vitest";
import {
  decideEnvHandle,
  DEFAULT_ENV_HANDLE_ALLOWLIST,
} from "../core/env-secret-allowlist.js";
import { tenantSecretResolver } from "../server.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Sentinel-planting helper: set an env var, run the attack, assert it never
// leaks the sentinel, then restore the prior value (no env pollution).
// ---------------------------------------------------------------------------
async function withEnv(
  name: string,
  value: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

/**
 * The canonical "this handle MUST be denied" assertion: decideEnvHandle never
 * returns `allowed`, AND the live resolver throws WITHOUT echoing the sentinel.
 */
async function assertHandleDenied(handle: string, sentinel: string): Promise<void> {
  const decision = decideEnvHandle(handle);
  // It is allowed to be `denied` OR `not_env` — but NEVER `allowed` for anything
  // other than the exact allow-listed handle.
  expect(decision.kind).not.toBe("allowed");

  const result = tenantSecretResolver.resolveSecret(handle, { tenantId: TENANT });
  await expect(result).rejects.toThrow();
  // The rejection reason must NOT contain the secret value (no value-echo leak).
  await result.catch((e: unknown) => {
    expect(String(e)).not.toContain(sentinel);
  });
}

// ===========================================================================
// 1. CASE-VARIANT ATTACKS — the allow-list is case-SENSITIVE; only the exact
//    name DEEPSEEK_API_KEY is resolvable. Targeting DATABASE_URL via casing.
// ===========================================================================
describe("Враг · env:// case-variant exfil attempts are DENIED", () => {
  const CASE_VARIANTS = [
    "env://database_url", // all-lower
    "env://Database_Url", // mixed
    "env://DATABASE_url", // partial
    "env://dEEPSEEK_API_KEY", // de-cased allow-listed name → must NOT match
    "env://deepseek_api_key", // lower allow-listed name → must NOT match
    "env://Deepseek_Api_Key", // title allow-listed name → must NOT match
  ];

  for (const handle of CASE_VARIANTS) {
    it(`DENIES ${JSON.stringify(handle)}`, async () => {
      await withEnv("DATABASE_URL", "postgres://LEAK-DB-SENTINEL", async () => {
        await withEnv("DEEPSEEK_API_KEY", "DEEPSEEK-KEY-SENTINEL", async () => {
          await assertHandleDenied(handle, "LEAK-DB-SENTINEL");
          // A de-cased copy of the allow-listed name must also not yield the key.
          if (handle.toLowerCase().includes("deepseek")) {
            await assertHandleDenied(handle, "DEEPSEEK-KEY-SENTINEL");
          }
        });
      });
    });
  }

  it("the allow-list membership test is EXACT (no normalization)", () => {
    // Set membership is case-exact. Anything but the literal entry is denied.
    expect(DEFAULT_ENV_HANDLE_ALLOWLIST.has("DEEPSEEK_API_KEY")).toBe(true);
    expect(DEFAULT_ENV_HANDLE_ALLOWLIST.has("deepseek_api_key")).toBe(false);
    expect(DEFAULT_ENV_HANDLE_ALLOWLIST.has("DATABASE_URL")).toBe(false);
  });
});

// ===========================================================================
// 2. WHITESPACE / CONTROL-CHAR ATTACKS — leading/trailing space, tab, CR, LF,
//    null bytes. decideEnvHandle does NO trimming, so the varName carries the
//    whitespace → not in the allow-list → denied. Critically, NO whitespace
//    variant of "DEEPSEEK_API_KEY" resolves, AND no whitespace variant smuggles
//    a different var.
// ===========================================================================
describe("Враг · whitespace/control-char smuggling is DENIED", () => {
  const WS_VARIANTS = [
    "env:// DATABASE_URL", // leading space in var
    "env://DATABASE_URL ", // trailing space
    "env://\tDATABASE_URL", // leading tab
    "env://DATABASE_URL\n", // trailing newline
    "env://DATABASE_URL\r", // trailing CR
    "env://DATABASE_URL\r\n", // CRLF
    "env://DEEPSEEK_API_KEY ", // allow-listed + trailing space → must NOT match
    " env://DEEPSEEK_API_KEY", // leading space before scheme → not even env://
    "env://DEEPSEEK_API_KEY\n", // allow-listed + newline → must NOT match
    "env://DEEPSEEK_API_KEY\t", // allow-listed + tab → must NOT match
    "\tenv://DEEPSEEK_API_KEY", // leading tab before scheme
  ];

  for (const handle of WS_VARIANTS) {
    it(`DENIES ${JSON.stringify(handle)}`, async () => {
      await withEnv("DATABASE_URL", "postgres://WS-DB-SENTINEL", async () => {
        await withEnv("DEEPSEEK_API_KEY", "WS-DEEPSEEK-SENTINEL", async () => {
          // Whatever it leaks, it must never be either sentinel.
          await assertHandleDenied(handle, "WS-DB-SENTINEL");
          await assertHandleDenied(handle, "WS-DEEPSEEK-SENTINEL");
        });
      });
    });
  }

  it("null-byte injection (env://DATABASE_URL\\0) is DENIED", async () => {
    // Construct a GENUINE NUL byte at runtime (keeps this source file ASCII-clean).
    const NUL = String.fromCharCode(0);
    await withEnv("DATABASE_URL", "postgres://NUL-SENTINEL", async () => {
      // A var name carrying a real NUL is not on the allow-list.
      await assertHandleDenied(`env://DATABASE_URL${NUL}`, "NUL-SENTINEL");
      // A NUL embedded mid-name (truncation-confusion attempt) is also denied.
      await assertHandleDenied(`env://DATABASE_URL${NUL}.ignored`, "NUL-SENTINEL");
      // Trailing NUL on the allow-listed name must not match either (no truncation
      // that would re-expose DEEPSEEK_API_KEY as the resolved var).
      await withEnv("DEEPSEEK_API_KEY", "NUL-DEEPSEEK", async () => {
        await assertHandleDenied(`env://DEEPSEEK_API_KEY${NUL}`, "NUL-DEEPSEEK");
      });
    });
  });
});

// ===========================================================================
// 3. PERCENT-ENCODING / PATH-TRICK ATTACKS — the resolver does a literal
//    string slice, NOT URL decoding. So env://DATABASE%5FURL stays the literal
//    "DATABASE%5FURL" → not on the allow-list. There is NO decode step that
//    would turn it back into DATABASE_URL.
// ===========================================================================
describe("Враг · percent-encoding / path tricks are DENIED", () => {
  const ENCODED = [
    "env://DATABASE%5FURL", // %5F == "_"
    "env://DATABASE%5fURL", // lower hex
    "env://DATABASE_URL%00", // trailing encoded NUL
    "env://./DATABASE_URL", // relative-path prefix
    "env://../DATABASE_URL", // parent-path prefix
    "env:///DATABASE_URL", // extra slash → varName "/DATABASE_URL"
    "env://x/../DATABASE_URL", // path traversal in var
    "env://DEEPSEEK%5FAPI%5FKEY", // encoded allow-listed name → must NOT decode
  ];

  for (const handle of ENCODED) {
    it(`DENIES ${JSON.stringify(handle)} (no URL-decode step exists)`, async () => {
      await withEnv("DATABASE_URL", "postgres://ENC-DB-SENTINEL", async () => {
        await withEnv("DEEPSEEK_API_KEY", "ENC-DEEPSEEK-SENTINEL", async () => {
          await assertHandleDenied(handle, "ENC-DB-SENTINEL");
          await assertHandleDenied(handle, "ENC-DEEPSEEK-SENTINEL");
        });
      });
    });
  }
});

// ===========================================================================
// 4. SCHEME-VARIANT ATTACKS — the prefix match is the literal "env://".
//    A different scheme that still NAMES an env var must NOT reach process.env.
//    Uppercase ENV:// must not match (and must not equal the legacy handle).
// ===========================================================================
describe("Враг · non-canonical schemes never reach process.env", () => {
  const SCHEMES = [
    "ENV://DATABASE_URL", // uppercase scheme
    "Env://DATABASE_URL", // mixed scheme
    "env:/DATABASE_URL", // single slash
    "env:DATABASE_URL", // no slashes
    "envt://DATABASE_URL", // typo-extended scheme
    "xenv://DATABASE_URL", // prefixed scheme
    "process.env://DATABASE_URL", // wishful scheme
    "file://DATABASE_URL", // file scheme
    "ENV://DEEPSEEK_API_KEY", // uppercase scheme + allow-listed name
  ];

  for (const handle of SCHEMES) {
    it(`scheme ${JSON.stringify(handle)} never yields a server env value`, async () => {
      await withEnv("DATABASE_URL", "postgres://SCHEME-DB-SENTINEL", async () => {
        await withEnv("DEEPSEEK_API_KEY", "SCHEME-DEEPSEEK-SENTINEL", async () => {
          // Either not_env or denied — never allowed; resolver throws, no leak.
          await assertHandleDenied(handle, "SCHEME-DB-SENTINEL");
          await assertHandleDenied(handle, "SCHEME-DEEPSEEK-SENTINEL");
        });
      });
    });
  }

  it("the legacy DEEPSEEK_HANDLE backward-compat path requires the EXACT string", async () => {
    // Pattern 2 in resolveSecret: handle === "env://DEEPSEEK_API_KEY" (exact).
    // The uppercase scheme is not_env and not equal to the legacy handle → throw.
    await withEnv("DEEPSEEK_API_KEY", "LEGACY-SENTINEL", async () => {
      await expect(
        tenantSecretResolver.resolveSecret("ENV://DEEPSEEK_API_KEY", { tenantId: TENANT }),
      ).rejects.toThrow();
      // The exact canonical handle still resolves (positive control).
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT }),
      ).resolves.toBe("LEGACY-SENTINEL");
    });
  });
});

// ===========================================================================
// 5. SECRET-VALUE ECHO — even a DENIED handle whose var IS set must not leak
//    the value via the thrown error message (redactHandle redacts the handle).
// ===========================================================================
describe("Враг · denied-handle errors never echo the env value or var name", () => {
  it("env://DATABASE_URL error redacts the handle to env://... (no var name, no value)", async () => {
    await withEnv("DATABASE_URL", "postgres://super-secret-ECHO-CHECK", async () => {
      const result = tenantSecretResolver.resolveSecret("env://DATABASE_URL", {
        tenantId: TENANT,
      });
      await expect(result).rejects.toThrow(/not permitted/i);
      await result.catch((e: unknown) => {
        const msg = String(e);
        expect(msg).not.toContain("super-secret-ECHO-CHECK"); // no value leak
        expect(msg).not.toContain("DATABASE_URL"); // no var-name leak (redacted)
        expect(msg).toContain("env://..."); // proves redaction happened
      });
    });
  });

  it("an arbitrary allow-listable-looking var (env://AWS_SECRET_ACCESS_KEY) is denied + redacted", async () => {
    await withEnv("AWS_SECRET_ACCESS_KEY", "AKIA-ECHO-SENTINEL", async () => {
      const result = tenantSecretResolver.resolveSecret("env://AWS_SECRET_ACCESS_KEY", {
        tenantId: TENANT,
      });
      await expect(result).rejects.toThrow(/not permitted/i);
      await result.catch((e: unknown) => {
        expect(String(e)).not.toContain("AKIA-ECHO-SENTINEL");
        expect(String(e)).not.toContain("AWS_SECRET_ACCESS_KEY");
      });
    });
  });
});

// ===========================================================================
// 6. POSITIVE CONTROL + EMPTY-VAR — only the exact allow-listed handle resolves,
//    and even then only when the env var is actually present.
// ===========================================================================
describe("Враг · positive control — ONLY env://DEEPSEEK_API_KEY resolves", () => {
  it("resolves the exact handle when the var is present", async () => {
    await withEnv("DEEPSEEK_API_KEY", "the-only-resolvable-value", async () => {
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT }),
      ).resolves.toBe("the-only-resolvable-value");
    });
  });

  it("throws (does not return empty) when the allow-listed var is UNSET", async () => {
    const prev = process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];
    try {
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT }),
      ).rejects.toThrow();
    } finally {
      if (prev !== undefined) process.env["DEEPSEEK_API_KEY"] = prev;
    }
  });

  it("an empty-string env value for the allow-listed var is treated as not-found (throws)", async () => {
    // decideEnvHandle says `allowed`, but resolveSecret guards `if (!key)` → throw.
    // An empty bearer token must not silently ship.
    await withEnv("DEEPSEEK_API_KEY", "", async () => {
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT }),
      ).rejects.toThrow();
    });
  });
});
