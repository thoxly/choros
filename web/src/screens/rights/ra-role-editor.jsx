/* ============================================================================
   CHOROS — ra-role-editor.jsx
   ЭКРАН 1: РЕДАКТОР РОЛИ.
   Право = структурный ГРАНТ {ресурс · операция · охват}, НЕ список тумблеров.
   Прогрессивное раскрытие: ПРОСТОЙ (пресеты) / РАСШИРЕННЫЙ (полный грант).
   Scope-пикер по закрытой решётке: дерево узлов + теги + числовой интервал;
   охват можно только СУЖАТЬ относительно потолка роли (монотонное сужение).
   Блок «опиши роль словами → LLM предлагает гранты → ты подтверждаешь».
   ============================================================================ */

const { useState: useStateRE } = React;

/* потолок охвата роли — выше него выбор заблокирован */
const CEILING_ID = "fin"; // Финансы

function descendantsOf(id) {
  const out = new Set([id]);
  const walk = (nid) => (ORG_BY_ID[nid]?.children || []).forEach((c) => { out.add(c); walk(c); });
  walk(id);
  return out;
}
const IN_CEILING = descendantsOf(CEILING_ID);

/* --- начальные гранты редактируемой роли --- */
const INITIAL_GRANTS = [
  { uri: "mcp://ledger.invoices", ops: ["read", "write"], nodes: ["fin-approve"], tags: [], range: "" },
  { uri: "mcp://contracts.lookup", ops: ["read"], nodes: ["fin"], tags: ["contracts"], range: "" },
  { uri: "mcp://payments.initiate", ops: ["exec"], nodes: ["fin-approve"], tags: ["payments"], range: "≤ ₽50 000" },
];

/* --- предложения LLM (появляются после «предложить») --- */
const LLM_PROPOSALS = [
  { uri: "mcp://ocr.extract", name: "OCR-распознавание", ops: ["exec"], nodes: ["fin-approve"], tags: [], range: "", reason: "для извлечения сумм со сканов счетов" },
  { uri: "mcp://ledger.invoices", name: "Реестр счетов", ops: ["read"], nodes: ["fin-approve"], tags: [], range: "", reason: "чтение счёта перед согласованием" },
  { uri: "mcp://payments.refund", name: "Возвраты средств", ops: ["exec"], nodes: ["fin"], tags: ["payments"], range: "≤ ₽20 000", reason: "корректировка переплат", heavy: true },
];

/* ---------------- ScopePicker — закрытая решётка ---------------- */
function ScopePicker({ grant, onChange, onClose }) {
  const toggleNode = (id) => {
    if (!IN_CEILING.has(id)) return;
    const has = grant.nodes.includes(id);
    onChange({ ...grant, nodes: has ? grant.nodes.filter((n) => n !== id) : [...grant.nodes, id] });
  };
  const toggleTag = (id) => {
    const has = grant.tags.includes(id);
    onChange({ ...grant, tags: has ? grant.tags.filter((t) => t !== id) : [...grant.tags, id] });
  };
  return (
    <div className="chs-scopepick">
      <div className="chs-scopepick__lattice">
        {/* Дерево узлов */}
        <div className="chs-scopepick__col">
          <div className="chs-scopepick__collabel">Узлы оргструктуры<span className="chs-scopepick__ceil">потолок: Финансы</span></div>
          <div className="chs-scopepick__tree">
            {ORG_TREE.map((n) => {
              const inside = IN_CEILING.has(n.id);
              const checked = grant.nodes.includes(n.id);
              const isCeil = n.id === CEILING_ID;
              return (
                <button
                  key={n.id} type="button"
                  className={`chs-scopenode ${checked ? "chs-scopenode--on" : ""} ${!inside ? "chs-scopenode--locked" : ""} ${isCeil ? "chs-scopenode--ceil" : ""}`}
                  style={{ paddingLeft: `calc(var(--chs-space-4) + ${n.depth} * var(--chs-space-7))` }}
                  onClick={() => toggleNode(n.id)} disabled={!inside}
                  title={!inside ? "Выше потолка роли — сужение только вниз" : undefined}
                >
                  <span className={`chs-scopenode__box ${checked ? "chs-scopenode__box--on" : ""}`} />
                  <span className="chs-scopenode__label">{n.label}</span>
                  {isCeil && <span className="chs-scopenode__tag">потолок</span>}
                  {!inside && <span className="chs-scopenode__lock">заблокировано</span>}
                </button>
              );
            })}
          </div>
        </div>
        {/* Теги + интервал */}
        <div className="chs-scopepick__col">
          <div className="chs-scopepick__collabel">Теги охвата<span className="chs-scopepick__ceil">мультивыбор</span></div>
          <div className="chs-scopepick__tags">
            {SCOPE_TAGS.map((t) => (
              <button key={t.id} type="button" className={`chs-scopetagbtn ${grant.tags.includes(t.id) ? "chs-scopetagbtn--on" : ""}`} onClick={() => toggleTag(t.id)}>
                <span className="chs-scopetagbtn__hash">#</span>{t.label}
              </button>
            ))}
          </div>
          <div className="chs-scopepick__collabel" style={{ marginTop: "var(--chs-space-7)" }}>Числовой интервал<span className="chs-scopepick__ceil">потолок: ₽250 000</span></div>
          <div className="chs-scopepick__range">
            <span className="chs-scopepick__rangeop">≤ ₽</span>
            <input
              className="chs-input chs-input--mono" inputMode="numeric"
              value={grant.range.replace(/[^\d ]/g, "")}
              placeholder="не задан"
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, "");
                onChange({ ...grant, range: v ? `≤ ₽${Number(v).toLocaleString("ru-RU")}` : "" });
              }}
            />
          </div>
          <div className="chs-scopepick__rangenote">Нельзя поднять выше потолка роли — только сузить.</div>
        </div>
      </div>
      <div className="chs-scopepick__foot">
        <span className="chs-scopepick__monotone">
          <span className="chs-scopepick__monoglyph" />
          монотонное сужение · {grant.nodes.length > 1 ? `scope-set из ${grant.nodes.length} узлов` : grant.nodes.length === 1 ? "один узел" : "узел не выбран"}
        </span>
        <Button variant="secondary" size="sm" onClick={onClose}>Готово</Button>
      </div>
    </div>
  );
}

