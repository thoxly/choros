/* ============================================================================
   CHOROS — shell.jsx
   Оболочка (экран 4): левая навигация, топбар, переключатель тем, роутинг.
   Иконки — простая геометрия (линии/круги/прямоугольники).
   ============================================================================ */

const { useState, useEffect } = React;

/* ---- Простые линейные иконки (минимальная геометрия) ---- */
function Icon({ name, className }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {name === "inbox" && (<><path {...p} d="M2 4.5h12v7H2z" /><path {...p} d="M2 9.5h3l1 1.5h4l1-1.5h3" /></>)}
      {name === "org" && (<><rect {...p} x="6" y="2" width="4" height="3" /><rect {...p} x="1.5" y="11" width="4" height="3" /><rect {...p} x="10.5" y="11" width="4" height="3" /><path {...p} d="M8 5v3M3.5 11V8h9v3" /></>)}
      {name === "process" && (<><circle {...p} cx="3.5" cy="8" r="1.8" /><circle {...p} cx="12.5" cy="8" r="1.8" /><path {...p} d="M5.3 8h5.4" /></>)}
      {name === "audit" && (<><path {...p} d="M8 2v12" /><circle {...p} cx="8" cy="4" r="1.4" /><circle {...p} cx="8" cy="8" r="1.4" /><circle {...p} cx="8" cy="12" r="1.4" /></>)}
      {name === "budget" && (<><rect {...p} x="2" y="3" width="12" height="10" rx="1" /><path {...p} d="M2 9.5h5l1-2 1.5 3 1-1.5H14" /></>)}
      {name === "search" && (<><circle {...p} cx="7" cy="7" r="4.2" /><path {...p} d="M10.2 10.2L14 14" /></>)}
      {name === "chevron" && (<path {...p} d="M6 4l4 4-4 4" />)}
      {name === "moon" && (<path {...p} d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" />)}
      {name === "sun" && (<><circle {...p} cx="8" cy="8" r="3" /><path {...p} d="M8 1.5v1.5M8 13v1.5M2.4 2.4l1 1M12.6 12.6l1 1M1.5 8H3M13 8h1.5M2.4 13.6l1-1M12.6 3.4l1-1" /></>)}
      {name === "check" && (<path {...p} d="M3 8.5l3.2 3L13 5" />)}
      {name === "filter" && (<path {...p} d="M2.5 4h11l-4.2 5v3.5L6.7 14V9z" />)}
      {name === "plus" && (<path {...p} d="M8 3v10M3 8h10" />)}
      {name === "dots" && (<><circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" /></>)}
      {name === "split" && (<><path {...p} d="M4 2.5v4M4 6.5c0 4 8 1 8 5" /><circle {...p} cx="4" cy="2" r="1.2" /><circle {...p} cx="12" cy="13" r="1.2" /></>)}
      {name === "rights" && (<><path {...p} d="M8 1.8l5 1.7v4.1c0 3-2.1 5.1-5 6.4-2.9-1.3-5-3.4-5-6.4V3.5z" /><circle {...p} cx="8" cy="7" r="1.3" /><path {...p} d="M8 8.3v2.1" /></>)}
    </svg>
  );
}

const NAV = [
  {
    group: "Оркестрация",
    items: [
      { id: "inbox", label: "Инбокс задач", icon: "inbox", count: 18, screen: true },
      { id: "org", label: "Оргструктура", icon: "org", screen: true },
      { id: "processes", label: "Процессы", icon: "process", count: 7 },
    ],
  },
  {
    group: "Наблюдаемость",
    items: [
      { id: "audit", label: "Аудит инстанса", icon: "audit", screen: true },
      { id: "budgets", label: "Бюджеты", icon: "budget", soon: true },
    ],
  },
  {
    group: "Доступ",
    items: [
      { id: "rights", label: "Права и доступ", icon: "rights", count: 8, screen: true },
    ],
  },
];

const SCREEN_META = {
  inbox: { crumb: ["Оркестрация", "Инбокс задач"] },
  org:   { crumb: ["Оркестрация", "Оргструктура"] },
  audit: { crumb: ["Наблюдаемость", "Аудит инстанса"] },
  rights: { crumb: ["Доступ", "Права и доступ"] },
};

function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="chs-theme-toggle" role="group" aria-label="Тема оформления">
      <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
        <Icon name="moon" /> Тёмная
      </button>
      <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
        <Icon name="sun" /> Светлая
      </button>
    </div>
  );
}

function NavItem({ item, active, onSelect }) {
  const disabled = item.soon || (!item.screen && !item.count && false);
  const clickable = !!item.screen;
  return (
    <button
      className="chs-navitem"
      aria-current={active ? "true" : undefined}
      disabled={!clickable}
      onClick={() => clickable && onSelect(item.id)}
      title={item.soon ? "Скоро" : item.label}
    >
      <Icon name={item.icon} className="chs-navitem__icon" />
      <span className="chs-navitem__label">{item.label}</span>
      {item.count != null && <span className="chs-navitem__count">{item.count}</span>}
      {item.soon && <span className="chs-navitem__soon">скоро</span>}
    </button>
  );
}

function Topbar({ screen, theme, setTheme }) {
  const crumb = SCREEN_META[screen]?.crumb || [];
  const right =
    screen === "inbox" ? (
      <Button variant="primary" size="sm" glyph={<Icon name="plus" className="chs-btn__glyph" />}>Новая задача</Button>
    ) : screen === "org" ? (
      <Button variant="secondary" size="sm" glyph={<Icon name="plus" className="chs-btn__glyph" />}>Исполнитель</Button>
    ) : screen === "audit" ? (
      <Button variant="secondary" size="sm">Экспорт лога</Button>
    ) : screen === "rights" ? (
      <Button variant="secondary" size="sm">Экспорт прав</Button>
    ) : null;
  return (
    <header className="chs-topbar">
      <div className="chs-topbar__left">
        <nav className="chs-crumbs">
          {crumb.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="chs-crumbs__sep">/</span>}
              <span className={`chs-crumbs__seg ${i === crumb.length - 1 ? "chs-crumbs__seg--cur" : ""}`}>{seg}</span>
            </React.Fragment>
          ))}
        </nav>
      </div>
      <div className="chs-topbar__right">
        {right}
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>
    </header>
  );
}

