/**
 * src/core/notification-templates.ts — T-0172 E-N.5
 *
 * Code-bundled notification templates (event_kind → {title, body})
 * + server-side {{var}} render with HTML-escape.
 *
 * DESIGN INVARIANTS (ADR T-0120 §2.9 / Fitness FF-TEMPLATE-NO-LLM / FF-HTML-ESCAPE / FF-TEMPLATE-CLASS):
 *
 *  PURE-CORE: no pg / node:http / node:net / node:https / fetch imports.
 *    All logic is deterministic string manipulation. Testable without DATABASE_URL.
 *
 *  NO-LLM / NO-ENGINE: renderTemplate is a plain {{var}} string substitution.
 *    No eval, no Handlebars, no EJS, no external template engine.
 *    grep-verifiable: no `eval(` / no engine import in this file.
 *
 *  HTML-ESCAPE REQUIRED (XSS barrier): when opts.html=true, every substituted
 *    payload value passes through escapeHtml() before insertion into the output.
 *    Email bodies with HTML content MUST use opts.html=true (payload variables
 *    come from user-controlled record data → XSS vector if unescaped).
 *
 *  FAIL-CLOSED: missing payload variable → empty string (not raw object, not throw).
 *  FALLBACK: unknown event_kind → { title: eventKind, body: '' }.
 *
 *  DATA-CLASS: payload variables are ≤ 'internal' (filtered at fanout T-0169).
 *    This module does NOT classify keys — it trusts the caller (publishNotificationEvent)
 *    to have already filtered confidential/restricted fields from the payload.
 *    DataClass is imported from data-classification.ts, NOT redeclared.
 *
 *  MAP-ONLY LOOKUP: renderNotification uses NOTIFICATION_TEMPLATES.get(eventKind)
 *    exclusively — no switch/if-else chain on event_kind.
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2.9/§4.4/§5 E-N.5.
 * Spec: docs/specs/T-0172-notification-templates.spec.md.
 */

// DataClass imported (NOT redeclared) — T-0033/ADR NF-8.
// Used only as type annotation in comments; the actual filtering is done at fanout.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { DataClass } from "./data-classification.js";
import type { TemplateRendererPort } from "./notification-router.js";

// ---------------------------------------------------------------------------
// escapeHtml — HTML-entity escaping for XSS prevention (FR-4, AC-5)
// ---------------------------------------------------------------------------

/**
 * Escape the 5 HTML-dangerous characters into their safe entity equivalents.
 *
 * Safe set: & → &amp;  < → &lt;  > → &gt;  " → &quot;  ' → &#39;
 *
 * Must be applied to EVERY payload variable when rendering HTML email bodies
 * (opts.html=true).  Plain-text rendering (opts.html=false) skips this function
 * entirely — see ADR §2.9: "plain-text-часть — без экранирования".
 *
 * Exported for independent test coverage (AC-5).
 */
export function escapeHtml(s: string): string {
  // Order matters: & must be replaced first to avoid double-escaping the
  // ampersand in subsequent entity substitutions.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// renderTemplate — core substitution engine (FR-3, AC-2, AC-3, AC-4, AC-12, AC-13)
// ---------------------------------------------------------------------------

/**
 * Render a {title, body} template pair by substituting ALL occurrences of
 * {{varName}} with the corresponding payload[varName] value.
 *
 * Rules:
 *  - ALL occurrences of {{varName}} in a string are replaced (global regex, AC-12).
 *  - Missing key → replaced with '' (fail-closed, AC-3).
 *  - opts.html=true  → values are HTML-escaped before insertion (XSS barrier, AC-4/NF-1).
 *  - opts.html=false → values inserted verbatim, no escaping (AC-13/NF-4).
 *  - No eval, no template engine, no LLM (NF-2).
 *
 * @param tmpl    - template strings (code-bundled; from NOTIFICATION_TEMPLATES or caller)
 * @param payload - variable values (≤ 'internal' DataClass; filtered at fanout)
 * @param opts    - { html: boolean } — enable HTML-escape for email HTML bodies
 */
export function renderTemplate(
  tmpl: { readonly title: string; readonly body: string },
  payload: Record<string, unknown>,
  opts: { html: boolean },
): { title: string; body: string } {
  return {
    title: substituteVars(tmpl.title, payload, opts.html),
    body:  substituteVars(tmpl.body,  payload, opts.html),
  };
}

/**
 * Replace all {{varName}} occurrences in `template` with payload values.
 * Internal helper — not exported (public surface is renderTemplate).
 */
function substituteVars(
  template: string,
  payload: Record<string, unknown>,
  html: boolean,
): string {
  // Global regex: replaces ALL occurrences of the same placeholder (AC-12).
  // Capture group 1 = variable name (trimmed, no leading/trailing whitespace).
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const key = varName.trim();
    const raw = payload[key];

    // Missing/undefined → empty string (fail-closed, AC-3; ADR §2.9 "пропуском").
    if (raw === undefined || raw === null) {
      return "";
    }

    const strVal = String(raw);

    // HTML-escape when rendering HTML content (XSS barrier, AC-4/NF-1).
    return html ? escapeHtml(strVal) : strVal;
  });
}

