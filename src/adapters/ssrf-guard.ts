/**
 * src/adapters/ssrf-guard.ts — T-0497 SSRF-hardening for LLM-egress.
 *
 * Blocks requests to private/loopback/link-local/metadata IP ranges before
 * the bearer-key-carrying HTTP request is made. Applied at the single common
 * egress point (OpenAILlmPort._post) so every call path — assistant, /test,
 * future adapters — is covered by one guard rather than per-route checks.
 *
 * WHY BOTH LITERAL-IP AND DNS-RESOLVED IP CHECK:
 *   A URL like https://10.0.0.1/ is an obvious SSRF target, but so is
 *   https://evil.example.com/ if that hostname resolves to a private IP
 *   (DNS rebinding or internal-pointing A record). We therefore:
 *     1. Check the literal URL host — catches IP literals without a DNS round-trip.
 *     2. Resolve the hostname via dns.promises.lookup (forces a real DNS query).
 *     3. Check the resolved IP — catches any name that maps to a private range.
 *
 * TOCTOU NOTE (residual risk):
 *   There is an inherent TOCTOU gap: we resolve once before the request, but
 *   a DNS rebind attack could change the answer between our lookup and Node's
 *   internal getaddrinfo call inside https.request. This is the classic
 *   "Time-of-check / Time-of-use" SSRF residual. Full mitigation requires
 *   binding a fixed IP at the socket level (connect hook / custom dns resolver)
 *   which is an infrastructure-level control. This guard eliminates the easy
 *   cases (literal private IPs + static internal DNS) and is noted as a
 *   residual risk in the task brief.
 *
 * BLOCKED RANGES:
 *   IPv4 private/loopback/link-local/metadata:
 *     127.0.0.0/8   — loopback
 *     10.0.0.0/8    — RFC-1918 private
 *     172.16.0.0/12 — RFC-1918 private
 *     192.168.0.0/16— RFC-1918 private
 *     169.254.0.0/16— link-local / AWS+GCP+Azure metadata (169.254.169.254)
 *   IPv6 private/loopback:
 *     ::1           — IPv6 loopback
 *     fc00::/7      — unique-local (fc00:: and fd00:: prefix)
 *   Also blocked by name:
 *     "localhost"   — name that maps to 127.x or ::1
 */

import dns from "node:dns";

// ---------------------------------------------------------------------------
// IP range matchers (pure functions — no I/O, exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` is an IPv4 address that falls within a blocked range.
 * Input is expected to be a dotted-decimal IPv4 string.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    // Malformed — treat as blocked (fail-safe).
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — RFC-1918
  if (a === 10) return true;
  // 172.16.0.0/12 — RFC-1918 (172.16–172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC-1918
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local / metadata service
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Returns true if `ip` is an IPv6 address that falls within a blocked range.
 * We handle the common cases: loopback (::1) and unique-local (fc00::/7).
 */
export function isPrivateIpv6(ip: string): boolean {
  // Strip brackets that may wrap an IPv6 literal in a URL host.
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();

  // ::1 — IPv6 loopback
  if (addr === "::1") return true;
  // Expanded loopback forms
  if (addr === "0:0:0:0:0:0:0:1") return true;

  // fc00::/7 — unique-local (first byte fc or fd, i.e. top 7 bits = 1111110x)
  // Both fc and fd have the 7-bit prefix 1111110.
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;

  return false;
}

/**
 * Returns true if `host` is the literal string "localhost" (any case),
 * which always maps to 127.x or ::1.
 */
export function isLocalhostName(host: string): boolean {
  return host.toLowerCase() === "localhost";
}

/**
 * Returns true if `host` looks like a bare IPv4 address (dotted-decimal).
 */
export function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Returns true if `host` looks like an IPv6 address (with or without brackets).
 * Heuristic: contains `:` after stripping brackets.
 */
export function isIpv6Literal(host: string): boolean {
  const stripped = host.replace(/^\[|\]$/g, "");
  return stripped.includes(":");
}

