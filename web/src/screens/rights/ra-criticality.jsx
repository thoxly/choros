/* ============================================================================
   CHOROS — ra-criticality.jsx
   ЭКРАН 2: КРИТИЧНОСТЬ И DUAL-CONTROL (ядро модели).
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { ExecutorBadge, ExecGlyph, Mono, Button } from '../../components/components.jsx';
import { CriticalityBadge, AxisList, SectionHead, Segmented, CRIT_AXES, critLevel } from './ra-data.jsx';

/* Два сценария запроса на изменение прав */
const SCENARIOS = {
  critical: {
    id: "chg-7b21e9",
    subject: { type: "human", name: "Е. Ларина" },
    role: "Согласование ≤ ₽250 000",
    requestedBy: "А. Кравцова",
    requestedAt: "2026-06-08 14:02:41",
    fromAxes: { guarded: false, external: false, sensitive: true },
    toAxes: { guarded: true, external: true, sensitive: true },
    diff: [
      { kind: "new", label: "Вызов внешней интеграции", detail: "Платёжный шлюз · invoke", note: "новый класс доступа — раньше отсутствовал" },
      { kind: "raise", label: "Потолок суммы платежа", detail: "₽50 000 → ₽250 000", note: "числовой интервал расширен в пределах потолка роли" },
      { kind: "guard", label: "Утверждение guarded-перехода", detail: "Согласование счёта", note: "роль начинает влиять на защищённый переход" },
      { kind: "same", label: "Чтение чувствительных данных", detail: "Реестр счетов · read", note: "без изменений" },
      { kind: "same", label: "Охват", detail: "Финансы · Согласование", note: "не расширяется вверх по дереву" },
    ],
    approvers: [
      { name: "М. Соколов", role: "Оператор control-plane", type: "human", basis: "владелец узла Финансы" },
      { name: "Д. Гаврилов", role: "Финансовый контролёр", type: "human", basis: "scoped: ≥ критичность роли" },
    ],
  },
  standard: {
    id: "chg-7b2204",
    subject: { type: "human", name: "Н. Савина" },
    role: "Линия поддержки L1",
    requestedBy: "К. Орлов",
    requestedAt: "2026-06-08 13:30:10",
    fromAxes: { guarded: false, external: false, sensitive: false },
    toAxes: { guarded: false, external: false, sensitive: false },
    diff: [
      { kind: "new", label: "Чтение базы знаний", detail: "kb.search · read", note: "нечувствительный ресурс" },
      { kind: "same", label: "Очередь обращений", detail: "support.queue · read/write", note: "без изменений" },
      { kind: "same", label: "Охват", detail: "Поддержка", note: "в пределах подразделения" },
    ],
    approvers: [
      { name: "И. Петров", role: "Руководитель поддержки", type: "human", basis: "scoped: владелец узла Поддержка" },
    ],
  },
};

const DIFF_META = {
  new:   { tag: "новый доступ", cls: "new" },
  raise: { tag: "расширение", cls: "raise" },
  guard: { tag: "guarded", cls: "guard" },
  same:  { tag: "без изменений", cls: "same" },
};

