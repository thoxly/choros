/**
 * src/__tests__/assistant-bundle-review.test.ts — T-0465 (D8-G4).
 *
 * Invariant under test (T-0465 #3): the bot reply for a generated solution carries
 * DEEP-LINKS into the actual sections (Приложения / Модельер) + a bundle-promote
 * descriptor — NOT a constructor rendered in chat. Pure ($0): tests buildBundleReview.
 */

import { describe, it, expect } from "vitest";
import { buildBundleReview } from "../http/assistant.js";

const BUNDLE_ID = "b2222222-2222-2222-2222-222222222222";

describe("AC-T465-5: review-in-sections — deep-links point at sections, not an in-chat constructor [D8-G4]", () => {
  it("apps → /app-schema/:id, processes → /processes/:key/edit; bundlePromote → bundle endpoint", () => {
    const { deepLinks, bundlePromote } = buildBundleReview(
      [{ id: "app-1", display_name: "Заявки на закупку" }],
      [{ process_key: "soglasovanie", name: "Согласование" }],
      /* sectionCount */ 1,
      BUNDLE_ID,
    );

    // INVARIANT (3): the reply carries LINKS into the sections (the user reviews the
    // generated DRAFT visually THERE — the chat never renders a constructor).
    const appLink = deepLinks.find((l) => l.kind === "app")!;
    expect(appLink.path).toBe("/app-schema/app-1");
    expect(appLink.label).toMatch(/Заявки на закупку/);

    const procLink = deepLinks.find((l) => l.kind === "process")!;
    expect(procLink.path).toBe("/processes/soglasovanie/edit");
    expect(procLink.label).toMatch(/Модельер/);

    // A deep-link is just a route path + label — NOT a serialized form/diagram payload.
    for (const l of deepLinks) {
      expect(typeof l.path).toBe("string");
      expect(l.path.startsWith("/")).toBe(true);
      expect(l).not.toHaveProperty("recordSchema");
      expect(l).not.toHaveProperty("bpmnXml");
      expect(l).not.toHaveProperty("formSchema");
    }

    // BUNDLE-PROMOTE: one descriptor → the bundle-promote endpoint (one promote unit).
    expect(bundlePromote).not.toBeNull();
    expect(bundlePromote!.bundleId).toBe(BUNDLE_ID);
    expect(bundlePromote!.path).toBe(`/api/solution-bundles/${BUNDLE_ID}/promote`);
    // 1 app + 1 process + 1 section = 3 items in the bundle.
    expect(bundlePromote!.itemCount).toBe(3);
  });

  it("process keys are URL-encoded in the deep-link path", () => {
    const { deepLinks } = buildBundleReview(
      [],
      [{ process_key: "согласование закупки", name: "Согласование" }],
      0,
      BUNDLE_ID,
    );
    expect(deepLinks[0]!.path).toBe(`/processes/${encodeURIComponent("согласование закупки")}/edit`);
  });

  it("empty bundle → no bundlePromote (nothing to publish)", () => {
    const { deepLinks, bundlePromote } = buildBundleReview([], [], 0, BUNDLE_ID);
    expect(deepLinks).toHaveLength(0);
    expect(bundlePromote).toBeNull();
  });
});
