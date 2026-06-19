/* ============================================================================
   CHOROS — ra-role-editor.jsx
   ЭКРАН 1: РЕДАКТОР РОЛИ.
   ============================================================================ */

import React, { useState } from 'react';
import { Mono, Button, OpChip } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';
import {
  ORG_TREE, ORG_BY_ID, SCOPE_TAGS, RESOURCES, RES_BY_URI, PRESETS,
  axesFromGrants, CriticalityBadge, ScopeToken, ProvenanceTag, SectionHead, Segmented,
} from './ra-data.jsx';

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
  { uri: "mcp://payments.initiate", ops: ["invoke"], nodes: ["fin-approve"], tags: ["payments"], range: "≤ ₽50 000" },
];

// Static mock removed (AC-14 / T-0039). propose() makes a live HTTP call.

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
  const ALL_OPS = ["read", "write", "invoke", "approve"];
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

/* --- helpers: map UI grant state → GrantWriteRequest structural atoms --- */

/** Convert a UI org-node slug (e.g. "fin-approve") to a ScopeElement. */
function nodeToScope(nodes, range) {
  const elements = [];
  for (const n of nodes) {
    elements.push({ kind: "node", hierarchy: "org", nodeId: n, nodeLevel: "department" });
  }
  if (range && /\d/.test(range)) {
    const amount = Number(range.replace(/[^\d]/g, ""));
    if (!isNaN(amount)) {
      elements.push({ kind: "interval", axis: "amount_rub", lo: 0, hi: amount });
    }
  }
  if (elements.length === 0) return { kind: "set", members: [] };
  if (elements.length === 1) return elements[0];
  return { kind: "set", members: elements };
}

/** Map UI op labels → canonical Operation literals. */
function mapOp(op) {
  if (op === "write") return "update";
  return op;
}

/**
 * Post a single GrantWriteRequest to POST /api/grants.
 * Returns { ok: true, id, state } or { ok: false, reason }.
 * state = "confirmed" | "semi-confirmed"
 */
async function postGrant(atom, actorId) {
  try {
    const resp = await fetch("/api/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dev-user": actorId },
      body: JSON.stringify(atom),
    });
    if (resp.status === 201) {
      const data = await resp.json();
      return { ok: true, id: data.id, state: data.state || "confirmed" };
    }
    const err = await resp.json().catch(() => ({}));
    return { ok: false, reason: err?.error?.reason || err?.error?.code || String(resp.status) };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * POST /api/grants with phase=confirm2 — second authenticator confirm.
 * Returns { ok: true } or { ok: false, reason }.
 */
async function postSecondConfirm(changeRef, actorId) {
  try {
    const resp = await fetch("/api/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dev-user": actorId },
      body: JSON.stringify({ phase: "confirm2", change_ref: changeRef }),
    });
    if (resp.ok) {
      return { ok: true };
    }
    const err = await resp.json().catch(() => ({}));
    return { ok: false, reason: err?.error?.reason || err?.error?.code || String(resp.status) };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/* ---------------- Экран ---------------- */
