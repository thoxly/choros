/* ============================================================================
   CHOROS — escalation-branch-builder.js
   T-0660 [столпы 1/2, модельер]: собрать «напоминание по таймеру с эскалацией»
   мышью, без правки сырого BPMN XML.

   Закрывает два физических пробела конструктора процессов (D-064, класс P0
   «продукт этого не даёт»):

     1. cancelActivity — «прерывающий / непрерывающий» boundary-таймер. Панель
        таймера не давала задать этот РОДНОЙ атрибут BPMN; непрерывающий таймер
        (cancelActivity="false" — «напоминание, не отмена», ADR-T0612 §D1) можно
        было получить лишь правкой XML. bpmn-js по умолчанию ставит true, поэтому
        непрерывающий таймер мышью был недостижим.

     2. Сама ветка эскалации СО СХОЖДЕНИЕМ. Валидный паттерн (ADR-T0612 §D2)
        требует: нормальное завершение шага И ветка эскалации сходятся в общий
        exclusiveGateway перед общим концом. Без схождения непрерывающий таймер
        даёт зомби-инстанс (T-0612). Собрать это схождение мышью вручную — почти
        гарантированно неверно (в отдельный конец). Аффорданс собирает КОРРЕКТНОЕ
        схождение одним кликом.

   Чистые части (cancelActivity read/write, гард предусловий) отделены от
   исполнителя на bpmn-js modeling API, поэтому логика юнит-тестируема без DOM.
   DI (координаты) генерируется bpmn-js автоматически при appendShape/connect.

   cancelActivity — родной атрибут BPMN 2.0; Flowable читает его напрямую, поэтому
   серверная трансляция не нужна (граница с T-0641: сервер не тронут).
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

/**
 * Build the converging escalation branch on the LIVE canvas via bpmn-js modeling.
 * Idempotent-guarded by canBuildEscalationBranch. DI (coordinates/waypoints) is
 * generated by bpmn-js automatically for every appendShape/connect.
 *
 * Topology produced:
 *   host  → gateway → next        (the host's single normal path, rerouted
 *                                   THROUGH a new converging exclusiveGateway)
 *   timer → escTask → gateway     (the escalation branch, converging into the
 *                                   same gateway)
 * plus the boundary timer set to non-interrupting (cancelActivity=false).
 *
 * This is exactly the shape the publish linter's checkTimerEscalationConvergence
 * (T-0641/T-0612) requires for a non-interrupting boundary timer — so the
 * mouse-built process passes the publish gate (no timer_escalation_no_convergence).
 *
 * @param {{ modeler: object, boundaryElement: object,
 *           escalationName?: string, gatewayName?: string }} args
 * @returns {{ applied: boolean, reason?: string, escalationTaskId?: string,
 *             gatewayId?: string }}
 */
export function applyEscalationBranch({ modeler, boundaryElement, escalationName, gatewayName }) {
  const guard = canBuildEscalationBranch(boundaryElement);
  if (!guard.ok) return { applied: false, reason: guard.reason };
  if (!modeler || typeof modeler.get !== 'function') {
    return { applied: false, reason: 'Модельер недоступен.' };
  }

  const modeling = modeler.get('modeling');
  const host = boundaryElement.host;
  const hostFlow = normalOutgoing(host)[0];
  const nextEl = hostFlow.target;

  // 1. Timer becomes a non-interrupting reminder (does not cancel the step).
  modeling.updateProperties(boundaryElement, { cancelActivity: false });

  // 2. Escalation step, appended from the boundary timer (creates timer→escTask + DI).
  const escTask = modeling.appendShape(
    boundaryElement,
    { type: 'bpmn:UserTask' },
    pointFrom(boundaryElement, 90, 120),
    boundaryElement.parent,
  );
  modeling.updateProperties(escTask, { name: escalationName || 'Эскалация' });

  // 3. Converging gateway, appended from the host step (creates host→gateway + DI).
  const gateway = modeling.appendShape(
    host,
    { type: 'bpmn:ExclusiveGateway' },
    pointFrom(host, host.width ? host.width / 2 + 90 : 140, 0),
    host.parent,
  );
  modeling.updateProperties(gateway, { name: gatewayName || 'Продолжить' });

  // 4. Reroute the host's normal path THROUGH the gateway:
  //    remove the old host→next flow, add gateway→next (gateway sits between them).
  modeling.removeConnection(hostFlow);
  modeling.connect(gateway, nextEl, { type: 'bpmn:SequenceFlow' });

  // 5. Escalation step converges into the same gateway.
  modeling.connect(escTask, gateway, { type: 'bpmn:SequenceFlow' });

  return {
    applied: true,
    escalationTaskId: escTask && escTask.id,
    gatewayId: gateway && gateway.id,
  };
}