function CriticalityScreen() {
  const [scenario, setScenario] = useState("critical");
  const sc = SCENARIOS[scenario];
  const fromLevel = critLevel(sc.fromAxes);
  const toLevel = critLevel(sc.toAxes);
  const raises = toLevel === "critical" && fromLevel !== "critical";
  const dual = sc.approvers.length > 1;

  // статусы аппруверов: pending | approved | rejected
  const [states, setStates] = useState(() => sc.approvers.map(() => "pending"));
  useEffect(() => { setStates(sc.approvers.map(() => "pending")); }, [scenario]);

  const setAt = (i, v) => setStates((s) => s.map((x, j) => (j === i ? v : x)));
  const approved = states.filter((s) => s === "approved").length;
  const rejected = states.some((s) => s === "rejected");
  const overall = rejected ? "rejected" : approved === sc.approvers.length ? "confirmed" : approved > 0 ? "partial" : "pending";
  const OVERALL_META = {
    pending:  { label: "Ожидает подтверждения", cls: "pending" },
    partial:  { label: `Частично подтверждено · ${approved} из ${sc.approvers.length}`, cls: "partial" },
    confirmed:{ label: "Подтверждено — изменение применится", cls: "confirmed" },
    rejected: { label: "Отклонено", cls: "rejected" },
  };

  return (
    <div className="chs-crit-screen">
      <div className="chs-crit-screen__inner">

        {/* Переключатель сценария */}
        <div className="chs-modebar chs-modebar--top">
          <Segmented
            value={scenario} onChange={setScenario}
            options={[
              { value: "critical", label: "Критичное изменение", hint: "dual-control" },
              { value: "standard", label: "Некритичное", hint: "1 аппрувер" },
            ]}
          />
          <span className="chs-modebar__hint">Сценарий определяется эффективной критичностью назначения, а не вручную.</span>
        </div>

        {/* Заголовок запроса */}
        <div className={`chs-chg ${raises ? "chs-chg--critical" : ""}`}>
          <div className="chs-chg__top">
            <div className="chs-chg__titlewrap">
              <div className="chs-chg__kicker">Запрос на изменение прав <Mono>{sc.id}</Mono></div>
              <h2 className="chs-chg__title">
                {sc.role}
                <span className="chs-chg__arrow">→</span>
                <ExecutorBadge type={sc.subject.type} name={sc.subject.name} />
              </h2>
              <div className="chs-chg__meta">
                запросил <b>{sc.requestedBy}</b> · <Mono>{sc.requestedAt}</Mono>
              </div>
            </div>
            <div className="chs-chg__critwrap">
              <span className="chs-chg__critk">критичность</span>
              <div className="chs-chg__critrow">
                <CriticalityBadge axes={sc.fromAxes} />
                <span className="chs-chg__critarrow">→</span>
                <CriticalityBadge axes={sc.toAxes} />
              </div>
            </div>
          </div>

          {raises && (
            <div className="chs-dualbanner">
              <span className="chs-dualbanner__glyph" />
              <div className="chs-dualbanner__txt">
                <b>Требуется два аппрувера.</b> Назначение поднимает критичность роли до «критичной» —
                добавляется вызов внешней интеграции и влияние на guarded-переход.{" "}
                <span className="chs-dualbanner__hint">Второй подтверждающий обязан иметь admin-полномочия — проверяется бэкендом.</span>
              </div>
              <span className="chs-dualbanner__tag">DUAL-CONTROL</span>
            </div>
          )}
        </div>

        <div className="chs-crit-grid">
          {/* Оси критичности */}
          <section className="chs-section2 chs-section2--first">
            <SectionHead title="Оси критичности" aux="эффективно после изменения · role_criticality" />
            <AxisList axes={sc.toAxes} />
          </section>

          {/* Эффективный дифф */}
          <section className="chs-section2 chs-section2--first">
            <SectionHead title="Эффективный дифф" aux="что реально расширяется — не построчный" />
            <div className="chs-effdiff">
              {sc.diff.map((d, i) => {
                const m = DIFF_META[d.kind];
                return (
                  <div key={i} className={`chs-effdiff__row chs-effdiff__row--${m.cls}`}>
                    <span className={`chs-effdiff__mark chs-effdiff__mark--${m.cls}`} />
                    <div className="chs-effdiff__body">
                      <span className="chs-effdiff__label">{d.label}</span>
                      <span className="chs-effdiff__detail">{d.detail}</span>
                      <span className="chs-effdiff__note">{d.note}</span>
                    </div>
                    <span className={`chs-effdiff__tag chs-effdiff__tag--${m.cls}`}>{m.tag}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* Dual-control: аппруверы + статусы */}
        <section className="chs-section2">
          <SectionHead
            title={dual ? "Подтверждение — два аппрувера" : "Подтверждение — scoped-аппрувер"}
            aux={dual ? "оба обязательны" : "одного достаточно для некритичного"}
            right={<span className={`chs-overall chs-overall--${OVERALL_META[overall].cls}`}><span className="chs-overall__dot" />{OVERALL_META[overall].label}</span>}
          />
          <div className="chs-approvers">
            {sc.approvers.map((a, i) => (
              <div key={i} className={`chs-approver chs-approver--${states[i]}`}>
                <div className="chs-approver__who">
                  <span className="chs-approver__glyph"><ExecGlyph type={a.type} size={9} /></span>
                  <div className="chs-approver__txt">
                    <span className="chs-approver__name">{a.name}</span>
                    <span className="chs-approver__role">{a.role}</span>
                  </div>
                </div>
                <div className="chs-approver__basis">{a.basis}</div>
                <div className="chs-approver__act">
                  {states[i] === "pending" && <>
                    <button type="button" className="chs-approver__reject" onClick={() => setAt(i, "rejected")}>Отклонить</button>
                    <button type="button" className="chs-approver__approve" onClick={() => setAt(i, "approved")}>Подтвердить</button>
                  </>}
                  {states[i] === "approved" && <span className="chs-approver__state chs-approver__state--ok">✓ подтвердил</span>}
                  {states[i] === "rejected" && <span className="chs-approver__state chs-approver__state--no">✕ отклонил</span>}
                </div>
              </div>
            ))}
          </div>
          <p className="chs-section2__note">
            При dual-control <b>оба</b> аппрувера подтверждают независимо; любой отказ останавливает применение.
            Каждое решение пишется в <b>журнал выдачи прав</b> с моно-ID и таймстампом.
          </p>
        </section>

      </div>
    </div>
  );
}

export default CriticalityScreen;
