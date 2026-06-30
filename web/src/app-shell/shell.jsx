/* ============================================================================
   CHOROS — shell.jsx
   Оболочка: левая навигация, топбар, переключатель тем, роутинг.
   ============================================================================ */

import React, { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'react';
import { useNavigate, useLocation, Routes, Route, Navigate, Link } from 'react-router-dom';
import { Button, Modal, Tooltip, Popover, LoadingState, EmptyState } from '../components/components.jsx';
import { ToastProvider, useToastContext } from './toast-context.jsx';
import { Icon } from './icon.jsx';
import { getDevUser, clearDevUser, setDevUser, devHeaders } from './dev-auth.js';
import { resolveActiveTenant, resolveNavCapabilities, getNavCapabilities, clearNavCapabilities } from './active-tenant.js';
import { loadAuthConfig, getAuthConfig, isKeycloakMode } from './auth-mode.js';
import * as kc from './keycloak-auth.js';
import { NAV, ZONES, NAV_HOME, visibleItems, visibleZones, effectiveStatus } from './nav-config.js';
import { groupAppsBySection } from './nav-sections.js';
import LoginScreen from '../screens/screen-login.jsx';
import RegisterScreen from '../screens/screen-register.jsx';
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
import AssistantScreen from '../screens/screen-assistant.jsx';
// T-0382 (D5): LLM connection screen — per-tenant BYO LLM configuration.
import LlmConfigScreen from '../screens/screen-llm-config.jsx';
// T-0474 (E-AGENTS L2): named LLM connection-profile registry (list + create).
import LlmConnectionsScreen from '../screens/screen-llm-connections.jsx';
// T-0383 (D5/PD-6): assistant system prompt editor.
import AssistantPromptScreen from '../screens/screen-assistant-prompt.jsx';
// T-0435: DMN branch-rules editor — /processes/:processKey/branch-rules
import DmnEditorScreen from '../screens/screen-dmn-editor.jsx';
// T-0477 (E-AGENTS L5): Расход — LLM cost accounting screen.
import SpendScreen from '../screens/screen-spend.jsx';
import ReportsScreen from '../screens/screen-reports.jsx';
// T-0493: Аналитика процессов — цикл-тайм + нагрузка по исполнителям.
import ProcessAnalyticsScreen from '../screens/screen-process-analytics.jsx';
// T-0494: Операционный обзор — три сигнала в одной панели.
import OpsOverviewScreen from '../screens/screen-ops-overview.jsx';

export { Icon };

// T-0538: RIGHTS_TABS расщеплены на два жанра (§5).
// ACCESS — операционный просмотр грантов (пункт nav 'rights' / «Доступ»).
const ACCESS_TABS = [
  { id: "overview", label: "Обзор ролей", path: "/rights",       status: "live" },
  { id: "trail",    label: "Журнал",      path: "/rights/trail", status: "live" },
];
// REFERENCE — справочные конструкты (пункт nav 'reference' / «Справочники»).
const REFERENCE_TABS = [
  { id: "criticality", label: "Критичность",          path: "/rights/criticality", status: "live" },
  { id: "sod",         label: "SoD",                  path: "/rights/sod",         status: "live" },
  { id: "editor",      label: "Каталог ролей",         path: "/rights/editor",      status: "demo" },
  { id: "intents",     label: "Повседневные операции", path: "/rights/intents",     status: "live" },
];

// NAV is imported from ./nav-config.js

// SCREEN_META (T-0317 → T-0355 → T-0538): static [zone, leaf] crumb per top-level screen.
// T-0538: зоны обновлены на 4 новые (Работа/Конструктор/Наблюдаемость/Администрирование).
const SCREEN_META = {
  overview: { crumb: ["Обзор"] },
  // Конструктор
  apps:  { crumb: ["Конструктор", "Приложения"] },
  "app-schema": { crumb: ["Конструктор", "Приложения"] },
  "app-records": { crumb: ["Конструктор", "Приложения"] },
  // T-0482: «Формы задач» скрыт из nav; /forms доступен по прямой ссылке.
  forms:  { crumb: ["Конструктор", "Привязка форм"] },
  modeler: { crumb: ["Конструктор", "Модельер"] },
  assistant: { crumb: ["Конструктор", "Ассистент"] },
  // Работа
  inbox: { crumb: ["Работа", "Мои задачи"] },
  processes: { crumb: ["Работа", "Процессы"] },
  // Наблюдаемость
  notifications: { crumb: ["Наблюдаемость", "Уведомления"] },
  audit: { crumb: ["Наблюдаемость", "Аудит"] },
  "ops-overview": { crumb: ["Наблюдаемость", "Операционный обзор"] },
  spend: { crumb: ["Наблюдаемость", "Расход"] },
  reports: { crumb: ["Наблюдаемость", "Отчёты"] },
  "process-analytics": { crumb: ["Наблюдаемость", "Аналитика процессов"] },
  // Администрирование
  org:   { crumb: ["Администрирование", "Оргструктура"] },
  agents: { crumb: ["Администрирование", "Агенты"] },
  // T-0538: «Права и доступ» → «Доступ» (scope сужен после выноса справочников).
  rights: { crumb: ["Администрирование", "Доступ"] },
  // T-0538: Справочники — новая точка входа (id='reference', path=/rights/criticality).
  reference: { crumb: ["Администрирование", "Справочники"] },
  "llm-connections": { crumb: ["Администрирование", "LLM-соединения"] },
  "llm-config": { crumb: ["Администрирование", "LLM-подключение"] },
  "assistant-prompt": { crumb: ["Администрирование", "Промпт ассистента"] },
  // T-0435: branch-rules editor — маршрут /processes/:processKey/branch-rules
  // → «processes» → SCREEN_META.processes по умолчанию.
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

  // T-0538: /rights/* sub-routes для крошек — определяем жанр по пути.
  // reference-жанр: /rights/criticality, /rights/sod, /rights/editor, /rights/intents
  // access-жанр: /rights (точно), /rights/trail
  if (root === 'rights' && parts[1] && ['criticality', 'sod', 'editor', 'intents'].includes(parts[1])) {
    const tab = REFERENCE_TABS.find((t) => t.path === '/' + parts.join('/'));
    return [
      { label: 'Администрирование' },
      { label: 'Справочники', path: '/rights/criticality' },
      { label: tab ? tab.label : parts[1] },
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
      <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
        <Icon name="moon" /> Тёмная
      </button>
      <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
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
  // T-0355: support optional `path` override on nav items. Items that don't
  // map cleanly to '/' + id (e.g. Модельер → /processes/new/edit) set a
  // `path` in nav-config.js. All OTHER items continue to use '/' + id so
  // routes remain unchanged (the invariant from T-0317).
  const targetPath = item.path || '/' + item.id;
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
      type="button"
      className="chs-navitem"
      aria-current={active ? "true" : undefined}
      disabled={!clickable}
      onClick={clickable ? () => navigate(targetPath) : undefined}
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
 * T-0528: errors surfaced via push() toast instead of blocking window.alert().
 * @param {(input: object) => void} push — from useToastContext()
 */
async function downloadAuditLog(push) {
  try {
    const res = await fetch('/api/audit/export', { headers: devHeaders() });
    if (res.status === 401) {
      push({ tone: 'error', title: 'Сессия истекла', message: 'Войдите в систему снова.', duration: 0 });
      return;
    }
    if (!res.ok) {
      push({ tone: 'error', title: 'Ошибка экспорта', message: `Сервер вернул ${res.status}.`, duration: 0 });
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
    push({ tone: 'success', title: 'Лог экспортирован' });
  } catch {
    push({ tone: 'error', title: 'Не удалось экспортировать лог', duration: 0 });
  }
}

function Topbar({ screen, pathname }) {
  const { entities } = useContext(CrumbContext);
  const { push } = useToastContext();
  // T-0317: dynamic, param-aware crumbs (entity names injected, parents linkable).
  const crumb = buildCrumbs(pathname, entities);
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);

  const handleExportLog = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadAuditLog(push);
    } finally {
      setExporting(false);
    }
  };

  const right =
    screen === "inbox" ? (
      // T-0374 (B17): inbox no longer links to a generic process launcher.
      null
    ) : screen === "processes" ? (
      // T-0374 (B17): generic «Запустить процесс» runtime launcher dissolved.
      <Button
        variant="secondary"
        size="sm"
        glyph={<Icon name="plus" className="chs-btn__glyph" />}
        onClick={() => navigate('/processes/new/edit')}
        title="Открыть конструктор для нового процесса"
      >
        Новый процесс
      </Button>
    ) : screen === "org" ? (
      // T-0484: this topbar button was INERT — make it honest.
      // T-0529: replaced Tooltip-on-disabled (AT can't reach disabled) with
      // aria-disabled + visible helper span (В2 pattern).
      <>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled="true"
          aria-describedby="topbar-org-hint"
          onClick={(e) => e.preventDefault()}
          glyph={<Icon name="plus" className="chs-btn__glyph" />}
        >
          Исполнитель
        </Button>
        <span id="topbar-org-hint" className="chs-sr-only">
          Добавить исполнителя можно в панели оргструктуры слева. Доступно владельцу тенанта.
        </span>
      </>
    ) : screen === "audit" ? (
      // T-0138: download current instance audit log
      // T-0528: errors surfaced via toast; T-0530: busy-state anti-double-submit
      <Button variant="secondary" size="sm" loading={exporting} disabled={exporting} onClick={handleExportLog}>Экспорт лога</Button>
    ) : (screen === "rights" || screen === "reference") ? (
      // T-0484 / T-0538: «Доступ» и «Справочники» — нет export endpoint, честный disabled.
      // T-0529: replaced Tooltip-on-disabled with aria-disabled + sr-only reason (В2 pattern).
      <>
        <Button variant="secondary" size="sm" aria-disabled="true" aria-describedby="topbar-rights-export-hint"
          onClick={(e) => e.preventDefault()}>
          Экспорт прав
        </Button>
        <span id="topbar-rights-export-hint" className="chs-sr-only">Экспорт прав пока недоступен — функция в разработке.</span>
      </>
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
        {/* T-0538: ThemeToggle удалён из топбара → аккаунт-поповер в подвале сайдбара */}
      </div>
    </header>
  );
}

// T-0538 (F2 review): суб-таб-бар показывается для screen ∈ {rights, reference}.
// При rights → access-жанр [overview, trail]; при reference → reference-жанр [criticality, sod, editor, intents].
function RightsSubTabs({ genre }) {
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = genre === "reference" ? REFERENCE_TABS : ACCESS_TABS;
  const active = tabs.find((t) =>
    t.path === location.pathname ||
    (t.path !== "/rights" && location.pathname.startsWith(t.path))
  )?.id || tabs[0]?.id;
  return (
    <div className="chs-subtabs">
      {tabs.map((t) => (
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
/**
 * T-0539: palette destinations filtered by navSet capability.
 * Hidden items (it.hidden) and zone-gated items are excluded — skipping the
 * capability gate here would let users navigate to zones they can't see (bypass).
 * @param {object|null} navSet  NavCapabilitySet | null (fail-closed → only РАБОТА)
 */
function paletteDestinations(navSet) {
  const out = [];
  const visZones = visibleZones(navSet);
  for (const grp of NAV) {
    for (const item of visibleItems(grp)) { // compat path: hidden filter only
      if (!item.screen) continue;
      if (effectiveStatus(item) === "soon") continue;
      // T-0539: exclude items from zones not visible to this actor.
      if (item.zone && !visZones.includes(item.zone)) continue;
      // T-0539: ownerOnly ломтики — только genesis-owner.
      if (item.ownerOnly && !(navSet && navSet.isGenesisOwner)) continue;
      // T-0355: respect `item.path` override (e.g. Модельер → /processes/new/edit).
      out.push({ id: item.id, label: item.label, group: grp.group, icon: item.icon, path: item.path || "/" + item.id });
    }
  }
  return out;
}

function CommandPalette({ open, onClose, onGo, navSet }) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const dests = paletteDestinations(navSet);
  const q = query.trim().toLowerCase();
  const matches = q
    ? dests.filter((d) => d.label.toLowerCase().includes(q) || d.group.toLowerCase().includes(q))
    : dests;

  // Reset activeIdx when matches change
  useEffect(() => { setActiveIdx(0); }, [matches.length]);

  // Reset the query each time the palette opens, and focus the search input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Focus after the Modal's own focus-trap has run.
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  function onSubmit(e) {
    e.preventDefault();
    if (matches.length > 0) onGo(matches[activeIdx]?.path || matches[0].path);
  }

  // T-0529: A3 — keyboard arrow-key navigation for commandpalette listbox
  function onInputKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[activeIdx]) onGo(matches[activeIdx].path);
    }
  }

  const optionId = (i) => `chs-palette-opt-${i}`;

  return (
    <Modal open={open} onClose={onClose} title="Перейти к разделу" size="sm">
      <form className="chs-palette" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="chs-input chs-palette__input"
          placeholder="Найти раздел…"
          aria-label="Поиск раздела"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="chs-palette-list"
          aria-activedescendant={matches.length > 0 ? optionId(activeIdx) : undefined}
          aria-expanded={matches.length > 0}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <ul id="chs-palette-list" className="chs-palette__list" role="listbox" aria-label="Разделы">
          {matches.length === 0 && (
            <li className="chs-palette__empty" role="presentation">
              <EmptyState compact title="Ничего не найдено" />
            </li>
          )}
          {matches.map((d, i) => (
            <li key={d.id} id={optionId(i)} role="option" aria-selected={i === activeIdx}>
              <button
                type="button"
                className={`chs-palette__item${i === activeIdx ? ' chs-palette__item--active' : ''}`}
                onClick={() => onGo(d.path)}
                tabIndex={-1}
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

/**
 * T-0538: аккаунт-поповер в подвале сайдбара.
 * Пункты: Профиль/Мои настройки=скоро, Уведомления, Тема, Сменить организацию, Выйти.
 * Строится на kit Popover (Esc, клик-вне). Триггер — настоящий <button> с aria-haspopup.
 * «скоро»/honest-disabled — aria-disabled + видимая причина (не native title).
 */
function AccountMenu({ user, theme, setTheme, onLogout, onNavigate, orgLabel }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const go = (path) => {
    setOpen(false);
    navigate(path);
    if (onNavigate) onNavigate(path);
  };

  const glyph = user.name.split(' ').slice(0, 2).map((w) => w[0]).join('');

  const trigger = (
    <button
      type="button"
      className="chs-nav__account-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="chs-nav__userglyph">{glyph}</div>
      <div className="chs-nav__userinfo">
        <span className="chs-nav__username">{user.name}</span>
        <span className="chs-nav__userrole">{user.position}</span>
      </div>
      <Icon name="chevron-up" className={`chs-nav__account-chevron ${open ? "chs-nav__account-chevron--open" : ""}`} />
    </button>
  );

  return (
    <div className="chs-nav__foot">
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        trigger={trigger}
        placement="top"
        align="start"
        className="chs-nav__account-popover-root"
      >
        <div className="chs-account-menu" role="menu" aria-label="Меню аккаунта">
          {/* Карточка — заголовок (не кликабельная навигация, только идентичность) */}
          <div className="chs-account-menu__header" aria-hidden="true">
            <div className="chs-nav__userglyph chs-nav__userglyph--lg">{glyph}</div>
            <div>
              <div className="chs-account-menu__name">{user.name}</div>
              <div className="chs-account-menu__org">{orgLabel || "—"}</div>
            </div>
          </div>

          <div className="chs-account-menu__divider" />

          {/* Профиль — скоро */}
          <button
            type="button"
            role="menuitem"
            className="chs-account-menu__item chs-account-menu__item--disabled"
            aria-disabled="true"
          >
            <Icon name="org" className="chs-account-menu__icon" />
            <span>Профиль</span>
            <span className="chs-account-menu__badge">скоро</span>
          </button>
          <span className="chs-account-menu__reason">Страница профиля в разработке</span>

          {/* Мои настройки — скоро */}
          <button
            type="button"
            role="menuitem"
            className="chs-account-menu__item chs-account-menu__item--disabled"
            aria-disabled="true"
          >
            <Icon name="apps" className="chs-account-menu__icon" />
            <span>Мои настройки</span>
            <span className="chs-account-menu__badge">скоро</span>
          </button>
          <span className="chs-account-menu__reason">Пользовательские настройки в разработке</span>

          {/* Уведомления */}
          <button
            type="button"
            role="menuitem"
            className="chs-account-menu__item"
            onClick={() => go('/notifications')}
          >
            <Icon name="bell" className="chs-account-menu__icon" />
            <span>Уведомления</span>
          </button>

          {/* Тема — inline-переключатель */}
          <div className="chs-account-menu__item chs-account-menu__item--theme" role="group" aria-label="Тема оформления">
            <Icon name="moon" className="chs-account-menu__icon" />
            <span>Тема</span>
            <div className="chs-theme-toggle chs-theme-toggle--compact">
              <button
                type="button"
                aria-pressed={theme === "dark"}
                className={theme === "dark" ? "chs-theme-toggle__btn--active" : ""}
                onClick={() => setTheme("dark")}
              >
                <Icon name="moon" /> Тёмная
              </button>
              <button
                type="button"
                aria-pressed={theme === "light"}
                className={theme === "light" ? "chs-theme-toggle__btn--active" : ""}
                onClick={() => setTheme("light")}
              >
                <Icon name="sun" /> Светлая
              </button>
            </div>
          </div>

          {/* Сменить организацию — honest-disabled (silo-only deploy сейчас) */}
          <button
            type="button"
            role="menuitem"
            className="chs-account-menu__item chs-account-menu__item--disabled"
            aria-disabled="true"
          >
            <Icon name="org" className="chs-account-menu__icon" />
            <span>Сменить организацию</span>
          </button>
          <span className="chs-account-menu__reason">Несколько организаций недоступно в вашем тарифе</span>

          <div className="chs-account-menu__divider" />

          {/* Выйти */}
          <button
            type="button"
            role="menuitem"
            className="chs-account-menu__item chs-account-menu__item--danger"
            onClick={() => { setOpen(false); onLogout(); }}
          >
            <Icon name="logout" className="chs-account-menu__icon" />
            <span>Выйти</span>
          </button>
        </div>
      </Popover>
    </div>
  );
}

function AppShell() {
  const [theme, setThemeState] = useState(() => localStorage.getItem("chs-theme") || "light");
  const [rightsFocus, setRightsFocus] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false); // T-0307: ⌘K command palette
  // Auth bootstrap (T-0258): authReady gates the first render until we know the
  // mode; authConfig holds it; currentUser is the active identity (dev-user in
  // dev mode, keycloak user in keycloak mode). authError surfaces login errors.
  const [authReady, setAuthReady] = useState(false);
  const [orgLabel, setOrgLabel] = useState(""); // resolved tenant label for the sidebar
  // T-0539: nav-capability set — drives zone/item visibility (fail-closed: null → only РАБОТА).
  const [navCaps, setNavCaps] = useState(null);
  // T-0540: приложения тенанта для динамических секций зоны РАБОТА.
  // Тянется отдельно от screen-apps (сайдбар=long-lived; экран=монтируется/демонтируется).
  const [navApps, setNavApps] = useState([]);
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
          if (fromCallback) {
            // Fresh login just completed (OIDC code→token exchange).
            setCurrentUser(fromCallback);
          } else if (kc.isAuthenticated()) {
            // Stored session with a still-valid access token.
            setCurrentUser(kc.getKeycloakUser());
          } else {
            // No session, or the access token expired. Adopting the stored user
            // here (as before) rendered the app with a DEAD token → every
            // protected API call 401'd while the gate thought we were logged in.
            // Try a silent refresh; on failure tryRefresh clears the stale
            // session so the gate falls through to the login screen.
            const refreshed = await kc.tryRefresh(cfg.keycloak);
            if (cancelled) return;
            setCurrentUser(refreshed || null);
          }
        } catch (err) {
          if (cancelled) return;
          setAuthError(err && err.message ? err.message : 'Ошибка входа');
          setCurrentUser(kc.isAuthenticated() ? kc.getKeycloakUser() : null);
        }
      } else {
        setCurrentUser(getDevUser());
      }
      // Resolve the caller's REAL tenant (server-derived from identity) so every
      // screen sends the correct x-tenant-id instead of the hardcoded seed tenant.
      // Failure is non-fatal: active-tenant.js keeps the legacy fallback.
      try {
        const resolved = await resolveActiveTenant();
        if (!cancelled && resolved && resolved.tenant) {
          const t = resolved.tenant;
          const n = Number(t.memberCount);
          setOrgLabel(
            t.displayName
              ? `${t.displayName}${Number.isFinite(n) ? ` · ${n} исп.` : ""}`
              : "",
          );
        }
      } catch {
        /* non-fatal */
      }
      // T-0539: resolve nav-capability set — drives zone/item visibility.
      // Runs after tenant resolution. Fail-closed: null → only РАБОТА (visibleZones default).
      try {
        const caps = await resolveNavCapabilities();
        if (!cancelled) setNavCaps(caps || null);
      } catch {
        /* fail-closed: navCaps stays null → only РАБОТА */
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
  // T-0538: alias for readability in zone/subtab logic below.
  const root = screen;

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
        const apps = data.applications || [];
        if (!cancelled) setNavApps(apps); // T-0540: кэш приложений для сайдбара
        const found = apps.find((a) => a.id === crumbAppId);
        if (found && found.display_name && !cancelled) {
          setCrumbEntity(`app:${crumbAppId}`, found.display_name);
        }
      } catch { /* crumb name is cosmetic — keep the id fallback */ }
    })();
    return () => { cancelled = true; };
  }, [currentUser, crumbAppId, crumbEntities, setCrumbEntity]);

  // T-0540: загрузка приложений для нав-секций зоны РАБОТА при смене пользователя.
  // Запускается при authReady+currentUser, но только если crumb-эффект не запустился первым.
  // Обновляется также при переходе на экран /apps (invalidation hint через location).
  useEffect(() => {
    if (!currentUser) { setNavApps([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/applications', { headers: devHeaders() });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setNavApps(Array.isArray(data.applications) ? data.applications : []);
      } catch { /* non-fatal: нет приложений → только inbox/processes */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, location.pathname === '/apps' ? location.pathname : null]);

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
    clearNavCapabilities(); // T-0539: clear capability cache on logout
    setNavCaps(null);
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
        <div className="chs-login-loading">
          <LoadingState label="Инициализация…" />
        </div>
      </div>
    );
  }

  // Gate: if not logged in, show the mode-appropriate login screen.
  // /register is a public pre-auth route — serve it before the login gate.
  if (!currentUser) {
    if (window.location.pathname === '/register') {
      return (
        <RegisterScreen
          onLogin={() => { kc.login(authConfig.keycloak); }}
          keycloakConfig={authConfig.keycloak || null}
        />
      );
    }
    return <LoginScreen onLogin={handleLogin} keycloak={keycloak} error={authError} />;
  }

  const devUser = currentUser;

  return (
    <ToastProvider>
    <CrumbContext.Provider value={crumbCtx}>
    <div className="chs-shell">
      <aside className="chs-nav">
        <div className="chs-nav__brand">
          <div className="chs-nav__logo" />
          <div className="chs-nav__brandtext">
            <span className="chs-nav__name">Choros</span>
            <span className="chs-nav__org">{orgLabel || "—"}</span>
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
          navSet={navCaps}
        />

        <div className="chs-nav__scroll">
          {/* T-0538: 4-zone IA.
              1. NAV_HOME («Обзор») — одиночный пункт без заголовка зоны.
              2. ZONES[0..3] — РАБОТА · КОНСТРУКТОР · НАБЛЮДАЕМОСТЬ · АДМИНИСТРИРОВАНИЕ.
              Каждая зона: заголовок-разделитель + пункты (c подгруппами в admin).
              Визуальный разделитель (chs-nav__space-divider) перед каждой зоной. */}

          {/* Home: «Обзор» без заголовка */}
          <div className="chs-nav__group">
            <NavItem
              item={NAV_HOME}
              active={screen === NAV_HOME.id}
            />
          </div>

          {/* Зоны */}
          {/* T-0539: capability-filter — только зоны из navCaps.zones (fail-closed: null → ['work']) */}
          {ZONES.map((zone) => {
            // Zone-level capability gate (T-0539): скрываем зону если не в visibleZones.
            if (!visibleZones(navCaps).includes(zone.id)) return null;
            // Item-level filter: hidden + ownerOnly (T-0538/T-0409).
            const items = visibleItems(zone.id, navCaps);
            if (items.length === 0) return null;

            // Для зоны admin — группируем пункты по subgroup.
            // Для зоны work — плоский список + динамические секции приложений (T-0540).
            // Для остальных зон — плоский список.
            const renderZoneItems = () => {
              if (zone.id === "work") {
                // Фиксированные пункты (inbox, processes) — из nav-config.
                const fixedItems = items.map((item) => (
                  <NavItem key={item.id} item={item} active={screen === item.id} />
                ));
                // T-0540: динамические секции из app.section-данных.
                // Видимость: groupAppsBySection работает поверх навApps, которые
                // уже отфильтрованы RLS / capability-фильтром T-0539 на сервере.
                const navSections = groupAppsBySection(navApps);
                const sectionItems = navSections.map((sec) => (
                  <div className="chs-nav__subgroup" key={sec.section}>
                    <div className="chs-nav__subgrouplabel">{sec.section}</div>
                    {sec.apps.map((app) => {
                      const appPath = `/app-records/${app.id}`;
                      const isActive = location.pathname === appPath;
                      return (
                        <button
                          key={app.id}
                          type="button"
                          className="chs-navitem"
                          aria-current={isActive ? "true" : undefined}
                          onClick={() => navigate(appPath)}
                        >
                          <Icon name="apps" className="chs-navitem__icon" />
                          <span className="chs-navitem__label">{app.display_name}</span>
                        </button>
                      );
                    })}
                  </div>
                ));
                return [...fixedItems, ...sectionItems];
              }

              if (zone.id !== "admin") {
                return items.map((item) => {
                  const isActive = item.path
                    // Модельер (path=/processes/new/edit): активен при /edit в pathname.
                    ? (item.id === "modeler" ? location.pathname.endsWith('/edit') : location.pathname === item.path)
                    : screen === item.id;
                  return <NavItem key={item.id} item={item} active={isActive} />;
                });
              }
              // Admin: сгруппировать по subgroup
              const subgroups = [];
              const seen = new Set();
              for (const item of items) {
                const sg = item.subgroup || "";
                if (!seen.has(sg)) { seen.add(sg); subgroups.push(sg); }
              }
              return subgroups.map((sg) => {
                const sgItems = items.filter((i) => (i.subgroup || "") === sg);
                // Подгруппу с 1+ пунктами показываем с мини-заголовком, если группа не пустая.
                return (
                  <div className="chs-nav__subgroup" key={sg}>
                    {sg && <div className="chs-nav__subgrouplabel">{sg}</div>}
                    {sgItems.map((item) => {
                      // T-0538: активность admin-пунктов с тонкой логикой /rights/*.
                      // 'reference' (path=/rights/criticality): активен когда на reference-жанре.
                      // 'rights' (no path): активен ТОЛЬКО на access-жанре (/rights, /rights/trail),
                      //   но НЕ на reference-жанре (/rights/criticality|sod|editor|intents).
                      // Остальные: path-точное совпадение ИЛИ screen-id.
                      const isReferenceSubRoute = root === "rights" && ['criticality', 'sod', 'editor', 'intents'].includes(pathParts[1]);
                      let itemActive;
                      if (item.id === "reference") {
                        itemActive = isReferenceSubRoute || location.pathname === (item.path || '/' + item.id);
                      } else if (item.id === "rights") {
                        // access-жанр: /rights или /rights/trail, но НЕ reference sub-routes
                        itemActive = root === "rights" && !isReferenceSubRoute;
                      } else if (item.path) {
                        itemActive = location.pathname === item.path;
                      } else {
                        itemActive = screen === item.id;
                      }
                      return (
                        <NavItem
                          key={item.id}
                          item={item}
                          active={itemActive}
                        />
                      );
                    })}
                  </div>
                );
              });
            };

            return (
              <React.Fragment key={zone.id}>
                <div className="chs-nav__space-divider" aria-hidden="true" />
                <div className="chs-nav__group">
                  <div className="chs-nav__grouplabel">{zone.label}</div>
                  {renderZoneItems()}
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* T-0538: аккаунт-поповер заменяет статичный подвал + плавающую «Выйти» */}
        <AccountMenu
          user={devUser}
          theme={theme}
          setTheme={setTheme}
          onLogout={handleLogout}
          orgLabel={orgLabel}
        />
      </aside>

      <main className="chs-main">
        <Topbar screen={screen} pathname={location.pathname} />
        {/* T-0538 (F2): суб-таб-бар для screen ∈ {rights, reference}.
            /rights и /rights/trail → access-жанр (обзор грантов + журнал).
            /rights/criticality|sod|editor|intents → reference-жанр (справочники).
            Примечание: 'reference' nav-id — path-override на /rights/criticality,
            поэтому screen будет 'rights' для всех /rights/* маршрутов. */}
        {root === "rights" && !['criticality','sod','editor','intents'].includes(pathParts[1]) && <RightsSubTabs genre="access" />}
        {root === "rights" && ['criticality','sod','editor','intents'].includes(pathParts[1]) && <RightsSubTabs genre="reference" />}
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
            <Route path="/processes" element={<ProcessesScreen />} />
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
            {/* T-0358: E17 Ассистент shell — треды-чаты с AI-агентом. LLM = T-0359/T-0360. */}
            <Route path="/assistant" element={<AssistantScreen />} />
            <Route path="/assistant/:threadId" element={<AssistantScreen />} />
            {/* T-0474 (E-AGENTS L2): named LLM connection-profile registry. */}
            <Route path="/llm-connections" element={<LlmConnectionsScreen />} />
            {/* T-0382 (D5): LLM connection screen — per-tenant BYO LLM configuration. */}
            <Route path="/llm-config" element={<LlmConfigScreen />} />
            {/* T-0383 (D5/PD-6): assistant system prompt editor. */}
            <Route path="/assistant-prompt" element={<AssistantPromptScreen />} />
            {/* T-0435: DMN branch-rules editor — scoped to a processKey. */}
            <Route path="/processes/:processKey/branch-rules" element={<DmnEditorScreen />} />
            {/* T-0477 (E-AGENTS L5): Расход — LLM cost accounting screen. */}
            <Route path="/spend" element={<SpendScreen />} />
            <Route path="/reports" element={<ReportsScreen />} />
            {/* T-0493: Аналитика процессов — цикл-тайм + нагрузка по исполнителям. */}
            <Route path="/process-analytics" element={<ProcessAnalyticsScreen />} />
            {/* T-0494: Операционный обзор — три сигнала (процессы + расход + отчёты) */}
            <Route path="/ops-overview" element={<OpsOverviewScreen />} />
          </Routes>
        </div>
      </main>
    </div>
    </CrumbContext.Provider>
    </ToastProvider>
  );
}

export default AppShell;
