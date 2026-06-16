/**
 * src/core/modules-nav.ts
 *
 * T-0079 · E11.8: Modules Navigation Hierarchy + Core-Owned Reference Catalogs
 *                 extend-not-replace guard + users/org Keycloak projection.
 *
 * Pure TS — no I/O, no DB, no network, no filesystem, no env reads.
 * Mirrors purity-discipline of field-visibility.ts (T-0081),
 * authoring-redlines.ts (T-0078), and schema-change-classifier.ts (T-0177).
 *
 * Exports:
 *   --- Nav hierarchy (Section → Application → Form/List) ---
 *   - NavItemKind         — leaf type discriminator ('form' | 'list')
 *   - NavLeaf             — terminal nav item (form or list endpoint)
 *   - NavApplication      — application-level node (groups forms/lists)
 *   - NavSection          — top-level section (groups applications)
 *   - NavConfig           — complete versioned nav tree (one per tenant)
 *   - validateNavConfig   — pure guard: well-formed + bounded reorder
 *
 *   --- Core-owned catalog field guard ---
 *   - CatalogFieldKind    — 'standard' (core-pinned) | 'custom' (tenant-addable)
 *   - CatalogFieldSpec    — description of one field in a core-owned catalog
 *   - CatalogChangeKind   — proposed change type ('add_field' | 'drop_field' |
 *                           'rename_field' | 'overwrite_standard')
 *   - CatalogChangeDecision — verdict: 'allow' | 'deny_core_pinned'
 *   - classifyCatalogFieldChange — default-DENY guard (extend-not-replace)
 *
 *   --- users/org Keycloak projection ---
 *   - UserProjection      — read-only projection of a Keycloak user (no CRUD table)
 *   - OrgUnitRef          — lightweight reference to a department/position node
 *
 * ADR references (NF-1 mandatory):
 *   - docs/design/extensibility-and-authoring.md §5 (modules/sections;
 *     core-owned reference catalogs; extend-not-replace; default-DENY on
 *     irreversibility; users/org = Keycloak projection).
 *   - Precedent T-0078 · evaluateAuthoringRedLine (authoring-redlines.ts):
 *     default-DENY on irreversibility for authoring ops; §5 «core-owned» concept
 *     originates there. T-0079 = same discipline applied at catalog-field scope.
 *   - Precedent T-0177 · classifySchemaChange (schema-change-classifier.ts):
 *     drop/rename → destructive; force escape-hatch for registry_def.record_schema.
 *     For core-owned catalog fields, no escape-hatch (§5: «ядро БЛОКИРУЕТ»).
 *   - Precedent T-0072 · checkBindingCompat (binding-compat.ts):
 *     one control plane of «artifact ↔ field» consistency.
 *   - tenancy-ADR §6: Keycloak = auth + federation; RBAC in TS core;
 *     users = read-mostly projection, NOT a CRUD table.
 *
 * NOT IMPORTED: pg, fs, net, http, node:crypto, process.env, process.exit,
 *               grant-resolver, grant-lattice, data-classification, object-handle
 *               (no circular dependency, no second authority path).
 */

// ---------------------------------------------------------------------------
// Part 1: Nav hierarchy — Section → Application → Form/List
// ---------------------------------------------------------------------------

/**
 * Leaf item kind in the nav tree.
 * 'form'  — a transactional form entry point (intake, approval, edit).
 * 'list'  — a record list / catalog view.
 * Vocab is closed; additions are additive-migration-only.
 */
export type NavItemKind = "form" | "list";

/**
 * A terminal leaf in the nav hierarchy (Form or List endpoint).
 * formKey / listKey is the stable, machine-readable identifier for the
 * named-binding contract (field-key == variable-name from ADR §9.1).
 */
export interface NavLeaf {
  /** Stable slug — must be URL-safe, unique within parent application. */
  readonly slug: string;
  /** Human-visible label (relabeled via Floor-1 button edit). */
  readonly label: string;
  /** Discriminator: 'form' | 'list' */
  readonly kind: NavItemKind;
  /**
   * Machine reference to the form binding or list key.
   * Opaque string; validated by the form-binding layer, not here.
   */
  readonly bindingKey: string;
  /** Display order within parent application (1-based, bounded reorder). */
  readonly order: number;
}

