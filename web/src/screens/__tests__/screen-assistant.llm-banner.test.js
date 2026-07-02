/**
 * web/src/screens/__tests__/screen-assistant.llm-banner.test.js
 * (T-0599 — proactive "LLM key not connected" banner, BEFORE message send)
 *
 * Same convention as screen-assistant.error-envelope.test.js (T-0573/T-0595):
 * vitest "node" environment, no jsdom/mount — source-presence assertions on
 * the real screen file (regex over the exact code that ships), because a full
 * DOM-mount harness does not exist for this screen (project convention, see
 * screen-llm-connections.states.test.jsx).
 *
 * WHAT THIS PROVES (spec docs/specs/T-0599-assistant-banner.spec.md AC-4..AC-8,
 * AC-12):
 *   - AC-4: the banner is gated on loading having finished (no flash of a
 *     wrong state before GET /api/agents resolves).
 *   - AC-5: the banner shows on a PROVEN llm_bound===false, warning tone.
 *   - AC-6/AC-7: the deep-link button renders ONLY for admin (isGenesisOwner
 *     or zones includes 'admin'), read from the ALREADY-resolved
 *     getNavCapabilities() cache — no new fetch introduced by the banner.
 *   - AC-8: llm_bound===true (or unknown/null) never shows the banner.
 *   - AC-9 (regression guard): the 503 send() path / deepLinks render block
 *     from T-0573/T-0595 is untouched — covered by the EXISTING
 *     screen-assistant.error-envelope.test.js (still 12/12 green, unmodified).
 *   - AC-12: the new kit component (Notice) is used, not an ad-hoc inline div.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_PATH = path.resolve(HERE, '../screen-assistant.jsx');
const src = fs.readFileSync(SCREEN_PATH, 'utf-8');

const COMPONENTS_PATH = path.resolve(HERE, '../../components/components.jsx');
const componentsSrc = fs.readFileSync(COMPONENTS_PATH, 'utf-8');

describe('T-0599 — GET /api/agents reuse (N1: no new endpoint)', () => {
  it('useAssistantLlmStatus fetches the EXISTING /api/agents endpoint (not a new one)', () => {
    expect(src).toMatch(/function useAssistantLlmStatus\s*\(/);
    expect(src).toMatch(/useAssistantLlmStatus[\s\S]{0,400}fetch\('\/api\/agents'/);
  });

  it('identifies the assistant by slug === \'assistant-agent\' (the same identifier the runtime resolver uses)', () => {
    expect(src).toMatch(/find\(\(a\) => a\.slug === 'assistant-agent'\)/);
  });

  it('reads llm_bound from the found row — the honestly-resolved server field (T-0599 agents-list.ts fix)', () => {
    expect(src).toMatch(/Boolean\(assistant\.llm_bound\)/);
  });
});

describe('T-0599 — AC-4/AC-5/AC-8: loading-honesty and banner gating', () => {
  it('the hook starts in loading:true, llmBound:null (honest unknown, not an assumed state)', () => {
    expect(src).toMatch(/useState\(\{\s*loading:\s*true,\s*llmBound:\s*null\s*\}\)/);
  });

  it('network/parse failure resolves to llmBound:null (unknown), NOT false — never fabricate "definitely no key" from a network error', () => {
    expect(src).toMatch(/\.catch\(\(\) => setState\(\{\s*loading:\s*false,\s*llmBound:\s*null\s*\}\)\)/);
  });

  it('showLlmBanner requires BOTH loading finished AND llmBound proven false (AC-4/AC-5/AC-8)', () => {
    expect(src).toMatch(/showLlmBanner\s*=\s*!llmStatusLoading\s*&&\s*llmBound\s*===\s*false/);
  });

  it('the banner render is gated on showLlmBanner, not on llmBound alone', () => {
    expect(src).toMatch(/\{showLlmBanner\s*&&\s*<AssistantLlmBanner\s*\/>\}/);
  });
});

describe('T-0599 — AC-7 (F7): on-mount AND on-focus re-read (live banner without polling)', () => {
  it('the hook re-fetches on mount', () => {
    expect(src).toMatch(/useAssistantLlmStatus[\s\S]{0,2000}useEffect\(\(\) => \{ load\(\); \}, \[load\]\);/);
  });

  it('the hook re-fetches on window focus (return-from-/llm-connections scenario)', () => {
    expect(src).toMatch(/addEventListener\('focus', onFocus\)/);
    expect(src).toMatch(/removeEventListener\('focus', onFocus\)/);
  });

  it('does NOT introduce polling (no setInterval in the hook) — spec explicitly scopes out realtime', () => {
    // Scope the check to the hook body only, so an unrelated setInterval
    // elsewhere in the (1000+ line) screen file would not false-negative this.
    const hookMatch = src.match(/function useAssistantLlmStatus\(\)[\s\S]*?\n}\n/);
    expect(hookMatch).not.toBeNull();
    expect(hookMatch[0]).not.toMatch(/setInterval/);
  });
});

describe('T-0599 — AC-6/AC-7: admin-gated deep-link button, no new fetch for admin status', () => {
  it('AssistantLlmBanner reads admin status from the ALREADY-resolved getNavCapabilities() cache (no new fetch)', () => {
    expect(src).toMatch(/import \{ getNavCapabilities \} from '\.\.\/app-shell\/active-tenant\.js'/);
    expect(src).toMatch(/function AssistantLlmBanner\s*\(\)[\s\S]{0,200}getNavCapabilities\(\)/);
  });

  it('isAdmin mirrors the SAME predicate that gates the admin nav-zone (isGenesisOwner || zones includes admin)', () => {
    expect(src).toMatch(/isGenesisOwner\s*\|\|\s*\(navCaps\.zones\s*\|\|\s*\[\]\)\.includes\('admin'\)/);
  });

  it('the deep-link button navigates to /llm-connections and is rendered ONLY when isAdmin (no dead door for non-admins)', () => {
    expect(src).toMatch(/isAdmin \? \([\s\S]{0,200}navigate\('\/llm-connections'\)/);
  });

  it('non-admin text redirects to the tenant administrator, without a bare /llm-connections path', () => {
    // Extract just the non-admin ternary branch text to avoid false-matching the admin branch.
    const bannerMatch = src.match(/function AssistantLlmBanner\(\)[\s\S]*?\n}\n/);
    expect(bannerMatch).not.toBeNull();
    const bannerBody = bannerMatch[0];
    expect(bannerBody.toLowerCase()).toMatch(/администратор/);
    // The non-admin message string itself must not carry the bare path — only
    // structural checks (not string content assertions) verify the button is
    // absent for non-admin; here we additionally require the message text
    // string literal for non-admin has no literal '/llm-connections'.
    const nonAdminMsgMatch = bannerBody.match(/:\s*'([^']*Обратитесь к администратору[^']*)'/);
    expect(nonAdminMsgMatch).not.toBeNull();
    expect(nonAdminMsgMatch[1]).not.toContain('/llm-connections');
  });

  it('admin text names the page by its FACTUAL nav/h1 title «LLM-соединения» (UX_REVIEW T-0595 F-1 lesson, not a paraphrase)', () => {
    const bannerMatch = src.match(/function AssistantLlmBanner\(\)[\s\S]*?\n}\n/);
    const bannerBody = bannerMatch[0];
    expect(bannerBody).toContain('LLM-соединения');
  });
});

describe('T-0599 — AC-5: warning tone, jargon-free text', () => {
  it('the banner uses tone="warning" on the Notice kit component', () => {
    expect(src).toMatch(/<Notice\s*\n\s*tone="warning"/);
  });

  it('the visible banner text contains no dev-jargon denylist tokens (mirrors assistant-llm-message-jargon.sh denylist)', () => {
    const bannerMatch = src.match(/function AssistantLlmBanner\(\)[\s\S]*?\n}\n/);
    const bannerBody = bannerMatch[0];
    for (const tok of ['LLM_NOT_CONFIGURED', 'OpenAILlmPort', 'secretHandle', 'llm_bound', 'llm_connection_id']) {
      expect(bannerBody).not.toContain(tok);
    }
  });
});

describe('T-0599 — AC-12: Notice is a reused kit component, imported from components.jsx (not an ad-hoc inline div)', () => {
  it('screen-assistant.jsx imports Notice from the shared kit', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bNotice\b[^}]*\}\s*from\s*'\.\.\/components\/components\.jsx'/);
  });

  it('Notice is defined and exported in components.jsx (the actual kit source)', () => {
    expect(componentsSrc).toMatch(/function Notice\(\{ tone = "info", title, message, action, className = "" \}\)/);
    expect(componentsSrc).toMatch(/export \{[\s\S]*\bNotice\b[\s\S]*\}/);
  });

  it('Notice only uses --chs-* CSS tokens in its class names (no hardcoded colors in the component itself)', () => {
    const noticeFnMatch = componentsSrc.match(/function Notice\([\s\S]*?\n\}\n/);
    expect(noticeFnMatch).not.toBeNull();
    // The component itself carries no inline style/hex/rgba — all styling is
    // class-based (chs-notice*), tokens live in components.css.
    expect(noticeFnMatch[0]).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(noticeFnMatch[0]).not.toMatch(/rgba\(/);
    expect(noticeFnMatch[0]).not.toMatch(/style=/);
  });
});

describe('T-0599 — AC-9 (regression guard): 503 honest-degrade path (T-0573/T-0595) is untouched', () => {
  it('the 503 branch and deepLinks render block from T-0595 are still present verbatim', () => {
    expect(src).toMatch(/r\.status === 503/);
    expect(src).toMatch(/deepLinks\.map\(\(dl, i\) => \(/);
    expect(src).toMatch(/onClick=\{\(\) => navigate\(dl\.path\)\}/);
  });
});
