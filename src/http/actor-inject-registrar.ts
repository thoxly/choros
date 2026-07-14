/**
 * src/http/actor-inject-registrar.ts — T-0328 G1 registration-site actor-inject façade.
 *
 * PROBLEM (ADR docs/design/T-0328-agent-facing-auth-model.adr.md §1 G1, §4):
 *   The two FROZEN agent-facing surfaces are ALREADY `withAuth`-wrapped at the
 *   registration site (secret-handle via withAuthRegistrar at server.ts; process-start
 *   via withAuth(makeStartInstanceHandler(...)) at processes.ts). That wrap CLOSES the
 *   bypass — in keycloak mode a bare `x-dev-user` no longer reaches the body (401). But
 *   it does NOT make the surface FUNCTIONAL: the frozen bodies still read identity from
 *   `req.headers['x-dev-user']` (and process-start also from `x-tenant-id`), which the
 *   SPA STOPS sending in keycloak mode. So in keycloak mode these two surfaces 401 even
 *   with a VALID Bearer — the screens look broken.
 *
 * SOLUTION (additive, NO founder thaw — ADR §4.1/§4.2):
 *   A registration-site PRE-HANDLER façade, a sibling of `withAuthRegistrar`
 *   (auth-wrap-router.ts). It composes the SAME single `withAuth` decorator, then —
 *   in keycloak mode ONLY — resolves the validated JWT identity (getAuthContext) into
 *   the employee slug and INJECTS it into `req.headers['x-dev-user']` BEFORE delegating
 *   to the frozen body. For process-start it ALSO resolves the actor's OWN tenant
 *   (resolveActorTenant — never a body/header-asserted tenant) and injects it into
 *   `req.headers['x-tenant-id']`. The frozen files (secret-handle.ts, process-start.ts)
 *   are byte-UNCHANGED: the fix is purely at the registration/wrapper site.
 *
 * BEHAVIOUR CONTRACT (mirrors withAuth + withAuthRegistrar, auth.ts §4):
 *   - dev mode  : authenticate() is a no-op; the injector is a PURE PASS-THROUGH
 *                 (getAuthContext is undefined in dev, so nothing is injected) — the
 *                 frozen body's existing x-dev-user convention is unchanged → dev tests
 *                 stay green.
 *   - keycloak  : withAuth REQUIRES a valid Bearer (401 otherwise — bypass dead). On a
 *                 valid Bearer, the resolved slug OVERWRITES (never merges) any client-
 *                 supplied x-dev-user (ADR §4.5 risk 3: the JWT identity is authoritative;
 *                 a client header must never shadow it). If identity resolution fails
 *                 (unknown slug / unresolved tenant) the façade fails CLOSED (401/403) —
 *                 it never delegates to the frozen body with an unresolved identity.
 *
 * SECURITY — human vs agent disjointness (ADR §3):
 *   These two surfaces are keycloak-SSO HUMAN surfaces. The slug is resolved ONLY via
 *   `resolveActorSlugFromAuth` (kind='human'-only, T-0372 anti-impersonation guard) —
 *   the agent resolver `resolveAgentSlugFromAuth` (kind='agent'-only) is NOT used here.
 *   An agent service-account token would fail the human resolver (its slug is kind='agent',
 *   never matched by the kind='human' existence check) → null → 401. The human and agent
 *   identity spaces stay provably disjoint at this seam.
 *
 * This is a façade only — it adds NO authorization logic. It resolves IDENTITY
 * (identity ⊥ rights); the frozen body's own authz gate (loadAdminContext /
 * holdsAgentMgmtUpdate for secret-handle; resolveActorTenant cross-tenant deny for
 * process-start) runs unchanged AFTER the injection.
 */

import type { IncomingMessage } from "node:http";
import { HttpError, type RouteHandler } from "./router.js";
import { withAuth, getAuthContext, getAuthMode } from "./auth.js";

/**
 * Minimal structural type of the Router surface used by `registerXxxRoutes`.
 * Depends only on `.register(method, pattern, handler)` so the façade stays
 * compatible with the real Router without importing its class (router.ts is the
 * FF-5 public-surface invariant — pinned byte-for-byte — and must NOT be edited).
 */
export interface RegistrarLike {
  register(method: string, pattern: string, handler: RouteHandler): void;
}

/**
 * Resolves a validated request's identity → employee slug. Production binding =
 * `resolveActorSlugFromAuth(getOrgPool(), sub, preferredUsername)` from src/db/org.ts;
 * injected so this module stays env-free / DB-free and the unit suite can exercise the
 * façade without a live Postgres (ADR §3 dependency-injection precedent).
 *
 * Contract: returns the resolved slug, or null to fail closed (unknown/unresolvable
 * identity → 401; the façade MUST NOT fall through to the frozen body).
 */
