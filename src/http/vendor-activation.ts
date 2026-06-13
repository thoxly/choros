/**
 * src/http/vendor-activation.ts — T-0127 (T-0198 impl)
 *
 * Vendor HTTP edge — the circuit<->vendor-control-plane boundary. This is the
 * ONLY HTTP surface that reads activation/entitlement state. User-facing
 * endpoints (auth/processes/inbox/audit/rights/grants/org) never touch it
 * (FF-T127-4).
 *
 * Endpoints:
 *   GET  /vendor/activation
 *        Reports the current ActivationStatus. ALWAYS 200 — reporting the verdict
 *        is not gating (the circuit is up either way). state ∈ active|autonomous|invalid.
 *
 *   POST /vendor/updates/check
 *   POST /vendor/agentic-ops/run
 *   GET  /vendor/support/ticket
 *        Vendor-SERVICE calls. These REFUSE with 402 (payment-required: no/expired
 *        entitlement) or 403 (forbidden: invalid key / not entitled for this flag)
 *        when the subscription does not grant the service. The refusal lands ON the
 *        vendor call — the core circuit is never affected (no kill-switch).
 *
 * Entitlement -> HTTP mapping:
 *   active + flag set       -> 200 (entitled)
 *   autonomous (no/expired) -> 402 PAYMENT_REQUIRED (renew the subscription)
 *   invalid (bad signature) -> 403 ACTIVATION_INVALID (key not trusted)
 *   active + flag unset     -> 403 NOT_ENTITLED (plan does not include this service)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./router.js";
import {
  isEntitled,
  type ActivationStatus,
  type VendorService,
} from "../vendor/activation.js";
import { currentActivationStatus } from "../vendor/entitlement.js";

/** A function the route uses to obtain the live ActivationStatus (injectable for tests). */
export type ActivationProvider = () => ActivationStatus;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Gate a vendor-service call on a single entitlement flag. Returns true if the
 * request was REFUSED (response already sent); false if entitled (caller proceeds).
 */
function refuseIfNotEntitled(
  res: ServerResponse,
  status: ActivationStatus,
  service: VendorService,
): boolean {
  if (isEntitled(status, service)) {
    return false; // entitled — caller proceeds
  }

  if (status.state === "invalid") {
    sendJson(res, 403, {
      error: {
        code: "ACTIVATION_INVALID",
        message: `activation key is not trusted (${status.reason}); vendor service '${service}' unavailable`,
      },
    });
    return true;
  }

  if (status.state === "autonomous") {
    sendJson(res, 402, {
      error: {
        code: "PAYMENT_REQUIRED",
        message: `no active subscription (${status.reason}); vendor service '${service}' requires an active activation key`,
      },
    });
    return true;
  }

  // state === 'active' but this specific flag is not granted by the plan.
  sendJson(res, 403, {
    error: {
      code: "NOT_ENTITLED",
      message: `subscription does not include vendor service '${service}'`,
    },
  });
  return true;
}

/**
 * Register the vendor activation + vendor-service endpoints.
 *
 * @param router    the app router.
 * @param provider  optional ActivationStatus provider (injectable for tests).
 *                  Defaults to reading env/fs via currentActivationStatus().
 */
export function registerVendorActivationRoutes(
  router: Router,
  provider: ActivationProvider = () => currentActivationStatus(),
): void {
  // --- status report (always 200; reporting is not gating) -----------------
  router.register("GET", "/vendor/activation", (_req: IncomingMessage, res: ServerResponse) => {
    const status = provider();
    sendJson(res, 200, {
      state: status.state,
      circuit_id: status.circuit_id,
      entitlements: status.entitlements,
      not_after: status.not_after,
      reason: status.reason,
    });
  });

  // --- vendor service: updates (self-upgrade / image pulls) ----------------
  router.register("POST", "/vendor/updates/check", (_req: IncomingMessage, res: ServerResponse) => {
    const status = provider();
    if (refuseIfNotEntitled(res, status, "updates")) return;
    sendJson(res, 200, { service: "updates", entitled: true, circuit_id: status.circuit_id });
  });

  // --- vendor service: agentic ops (fleet-ops maintenance) -----------------
  router.register("POST", "/vendor/agentic-ops/run", (_req: IncomingMessage, res: ServerResponse) => {
    const status = provider();
    if (refuseIfNotEntitled(res, status, "agentic_ops")) return;
    sendJson(res, 200, { service: "agentic_ops", entitled: true, circuit_id: status.circuit_id });
  });

  // --- vendor service: support channel -------------------------------------
  router.register("GET", "/vendor/support/ticket", (_req: IncomingMessage, res: ServerResponse) => {
    const status = provider();
    if (refuseIfNotEntitled(res, status, "support")) return;
    sendJson(res, 200, { service: "support", entitled: true, circuit_id: status.circuit_id });
  });
}
