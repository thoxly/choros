/**
 * T-0154 · ВРАГ — surface adapters: wire the deterministic harness to the REAL
 * Choros attack surface (and to deliberately-broken surfaces for the self-test).
 *
 * spec: playbooks/enemy-redteam-backlog.md §6 (репо Demiurge).
 *
 * The harness (enemy-harness.ts) is surface-agnostic; THIS file binds it to:
 *   - the REAL PDP — `resolveFor` from src/core/grant-resolver.ts, driven through
 *     in-memory ports (no DB) so the probe is pure & deterministic;
 *   - the REAL auth seam — `withAuth`/`authenticate` from src/http/auth.ts, driven
 *     in keycloak (prod) mode with a synthetic IncomingMessage;
 * and provides BROKEN counterparts that the `--self-test` plants to prove the
 * Enemy detects a genuine violation (an Enemy that can't fail is worthless).
 */

import { type IncomingMessage } from "node:http";
import {
  type ResolvedView,
  makeHandle,
} from "../../core/object-handle.js";
import { type Grant } from "../../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  resolveFor,
} from "../../core/grant-resolver.js";
import { withAuth } from "../../http/auth.js";
import { HttpError } from "../../http/router.js";
import {
  type EnemySurfaces,
  type PdpProbeInput,
  type AuthProbeInput,
  enemyOracle,
} from "./enemy-harness.js";

// ---------------------------------------------------------------------------
// REAL PDP surface — resolveFor through in-memory ports.
// ---------------------------------------------------------------------------

function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}

/** A record source that always has a row (so a LEAK reveals fields, not not_found). */
function presentRecord(): RecordSource {
  return { getRecord: () => Promise.resolve({ name: "secret", salary: 999 }) };
}

/**
 * Drive the REAL PDP. The handle is minted via makeHandle in the HANDLE's own
 * tenant (construction enforces ref==tenant); the cross-tenant attack is then the
 * SUBJECT being in a different tenant than the handle — exactly the resolveFor
 * tenant-gate (step 1). `now` is injected (fixed) so the probe is deterministic.
 */
export const realPdp = (input: PdpProbeInput): Promise<ResolvedView> => {
  const { subject, handleRef, grants } = input;
  const handle = makeHandle(handleRef, handleRef.tenantId);
  return resolveFor(
    {
      grants: staticGrants(grants),
      records: presentRecord(),
      ancestry: enemyOracle(),
      now: () => 1000, // fixed instant — no Date.now
    },
    handle,
    subject,
    "read",
  ) as Promise<ResolvedView>;
};

// ---------------------------------------------------------------------------
// REAL auth surface — withAuth/authenticate in keycloak (prod) mode.
// ---------------------------------------------------------------------------

/** Build a minimal IncomingMessage carrying the probe headers. */
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/**
 * Drive the REAL auth seam. We set CHOROS_AUTH_MODE=keycloak (prod), wrap a
 * sentinel handler in withAuth, and feed it the forged request. If auth passes
 * (the inner handler runs), we return 200 — that would be the LEAK. If it throws
 * HttpError we return its status (401 = correct rejection). getAuthMode() reads
 * process.env lazily, so the override takes effect per-call; we restore it after.
 */
export const realAuth = async (input: AuthProbeInput): Promise<number> => {
  const prev = process.env["CHOROS_AUTH_MODE"];
  process.env["CHOROS_AUTH_MODE"] = input.authMode; // "keycloak"
  // KC config must be present for the keycloak path to reach JWT validation;
  // a forged dev-header request fails BEFORE config matters (missing Bearer →
  // 401), but we set it so we exercise the genuine prod branch, not a config throw.
  const prevKc = process.env["KEYCLOAK_URL"];
  process.env["KEYCLOAK_URL"] = "http://kc.invalid"; // never reached for these cases
  try {
    let innerRan = false;
    const guarded = withAuth(async (_req, res) => {
      innerRan = true;
      res.statusCode = 200;
    });
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as Parameters<
      typeof guarded
    >[1];
    try {
      await guarded(fakeReq(input.headers), res, {});
    } catch (err) {
      if (err instanceof HttpError) return err.statusCode;
      throw err;
    }
    // No throw: auth let the request through. If the inner handler ran, the dev
    // header was honoured in prod — a vulnerability (return 200 = LEAK).
    return innerRan ? 200 : (res as { statusCode: number }).statusCode || 200;
  } finally {
    if (prev === undefined) delete process.env["CHOROS_AUTH_MODE"];
    else process.env["CHOROS_AUTH_MODE"] = prev;
    if (prevKc === undefined) delete process.env["KEYCLOAK_URL"];
    else process.env["KEYCLOAK_URL"] = prevKc;
  }
};

/** The production wiring the Enemy attacks in CI. */
export const realSurfaces: EnemySurfaces = { pdp: realPdp, auth: realAuth };

// ---------------------------------------------------------------------------
// BROKEN surfaces — planted vulnerabilities for `--self-test`. These prove the
// Enemy detects a real violation. Each mirrors a classic regression:
//   - allow-by-default PDP (deny-by-default broken)
//   - tenant-blind PDP (TENANT-ISO broken)
//   - dev-auth-honoured-in-prod (DEV-AUTH-PROD broken)
// ---------------------------------------------------------------------------

/** A PDP that ALWAYS allows — the deny-by-default / tenant-iso invariant is dead. */
export const allowAllPdp = (input: PdpProbeInput): Promise<ResolvedView> => {
  return Promise.resolve({
    denied: false,
    ref: input.handleRef,
    fields: { name: "LEAKED", salary: 999 },
  });
};

/** An auth seam that honours x-dev-user even in keycloak mode (returns 200). */
export const devAuthHonouredInProd = (_input: AuthProbeInput): Promise<number> =>
  Promise.resolve(200);

/** Broken surfaces for the self-test: every invariant is deliberately violated. */
export const brokenSurfaces: EnemySurfaces = {
  pdp: allowAllPdp,
  auth: devAuthHonouredInProd,
};