/* читаемое представление охвата гранта */
function scopeSummary(g) {
  const parts = [];
  if (g.nodes?.length) parts.push(g.nodes.map((n) => ORG_BY_ID[n]?.label).join(" · "));
  if (g.tags?.length) parts.push(g.tags.map((t) => "#" + (SCOPE_TAGS.find((x) => x.id === t)?.label || t)).join(" "));
  if (g.range) parts.push(g.range);
  return parts;
}

/* ---------------- Строка гранта (advanced) ---------------- */
function GrantEditRow({ g, idx, open, onOpen, onChange, onRemove }) {
  const res = RES_BY_URI[g.uri];
  const ALL_OPS = ["read", "write", "exec", "approve"];
  const toggleOp = (op) => {
    const has = g.ops.includes(op);
    onChange(idx, { ...g, ops: has ? g.ops.filter((o) => o !== op) : [...g.ops, op] });
  };
  const summary = scopeSummary(g);
  return (
    <div className={`chs-gedit ${open ? "chs-gedit--open" : ""}`}>
      <div className="chs-gedit__row">
        <div className="chs-gedit__res">
          <span className="chs-gedit__resname">{res?.name || g.uri}</span>
          <span className="chs-gedit__uri">{g.uri}</span>
        </div>
        <div className="chs-gedit__ops">
          {ALL_OPS.map((op) => (
            <button key={op} type="button" className={`chs-opbtn chs-opbtn--${op} ${g.ops.includes(op) ? "chs-opbtn--on" : ""}`} onClick={() => toggleOp(op)}>{op}</button>
          ))}
        </div>
        <button type="button" className={`chs-gedit__scope ${open ? "chs-gedit__scope--active" : ""}`} onClick={() => onOpen(open ? -1 : idx)}>
          {summary.length ? summary.map((s, i) => <ScopeToken key={i} kind={i === 0 ? "node" : "tag"}>{s}</ScopeToken>) : <span className="chs-gedit__scopeempty">задать охват</span>}
          <span className="chs-gedit__scopecaret">{open ? "закрыть" : "▾"}</span>
        </button>
        <button type="button" className="chs-gedit__del" onClick={() => onRemove(idx)} title="Удалить грант">✕</button>
      </div>
      {open && <ScopePicker grant={g} onChange={(ng) => onChange(idx, ng)} onClose={() => onOpen(-1)} />}
    </div>
  );
}

