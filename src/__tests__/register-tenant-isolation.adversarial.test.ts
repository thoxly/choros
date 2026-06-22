/**
 * src/__tests__/register-tenant-isolation.adversarial.test.ts
 *
 * T-0427 · ADVERSARY (Враг red-team) — tenant-isolation at self-registration time.
 *
 * Surface under attack: src/core/register.ts (registerTenant / slugifyOrgName /
 * slugCandidate) + src/http/register.ts (POST /api/register).
 *
 * These are PURE, runnable-NOW tests (in-memory fake pg pool + InMemoryKeycloakUserPort,
 * no live Postgres). They LOCK the isolation invariants so a future regression that
 * (a) starts trusting a client-supplied tenant_id/slug, (b) re-introduces the
 * Cyrillic→'org' slug collapse, or (c) drops the slug-collision retry, fails loudly.
 *
 * Attacks (per the red-team brief):
 *   A1  Slug collision  — two DIFFERENT org names that could normalize/transliterate to
 *       the same slug, all-Cyrillic / empty / whitespace / symbol-only / emoji / very-long /
 *       case-only / diacritic-only names → each registration yields a DISTINCT tenant
 *       (the DB UNIQUE(slug) + retry-on-23505 loop guarantees no two collapse into one
 *       shared workspace).
 *   A2  tenant_id reuse/overlap — tenant_id is server-generated (randomUUID), NEVER
 *       client-supplied or client-influenced. A crafted payload injecting
 *       tenantId / tenant_id / slug / id fields must be IGNORED (the HTTP route reads only
 *       orgName/email/password); two registrations always get DISTINCT server-generated ids.
 *
 * Companion DB-backed proof (clean isolation A3 + owner-grant scope A4, requires live PG):
 *   ci/checks/db/register-tenant-isolation.adversarial.test.ts  (CI-only).
 *
 * RESULT SUMMARY (see final report): all assertions below are GREEN → isolation HOLDS
 * at the pure/HTTP layer. No production code changed.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import pg from "pg";

import { Router } from "../http/router.js";
import { registerRegisterRoutes } from "../http/register.js";
import { registerTenant, slugifyOrgName } from "../core/register.js";
import { InMemoryKeycloakUserPort } from "../keycloak/fake-user-port.js";

// ---------------------------------------------------------------------------
// Fake pool that models the DB UNIQUE(slug) constraint (migration 013:17).
//
// Real behaviour: choros.tenant has UNIQUE(slug) GLOBALLY (not per-tenant). So the
// SECOND registration that tries to INSERT a tenant row with an already-taken slug
// gets a 23505 unique-violation, which registerTenant retries with a random suffix.
// This in-memory pool reproduces that: it remembers every committed slug and throws
// 23505 if a slug is re-inserted, so two same-normalizing names cannot collapse into
// one tenant row.
// ---------------------------------------------------------------------------

class SharedSlugRegistry {
  readonly committedSlugs = new Set<string>();
  /** tenant_id → slug, for every COMMITTED tenant row. */
  readonly tenantById = new Map<string, string>();
}

class UniqueSlugClient {
  // slug staged inside the current (un-committed) transaction
  private pendingSlug: string | null = null;
  private pendingTenantId: string | null = null;

  constructor(private readonly registry: SharedSlugRegistry) {}

  async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;

    if (text.startsWith("BEGIN")) {
      this.pendingSlug = null;
      this.pendingTenantId = null;
      return { rows: [] };
    }
    if (text.startsWith("ROLLBACK")) {
      this.pendingSlug = null;
      this.pendingTenantId = null;
      return { rows: [] };
    }
    if (text.startsWith("COMMIT")) {
      if (this.pendingSlug !== null && this.pendingTenantId !== null) {
        this.registry.committedSlugs.add(this.pendingSlug);
        this.registry.tenantById.set(this.pendingTenantId, this.pendingSlug);
      }
      this.pendingSlug = null;
      this.pendingTenantId = null;
      return { rows: [] };
    }

