/* ============================================================================
   CHOROS — escalation-branch-builder.js
   T-0660 [столпы 1/2, модельер]: собрать «напоминание по таймеру с эскалацией»
   мышью, без правки сырого BPMN XML.
   T-0776 [столпы 1/3, модельер]: корректирует форму D2 (T-0660) на форму D5
   (ADR-T0612 §8, T-0661) — см. ниже «D5 addendum».

   Закрывает два физических пробела конструктора процессов (D-064, класс P0
   «продукт этого не даёт»):

     1. cancelActivity — «прерывающий / непрерывающий» boundary-таймер. Панель
        таймера не давала задать этот РОДНОЙ атрибут BPMN; непрерывающий таймер
        (cancelActivity="false" — «напоминание, не отмена», ADR-T0612 §D1) можно
        было получить лишь правкой XML. bpmn-js по умолчанию ставит true, поэтому
        непрерывающий таймер мышью был недостижим.

     2. Сама ветка эскалации СО СХОЖДЕНИЕМ И РАЗРЕШЕНИЕМ КОНКУРЕНЦИИ. Валидный
        паттерн (ADR-T0612 §8, D5) требует не только схождения нормального
        завершения шага и ветки эскалации в общий exclusiveGateway, но и то,
        чтобы это схождение вело в SCOPE-LOCAL terminateEndEvent внутри
        embedded subProcess — иначе сработавший непрерывающий таймер порождает
        ВТОРОЙ параллельный токен, который простой сходящийся gateway + обычный
        endEvent не может погасить (T-0661: сходящийся exclusiveGateway —
        неконтролируемое слияние, каждый токен проходит независимо → зависание
        инстанса, если оба токена не разрешены). Собрать эту форму мышью вручную
        — почти гарантированно неверно. Аффорданс собирает КОРРЕКТНУЮ (D5) форму
        одним кликом.

   Чистые части (cancelActivity read/write, гард предусловий) отделены от
   исполнителя на bpmn-js modeling API, поэтому логика юнит-тестируема без DOM.
   DI (координаты) генерируется bpmn-js автоматически при appendShape/connect/
   createShape.

   cancelActivity — родной атрибут BPMN 2.0; Flowable читает его напрямую, поэтому
   серверная трансляция не нужна (граница с T-0641: сервер не тронут).

   ----------------------------------------------------------------------------
   D5 addendum (T-0776, ADR-T0612 §8): why the shape changed from D2 to D5
   ----------------------------------------------------------------------------
   D2 (T-0660, this file's original build) produced:
     host  → gateway → next        (host's single path, rerouted THROUGH gateway)
     timer → escTask → gateway     (escalation branch converging into gateway)
   T-0661 PROVED (live Flowable) this shape HANGS once the timer fires: a
   converging exclusiveGateway is an UNCONTROLLED MERGE — it passes EACH
   incoming token through independently, it does not "discard the later
   token". Once the timer fires, both `host` and `escTask` are open
   concurrently; whichever completes first sends ITS token through the
   gateway to `next` — but the OTHER task's token stays parked forever, and
   BPMN only completes a (sub)process when EVERY token is consumed. A new
   linter rule (`timer_escalation_unresolved_concurrency`,
   src/core/bpmn-linter.ts) now BLOCKS publishing this exact D2 shape.

   D5 fixes this by enclosing the race in an embedded subProcess whose
   convergence flows to a SCOPE-LOCAL terminateEndEvent (terminateAll left at
   its BPMN default, false): the FIRST racer to arrive there ends the
   sub-process scope, cancelling the OTHER, still-parked racer's token — the
   sub-process then completes normally and its single outgoing flow carries
   the resolved race onward exactly where `host` used to flow. Produced
   topology (mirrors docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt):

     subProcess (encloses):
       subStart → host  ─┐
       timer → escTask ──┼→ gateway → terminateEnd (scope-local)
     prior → subProcess → next   (top level; replaces the old prior → host → next flow)

   ----------------------------------------------------------------------------
   Reparent-connectivity fix (T-0776, adversarial review — empirically proven)
   ----------------------------------------------------------------------------
   Moving `host` into the new subProcess (step 4 of preExecute) only ever had
   its OUTGOING flow handled (`host → next`, retired in step 2 and replaced by
   `subProcess → next` in step 9/10). The host's INCOMING flow (`prior → host`,
   typically the process Start) was never touched by this builder — and
   bpmn-js SILENTLY DELETES that connection during moveElements because it
   would cross the new subProcess's boundary. Left unfixed: `prior.outgoing`
   becomes [], `subProcess.incoming` stays [] — the subProcess (and the whole
   built escalation branch) is NEVER ENTERED; a one-click build produced a
   structurally broken, unreachable process. Fixed by capturing the host's
   incoming flows + sources before the move, removing them explicitly, and
   reconnecting each prior source to the subProcess once it exists (preExecute
   steps 0, 2b, 4b) — all inside the SAME composite command, so the fix stays
   part of the single U-1 undo entry.
   ============================================================================ */