/**
 * Application-level node: groups NavLeaves (forms and lists) under one name.
 * Maps to §5 «Application/Module» in the Section→App→Form/List hierarchy.
 */
export interface NavApplication {
  /** Stable slug — unique within parent section. */
  readonly slug: string;
  /** Human-visible label. */
  readonly label: string;
  /** Ordered leaves (forms + lists) under this application. */
  readonly leaves: readonly NavLeaf[];
  /** Display order within parent section (1-based, bounded reorder). */
  readonly order: number;
}

/**
 * Top-level section: groups NavApplications.
 * Maps to §5 «Section» (= stable left-sidebar section, preset, bounded reorder).
 */
export interface NavSection {
  /** Stable slug — unique within tenant nav config. */
  readonly slug: string;
  /** Human-visible label. */
  readonly label: string;
  /** Applications within this section. */
  readonly applications: readonly NavApplication[];
  /** Display order (1-based, bounded reorder). */
  readonly order: number;
}

/**
 * Complete versioned nav config for one tenant.
 * Emitted as versioned config (ADR §5: «агент эмитит nav как версионированный
 * config-файл»). Stored in nav_version table (migration 067).
 *
 * version is a monotonic counter — the storage layer increments it on each
 * committed change. Pure code does not issue versions; that is the adapter's role.
 */
export interface NavConfig {
  /** Monotonic version counter (set by storage layer, not by this module). */
  readonly version: number;
  /** Ordered top-level sections. */
  readonly sections: readonly NavSection[];
}

// ---------------------------------------------------------------------------
// NavConfig validation — bounded reorder, slug uniqueness, non-empty labels
// ---------------------------------------------------------------------------

/** One validation failure. */
export interface NavValidationError {
  readonly path: string;
  readonly message: string;
}

/** Result of validateNavConfig. */
export interface NavValidationResult {
  readonly valid: boolean;
  readonly errors: readonly NavValidationError[];
}

/**
 * Max number of sections allowed per nav config.
 * ADR §5: «стабильный неломаемый левый сайдбар с пресет-секциями + ограниченный reorder».
 * Bounded: prevents unbounded nav sprawl (platform integrity).
 */
export const NAV_MAX_SECTIONS = 20;
/** Max applications per section. */
export const NAV_MAX_APPS_PER_SECTION = 30;
/** Max leaves per application. */
export const NAV_MAX_LEAVES_PER_APP = 50;

/**
 * Validates a proposed NavConfig for structural correctness:
 *  - NC-1: Section count ≤ NAV_MAX_SECTIONS (bounded reorder guard).
 *  - NC-2: All section/application/leaf slugs are non-empty URL-safe strings.
 *  - NC-3: Slugs unique within their parent container.
 *  - NC-4: Labels non-empty.
 *  - NC-5: Application count per section ≤ NAV_MAX_APPS_PER_SECTION.
 *  - NC-6: Leaf count per application ≤ NAV_MAX_LEAVES_PER_APP.
 *  - NC-7: version ≥ 0 (non-negative integer).
 *
 * Pure; no IO/DB/env. Returns { valid, errors[] }.
 */
