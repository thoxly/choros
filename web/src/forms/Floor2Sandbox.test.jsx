/**
 * web/src/forms/Floor2Sandbox.test.jsx  (T-0481 · E-FORMS F2)
 *
 * Class-b sandbox isolation tests (deliverable 4). Verifies the srcdoc builder
 * (pure) enforces the binding contract + isolation discipline:
 *   - the sandbox attribute is allow-scripts WITHOUT allow-same-origin (opaque
 *     origin) — the same T-0101 isolation the forms-sandbox-iframe uses;
 *   - the widget receives ONLY a plain-data binding island (no parent refs);
 *   - custom code mounts ONLY when explicitly flagged (§9.10 governance).
 *
 * We test the pure srcdoc builder + the component's flag gate via the tree-walk
 * approach (no DOM — node env).
 */

import { describe, it, expect } from 'vitest';
import { buildSandboxSrcdoc, decideSandboxRender, SANDBOX_ATTR } from './Floor2Sandbox.jsx';

describe('buildSandboxSrcdoc (binding island + isolation)', () => {
  it('injects ONLY plain field data (key/label/type/value) — no parent refs', () => {
    const srcdoc = buildSandboxSrcdoc(
      { componentId: 'kanban', code: 'document.getElementById("root").textContent="ok";' },
      [{ key: 'status', label: 'Статус', type: 'select', value: 'new' }],
    );
    expect(srcdoc).toContain('"key":"status"');
    expect(srcdoc).toContain('"value":"new"');
    // the user code is embedded, runs over `binding` only.
    expect(srcdoc).toContain('var binding=');
    expect(srcdoc).toContain('textContent="ok"');
    // posts height back via the T-0101 channel.
    expect(srcdoc).toContain('fjs-height');
  });

  it('falls back to a safe default render when no code is given', () => {
    const srcdoc = buildSandboxSrcdoc({ componentId: 'x' }, [{ key: 'a', value: 1 }]);
    expect(srcdoc).toContain('binding.fields');
    expect(typeof srcdoc).toBe('string');
  });
});

describe('governance + sandbox attribute (decideSandboxRender)', () => {
  it('refuses unflagged custom code (§9.10) — flagged:false', () => {
    expect(decideSandboxRender({ componentId: 'kanban', code: 'evil()' }).flagged).toBe(false);
    expect(decideSandboxRender({}).flagged).toBe(false);
  });

  it('mounts only when explicitly flagged — flagged:true', () => {
    expect(decideSandboxRender({ componentId: 'kanban', code: 'x', flagged: true }).flagged).toBe(true);
  });

  it('the sandbox attribute is allow-scripts WITHOUT allow-same-origin (opaque origin)', () => {
    expect(SANDBOX_ATTR).toBe('allow-scripts');
    expect(SANDBOX_ATTR).not.toContain('allow-same-origin');
    expect(decideSandboxRender({ flagged: true }).sandboxAttr).toBe('allow-scripts');
  });
});
