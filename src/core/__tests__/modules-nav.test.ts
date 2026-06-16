/**
 * T-0079 / E11.8 — Pure unit tests for modules-nav.ts
 *
 * Covers:
 *  MN-1  — validateNavConfig: valid config passes
 *  MN-2  — validateNavConfig: section count exceeds max → error
 *  MN-3  — validateNavConfig: duplicate section slug → error
 *  MN-4  — validateNavConfig: empty label → error
 *  MN-5  — validateNavConfig: invalid slug (spaces) → error
 *  MN-6  — validateNavConfig: application count exceeds max → error
 *  MN-7  — validateNavConfig: leaf count exceeds max → error
 *  MN-8  — validateNavConfig: negative version → error
 *  MN-9  — classifyCatalogFieldChange: add_field → allow
 *  MN-10 — classifyCatalogFieldChange: relabel → allow (even on standard field)
 *  MN-11 — classifyCatalogFieldChange: drop_field on standard → deny_core_pinned
 *  MN-12 — classifyCatalogFieldChange: drop_field on custom → allow
 *  MN-13 — classifyCatalogFieldChange: rename_field on standard → deny_core_pinned
 *  MN-14 — classifyCatalogFieldChange: rename_field on custom → allow
 *  MN-15 — classifyCatalogFieldChange: overwrite_standard on standard → deny_core_pinned
 *  MN-16 — classifyCatalogFieldChange: overwrite_standard on custom → allow
 *  MN-17 — CATALOG_STANDARD_FIELDS contains expected user fields
 *  MN-18 — USER_CATALOG_STANDARD_FIELDS is frozen (extend-not-replace: set contents)
 *  MN-19 — UserProjection shape: customFields is distinct from standard keys
 *  MN-20 — Nav hierarchy depth: leaf kind 'form' and 'list' both valid
 */

import { describe, it, expect } from "vitest";
import {
  type NavConfig,
  type NavSection,
  type NavApplication,
  type NavLeaf,
  type CatalogFieldSpec,
  type CatalogFieldChange,
  validateNavConfig,
  classifyCatalogFieldChange,
  NAV_MAX_SECTIONS,
  NAV_MAX_APPS_PER_SECTION,
  NAV_MAX_LEAVES_PER_APP,
  CATALOG_STANDARD_FIELDS,
  USER_CATALOG_STANDARD_FIELDS,
  ORG_UNIT_CATALOG_STANDARD_FIELDS,
  COUNTERPARTY_CATALOG_STANDARD_FIELDS,
} from "../modules-nav.js";

// ---------------------------------------------------------------------------
// Helpers: minimal valid fixture builders
// ---------------------------------------------------------------------------

function makeLeaf(slug: string, kind: "form" | "list" = "form"): NavLeaf {
  return { slug, label: `Label ${slug}`, kind, bindingKey: `binding_${slug}`, order: 1 };
}

function makeApp(slug: string, leaves: NavLeaf[] = []): NavApplication {
  return { slug, label: `App ${slug}`, leaves, order: 1 };
}

function makeSection(slug: string, apps: NavApplication[] = []): NavSection {
  return { slug, label: `Section ${slug}`, applications: apps, order: 1 };
}

function makeConfig(sections: NavSection[], version = 1): NavConfig {
  return { version, sections };
}

function makeStandardField(fieldKey: string): CatalogFieldSpec {
  return {
    fieldKey,
    label: `Label ${fieldKey}`,
    kind: "standard",
    catalogName: "user",
  };
}

function makeCustomField(fieldKey: string): CatalogFieldSpec {
  return {
    fieldKey,
    label: `Label ${fieldKey}`,
    kind: "custom",
    catalogName: "user",
  };
}

// ---------------------------------------------------------------------------
// MN-1: valid config passes
// ---------------------------------------------------------------------------

