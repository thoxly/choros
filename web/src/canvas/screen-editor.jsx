/* ============================================================================
   CHOROS — screen-editor.jsx
   Экран «Редактор процесса»: ТЕМА поверх встраиваемого bpmn-js.
   Воспроизводит штатный DOM bpmn.io (.djs-*, .bpmn-icon-*, .bio-properties-panel-*)
   и красит его исключительно через bpmn-theme.css → токены --chs-*.
   Здесь НЕ изобретается канвас — это макет того, что выдаёт перекрашенный bpmn-js.

   Диаграмма: Старт → User Task (человек) → Agent Task (ИИ-агент) →
              External Task (сервис) → Gateway → Конец.
   Тип шага = тип исполнителя; маркер-класс chs-exec-* несёт цвето-код.
   ============================================================================ */

import React, { useState as useEdState } from 'react';

/* --------------------------------------------------------------------------
   Воспроизведённый КАНВАС bpmn-js (SVG в .djs-container)
   Координаты — абсолютные пользовательские единицы = px (svg без viewBox),
   чтобы HTML-оверлеи (context-pad, popup) совмещались по тем же координатам.
   -------------------------------------------------------------------------- */

/* type-иконка задачи: круг(человек) / ромб(агент) / квадрат(сервис) */
function TypeIcon({ exec }) {
  return (
    <g className="chs-type-icon" transform="translate(8,8)">
      {exec === "human"   && <circle cx="6" cy="6" r="5" />}
      {exec === "agent"   && <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="0.6" transform="rotate(45 6 6)" />}
      {exec === "service" && <rect x="1.5" y="1.5" width="9" height="9" rx="1" />}
    </g>
  );
}

/* Глифы BPMN в стиле линейных иконок продукта (шрифт bpmn-font в реальной
   интеграции заменит их через .bpmn-icon-*::before; в макете рисуем сами). */
function BpmnGlyph({ name, size = 18 }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };
  const task = <rect {...p} x="2.5" y="4" width="11" height="8" rx="1.5" />;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {name === "hand-tool" && (<><path {...p} d="M8 2.5v11M2.5 8h11" /><path {...p} d="M6.3 4.2L8 2.5l1.7 1.7M6.3 11.8L8 13.5l1.7-1.7M4.2 6.3L2.5 8l1.7 1.7M11.8 6.3L13.5 8l-1.7 1.7" /></>)}
      {name === "lasso-tool" && <rect {...p} x="2.5" y="3.5" width="11" height="9" rx="2.5" strokeDasharray="2 2" />}
      {name === "space-tool" && (<><path {...p} d="M3.5 8h9" /><path {...p} d="M8 2.5v3M6.3 4.2L8 2.5l1.7 1.7M8 13.5v-3M6.3 11.8L8 13.5l1.7-1.7" /></>)}
      {name === "connection-multi" && (<><path {...p} d="M3 13L13 3" /><path {...p} d="M8.5 3H13v4.5" /></>)}
      {name === "connection" && (<><path {...p} d="M3 13L13 3" /><path {...p} d="M8.5 3H13v4.5" /></>)}
      {name === "start-event-none" && <circle {...p} cx="8" cy="8" r="5.5" />}
      {name === "intermediate-event-none" && (<><circle {...p} cx="8" cy="8" r="5.5" /><circle {...p} cx="8" cy="8" r="3.4" /></>)}
      {name === "end-event-none" && <circle {...p} cx="8" cy="8" r="5.5" strokeWidth="2.3" />}
      {name === "gateway-none" && <polygon {...p} points="8,2 14,8 8,14 2,8" />}
      {name === "gateway-xor" && (<><polygon {...p} points="8,2 14,8 8,14 2,8" /><path {...p} d="M6.3 6.3l3.4 3.4M9.7 6.3l-3.4 3.4" /></>)}
      {name === "gateway-parallel" && (<><polygon {...p} points="8,2 14,8 8,14 2,8" /><path {...p} d="M8 5v6M5 8h6" /></>)}
      {name === "task" && task}
      {name === "subprocess-expanded" && (<>{task}<path {...p} d="M8 8.6v2M7 9.6h2" /></>)}
      {name === "data-object" && (<><path {...p} d="M4 2.5h5l3 3v8H4z" /><path {...p} d="M9 2.5v3h3" /></>)}
      {name === "data-store" && (<><path {...p} d="M3.6 4.5c0-1.1 8.8-1.1 8.8 0v7c0 1.1-8.8 1.1-8.8 0z" /><path {...p} d="M3.6 4.5c0 1.1 8.8 1.1 8.8 0" /></>)}
      {name === "participant" && (<><rect {...p} x="2" y="3.5" width="12" height="9" rx="1" /><path {...p} d="M5 3.5v9" /></>)}
      {name === "trash" && (<><path {...p} d="M3.5 4.5h9" /><path {...p} d="M5.6 4.5V3h4.8v1.5" /><path {...p} d="M4.6 4.5l.5 8.5h5.8l.5-8.5" /></>)}
      {name === "screw-wrench" && (<><circle {...p} cx="8" cy="8" r="2.4" /><path {...p} d="M8 2.6v1.8M8 11.6v-1.8M2.6 8h1.8M11.6 8h-1.8M4.4 4.4l1.3 1.3M11.6 11.6l-1.3-1.3M11.6 4.4l-1.3 1.3M4.4 11.6l1.3-1.3" /></>)}
      {name === "user-task" && (<>{task}<circle {...p} cx="5.3" cy="6.4" r="1" /><path {...p} d="M3.8 9.4c0-1.1 3-1.1 3 0" /></>)}
      {name === "service-task" && (<>{task}<circle {...p} cx="5.3" cy="7" r="1.1" /><path {...p} d="M5.3 4.8v.9M5.3 9.2v-.9M3.6 7h.9M7 7h-.9" /></>)}
      {name === "send-task" && (<>{task}<rect {...p} x="3.5" y="5.7" width="4.2" height="2.9" rx="0.3" /><path {...p} d="M3.5 6l2.1 1.5L7.7 6" /></>)}
    </svg>
  );
}