    if (text.includes("INSERT") && text.includes("choros.tenant")) {
      // $1 = tenantId, $2 = slug (per register.ts:237-239)
      const tenantId = String(vals?.[0]);
      const slug = String(vals?.[1]);
      if (this.registry.committedSlugs.has(slug)) {
        // UNIQUE(slug) violation — exactly what live PG raises.
        throw Object.assign(new Error("duplicate key value violates unique constraint \"tenant_slug_key\""), {
          code: "23505",
        });
      }
      this.pendingSlug = slug;
      this.pendingTenantId = tenantId;
      return { rows: [] };
    }

    // All other INSERT/SET LOCAL/etc. are no-ops for this model.
    return { rows: [] };
  }

  release(): void { /* no-op */ }
}

function makeSharedPool(registry: SharedSlugRegistry): pg.Pool {
  return {
    connect: async () => new UniqueSlugClient(registry) as unknown as pg.PoolClient,
  } as unknown as pg.Pool;
}

// A capturing pool that records every query (for asserting what got sent to the DB).
class CapturingClient {
  constructor(private readonly sink: Array<{ text: string; values?: unknown[] }>) {}
  async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    const vals = typeof textOrConfig === "string" ? values : textOrConfig.values;
    this.sink.push({ text, values: vals });
    return { rows: [] };
  }
  release(): void { /* no-op */ }
}