function AppShell() {
  const [theme, setThemeState] = useState(() => localStorage.getItem("chs-theme") || "dark");
  const [screen, setScreenState] = useState(() => localStorage.getItem("chs-screen") || "audit");
  const [rightsFocus, setRightsFocus] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("chs-theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("chs-screen", screen); }, [screen]);

  const setTheme = (t) => setThemeState(t);
  const setScreen = (s) => setScreenState(s);
  const openRights = (roleId) => { setRightsFocus(roleId || null); setScreenState("rights"); };

  return (
    <div className="chs-shell">
      <aside className="chs-nav">
        <div className="chs-nav__brand">
          <div className="chs-nav__logo" />
          <div className="chs-nav__brandtext">
            <span className="chs-nav__name">Choros</span>
            <span className="chs-nav__org">control-plane · 214 исп.</span>
          </div>
        </div>

        <div className="chs-nav__search">
          <Icon name="search" />
          <span>Поиск</span>
          <kbd>⌘K</kbd>
        </div>

        <div className="chs-nav__scroll">
          {NAV.map((grp) => (
            <div className="chs-nav__group" key={grp.group}>
              <div className="chs-nav__grouplabel">{grp.group}</div>
              {grp.items.map((item) => (
                <NavItem key={item.id} item={item} active={screen === item.id} onSelect={setScreen} />
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
        <Topbar screen={screen} theme={theme} setTheme={setTheme} />
        <div className="chs-screen">
          {screen === "org" && <OrgScreen onOpenRights={openRights} />}
          {screen === "inbox" && <InboxScreen />}
          {screen === "audit" && <AuditScreen />}
          {screen === "rights" && <RightsScreen initialRole={rightsFocus} />}
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { Icon, AppShell });
