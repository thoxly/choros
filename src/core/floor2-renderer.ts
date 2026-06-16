/**
 * T-0076 · E11.5: Floor-2 Sandbox Renderer — agent-authored React presentation
 * over named-binding in a sandboxed iframe (vetted-палитра + флагованный кастом).
 *
 * Pure module — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и floor1-editor.ts (T-0073 · applyFloor1Edit).
 *
 * --- ADR MAPPING ---
 * This module implements docs/design/extensibility-and-authoring.md §4 Floor-2
 * and §9.10:
 *
 * §4 Floor-2 (two sub-classes):
 *   (a) Vetted-palette component — deterministic, round-trip stable, no flag.
 *       Agent picks from a fixed enumerated set (VETTED_COMPONENT_TYPES). Server
 *       validates the component type at render time; unknown types → INVALID_COMPONENT.
 *   (b) Custom component (agent-authored free React source) — sandbox-iframe §4/§7.
 *       Requires FLOOR2_CUSTOM_FLAG_KEY to be set to FLOOR2_CUSTOM_FLAG_VALUE in the
 *       render descriptor metadata. Without the flag → CUSTOM_FLAG_MISSING.
 *       This is the "flagged and rare" path (§9.10 / §11).
 *
 * §9.10 governance gate:
 *   Custom code MUST be gated/flagged. The flag is the single mandatory governance
 *   check before custom code reaches the iframe. Flag = intentional, auditable
 *   signal that the operator knowingly chose the custom (round-trip-cliff) path.
 *
 * §4 + §7 sandbox security contract:
 *   The agent-authored / custom code MUST execute inside a sandboxed iframe with:
 *     - sandbox="allow-scripts"  (JS must run to render)
 *     - NO allow-same-origin     (opaque origin — defeats parent-origin reach)
 *   This ensures the custom code cannot:
 *     - Reach the parent origin (document.cookie, localStorage, etc.)
 *     - Call parent window methods (no window.parent.postMessage to arbitrary targets)
 *     - Access browser storage of the parent
 *   The ONLY seam out of the iframe is the height-postMessage channel, which is
 *   origin-validated by acceptFrameHeight (form-frame-height.ts / frame-height.js).
 *
 * §4 named-binding invariant:
 *   Floor-2 code presents over the SAME named-binding contract as Floor-1.
 *   Code MUST NOT mutate process state directly — it is presentation/interaction
 *   over the validated binding. Backend validation (form-validator.ts T-0102) is
 *   the authority; iframe output is untrusted.
 *
 * §11 round-trip-decay:
 *   Custom components are the single place where agent round-trip decay may occur
 *   (vendor-documented cliff). This is why they are flagged, rare, and instrumented.
 *   FLOOR2_CUSTOM_FLAG_KEY in the descriptor is the intentional marker for auditing.
 *
 * Priors (NF-1):
 *   - forms-sandbox-iframe.sh (T-0101) already asserts Floor-1 iframe isolation.
 *   - form-frame-height.ts (T-0101) is the canonical height-channel validator.
 *   - classifyAuthoringFloor (T-0074) classifies custom_component as Floor-2 kind.
 *   - authoring-redlines.ts (T-0078) guards destructive ops.
 *   The Floor-2 renderer is the RENDERING layer AFTER classification — it is NOT
 *   a second classifier. One control plane per concern (NF-1).
 *
 * Exports:
 *   - VettedComponentType          — enumerated safe component types (§4a)
 *   - VETTED_COMPONENT_TYPES       — ReadonlySet of vetted types (machine-readable)
 *   - FLOOR2_SANDBOX_ATTR          — the required sandbox attribute string
 *   - FLOOR2_SANDBOX_MUST_CONTAIN  — tokens sandbox MUST contain
 *   - FLOOR2_SANDBOX_MUST_NOT_CONTAIN — tokens sandbox MUST NOT contain
 *   - FLOOR2_CUSTOM_FLAG_KEY       — governance flag key for custom code (§9.10)
 *   - FLOOR2_CUSTOM_FLAG_VALUE     — governance flag value (intentional opt-in)
 *   - Floor2RenderMode             — 'vetted' | 'custom' discriminator
 *   - Floor2RenderDescriptor       — full descriptor for one Floor-2 render
 *   - Floor2ValidationErrorCode    — error codes
 *   - Floor2ValidationError        — one validation error
 *   - Floor2ValidationResult       — result of validateFloor2Descriptor
 *   - Floor2SrcdocResult           — result of buildFloor2Srcdoc
 *   - validateFloor2Descriptor     — gate function: validate before render
 *   - buildFloor2Srcdoc            — build sandboxed srcdoc from descriptor
 *   - assertSandboxAttr            — pure sandbox-attribute validator (for tests/CI)
 *
 * Source: docs/design/extensibility-and-authoring.md §4 / §7 / §9.10 / §11
 */

