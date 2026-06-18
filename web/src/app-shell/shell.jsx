/* ============================================================================
   CHOROS — shell.jsx
   Оболочка: левая навигация, топбар, переключатель тем, роутинг.
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Routes, Route } from 'react-router-dom';
import { Button } from '../components/components.jsx';
import { Icon } from './icon.jsx';
import { getDevUser, clearDevUser, setDevUser, devHeaders } from './dev-auth.js';
import { loadAuthConfig, getAuthConfig, isKeycloakMode } from './auth-mode.js';
import * as kc from './keycloak-auth.js';
import { NAV, visibleItems, effectiveStatus } from './nav-config.js';
import LoginScreen from '../screens/screen-login.jsx';
import InboxScreen from '../screens/screen-inbox.jsx';
import OrgScreen from '../screens/screen-org.jsx';
import ProcessesScreen from '../screens/screen-processes.jsx';
import AppsScreen from '../screens/screen-apps.jsx';
import AppSchemaScreen from '../screens/screen-app-schema.jsx';
import AppRecordsScreen from '../screens/screen-app-records.jsx';
import AuditScreen from '../screens/screen-audit.jsx';
import RightsScreen from '../screens/rights/screen-rights.jsx';
import RoleEditorScreen from '../screens/rights/ra-role-editor.jsx';
import CriticalityScreen from '../screens/rights/ra-criticality.jsx';
import SoDScreen from '../screens/rights/ra-sod.jsx';
import GrantTrailScreen from '../screens/rights/ra-grant-trail.jsx';
import IntentsScreen from '../screens/rights/ra-intents.jsx';
import FormsScreen from '../screens/screen-forms.jsx';
import NotificationsScreen from '../screens/screen-notifications.jsx';
import ProcessEditorScreen from '../screens/screen-process-editor.jsx';
import AgentsScreen from '../screens/screen-agents.jsx';

export { Icon };

const RIGHTS_TABS = [
  { id: "overview",    label: "Обзор ролей",       path: "/rights",              status: "live" },
  { id: "intents",     label: "Бытовые операции",  path: "/rights/intents",      status: "live" },
  { id: "editor",      label: "Редактор роли",      path: "/rights/editor",       status: "demo" },
  { id: "criticality", label: "Критичность",        path: "/rights/criticality",  status: "demo" },
  { id: "sod",         label: "SoD",                path: "/rights/sod",          status: "demo" },
  { id: "trail",       label: "Журнал",             path: "/rights/trail",        status: "live" },
];

// NAV is imported from ./nav-config.js

const SCREEN_META = {
  apps:  { crumb: ["Конструктор", "Приложения"] },
  "app-schema": { crumb: ["Конструктор", "Поля приложения"] },
  "app-records": { crumb: ["Конструктор", "Записи приложения"] },
  inbox: { crumb: ["Оркестрация", "Инбокс задач"] },
  org:   { crumb: ["Оркестрация", "Оргструктура"] },
  processes: { crumb: ["Оркестрация", "Процессы"] },
  agents: { crumb: ["Оркестрация", "Агенты"] },
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
  const status = effectiveStatus(item);
  const isSoon = status === "soon";
  const clickable = !!item.screen && !isSoon;
  const titleAttr = isSoon ? "Скоро" : status === "demo" ? `${item.label} (демо)` : item.label;
  return (
    <button
      className="chs-navitem"
      aria-current={active ? "true" : undefined}
      disabled={!clickable}
      onClick={() => clickable && navigate('/' + item.id)}
      title={titleAttr}
    >
      <Icon name={item.icon} className="chs-navitem__icon" />
      <span className="chs-navitem__label">{item.label}</span>
      {item.count != null && status === "live" && <span className="chs-navitem__count">{item.count}</span>}
      {status === "demo" && <span className="chs-navitem__demo">демо</span>}
      {isSoon && <span className="chs-navitem__soon">скоро</span>}
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

function Topbar({ screen, theme, setTheme, onLaunchProcess }) {
  const crumb = SCREEN_META[screen]?.crumb || [];
  const navigate = useNavigate();
  const right =
    screen === "inbox" ? (
      // T-0281: «Новая задача» — enabled, navigates to /processes where the
      // launch modal lives (POST /api/processes/start, frozen contract §2.2).
      <Button
        variant="primary"
        size="sm"
        glyph={<Icon name="plus" className="chs-btn__glyph" />}
        onClick={() => navigate('/processes')}
        title="Запустить процесс"
      >
        Новая задача
      </Button>
    ) : screen === "processes" ? (
      // T-0281: «Запустить процесс» button in topbar on processes screen.
      <Button
        variant="primary"
        size="sm"
        glyph={<Icon name="plus" className="chs-btn__glyph" />}
        onClick={onLaunchProcess}
        title="Запустить процесс"
      >
        Запустить процесс
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
          title={t.status === "demo" ? `${t.label} (демо — mock-данные)` : t.label}
        >
          {t.label}
          {t.status === "demo" && <span className="chs-subtab__demo">демо</span>}
        </button>
      ))}
    </div>
  );
}

function AppShell() {
  const [theme, setThemeState] = useState(() => localStorage.getItem("chs-theme") || "dark");
  const [rightsFocus, setRightsFocus] = useState(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  // Auth bootstrap (T-0258): authReady gates the first render until we know the
  // mode; authConfig holds it; currentUser is the active identity (dev-user in
  // dev mode, keycloak user in keycloak mode). authError surfaces login errors.
  const [authReady, setAuthReady] = useState(false);
  const [authConfig, setAuthConfig] = useState(() => getAuthConfig());
  const [currentUser, setCurrentUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  // One-shot auth bootstrap: learn the mode, then in keycloak mode process any
  // OIDC redirect callback and adopt an existing session; in dev mode adopt the
  // stored dev-user. Fail-safe to dev on config errors (see loadAuthConfig).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadAuthConfig();
      if (cancelled) return;
      setAuthConfig(cfg);
      if (isKeycloakMode(cfg)) {
        try {
          const fromCallback = await kc.handleRedirectCallback(cfg.keycloak);
          if (cancelled) return;
          setCurrentUser(fromCallback || kc.getKeycloakUser());
        } catch (err) {
          if (cancelled) return;
          setAuthError(err && err.message ? err.message : 'Ошибка входа');
          setCurrentUser(kc.isAuthenticated() ? kc.getKeycloakUser() : null);
        }
      } else {
        setCurrentUser(getDevUser());
      }
      if (!cancelled) setAuthReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const keycloak = isKeycloakMode(authConfig);

  // Dev-mode login: persist the picked dev-user. Keycloak-mode login: kick off
  // the OIDC redirect (the page navigates away; nothing else to do here).
  const handleLogin = (user) => {
    if (keycloak) {
      setAuthError(null);
      kc.login(authConfig.keycloak);
      return;
    }
    setDevUser(user);
    setCurrentUser(user);
  };

  const handleLogout = () => {
    if (keycloak) {
      kc.logout(authConfig.keycloak); // clears session + redirects to KC logout
      return;
    }
    clearDevUser();
    setCurrentUser(null);
  };

  // Wait until we know the auth mode before deciding what to render.
  if (!authReady) {
    return (
      <div className="chs-login-screen">
        <div className="chs-login-loading"><p>Загрузка…</p></div>
      </div>
    );
  }

  // Gate: if not logged in, show the mode-appropriate login screen.
  if (!currentUser) {
    return <LoginScreen onLogin={handleLogin} keycloak={keycloak} error={authError} />;
  }

  const devUser = currentUser;

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
          {NAV.map((grp) => {
            const items = visibleItems(grp);
            if (items.length === 0) return null;
            return (
              <div className="chs-nav__group" key={grp.group}>
                <div className="chs-nav__grouplabel">{grp.group}</div>
                {items.map((item) => (
                  <NavItem key={item.id} item={item} active={screen === item.id} />
                ))}
              </div>
            );
          })}
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
        <Topbar screen={screen} theme={theme} setTheme={setTheme} onLaunchProcess={() => setLaunchOpen(true)} />
        {screen === "rights" && <RightsSubTabs />}
        <div className="chs-screen">
          <Routes>
            <Route path="/" element={<InboxScreen />} />
            <Route path="/apps" element={<AppsScreen />} />
            {/* T-0266: application field-constructor (registry_def editor) */}
            <Route path="/app-schema/:appId" element={<AppSchemaScreen />} />
            {/* T-0267: application records list + schema-driven create-record form */}
            <Route path="/app-records/:appId" element={<AppRecordsScreen />} />
            <Route path="/inbox" element={<InboxScreen />} />
            <Route path="/org" element={<OrgScreen onOpenRights={openRights} />} />
            <Route path="/processes" element={<ProcessesScreen launchOpen={launchOpen} onLaunchClose={() => setLaunchOpen(false)} />} />
            {/* T-0271: agents list + hire + LLM secret-handle bind */}
            <Route path="/agents" element={<AgentsScreen />} />
            <Route path="/notifications" element={<NotificationsScreen />} />
            <Route path="/audit" element={<AuditScreen />} />
            <Route path="/rights" element={<RightsScreen initialRole={rightsFocus} />} />
            <Route path="/rights/intents" element={<IntentsScreen />} />
            <Route path="/rights/editor" element={<RoleEditorScreen />} />
            <Route path="/rights/criticality" element={<CriticalityScreen />} />
            <Route path="/rights/sod" element={<SoDScreen />} />
            <Route path="/rights/trail" element={<GrantTrailScreen />} />
            <Route path="/forms" element={<FormsScreen theme={theme} />} />
            {/* T-0096: real bpmn-js editor — /processes/:id/edit */}
            <Route path="/processes/:id/edit" element={<ProcessEditorScreen />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default AppShell;