/* ---------------- Экран ---------------- */
function RoleEditorScreen() {
  const [mode, setMode] = useStateRE("advanced");
  const [grants, setGrants] = useStateRE(INITIAL_GRANTS);
  const [openIdx, setOpenIdx] = useStateRE(-1);
  const [presetSel, setPresetSel] = useStateRE(["p-recon"]);
  const [llmText, setLlmText] = useStateRE("Агент-помощник согласования: читает счёт и договор, распознаёт суммы со сканов, готовит решение до ₽50 000. Платежи не инициирует.");
  const [proposed, setProposed] = useStateRE([]); // {…grant, status}
  const [proposedShown, setProposedShown] = useStateRE(false);

  const axes = axesFromGrants(grants);

  const changeGrant = (idx, ng) => setGrants((gs) => gs.map((g, i) => (i === idx ? ng : g)));
  const removeGrant = (idx) => { setGrants((gs) => gs.filter((_, i) => i !== idx)); setOpenIdx(-1); };
  const addGrant = () => {
    const used = new Set(grants.map((g) => g.uri));
    const next = RESOURCES.find((r) => !used.has(r.uri)) || RESOURCES[0];
    setGrants((gs) => [...gs, { uri: next.uri, ops: ["read"], nodes: ["fin-approve"], tags: [], range: "" }]);
    setOpenIdx(grants.length);
  };

  const togglePreset = (id) => setPresetSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const presetGrantCount = presetSel.reduce((n, id) => n + (PRESETS.find((p) => p.id === id)?.grants.length || 0), 0);

  const propose = () => {
    setProposed(LLM_PROPOSALS.map((p) => ({ ...p, status: "pending" })));
    setProposedShown(true);
  };
  const setProposal = (i, status) => setProposed((ps) => ps.map((p, j) => (j === i ? { ...p, status } : p)));
  const confirmProposed = (i) => {
    const p = proposed[i];
    setGrants((gs) => [...gs, { uri: p.uri, ops: p.ops, nodes: p.nodes, tags: p.tags, range: p.range }]);
    setProposal(i, "confirmed");
  };
  const pendingCount = proposed.filter((p) => p.status === "pending").length;

  return (
    <div className="chs-rights">
      {/* левый рейл — выбор роли для редактирования (статичный для прототипа) */}
      <RoleEditRail />

      <div className="chs-rights__main">
        <div className="chs-roledetail chs-roledetail--editor">
          {/* заголовок роли + критичность */}
          <div className="chs-roledetail__head">
            <div className="chs-roledetail__titlewrap">
              <div className="chs-editbadge">режим редактирования</div>
              <h2 className="chs-roledetail__title">Согласующий счетов ≤ ₽50 000</h2>
              <div className="chs-roledetail__sub">
                <span className="chs-scopepill"><span className="chs-scopepill__glyph" />Финансы · Согласование</span>
                <span className="chs-crumbs__sep">/</span>
                <Mono style={{ color: "var(--chs-color-text-faint)" }}>role-fin-approve-50</Mono>
                <CriticalityBadge axes={axes} />
              </div>
            </div>
            <div className="chs-roledetail__actions">
              <Button variant="ghost" size="sm">Отмена</Button>
              <Button variant="primary" size="sm">Запросить применение</Button>
            </div>
          </div>

          {/* переключатель режима */}
          <div className="chs-modebar">
            <Segmented
              value={mode} onChange={setMode}
              options={[
                { value: "simple", label: "Простой", hint: "пресеты" },
                { value: "advanced", label: "Расширенный", hint: "гранты" },
              ]}
            />
            <span className="chs-modebar__hint">
              {mode === "simple"
                ? "Высокоуровневые намерения — каждое разворачивается в гранты."
                : "Полный атом права: ресурс · операция · охват."}
            </span>
          </div>

          {/* ----- ПРОСТОЙ РЕЖИМ ----- */}
          {mode === "simple" && (
            <section className="chs-section2">
              <SectionHead title="Пресеты роли" aux={`выбрано ${presetSel.length} · разворачивается в ${presetGrantCount} грантов`} />
              <div className="chs-presets">
                {PRESETS.map((p) => {
                  const on = presetSel.includes(p.id);
                  return (
                    <button key={p.id} type="button" className={`chs-preset ${on ? "chs-preset--on" : ""}`} onClick={() => togglePreset(p.id)}>
                      <span className={`chs-preset__check ${on ? "chs-preset__check--on" : ""}`} />
                      <span className="chs-preset__main">
                        <span className="chs-preset__label">{p.label}{p.critical && <span className="chs-preset__crit">критично</span>}</span>
                        <span className="chs-preset__desc">{p.desc}</span>
                        <span className="chs-preset__grants">
                          {p.grants.map((g, i) => (
                            <span key={i} className="chs-preset__grant">
                              {RES_BY_URI[g.uri]?.name}
                              {g.ops.map((op) => <OpChip key={op} op={op} />)}
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="chs-section2__note">
                Пресеты — это не отдельный слой прав, а готовые наборы грантов. Переключитесь в <b>Расширенный</b>, чтобы увидеть и сузить каждый грант.
              </p>
            </section>
          )}

          {/* ----- РАСШИРЕННЫЙ РЕЖИМ ----- */}
          {mode === "advanced" && (
            <section className="chs-section2">
              <SectionHead title="Гранты роли" aux={"атом: { ресурс · операция · охват }"} right={<button type="button" className="chs-addgrant" onClick={addGrant}>+ грант</button>} />
              <div className="chs-gedits">
                <div className="chs-gedit__colhead">
                  <span>Ресурс</span><span>Операции</span><span>Охват (scope)</span><span />
                </div>
                {grants.map((g, i) => (
                  <GrantEditRow key={i} g={g} idx={i} open={openIdx === i} onOpen={setOpenIdx} onChange={changeGrant} onRemove={removeGrant} />
                ))}
                {grants.length === 0 && <div className="chs-gedit__empty">Грантов нет — добавьте первый или примите предложения LLM ниже.</div>}
              </div>
              <p className="chs-section2__note">
                Доступные инструменты и видимые поля форм <b>вычисляются</b> из грантов — это не отдельные тумблеры. Охват каждого гранта можно только <b>сужать</b> относительно потолка роли.
              </p>
            </section>
          )}

          {/* ----- LLM: опиши роль словами → предложить гранты → подтвердить ----- */}
          <section className="chs-section2">
            <SectionHead title="Предложить гранты по описанию" aux="LLM предлагает · человек подтверждает" />
            <div className="chs-llmbox">
              <textarea className="chs-llmbox__ta" rows={3} value={llmText} onChange={(e) => setLlmText(e.target.value)} placeholder="Опишите роль словами: что сотрудник или агент должен уметь делать…" />
              <div className="chs-llmbox__bar">
                <span className="chs-llmbox__hint">Предложения требуют явного подтверждения — <code>proposed_by&nbsp;llm → confirmed_by&nbsp;human</code></span>
                <Button variant="secondary" size="sm" onClick={propose}>{proposedShown ? "Предложить заново" : "Предложить гранты"}</Button>
              </div>
            </div>

            {proposedShown && (
              <div className="chs-proposed">
                <div className="chs-proposed__head">
                  <ProvenanceTag by="llm" />
                  <span className="chs-proposed__count">{pendingCount > 0 ? `${pendingCount} ждут подтверждения` : "все обработаны"}</span>
                </div>
                {proposed.map((p, i) => (
                  <div key={i} className={`chs-prop chs-prop--${p.status}`}>
                    <div className="chs-prop__main">
                      <div className="chs-prop__res">
                        <span className="chs-prop__resname">{p.name}{p.heavy && <span className="chs-prop__heavy">поднимет критичность</span>}</span>
                        <span className="chs-prop__uri">{p.uri}</span>
                      </div>
                      <div className="chs-prop__ops">{p.ops.map((op) => <OpChip key={op} op={op} />)}</div>
                      <div className="chs-prop__scope">{scopeSummary(p).map((s, j) => <ScopeToken key={j} kind={j === 0 ? "node" : "tag"}>{s}</ScopeToken>)}</div>
                    </div>
                    <div className="chs-prop__reason">↳ {p.reason}</div>
                    <div className="chs-prop__act">
                      {p.status === "pending" && <>
                        <button type="button" className="chs-prop__reject" onClick={() => setProposal(i, "rejected")}>Отклонить</button>
                        <button type="button" className="chs-prop__confirm" onClick={() => confirmProposed(i)}>Подтвердить грант</button>
                      </>}
                      {p.status === "confirmed" && <span className="chs-prop__state chs-prop__state--ok">✓ подтверждено · confirmed_by М. Соколов</span>}
                      {p.status === "rejected" && <span className="chs-prop__state chs-prop__state--no">✕ отклонено</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/* статичный рейл выбора роли (визуальная согласованность с read-экраном) */
const RE_GROUPS = [
  { dept: "Финансы", roles: [["Контролёр расчётов", false], ["Согласование ≤ ₽250 000", false], ["Согласующий счетов ≤ ₽50 000", true], ["Сверка платежей", false], ["Приёмник эскалаций агентов", false]] },
  { dept: "Клиентский сервис", roles: [["Линия поддержки L1", false], ["Эскалации L2", false]] },
  { dept: "Платформа", roles: [["Коннектор реестра", false]] },
];
function RoleEditRail() {
  return (
    <div className="chs-rights__rail">
      <div className="chs-rights__railhead"><span>Роли</span><span className="chs-rights__railcount">8</span></div>
      <div className="chs-rights__search"><Icon name="search" /><span>Поиск роли</span></div>
      <div className="chs-rights__roles">
        {RE_GROUPS.map((grp) => (
          <div className="chs-rights__rgroup" key={grp.dept}>
            <div className="chs-rights__rgrouplabel">{grp.dept}</div>
            {grp.roles.map(([name, active]) => (
              <button key={name} type="button" className="chs-rolerow" aria-current={active ? "true" : undefined}>
                <span className="chs-rolerow__main"><span className="chs-rolerow__name">{name}</span></span>
                {active && <span className="chs-rolerow__editing">ред.</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { RoleEditorScreen });