/* --------------------------------------------------------------------------
   «Прерывающий / непрерывающий» — человеческие подписи. Значение хранится в
   родном BPMN-атрибуте cancelActivity (true = прерывающий, дефолт BPMN).
   -------------------------------------------------------------------------- */
export const INTERRUPT_MODES = [
  {
    value: 'interrupting',
    label: 'Останавливает текущий шаг',
    hint: 'Когда сработает таймер — текущий шаг закрывается и работа уходит на эскалацию.',
  },
  {
    value: 'non-interrupting',
    label: 'Работает параллельно (напоминание)',
    hint: 'Текущий шаг продолжается; эскалация уходит как напоминание, не отменяя шаг.',
  },
];

/** True iff the businessObject is a boundary event (a timer ATTACHED to a step). */
export function isBoundaryEventBo(bo) {
  return !!bo && bo.$type === 'bpmn:BoundaryEvent';
}

/**
 * Read the interrupt mode off a boundary event businessObject.
 * BPMN default when cancelActivity is absent/true is INTERRUPTING; only an
 * explicit `false` is non-interrupting.
 * @returns {'interrupting'|'non-interrupting'}
 */
export function readInterruptMode(bo) {
  if (!bo) return 'interrupting';
  return bo.cancelActivity === false ? 'non-interrupting' : 'interrupting';
}

/**
 * Write the interrupt mode onto the boundary event. Prefers bpmn-js
 * modeling.updateProperties (undo/redo + re-render of the solid/dashed border);
 * falls back to a direct businessObject write when no modeler is available
 * (pure tests / bot driver).
 *
 * @param {{ bo?: object, modeler?: object, element?: object }} ctx
 * @param {'interrupting'|'non-interrupting'} mode
 */
export function writeInterruptMode(ctx, mode) {
  const { bo, modeler, element } = ctx || {};
  // interrupting → cancelActivity=true (BPMN default); non-interrupting → false.
  const cancelActivity = mode !== 'non-interrupting';
  if (modeler && element) {
    try {
      const modeling = modeler.get('modeling');
      modeling.updateProperties(element, { cancelActivity });
      return;
    } catch (_) {
      /* fall through to a direct write */
    }
  }
  if (bo) bo.cancelActivity = cancelActivity;
}

/* --------------------------------------------------------------------------
   Escalation-branch build affordance.
   -------------------------------------------------------------------------- */

/** True iff a diagram connection is a bpmn:SequenceFlow (normal control flow). */
function isSequenceFlowConnection(conn) {
  if (!conn) return false;
  const t = conn.type || (conn.businessObject && conn.businessObject.$type);
  return t === 'bpmn:SequenceFlow';
}

/** The bpmn:SequenceFlow connections leaving an element (normal outgoing paths). */
export function normalOutgoing(element) {
  return ((element && element.outgoing) || []).filter(isSequenceFlowConnection);
}

