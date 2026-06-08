/* ============================================================================
   CHOROS — showcase.jsx  (страница-витрина фундамента дизайн-системы)
   ============================================================================ */
const { useState } = React;

/* ---------- маленькие хелперы витрины ---------- */
function Section({ num, title, desc, children }) {
  return (
    <section className="chs-section">
      <div className="chs-section__head">
        <span className="chs-section__num">{num}</span>
        <h2 className="chs-section__title">{title}</h2>
        {desc && <span className="chs-section__desc">{desc}</span>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, varName, color, dark }) {
  return (
    <div className="chs-swatch">
      <div className="chs-swatch__chip" style={{ background: color }} />
      <div className="chs-swatch__meta">
        <span className="chs-swatch__name">{name}</span>
        <span className="chs-swatch__var">{varName}</span>
      </div>
    </div>
  );
}

/* ---------- Палитра ---------- */
const NEUTRALS = [
  ["1000","--chs-neutral-1000"],["950","--chs-neutral-950"],["900","--chs-neutral-900"],
  ["850","--chs-neutral-850"],["800","--chs-neutral-800"],["750","--chs-neutral-750"],
  ["700","--chs-neutral-700"],["600","--chs-neutral-600"],["500","--chs-neutral-500"],
  ["400","--chs-neutral-400"],["300","--chs-neutral-300"],["200","--chs-neutral-200"],
  ["100","--chs-neutral-100"],["50","--chs-neutral-50"],["0","--chs-neutral-0"],
];

function PaletteSection() {
  return (
    <Section num="01" title="Палитра" desc="графит + один сигнал + три исполнителя">
      <div className="chs-subhead">Нейтральная база — графит / уголь</div>
      <div className="chs-swatch-row">
        {NEUTRALS.map(([n, v]) => (
          <Swatch key={v} name={n} varName={v} color={`var(${v})`} />
        ))}
      </div>

      <div className="chs-grid chs-grid--2" style={{ marginTop: "var(--chs-space-9)" }}>
        <div>
          <div className="chs-subhead">Сигнальный акцент</div>
          <div className="chs-swatch-row" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <Swatch name="accent" varName="--chs-color-accent" color="var(--chs-color-accent)" />
            <Swatch name="hover" varName="--chs-color-accent-hover" color="var(--chs-color-accent-hover)" />
            <Swatch name="soft" varName="--chs-color-accent-soft" color="var(--chs-color-accent-soft)" />
          </div>
          <p style={{ fontSize: "var(--chs-text-sm)", color: "var(--chs-color-text-muted)", marginTop: "var(--chs-space-5)", lineHeight: 1.5 }}>
            Единственный хроматический сигнал интерфейса: первичные действия, фокус, выделение строки, активные состояния. Всё остальное — нейтрали.
          </p>
        </div>
        <div>
          <div className="chs-subhead">Статусы</div>
          <div className="chs-swatch-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            <Swatch name="success" varName="--chs-color-success" color="var(--chs-color-success)" />
            <Swatch name="warning" varName="--chs-color-warning" color="var(--chs-color-warning)" />
            <Swatch name="danger" varName="--chs-color-danger" color="var(--chs-color-danger)" />
            <Swatch name="info" varName="--chs-color-info" color="var(--chs-color-info)" />
          </div>
          <div style={{ display: "flex", gap: "var(--chs-space-4)", marginTop: "var(--chs-space-6)", flexWrap: "wrap" }}>
            <StatusChip status="running" /><StatusChip status="done" /><StatusChip status="failed" /><StatusChip status="waiting" /><StatusChip status="paused" />
          </div>
        </div>
      </div>

      <div className="chs-subhead" style={{ marginTop: "var(--chs-space-9)" }}>Три исполнителя — сквозной цвето-иконочный код</div>
      <div className="chs-grid chs-grid--3">
        {[
          { type: "human",   varName: "--chs-exec-human" },
          { type: "agent",   varName: "--chs-exec-agent" },
          { type: "service", varName: "--chs-exec-service" },
        ].map(({ type, varName }) => (
          <div key={type} className="chs-exec-card" style={{ borderColor: `var(${varName}-border)`, background: `var(${varName}-soft)` }}>
            <div className="chs-exec-card__big" style={{ background: `var(${varName})` }}>
              <ExecGlyph type={type} size={26} filled={false} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="chs-exec-card__name" style={{ color: `var(${varName})` }}>{EXEC_META[type].label}</span>
              <ExecutorBadge type={type} />
            </div>
            <span className="chs-exec-card__var">{varName}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ---------- Типографика ---------- */
const TYPE_SCALE = [
  ["4xl / 46", "--chs-text-4xl", 700, "Control plane"],
  ["3xl / 34", "--chs-text-3xl", 600, "Процессы и исполнители"],
  ["2xl / 26", "--chs-text-2xl", 600, "Заголовок раздела"],
  ["xl / 20",  "--chs-text-xl",  600, "Подзаголовок панели"],
  ["lg / 16",  "--chs-text-lg",  500, "Крупный текст"],
  ["md / 14",  "--chs-text-md",  400, "Вторичный текст интерфейса"],
  ["base / 13","--chs-text-base",400, "Базовый текст плотного UI — строки, метки, кнопки"],
  ["sm / 12",  "--chs-text-sm",  400, "Подписи, второстепенные данные"],
  ["xs / 11",  "--chs-text-xs",  500, "МЕТКИ, КАПС"],
];

function TypeSection() {
  return (
    <Section num="02" title="Типографика" desc="Golos Text (гротеск) + JetBrains Mono">
      <div className="chs-grid chs-grid--2">
        <div className="chs-card">
          <span className="chs-card__label">--chs-font-sans · гротеск · интерфейсный текст</span>
          {TYPE_SCALE.map(([meta, v, w, sample]) => (
            <div className="chs-type-row" key={v}>
              <span className="chs-type-meta">{meta}</span>
              <span className="chs-type-spec" style={{ fontSize: `var(${v})`, fontWeight: w, letterSpacing: "var(--chs-tracking-tight)" }}>{sample}</span>
            </div>
          ))}
        </div>
        <div className="chs-card">
          <span className="chs-card__label">--chs-font-mono · моноширинный · всё «машинное»</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--chs-space-6)", marginTop: "var(--chs-space-3)" }}>
            <div>
              <div className="chs-type-meta" style={{ marginBottom: 6 }}>ID процесса / инстанса / задачи</div>
              <div style={{ display: "flex", gap: "var(--chs-space-5)", flexWrap: "wrap" }}>
                <MonoId chip>{"PRC-2041"}</MonoId><MonoId chip>{"INS-8837-A"}</MonoId><MonoId chip>{"TSK-0192"}</MonoId>
              </div>
            </div>
            <div>
              <div className="chs-type-meta" style={{ marginBottom: 6 }}>Таймстамп</div>
              <Mono style={{ fontSize: "var(--chs-text-md)" }}>2026-06-07 14:32:08.417 UTC+3</Mono>
            </div>
            <div>
              <div className="chs-type-meta" style={{ marginBottom: 6 }}>Бюджет — токены / деньги</div>
              <div style={{ display: "flex", gap: "var(--chs-space-8)", flexWrap: "wrap" }}>
                <Mono style={{ fontSize: "var(--chs-text-lg)" }}>148 920 ткн</Mono>
                <Mono style={{ fontSize: "var(--chs-text-lg)" }}>₽ 12 480,00</Mono>
              </div>
            </div>
            <div>
              <div className="chs-type-meta" style={{ marginBottom: 6 }}>Табличные числа (tnum)</div>
              <Mono style={{ fontSize: "var(--chs-text-md)", display: "block", lineHeight: 1.5 }}>
                1 204.50<br/>  87.00<br/>3 991.25
              </Mono>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------- Отступы / Радиусы ---------- */
const SPACES = [
  ["space-1","--chs-space-1","2"],["space-2","--chs-space-2","4"],["space-3","--chs-space-3","6"],
  ["space-4","--chs-space-4","8"],["space-5","--chs-space-5","12"],["space-6","--chs-space-6","16"],
  ["space-7","--chs-space-7","20"],["space-8","--chs-space-8","24"],["space-9","--chs-space-9","32"],
  ["space-10","--chs-space-10","48"],["space-11","--chs-space-11","64"],
];
const RADII = [
  ["radius-1","--chs-radius-1","2"],["radius-2","--chs-radius-2","4"],
  ["radius-3","--chs-radius-3","6"],["radius-4","--chs-radius-4","8"],
];

function ScaleSection() {
  return (
    <Section num="03" title="Отступы и радиусы" desc="шаг 2 / 4px · резкие грани">
      <div className="chs-grid chs-grid--2">
        <div className="chs-card">
          <span className="chs-card__label">--chs-space-* · базовая сетка</span>
          {SPACES.map(([n, v, px]) => (
            <div className="chs-scale-row" key={v}>
              <span className="chs-scale-name">{n}</span>
              <span className="chs-scale-val">{px}px</span>
              <span className="chs-scale-bar" style={{ width: `var(${v})` }} />
            </div>
          ))}
        </div>
        <div className="chs-card">
          <span className="chs-card__label">--chs-radius-* · малые радиусы</span>
          <div className="chs-tokrow" style={{ marginTop: "var(--chs-space-5)" }}>
            {RADII.map(([n, v, px]) => (
              <div className="chs-radius-cell" key={v}>
                <div className="chs-radius-demo" style={{ borderRadius: `var(${v})` }} />
                <span className="chs-scale-name" style={{ width: "auto", textAlign: "center" }}>{n}</span>
                <span className="chs-scale-val" style={{ width: "auto" }}>{px}px</span>
              </div>
            ))}
          </div>
          <span className="chs-card__label" style={{ marginTop: "var(--chs-space-9)" }}>Тени — минимум, опора на границы</span>
          <div style={{ display: "flex", gap: "var(--chs-space-8)", marginTop: "var(--chs-space-5)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
              <div style={{ width: 60, height: 48, background: "var(--chs-color-surface-raised)", borderRadius: "var(--chs-radius-3)", boxShadow: "var(--chs-shadow-1)", border: "1px solid var(--chs-color-border)" }} />
              <span className="chs-scale-name" style={{ width: "auto" }}>shadow-1</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
              <div style={{ width: 60, height: 48, background: "var(--chs-color-surface-raised)", borderRadius: "var(--chs-radius-3)", boxShadow: "var(--chs-shadow-2)", border: "1px solid var(--chs-color-border)" }} />
              <span className="chs-scale-name" style={{ width: "auto" }}>shadow-2</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------- Примитивы ---------- */
function PrimitivesSection() {
  const [q, setQ] = useState("");
  return (
    <Section num="04" title="Примитивы" desc="доменные компоненты">
      <div className="chs-grid chs-grid--2">
        <div className="chs-card">
          <span className="chs-card__label">ExecutorBadge · MonoId</span>
          <div style={{ display: "flex", gap: "var(--chs-space-5)", flexWrap: "wrap", marginBottom: "var(--chs-space-7)" }}>
            <ExecutorBadge type="human" name="А. Кравцова" />
            <ExecutorBadge type="agent" name="extract-v3" />
            <ExecutorBadge type="service" name="ocr-gateway" />
          </div>
          <div style={{ display: "flex", gap: "var(--chs-space-6)", flexWrap: "wrap", alignItems: "center" }}>
            <ExecutorBadge type="human" bare />
            <ExecutorBadge type="agent" bare />
            <ExecutorBadge type="service" bare />
            <MonoId chip>{"PRC-2041"}</MonoId>
            <MonoId>{"INS-8837-A"}</MonoId>
          </div>
        </div>

        <div className="chs-card">
          <span className="chs-card__label">BudgetMeter</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--chs-space-6)" }}>
            <BudgetMeter label="Токены инстанса" used={148920} total={250000} unit="ткн" />
            <BudgetMeter label="Лимит расхода" used={11800} total={12480} unit="₽" fmt={(n)=>"₽ "+n.toLocaleString("ru-RU")} />
            <BudgetMeter label="Превышение" used={26400} total={20000} unit="ткн" />
          </div>
        </div>

        <div className="chs-card">
          <span className="chs-card__label">Кнопки</span>
          <div className="chs-specrow">
            <Button variant="primary">Запустить процесс</Button>
            <Button variant="secondary">Открыть</Button>
            <Button variant="ghost">Отмена</Button>
            <Button variant="danger">Остановить</Button>
          </div>
          <div className="chs-specrow">
            <Button variant="primary" size="sm">Назначить</Button>
            <Button variant="secondary" size="sm">Дублировать</Button>
            <Button variant="ghost" size="sm">Подробнее</Button>
            <Button variant="secondary" size="sm" disabled>Недоступно</Button>
          </div>
        </div>

        <div className="chs-card">
          <span className="chs-card__label">Поля ввода</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--chs-space-6)" }}>
            <Field label="Название процесса" placeholder="Согласование счёта" value={q} onChange={(e)=>setQ(e.target.value)} />
            <Field label="ID инстанса" mono placeholder="INS-0000-0" />
            <Field label="Лимит, ткн" mono defaultValue="250000" />
            <Field label="SLA, мин" mono invalid defaultValue="-15" hint="Значение должно быть ≥ 0" />
          </div>
        </div>
      </div>

      <div className="chs-subhead">TaskRow — плотная строка задачи (высота 34px)</div>
      <div className="chs-panel">
        <TaskRow status="running" name="Извлечение реквизитов из PDF" sub="Согласование счёта · шаг 2 из 5" execType="agent" execName="extract-v3" id="TSK-0192" budget={{used:148920,total:250000,unit:"ткн"}} ts="14:32:08" />
        <TaskRow status="waiting" name="Ручная проверка суммы" sub="Ожидает исполнителя" execType="human" execName="А. Кравцова" id="TSK-0193" budget={{used:0,total:1,unit:""}} ts="—" />
        <TaskRow status="done" name="Запись в реестр платежей" execType="service" execName="ledger-api" id="TSK-0188" budget={{used:120,total:500,unit:"ткн"}} ts="14:29:51" />
        <TaskRow status="failed" name="Уведомление контрагента" sub="Таймаут SMTP-шлюза" execType="service" execName="notify-svc" id="TSK-0190" budget={{used:0,total:200,unit:"ткн"}} ts="14:31:02" />
        <TaskRow status="paused" name="Эскалация руководителю" execType="human" execName="Д. Орлов" id="TSK-0194" budget={{used:0,total:1,unit:""}} ts="—" />
      </div>

      <div className="chs-grid chs-grid--2" style={{ marginTop: "var(--chs-space-8)" }}>
        <div>
          <div className="chs-subhead">AuditEvent — единый аудит-лог</div>
          <div className="chs-panel" style={{ padding: "var(--chs-space-3) 0" }}>
            <AuditEvent ts="14:32:08.417" actorType="agent" actor="extract-v3" action="извлёк 7 полей из документа" target="DOC-5521" />
            <AuditEvent ts="14:31:55.002" actorType="human" actor="А. Кравцова" action="назначена на задачу" target="TSK-0193" />
            <AuditEvent ts="14:31:02.778" actorType="service" actor="notify-svc" action="вернул ошибку SMTP_TIMEOUT по" target="TSK-0190" />
            <AuditEvent ts="14:29:51.334" actorType="service" actor="ledger-api" action="зафиксировал платёж в реестре" target="PAY-3390" />
            <AuditEvent ts="14:28:10.001" actorType="human" actor="Д. Орлов" action="запустил инстанс процесса" target="INS-8837-A" />
          </div>
        </div>
        <div>
          <div className="chs-subhead">Плотная таблица — инстансы процессов</div>
          <div className="chs-panel">
            <table className="chs-table">
              <thead>
                <tr><th>Инстанс</th><th>Статус</th><th>Исполнитель</th><th className="chs-num">Бюджет, ткн</th></tr>
              </thead>
              <tbody>
                <tr><td><MonoId>{"INS-8837-A"}</MonoId></td><td><StatusChip status="running" /></td><td><ExecutorBadge type="agent" name="extract-v3" /></td><td className="chs-num">148 920</td></tr>
                <tr><td><MonoId>{"INS-8836-C"}</MonoId></td><td><StatusChip status="waiting" /></td><td><ExecutorBadge type="human" name="А. Кравцова" /></td><td className="chs-num">0</td></tr>
                <tr><td><MonoId>{"INS-8835-A"}</MonoId></td><td><StatusChip status="done" /></td><td><ExecutorBadge type="service" name="ledger-api" /></td><td className="chs-num">12 040</td></tr>
                <tr><td><MonoId>{"INS-8834-B"}</MonoId></td><td><StatusChip status="failed" /></td><td><ExecutorBadge type="service" name="notify-svc" /></td><td className="chs-num">3 200</td></tr>
                <tr><td><MonoId>{"INS-8833-A"}</MonoId></td><td><StatusChip status="paused" /></td><td><ExecutorBadge type="human" name="Д. Орлов" /></td><td className="chs-num">880</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ---------- App ---------- */
function App() {
  const [theme, setTheme] = useState("dark");
  React.useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  return (
    <div className="chs-app">
      <header className="chs-topbar">
        <div className="chs-brand">
          <span className="chs-logo" />
          <span className="chs-brand__name">Choros</span>
          <span className="chs-brand__tag">design-system / foundation v0.1</span>
        </div>
        <div className="chs-theme-toggle" role="group" aria-label="Тема">
          <button aria-pressed={theme==="dark"} onClick={()=>setTheme("dark")}>Тёмная</button>
          <button aria-pressed={theme==="light"} onClick={()=>setTheme("light")}>Светлая</button>
        </div>
      </header>

      <div className="chs-page">
        <div className="chs-intro">
          <h1>Фундамент дизайн-системы</h1>
          <p>
            Базовый слой для процессной платформы, где человек, ИИ-агент и микросервис — равноправные исполнители
            под одним control plane и единым аудит-логом. Токены, типошкала и доменные примитивы, которые наследуют
            остальные проекты. Инженерная плотность, резкие грани, моноширинный для всего машинного.
          </p>
        </div>

        <PaletteSection />
        <TypeSection />
        <ScaleSection />
        <PrimitivesSection />

        <footer className="chs-foot">
          <span>CHOROS · chs-* tokens · :root + [data-theme=light]</span>
          <span>Golos Text · JetBrains Mono</span>
        </footer>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