describe("MN-1 — validateNavConfig: valid config passes", () => {
  it("minimal valid config with one section/app/leaf", () => {
    const config = makeConfig([
      makeSection("main", [makeApp("contracts", [makeLeaf("new-contract")])]),
    ]);
    const result = validateNavConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("config with form and list leaves is valid", () => {
    const config = makeConfig([
      makeSection("main", [
        makeApp("contracts", [makeLeaf("new-contract", "form"), makeLeaf("contract-list", "list")]),
      ]),
    ]);
    const result = validateNavConfig(config);
    expect(result.valid).toBe(true);
  });

  it("empty sections config is valid (version=0)", () => {
    const config = makeConfig([], 0);
    const result = validateNavConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MN-2: section count exceeds max
// ---------------------------------------------------------------------------

describe("MN-2 — validateNavConfig: section count exceeds max", () => {
  it("should fail when sections.length > NAV_MAX_SECTIONS", () => {
    const sections = Array.from({ length: NAV_MAX_SECTIONS + 1 }, (_, i) =>
      makeSection(`sec-${i}`),
    );
    const result = validateNavConfig(makeConfig(sections));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "sections")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-3: duplicate section slug
// ---------------------------------------------------------------------------

describe("MN-3 — validateNavConfig: duplicate section slug", () => {
  it("should fail on duplicate section slugs", () => {
    const config = makeConfig([makeSection("main"), makeSection("main")]);
    const result = validateNavConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("duplicate section slug"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-4: empty label
// ---------------------------------------------------------------------------

describe("MN-4 — validateNavConfig: empty label", () => {
  it("should fail when section label is empty string", () => {
    const sec: NavSection = { slug: "main", label: "", applications: [], order: 1 };
    const result = validateNavConfig(makeConfig([sec]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("label must be non-empty"))).toBe(true);
  });

  it("should fail when app label is empty string", () => {
    const app: NavApplication = { slug: "contracts", label: "   ", leaves: [], order: 1 };
    const result = validateNavConfig(makeConfig([makeSection("main", [app])]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("label must be non-empty"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-5: invalid slug (spaces / special chars)
// ---------------------------------------------------------------------------

describe("MN-5 — validateNavConfig: invalid slug", () => {
  it("should fail when section slug contains spaces", () => {
    const sec: NavSection = { slug: "my section", label: "My Section", applications: [], order: 1 };
    const result = validateNavConfig(makeConfig([sec]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("URL-safe"))).toBe(true);
  });

  it("should fail when leaf slug is empty", () => {
    const leaf: NavLeaf = { slug: "", label: "leaf", kind: "form", bindingKey: "b", order: 1 };
    const app = makeApp("contracts", [leaf]);
    const result = validateNavConfig(makeConfig([makeSection("main", [app])]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("URL-safe"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-6: application count exceeds max per section
// ---------------------------------------------------------------------------

describe("MN-6 — validateNavConfig: application count exceeds max", () => {
  it("should fail when apps.length > NAV_MAX_APPS_PER_SECTION", () => {
    const apps = Array.from({ length: NAV_MAX_APPS_PER_SECTION + 1 }, (_, i) =>
      makeApp(`app-${i}`),
    );
    const result = validateNavConfig(makeConfig([makeSection("main", apps)]));
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("application count")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-7: leaf count exceeds max per application
// ---------------------------------------------------------------------------

describe("MN-7 — validateNavConfig: leaf count exceeds max", () => {
  it("should fail when leaves.length > NAV_MAX_LEAVES_PER_APP", () => {
    const leaves = Array.from({ length: NAV_MAX_LEAVES_PER_APP + 1 }, (_, i) =>
      makeLeaf(`leaf-${i}`),
    );
    const app = makeApp("contracts", leaves);
    const result = validateNavConfig(makeConfig([makeSection("main", [app])]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("leaf count"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-8: negative version
// ---------------------------------------------------------------------------

describe("MN-8 — validateNavConfig: negative version", () => {
  it("should fail when version is negative", () => {
    const result = validateNavConfig(makeConfig([], -1));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "version")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-9: classifyCatalogFieldChange: add_field → always allow
// ---------------------------------------------------------------------------

describe("MN-9 — classifyCatalogFieldChange: add_field → allow", () => {
  it("add_field with no existing spec → allow", () => {
    const change: CatalogFieldChange = {
      kind: "add_field",
      fieldKey: "new_custom_field",
      newFieldSpec: { fieldKey: "new_custom_field", label: "New Field", kind: "custom" },
    };
    const result = classifyCatalogFieldChange(undefined, change);
    expect(result.verdict).toBe("allow");
  });

  it("add_field even when existing spec is standard → allow (additive)", () => {
    // Adding a brand-new field is always additive, regardless of any existing spec context
    const change: CatalogFieldChange = {
      kind: "add_field",
      fieldKey: "another_field",
    };
    const result = classifyCatalogFieldChange(makeStandardField("id"), change);
    expect(result.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// MN-10: relabel → always allow (even on standard field)
// ---------------------------------------------------------------------------

describe("MN-10 — classifyCatalogFieldChange: relabel → allow", () => {
  it("relabel on standard field → allow (non-destructive, ADR §5 §4)", () => {
    const result = classifyCatalogFieldChange(makeStandardField("email"), {
      kind: "relabel",
      fieldKey: "email",
    });
    expect(result.verdict).toBe("allow");
    expect(result.changeKind).toBe("relabel");
  });

  it("relabel on custom field → allow", () => {
    const result = classifyCatalogFieldChange(makeCustomField("custom_note"), {
      kind: "relabel",
      fieldKey: "custom_note",
    });
    expect(result.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// MN-11: drop_field on standard → deny_core_pinned
// ---------------------------------------------------------------------------

describe("MN-11 — classifyCatalogFieldChange: drop_field on standard → deny_core_pinned", () => {
  it("drop_field standard field → deny", () => {
    const result = classifyCatalogFieldChange(makeStandardField("email"), {
      kind: "drop_field",
      fieldKey: "email",
    });
    expect(result.verdict).toBe("deny_core_pinned");
    if (result.verdict === "deny_core_pinned") {
      expect(result.fieldKey).toBe("email");
      expect(result.reason).toMatch(/core-owned standard field/);
      expect(result.changeKind).toBe("drop_field");
    }
  });

  it("drop_field: NO escape-hatch for standard (ADR §5 absolute ban)", () => {
    // No force parameter exists — the deny is unconditional for standard fields
    const result = classifyCatalogFieldChange(makeStandardField("id"), {
      kind: "drop_field",
      fieldKey: "id",
    });
    expect(result.verdict).toBe("deny_core_pinned");
  });
});

// ---------------------------------------------------------------------------
// MN-12: drop_field on custom → allow
// ---------------------------------------------------------------------------

describe("MN-12 — classifyCatalogFieldChange: drop_field on custom → allow", () => {
  it("drop_field custom field → allow", () => {
    const result = classifyCatalogFieldChange(makeCustomField("my_notes"), {
      kind: "drop_field",
      fieldKey: "my_notes",
    });
    expect(result.verdict).toBe("allow");
    expect(result.changeKind).toBe("drop_field");
  });
});

// ---------------------------------------------------------------------------
// MN-13: rename_field on standard → deny_core_pinned
// ---------------------------------------------------------------------------

describe("MN-13 — classifyCatalogFieldChange: rename_field on standard → deny_core_pinned", () => {
  it("rename_field standard field → deny", () => {
    const result = classifyCatalogFieldChange(makeStandardField("username"), {
      kind: "rename_field",
      fieldKey: "username",
    });
    expect(result.verdict).toBe("deny_core_pinned");
    if (result.verdict === "deny_core_pinned") {
      expect(result.reason).toMatch(/extend-not-replace/);
    }
  });
});

// ---------------------------------------------------------------------------
// MN-14: rename_field on custom → allow
// ---------------------------------------------------------------------------

describe("MN-14 — classifyCatalogFieldChange: rename_field on custom → allow", () => {
  it("rename_field custom field → allow", () => {
    const result = classifyCatalogFieldChange(makeCustomField("old_name"), {
      kind: "rename_field",
      fieldKey: "old_name",
    });
    expect(result.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// MN-15: overwrite_standard on standard → deny_core_pinned
// ---------------------------------------------------------------------------

describe("MN-15 — classifyCatalogFieldChange: overwrite_standard on standard → deny_core_pinned", () => {
  it("overwrite_standard on standard field → deny", () => {
    const result = classifyCatalogFieldChange(makeStandardField("email"), {
      kind: "overwrite_standard",
      fieldKey: "email",
    });
    expect(result.verdict).toBe("deny_core_pinned");
    if (result.verdict === "deny_core_pinned") {
      expect(result.reason).toMatch(/cannot be overwritten/);
    }
  });
});

// ---------------------------------------------------------------------------
// MN-16: overwrite_standard on custom → allow
// ---------------------------------------------------------------------------

describe("MN-16 — classifyCatalogFieldChange: overwrite_standard on custom → allow", () => {
  it("overwrite_standard on custom field → allow (custom is not core-pinned)", () => {
    const result = classifyCatalogFieldChange(makeCustomField("tenant_code"), {
      kind: "overwrite_standard",
      fieldKey: "tenant_code",
    });
    expect(result.verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// MN-17: CATALOG_STANDARD_FIELDS contains expected fields
// ---------------------------------------------------------------------------

describe("MN-17 — CATALOG_STANDARD_FIELDS: expected keys present", () => {
  it("user catalog has id, username, displayName, email, enabled", () => {
    const userFields = CATALOG_STANDARD_FIELDS.user;
    expect(userFields.has("id")).toBe(true);
    expect(userFields.has("username")).toBe(true);
    expect(userFields.has("displayName")).toBe(true);
    expect(userFields.has("email")).toBe(true);
    expect(userFields.has("enabled")).toBe(true);
  });

  it("org_unit catalog has id, slug, display_name, parent_id", () => {
    const ouFields = CATALOG_STANDARD_FIELDS.org_unit;
    expect(ouFields.has("id")).toBe(true);
    expect(ouFields.has("slug")).toBe(true);
    expect(ouFields.has("display_name")).toBe(true);
    expect(ouFields.has("parent_id")).toBe(true);
  });

  it("counterparty catalog has id, name, inn, type, status", () => {
    const cpFields = CATALOG_STANDARD_FIELDS.counterparty;
    expect(cpFields.has("id")).toBe(true);
    expect(cpFields.has("name")).toBe(true);
    expect(cpFields.has("inn")).toBe(true);
    expect(cpFields.has("type")).toBe(true);
    expect(cpFields.has("status")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MN-18: USER_CATALOG_STANDARD_FIELDS is consistent (ReadonlySet)
// ---------------------------------------------------------------------------

describe("MN-18 — USER_CATALOG_STANDARD_FIELDS is a ReadonlySet", () => {
  it("is a Set with 5 entries", () => {
    expect(USER_CATALOG_STANDARD_FIELDS).toBeInstanceOf(Set);
    expect(USER_CATALOG_STANDARD_FIELDS.size).toBe(5);
  });

  it("ORG_UNIT has 4 entries", () => {
    expect(ORG_UNIT_CATALOG_STANDARD_FIELDS.size).toBe(4);
  });

  it("COUNTERPARTY has 5 entries", () => {
    expect(COUNTERPARTY_CATALOG_STANDARD_FIELDS.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// MN-19: UserProjection type-shape: customFields distinct from standard keys
// ---------------------------------------------------------------------------

describe("MN-19 — UserProjection: customFields is distinct from standard keys", () => {
  it("USER_CATALOG_STANDARD_FIELDS does not contain 'customFields' key itself", () => {
    // customFields is the envelope for extensions — it must not be a standard field key
    expect(USER_CATALOG_STANDARD_FIELDS.has("customFields")).toBe(false);
  });

  it("no standard user field key appears in a plausible customFields object", () => {
    // Standard fields are top-level on UserProjection, not in customFields
    const customFieldsExample: Record<string, unknown> = {
      department_code: "FIN",
      employee_number: "12345",
    };
    for (const key of Object.keys(customFieldsExample)) {
      expect(USER_CATALOG_STANDARD_FIELDS.has(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// MN-20: NavLeaf kind 'form' and 'list' both valid
// ---------------------------------------------------------------------------

describe("MN-20 — NavLeaf: both 'form' and 'list' kind are valid", () => {
  it("config with form leaf validates cleanly", () => {
    const config = makeConfig([makeSection("main", [makeApp("apps", [makeLeaf("entry", "form")])])]);
    expect(validateNavConfig(config).valid).toBe(true);
  });

  it("config with list leaf validates cleanly", () => {
    const config = makeConfig([
      makeSection("main", [makeApp("apps", [makeLeaf("registry", "list")])]),
    ]);
    expect(validateNavConfig(config).valid).toBe(true);
  });

  it("config with both form and list leaves under same app validates cleanly", () => {
    const config = makeConfig([
      makeSection("main", [
        makeApp("contracts", [
          makeLeaf("new-contract", "form"),
          makeLeaf("contracts-list", "list"),
        ]),
      ]),
    ]);
    expect(validateNavConfig(config).valid).toBe(true);
  });
});