function RoleEditorScreen() {
  const [mode, setMode] = useState("advanced");
  const [grants, setGrants] = useState(INITIAL_GRANTS);
  const [openIdx, setOpenIdx] = useState(-1);
  const [presetSel, setPresetSel] = useState(["p-recon"]);
  const [llmText, setLlmText] = useState("Агент-помощник согласования: читает счёт и договор, распознаёт суммы со сканов, готовит решение до ₽50 000. Платежи не инициирует.");
  const [proposed, setProposed] = useState([]);
  const [proposedShown, setProposedShown] = useState(false);
  // proposalAgentId: UUID of the BYO agent returned by /api/grants/propose (AC-15).
  const [proposalAgentId, setProposalAgentId] = useState(null);
  // Submit state: null | "loading" | { errors: [{ uri, reason }], success: number }
  const [submitResult, setSubmitResult] = useState(null);
  // Dual-control: pending second confirmations from critical grants
  // Each entry: { changeRef: string, uri: string, op: string }
  const [pendingConfirms, setPendingConfirms] = useState([]);
  // Second-confirm actor (separate from ACTOR_ID — simulates second admin)
  const [confirmActor, setConfirmActor] = useState("e-owner2");
  const [confirmResult, setConfirmResult] = useState(null); // null | "loading" | { ok, reason? }

  // Static role UUID for the dev silo "Согласующий счетов ≤ ₽50 000" (seed role).
  // In a DB-backed scenario this would come from the selected role context.
  const EDITOR_ROLE_ID = "e0000000-0000-0000-0000-000000000002";
  const ACTOR_ID = "e-owner"; // dev silo actor (genesis owner, confirmed by seed)

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

  /** Expand preset selection into structural grant atoms (AC-18: client-side, no preset table). */
  function expandPresets() {
    const atoms = [];
    for (const presetId of presetSel) {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset) continue;
      for (const g of preset.grants) {
        for (const op of g.ops) {
          atoms.push({
            uri: g.uri,
            ops: [op],
            nodes: g.scopeOwn ? ["fin-approve"] : ["fin"],
            tags: [],
            range: g.scopeRange || "",
          });
        }
      }
    }
    return atoms;
  }

  /**
   * "Запросить применение" — submit handler (AC-17 / FR-7).
   * Advanced mode: submits each grant atom.
   * Simple mode: expands presets first (AC-18), then submits.
   */
  const handleSubmit = async () => {
    setSubmitResult("loading");
    setPendingConfirms([]);
    setConfirmResult(null);
    const sourceGrants = mode === "simple" ? expandPresets() : grants;
    const errors = [];
    let successCount = 0;
    const newPending = [];

    for (const g of sourceGrants) {
      for (const op of g.ops) {
        const scope = nodeToScope(g.nodes || [], g.range || "");
        const atom = {
          role_id: EDITOR_ROLE_ID,
          resource_type: g.uri, // URI used as resource_type identifier
          operation: mapOp(op),
          scope,
          granted_by: ACTOR_ID,
          delegable: true,
        };
        const result = await postGrant(atom, ACTOR_ID);
        if (result.ok) {
          successCount++;
          if (result.state === "semi-confirmed") {
            newPending.push({ changeRef: result.id, uri: g.uri, op });
          }
        } else {
          errors.push({ uri: g.uri, op, reason: result.reason });
        }
      }
    }
    if (newPending.length > 0) {
      setPendingConfirms(newPending);
    }
    setSubmitResult({ errors, success: successCount });
  };

  // propose() — live HTTP call to POST /api/grants/propose (AC-14 / T-0039).
  // On success: stores proposal_agent_id (AC-15) and maps ScopeElement atoms
  // back to UI grant shape. On 503: shows "BYO-агент не настроен".
  const propose = async () => {
    try {
      const resp = await fetch("/api/grants/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-user": ACTOR_ID },
        body: JSON.stringify({ text: llmText, role_id: EDITOR_ROLE_ID }),
      });
      if (resp.status === 503) {
        const err = await resp.json().catch(() => ({}));
        const code = err?.error?.code || "NO_PROPOSAL_AGENT";
        if (code === "NO_PROPOSAL_AGENT") {
          setProposed([{ _error: "BYO-агент не настроен", status: "error" }]);
          setProposalAgentId(null);
          setProposedShown(true);
          return;
        }
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setProposed([{ _error: err?.error?.code || String(resp.status), status: "error" }]);
        setProposalAgentId(null);
        setProposedShown(true);
        return;
      }
      const data = await resp.json();
      // Store the agent UUID for threading into confirmProposed (AC-15).
      setProposalAgentId(data.proposal_agent_id || null);
      // Map ProposedGrantAtom[] → UI grant shape (inverse of nodeToScope).
      const atoms = (data.proposed || []).map((atom) => {
        // Extract nodes/range from scope for UI display.
        const scope = atom.scope || {};
        const nodes = [];
        let range = "";
        if (scope.kind === "node") {
          nodes.push(scope.nodeId);
        } else if (scope.kind === "set" && Array.isArray(scope.members)) {
          for (const m of scope.members) {
            if (m.kind === "node") nodes.push(m.nodeId);
            if (m.kind === "interval" && m.axis === "amount_rub") {
              range = `≤ ₽${Number(m.hi).toLocaleString("ru-RU")}`;
            }
          }
        } else if (scope.kind === "interval" && scope.axis === "amount_rub") {
          range = `≤ ₽${Number(scope.hi).toLocaleString("ru-RU")}`;
        }
        const res = RES_BY_URI[atom.resource_type];
        return {
          uri: atom.resource_type,
          name: res?.name || atom.resource_type,
          ops: [atom.operation],
          nodes: nodes.length ? nodes : ["fin"],
          tags: [],
          range,
          reason: atom.reason || "",
          status: "pending",
        };
      });
      setProposed(atoms);
      setProposedShown(true);
    } catch (e) {
      setProposed([{ _error: String(e?.message || e), status: "error" }]);
      setProposalAgentId(null);
      setProposedShown(true);
    }
  };
  const setProposal = (i, status) => setProposed((ps) => ps.map((p, j) => (j === i ? { ...p, status } : p)));
  const confirmProposed = async (i) => {
    const p = proposed[i];
    // D-1 (T-0039): proposed_by = agent-employee UUID from the proposal response
    // envelope (AC-15), NOT the legacy string "llm". The UUID confers no authority;
    // confirmed_by is derived from the authenticated actor on the server (R-AUTH).
    // Body confirmed_by is intentionally omitted — the server ignores it (D-1).
    const scope = nodeToScope(p.nodes || [], p.range || "");
    const atom = {
      role_id: EDITOR_ROLE_ID,
      resource_type: p.uri,
      operation: mapOp(p.ops[0] || "read"),
      scope,
      granted_by: ACTOR_ID,
      proposed_by: proposalAgentId, // UUID from proposal response (AC-15)
      delegable: true,
    };
    const result = await postGrant(atom, ACTOR_ID);
    if (result.ok && result.state === "semi-confirmed") {
      setPendingConfirms((prev) => [...prev, { changeRef: result.id, uri: p.uri, op: p.ops[0] || "read" }]);
    }
    setGrants((gs) => [...gs, { uri: p.uri, ops: p.ops, nodes: p.nodes, tags: p.tags, range: p.range }]);
    setProposal(i, "confirmed");
  };
  const handleSecondConfirm = async () => {
    if (pendingConfirms.length === 0) return;
    setConfirmResult("loading");
    const results = [];
    for (const pc of pendingConfirms) {
      const r = await postSecondConfirm(pc.changeRef, confirmActor);
      results.push({ ...pc, ...r });
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setConfirmResult({ ok: true });
      setPendingConfirms([]);
    } else {
      setConfirmResult({ ok: false, reason: failed.map((f) => `${f.uri}: ${f.reason}`).join("; ") });
    }
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
              <Button variant="ghost" size="sm" onClick={() => setSubmitResult(null)}>Отмена</Button>
              <Button
                variant="primary"
                size="sm"
                disabled={submitResult === "loading"}
                onClick={handleSubmit}
              >
                {submitResult === "loading" ? "Отправка…" : "Запросить применение"}
              </Button>
            </div>
            {submitResult && submitResult !== "loading" && (
              <div className="chs-submit-result" style={{ marginTop: "var(--chs-space-3)", fontSize: "var(--chs-text-sm)" }}>
                {submitResult.success > 0 && (
                  <span style={{ color: "var(--chs-color-success)" }}>
                    ✓ {submitResult.success} грант(ов) применено
                  </span>
                )}
                {submitResult.errors.length > 0 && submitResult.errors.map((e, i) => (
                  <div key={i} style={{ color: "var(--chs-color-danger)", marginTop: "var(--chs-space-1)" }}>
                    ✕ {e.uri} [{e.op}]: {e.reason}
                  </div>
                ))}
              </div>
            )}

            {/* ── Dual-control: second-confirm panel ── */}
            {pendingConfirms.length > 0 && (
              <div className="chs-dualbanner" style={{ marginTop: "var(--chs-space-3)" }}>
                <span className="chs-dualbanner__glyph" />
                <div className="chs-dualbanner__txt">
                  <b>Требуется второй аппрувер.</b>{" "}
                  {pendingConfirms.length} грант(ов) в статусе <code>semi-confirmed</code> — критичное расширение.
                  Войдите как второй администратор и подтвердите.
                  <div style={{ marginTop: "var(--chs-space-3)", display: "flex", alignItems: "center", gap: "var(--chs-space-3)", flexWrap: "wrap" }}>
                    <label style={{ fontSize: "var(--chs-text-sm)", color: "var(--chs-color-text-muted)" }}>
                      Второй аппрувер (X-Dev-User):
                      <input
                        className="chs-input chs-input--mono"
                        style={{ marginLeft: "var(--chs-space-2)", width: "14ch" }}
                        value={confirmActor}
                        onChange={(e) => setConfirmActor(e.target.value)}
                        placeholder="user-id"
                      />
                    </label>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={confirmResult === "loading" || !confirmActor}
                      onClick={handleSecondConfirm}
                    >
                      {confirmResult === "loading" ? "Подтверждение…" : "Подтвердить (confirm2)"}
                    </Button>
                    {confirmResult && confirmResult !== "loading" && (
                      confirmResult.ok
                        ? <span style={{ color: "var(--chs-color-success)" }}>✓ подтверждено — гранты активны</span>
                        : <span style={{ color: "var(--chs-color-danger)" }}>✕ {confirmResult.reason}</span>
                    )}
                  </div>
                </div>
                <span className="chs-dualbanner__tag">DUAL-CONTROL</span>
              </div>
            )}
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
                {proposed.map((p, i) => {
                  // Error / 503 sentinel row from propose().
                  if (p._error) {
                    return (
                      <div key={i} className="chs-prop chs-prop--error" style={{ color: "var(--chs-color-danger)", padding: "var(--chs-space-3)" }}>
                        {p._error}
                      </div>
                    );
                  }
                  return (
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
                  );
                })}
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

export default RoleEditorScreen;
