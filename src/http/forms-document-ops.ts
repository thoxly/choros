/**
 * src/http/forms-document-ops.ts  (T-0656 · E-FORMS — machine seam / столп 2+4)
 *
 * THE AGENT/ASSISTANT SEAM for assembling a form the SAME way a human does.
 *
 * Founder order: the form builder must be pleasant "и человеку и машине/агенту
 * через api или mcp — в духе нашего продукта". The human canvas (FormDesigner
 * .jsx) mutates the form-document through the pure ops (form-document-ops.js);
 * this route lets an agent apply ONE of those exact ops to the persisted layout
 * over HTTP — same op vocabulary, same content gate, same auth/role — so the
 * two drivers can never diverge on the contract.
 *
 * Route:
 *   POST /api/forms/document-ops
 *     body { processKey, stepKey, op: { kind, ...args }, applicationId? }
 *       op.kind ∈ { insert, remove, reorder, update, move }  (closed vocabulary)
 *       applicationId — OPTIONAL uuid (dual-cased `application_id` accepted too,
 *         same convention as processKey/process_key). Pins WHICH process↔app
 *         binding validates this save when the process is bound to 2+
 *         applications (T-0711). A caller MAY omit it; on a process with
 *         EXACTLY ONE binding, omitting it changes nothing (deterministic
 *         resolution — T-0711). On a process bound to 2+ applications,
 *         omitting it is a 422 AMBIGUOUS_APPLICATION (T-0725, see below) — the
 *         seam asks rather than silently guessing the oldest binding.
 *     → 200 { layout, version }
 *     → 400 VALIDATION   (malformed op / unknown kind, or a malformed applicationId — fail-closed)
 *     → 404 NOT_FOUND    (no form_binding.layout for processKey+stepKey — nothing to patch)
 *     → 409 WRONG_FLOOR  (classifyFloorBoundary → Floor-2; SAME judge as /binding)
 *     → 422 AMBIGUOUS_APPLICATION (T-0725: 2+ process_app_binding rows for processKey,
 *          no applicationId given — the caller must pick one; body lists the candidates)
 *     → 401 / 403        (SAME extractActorSlug + checkRole as /api/forms/binding)
 *
 * DESIGN (ADR-T0656 §4.3):
 *  - auth/role/tenant resolution reuse binding.ts (withTenantTx, checkRole,
 *    getBindingLayout, classifyLayoutSave) — one auth surface, one Floor gate.
 *  - op application is the pure applyDocumentOp (form-document-op-apply.ts),
 *    which drives the SERVER port of the SAME ops the human canvas uses
 *    (src/core/form-document-ops.ts, parity-tested against the JS module).
 *  - the seam PATCHES an existing form (404 if none); creating a form from
 *    scratch is POST /api/forms/binding with a full layout (already exists).
 *
 * BOT == HUMAN PARITY ON APPLICATION SELECTION (T-0725, столп 5):
 *   FormDesigner (the human canvas) ALWAYS threads its selected-application
 *   picker value through persistLayout → application_id (structurally — the
 *   picker state drives the field palette AND the save call, T-0711 review
 *   §1(a)). An agent has no picker; it MAY pass applicationId, but a caller
 *   that skips it on a process bound to a SINGLE application loses nothing
 *   (deterministic resolution, T-0711). The asymmetry T-0711 review flagged
 *   as non-blocking finding N-1 was the MULTI-binding case: skipping the pin
 *   there used to resolve the T-0711 fallback (oldest binding) silently,
 *   possibly against a schema the caller never intended — an agent could
 *   validate/save against the WRONG application with no signal. This route
 *   now runs an ambiguity pre-flight (listProcessAppBindingCandidates) before
 *   the content gate: 2+ bindings + no pin → honest 422
 *   AMBIGUOUS_APPLICATION naming every candidate, instead of a silent guess.
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { withAuth } from "./auth.js";
import {
  withTenantTx,
  checkRole,
  getBindingLayout,
  classifyLayoutSave,
  extractActorSlug,
  type BindingRoutesDeps,
} from "./binding.js";
import { applyDocumentOp } from "../core/form-document-op-apply.js";
import { listProcessAppBindingCandidates } from "../db/live-form-schema.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/**
 * Register POST /api/forms/document-ops. Requires the actor→tenant resolver
 * (same deps object as the actor-scoped binding routes).
 */
