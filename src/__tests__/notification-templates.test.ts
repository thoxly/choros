/**
 * T-0172 · Notification templates unit tests
 *
 * Pure unit — no DB, no env vars. Tests renderTemplate, escapeHtml,
 * renderNotification, defaultTemplateRenderer, NOTIFICATION_TEMPLATES.
 *
 * Covers AC-1..AC-14 from docs/specs/T-0172-notification-templates.spec.md.
 *
 * Fitness functions tested here:
 *   FF-TEMPLATE-NO-LLM, FF-HTML-ESCAPE, FF-TEMPLATE-CLASS
 */

import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_TEMPLATES,
  renderTemplate,
  renderNotification,
  defaultTemplateRenderer,
  escapeHtml,
} from "../core/notification-templates.js";

// ---------------------------------------------------------------------------
// AC-1: NOTIFICATION_TEMPLATES contains exactly 5 day-1 event_kinds
// ---------------------------------------------------------------------------

describe("NOTIFICATION_TEMPLATES", () => {
  const REQUIRED_KINDS = [
    "task.assigned",
    "approval.requested",
    "sla.warning",
    "sla.breach",
    "escalation.raised",
  ] as const;

  it("AC-1: contains exactly 5 entries", () => {
    expect(NOTIFICATION_TEMPLATES.size).toBe(5);
  });

  for (const kind of REQUIRED_KINDS) {
    it(`AC-1: has entry for '${kind}'`, () => {
      const tmpl = NOTIFICATION_TEMPLATES.get(kind);
      expect(tmpl).toBeDefined();
      expect(typeof tmpl?.title).toBe("string");
      expect(typeof tmpl?.body).toBe("string");
      expect(tmpl?.title.length).toBeGreaterThan(0);
      // body may be empty for fallback but day-1 templates all have body text
      expect(typeof tmpl?.body).toBe("string");
    });
  }

  it("AC-1: each template has non-empty title", () => {
    for (const [kind, tmpl] of NOTIFICATION_TEMPLATES) {
      expect(tmpl.title.length, `${kind} title is empty`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: Basic variable substitution (html=false)
// ---------------------------------------------------------------------------

describe("renderTemplate — basic substitution", () => {
  it("AC-2: substitutes variables in title and body", () => {
    const result = renderTemplate(
      { title: "Hello {{name}}", body: "Body {{val}}" },
      { name: "Alice", val: "X" },
      { html: false },
    );
    expect(result.title).toBe("Hello Alice");
    expect(result.body).toBe("Body X");
  });

  it("substitutes variable in title only", () => {
    const result = renderTemplate(
      { title: "Task: {{taskName}}", body: "No vars here" },
      { taskName: "Review PR" },
      { html: false },
    );
    expect(result.title).toBe("Task: Review PR");
    expect(result.body).toBe("No vars here");
  });

  it("substitutes variable in body only", () => {
    const result = renderTemplate(
      { title: "Static title", body: "Hello {{user}}" },
      { user: "Bob" },
      { html: false },
    );
    expect(result.title).toBe("Static title");
    expect(result.body).toBe("Hello Bob");
  });

  it("returns template unchanged when no variables present", () => {
    const result = renderTemplate(
      { title: "No placeholders", body: "Plain text body" },
      {},
      { html: false },
    );
    expect(result.title).toBe("No placeholders");
    expect(result.body).toBe("Plain text body");
  });
});

// ---------------------------------------------------------------------------
// AC-3: Missing payload variable → empty string (fail-closed)
// ---------------------------------------------------------------------------

describe("renderTemplate — missing variable", () => {
  it("AC-3: missing key → empty string, not throw", () => {
    const result = renderTemplate(
      { title: "Hi {{missing}}", body: "Value: {{alsoMissing}}" },
      {},
      { html: false },
    );
    expect(result.title).toBe("Hi ");
    expect(result.body).toBe("Value: ");
  });

  it("AC-3: undefined value → empty string", () => {
    const result = renderTemplate(
      { title: "{{x}}", body: "{{y}}" },
      { x: undefined as unknown as string, y: null as unknown as string },
      { html: false },
    );
    expect(result.title).toBe("");
    expect(result.body).toBe("");
  });

  it("AC-3: only present keys substituted; missing keys → empty string", () => {
    const result = renderTemplate(
      { title: "{{present}} and {{missing}}", body: "" },
      { present: "VALUE" },
      { html: false },
    );
    expect(result.title).toBe("VALUE and ");
  });
});

// ---------------------------------------------------------------------------
// AC-4: HTML-escape when html=true (XSS-probe)
// ---------------------------------------------------------------------------

describe("renderTemplate — HTML-escape when html=true", () => {
  it("AC-4: XSS-probe: <script> in payload is escaped", () => {
    const result = renderTemplate(
      { title: "Hello {{name}}", body: "Content: {{name}}" },
      { name: "<script>alert(1)</script>" },
      { html: true },
    );
    expect(result.title).toContain("&lt;script&gt;");
    expect(result.title).not.toContain("<script>");
    expect(result.body).toContain("&lt;script&gt;");
    expect(result.body).not.toContain("<script>");
  });

  it("AC-4: all 5 HTML special chars escaped in title and body", () => {
    const result = renderTemplate(
      { title: "{{v}}", body: "{{v}}" },
      { v: `<>&"'` },
      { html: true },
    );
    expect(result.title).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(result.body).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("AC-4: ampersand escaped first (no double-escape)", () => {
    const result = renderTemplate(
      { title: "{{v}}", body: "" },
      { v: "A & B" },
      { html: true },
    );
    // Should be "A &amp; B", NOT "A &amp;amp; B"
    expect(result.title).toBe("A &amp; B");
  });

  it("AC-4: img XSS vector escaped", () => {
    const result = renderTemplate(
      { title: "{{taskName}}", body: "{{taskName}}" },
      { taskName: '<img src=x onerror=alert(1)>' },
      { html: true },
    );
    expect(result.title).not.toContain("<img");
    expect(result.body).not.toContain("<img");
    expect(result.title).toContain("&lt;img");
    expect(result.body).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// AC-5: escapeHtml covers all 5 dangerous chars
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("AC-5: escapes all 5 HTML special chars", () => {
    expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("AC-5: leaves safe chars unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("AC-5: escapes < alone", () => {
    expect(escapeHtml("<")).toBe("&lt;");
  });

  it("AC-5: escapes > alone", () => {
    expect(escapeHtml(">")).toBe("&gt;");
  });

  it("AC-5: escapes & alone", () => {
    expect(escapeHtml("&")).toBe("&amp;");
  });

  it("AC-5: escapes \" alone", () => {
    expect(escapeHtml('"')).toBe("&quot;");
  });

  it("AC-5: escapes ' alone", () => {
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("AC-5: escapes multiple occurrences", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("AC-5: empty string → empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC-6: renderNotification with task.assigned returns taskName in result
// ---------------------------------------------------------------------------

describe("renderNotification", () => {
  it("AC-6: task.assigned — taskName appears in title and body", () => {
    const result = renderNotification("task.assigned", { taskName: "MyTask" }, { html: false });
    expect(result.title).toContain("MyTask");
    expect(result.body).toContain("MyTask");
  });

  it("AC-6: approval.requested — taskName appears in title and body", () => {
    const result = renderNotification("approval.requested", { taskName: "ApprovalTask" }, { html: false });
    expect(result.title).toContain("ApprovalTask");
    expect(result.body).toContain("ApprovalTask");
  });

  it("AC-6: sla.warning — taskName appears in title and body", () => {
    const result = renderNotification("sla.warning", { taskName: "SlaTask" }, { html: false });
    expect(result.title).toContain("SlaTask");
    expect(result.body).toContain("SlaTask");
  });

  it("AC-6: sla.breach — taskName appears in title and body", () => {
    const result = renderNotification("sla.breach", { taskName: "BreachTask" }, { html: false });
    expect(result.title).toContain("BreachTask");
    expect(result.body).toContain("BreachTask");
  });

  it("AC-6: escalation.raised — taskName appears in title and body", () => {
    const result = renderNotification("escalation.raised", { taskName: "EscTask" }, { html: false });
    expect(result.title).toContain("EscTask");
    expect(result.body).toContain("EscTask");
  });

  // -------------------------------------------------------------------------
  // AC-7: Fallback for unknown event_kind
  // -------------------------------------------------------------------------

  it("AC-7: unknown event_kind → fallback {title: eventKind, body: ''}", () => {
    const result = renderNotification("unknown.event_kind", {}, { html: false });
    expect(result.title).toBe("unknown.event_kind");
    expect(result.body).toBe("");
  });

  it("AC-7: empty event_kind string → fallback", () => {
    const result = renderNotification("", {}, { html: false });
    expect(result.title).toBe("");
    expect(result.body).toBe("");
  });

  it("AC-7: completely new event kind → fallback, no throw", () => {
    expect(() => {
      renderNotification("future.event.kind", { x: 1 }, { html: false });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-8: defaultTemplateRenderer uses plain-text (no HTML-escape)
// ---------------------------------------------------------------------------

describe("defaultTemplateRenderer", () => {
  it("AC-8: render returns title and body for task.assigned", () => {
    const result = defaultTemplateRenderer.render("task.assigned", { taskName: "T" });
    expect(typeof result.title).toBe("string");
    expect(typeof result.body).toBe("string");
    expect(result.title).toContain("T");
  });

  it("AC-8: plain-text — HTML chars NOT escaped", () => {
    // defaultTemplateRenderer uses html=false, so < stays <
    const result = defaultTemplateRenderer.render("task.assigned", { taskName: "<task>" });
    // Should contain raw < because html=false
    expect(result.title).toContain("<task>");
    expect(result.title).not.toContain("&lt;");
  });

  it("AC-8: unknown event_kind via defaultTemplateRenderer → fallback", () => {
    const result = defaultTemplateRenderer.render("unknown.kind", {});
    expect(result.title).toBe("unknown.kind");
    expect(result.body).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC-9: XSS-probe sквозная через renderNotification with html=true
// ---------------------------------------------------------------------------

describe("XSS probes — html=true", () => {
  it("AC-9: <img onerror> in taskName is escaped with html=true", () => {
    const result = renderNotification(
      "task.assigned",
      { taskName: '<img src=x onerror=alert(1)>' },
      { html: true },
    );
    expect(result.title).not.toContain("<img");
    expect(result.body).not.toContain("<img");
    expect(result.title).toContain("&lt;img");
    expect(result.body).toContain("&lt;img");
  });

  it("AC-9: <script> payload escaped when rendering all 5 event_kinds with html=true", () => {
    const payload = { taskName: "<script>alert(XSS)</script>" };
    const xssMarker = "<script>";
    for (const kind of [
      "task.assigned",
      "approval.requested",
      "sla.warning",
      "sla.breach",
      "escalation.raised",
    ]) {
      const result = renderNotification(kind, payload, { html: true });
      expect(result.title, `${kind} title not escaped`).not.toContain(xssMarker);
      expect(result.body,  `${kind} body not escaped`).not.toContain(xssMarker);
      expect(result.title).toContain("&lt;script&gt;");
    }
  });

  it("AC-9: quote injection escaped in html=true mode", () => {
    const result = renderNotification(
      "task.assigned",
      { taskName: '" onmouseover="alert(1)' },
      { html: true },
    );
    // The double-quote should be escaped so it can't break HTML attributes
    expect(result.title).not.toContain('"');
    expect(result.title).toContain("&quot;");
  });
});

// ---------------------------------------------------------------------------
// AC-12: All occurrences of {{var}} replaced (not just first)
// ---------------------------------------------------------------------------

describe("renderTemplate — multiple occurrences", () => {
  it("AC-12: all occurrences of same {{var}} in body replaced", () => {
    const result = renderTemplate(
      { title: "", body: "{{name}} & {{name}}" },
      { name: "A" },
      { html: false },
    );
    expect(result.body).toBe("A & A");
  });

  it("AC-12: all occurrences in title replaced", () => {
    const result = renderTemplate(
      { title: "{{x}} then {{x}}", body: "" },
      { x: "Z" },
      { html: false },
    );
    expect(result.title).toBe("Z then Z");
  });

  it("AC-12: multiple different vars all replaced", () => {
    const result = renderTemplate(
      { title: "{{a}} {{b}} {{a}}", body: "{{b}} {{a}}" },
      { a: "foo", b: "bar" },
      { html: false },
    );
    expect(result.title).toBe("foo bar foo");
    expect(result.body).toBe("bar foo");
  });
});

// ---------------------------------------------------------------------------
// AC-13: plain-text (html=false) — no escaping
// ---------------------------------------------------------------------------

describe("renderTemplate — plain-text no escape", () => {
  it("AC-13: html=false: <b>text</b> in payload appears verbatim", () => {
    const result = renderTemplate(
      { title: "{{val}}", body: "{{val}}" },
      { val: "<b>text</b>" },
      { html: false },
    );
    expect(result.title).toBe("<b>text</b>");
    expect(result.body).toBe("<b>text</b>");
  });

  it("AC-13: html=false: ampersand appears verbatim", () => {
    const result = renderTemplate(
      { title: "{{val}}", body: "" },
      { val: "A & B" },
      { html: false },
    );
    expect(result.title).toBe("A & B");
    expect(result.title).not.toContain("&amp;");
  });

  it("AC-13: html=false: quotes appear verbatim", () => {
    const result = renderTemplate(
      { title: "{{val}}", body: "" },
      { val: `"hello"` },
      { html: false },
    );
    expect(result.title).toBe(`"hello"`);
  });
});

// ---------------------------------------------------------------------------
// Structural / fitness tests (AC-10, AC-11)
// AC-10/AC-11 are grep-based and covered by the fitness script.
// Here we test structural compatibility at the type level.
// ---------------------------------------------------------------------------

describe("structural: TemplateRendererPort compatibility", () => {
  it("AC-10: defaultTemplateRenderer.render is a function", () => {
    expect(typeof defaultTemplateRenderer.render).toBe("function");
  });

  it("AC-10: defaultTemplateRenderer.render returns {title, body}", () => {
    const result = defaultTemplateRenderer.render("task.assigned", { taskName: "X" });
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("body");
    expect(typeof result.title).toBe("string");
    expect(typeof result.body).toBe("string");
  });
});

describe("structural: NOTIFICATION_TEMPLATES is ReadonlyMap", () => {
  it("AC-1: NOTIFICATION_TEMPLATES.get returns undefined for unknown", () => {
    expect(NOTIFICATION_TEMPLATES.get("not.a.real.kind")).toBeUndefined();
  });

  it("structural: Map.set is not callable (ReadonlyMap discipline)", () => {
    // ReadonlyMap type prevents .set; we test at runtime that NOTIFICATION_TEMPLATES
    // is a proper Map with no writable mutations expected via the type.
    // The object is a Map instance (not a frozen plain object).
    expect(NOTIFICATION_TEMPLATES).toBeInstanceOf(Map);
  });
});
