/**
 * src/__tests__/resolve-agent-slug.test.ts — T-0424 [SECURITY] unit tests for
 * resolveAgentSlugFromAuth in src/db/org.ts AND its DISJOINTNESS from the human
 * resolver resolveActorSlugFromAuth.
 *
 * Pure unit — no live Postgres. The fake pool models the production mapping
 *   agent_card (kc_client_id, employee_id) JOIN employee ON kind='agent' -> slug
 * by holding a map kc_client_id -> { slug, kind }. The agent resolver's SQL
 * filters `e.kind = 'agent'` and joins through agent_card (whose FK can ONLY
 * point at a kind='agent' employee), so the fake JOIN drops any row whose kind
 * is not 'agent' — exactly mirroring the production query + FK semantics.
 *
 * This proves the crux security property (ADR §3): the human and agent paths are
 * DISJOINT, each yields only its own kind, and neither lets a principal escalate
 * across kinds. The negative tests below assert agent↛human and human↛agent.
 *
 * Covers:
 *   (a) valid agent token (service-account-<clientId>) → resolves the AGENT slug
 *   (b) NEGATIVE agent↛human: an agent token cannot resolve a HUMAN employee even
 *       if a card row pointed at a human kind (FK/JOIN kind='agent' filter drops it)
 *   (c) NEGATIVE actorType gate: a HUMAN token routed into the agent resolver →
 *       null (the hard `actorType !== 'agent'` gate; human↛agent on this path)
 *   (d) preferred_username not "service-account-"-prefixed → null (fail-closed)
 *   (e) empty clientId after the prefix → null (fail-closed)
 *   (f) unknown kc_client_id (no agent_card) → null → caller 401 fail-closed
 *   (g) DISJOINTNESS: the SAME identity strings cannot resolve on BOTH paths —
 *       human↛agent (human resolver never returns an agent slug) and
 *       agent↛human (agent resolver never returns a human slug)
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  resolveAgentSlugFromAuth,
  resolveActorSlugFromAuth,
} from "../db/org.js";

// ---------------------------------------------------------------------------
// Fake pool for the AGENT resolver.
//
// cards: kc_client_id -> { slug, kind }. The production query is
//   SELECT e.slug FROM agent_card ac JOIN employee e
//     ON e.tenant_id=ac.tenant_id AND e.id=ac.employee_id
//    WHERE ac.kc_client_id=$1 AND e.kind='agent' LIMIT 1
// We emulate the JOIN + WHERE kind='agent': a card only yields a slug if its
// joined employee.kind === 'agent'. A card pointing at a human is dropped — the
// real agent_card FK (CHECK employee_kind='agent') makes that row impossible at
// the DB, and the kind='agent' WHERE clause excludes it even if it existed.
// ---------------------------------------------------------------------------

function makeAgentPool(
  cards: Map<string, { slug: string; kind: "agent" | "human" }>,
): { pool: Pool; queryCalls: string[] } {
  const queryCalls: string[] = [];

  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (_sql: string, params?: unknown[]): Promise<any> => {
      const kcClientId = (params ?? [])[0] as string | undefined;
      if (kcClientId !== undefined) queryCalls.push(kcClientId);
      const card = kcClientId !== undefined ? cards.get(kcClientId) : undefined;
      // JOIN ... WHERE e.kind = 'agent' — drop non-agent rows.
      if (card !== undefined && card.kind === "agent") {
        return { rows: [{ slug: card.slug }] };
      }
      return { rows: [] };
    },
    release: () => { /* no-op */ },
  } as unknown as PoolClient;

  const pool = { connect: async () => fakeClient } as unknown as Pool;
  return { pool, queryCalls };
}