function makeCapturingPool(sink: Array<{ text: string; values?: unknown[] }>): pg.Pool {
  return {
    connect: async () => new CapturingClient(sink) as unknown as pg.PoolClient,
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function register(pool: pg.Pool, kc: InMemoryKeycloakUserPort, orgName: string, email: string) {
  return registerTenant({ pool, kc, nowMs: () => 1_700_000_000_000 }, { orgName, email, password: "password123" });
}

// ===========================================================================
// A1 — Slug collision: distinct names that normalize alike → DISTINCT tenants.
//
// We register a SEQUENCE of names through the SAME shared-slug pool (modeling
// the global UNIQUE(slug)). The invariant: N successful registrations ⇒ N distinct
// tenant_ids AND N distinct committed slugs. No two collapse into one workspace.
// ===========================================================================

describe("A1 — slug collision: colliding org names get DISTINCT tenants (no shared workspace)", () => {
  async function registerAll(names: Array<{ orgName: string; email: string }>) {
    const registry = new SharedSlugRegistry();
    const pool = makeSharedPool(registry);
    const kc = new InMemoryKeycloakUserPort();
    const results = [];
    for (const n of names) {
      results.push(await register(pool, kc, n.orgName, n.email));
    }
    return { results, registry };
  }

  function assertAllDistinct(results: Array<{ tenantId: string; tenantSlug: string }>, registry: SharedSlugRegistry) {
    const ids = results.map((r) => r.tenantId);
    const slugs = results.map((r) => r.tenantSlug);
    // Distinct server-generated tenant ids
    expect(new Set(ids).size).toBe(results.length);
    // Distinct committed slugs (the global UNIQUE(slug) is honoured)
    expect(new Set(slugs).size).toBe(results.length);
    // The registry's committed-slug count equals the number of registrations
    expect(registry.committedSlugs.size).toBe(results.length);
    expect(registry.tenantById.size).toBe(results.length);
  }

  it("two SAME display names ('Acme' twice) → 2 distinct tenants, 2 distinct slugs", async () => {
    const { results, registry } = await registerAll([
      { orgName: "Acme", email: "a@a.com" },
      { orgName: "Acme", email: "b@b.com" },
    ]);
    assertAllDistinct(results, registry);
    // First keeps the pretty base slug; second gets a suffixed variant.
    expect(results[0].tenantSlug).toBe("acme");
    expect(results[1].tenantSlug).not.toBe("acme");
    expect(results[1].tenantSlug.startsWith("acme-")).toBe(true);
  });

  it("two DIFFERENT Cyrillic names that transliterate to the SAME slug → 2 distinct tenants", async () => {
    // "Тест" → "test"; a Latin "Test" also → "test". They collide on slug.
    const { results, registry } = await registerAll([
      { orgName: "Тест", email: "c1@a.com" },   // cyrillic → "test"
      { orgName: "Test", email: "c2@a.com" },   // latin    → "test"
    ]);
    assertAllDistinct(results, registry);
    expect(results[0].tenantSlug).toBe("test");
    expect(results[1].tenantSlug).not.toBe("test");
  });

  it("names differing ONLY by case ('Foo' vs 'FOO' vs 'foo') → 3 distinct tenants", async () => {
    const { results, registry } = await registerAll([
      { orgName: "Foo", email: "f1@a.com" },
      { orgName: "FOO", email: "f2@a.com" },
      { orgName: "foo", email: "f3@a.com" },
    ]);
    assertAllDistinct(results, registry);
  });

  it("names differing ONLY by Cyrillic diacritic (ё vs е → both 'e') → distinct tenants", async () => {
    // "Приём" → "priem", "Прием" → "priem" (ё and е both map to 'e').
    const { results, registry } = await registerAll([
      { orgName: "Приём", email: "d1@a.com" },
      { orgName: "Прием", email: "d2@a.com" },
    ]);
    assertAllDistinct(results, registry);
    expect(results[0].tenantSlug).toBe("priem");
    expect(results[1].tenantSlug).not.toBe("priem");
  });

  it("symbol-only / emoji / whitespace names (all slugify to fallback 'org') → distinct tenants", async () => {
    // EVERY one of these normalizes to the bare fallback "org" — the WORST collision
    // case and the exact class of the historical prior-bug. They MUST NOT share a tenant.
    const { results, registry } = await registerAll([
      { orgName: "!!!", email: "s1@a.com" },        // symbols only → "org"
      { orgName: "   .   ", email: "s2@a.com" },    // whitespace+dot → "org"
      { orgName: "🚀🚀🚀", email: "s3@a.com" },      // emoji only → "org"
      { orgName: "---", email: "s4@a.com" },        // dashes only → "org"
      { orgName: "@#$%", email: "s5@a.com" },       // punctuation → "org"
    ]);
    // Sanity: every base slug is indeed the fallback (proves they all collide).
    for (const n of ["!!!", "   .   ", "🚀🚀🚀", "---", "@#$%"]) {
      expect(slugifyOrgName(n)).toBe("org");
    }
    // Yet all 5 registrations land in 5 DISTINCT tenants with 5 DISTINCT slugs.
    assertAllDistinct(results, registry);
    expect(results[0].tenantSlug).toBe("org");
    for (let i = 1; i < results.length; i++) {
      expect(results[i].tenantSlug).not.toBe("org");
      expect(results[i].tenantSlug.startsWith("org-")).toBe(true);
    }
  });

  it("all-Cyrillic identical names ('Компания' twice) → distinct tenants, latin slugs", async () => {
    const { results, registry } = await registerAll([
      { orgName: "Компания", email: "k1@a.com" },
      { orgName: "Компания", email: "k2@a.com" },
    ]);
    assertAllDistinct(results, registry);
    expect(/^[a-z0-9-]+$/.test(results[0].tenantSlug)).toBe(true);
    expect(results[0].tenantSlug).not.toBe("org");
  });

  it("long names (≤120) that share an 80-char prefix → distinct tenants (truncation collision)", async () => {
    // orgName is capped at 120 by validation; slugifyOrgName truncates the SLUG at 80.
    // Two names sharing the first 100 'a's differ only past char 80 of the slug, so
    // their TRUNCATED base slugs collide → the retry loop must still keep them distinct.
    const prefix = "a".repeat(100);
    expect(slugifyOrgName(prefix + "-xxx")).toBe(slugifyOrgName(prefix + "-yyy")); // proves collision
    const { results, registry } = await registerAll([
      { orgName: prefix + "-xxx", email: "l1@a.com" },
      { orgName: prefix + "-yyy", email: "l2@a.com" },
    ]);
    assertAllDistinct(results, registry);
    // Both slugs stay within the 80-char cap.
    for (const r of results) expect(r.tenantSlug.length).toBeLessThanOrEqual(80);
  });

  it("ten identical-name registrations → 10 distinct tenants (retry budget holds for realistic N)", async () => {
    const names = Array.from({ length: 10 }, (_, i) => ({ orgName: "Contested", email: `c${i}@a.com` }));
    const { results, registry } = await registerAll(names);
    assertAllDistinct(results, registry);
  });
});

// ===========================================================================
// A2 — tenant_id is server-generated, never client-supplied/influenced.
// ===========================================================================

describe("A2 — tenant_id/slug cannot be steered by the client", () => {
  it("HTTP route IGNORES injected tenantId/tenant_id/id/slug fields in the body", async () => {
    const sink: Array<{ text: string; values?: unknown[] }> = [];
    const pool = makeCapturingPool(sink);
    const kc = new InMemoryKeycloakUserPort();
    const router = new Router();
    registerRegisterRoutes(router, { pool, kc });
    const server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));

    // The forged tenant id the attacker tries to ride into.
    const FORGED = "deadbeef-dead-dead-dead-deaddeaddead";
    const FORGED_SLUG = "victim-tenant";

    try {
      const resp = await makeRequest(server, "POST", "/api/register", {
        orgName: "Attacker Co",
        email: "atk@evil.com",
        password: "password123",
        // injection attempts — every plausible field name:
        tenantId: FORGED,
        tenant_id: FORGED,
        id: FORGED,
        slug: FORGED_SLUG,
        tenantSlug: FORGED_SLUG,
      });
      expect(resp.status).toBe(201);
      const out = JSON.parse(resp.body) as { tenantId: string; tenantSlug: string };

      // The response tenant id is NOT the forged value.
      expect(out.tenantId).not.toBe(FORGED);
      // It's a fresh UUID.
      expect(out.tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      // The slug is derived from orgName, NOT the forged slug.
      expect(out.tenantSlug).toBe("attacker-co");
      expect(out.tenantSlug).not.toBe(FORGED_SLUG);

      // And the forged id/slug never reached the DB tenant INSERT.
      const tenantInsert = sink.find((q) => q.text.includes("INSERT") && q.text.includes("choros.tenant"));
      expect(tenantInsert).toBeDefined();
      expect(JSON.stringify(tenantInsert!.values)).not.toContain(FORGED);
      expect(JSON.stringify(tenantInsert!.values)).not.toContain(FORGED_SLUG);
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    }
  });

  it("two registrations with IDENTICAL payloads still get DISTINCT server-generated tenant ids", async () => {
    const registry = new SharedSlugRegistry();
    const pool = makeSharedPool(registry);
    const kc = new InMemoryKeycloakUserPort();
    const r1 = await register(pool, kc, "Same Inc", "x@a.com");
    const r2 = await register(pool, kc, "Same Inc", "y@a.com");
    expect(r1.tenantId).not.toBe(r2.tenantId);
  });

  it("the GUC and DB INSERT both use the SERVER-generated tenant_id (self-ref tenant row)", async () => {
    const sink: Array<{ text: string; values?: unknown[] }> = [];
    const pool = makeCapturingPool(sink);
    const kc = new InMemoryKeycloakUserPort();
    const out = await register(pool, kc, "Self Ref Co", "self@a.com");

    // SET LOCAL choros.tenant_id = '<server uuid>' — must equal the returned tenantId.
    const setLocal = sink.find((q) => q.text.includes("SET LOCAL choros.tenant_id"));
    expect(setLocal).toBeDefined();
    expect(setLocal!.text).toContain(out.tenantId);
    // The interpolated value is a UUID (no SQL metacharacters could ride in — it's randomUUID).
    const m = setLocal!.text.match(/choros\.tenant_id = '([^']+)'/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The tenant INSERT writes tenant_id = id = the SAME server uuid (self-ref).
    const tenantInsert = sink.find((q) => q.text.includes("INSERT") && q.text.includes("choros.tenant"));
    expect(tenantInsert!.values?.[0]).toBe(out.tenantId);
  });

  it("ALL seeded rows (role/employee/role_assignment/grant) carry the SAME server tenant_id (no cross-tenant write)", async () => {
    const sink: Array<{ text: string; values?: unknown[] }> = [];
    const pool = makeCapturingPool(sink);
    const kc = new InMemoryKeycloakUserPort();
    const out = await register(pool, kc, "Scoped Co", "scoped@a.com");

    // Every INSERT into a tenant table must have $1 === the server tenant_id.
    const tenantTables = ["choros.tenant", "choros.role", "choros.employee", "choros.role_assignment", 'choros."grant"'];
    const inserts = sink.filter((q) => q.text.includes("INSERT") && tenantTables.some((t) => q.text.includes(t)));
    expect(inserts.length).toBeGreaterThanOrEqual(8); // tenant + role + emp + ra + 2 ra + agent emp + 2 grants...
    for (const ins of inserts) {
      // First bound param is always tenant_id in register.ts INSERTs.
      expect(ins.values?.[0]).toBe(out.tenantId);
    }
  });

  it("a non-string orgName injected as an object/array is coerced safely (no slug steering, no crash)", async () => {
    // The HTTP layer guards typeof === 'string', so non-string orgName becomes "" → VALIDATION.
    const sink: Array<{ text: string; values?: unknown[] }> = [];
    const pool = makeCapturingPool(sink);
    const kc = new InMemoryKeycloakUserPort();
    const router = new Router();
    registerRegisterRoutes(router, { pool, kc });
    const server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const resp = await makeRequest(server, "POST", "/api/register", {
        orgName: { malicious: "object" },
        email: "obj@a.com",
        password: "password123",
      });
      // Non-string orgName → "" → 400 VALIDATION (KC never called, no DB write).
      expect(resp.status).toBe(400);
      expect(kc.createCallCount).toBe(0);
      expect(sink.filter((q) => q.text.includes("INSERT")).length).toBe(0);
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    }
  });
});

