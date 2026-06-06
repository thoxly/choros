import { describe, it, expect } from "vitest";
import { SCAFFOLD_VERSION } from "../index.js";

describe("scaffold", () => {
  it("exports SCAFFOLD_VERSION as a string", () => {
    expect(typeof SCAFFOLD_VERSION).toBe("string");
  });

  it("SCAFFOLD_VERSION is non-empty", () => {
    expect(SCAFFOLD_VERSION.length).toBeGreaterThan(0);
  });
});
