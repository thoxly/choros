/**
 * Unit tests for src/core/process-gen-loop.ts — T-0464 [D8-G3].
 *
 * Spec: docs/specs/text-first-solution-builder.spec.md §3.4.
 *
 * Contract under test (the four task acceptance points):
 *   1. The loop REPAIRS a lint-failing draft and converges: a scripted bot that
 *      first emits a broken (dead-branch) draft, then a fixed one when fed the
 *      lint feedback, ends in status="draft_ready".
 *   2. An ungroundable condition (missing field) triggers cascade/ask:
 *      status="needs_grounding" with the missing-field gap surfaced.
 *   3. Attempt-limit exhaustion surfaces HONESTLY: a bot that always emits a broken
 *      draft ends in status="exhausted" — NO broken process is emitted (no bpmnXml).
 *   4. A converged draft lands as DRAFT for modeler review (status="draft_ready",
 *      carries bpmnXml + processKey) — never auto-published (no publish in this layer).
 *   + LLM dormant/error surfaces honestly (status="llm_error").
 *
 * ZERO NETWORK / ZERO DB / ZERO COST. The bot is a scripted in-memory LlmPort.
 */

import { describe, it, expect } from "vitest";
import {
  runProcessGenLoop,
  extractBpmnXml,
  MAX_GEN_ATTEMPTS,
  type ProcessGenRequest,
} from "../process-gen-loop.js";
import type {
  LlmPort,
  LlmRequest,
  LlmResult,
  ChatLlmRequest,
  ChatLlmResult,
} from "../llm-port.js";
import { LlmDormantError } from "../llm-port.js";
import type { GroundingContext } from "../process-gen-validator.js";

// ---------------------------------------------------------------------------
// Scripted chat port — returns a FIXED sequence of replies, one per chat() call.
// This lets us simulate generate → (broken) → repair → (fixed) deterministically.
// ---------------------------------------------------------------------------

class ScriptedChatPort implements LlmPort {
  private idx = 0;
  readonly chatCalls: ChatLlmRequest[] = [];
  constructor(
    private readonly replies: string[],
    private readonly throwMode?: "dormant" | "error",
  ) {}

  complete(_req: LlmRequest): Promise<LlmResult> {
    return Promise.reject(new Error("not used"));
  }

  async chat(req: ChatLlmRequest): Promise<ChatLlmResult> {
    this.chatCalls.push(req);
    if (this.throwMode === "dormant") throw new LlmDormantError("scripted dormant");
    if (this.throwMode === "error") throw new Error("scripted llm error");
    const text = this.replies[Math.min(this.idx, this.replies.length - 1)];
    this.idx += 1;
    return { text, toolCalls: undefined };
  }
}

// ---------------------------------------------------------------------------
// BPMN fixtures
// ---------------------------------------------------------------------------

/** A BROKEN draft: Task_dead is a dead end (reachable, no outgoing flow). */
const BROKEN_XML = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D_bad">
  <process id="P_bad" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_dead" name="Тупик"/>
    <sequenceFlow id="f1" sourceRef="Start_1" targetRef="Task_dead"/>
  </process>
</definitions>`;

/** A GOOD draft: start → task → end, fully connected; lane «Бухгалтер», field amount. */
const GOOD_XML = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn" id="D_ok">
  <process id="P_ok" isExecutable="true">
    <laneSet id="LS_1">
      <lane id="L_buh" name="Бухгалтер">
        <flowNodeRef>Task_review</flowNodeRef>
      </lane>
    </laneSet>
    <startEvent id="Start_1"/>
    <userTask id="Task_review" name="Проверить"/>
    <exclusiveGateway id="GW_1"/>
    <userTask id="Task_extra" name="Доп. согласование"/>
    <endEvent id="End_1"/>
    <endEvent id="End_2"/>
    <sequenceFlow id="f1" sourceRef="Start_1" targetRef="Task_review"/>
    <sequenceFlow id="f2" sourceRef="Task_review" targetRef="GW_1"/>
    <sequenceFlow id="f3" sourceRef="GW_1" targetRef="Task_extra">
      <conditionExpression>\${amount > 100000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f4" sourceRef="GW_1" targetRef="End_2">
      <conditionExpression>\${amount &lt;= 100000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f5" sourceRef="Task_extra" targetRef="End_1"/>
  </process>
</definitions>`;

const GROUNDING_OK: GroundingContext = {
  fieldKeys: ["amount", "title"],
  roleSlugs: ["buhgalter"],
};