// ---------------------------------------------------------------------------
// DNS lookup type — injectable for testing
// ---------------------------------------------------------------------------

export type DnsLookupFn = (
  hostname: string,
  opts: { family: 0 },
) => Promise<{ address: string; family: number }>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Error thrown when an endpoint is blocked by the SSRF guard.
 * The message is safe to surface to the caller (no internal IP detail that
 * would help an attacker map the network — we say "private range" not the IP).
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * assertSafeEndpointWithLookup — testable core (accepts an injected DNS lookup fn).
 *
 * Steps:
 *   1. Parse the URL; extract hostname.
 *   2. If hostname is "localhost" → block immediately (no DNS).
 *   3. If hostname is an IPv4 literal → check isPrivateIpv4 (no DNS).
 *   4. If hostname is an IPv6 literal → check isPrivateIpv6 (no DNS).
 *   5. Otherwise (DNS name) → resolve via lookup and check the resolved IP.
 *
 * Throws SsrfBlockedError if the target is blocked.
 * Re-throws DNS errors as-is (ENOTFOUND etc.) — they are not a security issue;
 * the request will fail anyway and the caller maps them to user messages.
 */
export async function assertSafeEndpointWithLookup(
  endpoint: string,
  lookup: DnsLookupFn,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SsrfBlockedError(
      `SSRF guard: malformed endpoint URL (cannot parse): ${endpoint.slice(0, 80)}`,
    );
  }

  // url.hostname strips brackets from IPv6 literals.
  const host = url.hostname;

  // 1. localhost name
  if (isLocalhostName(host)) {
    throw new SsrfBlockedError(
      "SSRF guard: endpoint resolves to a private/loopback host (localhost is not permitted)",
    );
  }

  // 2. IPv4 literal
  if (isIpv4Literal(host)) {
    if (isPrivateIpv4(host)) {
      throw new SsrfBlockedError(
        "SSRF guard: endpoint targets a private or reserved IPv4 range (blocked)",
      );
    }
    // Public IPv4 literal — no DNS to resolve, allow.
    return;
  }

  // 3. IPv6 literal (URL.hostname strips brackets already)
  if (isIpv6Literal(host)) {
    if (isPrivateIpv6(host)) {
      throw new SsrfBlockedError(
        "SSRF guard: endpoint targets a private or loopback IPv6 range (blocked)",
      );
    }
    // Public IPv6 literal — allow.
    return;
  }

  // 4. DNS name — resolve and check the resolved IP.
  // We use the injected lookup fn (production = dns.promises.lookup;
  // tests = controllable stub so no real network call is made).
  // family:0 = accept both IPv4 and IPv6.
  const result = await lookup(host, { family: 0 });
  const resolvedAddress = result.address;
  const resolvedFamily = result.family;

  if (resolvedFamily === 4) {
    if (isPrivateIpv4(resolvedAddress)) {
      throw new SsrfBlockedError(
        "SSRF guard: endpoint hostname resolves to a private or reserved IPv4 range (blocked)",
      );
    }
  } else if (resolvedFamily === 6) {
    if (isPrivateIpv6(resolvedAddress)) {
      throw new SsrfBlockedError(
        "SSRF guard: endpoint hostname resolves to a private or loopback IPv6 range (blocked)",
      );
    }
  }
  // resolvedFamily is always 4 or 6 per the Node.js dns.promises.lookup contract.
}

/**
 * assertSafeEndpoint — production entry point. Uses the real system DNS resolver.
 * Call this from OpenAILlmPort._post BEFORE issuing the HTTPS request.
 */
export async function assertSafeEndpoint(endpoint: string): Promise<void> {
  return assertSafeEndpointWithLookup(
    endpoint,
    // dns.promises.lookup has overloads; we cast to match our simplified DnsLookupFn type.
    (hostname, opts) =>
      dns.promises.lookup(hostname, opts) as Promise<{ address: string; family: number }>,
  );
}