/**
 * Precondition check for the «собрать ветку эскалации» affordance. Pure — reads
 * the diagram shape graph only. Returns { ok, reason } so the panel can disable
 * the button with a human explanation.
 *
 * Requires:
 *   - the selected event is a boundary event ATTACHED to a step (has .host);
 *   - the branch is not already built (the boundary has no outgoing flow yet);
 *   - the host step has EXACTLY ONE normal outgoing flow, so rerouting it
 *     through the converging gateway is unambiguous and safe.
 *
 * @param {object} boundaryElement - the selected bpmn-js shape
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canBuildEscalationBranch(boundaryElement) {
  const bo = boundaryElement && boundaryElement.businessObject;
  if (!isBoundaryEventBo(bo)) {
    return { ok: false, reason: 'Закрепите таймер на шаге, чтобы собрать напоминание.' };
  }
  const host = boundaryElement.host;
  if (!host || !host.businessObject) {
    return { ok: false, reason: 'Таймер не закреплён на шаге.' };
  }
  if (normalOutgoing(boundaryElement).length > 0) {
    return { ok: false, reason: 'Ветка эскалации уже собрана.' };
  }
  const hostOut = normalOutgoing(host);
  if (hostOut.length !== 1) {
    return {
      ok: false,
      reason: 'Сначала соедините шаг ровно с одним следующим элементом.',
    };
  }
  return { ok: true };
}

/** Safe absolute position helper (guards missing geometry in tests). */
function pointFrom(el, dx, dy) {
  const x = (el && typeof el.x === 'number' ? el.x : 0) + (el && el.width ? el.width / 2 : 0);
  const y = (el && typeof el.y === 'number' ? el.y : 0) + (el && el.height ? el.height / 2 : 0);
  return { x: x + dx, y: y + dy };
}

/* --------------------------------------------------------------------------
   T-0660 U-1: ONE click = ONE undo entry.

   The build is a COMPOSITE COMMAND — the canonical bpmn-js/diagram-js way to
   group multi-step modeling into a single undo/redo unit (the exact pattern of
   diagram-js' own AppendShapeHandler: nested modeling calls fired from a
   handler's preExecute/postExecute phase). CommandStack._pushAction assigns
   every NESTED action the BASE action's id, and undo()/redo() loop
   `while (next.id === action.id)` — so the nested operations below (D5: timer
   flip, subProcess create, host+timer reparent, sub-start wiring, escalation
   task, gateway, scope-local terminate, top-level reconnect) are undone by a
   SINGLE commandStack.undo(). Nested execution is only legal in
   preExecute/postExecute (the atomic guard throws inside execute/revert),
   hence all work lives in preExecute; execute/revert are intentionally absent
   (both optional per CommandStack._internalExecute/_internalUndo).
   -------------------------------------------------------------------------- */

/** Command name for the composite escalation-branch build (one undo entry). */
export const BUILD_ESCALATION_BRANCH_CMD = 'choros.escalationBranch.build';

/**
 * Composite command handler. Instantiated by the diagram-js injector
 * (commandStack.registerHandler), receives the real modeling service via $inject.
 *
 * Context in:  { boundaryElement, escalationName?, gatewayName?, subProcessName?,
 *                terminateName? }
 * Context out: { escalationTask, gateway, subProcess, terminateEnd, subStart }
 *              (the created shapes)
 */
export function BuildEscalationBranchHandler(modeling) {
  this._modeling = modeling;
}
BuildEscalationBranchHandler.$inject = ['modeling'];

