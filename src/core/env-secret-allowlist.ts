/**
 * src/core/env-secret-allowlist.ts — T-0382 (D5) BLOCKER-1 hardening.
 *
 * PURE, IO-FREE helper for the env:// secret-handle allow-list.
 *
 * SECURITY RATIONALE:
 *   A tenant admin controls BOTH the LLM secret-handle and the llm_endpoint
 *   (PUT /api/llm-config). An unrestricted `env://VARNAME` resolver would let a
 *   tenant set handle="env://DATABASE_URL" + endpoint="https://attacker" and the
 *   server env value would ship as `Authorization: Bearer <value>` — arbitrary
 *   server-environment exfiltration.
 *
 *   Therefore `env://` handles are resolvable ONLY for an explicit allow-list of
 *   env var names. Everything else is rejected. Real tenant BYO keys must be
 *   stored via the encrypted secret-handle custody store (T-0025), not via
 *   tenant-supplied env:// pointers.
 *
 * This module is the single source of truth for the allow-list decision so it
 * can be unit-tested in isolation (no process.env, no server bootstrap).
 */

/**
 * The default allow-list of env var names resolvable through an `env://` handle.
 * Exactly ONE entry: the deployment's single dev fallback key. Any other env var
 * (DB password, cloud creds, Keycloak secrets, etc.) is NOT resolvable.
 */
export const DEFAULT_ENV_HANDLE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "DEEPSEEK_API_KEY",
]);

/** Outcome of an env:// handle resolution decision. */
export type EnvHandleDecision =
  | { kind: "not_env" }
  | { kind: "denied"; varName: string }
  | { kind: "allowed"; varName: string };

/**
 * Decide whether a secret handle is an allow-listed `env://` reference.
 *
 *   - `not_env`  — handle does not use the env:// scheme (caller handles other schemes).
 *   - `denied`   — env:// handle naming a var NOT on the allow-list (reject — do NOT read it).
 *   - `allowed`  — env:// handle naming an allow-listed var (caller may read process.env).
 *
 * PURE: takes the allow-list explicitly; never touches process.env.
 */
export function decideEnvHandle(
  handle: string,
  allowlist: ReadonlySet<string> = DEFAULT_ENV_HANDLE_ALLOWLIST,
): EnvHandleDecision {
  const prefix = "env://";
  if (!handle.startsWith(prefix)) {
    return { kind: "not_env" };
  }
  const varName = handle.slice(prefix.length);
  if (!allowlist.has(varName)) {
    return { kind: "denied", varName };
  }
  return { kind: "allowed", varName };
}