// Fake pool for the HUMAN resolver (mirrors resolve-actor-slug.test.ts): only
// returns exists=true for slugs in existsSlugs, which represent kind='human' rows.
function makeHumanPool(existsSlugs: Set<string>): {
  pool: Pool;
  queryCalls: string[];
} {
  const queryCalls: string[] = [];
  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (_sql: string, params?: unknown[]): Promise<any> => {
      const slug = (params ?? [])[0] as string | undefined;
      if (slug !== undefined) queryCalls.push(slug);
      const exists = slug !== undefined && existsSlugs.has(slug);
      return { rows: [{ exists }] };
    },
    release: () => { /* no-op */ },
  } as unknown as PoolClient;
  const pool = { connect: async () => fakeClient } as unknown as Pool;
  return { pool, queryCalls };
}

const agentCtx = (preferredUsername: string, sub = "kc-svc-account-uuid") => ({
  sub,
  preferredUsername,
  actorType: "agent" as const,
});

// ---------------------------------------------------------------------------
// (a) valid agent token → resolves the AGENT slug
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (a) valid agent token resolves agent slug", () => {
  it("strips service-account- prefix → kc_client_id → agent_card → agent employee.slug", async () => {
    // KC: preferred_username = "service-account-agent-recon"; the card maps
    // kc_client_id "agent-recon" → agent employee slug "a-recon" (kind='agent').
    const cards = new Map([["agent-recon", { slug: "a-recon", kind: "agent" as const }]]);
    const { pool, queryCalls } = makeAgentPool(cards);

    const result = await resolveAgentSlugFromAuth(pool, agentCtx("service-account-agent-recon"));

    expect(result).toBe("a-recon");
    // The query keyed on the STRIPPED clientId, not the raw preferred_username.
    expect(queryCalls).toEqual(["agent-recon"]);
  });
});

// ---------------------------------------------------------------------------
// (b) NEGATIVE — agent ↛ human: agent resolver can NEVER return a human slug.
//
// Even if (impossibly, per the agent_card FK CHECK(employee_kind='agent')) a
// card row pointed at a kind='human' employee, the JOIN's WHERE e.kind='agent'
// filter drops it. The resolver returns null — it CANNOT yield a human slug.
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (b) agent token CANNOT resolve a human employee", () => {
  it("returns null when the (hypothetical) card row joins a kind='human' employee", async () => {
    // A card whose joined employee is kind='human' (e.g. an attacker trying to
    // point an agent client at a human like 'e-orlov'). The kind='agent' filter
    // — backed by the agent_card FK at the DB — excludes it.
    const cards = new Map([["agent-evil", { slug: "e-orlov", kind: "human" as const }]]);
    const { pool } = makeAgentPool(cards);

    const result = await resolveAgentSlugFromAuth(pool, agentCtx("service-account-agent-evil"));

    // PROOF agent↛human: a human-kind row is unreachable from the agent path.
    expect(result).toBeNull();
    expect(result).not.toBe("e-orlov");
  });
});

// ---------------------------------------------------------------------------
// (c) NEGATIVE — human ↛ agent on the agent path: the hard actorType gate.
//
// If a HUMAN token were ever routed into resolveAgentSlugFromAuth, the
// defense-in-depth `actorType !== 'agent'` gate returns null WITHOUT touching the
// DB. A human cannot ride the agent path even by mis-routing.
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (c) human actorType is rejected (no-op gate)", () => {
  it("returns null and issues NO query when actorType !== 'agent'", async () => {
    // A human ctx that even carries a valid-looking service-account preferred_username
    // and a real agent clientId in the cards map — still rejected by the kind gate.
    const cards = new Map([["agent-recon", { slug: "a-recon", kind: "agent" as const }]]);
    const { pool, queryCalls } = makeAgentPool(cards);

    const result = await resolveAgentSlugFromAuth(pool, {
      sub: "human-sub",
      preferredUsername: "service-account-agent-recon",
      actorType: "human",
    });

    // PROOF human↛agent: the agent resolver is a no-op for a human claim.
    expect(result).toBeNull();
    expect(queryCalls).toHaveLength(0); // gate short-circuits before any DB query
  });
});