export function registerFormDocumentOpsRoute(
  router: Router,
  pool: pg.Pool,
  deps: BindingRoutesDeps,
): void {
  const { resolveActorTenant } = deps;

  router.register("POST", "/api/forms/document-ops", withAuth(async (req: IncomingMessage, res, _params) => {
    const actor = await extractActorSlug(req, pool);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const processKey = typeof body["processKey"] === "string" ? body["processKey"].trim() : "";
    const stepKey = typeof body["stepKey"] === "string" ? body["stepKey"].trim() : "";
    if (!processKey) throw new HttpError(400, "VALIDATION", "processKey must be a non-empty string");
    if (!stepKey) throw new HttpError(400, "VALIDATION", "stepKey must be a non-empty string");
    if (body["op"] === undefined || body["op"] === null) {
      throw new HttpError(400, "VALIDATION", "op is required");
    }

    // T-0711 (P2, review T-0706 finding #37): same optional application_id
    // pin as POST /api/forms/binding (binding.ts) — a process can be bound to
    // 2+ applications, and this seam runs the SAME classifyLayoutSave gate on
    // save. An agent driver that knows which binding it targets can name it
    // explicitly; absent, the gate falls back to a deterministic resolution
    // (see live-form-schema.ts) rather than an arbitrary DB row — UNLESS the
    // process is genuinely ambiguous (2+ bindings), in which case the
    // pre-flight below (T-0725) asks instead of guessing.
    const rawApplicationId = (
      typeof body["applicationId"] === "string" ? body["applicationId"] :
      typeof body["application_id"] === "string" ? body["application_id"] : ""
    ).trim();
    if (rawApplicationId) {
      assertUuidShape(rawApplicationId, "applicationId");
    }
    const applicationId: string | null = rawApplicationId || null;

    const tenantId = await resolveActorTenant(actor);
    assertUuidShape(tenantId, "tenantId");
    const nowMs = Date.now();

    const result = await withTenantTx(pool, tenantId, async (client) => {
      // Owner bypass (T-0666, ADR-T0666 §2.1) — same checkRole change as
      // /api/forms/binding; mechanical signature update only, no change to
      // this seam's op-apply / Floor gate logic (T-0656 scope untouched).
      await checkRole(client, pool, tenantId, actor);

      const existing = await getBindingLayout(client, tenantId, processKey, stepKey);
      if (!existing || existing.layout === null || existing.layout === undefined) {
        // Nothing to patch — the agent must create the form first (POST /binding
        // with a full layout). Honest 404, not a silent create.
        throw new HttpError(
          404,
          "NOT_FOUND",
          `no form layout to patch for process "${processKey}" step "${stepKey}" — create it first via POST /api/forms/binding`,
        );
      }

      // T-0725 (N-1, review T-0711 §6): ambiguity pre-flight — ONLY when the
      // caller skipped the pin. A process bound to a single application keeps
      // the T-0711 fallback unchanged (candidates.length <= 1 → no-op here);
      // a genuinely multi-bound process without a pin gets an honest,
      // machine-readable "which application?" error instead of the seam
      // silently validating/saving against whichever binding is oldest. Human
      // saves (POST /api/forms/binding via FormDesigner) never hit this path
      // — the picker always threads applicationId (T-0711 review §1(a)) — so
      // this is additive for the agent seam only, no human-path regression.
      if (!applicationId) {
        const candidates = await listProcessAppBindingCandidates(client, tenantId, processKey);
        if (candidates.length > 1) {
          const optionsText = candidates
            .map((c) => `${c.applicationDisplayName ?? c.applicationSlug ?? c.applicationId} (applicationId=${c.applicationId})`)
            .join("; ");
          throw new HttpError(
            422,
            "AMBIGUOUS_APPLICATION",
            `Process "${processKey}" is bound to ${candidates.length} applications — pass applicationId to pick which schema this save targets (no pin means no guess). Candidates: ${optionsText}.`,
          );
        }
      }

      // Apply ONE op through the SAME pure ops the human canvas drives.
      const applied = applyDocumentOp(existing.layout, body["op"]);
      if (!applied.ok) {
        throw new HttpError(400, "VALIDATION", `invalid op: ${applied.error}`);
      }
      const nextLayout = applied.doc as unknown as Record<string, unknown>;

      // SAME Floor-1/Floor-2 content gate as the human save (one judge).
      // T-0711: thread the same optional applicationId pin as /api/forms/binding.
      await classifyLayoutSave(client, tenantId, processKey, nextLayout, applicationId);

      // Persist (version+1) — the same upsert semantics as /api/forms/binding.
      const newVersion = existing.version + 1;
      await client.query(
        `UPDATE choros.form_binding
            SET layout = $1::jsonb,
                version = $2,
                updated_at = $3
          WHERE tenant_id = $4
            AND process_key = $5
            AND form_key = $6`,
        [JSON.stringify(nextLayout), newVersion, nowMs, tenantId, processKey, stepKey],
      );
      return { layout: nextLayout, version: newVersion };
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  }));
}
