/**
 * src/__tests__/authConfig.test.ts — T-0258
 *
 * Unit tests for the public auth-config builder (buildPublicAuthConfig) that
 * backs GET /api/auth-config. The browser SPA reads this to learn the mode and
 * the public OIDC parameters. Guarantees:
 *   - dev mode → { mode: "dev" }, NO keycloak block (and never a secret);
 *   - keycloak mode → { mode: "keycloak", keycloak: { url, realm, clientId, audience } }
 *     with the documented env precedence + defaults;
 *   - the returned object NEVER contains a client secret.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildPublicAuthConfig } from "../http/auth.js";

const ENV_KEYS = [
  "CHOROS_AUTH_MODE",
  "KEYCLOAK_PUBLIC_URL",
  "KEYCLOAK_URL",
  "KEYCLOAK_REALM",
  "KEYCLOAK_WEB_CLIENT_ID",
  "KEYCLOAK_AUDIENCE",
] as const;

function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restore(s: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

describe("buildPublicAuthConfig (T-0258)", () => {
  const saved = snapshot();
  afterEach(() => restore(saved));

  it("dev mode (default) → { mode: 'dev' } with no keycloak block", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = buildPublicAuthConfig();
    expect(cfg).toEqual({ mode: "dev" });
    expect(cfg.keycloak).toBeUndefined();
  });

  it("explicit dev mode → { mode: 'dev' }", () => {
    process.env["CHOROS_AUTH_MODE"] = "dev";
    expect(buildPublicAuthConfig()).toEqual({ mode: "dev" });
  });

  it("keycloak mode → public OIDC params with defaults", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    process.env["KEYCLOAK_URL"] = "http://keycloak:8180";
    const cfg = buildPublicAuthConfig();
    expect(cfg.mode).toBe("keycloak");
    expect(cfg.keycloak).toEqual({
      url: "http://keycloak:8180",
      realm: "choros", // default
      clientId: "choros-web", // default public SPA client
      audience: "choros-api", // default
    });
  });

  it("keycloak mode → KEYCLOAK_PUBLIC_URL takes precedence over KEYCLOAK_URL", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    process.env["KEYCLOAK_URL"] = "http://keycloak:8180"; // internal compose host
    process.env["KEYCLOAK_PUBLIC_URL"] = "https://auth.example.com"; // browser-facing
    process.env["KEYCLOAK_REALM"] = "acme";
    process.env["KEYCLOAK_WEB_CLIENT_ID"] = "acme-web";
    process.env["KEYCLOAK_AUDIENCE"] = "acme-api";
    const cfg = buildPublicAuthConfig();
    expect(cfg.keycloak).toEqual({
      url: "https://auth.example.com",
      realm: "acme",
      clientId: "acme-web",
      audience: "acme-api",
    });
  });

  it("NEVER leaks a client secret in any mode", () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    process.env["KEYCLOAK_URL"] = "http://keycloak:8180";
    const cfg = buildPublicAuthConfig();
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toMatch(/secret/i);
    expect((cfg.keycloak as Record<string, unknown>)["secret"]).toBeUndefined();
  });
});
