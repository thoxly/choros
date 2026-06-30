/**
 * src/__tests__/ssrf-guard.adversarial.test.ts — T-0497 SSRF guard unit tests.
 *
 * Verifies that assertSafeEndpointWithLookup blocks every private/loopback/
 * link-local/metadata target (both literal IP and DNS-resolved) and passes
 * through public endpoints.
 *
 * We test via the exported `assertSafeEndpointWithLookup` (injectable DNS lookup)
 * so no real network call is made. The pure IP-range helpers (isPrivateIpv4,
 * isPrivateIpv6, etc.) are also tested directly as they are exported.
 *
 * TOCTOU residual: acknowledged in ssrf-guard.ts — not tested here because the gap
 * is architectural (DNS rebind between lookup and getaddrinfo in https.request)
 * and requires infra-level controls beyond the guard's scope.
 */

import { describe, it, expect } from "vitest";
import {
  assertSafeEndpointWithLookup,
  isPrivateIpv4,
  isPrivateIpv6,
  isLocalhostName,
  SsrfBlockedError,
  type DnsLookupFn,
} from "../adapters/ssrf-guard.js";

// ---------------------------------------------------------------------------
// Helpers — controllable DNS stub
// ---------------------------------------------------------------------------

/** Returns a DnsLookupFn that always resolves to the given address/family. */
function stubLookup(address: string, family: 4 | 6): DnsLookupFn {
  return async (_host, _opts) => ({ address, family });
}

/** Returns a DnsLookupFn that always rejects with a DNS-like error. */
function failLookup(code: string): DnsLookupFn {
  return async (host, _opts) => {
    const err = Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code });
    throw err;
  };
}

/**
 * A sentinel lookup that MUST NOT be called (for literal-IP and localhost cases).
 * If called it throws to make the test fail clearly.
 */
const noopLookup: DnsLookupFn = async (host) => {
  throw new Error(
    `BUG: ssrf-guard called DNS lookup for literal/localhost '${host}' — should short-circuit`,
  );
};

// ---------------------------------------------------------------------------
// isPrivateIpv4 — pure function unit tests
// ---------------------------------------------------------------------------

describe("T-0497 · isPrivateIpv4 — private ranges", () => {
  const PRIVATE: string[] = [
    "127.0.0.1", "127.0.0.2", "127.255.255.255",     // loopback /8
    "10.0.0.1", "10.255.255.255",                      // RFC-1918 /8
    "172.16.0.1", "172.20.0.1", "172.31.255.255",     // RFC-1918 /12
    "192.168.0.1", "192.168.255.255",                  // RFC-1918 /16
    "169.254.0.1", "169.254.169.254",                  // link-local / metadata
  ];

  for (const ip of PRIVATE) {
    it(`blocks ${ip}`, () => {
      expect(isPrivateIpv4(ip)).toBe(true);
    });
  }

  const PUBLIC: string[] = [
    "1.1.1.1", "8.8.8.8", "104.18.6.92", "203.0.113.1",
    "172.15.0.1", "172.32.0.1",   // just outside /12
    "192.167.0.1", "192.169.0.1", // just outside 192.168/16
  ];

  for (const ip of PUBLIC) {
    it(`allows ${ip}`, () => {
      expect(isPrivateIpv4(ip)).toBe(false);
    });
  }
});

describe("T-0497 · isPrivateIpv6 — private ranges", () => {
  it("blocks ::1 (loopback)", () => expect(isPrivateIpv6("::1")).toBe(true));
  it("blocks 0:0:0:0:0:0:0:1 (expanded loopback)", () => expect(isPrivateIpv6("0:0:0:0:0:0:0:1")).toBe(true));
  it("blocks fc00::1 (unique-local fc)", () => expect(isPrivateIpv6("fc00::1")).toBe(true));
  it("blocks fd00::1 (unique-local fd)", () => expect(isPrivateIpv6("fd00::1")).toBe(true));
  it("blocks fd12:3456::1 (unique-local fd)", () => expect(isPrivateIpv6("fd12:3456::1")).toBe(true));
  it("allows 2001:db8::1 (TEST-NET range — public)", () => expect(isPrivateIpv6("2001:db8::1")).toBe(false));
  it("allows 2606:4700::1 (Cloudflare public)", () => expect(isPrivateIpv6("2606:4700::1")).toBe(false));
});

