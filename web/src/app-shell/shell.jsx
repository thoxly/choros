/* ============================================================================
   CHOROS — shell.jsx
   Оболочка: левая навигация, топбар, переключатель тем, роутинг.
   ============================================================================ */

import React, { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate, Link } from 'react-router-dom';
import { Button, Modal, Tooltip } from '../components/components.jsx';
import { Icon } from './icon.jsx';
import { getDevUser, clearDevUser, setDevUser, devHeaders } from './dev-auth.js';
import { loadAuthConfig, getAuthConfig, isKeycloakMode } from './auth-mode.js';
import * as kc from './keycloak-auth.js';
import { NAV, visibleItems, effectiveStatus } from './nav-config.js';
import LoginScreen from '../screens/screen-login.jsx';
import OverviewScreen from '../screens/screen-overview.jsx';
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
import RecordDetailScreen from '../screens/screen-record-detail.jsx';

export { Icon };

const RIGHTS_TABS = [
  { id: "overview",    label: "Обзор ролей",       path: "/rights",              status: "live" },
  { id: "intents",     label: "Повседневные операции",  path: "/rights/intents",  status: "live" },
  { id: "editor",      label: "Редактор роли",      path: "/rights/editor",       status: "demo" },
  { id: "criticality", label: "Критичность",        path: "/rights/criticality",  status: "demo" },
  { id: "sod",         label: "SoD",                path: "/rights/sod",          status: "demo" },
  { id: "trail",       label: "Журнал",             path: "/rights/trail",        status: "live" },
];

// NAV is imported from ./nav-config.js

// SCREEN_META (T-0317): static [group, leaf] crumb per top-level screen. Group
// labels track the re-sectioned IA in nav-config.js (4 разделов). This is the
// BASE crumb; the dynamic builder below extends it for deep, param-aware routes
// (app field-editor, records, record detail) by injecting entity names.
const SCREEN_META = {
  overview: { crumb: ["Обзор"] },
  apps:  { crumb: ["Конструктор", "Приложения"] },
  "app-schema": { crumb: ["Конструктор", "Приложения"] },
  "app-records": { crumb: ["Конструктор", "Приложения"] },
  inbox: { crumb: ["Работа", "Мои задачи"] },
  org:   { crumb: ["Исполнители и доступ", "Оргструктура"] },
  processes: { crumb: ["Работа", "Процессы"] },
  agents: { crumb: ["Исполнители и доступ", "Агенты"] },
  notifications: { crumb: ["Наблюдаемость", "Уведомления"] },
  audit: { crumb: ["Наблюдаемость", "Аудит"] },
  rights: { crumb: ["Исполнители и доступ", "Права и доступ"] },
  forms:  { crumb: ["Конструктор", "Формы задач"] },
};

/**
 * T-0317: lightweight crumb context. Deep routes (/app-schema/:appId,
 * /app-records/:appId, /apps/:appId/records/:id) need an entity's human name
 * (e.g. application display_name) that only the screen has fetched. Rather than
 * lift every fetch into the shell, a screen calls `setCrumbEntity('app:'+id, name)`
 * once it resolves the name; the breadcrumb builder reads it. If a screen hasn't
 * registered a name yet, the builder falls back to a short id — the crumb stays
 * correct (right group, clickable parents), just less pretty for a tick.
 *
 * @typedef {{ entities: Record<string,string>, setCrumbEntity: (key: string, label: string) => void }} CrumbCtx
 */
const CrumbContext = React.createContext(/** @type {CrumbCtx} */ ({ entities: {}, setCrumbEntity: () => {} }));

/** Shorten a raw id for a fallback crumb (no name yet): keep it readable. */
function shortId(id) {
  if (!id) return '';
  return id.length > 10 ? id.slice(0, 8) + '…' : id;
}

/**
 * T-0317: build clickable, param-aware breadcrumb segments for the current route.
 * Returns `[{ label, path? }]` — segments with a `path` render as up-nav links;
 * the last (current) segment never links. Deep routes inject entity names from
 * the crumb context (application display_name, record id).
 *
 * Fixes the record-detail bug: `/apps/:appId/records/:id` previously fell back to
 * the bare «Приложения» crumb (pathParts[0] === "apps" → SCREEN_META.apps). It now
 * reads «Конструктор / Приложения / «<app>» / Данные / Запись <id>».
 *
 * @param {string} pathname
 * @param {Record<string,string>} entities  resolved entity labels by key
 * @returns {{ label: string, path?: string }[]}
 */