export function validateNavConfig(config: NavConfig): NavValidationResult {
  const errors: NavValidationError[] = [];

  // NC-7: version non-negative integer
  if (!Number.isInteger(config.version) || config.version < 0) {
    errors.push({ path: "version", message: "version must be a non-negative integer" });
  }

  // NC-1: section count bounded
  if (config.sections.length > NAV_MAX_SECTIONS) {
    errors.push({
      path: "sections",
      message: `section count ${config.sections.length} exceeds max ${NAV_MAX_SECTIONS}`,
    });
  }

  // NC-2/3/4 at section level
  const sectionSlugs = new Set<string>();
  for (const sec of config.sections) {
    const secPath = `sections[${sec.slug}]`;

    if (!isValidSlug(sec.slug)) {
      errors.push({ path: secPath + ".slug", message: "slug must be non-empty URL-safe string" });
    } else if (sectionSlugs.has(sec.slug)) {
      errors.push({ path: secPath + ".slug", message: `duplicate section slug '${sec.slug}'` });
    } else {
      sectionSlugs.add(sec.slug);
    }

    if (!sec.label || sec.label.trim() === "") {
      errors.push({ path: secPath + ".label", message: "label must be non-empty" });
    }

    // NC-5: app count bounded
    if (sec.applications.length > NAV_MAX_APPS_PER_SECTION) {
      errors.push({
        path: secPath + ".applications",
        message: `application count ${sec.applications.length} exceeds max ${NAV_MAX_APPS_PER_SECTION}`,
      });
    }

    const appSlugs = new Set<string>();
    for (const app of sec.applications) {
      const appPath = `${secPath}.applications[${app.slug}]`;

      if (!isValidSlug(app.slug)) {
        errors.push({ path: appPath + ".slug", message: "slug must be non-empty URL-safe string" });
      } else if (appSlugs.has(app.slug)) {
        errors.push({ path: appPath + ".slug", message: `duplicate application slug '${app.slug}'` });
      } else {
        appSlugs.add(app.slug);
      }

      if (!app.label || app.label.trim() === "") {
        errors.push({ path: appPath + ".label", message: "label must be non-empty" });
      }

      // NC-6: leaf count bounded
      if (app.leaves.length > NAV_MAX_LEAVES_PER_APP) {
        errors.push({
          path: appPath + ".leaves",
          message: `leaf count ${app.leaves.length} exceeds max ${NAV_MAX_LEAVES_PER_APP}`,
        });
      }

      const leafSlugs = new Set<string>();
      for (const leaf of app.leaves) {
        const leafPath = `${appPath}.leaves[${leaf.slug}]`;

        if (!isValidSlug(leaf.slug)) {
          errors.push({ path: leafPath + ".slug", message: "slug must be non-empty URL-safe string" });
        } else if (leafSlugs.has(leaf.slug)) {
          errors.push({ path: leafPath + ".slug", message: `duplicate leaf slug '${leaf.slug}'` });
        } else {
          leafSlugs.add(leaf.slug);
        }

        if (!leaf.label || leaf.label.trim() === "") {
          errors.push({ path: leafPath + ".label", message: "label must be non-empty" });
        }

        if (!leaf.bindingKey || leaf.bindingKey.trim() === "") {
          errors.push({ path: leafPath + ".bindingKey", message: "bindingKey must be non-empty" });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** URL-safe slug: non-empty, alphanumeric + hyphen/underscore only. */
function isValidSlug(s: string): boolean {
  return typeof s === "string" && s.length > 0 && /^[a-z0-9_-]+$/i.test(s);
}

// ---------------------------------------------------------------------------
// Part 2: Core-owned reference catalog field guard (extend-not-replace)
// ---------------------------------------------------------------------------

/**
 * Whether a catalog field is core-owned (standard) or tenant-addable (custom).
 * 'standard'  — auto-populated, core-pinned; drop/rename/overwrite is DENIED.
 * 'custom'    — added by tenant/agent; additive and modifiable.
 */
export type CatalogFieldKind = "standard" | "custom";

/**
 * Descriptor for one field in a core-owned reference catalog
 * (counterparties, org structure, users).
 *
 * Stored in catalog_field_spec table (migration 067).
 * For users/org: standard fields are read from the Keycloak projection
 * (UserProjection) and are immutable; custom fields are tenant extensions.
 */
export interface CatalogFieldSpec {
  /** Machine key — must match the named-binding contract. */
  readonly fieldKey: string;
  /** Human-visible label. */
  readonly label: string;
  /** 'standard' = core-pinned (extend-not-replace); 'custom' = tenant-addable. */
  readonly kind: CatalogFieldKind;
  /**
   * Name of the core-owned catalog this field belongs to.
   * Closed vocab (additive-migration-only): 'counterparty' | 'user' | 'org_unit'
   */
  readonly catalogName: "counterparty" | "user" | "org_unit";
}

/**
 * The kind of proposed change to a catalog field.
 * 'add_field'          — adding a new (custom) field → allowed.
 * 'drop_field'         — removing a field → DENIED if standard.
 * 'rename_field'       — renaming a field key → DENIED if standard.
 * 'overwrite_standard' — replacing a standard field's schema → DENIED if standard.
 * 'relabel'            — changing only the display label → always allowed (soft).
 */
export type CatalogChangeKind =
  | "add_field"
  | "drop_field"
  | "rename_field"
  | "overwrite_standard"
  | "relabel";

/**
 * A proposed change to one field in a core-owned catalog.
 */
export interface CatalogFieldChange {
  kind: CatalogChangeKind;
  /** The field being changed (must be supplied for all kinds except add_field). */
  fieldKey: string;
  /** For add_field: the new field spec to be added. */
  newFieldSpec?: Omit<CatalogFieldSpec, "catalogName">;
}

/**
 * Decision from the extend-not-replace guard.
 * 'allow'           — change is additive or relabel; safe to proceed.
 * 'deny_core_pinned'— change targets a standard field; blocked (no escape-hatch).
 */
export type CatalogChangeDecision =
  | { verdict: "allow"; changeKind: CatalogChangeKind }
  | {
      verdict: "deny_core_pinned";
      changeKind: CatalogChangeKind;
      fieldKey: string;
      reason: string;
    };

/**
 * Core-owned reference catalog extend-not-replace guard.
 *
 * Default-DENY on irreversibility (ADR §5, symmetric to RLS default-DENY):
 *   - add_field       → always ALLOW (additive, extend-not-replace).
 *   - relabel         → always ALLOW (non-destructive, display-only).
 *   - drop_field      → ALLOW for custom, DENY for standard.
 *   - rename_field    → ALLOW for custom, DENY for standard.
 *   - overwrite_standard → DENY for standard (irreversible by definition); ALLOW for custom.
 *
 * For standard fields there is NO escape-hatch (ADR §5: «ядро БЛОКИРУЕТ
 * delete/rename/overwrite стандартных авто-заполняемых полей»). This is
 * intentionally stricter than classifySchemaChange (T-0177) which allows a
 * force=true escape-hatch for non-core registry_def fields.
 *
 * @param existingSpec  — current field spec from catalog_field_spec
 *                        (undefined means the field does not yet exist → add_field only valid)
 * @param change        — proposed change
 * @returns CatalogChangeDecision
 */
export function classifyCatalogFieldChange(
  existingSpec: CatalogFieldSpec | undefined,
  change: CatalogFieldChange,
): CatalogChangeDecision {
  const { kind, fieldKey } = change;

  // add_field: always allowed (extend-not-replace, additive)
  if (kind === "add_field") {
    return { verdict: "allow", changeKind: kind };
  }

  // relabel: always allowed (soft, display-only; ADR §5 + §4)
  if (kind === "relabel") {
    return { verdict: "allow", changeKind: kind };
  }

  // For destructive ops (drop, rename, overwrite): check field kind
  const isStandard = existingSpec?.kind === "standard";

  if (kind === "drop_field") {
    if (isStandard) {
      return {
        verdict: "deny_core_pinned",
        changeKind: kind,
        fieldKey,
        reason: `field '${fieldKey}' is a core-owned standard field and cannot be dropped (extend-not-replace, ADR §5)`,
      };
    }
    return { verdict: "allow", changeKind: kind };
  }

  if (kind === "rename_field") {
    if (isStandard) {
      return {
        verdict: "deny_core_pinned",
        changeKind: kind,
        fieldKey,
        reason: `field '${fieldKey}' is a core-owned standard field and cannot be renamed (extend-not-replace, ADR §5)`,
      };
    }
    return { verdict: "allow", changeKind: kind };
  }

  if (kind === "overwrite_standard") {
    // overwrite_standard is destructive by definition — for standard fields, unconditional deny.
    if (isStandard) {
      return {
        verdict: "deny_core_pinned",
        changeKind: kind,
        fieldKey,
        reason: `field '${fieldKey}' is a core-owned standard field and cannot be overwritten (extend-not-replace, ADR §5)`,
      };
    }
    // Custom field: allow (tenant's own field, not core-pinned)
    return { verdict: "allow", changeKind: kind };
  }

  // Exhaustive fallback (TypeScript narrowing safety)
  return { verdict: "allow", changeKind: kind };
}

// ---------------------------------------------------------------------------
// Part 3: users/org = read-mostly Keycloak projection (no second user store)
// ---------------------------------------------------------------------------

/**
 * Read-only projection of a Keycloak user into Choros.
 * NOT a DB table; derived from KC JWT claims + KC admin API at read time.
 * Tenancy-ADR §6: «Keycloak = auth+федерация, RBAC в TS-ядре».
 *
 * Standard fields here are the core-owned field set for the 'user' catalog.
 * Tenants may add custom fields via catalog_field_spec (kind='custom');
 * the standard fields below are NOT modifiable (classifyCatalogFieldChange guards them).
 */
export interface UserProjection {
  /** Keycloak user UUID (sub claim). Immutable, core-pinned. */
  readonly id: string;
  /** Username / preferred_username from KC token. Core-pinned. */
  readonly username: string;
  /** Display name (name claim or firstName+lastName). Core-pinned. */
  readonly displayName: string;
  /** Primary email from KC. Core-pinned. */
  readonly email: string;
  /** Whether the KC user is enabled. Core-pinned. */
  readonly enabled: boolean;
  /**
   * Tenant-local role assignments (derived from RBAC, not from KC roles).
   * This is the RBAC-layer view; KC groups/roles are NOT directly surfaced.
   */
  readonly roleIds: readonly string[];
  /**
   * Optional reference to an org unit (department/position from T-0017).
   * Null if the user is not mapped to an org node.
   */
  readonly orgUnitRef: OrgUnitRef | null;
  /**
   * Custom tenant-extension fields (key→value map).
   * Keys present here correspond to CatalogFieldSpec rows with kind='custom'
   * and catalogName='user'. Core-pinned standard keys above are NOT repeated here.
   */
  readonly customFields: Readonly<Record<string, unknown>>;
}

/**
 * Lightweight reference to an org unit (department or position node).
 * Points into choros.department / choros.position tables (migration 014/015).
 * Read-mostly; the actual department/position row is resolved by the edge layer.
 */
export interface OrgUnitRef {
  /** 'department' | 'position' — which table this ref points to. */
  readonly kind: "department" | "position";
  /** UUID of the department or position row (tenant-scoped). */
  readonly id: string;
  /** Denormalized display name for quick display (from the referenced row). */
  readonly displayName: string;
}

/**
 * Standard field keys for the 'user' catalog.
 * These are core-pinned: any CatalogFieldChange targeting one of these keys
 * for a CatalogFieldSpec with kind='standard' + catalogName='user' will be
 * DENIED by classifyCatalogFieldChange.
 *
 * Additive (new standard fields may be added via additive-migration + new key here),
 * never removable from this set (symmetric to frozen-checks discipline).
 */
export const USER_CATALOG_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "username",
  "displayName",
  "email",
  "enabled",
]);

/**
 * Standard field keys for the 'org_unit' catalog.
 * Core-pinned fields of the department/position projection.
 */
export const ORG_UNIT_CATALOG_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "slug",
  "display_name",
  "parent_id",
]);

/**
 * Standard field keys for the 'counterparty' catalog.
 * Core-pinned fields of the counterparty reference catalog.
 */
export const COUNTERPARTY_CATALOG_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "inn",
  "type",
  "status",
]);

/**
 * Map of catalogName → set of standard (core-pinned) field keys.
 * Used by the HTTP layer to look up whether a field is standard before
 * calling classifyCatalogFieldChange.
 */
export const CATALOG_STANDARD_FIELDS: Readonly<
  Record<CatalogFieldSpec["catalogName"], ReadonlySet<string>>
> = {
  user: USER_CATALOG_STANDARD_FIELDS,
  org_unit: ORG_UNIT_CATALOG_STANDARD_FIELDS,
  counterparty: COUNTERPARTY_CATALOG_STANDARD_FIELDS,
};