BuildEscalationBranchHandler.prototype.preExecute = function preExecute(context) {
  const modeling = this._modeling;
  const boundaryElement = context.boundaryElement;
  const host = boundaryElement.host;
  const parent = host.parent;
  const hostFlow = normalOutgoing(host)[0];
  const nextEl = hostFlow.target;

  // 0. THE FIX (T-0776, adversarial review — empirically proven): capture the
  //    host's INCOMING sequence flow(s) and their sources BEFORE anything
  //    moves. bpmn-js SILENTLY DELETES a connection that would cross the new
  //    subProcess's boundary once moveElements (step 4) reparents the host —
  //    unlike the OUTGOING side (handled below, step 2/9), nothing previously
  //    reconnected the incoming side, so the process's prior step (often the
  //    Start event) was orphaned and the subProcess was NEVER ENTERED
  //    (subProcess.incoming stayed [] — a structurally broken, unreachable
  //    process). A host that IS itself the process start (no incoming) is a
  //    valid, if unusual, case — hostIncoming is simply empty and nothing is
  //    reconnected.
  const hostIncoming = (host.incoming || []).filter(isSequenceFlowConnection);
  const incomingSources = hostIncoming.map((c) => c.source);

  // 1. Timer becomes a non-interrupting reminder (does not cancel the step).
  modeling.updateProperties(boundaryElement, { cancelActivity: false });

  // 2. The host's old top-level OUTGOING flow is retired here: once the race
  //    resolves, the ENCLOSING subProcess (step 3) carries the flow onward,
  //    not the bare host (D5 — the host moves INSIDE the subProcess in step 4).
  modeling.removeConnection(hostFlow);

  // 2b. The host's old top-level INCOMING flow(s) are retired too, explicitly
  //     (rather than left for bpmn-js to silently drop during the move) — they
  //     are reconnected to the subProcess once it exists (step 4b below).
  hostIncoming.forEach((c) => modeling.removeConnection(c));

  // 3. Embedded subProcess (D5, ADR-T0612 §8 / T-0661): encloses the fin-approval
  //    RACE (host + escalation task) so a SCOPE-LOCAL terminate end event can
  //    cancel the losing racer's token without ending anything outside this
  //    slice. Created at the host's original top-level slot.
  const subProcess = modeling.createShape(
    { type: 'bpmn:SubProcess', isExpanded: true },
    pointFrom(host, 0, 0),
    parent,
  );
  modeling.updateProperties(subProcess, {
    name: context.subProcessName || 'Шаг с напоминанием (гонка + эскалация)',
  });

  // 4. Move the host step — WITH its attached boundary timer — INTO the
  //    subProcess. The host keeps its id/config; only its containment changes.
  modeling.moveElements([host, boundaryElement], { x: 0, y: 0 }, subProcess);

  // 4b. THE FIX (T-0776): reconnect the host's prior incoming source(s) — e.g.
  //     the process Start event — to the subProcess now enclosing the host.
  //     Without this, whatever used to flow into the host has nowhere to go:
  //     the subProcess is never entered and the whole built branch is dead.
  incomingSources.forEach((src) => {
    modeling.connect(src, subProcess, { type: 'bpmn:SequenceFlow' });
  });

  // 5. Embedded sub-processes require exactly one none-start event; wire it
  //    to the (now-nested) host so the race actually begins on entry.
  const subStart = modeling.createShape(
    { type: 'bpmn:StartEvent' },
    pointFrom(host, -140, 0),
    subProcess,
  );
  modeling.connect(subStart, host, { type: 'bpmn:SequenceFlow' });

  // 6. Escalation step, appended from the boundary timer (creates timer→escTask
  //    + DI, INSIDE the subProcess since the timer now lives there).
  const escTask = modeling.appendShape(
    boundaryElement,
    { type: 'bpmn:UserTask' },
    pointFrom(boundaryElement, 90, 120),
    subProcess,
  );
  modeling.updateProperties(escTask, { name: context.escalationName || 'Эскалация' });

  // 7. Converging gateway, appended from the host step (creates host→gateway +
  //    DI, INSIDE the subProcess). Both racers still converge here (T-0612 D2
  //    is preserved) — the fix is what the gateway now flows TO (step 9).
  const gateway = modeling.appendShape(
    host,
    { type: 'bpmn:ExclusiveGateway' },
    pointFrom(host, host.width ? host.width / 2 + 90 : 140, 0),
    subProcess,
  );
  modeling.updateProperties(gateway, { name: context.gatewayName || 'Продолжить' });

  // 8. Escalation step converges into the same gateway.
  modeling.connect(escTask, gateway, { type: 'bpmn:SequenceFlow' });

  // 9. THE FIX (T-0661/D5): the gateway flows to a SCOPE-LOCAL terminate end
  //    event (terminateAll left at its BPMN default, false) instead of a plain
  //    end — the FIRST racer to arrive here ends the sub-process scope,
  //    cancelling the other, still-parked racer's token. Appended from the
  //    gateway (creates gateway→terminateEnd + DI).
  const terminateEnd = modeling.appendShape(
    gateway,
    { type: 'bpmn:EndEvent', eventDefinitionType: 'bpmn:TerminateEventDefinition' },
    pointFrom(gateway, 120, 0),
    subProcess,
  );
  modeling.updateProperties(terminateEnd, {
    name: context.terminateName || 'Решение принято',
  });

  // 10. The subProcess (not the bare host) now carries the resolved race
  //     onward to wherever the host used to flow — the ONLY top-level change.
  modeling.connect(subProcess, nextEl, { type: 'bpmn:SequenceFlow' });

  context.escalationTask = escTask;
  context.gateway = gateway;
  context.subProcess = subProcess;
  context.terminateEnd = terminateEnd;
  context.subStart = subStart;
};

