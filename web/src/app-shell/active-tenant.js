/**
 * web/src/app-shell/active-tenant.js
 *
 * Single source of truth for "which tenant is the logged-in user operating in".
 *
 * THE BUG THIS FIXES: in keycloak mode the JWT has no tenant claim, so the SPA
 * had no way to know the caller's real tenant. Every org/process/agent screen
 * therefore hardcoded `x-tenant-id = 'a0000000-…-001'` (the seed "Dev Silo").
 * A user who registered their OWN company got pointed at a tenant they don't own
 * → 403 NOT_OWNER on org writes, and process drafts leaked into the dev silo.
 *
 * Now: on boot the shell calls resolveActiveTenant() once (GET /api/my-tenant,
 * which derives the tenant from the validated identity server-side), caches the
 * result here, and every screen reads getActiveTenantId() instead of the constant.
 *
 * The FALLBACK keeps legacy behaviour if the endpoint is unavailable (old dev
 * stacks, dev-no-db) — never worse than before the fix.
 */

import { authHeaders } from './dev-auth.js';

// Legacy seed tenant — used ONLY as a last-resort fallback so nothing regresses
// when /api/my-tenant cannot be reached. Real tenants override this on boot.
export const FALLBACK_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

let activeTenantId = null;
let activeTenant = null; // { id, slug, displayName, memberCount } | null

/**
 * Current tenant id for API calls. Returns the resolved real tenant once boot
 * has run; falls back to the seed tenant only if resolution never succeeded.
 */
export function getActiveTenantId() {
  return activeTenantId || FALLBACK_TENANT_ID;
}

/** Full tenant descriptor (slug, display name, member count) or null if unknown. */
export function getActiveTenant() {
  return activeTenant;
}

/** Test/seam setter. */
export function setActiveTenant(info) {
  activeTenant = info && info.id ? info : null;
  activeTenantId = (info && info.tenantId) || (info && info.id) || activeTenantId;
}

/** Clear cached tenant (e.g. on logout / identity switch). */
export function clearActiveTenant() {
  activeTenantId = null;
  activeTenant = null;
}

/**
 * Resolve the caller's real tenant from the server and cache it. Safe to call
 * repeatedly; on any failure the cache is left as-is (fallback remains in force).
 * Returns the resolved { tenantId, tenant } or null.
 */
export async function resolveActiveTenant() {
  try {
    const res = await fetch('/api/my-tenant', { headers: { ...authHeaders() } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.tenantId === 'string') {
      activeTenantId = data.tenantId;
      activeTenant = data.tenant || null;
      return data;
    }
  } catch {
    // network/parse error → keep whatever we had (fallback or prior value).
  }
  return null;
}