// ===========================================================================
// Slug-derivation hardening — lock the transliteration/fallback so the historical
// "Cyrillic → 'org' collapse" bug can never silently regress.
// ===========================================================================

describe("slugifyOrgName — collision-relevant normalization is LOCKED", () => {
  it("distinct Cyrillic names produce distinct base slugs (the fixed prior bug)", () => {
    // Before the transliteration fix, BOTH of these collapsed to "" → "org".
    expect(slugifyOrgName("Браузер Приёмка")).not.toBe(slugifyOrgName("Браузер Два"));
    expect(slugifyOrgName("Браузер Приёмка")).not.toBe("org");
    expect(slugifyOrgName("Браузер Два")).not.toBe("org");
  });

  it("only genuinely empty-after-normalization names fall back to 'org'", () => {
    expect(slugifyOrgName("!!!")).toBe("org");
    expect(slugifyOrgName("   ")).toBe("org");
    expect(slugifyOrgName("🚀")).toBe("org");
    // A name with ANY latin/cyrillic letter does NOT fall back.
    expect(slugifyOrgName("a")).toBe("a");
    expect(slugifyOrgName("Я")).toBe("ya");
  });

  it("slug output is always lowercase [a-z0-9-], capped at 80, no leading/trailing dash", () => {
    const samples = ["UPPER", "Mixed-Case Org!!", "  spaces  ", "a".repeat(300), "Тест Орг", "🚀 Rocket 🚀"];
    for (const s of samples) {
      const slug = slugifyOrgName(s);
      expect(slug.length).toBeLessThanOrEqual(80);
      expect(/^[a-z0-9-]+$/.test(slug)).toBe(true);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });
});