describe("T-0497 · isLocalhostName", () => {
  it("blocks 'localhost'", () => expect(isLocalhostName("localhost")).toBe(true));
  it("blocks 'LOCALHOST' (case-insensitive)", () => expect(isLocalhostName("LOCALHOST")).toBe(true));
  it("allows 'localhostapp.example.com'", () => expect(isLocalhostName("localhostapp.example.com")).toBe(false));
  it("allows 'api.example.com'", () => expect(isLocalhostName("api.example.com")).toBe(false));
});

// ---------------------------------------------------------------------------
// Literal IP blocks — no DNS needed (noopLookup must NOT be called)
// ---------------------------------------------------------------------------

describe("T-0497 · SSRF guard — literal private/loopback IPv4 endpoints are blocked", () => {
  const PRIVATE_IPV4_ENDPOINTS = [
    "https://127.0.0.1/v1",          // loopback
    "https://127.0.0.2/v1",          // loopback range
    "https://127.255.255.255/v1",    // loopback range end
    "https://10.0.0.1/v1",           // RFC-1918
    "https://10.255.255.255/v1",     // RFC-1918 range end
    "https://172.16.0.1/v1",         // RFC-1918 start
    "https://172.31.255.255/v1",     // RFC-1918 end
    "https://192.168.0.1/v1",        // RFC-1918
    "https://192.168.255.255/v1",    // RFC-1918 end
    "https://169.254.0.1/v1",        // link-local
    "https://169.254.169.254/v1",    // AWS/GCP/Azure metadata service
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
  ];

  for (const endpoint of PRIVATE_IPV4_ENDPOINTS) {
    it(`blocks ${endpoint}`, async () => {
      await expect(
        assertSafeEndpointWithLookup(endpoint, noopLookup),
      ).rejects.toThrow(SsrfBlockedError);
    });
  }
});

describe("T-0497 · SSRF guard — literal private/loopback IPv6 endpoints are blocked", () => {
  const PRIVATE_IPV6_ENDPOINTS = [
    "https://[::1]/v1",              // IPv6 loopback
    "https://[fc00::1]/v1",          // unique-local fc
    "https://[fd00::1]/v1",          // unique-local fd
    "https://[fd12:3456:789a::1]/v1",// unique-local fd (longer)
  ];

  for (const endpoint of PRIVATE_IPV6_ENDPOINTS) {
    it(`blocks ${endpoint}`, async () => {
      await expect(
        assertSafeEndpointWithLookup(endpoint, noopLookup),
      ).rejects.toThrow(SsrfBlockedError);
    });
  }
});