export type ActorSlugResolver = (
  sub: string,
  preferredUsername: string | undefined,
) => Promise<string | null>;

/**
 * Resolves an actor slug → the tenant the actor ACTUALLY belongs to. Production
 * binding = `resolveActorTenant(getOrgPool(), slug)` from src/db/org.ts (which is
 * fail-closed: an unknown slug / DB error THROWS HttpError(403), never the Dev Silo).
 * Injected for the same reason as ActorSlugResolver. Used ONLY for process-start (which
 * needs x-tenant-id); secret-handle pins DEV_TENANT_ID in-body and needs no tenant inject.
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * Façade options. `injectTenant` is supplied for process-start (which reads
 * x-tenant-id) and omitted for secret-handle (which reads only x-dev-user).
 */
export interface ActorInjectOptions {
  resolveActorSlug: ActorSlugResolver;
  /** Present ⇒ also resolve + inject x-tenant-id (process-start). Absent ⇒ slug only. */
  injectTenant?: ActorTenantResolver;
}

/**
 * Core injector: in keycloak mode, resolve the validated identity into x-dev-user
 * (and x-tenant-id when injectTenant is supplied) on `req.headers`, mutating the
 * request the frozen body will read. Dev mode is a pure pass-through.
 *
 * Runs AFTER authenticate() (so getAuthContext is populated) and BEFORE the frozen
 * body (so the body reads the injected, authoritative identity). Exported for unit
 * tests; not part of the public route surface.
 */
export async function injectResolvedActor(
  req: IncomingMessage,
  opts: ActorInjectOptions,
): Promise<void> {
  // Dev mode: no JWT, no AuthContext — leave the existing x-dev-user convention
  // untouched (pure pass-through; the frozen body authenticates via its own header).
  if (getAuthMode() !== "keycloak") return;

  // keycloak mode: withAuth already populated the AuthContext (or 401'd before us).
  // Defense-in-depth: if it is somehow absent, fail closed rather than trust a header.
  const ctx = getAuthContext(req);
  if (ctx === undefined) {
    throw new HttpError(401, "UNAUTHENTICATED", "missing authenticated identity");
  }

  // HUMAN bridge only (kind='human'; T-0372). An agent token resolves to null here
  // (its slug is kind='agent', never matched) → 401, keeping the human/agent spaces
  // disjoint at this keycloak-SSO human surface.
  const slug = await opts.resolveActorSlug(ctx.sub, ctx.preferredUsername);
  if (slug === null) {
    throw new HttpError(401, "UNAUTHENTICATED", "could not resolve caller identity");
  }

  // OVERWRITE (never merge) — the JWT-resolved slug is authoritative; a client-supplied
  // x-dev-user must never shadow it (ADR §4.5 risk 3).
  req.headers["x-dev-user"] = slug;

  // process-start: also inject the actor's OWN tenant. resolveActorTenant is fail-closed
  // (unknown slug / DB error THROWS HttpError(403)); we NEVER trust a body/header tenant.
  if (opts.injectTenant !== undefined) {
    const tenantId = await opts.injectTenant(slug);
    req.headers["x-tenant-id"] = tenantId;
  }
}

/**
 * Wraps a single RouteHandler: withAuth (validate + populate AuthContext) THEN, in
 * keycloak mode, inject the resolved identity into headers BEFORE the inner handler.
 *
 * Order is load-bearing (ADR §4.5 risk 2): authenticate runs first (so getAuthContext
 * is populated), the injector second, the frozen body last.
 */
export function withActorInject(
  handler: RouteHandler,
  opts: ActorInjectOptions,
): RouteHandler {
  // withAuth(inner) ⇒ authenticate(req) runs first; inner runs only after a valid token.
  return withAuth(async (req, res, params) => {
    await injectResolvedActor(req, opts);
    return handler(req, res, params);
  });
}

/**
 * Returns a Router façade that applies `withActorInject` to every handler registered
 * through it, then forwards the registration to `target`.
 *
 * Usage (composition root, mirrors withAuthRegistrar):
 *   registerSecretHandleRoutes(actorInjectRegistrar(router, { resolveActorSlug }), pool);
 *
 * Use this for the secret-handle frozen surface (slug-only). For the single
 * process-start route, wrap the handler directly with `withActorInject(handler, {
 * resolveActorSlug, injectTenant })` — it is registered as one explicit route, not
 * through an internal registrar.
 */
export function actorInjectRegistrar<T extends RegistrarLike>(
  target: T,
  opts: ActorInjectOptions,
): RegistrarLike {
  return {
    register(method: string, pattern: string, handler: RouteHandler): void {
      target.register(method, pattern, withActorInject(handler, opts));
    },
  };
}
