/* ============================================================================
   CHOROS — ra-shell.jsx
   Оболочка раздела «Права и доступ». Наследует каркас продукта:
   левая навигация + топбар + переключатель тем. Вторичные вкладки — четыре
   экрана раздела. Icon берётся из shell.jsx.
   ============================================================================ */

const { useState: useStateShell, useEffect: useEffectShell } = React;

const RA_NAV = [
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

const RA_TABS = [
  { id: "editor", label: "Редактор роли" },
  { id: "criticality", label: "Критичность · согласование" },
  { id: "sod", label: "Разделение обязанностей" },
  { id: "trail", label: "Журнал выдачи прав" },
];

function RA_ThemeToggle({ theme, setTheme }) {
  return (
    <div className="chs-theme-toggle" role="group" aria-label="Тема оформления">
      <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Icon name="moon" /> Тёмная</button>
      <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Icon name="sun" /> Светлая</button>
    </div>
  );
}

function RightsAdminShell() {
  const [theme, setTheme] = useStateShell(() => localStorage.getItem("chs-theme") || "dark");
  const [tab, setTab] = useStateShell(() => localStorage.getItem("chs-ra-tab") || "editor");

  useEffectShell(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("chs-theme", theme);
  }, [theme]);
  useEffectShell(() => { localStorage.setItem("chs-ra-tab", tab); }, [tab]);

  const tabMeta = RA_TABS.find((t) => t.id === tab) || RA_TABS[0];

  return (
    <div className="chs-shell" data-screen-label="Права и доступ">
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
          {RA_NAV.map((grp) => (
            <div className="chs-nav__group" key={grp.group}>
              <div className="chs-nav__grouplabel">{grp.group}</div>
              {grp.items.map((item) => (
                <button key={item.id} type="button" className="chs-navitem" aria-current={item.id === "rights" ? "true" : undefined} disabled={item.id !== "rights"} title={item.soon ? "Скоро" : item.label}>
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
              <span className="chs-crumbs__seg">Доступ</span>
              <span className="chs-crumbs__sep">/</span>
              <span className="chs-crumbs__seg">Права и доступ</span>
              <span className="chs-crumbs__sep">/</span>
              <span className="chs-crumbs__seg chs-crumbs__seg--cur">{tabMeta.label}</span>
            </nav>
          </div>
          <div className="chs-topbar__right">
            <RA_ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </header>

        {/* вторичные вкладки раздела */}
        <div className="chs-subtabs">
          {RA_TABS.map((t) => (
            <button key={t.id} type="button" className="chs-subtab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} data-screen-label={t.label}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="chs-screen">
          {tab === "editor" && <RoleEditorScreen />}
          {tab === "criticality" && <CriticalityScreen />}
          {tab === "sod" && <SoDScreen />}
          {tab === "trail" && <GrantTrailScreen />}
        </div>
      </main>
    </div>
  );
}

Object.assign(window, { RightsAdminShell });