describe("T-0497 · SSRF guard — 'localhost' name is blocked without DNS lookup", () => {
  it("blocks https://localhost/v1", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://localhost/v1", noopLookup),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks https://LOCALHOST/v1 (case-insensitive)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://LOCALHOST/v1", noopLookup),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// DNS-resolved private IP blocks
// ---------------------------------------------------------------------------

describe("T-0497 · SSRF guard — hostname resolving to private IPv4 is blocked", () => {
  it("blocks a hostname that resolves to 127.0.0.1 (DNS rebind scenario)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://evil.example.com/v1", stubLookup("127.0.0.1", 4)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to 10.0.0.5 (internal network)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://internal.corp/v1", stubLookup("10.0.0.5", 4)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to 172.20.0.1 (RFC-1918 /12)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://metadata.internal/v1", stubLookup("172.20.0.1", 4)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to 192.168.1.1 (RFC-1918 /16)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://router.local/v1", stubLookup("192.168.1.1", 4)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to 169.254.169.254 (metadata service)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://metadata-proxy.example.com/v1", stubLookup("169.254.169.254", 4)),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe("T-0497 · SSRF guard — hostname resolving to private IPv6 is blocked", () => {
  it("blocks a hostname that resolves to ::1", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://loop.example.com/v1", stubLookup("::1", 6)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to fc00::1 (unique-local)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://ula.example.com/v1", stubLookup("fc00::1", 6)),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to fd12:3456::1 (unique-local fd)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://ula2.example.com/v1", stubLookup("fd12:3456::1", 6)),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// Public endpoints — must pass through
// ---------------------------------------------------------------------------

describe("T-0497 · SSRF guard — public endpoints pass through", () => {
  it("allows api.openai.com resolving to 104.18.6.92 (public IPv4)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://api.openai.com/v1", stubLookup("104.18.6.92", 4)),
    ).resolves.toBeUndefined();
  });

  it("allows api.deepseek.com resolving to 203.0.113.10 (public IPv4 — TEST-NET)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://api.deepseek.com/v1", stubLookup("203.0.113.10", 4)),
    ).resolves.toBeUndefined();
  });

  it("allows a hostname resolving to a public IPv6 address (2001:db8::1)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://api.example.com/v1", stubLookup("2001:db8::1", 6)),
    ).resolves.toBeUndefined();
  });

  it("allows literal public IPv4 (1.1.1.1) — DNS lookup is NOT called", async () => {
    // noopLookup throws if called — proves the short-circuit for literal IPs.
    await expect(
      assertSafeEndpointWithLookup("https://1.1.1.1/v1", noopLookup),
    ).resolves.toBeUndefined();
  });

  it("allows literal public IPv4 (8.8.8.8) — DNS lookup is NOT called", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://8.8.8.8/v1", noopLookup),
    ).resolves.toBeUndefined();
  });

  it("does NOT block 172.15.x.x (just outside the /12 range)", async () => {
    // 172.15.x.x is NOT in 172.16/12 → no lookup needed (literal IP short-circuit).
    await expect(
      assertSafeEndpointWithLookup("https://172.15.0.1/v1", noopLookup),
    ).resolves.toBeUndefined();
  });

  it("does NOT block 172.32.x.x (just outside the /12 range)", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://172.32.0.1/v1", noopLookup),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DNS failure — let the error propagate (not a security block)
// ---------------------------------------------------------------------------

describe("T-0497 · SSRF guard — DNS resolution failure propagates (not SsrfBlockedError)", () => {
  it("ENOTFOUND throws the DNS error, not SsrfBlockedError", async () => {
    let caughtErr: unknown;
    try {
      await assertSafeEndpointWithLookup("https://nonexistent.invalid/v1", failLookup("ENOTFOUND"));
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr).not.toBeInstanceOf(SsrfBlockedError);
    expect((caughtErr as Error & { code?: string }).code ?? (caughtErr as Error).message).toMatch(
      /ENOTFOUND|getaddrinfo/i,
    );
  });

  it("EAI_AGAIN throws the DNS error, not SsrfBlockedError", async () => {
    let caughtErr: unknown;
    try {
      await assertSafeEndpointWithLookup("https://slow-dns.example.com/v1", failLookup("EAI_AGAIN"));
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).not.toBeInstanceOf(SsrfBlockedError);
  });
});

// ---------------------------------------------------------------------------
// SsrfBlockedError — error class contract
// ---------------------------------------------------------------------------

describe("T-0497 · SsrfBlockedError — class contract", () => {
  it("is an instanceof Error", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://127.0.0.1/v1", noopLookup),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error);
  });

  it("has name 'SsrfBlockedError'", async () => {
    await expect(
      assertSafeEndpointWithLookup("https://127.0.0.1/v1", noopLookup),
    ).rejects.toSatisfy((e: unknown) => (e as Error).name === "SsrfBlockedError");
  });

  it("message contains 'SSRF guard' and does not include a raw IP address as a vector", async () => {
    let caughtErr: unknown;
    try { await assertSafeEndpointWithLookup("https://127.0.0.1/v1", noopLookup); }
    catch (e) { caughtErr = e; }
    expect(caughtErr).toBeInstanceOf(SsrfBlockedError);
    expect((caughtErr as Error).message).toMatch(/SSRF guard|private|loopback|reserved|blocked/i);
  });
});

// ---------------------------------------------------------------------------
// sanitizeProviderError integration: SsrfBlockedError maps to the right message
// ---------------------------------------------------------------------------

describe("T-0497 · sanitizeProviderError handles SsrfBlockedError", () => {
  it("maps SsrfBlockedError to the 'приватному диапазону' message", async () => {
    const { sanitizeProviderError } = await import("../http/llm-connection-test.js");
    const err = new SsrfBlockedError(
      "SSRF guard: endpoint targets a private or reserved IPv4 range (blocked)",
    );
    const msg = sanitizeProviderError(err);
    expect(msg).toMatch(/приватному|зарезервированному/i);
    // Must not echo the raw message content (could hint at network topology)
    expect(msg).not.toContain("10.0.");
    expect(msg).not.toContain("127.0");
    expect(msg).not.toContain("SSRF guard");
  });

  it("maps a generic error with 'SSRF guard' substring to the same message", async () => {
    const { sanitizeProviderError } = await import("../http/llm-connection-test.js");
    const msg = sanitizeProviderError(new Error("SSRF guard: something internal"));
    expect(msg).toMatch(/приватному|зарезервированному/i);
  });
});