function TaskShape({ id, x, y, exec, title, sub, selected }) {
  const W = 132, H = 72;
  return (
    <g
      className={`djs-element djs-shape chs-exec-${exec}${selected ? " selected" : ""}`}
      data-element-id={id}
      transform={`translate(${x},${y})`}
    >
      <g className="djs-visual">
        <rect width={W} height={H} rx="6" ry="6" />
        <TypeIcon exec={exec} />
        <text x={W / 2} y={sub ? H / 2 - 2 : H / 2 + 4} textAnchor="middle" fontSize="13" fontWeight="500">{title}</text>
        {sub && <text x={W / 2} y={H / 2 + 16} textAnchor="middle" fontSize="10.5" className="chs-shape-sub">{sub}</text>}
      </g>
      <rect className="djs-hit" x="0" y="0" width={W} height={H} fill="none" />
      {selected && (
        <>
          <rect className="djs-outline" x="-6" y="-6" width={W + 12} height={H + 12} fill="none" rx="3" />
          {[[-6, -6], [W + 6, -6], [-6, H + 6], [W + 6, H + 6]].map(([rx, ry], i) => (
            <rect key={i} className="djs-resizer-visual" x={rx - 3} y={ry - 3} width="6" height="6" />
          ))}
        </>
      )}
    </g>
  );
}

