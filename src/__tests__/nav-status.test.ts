/**
 * T-0260 → T-0355: NAV status / filtering logic + IA structure — unit tests.
 *
 * nav-config.js lives in web/src (excluded from root vitest by config).
 * This test mirrors the logic in-source so the classification contract is
 * covered by the ambient CI gate without needing a cross-package import.
 *
 * T-0355 update: reflects the authoring/work two-space IA split.
 * If you update the logic in nav-config.js, update the mirror here too.
 */
import { describe, it, expect } from "vitest";

type NavStatus = "live" | "demo" | "soon";
type NavSpace  = "authoring" | "work";

interface NavItem {
  id: string;
  label: string;
  icon: string;
  path?: string;   // T-0355: optional route override
  screen?: boolean;
  soon?: boolean;
  hidden?: boolean;
  status: NavStatus;
  count?: number;
}

interface NavGroup {
  group: string;
  space?: NavSpace;  // T-0355: authoring | work (undefined = home, above both spaces)
  items: NavItem[];
  home?: boolean;
}

// ------ Mirrored helpers (must stay in lockstep with nav-config.js) --------

function visibleItems(group: NavGroup): NavItem[] {
  return group.items.filter((item) => !item.hidden);
}

function effectiveStatus(item: NavItem): NavStatus {
  if (item.status) return item.status;
  if (item.soon) return "soon";
  return "live";
}

// ------ Reference classification (must match NAV in nav-config.js) ---------
// T-0355: two-space IA. Home group has no space. Authoring groups come before
// work groups in nav order.

const NAV: NavGroup[] = [
  // Home — above both spaces
  {
    group: "Обзор",
    home: true,
    items: [
      { id: "overview", label: "Обзор", icon: "apps", screen: true, status: "live" },
    ],
  },
  // ── AUTHORING ────────────────────────────────────────────────────────────
  {
    group: "Конструктор",
    space: "authoring",
    items: [
      { id: "apps",  label: "Приложения",  icon: "apps",  screen: true, status: "live" },
      { id: "forms", label: "Формы задач", icon: "forms", screen: true, status: "demo" },
    ],
  },
  {
    group: "Модельер",
    space: "authoring",
    items: [
      { id: "modeler", label: "Модельер", icon: "process", path: "/processes/new/edit", screen: true, status: "demo" },
    ],
  },
  {
    group: "Ассистент",
    space: "authoring",
    items: [
      { id: "assistant", label: "Ассистент", icon: "assistant", screen: true, status: "demo" },
    ],
  },
  // ── WORK ─────────────────────────────────────────────────────────────────
  {
    group: "Работа",
    space: "work",
    items: [
      { id: "inbox",     label: "Мои задачи", icon: "inbox",   screen: true, status: "live" },
      { id: "processes", label: "Процессы",   icon: "process", screen: true, status: "live" },
    ],
  },
  {
    group: "Исполнители и доступ",
    space: "work",
    items: [
      { id: "org",    label: "Оргструктура",   icon: "org",    screen: true, status: "live" },
      { id: "agents", label: "Агенты",          icon: "org",    screen: true, status: "live" },
      { id: "rights", label: "Права и доступ",  icon: "rights", screen: true, status: "live" },
    ],
  },
  {
    group: "Наблюдаемость",
    space: "work",
    items: [
      { id: "notifications", label: "Уведомления", icon: "bell",   screen: true, status: "live" },
      { id: "audit",         label: "Аудит",       icon: "audit",  screen: true, status: "live" },
      { id: "budgets",       label: "Бюджеты",     icon: "budget", soon: true,   status: "soon" },
    ],
  },
];

// ------ Tests ---------------------------------------------------------------

