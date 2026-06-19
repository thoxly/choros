/* ============================================================================
   CHOROS — ra-sod.jsx
   ЭКРАН 3: SoD И КОНФЛИКТЫ (разделение обязанностей).
   ============================================================================ */

import React, { useState } from 'react';
import { ExecutorBadge, Mono, Button, KitIcon } from '../../components/components.jsx';
import { SOD_RULES, SectionHead } from './ra-data.jsx';

/* субъект и его текущие роли */
const SOD_SUBJECT = { type: "human", name: "Е. Ларина", held: ["Контролёр расчётов", "Сверка платежей"] };

/* роли-кандидаты на назначение */
const SOD_CANDIDATES = [
  "Согласование ≤ ₽250 000",
  "Инициировать платёж",
  "Линия поддержки L1",
  "Приёмник эскалаций агентов",
];

/* найти конфликт между кандидатом и уже выданными ролями */
function findConflicts(candidate, held) {
  return SOD_RULES.filter(
    (r) => (r.a === candidate && held.includes(r.b)) || (r.b === candidate && held.includes(r.a))
  ).map((r) => ({ rule: r, with: r.a === candidate ? r.b : r.a }));
}

function SoDScreen() {
  const [candidate, setCandidate] = useState("Согласование ≤ ₽250 000");
  const conflicts = findConflicts(candidate, SOD_SUBJECT.held);
  const blocked = conflicts.some((c) => c.rule.severity === "block");
  const warned = conflicts.length > 0 && !blocked;

  return (
    <div className="chs-sod-screen">
      <div className="chs-sod-screen__inner">

        {/* Живое назначение */}
        <section className="chs-section2 chs-section2--first">
          <SectionHead title="Назначение роли" aux="проверка SoD выполняется до записи" />
          <div className="chs-assignbox">
            <div className="chs-assignbox__subject">
              <span className="chs-assignbox__k">Кому</span>
              <ExecutorBadge type={SOD_SUBJECT.type} name={SOD_SUBJECT.name} />
              <span className="chs-assignbox__held">
                уже назначено:
                {SOD_SUBJECT.held.map((h) => <span key={h} className="chs-heldrole">{h}</span>)}
              </span>
            </div>
            <div className="chs-assignbox__pick">
              <span className="chs-assignbox__k">Добавить роль</span>
              <div className="chs-assignbox__candidates">
                {SOD_CANDIDATES.map((c) => {
                  const cf = findConflicts(c, SOD_SUBJECT.held);
                  const sev = cf.some((x) => x.rule.severity === "block") ? "block" : cf.length ? "warn" : "ok";
                  return (
                    <button key={c} type="button" className={`chs-candidate ${candidate === c ? "chs-candidate--sel" : ""} chs-candidate--${sev}`} onClick={() => setCandidate(c)}>
                      <span className={`chs-candidate__dot chs-candidate__dot--${sev}`} />
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Результат проверки */}
          {blocked && (
            <div className="chs-conflict chs-conflict--block">
              <div className="chs-conflict__head">
                <span className="chs-conflict__glyph" />
                <span className="chs-conflict__title">Конфликт разделения обязанностей — назначение заблокировано</span>
                <span className="chs-conflict__sev chs-conflict__sev--block">BLOCK</span>
              </div>
              {conflicts.filter((c) => c.rule.severity === "block").map((c) => (
                <div key={c.rule.id} className="chs-conflict__body">
                  <div className="chs-conflict__pair">
                    <span className="chs-conflict__role">{candidate}</span>
                    <span className="chs-conflict__x"><KitIcon name="close" /></span>
                    <span className="chs-conflict__role">{c.with}</span>
                  </div>
                  <div className="chs-conflict__why">{c.rule.rationale} «{c.with}» уже назначена этому исполнителю.</div>
                  <button type="button" className="chs-conflict__rule">правило {c.rule.id} · {c.rule.title} →</button>
                </div>
              ))}
              <div className="chs-conflict__act">
                <Button variant="ghost" size="sm">Отмена</Button>
                <Button variant="danger" size="sm">Запросить исключение</Button>
              </div>
            </div>
          )}

          {warned && (
            <div className="chs-conflict chs-conflict--warn">
              <div className="chs-conflict__head">
                <span className="chs-conflict__glyph" />
                <span className="chs-conflict__title">Потенциальный конфликт — требуется обоснование</span>
                <span className="chs-conflict__sev chs-conflict__sev--warn">WARN</span>
              </div>
              {conflicts.map((c) => (
                <div key={c.rule.id} className="chs-conflict__body">
                  <div className="chs-conflict__pair">
                    <span className="chs-conflict__role">{candidate}</span>
                    <span className="chs-conflict__x"><KitIcon name="close" /></span>
                    <span className="chs-conflict__role">{c.with}</span>
                  </div>
                  <div className="chs-conflict__why">{c.rule.rationale}</div>
                  <button type="button" className="chs-conflict__rule">правило {c.rule.id} · {c.rule.title} →</button>
                </div>
              ))}
              <div className="chs-conflict__act">
                <Button variant="ghost" size="sm">Отмена</Button>
                <Button variant="secondary" size="sm">Назначить с обоснованием</Button>
              </div>
            </div>
          )}

          {conflicts.length === 0 && (
            <div className="chs-conflict chs-conflict--ok">
              <span className="chs-conflict__okglyph" />
              <span>Конфликтов SoD нет. Роль «{candidate}» совместима с текущими назначениями — можно назначать.</span>
              <Button variant="primary" size="sm">Назначить</Button>
            </div>
          )}
        </section>

        {/* Реестр правил SoD */}
        <section className="chs-section2">
          <SectionHead title="Реестр правил SoD" aux={`${SOD_RULES.length} правил · несовместимые пары ролей`} />
          <div className="chs-sodtable">
            <div className="chs-sodtable__colhead">
              <span>Правило</span><span>Несовместимая пара</span><span>Обоснование</span><span>Класс</span>
            </div>
            {SOD_RULES.map((r) => {
              const live = (r.a === candidate && SOD_SUBJECT.held.includes(r.b)) || (r.b === candidate && SOD_SUBJECT.held.includes(r.a));
              return (
                <div key={r.id} className={`chs-sodrow ${live ? "chs-sodrow--live" : ""}`}>
                  <div className="chs-sodrow__id"><Mono>{r.id}</Mono>{live && <span className="chs-sodrow__livetag">сработало</span>}</div>
                  <div className="chs-sodrow__pair">
                    <span>{r.a}</span><span className="chs-sodrow__vs">≠</span><span>{r.b}</span>
                  </div>
                  <div className="chs-sodrow__why">{r.rationale}</div>
                  <div className="chs-sodrow__sev"><span className={`chs-sodsev chs-sodsev--${r.severity}`}>{r.severity === "block" ? "блок" : "предупр."}</span></div>
                </div>
              );
            })}
          </div>
          <p className="chs-section2__note">
            Базовая ось SoD — <b>кто запрашивает ≠ кто утверждает</b>. Правила проверяются на каждом назначении роли
            и при пересмотре грантов; срабатывание попадает в единый аудит.
          </p>
        </section>

      </div>
    </div>
  );
}

export default SoDScreen;
