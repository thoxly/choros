/* ============================================================================
   CHOROS — shell.jsx
   Оболочка: левая навигация, топбар, переключатель тем, роутинг.
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Routes, Route } from 'react-router-dom';
import { Button } from '../components/components.jsx';
import { Icon } from './icon.jsx';
import { getDevUser, clearDevUser, setDevUser, devHeaders } from './dev-auth.js';
import LoginScreen from '../screens/screen-login.jsx';
import InboxScreen from '../screens/screen-inbox.jsx';
import OrgScreen from '../screens/screen-org.jsx';
import ProcessesScreen from '../screens/screen-processes.jsx';
import AuditScreen from '../screens/screen-audit.jsx';
import RightsScreen from '../screens/rights/screen-rights.jsx';
import RoleEditorScreen from '../screens/rights/ra-role-editor.jsx';
import CriticalityScreen from '../screens/rights/ra-criticality.jsx';
import SoDScreen from '../screens/rights/ra-sod.jsx';
import GrantTrailScreen from '../screens/rights/ra-grant-trail.jsx';
import IntentsScreen from '../screens/rights/ra-intents.jsx';
import FormsScreen from '../screens/screen-forms.jsx';
import NotificationsScreen from '../screens/screen-notifications.jsx';

export { Icon };

const RIGHTS_TABS = [
  { id: "overview", label: "Обзор ролей", path: "/rights" },
  { id: "intents",  label: "Бытовые операции", path: "/rights/intents" },
  { id: "editor",   label: "Редактор роли", path: "/rights/editor" },
  { id: "criticality", label: "Критичность", path: "/rights/criticality" },
  { id: "sod",      label: "SoD", path: "/rights/sod" },
  { id: "trail",    label: "Журнал", path: "/rights/trail" },
];

const NAV = [
  {
    group: "Оркестрация",
    items: [
      { id: "inbox", label: "Инбокс задач", icon: "inbox", count: 18, screen: true },
      { id: "org", label: "Оргструктура", icon: "org", screen: true },
      { id: "processes", label: "Процессы", icon: "process", count: 7, screen: true },
    ],
  },
  {
    group: "Наблюдаемость",
    items: [
      { id: "notifications", label: "Уведомления", icon: "bell", screen: true },
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
  {
    group: "Разработка",
    items: [
      { id: "forms", label: "Формы задач", icon: "forms", screen: true },
    ],
  },
];

const SCREEN_META = {
  inbox: { crumb: ["Оркестрация", "Инбокс задач"] },
  org:   { crumb: ["Оркестрация", "Оргструктура"] },
  processes: { crumb: ["Оркестрация", "Процессы"] },
  notifications: { crumb: ["Наблюдаемость", "Уведомления"] },
  audit: { crumb: ["Наблюдаемость", "Аудит инстанса"] },
  rights: { crumb: ["Доступ", "Права и доступ"] },
  forms:  { crumb: ["Разработка", "Формы задач"] },
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

/**
 * T-0138: download audit log by fetching /api/audit/export and triggering
 * a browser file-save. Uses current devHeaders() for auth (x-dev-user).
 * Falls back to alert on auth/network error.
 */
async function downloadAuditLog() {
  try {
    const res = await fetch('/api/audit/export', { headers: devHeaders() });
    if (res.status === 401) {
      alert('Войдите в систему, чтобы экспортировать лог аудита.');
      return;
    }
    if (!res.ok) {
      alert(`Ошибка экспорта: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : 'audit-export.json';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    alert('Не удалось выполнить экспорт лога аудита.');
  }
}

function Topbar({ screen, theme, setTheme }) {
  const crumb = SCREEN_META[screen]?.crumb || [];
  const right =
    screen === "inbox" ? (
      // T-0138: «Новая задача» requires a running Flowable instance to start a
      // process. No start-instance HTTP route exists in day-1. Button is disabled
      // with a tooltip explaining the prerequisite. Forward obligation: when
      // POST /api/processes/start is implemented this button opens a launch modal.
      <Button
        variant="primary"
        size="sm"
        glyph={<Icon name="plus" className="chs-btn__glyph" />}
        disabled
        title="Создание задачи требует подключения к Flowable (будет доступно в следующей итерации)"
      >
        Новая задача
      </Button>
    ) : screen === "org" ? (
      <Button variant="secondary" size="sm" glyph={<Icon name="plus" className="chs-btn__glyph" />}>Исполнитель</Button>
    ) : screen === "audit" ? (
      // T-0138: download current instance audit log via GET /api/audit/export
      <Button variant="secondary" size="sm" onClick={downloadAuditLog}>Экспорт лога</Button>
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

function RightsSubTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const active = RIGHTS_TABS.find((t) =>
    t.path === location.pathname ||
    (t.path !== "/rights" && location.pathname.startsWith(t.path))
  )?.id || "overview";
  return (
    <div className="chs-subtabs">
      {RIGHTS_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="chs-subtab"
          aria-selected={active === t.id}
          onClick={() => navigate(t.path)}
          data-screen-label={t.label}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function AppShell() {
  const [theme, setThemeState] = useState(() => localStorage.getItem("chs-theme") || "dark");
  const [rightsFocus, setRightsFocus] = useState(null);
  const [devUser, setDevUserState] = useState(() => getDevUser());
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

  const handleLogin = (user) => {
    setDevUser(user);
    setDevUserState(user);
  };

  const handleLogout = () => {
    clearDevUser();
    setDevUserState(null);
  };

  // Gate: if not logged in, show login screen
  if (!devUser) {
    return <LoginScreen onLogin={handleLogin} />;
  }

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
          <div className="chs-nav__userglyph">{devUser.name.split(' ').slice(0, 2).map((word) => word[0]).join('')}</div>
          <div className="chs-nav__userinfo">
            <span className="chs-nav__username">{devUser.name}</span>
            <span className="chs-nav__userrole">{devUser.position}</span>
          </div>
          <button onClick={handleLogout} title="Выйти" className="chs-nav__logout-btn">
            Выйти
          </button>
        </div>
      </aside>

      <main className="chs-main">
        <Topbar screen={screen} theme={theme} setTheme={setTheme} />
        {screen === "rights" && <RightsSubTabs />}
        <div className="chs-screen">
          <Routes>
            <Route path="/" element={<InboxScreen />} />
            <Route path="/inbox" element={<InboxScreen />} />
            <Route path="/org" element={<OrgScreen onOpenRights={openRights} />} />
            <Route path="/processes" element={<ProcessesScreen />} />
            <Route path="/notifications" element={<NotificationsScreen />} />
            <Route path="/audit" element={<AuditScreen />} />
            <Route path="/rights" element={<RightsScreen initialRole={rightsFocus} />} />
            <Route path="/rights/intents" element={<IntentsScreen />} />
            <Route path="/rights/editor" element={<RoleEditorScreen />} />
            <Route path="/rights/criticality" element={<CriticalityScreen />} />
            <Route path="/rights/sod" element={<SoDScreen />} />
            <Route path="/rights/trail" element={<GrantTrailScreen />} />
            <Route path="/forms" element={<FormsScreen theme={theme} />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default AppShell;