function ProcessCanvas() {
  const CY = 210;
  return (
    <svg className="chs-bpmn-svg" width="930" height="300" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="chs-sequenceflow-end" viewBox="0 0 12 12" refX="11" refY="6"
          markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M1,1 L11,6 L1,11 z" />
        </marker>
      </defs>

      {/* связи (sequence flows) — рисуем первыми, под фигурами */}
      <g className="djs-connections">
        {[
          "M114,210 L150,210",
          "M290,210 L340,210",
          "M480,210 L530,210",
          "M670,210 L708,210",
          "M772,210 L830,210",
        ].map((d, i) => (
          <g className="djs-element djs-connection" data-element-id={`Flow_${i + 1}`} key={i}>
            <g className="djs-visual"><path d={d} markerEnd="url(#chs-sequenceflow-end)" /></g>
            <path className="djs-hit" d={d} fill="none" stroke="transparent" strokeWidth="12" />
          </g>
        ))}
      </g>

      {/* Старт */}
      <g className="djs-element djs-shape chs-event-start" data-element-id="StartEvent_1" transform="translate(78,192)">
        <g className="djs-visual"><circle cx="18" cy="18" r="18" /></g>
        <circle className="djs-hit" cx="18" cy="18" r="18" fill="none" />
      </g>
      <text x="96" y={CY + 44} textAnchor="middle" className="djs-label">Счёт поступил</text>

      {/* Шаги-исполнители */}
      <TaskShape id="Activity_user" x={158} y={174} exec="human" title="Согласовать счёт" sub="User Task" />
      <TaskShape id="Activity_agent" x={348} y={174} exec="agent" title="Проверить реквизиты" sub="Agent Task" selected />
      <TaskShape id="Activity_ext" x={538} y={174} exec="service" title="Провести платёж" sub="External Task" />

      {/* Шлюз */}
      <g className="djs-element djs-shape chs-gateway" data-element-id="Gateway_1" transform="translate(716,182)">
        <g className="djs-visual">
          <polygon points="28,0 56,28 28,56 0,28" />
          <path d="M18,18 L38,38 M38,18 L18,38" />
        </g>
        <rect className="djs-hit" x="0" y="0" width="56" height="56" fill="none" />
      </g>
      <text x="744" y={CY + 56} textAnchor="middle" className="djs-label">В пределах автономии?</text>

      {/* Конец */}
      <g className="djs-element djs-shape chs-event-end" data-element-id="EndEvent_1" transform="translate(838,192)">
        <g className="djs-visual"><circle cx="18" cy="18" r="18" /></g>
        <circle className="djs-hit" cx="18" cy="18" r="18" fill="none" />
      </g>
      <text x="856" y={CY + 44} textAnchor="middle" className="djs-label">Платёж проведён</text>
    </svg>
  );
}

/* --------------------------------------------------------------------------
   ПАЛИТРА (.djs-palette) — штатные классы + .bpmn-icon-*
   -------------------------------------------------------------------------- */
const PALETTE = [
  { cls: "bpmn-icon-hand-tool", title: "Инструмент «рука»" },
  { cls: "bpmn-icon-lasso-tool", title: "Лассо-выделение" },
  { cls: "bpmn-icon-space-tool", title: "Инструмент «отступ»" },
  { cls: "bpmn-icon-connection-multi", title: "Создать связь" },
  { sep: true },
  { cls: "bpmn-icon-start-event-none", title: "Начальное событие" },
  { cls: "bpmn-icon-intermediate-event-none", title: "Промежуточное событие" },
  { cls: "bpmn-icon-end-event-none", title: "Конечное событие" },
  { cls: "bpmn-icon-gateway-none", title: "Шлюз" },
  { sep: true },
  { cls: "bpmn-icon-task", title: "Задача" },
  { cls: "bpmn-icon-subprocess-expanded", title: "Подпроцесс" },
  { cls: "bpmn-icon-data-object", title: "Объект данных" },
  { cls: "bpmn-icon-data-store", title: "Хранилище данных" },
  { sep: true },
  { cls: "bpmn-icon-participant", title: "Пул / участник" },
];

