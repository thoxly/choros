/**
 * web/src/screens/screen-agents.test.jsx  (T-0498)
 *
 * Source-presence tests for the per-agent LLM-connection selector on the agents
 * screen (screen-agents.jsx). Convention (project): vitest "node" environment,
 * no React mount — the carrying logic is the pure helpers (agents-form.js, tested
 * separately); here we assert the selector wiring + token discipline structurally.
 *
 *   - the "LLM-подключение" selector is present and PUTs to /api/agents/:id/llm-connection;
 *   - the "Не задано (по умолчанию)" default option exists (detach path);
 *   - the soft connect-hint copy is present (no dead button — it navigates);
 *   - only existing --chs-* tokens (no --chs-color-primary / --chs-weight-normal).
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-agents.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-agents — LLM-connection selector wiring', () => {
  it('renders the "LLM-подключение" selector', () => {
    expect(src).toContain('LLM-подключение');
  });
  it('PUTs the binding to PUT /api/agents/:id/llm-connection', () => {
    expect(src).toContain('/api/agents/${agent.id}/llm-connection');
    expect(src).toMatch(/method:\s*'PUT'/);
  });
  it('reads the connection registry from GET /api/llm-connections', () => {
    expect(src).toContain('/api/llm-connections');
  });
  it('offers a "Не задано (по умолчанию)" default option (detach path)', () => {
    expect(src).toContain('Не задано (по умолчанию)');
  });
  it('shows the current binding from agent.llm_connection_id', () => {
    expect(src).toContain('agent.llm_connection_id');
  });
  it('has a soft connect-hint that navigates to LLM-connections (no dead button)', () => {
    expect(src).toContain('Создайте подключение');
    expect(src).toContain("navigate('/llm-connections')");
  });
  it('handles a 403 on the connections list honestly (selector disabled, not an error)', () => {
    expect(src).toContain('setConnectionsAvailable');
  });
});

describe('screen-agents — token discipline (OBLIK)', () => {
  it('does NOT use the non-existent --chs-color-primary token', () => {
    expect(src).not.toMatch(/--chs-color-primary[^-]/);
  });
  it('does NOT use the non-existent --chs-weight-normal token', () => {
    expect(src).not.toContain('--chs-weight-normal');
  });
});
