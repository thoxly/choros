/* ============================================================================
   CHOROS — screen-processes.jsx
   ЭКРАН: плотная таблица процессов (инстансов).
   Колонки: Процесс · Инстанс · Статус · Узел · Прогресс · Запущен · Исполнители · Действие.
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MonoId, Mono, StatusChip, ExecGlyph } from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)",
};

function ProcessesScreen() {
  const navigate = useNavigate();
  const [instances, setInstances] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/processes', { headers: devHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setInstances(data.instances);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const list = instances || [];

  return (
    <div className="chs-inbox">
      <div className="chs-inbox__scroll">
        {error ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            <p style={{ marginBottom: "var(--chs-space-3)" }}>Не удалось загрузить процессы: {error}</p>
            <Button onClick={load}>Повторить</Button>
          </div>
        ) : instances === null ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Загрузка процессов…
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
            Нет процессов
          </div>
        ) : (
          <table className="chs-itable">
            <colgroup>
              <col style={{ width: "auto" }} />
              <col style={{ width: "108px" }} />
              <col style={{ width: "132px" }} />
              <col style={{ width: "176px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "120px" }} />
              <col style={{ width: "100px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Процесс</th>
                <th>Инстанс</th>
                <th>Статус</th>
                <th>Текущий узел</th>
                <th>Прогресс</th>
                <th>Запущен</th>
                <th>Исполнители</th>
                <th className="chs-r">Действие</th>
              </tr>
            </thead>
            <tbody>
              {list.map((inst) => (
                <tr key={inst.id}>
                  <td>
                    <div className="chs-task">
                      <span className="chs-task__marker" style={{ background: MARKER_COLOR[inst.status] }} />
                      <span className="chs-task__txt">
                        <span className="chs-task__name">{inst.name}</span>
                        <span className="chs-task__step">{inst.procId}</span>
                      </span>
                    </div>
                  </td>
                  <td><MonoId>{inst.id}</MonoId></td>
                  <td><StatusChip status={inst.status} /></td>
                  <td><Mono style={{ fontSize: "var(--chs-text-sm)" }}>{inst.node}</Mono></td>
                  <td>
                    <Mono style={{ fontSize: "var(--chs-text-sm)", color: "var(--chs-color-text-muted)" }}>
                      {inst.progress.done}/{inst.progress.total}
                    </Mono>
                  </td>
                  <td><Mono style={{ fontSize: "var(--chs-text-xs)", color: "var(--chs-color-text-muted)" }}>{inst.started}</Mono></td>
                  <td>
                    <div style={{ display: "flex", gap: "var(--chs-space-2)" }}>
                      {inst.execs.map((execType, idx) => (
                        <ExecGlyph key={idx} type={execType} size={9} filled={true} />
                      ))}
                    </div>
                  </td>
                  <td className="chs-r">
                    <Button variant="ghost" size="sm" onClick={() => navigate('/audit')}>Открыть</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default ProcessesScreen;