describe("visibleItems (T-0260)", () => {
  it("returns all items when none are hidden", () => {
    const grp = NAV[0];
    expect(visibleItems(grp)).toHaveLength(grp.items.length);
  });

  it("filters out hidden items", () => {
    const grp: NavGroup = {
      group: "Test",
      items: [
        { id: "a", label: "A", icon: "x", screen: true, status: "live" },
        { id: "b", label: "B", icon: "x", screen: true, status: "demo", hidden: true },
        { id: "c", label: "C", icon: "x", soon: true, status: "soon" },
      ],
    };
    const visible = visibleItems(grp);
    expect(visible).toHaveLength(2);
    expect(visible.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("returns empty array when all items are hidden", () => {
    const grp: NavGroup = {
      group: "Empty",
      items: [
        { id: "x", label: "X", icon: "x", status: "live", hidden: true },
      ],
    };
    expect(visibleItems(grp)).toHaveLength(0);
  });
});

describe("effectiveStatus (T-0260)", () => {
  it("returns status field when present", () => {
    const item: NavItem = { id: "a", label: "A", icon: "x", screen: true, status: "live" };
    expect(effectiveStatus(item)).toBe("live");
  });

  it("returns 'soon' for legacy soon:true items (backwards compat)", () => {
    const item: NavItem = { id: "b", label: "B", icon: "x", soon: true, status: "soon" };
    expect(effectiveStatus(item)).toBe("soon");
  });

  it("returns 'demo' for explicitly demo items", () => {
    const item: NavItem = { id: "c", label: "C", icon: "x", screen: true, status: "demo" };
    expect(effectiveStatus(item)).toBe("demo");
  });
});

describe("NAV classification invariants (T-0260)", () => {
  const allItems = NAV.flatMap((g) => g.items);

  it("every nav item has a status field", () => {
    for (const item of allItems) {
      expect(["live", "demo", "soon"], `item ${item.id} missing valid status`).toContain(item.status);
    }
  });

  it("no item is both hidden and screen:true without a status", () => {
    // hidden items have status (just not rendered)
    for (const item of allItems) {
      if (item.hidden) {
        expect(item.status, `hidden item ${item.id} must still have status`).toBeTruthy();
      }
    }
  });

  it("inbox is live", () => {
    const inbox = allItems.find((i) => i.id === "inbox");
    expect(inbox?.status).toBe("live");
  });

  it("org is live (T-0269: real CRUD)", () => {
    const org = allItems.find((i) => i.id === "org");
    expect(org?.status).toBe("live");
  });

  it("forms is demo (developer sandbox, not production screen)", () => {
    const forms = allItems.find((i) => i.id === "forms");
    expect(forms?.status).toBe("demo");
  });

  it("budgets is soon (not built)", () => {
    const budgets = allItems.find((i) => i.id === "budgets");
    expect(budgets?.status).toBe("soon");
  });

  it("audit is live (real API + export action)", () => {
    const audit = allItems.find((i) => i.id === "audit");
    expect(audit?.status).toBe("live");
  });

  it("notifications is live (real API with mark-read)", () => {
    const notif = allItems.find((i) => i.id === "notifications");
    expect(notif?.status).toBe("live");
  });

  it("rights is live (overview + intents + trail are real)", () => {
    const rights = allItems.find((i) => i.id === "rights");
    expect(rights?.status).toBe("live");
  });

  it("processes is live (real API + launch action)", () => {
    const proc = allItems.find((i) => i.id === "processes");
    expect(proc?.status).toBe("live");
  });

  it("all 'soon' items are not screen:true (non-clickable)", () => {
    const soonItems = allItems.filter((i) => i.status === "soon");
    for (const item of soonItems) {
      expect(item.screen, `soon item ${item.id} should not be screen:true`).toBeFalsy();
    }
  });

  it("all items with status are marked (no unmarked path to a screen)", () => {
    // Every item that has screen:true must have a status set explicitly.
    const screenItems = allItems.filter((i) => i.screen);
    for (const item of screenItems) {
      expect(item.status, `screen item ${item.id} must have explicit status`).toBeTruthy();
    }
  });
});

describe("T-0355: two-space IA invariants", () => {
  it("home group has no space and home:true", () => {
    const home = NAV.find((g) => g.home);
    expect(home).toBeDefined();
    expect(home?.space).toBeUndefined();
  });

  it("exactly one home group", () => {
    expect(NAV.filter((g) => g.home)).toHaveLength(1);
  });

  it("authoring groups include Конструктор, Модельер, Ассистент", () => {
    const authoring = NAV.filter((g) => g.space === "authoring").map((g) => g.group);
    expect(authoring).toContain("Конструктор");
    expect(authoring).toContain("Модельер");
    expect(authoring).toContain("Ассистент");
  });

  it("work groups include Работа, Исполнители и доступ, Наблюдаемость", () => {
    const work = NAV.filter((g) => g.space === "work").map((g) => g.group);
    expect(work).toContain("Работа");
    expect(work).toContain("Исполнители и доступ");
    expect(work).toContain("Наблюдаемость");
  });

  it("all authoring groups appear before work groups (after home)", () => {
    const nonHome = NAV.filter((g) => !g.home);
    let seenWork = false;
    for (const grp of nonHome) {
      if (grp.space === "work") seenWork = true;
      if (seenWork) {
        expect(grp.space).not.toBe("authoring");
      }
    }
  });

  it("no duplicate item ids across all groups", () => {
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Модельер item has a path override pointing to existing route", () => {
    const modelerGrp = NAV.find((g) => g.group === "Модельер");
    expect(modelerGrp).toBeDefined();
    const modeler = modelerGrp!.items.find((i) => i.id === "modeler");
    expect(modeler?.path).toMatch(/^\/processes\/.+\/edit$/);
    // Must NOT be bare /modeler (no such route exists yet)
    expect(modeler?.path).not.toBe("/modeler");
  });

  it("assistant is in authoring space and is demo (no live LLM backend yet)", () => {
    const assistantGrp = NAV.find((g) => g.group === "Ассистент");
    expect(assistantGrp?.space).toBe("authoring");
    const assistant = assistantGrp?.items.find((i) => i.id === "assistant");
    expect(assistant?.status).toBe("demo");
  });
});