// ---------------------------------------------------------------------------
// NOTIFICATION_TEMPLATES — code-bundled Map of day-1 templates (FR-1, AC-1)
// ---------------------------------------------------------------------------

/**
 * Code-bundled template Map: event_kind → { title, body }.
 *
 * Day-1 templates for the 5 event_kinds in T-0171 DEFAULT_PREFERENCES:
 *   task.assigned, approval.requested, sla.warning, sla.breach, escalation.raised.
 *
 * Payload variables (≤ 'internal' DataClass — filtered at fanout T-0169):
 *   {{taskName}} — display name of the task/process instance (internal).
 *   {{assignedBy}} — actor who performed the assignment (internal, optional).
 *
 * Templates are vendor-owned (code-bundled, ADR §2.9 РЕШЕНИЕ §3-в).
 * Tenant-configurable templates are Stage-2.
 *
 * Lookup discipline: use NOTIFICATION_TEMPLATES.get(eventKind) — NO switch/if-else.
 */
export const NOTIFICATION_TEMPLATES: ReadonlyMap<string, { readonly title: string; readonly body: string }> = new Map([
  [
    "task.assigned",
    {
      title: "Вам назначена задача: {{taskName}}",
      body:  "Задача «{{taskName}}» назначена вам.",
    },
  ],
  [
    "approval.requested",
    {
      title: "Запрос на подтверждение: {{taskName}}",
      body:  "По задаче «{{taskName}}» запрошено ваше подтверждение.",
    },
  ],
  [
    "sla.warning",
    {
      title: "Предупреждение SLA: {{taskName}}",
      body:  "Задача «{{taskName}}» приближается к дедлайну SLA.",
    },
  ],
  [
    "sla.breach",
    {
      title: "Нарушение SLA: {{taskName}}",
      body:  "Задача «{{taskName}}» нарушила дедлайн SLA.",
    },
  ],
  [
    "escalation.raised",
    {
      title: "Эскалация: {{taskName}}",
      body:  "По задаче «{{taskName}}» создана эскалация.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// renderNotification — convenience wrapper with fallback (FR-7, AC-6, AC-7)
// ---------------------------------------------------------------------------

/**
 * Render a notification for a given event_kind and payload.
 *
 * Looks up the template from NOTIFICATION_TEMPLATES via Map.get(eventKind)
 * (NO switch/if-else chain — FF-template-no-switch discipline mirrors
 * FF-NO-SWITCH-CHANNEL in the router).
 *
 * Fallback (ADR §2.9 / AC-7): unknown event_kind → { title: eventKind, body: '' }.
 * Does NOT throw on unknown kinds — the pipeline stays alive.
 *
 * @param eventKind - notification event kind string (e.g. 'task.assigned')
 * @param payload   - variable values (≤ 'internal'; filtered by fanout)
 * @param opts      - { html: boolean } — passed to renderTemplate
 */
export function renderNotification(
  eventKind: string,
  payload: Record<string, unknown>,
  opts: { html: boolean },
): { title: string; body: string } {
  // Map-only lookup (no switch/if-else on eventKind).
  const tmpl = NOTIFICATION_TEMPLATES.get(eventKind);

  if (tmpl === undefined) {
    // Fallback for unknown event_kind (AC-7): title = eventKind, body = ''.
    // Does not throw — the delivery pipeline must not crash on unknown kinds.
    return { title: eventKind, body: "" };
  }

  return renderTemplate(tmpl, payload, opts);
}

// ---------------------------------------------------------------------------
// defaultTemplateRenderer — TemplateRendererPort implementation (FR-8, AC-8, AC-10)
// ---------------------------------------------------------------------------

/**
 * Default implementation of TemplateRendererPort (from notification-router.ts T-0169).
 *
 * Uses plain-text rendering (opts.html=false) — appropriate for in-app notifications
 * and the default fanout render in publishNotificationEvent.  Email drivers that need
 * HTML bodies should call renderNotification(..., { html: true }) directly before
 * building the SMTP message.
 *
 * Structural compatibility with TemplateRendererPort is enforced by tsc --noEmit (AC-10).
 *
 * Injected into PublishNotificationDeps.templates in publishNotificationEvent.
 * No audit_event in this path (pure-function, FF-NO-DELIVERY-AUDIT).
 */
export const defaultTemplateRenderer: TemplateRendererPort = {
  render(eventKind: string, payload: Record<string, unknown>): { title: string; body: string } {
    // Plain-text render (no HTML-escape) — in-app and default fanout context.
    return renderNotification(eventKind, payload, { html: false });
  },
};