/** Command stacks the composite handler is already registered on. */
const registeredStacks = new WeakSet();

/** Register the composite handler on this modeler's commandStack (once per stack). */
function ensureBuildHandlerRegistered(commandStack) {
  if (registeredStacks.has(commandStack)) return;
  commandStack.registerHandler(BUILD_ESCALATION_BRANCH_CMD, BuildEscalationBranchHandler);
  registeredStacks.add(commandStack);
}

/**
 * Build the D5 escalation branch (ADR-T0612 §8, T-0661) on the LIVE canvas via
 * bpmn-js modeling. Idempotent-guarded by canBuildEscalationBranch. DI
 * (coordinates/waypoints) is generated by bpmn-js automatically for every
 * createShape/appendShape/connect.
 *
 * ATOMIC (U-1): all operations run as ONE composite command
 * (BUILD_ESCALATION_BRANCH_CMD) — a single commandStack.undo() removes the whole
 * built branch (subProcess and everything moved/created inside it) and restores
 * the original topology.
 *
 * Topology produced (mirrors
 * docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt):
 *   subProcess (encloses the race):
 *     subStart → host  ─┐
 *     timer → escTask ──┼→ gateway → terminateEnd (scope-local terminate)
 *   subProcess → next   (top level; replaces the old host → next flow)
 * plus the boundary timer set to non-interrupting (cancelActivity=false).
 *
 * This is exactly the shape the publish linter's checkTimerEscalationConvergence
 * (T-0612/T-0641/T-0661, src/core/bpmn-linter.ts) requires for a non-interrupting
 * boundary timer — it satisfies BOTH the convergence rule
 * (`timer_escalation_no_convergence`: host and escTask both reach the gateway)
 * AND the concurrency-resolution rule
 * (`timer_escalation_unresolved_concurrency`: a terminateEndEvent is reachable
 * from the escalation branch) — so the mouse-built process passes the publish
 * gate AND is not the D2 shape T-0661 proved hangs once the timer fires.
 *
 * @param {{ modeler: object, boundaryElement: object,
 *           escalationName?: string, gatewayName?: string,
 *           subProcessName?: string, terminateName?: string }} args
 * @returns {{ applied: boolean, reason?: string, escalationTaskId?: string,
 *             gatewayId?: string, subProcessId?: string,
 *             terminateEndId?: string }}
 */
export function applyEscalationBranch({
  modeler,
  boundaryElement,
  escalationName,
  gatewayName,
  subProcessName,
  terminateName,
}) {
  const guard = canBuildEscalationBranch(boundaryElement);
  if (!guard.ok) return { applied: false, reason: guard.reason };
  if (!modeler || typeof modeler.get !== 'function') {
    return { applied: false, reason: 'Модельер недоступен.' };
  }

  const commandStack = modeler.get('commandStack');
  ensureBuildHandlerRegistered(commandStack);

  const context = {
    boundaryElement,
    escalationName,
    gatewayName,
    subProcessName,
    terminateName,
  };
  commandStack.execute(BUILD_ESCALATION_BRANCH_CMD, context);

  return {
    applied: true,
    escalationTaskId: context.escalationTask && context.escalationTask.id,
    gatewayId: context.gateway && context.gateway.id,
    subProcessId: context.subProcess && context.subProcess.id,
    terminateEndId: context.terminateEnd && context.terminateEnd.id,
  };
}
