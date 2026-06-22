/**
 * src/http/auth-wrap-router.ts — T-0328/T-0418 registration-site auth wrap.
 *
 * Problem (ADR T-0328 §3.4): two surfaces are FROZEN in-body and cannot be
 * edited to add a `withAuth` guard:
 *   - src/http/secret-handle.ts (founder-frozen, FF-25-6)
 *   - the makeStartInstanceHandler body in src/http/process-start.ts
 *
 * `withAuth` is a pure handler decorator (auth.ts), and these modules call
 * `router.register(...)` *internally* from their own `registerXxxRoutes`
 * function. We cannot edit those frozen bodies, and we must NOT edit
 * src/http/router.ts (FF-5 public-surface invariant pins router.ts byte-for-byte).
 *
 * Solution: a thin Router *façade* that wraps every handler passed to
 * `.register(...)` with `withAuth` before delegating to the real router. The
 * composition root passes this façade to `registerSecretHandleRoutes` instead of
 * the bare router, so each frozen handler is validated by `authenticate()` BEFORE
 * its body runs — with no edit to the frozen file and no edit to router.ts.
 *
 * Behaviour contract (mirrors withAuth, auth.ts §4):
 *   - dev mode  : authenticate() is a no-op pass-through; the frozen body's
 *                 existing x-dev-user convention is unchanged → dev tests stay green.
 *   - keycloak  : a valid Bearer is REQUIRED (401 otherwise); x-dev-user alone no
 *                 longer reaches the frozen body, so the dev bypass is dead in prod.
 *
 * This is a façade only — it adds NO logic to the frozen surface; it composes the
 * single existing `withAuth` decorator at the registration boundary.
 */

import type { RouteHandler } from "./router.js";
import { withAuth } from "./auth.js";

/**
 * Minimal structural type of the Router surface used by `registerXxxRoutes`.
 * We depend only on `.register(method, pattern, handler)` so the façade stays
 * compatible with the real Router without importing its class (and without
 * needing to touch router.ts).
 */
export interface RegistrarLike {
  register(method: string, pattern: string, handler: RouteHandler): void;
}

/**
 * Returns a Router façade that applies `withAuth` to every handler registered
 * through it, then forwards the registration to `target`.
 *
 * Usage (composition root):
 *   registerSecretHandleRoutes(withAuthRegistrar(router), pool);
 *
 * The returned object is structurally a `RegistrarLike` (it has `.register`),
 * which is all `registerSecretHandleRoutes(router, pool)` requires.
 */
export function withAuthRegistrar<T extends RegistrarLike>(target: T): RegistrarLike {
  return {
    register(method: string, pattern: string, handler: RouteHandler): void {
      target.register(method, pattern, withAuth(handler));
    },
  };
}
