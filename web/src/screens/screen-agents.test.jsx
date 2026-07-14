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

// ---------------------------------------------------------------------------
// T-0499 — agent ACTIVITY panel
// ---------------------------------------------------------------------------

describe('screen-agents — activity panel wiring (T-0499)', () => {
  it('reads the activity stream from GET /api/agents/:id/activity', () => {
    expect(src).toContain('/api/agents/${agentId}/activity');
  });
  it('has an "Активность" toggle (no dead button)', () => {
    expect(src).toContain('Активность');
    expect(src).toContain('setActivityOpen');
  });
  it('renders honest states (loading / error / empty)', () => {
    expect(src).toContain('Загрузка активности');
    expect(src).toContain('Агент ещё ничего не делал');
    // 401/403 are surfaced human via mapActivityError, not raw codes.
    expect(src).toContain('mapActivityError');
  });
  it('supports cursor pagination via «Загрузить ещё»', () => {
    expect(src).toContain('Загрузить ещё');
    expect(src).toContain('nextCursor');
  });
  it('maps outcomes to human chips (no raw agent.blocked jargon in the UI)', () => {
    expect(src).toContain('outcomeMeta');
    expect(src).not.toContain('agent.blocked');
    expect(src).not.toContain('agent.proceeded');
  });
});

// ---------------------------------------------------------------------------
// T-0637 — agent COMPETENCE INSTRUCTION editor (draft/publish)
// ---------------------------------------------------------------------------

describe('screen-agents — instruction editor wiring (T-0637)', () => {
  it('reads/writes the instruction via GET/PUT /api/agents/:id/instruction', () => {
    expect(src).toContain('/api/agents/${agentId}/instruction');
    expect(src).toMatch(/method:\s*'PUT'/);
  });
  it('has an "Инструкция агента" toggle (no dead button)', () => {
    expect(src).toContain('Инструкция агента');
    expect(src).toContain('setInstructionOpen');
  });
  it('publishes via the EXISTING shared promote route, not a new mechanism', () => {
    expect(src).toContain('/api/artifacts/${state.instruction_id}/promote');
    expect(src).toContain("artifact_table: 'agent_instruction'");
    expect(src).toMatch(/method:\s*'POST'/);
  });
  it('renders honest states (loading / error) and human tier labels', () => {
    expect(src).toContain('Загрузка инструкции');
    expect(src).toContain('instructionTierLabel');
    expect(src).toContain('mapAgentInstructionError');
    expect(src).toContain('mapAgentInstructionPromoteError');
  });
  it('the publish button is disabled with a reason when not in draft / no id yet (not a dead affordance)', () => {
    expect(src).toContain('canPublish');
    expect(src).toContain('publishDisabledReason');
  });
  it('the published-lock 409 is surfaced human, not a raw code', () => {
    expect(src).not.toMatch(/>\s*409\s*</);
  });
  it('uses only --chs-* tokens for the new section (no hardcoded color)', () => {
    // Scoped check: the tier badge / textarea / banner styles introduced for T-0637.
    const idx = src.indexOf('T-0637 — Instruction editor tokens');
    expect(idx).toBeGreaterThan(-1);
    const section = src.slice(idx, src.indexOf('function AgentInstructionEditor'));
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