import type { BindingField } from "./binding-compat.js";

// ---------------------------------------------------------------------------
// §4a — Vetted-palette component types
// ---------------------------------------------------------------------------

/**
 * Enumerated safe component types for the vetted-palette path (§4a).
 *
 * Each type corresponds to a deterministic React component that:
 *   - Is round-trip stable (survives agent re-authoring unchanged)
 *   - Is schema-validated by the server
 *   - Requires no custom code (no round-trip-cliff risk)
 *
 * New types are added ONLY by explicit ADR update + VETTED_COMPONENT_TYPES expansion.
 * Unknown types are rejected as INVALID_COMPONENT (closed vocab, same discipline as
 * FLOOR1_EDIT_KINDS / FLOOR2_EDIT_KINDS in authoring-floor-classifier.ts).
 */
export type VettedComponentType =
  | "text_input"        // Single-line text field
  | "number_input"      // Numeric field (integer or decimal)
  | "textarea"          // Multi-line text area
  | "select"            // Dropdown select (options from binding schema)
  | "date_picker"       // Date picker
  | "checkbox"          // Boolean checkbox
  | "radio_group"       // Radio button group (options from binding schema)
  | "currency_input"    // Currency field (number + currency code)
  | "file_upload";      // File attachment (via T-0201 file API)

/**
 * Machine-readable set of vetted component types.
 * Consumed by CI checks and the HTTP layer.
 */
export const VETTED_COMPONENT_TYPES: ReadonlySet<VettedComponentType> =
  new Set<VettedComponentType>([
    "text_input",
    "number_input",
    "textarea",
    "select",
    "date_picker",
    "checkbox",
    "radio_group",
    "currency_input",
    "file_upload",
  ]);

// ---------------------------------------------------------------------------
// §4 / §7 — Sandbox security constants
// ---------------------------------------------------------------------------

/**
 * The required sandbox attribute value for ALL Floor-2 iframes.
 *
 * SECURITY RATIONALE:
 *   allow-scripts   — JS must run to render the React component.
 *   NO allow-same-origin — CRITICAL. Combining allow-scripts + allow-same-origin
 *     restores the sandbox origin to the parent, defeating the entire isolation:
 *     the sandboxed code could then read parent cookies, storage, DOM, and call
 *     parent APIs. The iframe MUST run with an OPAQUE origin ('null') so any
 *     parent-origin access attempt fails at the browser security boundary.
 *
 * This matches the T-0101 Floor-1 form sandbox contract (forms-sandbox-iframe.sh
 * FF-FORMS2-1). Floor-2 adopts the same invariant (one sandbox policy, not two).
 */
export const FLOOR2_SANDBOX_ATTR = "allow-scripts" as const;

/**
 * Tokens the sandbox attribute MUST contain.
 * Used by assertSandboxAttr and the CI check.
 */
export const FLOOR2_SANDBOX_MUST_CONTAIN: ReadonlyArray<string> = ["allow-scripts"];

/**
 * Tokens the sandbox attribute MUST NOT contain.
 * allow-same-origin defeats the opaque-origin isolation.
 */
export const FLOOR2_SANDBOX_MUST_NOT_CONTAIN: ReadonlyArray<string> = [
  "allow-same-origin",
];

