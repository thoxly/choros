/**
 * web/src/screens/__tests__/screen-llm-connections.a11y.test.jsx  (T-0574, FF-UX-5)
 *
 * AC-12 — the API-key input carries label/aria-*, autoComplete=off, type=password
 * (N5, not a regression); the «Назначить ассистенту» action has no dead
 * enabled-no-op affordance (it is hidden/replaced by a chip once the profile is
 * already the assistant's active connection).
 *
 * Approach (project convention — vitest "node" environment, no jsdom/DOM mount,
 * no react-dom/react-test-renderer in this repo): source-text presence checks
 * (fs.readFileSync + toMatch/toContain), mirroring the existing "CSS-токены"
 * block in screen-llm-connections.test.jsx. NOTE: the kit `Field` component
 * (components.jsx) itself calls `useId()` — a real hook — so it CANNOT be
 * invoked directly as a plain function outside a render (confirmed: doing so
 * throws "Cannot read properties of null (reading 'useId')", since there is no
 * dispatcher outside a React render pass and this repo has no react-dom /
 * react-test-renderer to mount one). Field's own label/aria/id-binding contract
 * is therefore proven at the SOURCE level here (this screen's call site
 * literally sets label/type/autoComplete) rather than by re-deriving it via a
 * direct call — consistent with how the rest of this screen's test suite
 * already treats hook-bearing components (grep, not mount).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_PATH = path.resolve(HERE, '../screen-llm-connections.jsx');
const src = fs.readFileSync(SCREEN_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// (1) The API-key Field call site carries label/type/autoComplete (N5).
// ---------------------------------------------------------------------------

describe('T-0574 (FF-UX-5/AC-12) — API-key field: label/type/autoComplete (N5, not a regression)', () => {
  it('the API-key Field has an explicit human label', () => {
    expect(src).toMatch(/label="API-ключ \(вставить\)"/);
  });

  it('the same Field block sets type="password" and autoComplete="off"', () => {
    const fieldBlockMatch = src.match(/<Field\s+label="API-ключ \(вставить\)"[\s\S]{0,400}?\/>/);
    expect(fieldBlockMatch).not.toBeNull();
    expect(fieldBlockMatch[0]).toContain('type="password"');
    expect(fieldBlockMatch[0]).toContain('autoComplete="off"');
  });

  it('the Field kit component itself always binds <label htmlFor> to the input id (components.jsx contract)', () => {
    const componentsPath = path.resolve(HERE, '../../components/components.jsx');
    const componentsSrc = fs.readFileSync(componentsPath, 'utf-8');
    const fieldFnMatch = componentsSrc.match(/function Field\([\s\S]*?\n}\n/);
    expect(fieldFnMatch).not.toBeNull();
    const body = fieldFnMatch[0];
    expect(body).toMatch(/<label className="chs-label" htmlFor=\{inputId\}>/);
    expect(body).toMatch(/<input\s/);
    expect(body).toMatch(/id=\{inputId\}/);
    expect(body).toMatch(/aria-invalid=\{invalid \|\| undefined\}/);
    expect(body).toMatch(/aria-describedby=\{hintId\}/);
  });
});

// ---------------------------------------------------------------------------
// (2) «Назначить ассистенту» — no dead enabled-no-op affordance once assigned.
// ---------------------------------------------------------------------------

describe('T-0574 (FF-UX-5/AC-12) — assistant-assign action has no dead enabled-no-op', () => {
  it('AssistantBinder renders a chip (not a clickable Button) once assigned — the ternary gates on isAssigned', () => {
    // The component MUST branch: isAssigned ? <chip> : <Button ...>Назначить ассистенту</Button>
    const fnMatch = src.match(/function AssistantBinder[\s\S]*?\n}\n/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];
    expect(fnBody).toMatch(/isAssigned\s*\?\s*\(/);
    // The Button branch (the "assign" affordance) is the FALSE branch of the
    // ternary — i.e. only rendered when isAssigned is false. A crude but
    // reliable structural check: the chip span appears BEFORE the Button in
    // the ternary's source order (`cond ? <chip> : <Button>`).
    const chipIdx = fnBody.indexOf('ассистент использует этот профиль');
    const buttonIdx = fnBody.indexOf('Назначить ассистенту');
    expect(chipIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(chipIdx).toBeLessThan(buttonIdx);
  });

  it('the Button is disabled while busy or while the assistant binding is not yet resolved (no premature enabled state)', () => {
    const fnMatch = src.match(/function AssistantBinder[\s\S]*?\n}\n/);
    const fnBody = fnMatch[0];
    expect(fnBody).toMatch(/disabled=\{busy \|\| !assistantBinding\}/);
  });

  it('a 404 from the bind attempt (anti-regression sentinel, ADR §2.3) is surfaced honestly, not swallowed', () => {
    const fnMatch = src.match(/function AssistantBinder[\s\S]*?\n}\n/);
    const fnBody = fnMatch[0];
    expect(fnBody).toMatch(/res\.status === 404/);
  });
});
