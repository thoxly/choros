/**
 * web/src/app-shell/shell.sidebar.test.jsx — T-0651 (sidebar-workspace)
 *
 * Structural + wiring invariants for the sidebar's T-0651 additions. Following
 * the same "read the source, assert the invariant" approach as
 * FormDesigner.test.jsx (this web tier has no jsdom / @testing-library, so full
 * mount + interaction is out of scope here — the interactive LOGIC is covered
 * by sidebar-dnd.test.js / sidebar-app-menu.test.js / user-prefs / nav-sections;
 * these assertions lock the wiring that regex can prove without a DOM).
 *
 * The invariants that matter for review:
 *   - collapse groups use aria-expanded (accessible, keyboard-operable button),
 *     NOT a div-with-onClick;
 *   - the DnD keeps ▲/▼ buttons (first-class keyboard alternative, spec §2C —
 *     DnD is ADDED, never replaces the arrows);
 *   - the task counter is wired to the SAME feed the inbox screen reads
 *     (GET /api/inbox counts.mine), not a static seed;
 *   - collapsed-group state persists via the user_pref key;
 *   - NO nested sections are introduced (ADR T-0551 §6 / T-0651 §3 boundary).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_SRC = readFileSync(join(__dirname, 'shell.jsx'), 'utf-8');

describe('sidebar collapse (T-0651)', () => {
  it('zone header is a keyboard-operable button with aria-expanded', () => {
    // CollapsibleZoneHeader must render a <button> with aria-expanded — a
    // div-onClick would be inaccessible (the whole point of keeping the ▲/▼
    // pattern is a11y, so the collapse toggle must be a11y too).
    expect(SHELL_SRC).toMatch(/function CollapsibleZoneHeader/);
    const headerBlock = SHELL_SRC.slice(SHELL_SRC.indexOf('function CollapsibleZoneHeader'));
    expect(headerBlock).toMatch(/aria-expanded=\{!collapsed\}/);
    expect(headerBlock).toMatch(/<button/);
  });

  it('collapse state persists to the user_pref store on toggle', () => {
    expect(SHELL_SRC).toMatch(/setUserPref\(SIDEBAR_COLLAPSED_GROUPS_KEY/);
  });

  it('РАБОТА zone is never collapsible (permanent home layer, spec §2A)', () => {
    // collapsible flag excludes the work zone.
    expect(SHELL_SRC).toMatch(/const collapsible = zone\.id !== "work"/);
  });

  it('default-collapsed set is exactly the three secondary zones', () => {
    expect(SHELL_SRC).toMatch(/\['constructor', 'observability', 'admin'\]/);
  });
});

describe('sidebar DnD keeps ▲/▼ (T-0651 spec §2C)', () => {
  it('app row renders BOTH arrow buttons (up + down) alongside the drag handle', () => {
    const rowBlock = SHELL_SRC.slice(SHELL_SRC.indexOf('function SidebarAppRow'));
    expect(rowBlock).toMatch(/onMoveArrow\(app\.id, -1\)/); // up
    expect(rowBlock).toMatch(/onMoveArrow\(app\.id, 1\)/);  // down
    expect(rowBlock).toMatch(/draggable/);                  // DnD on the same row
  });

  it('section header renders arrow buttons AND is a drop target', () => {
    const secBlock = SHELL_SRC.slice(SHELL_SRC.indexOf('function SidebarSectionGroup'));
    expect(secBlock).toMatch(/onMoveArrow\(section\.section_id, -1\)/);
    expect(secBlock).toMatch(/onMoveArrow\(section\.section_id, 1\)/);
    expect(secBlock).toMatch(/onDrop=/);
  });
});

describe('task counter wired to the live inbox feed (T-0651)', () => {
  it('reads counts.mine from GET /api/inbox (same feed the inbox screen uses)', () => {
    expect(SHELL_SRC).toMatch(/\/api\/inbox\?tab=all&limit=1/);
    expect(SHELL_SRC).toMatch(/counts\.mine/);
  });

  it('passes the live count to the inbox NavItem only (not a static seed)', () => {
    expect(SHELL_SRC).toMatch(/liveCount=\{item\.id === "inbox" \? \(inboxMineCount/);
  });
});

describe('boundaries (T-0651 §3)', () => {
  it('does not introduce nested sections (no section-inside-section rendering)', () => {
    // SidebarSectionGroup must not render another SidebarSectionGroup as a child.
    const secBlock = SHELL_SRC.slice(
      SHELL_SRC.indexOf('function SidebarSectionGroup'),
      SHELL_SRC.indexOf('function SidebarCreateSection'),
    );
    expect(secBlock).not.toMatch(/<SidebarSectionGroup/);
  });

  it('reuses the existing app-management modals (no duplicate rename/section UI)', () => {
    // Imports the T-0567/T-0551 modals from screen-apps.jsx rather than
    // re-implementing them.
    expect(SHELL_SRC).toMatch(/import \{ RenameAppModal, SetSectionModal \} from '\.\.\/screens\/screen-apps\.jsx'/);
  });
});