function buildCrumbs(pathname, entities) {
  const parts = pathname.split('/').filter(Boolean);
  const root = parts[0] || 'overview';
  const appName = (appId) => entities[`app:${appId}`] || shortId(appId);

  // Constructor deep routes: /app-schema/:appId, /app-records/:appId,
  // /apps/:appId/records/:id — all hang under Конструктор / Приложения / «<app>».
  if (root === 'app-schema' && parts[1]) {
    const appId = parts[1];
    return [
      { label: 'Конструктор' },
      { label: 'Приложения', path: '/apps' },
      { label: `«${appName(appId)}»`, path: `/app-records/${appId}` },
      { label: 'Поля' },
    ];
  }
  if (root === 'app-records' && parts[1]) {
    const appId = parts[1];
    return [
      { label: 'Конструктор' },
      { label: 'Приложения', path: '/apps' },
      { label: `«${appName(appId)}»` },
      { label: 'Данные' },
    ];
  }
  if (root === 'apps' && parts[1] && parts[2] === 'records' && parts[3]) {
    const appId = parts[1];
    const recId = parts[3];
    return [
      { label: 'Конструктор' },
      { label: 'Приложения', path: '/apps' },
      { label: `«${appName(appId)}»`, path: `/app-records/${appId}` },
      { label: 'Данные', path: `/app-records/${appId}` },
      { label: `Запись ${shortId(recId)}` },
    ];
  }

  // Default: static crumb from SCREEN_META for top-level screens. A single-
  // segment crumb (home «Обзор») renders one current segment; a [group, leaf]
  // crumb renders a non-clickable group + current leaf. Unknown routes fall back
  // to the Обзор home.
  const meta = SCREEN_META[root] || SCREEN_META.overview;
  return meta.crumb.map((label) => ({ label }));
}

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
  // T-0307 (audit #5): the `count` on a nav item is a STATIC seed in
  // nav-config — it does NOT come from the section's live content (e.g. nav
  // shows «Процессы 7» while the page lists a different number, «Инбокс 18»
  // while the inbox tabs fetch their own counts from /api/inbox). A badge that
  // contradicts the page it points to is worse than no badge, so we don't
  // render these seed counts. Honest, content-derived counts live inside the
  // screens (inbox tab counts, rights rail count), which remain the source of
  // truth. Re-introduce a sidebar count only when it is wired to the same feed.
  // The visible «демо»/«скоро» word IS the honest status label; an aria-label
  // spells out the meaning for assistive tech. We do NOT nest a focusable kit
  // Tooltip trigger inside this <button> (that is invalid nested-interactive
  // markup) — the kit Tooltip is applied on the rights sub-tab demo badge,
  // which sits OUTSIDE its button and can host a tooltip cleanly (T-0307 #5).
  const badge =
    status === "demo" ? <span className="chs-navitem__demo" aria-label="демо — данные иллюстративные">демо</span> :
    isSoon ? <span className="chs-navitem__soon" aria-label="скоро — раздел ещё не готов">скоро</span> : null;
  return (
    <button
      className="chs-navitem"
      aria-current={active ? "true" : undefined}
      disabled={!clickable}
      onClick={() => clickable && navigate('/' + item.id)}
    >
      <Icon name={item.icon} className="chs-navitem__icon" />
      <span className="chs-navitem__label">{item.label}</span>
      {badge}
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

function Topbar({ screen, pathname, theme, setTheme, onLaunchProcess }) {
  const { entities } = useContext(CrumbContext);
  // T-0317: dynamic, param-aware crumbs (entity names injected, parents linkable).
  const crumb = buildCrumbs(pathname, entities);
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
        <nav className="chs-crumbs" aria-label="Хлебные крошки">
          {crumb.map((seg, i) => {
            const isLast = i === crumb.length - 1;
            return (
              <React.Fragment key={i}>
                {i > 0 && <span className="chs-crumbs__sep" aria-hidden="true">/</span>}
                {seg.path && !isLast ? (
                  // Parent segment → clickable up-nav (real route, kit link styling).
                  <Link className="chs-crumbs__seg chs-crumbs__seg--link" to={seg.path}>
                    {seg.label}
                  </Link>
                ) : (
                  <span
                    className={`chs-crumbs__seg ${isLast ? "chs-crumbs__seg--cur" : ""}`}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {seg.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
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
        // The «демо» badge is rendered as a sibling of the button (not nested
        // inside it) so the kit Tooltip can wrap it without putting a focusable
        // tooltip-trigger inside an interactive <button> (invalid markup).
        // T-0307 #5: replaces the silent title= demo hint with a real Tooltip.
        <span className="chs-subtab-wrap" key={t.id}>
          <button
            type="button"
            className="chs-subtab"
            aria-selected={active === t.id}
            onClick={() => navigate(t.path)}
            data-screen-label={t.label}
          >
            {t.label}
          </button>
          {t.status === "demo" && (
            <Tooltip label="Демо — данные иллюстративные (mock)" placement="bottom">
              <span className="chs-subtab__demo">демо</span>
            </Tooltip>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * T-0307 (audit #8): command palette for ⌘K. Lists the real, navigable product
 * sections (every NAV item that has a screen and is not «soon»), each with its
 * breadcrumb group so the destination reads honestly. Type-to-filter; Enter /
 * click navigates. Built on the kit Modal (focus-trap, Esc, scroll-lock,
 * overlay via tokens — principles.md §4) — no hand-rolled overlay, no dead
 * control. Destinations are derived from the SAME nav-config source the sidebar
 * uses, so the palette can never drift from the live navigation.
 */
function paletteDestinations() {
  const out = [];
  for (const grp of NAV) {
    for (const item of visibleItems(grp)) {
      if (!item.screen) continue;
      if (effectiveStatus(item) === "soon") continue;
      out.push({ id: item.id, label: item.label, group: grp.group, icon: item.icon, path: "/" + item.id });
    }
  }
  return out;
}

function CommandPalette({ open, onClose, onGo }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const dests = paletteDestinations();
  const q = query.trim().toLowerCase();
  const matches = q
    ? dests.filter((d) => d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q))
    : dests;

  // Reset the query each time the palette opens, and focus the search input.
  useEffect(() => {
    if (open) {
      setQuery("");
      // Focus after the Modal's own focus-trap has run.
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  function onSubmit(e) {
    e.preventDefault();
    if (matches.length > 0) onGo(matches[0].path);
  }

  return (
    <Modal open={open} onClose={onClose} title="Перейти к разделу" size="sm">
      <form className="chs-palette" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="chs-input chs-palette__input"
          placeholder="Найти раздел…"
          aria-label="Поиск раздела"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="chs-palette__list" role="listbox" aria-label="Разделы">
          {matches.length === 0 && (
            <li className="chs-palette__empty" role="presentation">Ничего не найдено</li>
          )}
          {matches.map((d) => (
            <li key={d.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="chs-palette__item"
                onClick={() => onGo(d.path)}
              >
                <Icon name={d.icon} className="chs-palette__icon" />
                <span className="chs-palette__label">{d.label}</span>
                <span className="chs-palette__group">{d.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </form>
    </Modal>
  );
}

function AppShell() {
  const [theme, setThemeState] = useState(() => localStorage.getItem("chs-theme") || "light");
  const [rightsFocus, setRightsFocus] = useState(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false); // T-0307: ⌘K command palette
  // Auth bootstrap (T-0258): authReady gates the first render until we know the
  // mode; authConfig holds it; currentUser is the active identity (dev-user in
  // dev mode, keycloak user in keycloak mode). authError surfaces login errors.
  const [authReady, setAuthReady] = useState(false);
  const [authConfig, setAuthConfig] = useState(() => getAuthConfig());
  const [currentUser, setCurrentUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  // T-0317: resolved crumb entity labels (e.g. app:<id> → display_name), filled
  // by screens via useCrumbEntity once they fetch the name. Stable setter so the
  // registering effect doesn't re-run; idempotent to avoid render loops.
  const [crumbEntities, setCrumbEntities] = useState({});
  const setCrumbEntity = useCallback((key, label) => {
    setCrumbEntities((prev) => (prev[key] === label ? prev : { ...prev, [key]: label }));
  }, []);
  const crumbCtx = useMemo(
    () => ({ entities: crumbEntities, setCrumbEntity }),
    [crumbEntities, setCrumbEntity],
  );
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

  // Derive current screen from pathname. T-0326: the app now lands on the
  // orienting «Обзор» home, so the empty-path fallback is "overview" (the «/»
  // route redirects there anyway; this just keeps the active-nav highlight and
  // crumb honest during the redirect tick).
  const pathParts = location.pathname.split('/').filter(Boolean);
  const screen = pathParts[0] || "overview";

  // T-0317: which application id (if any) the current route is about. Deep
  // constructor routes carry it as the first param (/app-schema/:appId,
  // /app-records/:appId, /apps/:appId/records/:id) so the crumb can name it.
  const crumbAppId =
    (screen === "app-schema" || screen === "app-records") ? pathParts[1] :
    (screen === "apps" && pathParts[2] === "records") ? pathParts[1] :
    null;

  // Resolve the application display_name for the breadcrumb. Screens are out of
  // shell scope (and record-detail never fetches the app at all), so the shell
  // does the lookup itself: one cheap GET /api/applications, cached in the crumb
  // context. Best-effort — a failure just leaves the short-id fallback crumb.
  useEffect(() => {
    if (!currentUser || !crumbAppId) return;
    if (crumbEntities[`app:${crumbAppId}`]) return; // already resolved
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/applications', { headers: devHeaders() });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const found = (data.applications || []).find((a) => a.id === crumbAppId);
        if (found && found.display_name && !cancelled) {
          setCrumbEntity(`app:${crumbAppId}`, found.display_name);
        }
      } catch { /* crumb name is cosmetic — keep the id fallback */ }
    })();
    return () => { cancelled = true; };
  }, [currentUser, crumbAppId, crumbEntities, setCrumbEntity]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("chs-theme", theme);
  }, [theme]);

  // T-0307 (audit #8): ⌘K / Ctrl+K opens the command palette globally — the
  // sidebar hint is now a live affordance, not a dead <div>. Esc-to-close is
  // handled by the Modal's own focus-trap when it is open.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
    <CrumbContext.Provider value={crumbCtx}>
    <div className="chs-shell">
      <aside className="chs-nav">
        <div className="chs-nav__brand">
          <div className="chs-nav__logo" />
          <div className="chs-nav__brandtext">
            <span className="chs-nav__name">Choros</span>
            <span className="chs-nav__org">control-plane · 214 исп.</span>
          </div>
        </div>

        <button
          type="button"
          className="chs-nav__search"
          aria-label="Поиск по разделам (Cmd+K)"
          aria-haspopup="dialog"
          onClick={() => setPaletteOpen(true)}
        >
          <Icon name="search" />
          <span>Поиск разделов</span>
          <kbd>⌘K</kbd>
        </button>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onGo={(path) => { setPaletteOpen(false); navigate(path); }}
        />

        <div className="chs-nav__scroll">
          {NAV.map((grp) => {
            const items = visibleItems(grp);
            if (items.length === 0) return null;
            return (
              <div className="chs-nav__group" key={grp.group}>
                {/* T-0326: home group («Обзор») renders as a single top item
                    without a group label — a header over one choice is noise. */}
                {!grp.home && <div className="chs-nav__grouplabel">{grp.group}</div>}
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
        <Topbar screen={screen} pathname={location.pathname} theme={theme} setTheme={setTheme} onLaunchProcess={() => setLaunchOpen(true)} />
        {screen === "rights" && <RightsSubTabs />}
        <div className="chs-screen">
          <Routes>
            {/* T-0326: default landing → «Обзор» (orienting home), not the bare
                /apps list. /apps stays reachable from the tile CTA + nav. */}
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewScreen />} />
            <Route path="/apps" element={<AppsScreen />} />
            {/* T-0266: application field-constructor (registry_def editor) */}
            <Route path="/app-schema/:appId" element={<AppSchemaScreen />} />
            {/* T-0267: application records list + schema-driven create-record form */}
            <Route path="/app-records/:appId" element={<AppRecordsScreen />} />
            {/* T-0295: record detail view (read-only) */}
            <Route path="/apps/:appId/records/:id" element={<RecordDetailScreen />} />
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
    </CrumbContext.Provider>
  );
}

export default AppShell;