// ---------------------------------------------------------------------------
// (d) preferred_username not service-account-prefixed → null (fail-closed)
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (d) non-service-account preferred_username → null", () => {
  it("returns null when preferred_username is not 'service-account-'-prefixed", async () => {
    const cards = new Map([["agent-recon", { slug: "a-recon", kind: "agent" as const }]]);
    const { pool, queryCalls } = makeAgentPool(cards);

    // A token claiming actor_type=agent but with a bare username (e.g. 'a-recon')
    // — must NOT be treated as a clientId; fail-closed.
    const result = await resolveAgentSlugFromAuth(pool, agentCtx("a-recon"));

    expect(result).toBeNull();
    expect(queryCalls).toHaveLength(0); // never reaches the DB
  });
});

// ---------------------------------------------------------------------------
// (e) empty clientId after the prefix → null (fail-closed)
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (e) empty clientId after prefix → null", () => {
  it("returns null when preferred_username is exactly 'service-account-'", async () => {
    const { pool, queryCalls } = makeAgentPool(new Map());

    const result = await resolveAgentSlugFromAuth(pool, agentCtx("service-account-"));

    expect(result).toBeNull();
    expect(queryCalls).toHaveLength(0); // empty clientId → no DB query
  });
});

// ---------------------------------------------------------------------------
// (f) unknown kc_client_id (no agent_card) → null → caller 401 fail-closed
// ---------------------------------------------------------------------------

describe("T-0424 resolveAgentSlugFromAuth — (f) unknown kc_client_id → null", () => {
  it("returns null when no agent_card exists for the clientId (unprovisioned client)", async () => {
    const { pool, queryCalls } = makeAgentPool(new Map()); // no cards at all

    const result = await resolveAgentSlugFromAuth(pool, agentCtx("service-account-agent-ghost"));

    // PROOF: a KC client unknown to this Choros (no agent_card) resolves to null.
    expect(result).toBeNull();
    expect(queryCalls).toEqual(["agent-ghost"]); // looked up, found nothing
  });
});

// ---------------------------------------------------------------------------
// (g) DISJOINTNESS — the same identity strings cannot resolve on BOTH paths.
//
// This is the crossover-set-is-empty proof. We take the agent's identity and the
// human resolver, and a human's identity and the agent resolver, and show neither
// path yields the other kind's slug.
// ---------------------------------------------------------------------------

describe("T-0424 disjointness — human↛agent and agent↛human across BOTH resolvers", () => {
  it("human resolver (resolveActorSlugFromAuth) NEVER returns an agent slug", async () => {
    // The human resolver's DB filter is kind='human'. An agent slug 'a-recon' is
    // kind='agent', so it is absent from the human existsSlugs set → null.
    const humanSlugs = new Set(["e-orlov", "e-larina"]); // only kind='human' rows
    const { pool } = makeHumanPool(humanSlugs);

    // Try to make the human resolver yield the agent slug 'a-recon' via BOTH sub
    // and preferred_username — it cannot (a-recon is not a kind='human' row).
    const result = await resolveActorSlugFromAuth(pool, "a-recon", "a-recon");

    // PROOF human↛agent: the human path cannot return an agent slug.
    expect(result).toBeNull();
    expect(result).not.toBe("a-recon");
  });

  it("agent resolver (resolveAgentSlugFromAuth) NEVER returns a human slug", async () => {
    // The human personas exist as kind='human'; suppose an attacker registered an
    // agent_card pointing 'agent-imposter' at the human 'e-orlov'. The agent
    // resolver's kind='agent' JOIN (and the agent_card FK at the DB) drop it.
    const cards = new Map([
      ["agent-imposter", { slug: "e-orlov", kind: "human" as const }],
      ["agent-recon", { slug: "a-recon", kind: "agent" as const }],
    ]);
    const { pool } = makeAgentPool(cards);

    const human = await resolveAgentSlugFromAuth(
      pool,
      agentCtx("service-account-agent-imposter"),
    );
    const agent = await resolveAgentSlugFromAuth(
      pool,
      agentCtx("service-account-agent-recon"),
    );

    // PROOF agent↛human: the agent path returns ONLY the genuine agent slug, and
    // NEVER the human slug, even when a card row names a human.
    expect(human).toBeNull();
    expect(human).not.toBe("e-orlov");
    expect(agent).toBe("a-recon");
  });
});