function makeReq(
  llm: LlmPort,
  grounding: GroundingContext = GROUNDING_OK,
  maxAttempts?: number,
): ProcessGenRequest {
  return {
    description: "крупные заявки на доп. согласование, остальные сразу закрыть",
    llm,
    systemPrompt: "Ты собираешь BPMN-процесс из текста.",
    grounding,
    processKey: "zakupki-soglasovanie",
    processName: "Согласование закупок",
    maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// 1. The loop REPAIRS a lint-failing draft and converges.
// ---------------------------------------------------------------------------

describe("AC-1: loop repairs a broken draft and converges to draft_ready", () => {
  it("first reply is broken, second (after feedback) is good → draft_ready on attempt 2", async () => {
    const bot = new ScriptedChatPort([
      `Вот процесс:\n\`\`\`xml\n${BROKEN_XML}\n\`\`\``,
      `Исправил:\n${GOOD_XML}`,
    ]);
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("draft_ready");
    if (out.status === "draft_ready") {
      expect(out.attempts).toBe(2);
      expect(out.bpmnXml).toContain("P_ok");
    }
    // The second chat call MUST have received the lint feedback (the repair signal).
    expect(bot.chatCalls.length).toBe(2);
    const secondTurn = bot.chatCalls[1].messages.map((m) => m.content).join("\n");
    expect(secondTurn.toLowerCase()).toContain("dead end");
  });
});

// ---------------------------------------------------------------------------
// 2. An ungroundable condition (missing field) triggers cascade/ask.
// ---------------------------------------------------------------------------

describe("AC-2: ungroundable condition (missing field) → needs_grounding (cascade/ask)", () => {
  it("good topology but condition references a field that does not exist", async () => {
    const bot = new ScriptedChatPort([GOOD_XML]);
    // amount is referenced by the gateway but NOT in the grounding fieldKeys.
    const out = await runProcessGenLoop(
      makeReq(bot, { fieldKeys: ["title"], roleSlugs: ["buhgalter"] }),
    );
    expect(out.status).toBe("needs_grounding");
    if (out.status === "needs_grounding") {
      const fieldGap = out.gaps.find((g) => g.kind === "missing_field");
      expect(fieldGap).toBeDefined();
      expect(fieldGap && fieldGap.kind === "missing_field" && fieldGap.fieldKey).toBe("amount");
      // The last draft is kept so a follow-up turn can patch it after cascade.
      expect(out.lastDraftXml).toContain("P_ok");
    }
  });

  it("an ungroundable role (lane → nonexistent role) also surfaces needs_grounding", async () => {
    const bot = new ScriptedChatPort([GOOD_XML]);
    const out = await runProcessGenLoop(
      makeReq(bot, { fieldKeys: ["amount"], roleSlugs: [] }),
    );
    expect(out.status).toBe("needs_grounding");
    if (out.status === "needs_grounding") {
      expect(out.gaps.some((g) => g.kind === "missing_role")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Attempt-limit exhaustion surfaces HONESTLY — no broken process emitted.
// ---------------------------------------------------------------------------

describe("AC-3: attempt-limit exhaustion is honest — no broken process emitted", () => {
  it("a bot that always emits a broken draft → status=exhausted, NO bpmnXml", async () => {
    const bot = new ScriptedChatPort([BROKEN_XML]); // always broken
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("exhausted");
    if (out.status === "exhausted") {
      expect(out.attempts).toBe(MAX_GEN_ATTEMPTS);
      expect(out.lastViolations.length).toBeGreaterThan(0);
      // HONEST: the failure object carries NO bpmnXml field — nothing to persist.
      expect("bpmnXml" in out).toBe(false);
      expect(out.message).toContain("НЕ создан");
    }
    // It actually retried up to the cap.
    expect(bot.chatCalls.length).toBe(MAX_GEN_ATTEMPTS);
  });

  it("respects a custom (lower) attempt cap", async () => {
    const bot = new ScriptedChatPort([BROKEN_XML]);
    const out = await runProcessGenLoop(makeReq(bot, GROUNDING_OK, 2));
    expect(out.status).toBe("exhausted");
    if (out.status === "exhausted") expect(out.attempts).toBe(2);
    expect(bot.chatCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Converged draft lands as DRAFT for modeler review — never auto-published.
// ---------------------------------------------------------------------------

describe("AC-4: converged draft is a DRAFT (modeler review) — not auto-published", () => {
  it("a first-try good draft → draft_ready carrying processKey + bpmnXml on attempt 1", async () => {
    const bot = new ScriptedChatPort([GOOD_XML]);
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("draft_ready");
    if (out.status === "draft_ready") {
      expect(out.attempts).toBe(1);
      expect(out.processKey).toBe("zakupki-soglasovanie");
      expect(out.processName).toBe("Согласование закупок");
      expect(out.bpmnXml).toContain("P_ok");
      // No "published" concept here — this layer only ever yields a draft plan.
      expect(out.summary.toLowerCase()).toContain("ревью");
    }
  });
});

// ---------------------------------------------------------------------------
// LLM dormant / error honesty.
// ---------------------------------------------------------------------------

describe("LLM dormant / error surfaces honestly", () => {
  it("dormant port → llm_error with cause=dormant, no draft", async () => {
    const bot = new ScriptedChatPort([], "dormant");
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("llm_error");
    if (out.status === "llm_error") expect(out.cause).toBe("dormant");
  });

  it("error port → llm_error with cause=error, no draft", async () => {
    const bot = new ScriptedChatPort([], "error");
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("llm_error");
    if (out.status === "llm_error") expect(out.cause).toBe("error");
  });

  it("a chatty bot that never emits XML exhausts honestly (no broken process)", async () => {
    const bot = new ScriptedChatPort(["Конечно! Сейчас соберу процесс…"]);
    const out = await runProcessGenLoop(makeReq(bot));
    expect(out.status).toBe("exhausted");
    expect("bpmnXml" in out).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractBpmnXml unit coverage.
// ---------------------------------------------------------------------------

describe("extractBpmnXml", () => {
  it("pulls a bare <definitions> document", () => {
    expect(extractBpmnXml(GOOD_XML)).toContain("P_ok");
  });
  it("pulls a fenced ```xml block", () => {
    const got = extractBpmnXml("Вот:\n```xml\n" + GOOD_XML + "\n```");
    expect(got).toContain("P_ok");
  });
  it("returns null on prose with no XML", () => {
    expect(extractBpmnXml("Я подумаю над этим.")).toBeNull();
  });
});