function Palette() {
  return (
    <div className="djs-palette two-column open" aria-label="Палитра элементов">
      <div className="djs-palette-entries">
        {PALETTE.map((e, i) =>
          e.sep
            ? <div className="separator" key={i} />
            : <div className={`entry ${e.cls}`} key={i} title={e.title} role="button"><BpmnGlyph name={e.cls.replace("bpmn-icon-", "")} size={18} /></div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   CONTEXT-PAD (.djs-context-pad) — действия у выбранного узла
   -------------------------------------------------------------------------- */
function ContextPad({ onWrench }) {
  return (
    <div className="djs-context-pad open" style={{ left: "496px", top: "150px" }} aria-label="Действия с узлом">
      <div className="entry bpmn-icon-connection-multi" title="Связать" role="button"><BpmnGlyph name="connection-multi" size={15} /></div>
      <div className="entry bpmn-icon-trash" title="Удалить" role="button"><BpmnGlyph name="trash" size={15} /></div>
      <div className="entry bpmn-icon-task" title="Добавить задачу" role="button"><BpmnGlyph name="task" size={15} /></div>
      <div className="entry bpmn-icon-gateway-none" title="Добавить шлюз" role="button"><BpmnGlyph name="gateway-none" size={15} /></div>
      <div className="entry bpmn-icon-end-event-none" title="Добавить конец" role="button"><BpmnGlyph name="end-event-none" size={15} /></div>
      <div className="entry bpmn-icon-screw-wrench" title="Изменить тип шага" role="button" onClick={onWrench}><BpmnGlyph name="screw-wrench" size={15} /></div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   POPUP «Заменить элемент» (.djs-popup) — выбор типа шага = типа исполнителя
   -------------------------------------------------------------------------- */
function ReplacePopup() {
  return (
    <div className="djs-popup" style={{ left: "348px", top: "266px" }} role="dialog" aria-label="Заменить элемент">
      <div className="djs-popup-header">
        <div className="djs-popup-title">Заменить элемент</div>
        <div className="djs-popup-search">
          <Icon name="search" />
          <input className="djs-popup-search-input" placeholder="Поиск типа шага…" defaultValue="" />
        </div>
      </div>
      <div className="djs-popup-body">
        <div className="djs-popup-group">
          <div className="entry-header">Шаги-исполнители</div>
          <div className="entry bpmn-icon-user-task" role="option">
            <BpmnGlyph name="user-task" size={17} />
            <span className="djs-popup-entry-name">User Task — человек</span>
            <span className="djs-popup__execdot djs-popup__execdot--human" />
          </div>
          <div className="entry bpmn-icon-service-task selected" role="option" aria-selected="true">
            <BpmnGlyph name="service-task" size={17} />
            <span className="djs-popup-entry-name">Agent Task — ИИ-агент</span>
            <span className="djs-popup__execdot djs-popup__execdot--agent" />
          </div>
          <div className="entry bpmn-icon-send-task" role="option">
            <BpmnGlyph name="send-task" size={17} />
            <span className="djs-popup-entry-name">External Task — сервис</span>
            <span className="djs-popup__execdot djs-popup__execdot--service" />
          </div>
        </div>
        <div className="djs-popup-group">
          <div className="entry-header">Шлюзы и события</div>
          <div className="entry bpmn-icon-gateway-xor" role="option">
            <BpmnGlyph name="gateway-xor" size={17} />
            <span className="djs-popup-entry-name">Эксклюзивный шлюз</span>
          </div>
          <div className="entry bpmn-icon-gateway-parallel" role="option">
            <BpmnGlyph name="gateway-parallel" size={17} />
            <span className="djs-popup-entry-name">Параллельный шлюз</span>
          </div>
          <div className="entry bpmn-icon-end-event-none" role="option">
            <BpmnGlyph name="end-event-none" size={17} />
            <span className="djs-popup-entry-name">Конечное событие</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   ПАНЕЛЬ СВОЙСТВ (.bio-properties-panel*) — выбран Agent Task
   -------------------------------------------------------------------------- */
function PanelGroup({ title, dot, defaultOpen = false, children }) {
  const [open, setOpen] = useEdState(defaultOpen);
  return (
    <div className="bio-properties-panel-group">
      <div className="bio-properties-panel-group-header" aria-expanded={open} onClick={() => setOpen((o) => !o)} role="button">
        <span className="bio-properties-panel-group-header-title">{title}</span>
        <span className="bio-properties-panel-group-header-buttons">
          {dot && <span className="bio-properties-panel-dot" style={{ background: dot }} />}
          <span className="bio-properties-panel-arrow">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        </span>
      </div>
      <div className={`bio-properties-panel-group-entries ${open ? "open" : ""}`}>{children}</div>
    </div>
  );
}

function PPEntry({ label, children, mono }) {
  return (
    <div className="bio-properties-panel-entry" data-mono={mono ? "" : undefined}>
      {label && <label className="bio-properties-panel-label">{label}</label>}
      {children}
    </div>
  );
}

function PropertiesPanel() {
  return (
    <div className="bio-properties-panel-container">
      <div className="bio-properties-panel">
        <div className="bio-properties-panel-header">
          <span className="bio-properties-panel-header-icon bio-properties-panel-header-icon--agent">
            <ExecGlyph type="agent" size={13} />
          </span>
          <span className="bio-properties-panel-header-labels">
            <span className="bio-properties-panel-header-type">Agent Task · bpmn:ServiceTask</span>
            <span className="bio-properties-panel-header-label">Проверить реквизиты</span>
          </span>
        </div>

        <div className="bio-properties-panel-scroll-container">
          <PanelGroup title="Общее" defaultOpen>
            <PPEntry label="ID элемента" mono>
              <div className="bio-properties-panel-textfield">
                <input className="bio-properties-panel-input chs-mono" defaultValue="Activity_agent_0qz" />
              </div>
            </PPEntry>
            <PPEntry label="Имя шага">
              <div className="bio-properties-panel-textfield">
                <input className="bio-properties-panel-input" defaultValue="Проверить реквизиты" />
              </div>
            </PPEntry>
            <PPEntry label="Тип шага → исполнитель">
              <div className="bio-properties-panel-select">
                <select defaultValue="agent">
                  <option value="human">User Task — человек</option>
                  <option value="agent">Agent Task — ИИ-агент</option>
                  <option value="service">External Task — сервис</option>
                </select>
              </div>
            </PPEntry>
          </PanelGroup>

          <PanelGroup title="Исполнитель (полиморфный сотрудник)" dot="var(--chs-exec-agent)" defaultOpen>
            <PPEntry label="Назначенная роль">
              <div className="bio-properties-panel-select">
                <select defaultValue="r1">
                  <option value="r1">Контролёр платежей</option>
                  <option value="r2">Бухгалтер-оператор</option>
                </select>
              </div>
            </PPEntry>
            <PPEntry label="Закреплённый агент">
              <div className="chs-pp-readonly">
                <ExecutorBadge type="agent" name="Счёт-агент" />
                <MonoId>EMP-A-0042</MonoId>
              </div>
            </PPEntry>
            <PPEntry>
              <p className="chs-pp-note">Инструменты и видимые поля формы — <b>производные от грантов роли</b>, отдельными тумблерами не задаются.</p>
            </PPEntry>
          </PanelGroup>

          <PanelGroup title="Модель — BYO LLM" dot="var(--chs-exec-agent)" defaultOpen>
            <PPEntry label="Endpoint (хостинг клиента)" mono>
              <div className="bio-properties-panel-textfield">
                <input className="bio-properties-panel-input chs-mono" defaultValue="https://llm.internal/v1" />
              </div>
            </PPEntry>
            <div className="chs-pp-row">
              <PPEntry label="Модель">
                <div className="bio-properties-panel-select">
                  <select defaultValue="m1"><option value="m1">qwen2.5-72b</option><option>llama-3.1-70b</option></select>
                </div>
              </PPEntry>
              <PPEntry label="Контекст" mono>
                <div className="chs-pp-inline">
                  <div className="bio-properties-panel-textfield" style={{ flex: 1 }}>
                    <input className="bio-properties-panel-input chs-mono" defaultValue="32 768" />
                  </div>
                  <span className="chs-pp-unit">ткн</span>
                </div>
              </PPEntry>
            </div>
          </PanelGroup>

          <PanelGroup title="Бюджет и автономия" dot="var(--chs-color-warning)">
            <div className="chs-pp-row">
              <PPEntry label="Резерв / инстанс" mono>
                <div className="chs-pp-inline">
                  <div className="bio-properties-panel-textfield" style={{ flex: 1 }}><input className="bio-properties-panel-input chs-mono" defaultValue="50 000" /></div>
                  <span className="chs-pp-unit">ткн</span>
                </div>
              </PPEntry>
              <PPEntry label="Порог автономии" mono>
                <div className="chs-pp-inline">
                  <div className="bio-properties-panel-textfield" style={{ flex: 1 }}><input className="bio-properties-panel-input chs-mono" defaultValue="50 000" /></div>
                  <span className="chs-pp-unit">₽</span>
                </div>
              </PPEntry>
            </div>
            <PPEntry label="Зоны решения">
              <div className="chs-pp-autonomy">
                <span className="z-auto" style={{ flex: 5 }}>авто</span>
                <span className="z-review" style={{ flex: 3 }}>ревью</span>
                <span className="z-block" style={{ flex: 2 }}>стоп</span>
              </div>
            </PPEntry>
            <PPEntry label="Правило эскалации">
              <div className="bio-properties-panel-select">
                <select defaultValue="e1"><option value="e1">→ Контролёр платежей (человек)</option><option>→ Владелец процесса</option></select>
              </div>
            </PPEntry>
          </PanelGroup>

          <PanelGroup title="Форма и поля" dot="var(--chs-color-info)">
            <PPEntry label="Видимые поля (производные)">
              <div className="chs-pp-derived">
                <DerivedChip kind="read">сумма</DerivedChip>
                <DerivedChip kind="read">поставщик</DerivedChip>
                <DerivedChip kind="write">решение</DerivedChip>
              </div>
              <p className="chs-pp-note">Набор полей вычислен из грантов роли «Контролёр платежей».</p>
            </PPEntry>
          </PanelGroup>
        </div>
      </div>
    </div>
  );
}

/* Сцена диаграммы: масштабирует канвас под вьюпорт (как zoom fit-viewport bpmn-js).
   Канвас + контекст-пад + попап живут в одной системе координат и скейлятся
   вместе, поэтому оверлеи остаются привязанными к узлу. */
const DIAGRAM_W = 930, DIAGRAM_H = 300, NODE_CY = 210;

function DiagramStage({ zoomMul, onFit }) {
  const wrapRef = React.useRef(null);
  const [box, setBox] = useEdState({ w: 0, h: 0 });

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = box.w ? Math.min(1.15, (box.w - 40) / DIAGRAM_W) : 0.6;
  const scale = Math.max(0.3, fit * zoomMul);
  React.useEffect(() => { onFit(scale); }, [scale, onFit]);
  const tx = Math.round((box.w - DIAGRAM_W * scale) / 2);
  const ty = Math.round(box.h / 2 - NODE_CY * scale);

  return (
    <div className="chs-canvas" ref={wrapRef}>
      <div className="djs-container">
        <div className="chs-diagram" style={{ width: DIAGRAM_W, height: DIAGRAM_H, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
          <ProcessCanvas />
          <ContextPad onWrench={() => {}} />
          <ReplacePopup />
        </div>
        <Palette />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   ЭКРАН РЕДАКТОРА: тулбар + канвас(палитра/пад/попап) + панель свойств
   -------------------------------------------------------------------------- */
function ProcessEditor() {
  const [zoomMul, setZoomMul] = useEdState(1);
  const [fitScale, setFitScale] = useEdState(0.6);
  return (
    <div className="chs-editor" data-screen-label="Редактор процесса">
      <div className="chs-edtoolbar">
        <div className="chs-edtoolbar__id">
          <span className="chs-edtoolbar__name">Согласование счёта поставщика</span>
        </div>
        <div className="chs-edtoolbar__meta">
          <MonoId>PRC-INV-APPROVE</MonoId>
          <MonoId>v4 · черновик</MonoId>
        </div>
        <div className="chs-edtoolbar__sep" />
        <div className="chs-edtoolbar__group">
          <button className="chs-iconbtn" title="Отменить"><Icon name="chevron" className="" /></button>
          <button className="chs-iconbtn" title="Повторить" style={{ transform: "scaleX(-1)" }}><Icon name="chevron" /></button>
        </div>
        <span className="chs-edtoolbar__dirty">несохранённые изменения</span>
        <div className="chs-edtoolbar__spacer" />
        <StatusChip status="paused" label="Не опубликован" />
        <Button variant="ghost" size="sm">Проверить</Button>
        <Button variant="secondary" size="sm">Сохранить</Button>
        <Button variant="primary" size="sm">Опубликовать</Button>
      </div>

      <div className="chs-editor__body">
        <div className="chs-canvas-outer">
          <DiagramStage zoomMul={zoomMul} onFit={setFitScale} />
          <div className="chs-zoom">
            <button onClick={() => setZoomMul((z) => Math.max(0.4, +(z - 0.15).toFixed(2)))} title="Уменьшить">−</button>
            <span className="chs-zoom__val">{Math.round(fitScale * 100)}%</span>
            <button onClick={() => setZoomMul((z) => Math.min(2.2, +(z + 0.15).toFixed(2)))} title="Увеличить">+</button>
          </div>
        </div>
        <PropertiesPanel />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   ОБОЛОЧКА (нав + топбар + переключатель тем) — как в каркасе продукта
   -------------------------------------------------------------------------- */
const ED_NAV = [
  { group: "Оркестрация", items: [
    { id: "inbox", label: "Инбокс задач", icon: "inbox", count: 18 },
    { id: "org", label: "Оргструктура", icon: "org" },
    { id: "processes", label: "Процессы", icon: "process", count: 7 },
  ]},
  { group: "Наблюдаемость", items: [
    { id: "audit", label: "Аудит инстанса", icon: "audit" },
    { id: "budgets", label: "Бюджеты", icon: "budget", soon: true },
  ]},
  { group: "Доступ", items: [
    { id: "rights", label: "Права и доступ", icon: "rights", count: 8 },
  ]},
];

function EditorShell() {
  const [theme, setTheme] = useEdState(() => localStorage.getItem("chs-theme") || "dark");
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("chs-theme", theme);
  }, [theme]);

  return (
    <div className="chs-shell" data-screen-label="Процессы — Редактор">
      <aside className="chs-nav">
        <div className="chs-nav__brand">
          <div className="chs-nav__logo" />
          <div className="chs-nav__brandtext">
            <span className="chs-nav__name">Choros</span>
            <span className="chs-nav__org">control-plane · 214 исп.</span>
          </div>
        </div>
        <div className="chs-nav__search"><Icon name="search" /><span>Поиск</span><kbd>⌘K</kbd></div>
        <div className="chs-nav__scroll">
          {ED_NAV.map((grp) => (
            <div className="chs-nav__group" key={grp.group}>
              <div className="chs-nav__grouplabel">{grp.group}</div>
              {grp.items.map((item) => (
                <button key={item.id} type="button" className="chs-navitem"
                  aria-current={item.id === "processes" ? "true" : undefined}
                  disabled={item.id !== "processes"} title={item.soon ? "Скоро" : item.label}>
                  <Icon name={item.icon} className="chs-navitem__icon" />
                  <span className="chs-navitem__label">{item.label}</span>
                  {item.count != null && <span className="chs-navitem__count">{item.count}</span>}
                  {item.soon && <span className="chs-navitem__soon">скоро</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="chs-nav__foot">
          <div className="chs-nav__userglyph">МС</div>
          <div className="chs-nav__userinfo">
            <span className="chs-nav__username">М. Соколов</span>
            <span className="chs-nav__userrole">Оператор control-plane</span>
          </div>
        </div>
      </aside>

      <main className="chs-main">
        <header className="chs-topbar">
          <div className="chs-topbar__left">
            <nav className="chs-crumbs">
              <span className="chs-crumbs__seg">Оркестрация</span>
              <span className="chs-crumbs__sep">/</span>
              <span className="chs-crumbs__seg">Процессы</span>
              <span className="chs-crumbs__sep">/</span>
              <span className="chs-crumbs__seg chs-crumbs__seg--cur">Согласование счёта поставщика</span>
            </nav>
          </div>
          <div className="chs-topbar__right">
            <div className="chs-theme-toggle" role="group" aria-label="Тема оформления">
              <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Icon name="moon" /> Тёмная</button>
              <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Icon name="sun" /> Светлая</button>
            </div>
          </div>
        </header>
        <div className="chs-screen"><ProcessEditor /></div>
      </main>
    </div>
  );
}

export { EditorShell, ProcessEditor };