// ---------------------------------------------------------------------------
// §9.10 — Custom-code governance flag
// ---------------------------------------------------------------------------

/**
 * The governance flag key that MUST be present in Floor2RenderDescriptor.meta
 * when mode === 'custom'. This is the intentional, auditable opt-in signal for
 * custom (free agent-authored) React code (§9.10 / §11 round-trip-cliff).
 *
 * Without this flag set to FLOOR2_CUSTOM_FLAG_VALUE, validateFloor2Descriptor
 * returns CUSTOM_FLAG_MISSING and the iframe is NOT rendered.
 *
 * Design intent: the flag is not a security boundary (the sandbox IS), but a
 * GOVERNANCE signal — the operator explicitly and knowingly chose the custom path,
 * making it auditable and traceable in the authoring log.
 */
export const FLOOR2_CUSTOM_FLAG_KEY = "floor2_custom_confirmed" as const;

/**
 * The required value for the custom-code governance flag.
 */
export const FLOOR2_CUSTOM_FLAG_VALUE = "true" as const;

// ---------------------------------------------------------------------------
// Floor2RenderMode — discriminator
// ---------------------------------------------------------------------------

/**
 * Render mode discriminator.
 *   'vetted'  — component from VETTED_COMPONENT_TYPES; deterministic; no flag required.
 *   'custom'  — agent-authored free React source; flag required; rare; instrumented.
 */
export type Floor2RenderMode = "vetted" | "custom";

// ---------------------------------------------------------------------------
// Floor2RenderDescriptor — full descriptor for one Floor-2 render
// ---------------------------------------------------------------------------

/**
 * A vetted-palette render descriptor (§4a).
 *
 * @param mode           - Must be 'vetted'.
 * @param componentType  - One of VETTED_COMPONENT_TYPES.
 * @param bindingKey     - The named-binding key this component renders (field-key
 *                         from BindingField.key). Must exist in the current fields[].
 * @param props          - Component props (label, placeholder, options, etc.) as
 *                         a plain object. Opaque to the core — validated at render.
 * @param meta           - Optional audit context (agentId, draftId, etc.). Ignored
 *                         by the renderer; present for audit log consumers.
 */
