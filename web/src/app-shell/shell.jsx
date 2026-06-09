/* ============================================================================
   CHOROS — shell.jsx
   Оболочка: левая навигация, топбар, переключатель тем, роутинг.
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Routes, Route } from 'react-router-dom';
import { Button } from '../components/components.jsx';
import { Icon } from './icon.jsx';
import InboxScreen from '../screens/screen-inbox.jsx';
import OrgScreen from '../screens/screen-org.jsx';
import AuditScreen from '../screens/screen-audit.jsx';
import RightsScreen from '../screens/rights/screen-rights.jsx';

export { Icon };

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

function NavItem({ item, active }) {
  const navigate = useNavigate();
  const disabled = item.soon || !item.screen;
  const clickable = !!item.screen;
  return (
    <button
      className="chs-navitem"
      aria-current={active ? "true" : undefined}
      disabled={!clickable}
      onClick={() => clickable && navigate('/' + item.id)}
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
  const [rightsFocus, setRightsFocus] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Derive current screen from pathname
  const pathParts = location.pathname.split('/').filter(Boolean);
  const screen = pathParts[0] || "inbox";

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("chs-theme", theme);
  }, [theme]);

  const setTheme = (t) => setThemeState(t);
  const openRights = (roleId) => {
    setRightsFocus(roleId || null);
    navigate('/rights');
  };

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
                <NavItem key={item.id} item={item} active={screen === item.id} />
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
          <Routes>
            <Route path="/" element={<InboxScreen />} />
            <Route path="/inbox" element={<InboxScreen />} />
            <Route path="/org" element={<OrgScreen onOpenRights={openRights} />} />
            <Route path="/audit" element={<AuditScreen />} />
            <Route path="/rights" element={<RightsScreen initialRole={rightsFocus} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default AppShell;