export interface VettedFloor2Descriptor {
  mode: "vetted";
  componentType: VettedComponentType;
  bindingKey: string;
  props?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/**
 * A custom-component render descriptor (§4b / §9.10).
 *
 * REQUIRES: meta[FLOOR2_CUSTOM_FLAG_KEY] === FLOOR2_CUSTOM_FLAG_VALUE.
 *
 * @param mode          - Must be 'custom'.
 * @param reactSource   - The agent-authored React component source (UTF-8 string).
 *                        Executed inside the sandboxed iframe — NEVER eval'd in parent.
 * @param bindingKey    - The named-binding key this component renders. Must exist in fields[].
 * @param meta          - REQUIRED. Must contain { floor2_custom_confirmed: 'true' } (§9.10).
 */
export interface CustomFloor2Descriptor {
  mode: "custom";
  reactSource: string;
  bindingKey: string;
  meta: Record<string, unknown> & {
    [FLOOR2_CUSTOM_FLAG_KEY]: typeof FLOOR2_CUSTOM_FLAG_VALUE;
  };
}

/**
 * Discriminated union of all Floor-2 render descriptors.
 */
export type Floor2RenderDescriptor = VettedFloor2Descriptor | CustomFloor2Descriptor;

// ---------------------------------------------------------------------------
// Floor2ValidationError / Floor2ValidationResult
// ---------------------------------------------------------------------------

/** Validation error codes for Floor-2 descriptor validation. */
export type Floor2ValidationErrorCode =
  | "UNKNOWN_BINDING_KEY"    // bindingKey not found in current fields[]
  | "INVALID_COMPONENT"      // componentType not in VETTED_COMPONENT_TYPES
  | "CUSTOM_FLAG_MISSING"    // custom mode without floor2_custom_confirmed flag
  | "EMPTY_REACT_SOURCE"     // custom mode with empty reactSource
  | "INVALID_MODE";          // mode is not 'vetted' or 'custom'

/** One validation error from validateFloor2Descriptor. */
export interface Floor2ValidationError {
  code: Floor2ValidationErrorCode;
  message: string;
  field?: string;
}

/** Result of validateFloor2Descriptor. */
export type Floor2ValidationResult =
  | { ok: true }
  | { ok: false; errors: Floor2ValidationError[] };

// ---------------------------------------------------------------------------
// Floor2SrcdocResult
// ---------------------------------------------------------------------------

/**
 * Result of buildFloor2Srcdoc.
 *
 * On success: { ok: true, srcdoc, sandboxAttr } — the srcdoc to set on the
 *   iframe, and the sandboxAttr string (always FLOOR2_SANDBOX_ATTR).
 * On failure: { ok: false, errors } — validation errors.
 */
export type Floor2SrcdocResult =
  | { ok: true; srcdoc: string; sandboxAttr: typeof FLOOR2_SANDBOX_ATTR }
  | { ok: false; errors: Floor2ValidationError[] };

// ---------------------------------------------------------------------------
// assertSandboxAttr — pure sandbox attribute validator
// ---------------------------------------------------------------------------

/**
 * Validates a sandbox attribute string against Floor-2 security invariants.
 *
 * Rules (§4 / §7 / FF-FLOOR2-SANDBOX):
 *   1. Must contain every token in FLOOR2_SANDBOX_MUST_CONTAIN.
 *   2. Must NOT contain any token in FLOOR2_SANDBOX_MUST_NOT_CONTAIN.
 *
 * Used by:
 *   - Floor2Viewer.jsx (asserts at runtime in dev mode)
 *   - ci/checks/floor2-sandbox-isolation.sh (static CI gate)
 *   - Tests (unit-asserting the constant FLOOR2_SANDBOX_ATTR is safe)
 *
 * @param sandboxAttr  The sandbox attribute string to validate.
 * @returns { ok: true } if valid, { ok: false; violations } if not.
 */
export function assertSandboxAttr(
  sandboxAttr: string,
): { ok: true } | { ok: false; violations: string[] } {
  const tokens = sandboxAttr.trim().split(/\s+/);
  const tokenSet = new Set(tokens);
  const violations: string[] = [];

  for (const required of FLOOR2_SANDBOX_MUST_CONTAIN) {
    if (!tokenSet.has(required)) {
      violations.push(
        `sandbox MUST contain '${required}' — iframe code cannot run without it`,
      );
    }
  }

  for (const forbidden of FLOOR2_SANDBOX_MUST_NOT_CONTAIN) {
    if (tokenSet.has(forbidden)) {
      violations.push(
        `sandbox MUST NOT contain '${forbidden}' — combining allow-scripts + allow-same-origin defeats opaque-origin isolation (parent-origin reach)`,
      );
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateFloor2Descriptor — gate function
// ---------------------------------------------------------------------------

/**
 * Validates a Floor2RenderDescriptor before rendering.
 *
 * Enforces:
 *   1. mode is 'vetted' or 'custom' (INVALID_MODE).
 *   2. bindingKey exists in fields[] (UNKNOWN_BINDING_KEY).
 *   3. For 'vetted' mode: componentType ∈ VETTED_COMPONENT_TYPES (INVALID_COMPONENT).
 *   4. For 'custom' mode:
 *      a. meta[FLOOR2_CUSTOM_FLAG_KEY] === FLOOR2_CUSTOM_FLAG_VALUE (CUSTOM_FLAG_MISSING).
 *      b. reactSource is a non-empty string (EMPTY_REACT_SOURCE).
 *
 * Pure function — no I/O. The descriptor is accepted or rejected entirely from
 * its own shape + the fields[].key set.
 *
 * @param descriptor  Floor2RenderDescriptor to validate.
 * @param fields      Current BindingField[] from form_binding (named-binding contract).
 * @returns Floor2ValidationResult
 */
export function validateFloor2Descriptor(
  descriptor: Floor2RenderDescriptor,
  fields: BindingField[],
): Floor2ValidationResult {
  const errors: Floor2ValidationError[] = [];
  const fieldKeys = new Set(fields.map((f) => f.key));

  // Check mode is valid
  if (descriptor.mode !== "vetted" && descriptor.mode !== "custom") {
    errors.push({
      code: "INVALID_MODE",
      message: `mode must be 'vetted' or 'custom'; got '${String((descriptor as Floor2RenderDescriptor).mode)}'`,
    });
    return { ok: false, errors };
  }

  // Check bindingKey exists in the named-binding contract
  if (!fieldKeys.has(descriptor.bindingKey)) {
    errors.push({
      code: "UNKNOWN_BINDING_KEY",
      message: `bindingKey "${descriptor.bindingKey}" does not exist in the form binding (field-key == variable-name contract, ADR §4)`,
      field: descriptor.bindingKey,
    });
  }

  if (descriptor.mode === "vetted") {
    // Vetted-palette path (§4a): componentType must be in the closed vocab
    if (
      !(VETTED_COMPONENT_TYPES as ReadonlySet<string>).has(
        descriptor.componentType,
      )
    ) {
      errors.push({
        code: "INVALID_COMPONENT",
        message: `componentType "${descriptor.componentType}" is not in the vetted-palette (VETTED_COMPONENT_TYPES). ` +
          `Use one of: ${Array.from(VETTED_COMPONENT_TYPES).join(", ")}`,
        field: "componentType",
      });
    }
  } else {
    // Custom-code path (§4b / §9.10): flag MUST be present
    const flag = descriptor.meta?.[FLOOR2_CUSTOM_FLAG_KEY];
    if (flag !== FLOOR2_CUSTOM_FLAG_VALUE) {
      errors.push({
        code: "CUSTOM_FLAG_MISSING",
        message:
          `custom Floor-2 code requires meta.${FLOOR2_CUSTOM_FLAG_KEY} === '${FLOOR2_CUSTOM_FLAG_VALUE}' ` +
          `(§9.10 governance flag — intentional opt-in to the round-trip-cliff path). ` +
          `Got: ${flag === undefined ? "absent" : `'${String(flag)}'`}`,
        field: FLOOR2_CUSTOM_FLAG_KEY,
      });
    }

    // reactSource must be non-empty
    if (
      typeof descriptor.reactSource !== "string" ||
      descriptor.reactSource.trim().length === 0
    ) {
      errors.push({
        code: "EMPTY_REACT_SOURCE",
        message: "custom Floor-2 descriptor must have a non-empty reactSource string",
        field: "reactSource",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildFloor2Srcdoc — build sandboxed iframe srcdoc from descriptor
// ---------------------------------------------------------------------------

/**
 * Builds the srcdoc HTML string for a Floor-2 sandboxed iframe.
 *
 * SECURITY CONTRACT:
 *   - All agent-authored/custom code is placed INSIDE the srcdoc, never eval'd
 *     in the parent document.
 *   - The returned sandboxAttr is always FLOOR2_SANDBOX_ATTR ("allow-scripts"),
 *     never allow-same-origin.
 *   - The iframe runs with an opaque origin ('null') — it cannot reach the parent.
 *   - The only seam out is the height-postMessage channel, which is origin-validated
 *     by acceptFrameHeight in the parent (form-frame-height.ts / frame-height.js).
 *
 * For 'vetted' mode: renders a minimal host scaffold that declares the binding key
 *   and component type in data attributes (real component rendering is in the browser
 *   layer Floor2Viewer.jsx — this srcdoc is the stub/host).
 *
 * For 'custom' mode: wraps the agent-authored reactSource in a minimal React host
 *   scaffold, including the height-postMessage emitter. The source executes inside
 *   the opaque-origin sandbox — no parent-origin access is possible.
 *
 * Validates descriptor before building. Returns errors if validation fails.
 *
 * @param descriptor  Floor2RenderDescriptor (vetted or custom).
 * @param fields      Current BindingField[] (named-binding contract).
 * @param theme       'dark' | 'light' — injected as data-theme on <html>.
 * @returns Floor2SrcdocResult
 */
export function buildFloor2Srcdoc(
  descriptor: Floor2RenderDescriptor,
  fields: BindingField[],
  theme: "dark" | "light" = "dark",
): Floor2SrcdocResult {
  // Validate first — fail fast
  const validation = validateFloor2Descriptor(descriptor, fields);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const safeTheme = theme === "light" ? "light" : "dark";

  // The height-postMessage emitter — injected into both modes.
  // This is the ONLY channel from iframe to parent (opaque-origin boundary).
  const heightEmitter = `
(function emitHeight() {
  function send() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    window.parent.postMessage({ type: 'fjs-height', h: h }, '*');
  }
  send();
  var ro = (typeof ResizeObserver !== 'undefined')
    ? new ResizeObserver(send)
    : null;
  if (ro) ro.observe(document.body);
  window.addEventListener('load', send);
})();
`.trim();

  let srcdoc: string;

  if (descriptor.mode === "vetted") {
    // Vetted-palette: the srcdoc is a minimal scaffold. The actual React rendering
    // happens in the parent (Floor2Viewer.jsx) via the browser's vetted component
    // registry. The scaffold declares identity via data attributes so the parent
    // can initialize the correct component via the height channel.
    const componentType = descriptor.componentType;
    const bindingKey = descriptor.bindingKey;
    // Props serialized as JSON attribute for the vetted component to read
    const propsJson = JSON.stringify(descriptor.props ?? {});
    // Escape for HTML attribute context
    const safeProps = propsJson
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    srcdoc = `<!DOCTYPE html>
<html lang="ru" data-theme="${safeTheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { margin: 0; padding: 8px; box-sizing: border-box; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div
  id="floor2-vetted-host"
  data-floor2-mode="vetted"
  data-component-type="${componentType}"
  data-binding-key="${bindingKey}"
  data-props="${safeProps}"
></div>
<script>${heightEmitter}<\/script>
</body>
</html>`;
  } else {
    // Custom-code path (§4b / §9.10):
    // The agent-authored reactSource is embedded inside the srcdoc.
    // SECURITY: the script runs inside the sandbox (opaque origin 'null') —
    // it cannot access parent.document, parent.localStorage, parent.cookie, etc.
    // The only outbound channel is postMessage to '*' (height only),
    // which the parent validates via acceptFrameHeight (opaque origin check).
    const bindingKey = descriptor.bindingKey;
    // Find the binding field for the custom component
    const field = fields.find((f) => f.key === bindingKey);
    const fieldLabel = field?.label ?? bindingKey;

    // The custom source is embedded verbatim — it cannot escape the sandbox.
    // We do NOT sanitize it because sanitization would break agent-authored code;
    // instead, the SANDBOX is the security boundary (opaque origin).
    // The agent source must be self-contained (no external imports).
    const customSource = descriptor.reactSource;

    srcdoc = `<!DOCTYPE html>
<html lang="ru" data-theme="${safeTheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { margin: 0; padding: 8px; box-sizing: border-box; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div
  id="floor2-custom-host"
  data-floor2-mode="custom"
  data-binding-key="${bindingKey}"
  data-field-label="${fieldLabel.replace(/"/g, "&quot;")}"
  data-floor2-custom-confirmed="${FLOOR2_CUSTOM_FLAG_VALUE}"
></div>
<script>
/* === Floor-2 custom component (agent-authored, §9.10 flagged) === */
/* SECURITY: this code runs inside a sandboxed iframe (opaque origin 'null').
   It cannot reach the parent document, cookies, or storage. The only seam
   out is the height postMessage channel (origin-validated by parent). */
${customSource}
<\/script>
<script>${heightEmitter}<\/script>
</body>
</html>`;
  }

  return { ok: true, srcdoc, sandboxAttr: FLOOR2_SANDBOX_ATTR };
}
