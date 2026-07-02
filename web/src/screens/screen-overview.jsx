/* ============================================================================
   CHOROS — screen-overview.jsx
   ЭКРАН: ОБЗОР (домашний экран / точка входа). T-0326.

   До этого продукт приземлялся холодно на /apps — голый список без ориентира.
   «Обзор» отвечает на вопрос «куда я попал и что тут делать»: по плитке на
   каждый из 4 разделов ИА (Конструктор · Работа · Исполнители и доступ ·
   Наблюдаемость) с короткой подсказкой, ЖИВЫМИ счётчиками (где дёшево) и
   первичным действием, ведущим внутрь раздела.

   Счётчики (best-effort, деградируют поштучно — никогда не роняют дом):
     • приложения      — GET /api/applications  → { applications: [...] }.length
     • открытые задачи — GET /api/inbox          → { counts: { all,... } }.all
     • процессы        — GET /api/processes       → { instances: [...] }.length
   Любой сбой одного фетча оставляет плитку БЕЗ числа (прочерк), не ломая экран
   (principles.md §6 — состояния явные, но дом всегда рендерится).

   T-0598 (находка №1 отчёта ux-loop-report-2026-07-02.md): секция «Первые
   шаги» над сеткой плиток — non-blocking checklist-stepper (uxpatterns MCP
   patterns/advanced/wizard, onboarding-вариант) для нового владельца. Три
   обязательных шага + один опциональный, все кормятся ЖИВЫМИ сигналами из
   уже существующих READ-эндпоинтов (ноль новых API):
     • шаг 1 «Создайте приложение» — переиспользует уже загруженный `apps`
       (тот же счётчик, что у плитки «Конструктор»), done при apps > 0.
     • шаг 2 «Подключите LLM-ключ»  — GET /api/agents + импортированная чистая
       функция resolveAssistantBinding (screen-llm-connections.jsx) находит
       агента-ассистента тенанта; done когда у него есть привязанный
       llm_connection_id. Выбран /api/agents, а не /api/llm-connections,
       потому что последний требует капабилити llm_connection:configure
       (403 для рядового сотрудника) — /api/agents гейтится только withAuth,
       честно виден любому авторизованному пользователю тенанта.
     • шаг 3 «Спросите ассистента» — GET /api/assistant/threads, done когда
       хотя бы один тред имеет message_count > 0.
     • шаг 4 (опционально) «Настройте права» — GET /api/rights/tenant-state,
       рендерится ТОЛЬКО при can_manage:true (иначе структурно отсутствует —
       тот же принцип, что ADR T-0572 применяет к формам выдачи/отзыва); не
       участвует в критерии скрытия полосы.
   Деградация: любой сбой (сеть/HTTP/парсинг) на шагах 1-3 оставляет шаг БЕЗ
   чека (не error state, не красный экран) — CTA-ссылка остаётся рабочей.
   Полоса целиком скрывается только когда шаги 1-3 ВСЕ подтверждённо true —
   производное от данных состояние, без localStorage/dismiss.

   Авторизация — через devHeaders() (X-Dev-User), как у остальных экранов.
   OBLIK: потребляем KIT (Button, KitIcon, LoadingState) + только --chs-color-*
   токены; ноль хардкода цвета (UX-гейт G6). Плотный B2B, обе темы WCAG AA.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, KitIcon, LoadingState } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
// T-0598: переиспользуем существующую чистую функцию резолюции привязки
// ассистента (импорт, не копия логики — единственный источник истины про то,
// как выглядит «ассистент подключён к LLM-профилю»).
import { resolveAssistantBinding } from './screen-llm-connections.jsx';

// ---- token-only inline style helpers (no hardcoded color — G6) ---------------
const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: 'var(--chs-space-6)',
};
const tileStyle = {
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-6)',
};
const tileHeadStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)',
  marginBottom: 'var(--chs-space-2)',
};
const tileIconStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', flex: '0 0 auto',
  borderRadius: 'var(--chs-radius-2)',
  background: 'var(--chs-color-accent-soft)', color: 'var(--chs-color-accent)',
};
const tileTitleStyle = {
  fontSize: 'var(--chs-text-md)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)',
};
const tileDescStyle = {
  fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)',
  lineHeight: 1.45, margin: '0 0 var(--chs-space-5) 0',
};
const statsRowStyle = {
  display: 'flex', gap: 'var(--chs-space-7)',
  marginBottom: 'var(--chs-space-6)', marginTop: 'auto',
};
const statValStyle = {
  fontFamily: 'var(--chs-font-mono)', fontVariantNumeric: 'tabular-nums',
  fontSize: 'var(--chs-text-2xl)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)',
  lineHeight: 1.1,
};
const statLabelStyle = {
  display: 'block', fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-1)',
};

/**
 * Stat — одна метрика плитки: крупное моноширинное число + подпись.
 * loading → компактный спиннер; value===null (сбой/нет данных) → честный «—».
 */
function Stat({ label, value, loading }) {
  return (
    <div>
      <span style={statValStyle}>
        {loading ? <LoadingState compact label="" /> : (value == null ? '—' : value)}
      </span>
      <span style={statLabelStyle}>{label}</span>
    </div>
  );
}

/**
 * Tile — плитка раздела: иконка+заголовок, описание, метрики, первичное действие.
 * Вся плитка ведёт в раздел (clickable surface), но фокусируемое действие — это
 * явная Button-CTA (доступность: навигация с клавиатуры через кнопку).
 */
function Tile({ icon, title, description, stats, cta, onGo }) {
  return (
    <section
      style={{ ...tileStyle, cursor: 'pointer' }}
      onClick={onGo}
      aria-label={title}
    >
      <div style={tileHeadStyle}>
        <span style={tileIconStyle}><Icon name={icon} /></span>
        <span style={tileTitleStyle}>{title}</span>
      </div>
      <p style={tileDescStyle}>{description}</p>
      <div style={statsRowStyle}>
        {stats.map((s, i) => (
          <Stat key={i} label={s.label} value={s.value} loading={s.loading} />
        ))}
      </div>
      <div>
        <Button
          variant="primary"
          size="sm"
          glyph={cta.glyph}
          onClick={(e) => { e.stopPropagation(); onGo(); }}
        >
          {cta.label}
        </Button>
      </div>
    </section>
  );
}

/**
 * Загружает один счётчик best-effort: возвращает число при успехе, null при
 * любом сбое (сеть/HTTP/парсинг). Никогда не бросает — дом не должен падать
 * из-за одного раздела.
 * @param {string} url
 * @param {(data:any)=>number} pick  извлекает число из тела ответа
 */
async function fetchCount(url, pick) {
  try {
    const res = await fetch(url, { headers: devHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const n = pick(data);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ============================================================================
   T-0598 — «Первые шаги» (находка №1): non-blocking checklist-stepper.
   ============================================================================ */

// ---- token-only inline styles (G6: --chs-* only) --------------------------
const stepsSectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-3)',
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-5) var(--chs-space-6)',
  marginBottom: 'var(--chs-space-6)',
};
const stepsHeadStyle = {
  fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-semibold)',
  letterSpacing: 'var(--chs-tracking-wide)',
  textTransform: 'uppercase',
  color: 'var(--chs-color-text-faint)',
};
const stepRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--chs-space-4)',
};
const stepMarkerDoneStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '20px', height: '20px', flex: '0 0 auto',
  borderRadius: 'var(--chs-radius-full, 999px)',
  background: 'var(--chs-color-success-soft)', color: 'var(--chs-color-success)',
};
const stepMarkerTodoStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '20px', height: '20px', flex: '0 0 auto',
  borderRadius: 'var(--chs-radius-full, 999px)',
  border: '1px solid var(--chs-color-border)',
};
const stepTextStyle = {
  flex: '1 1 auto',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};
const stepTextDoneStyle = {
  ...stepTextStyle,
  color: 'var(--chs-color-text-muted)',
};

/**
 * StepRow — одна строка чек-листа: маркер состояния (галка/пусто/загрузка) +
 * текст шага + CTA-ссылка в соответствующий раздел. Всегда кликабельна,
 * независимо от того, загрузился ли чек (навигация не зависит от статуса).
 */
function StepRow({ label, done, loading, ctaLabel, onGo }) {
  return (
    <div style={stepRowStyle}>
      {loading ? (
        <LoadingState compact label="" />
      ) : done ? (
        <span style={stepMarkerDoneStyle} aria-hidden="true"><KitIcon name="check" /></span>
      ) : (
        <span style={stepMarkerTodoStyle} aria-hidden="true" />
      )}
      <span style={done ? stepTextDoneStyle : stepTextStyle}>{label}</span>
      <Button variant="ghost" size="sm" onClick={onGo}>{ctaLabel}</Button>
    </div>
  );
}

/**
 * useFirstStepsSignals — best-effort загрузка трёх дополнительных сигналов
 * (LLM-ключ / ассистент / права), КАЖДЫЙ по образцу fetchCount: любой сбой
 * (сеть/HTTP/парсинг) деградирует до null, никогда не бросает. Шаг
 * «приложение» НЕ дублируется здесь — он приходит пропом из уже загруженного
 * состояния экрана (apps).
 *
 * Возвращает:
 *   llmConnected  — null (грузим/недоступно) | boolean
 *   assistantUsed — null (грузим/недоступно) | boolean
 *   canManage     — null (грузим/недоступно/false) | true — шаг 4 рендерится
 *                    только при true (AC-5: структурное отсутствие, не «без чека»)
 *   loadingExtra  — true, пока хотя бы один из трёх ещё грузится
 */
function useFirstStepsSignals() {
  const [llmConnected, setLlmConnected] = useState(null);
  const [assistantUsed, setAssistantUsed] = useState(null);
  const [canManage, setCanManage] = useState(null);
  const [loadingExtra, setLoadingExtra] = useState(true);

  const load = useCallback(async () => {
    setLoadingExtra(true);
    const [agentsRes, threadsRes, rightsRes] = await Promise.all([
      (async () => {
        try {
          const res = await fetch('/api/agents', { headers: devHeaders() });
          if (!res.ok) return null;
          const data = await res.json();
          const binding = resolveAssistantBinding(data.agents);
          if (!binding) return null;
          return binding.assistantConnectionId != null;
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const res = await fetch('/api/assistant/threads', { headers: devHeaders() });
          if (!res.ok) return null;
          const data = await res.json();
          if (!Array.isArray(data.threads)) return null;
          return data.threads.some((t) => t && typeof t.message_count === 'number' && t.message_count > 0);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const res = await fetch('/api/rights/tenant-state', { headers: devHeaders() });
          if (!res.ok) return null;
          const data = await res.json();
          return data && data.can_manage === true ? true : null;
        } catch {
          return null;
        }
      })(),
    ]);
    setLlmConnected(agentsRes);
    setAssistantUsed(threadsRes);
    setCanManage(rightsRes);
    setLoadingExtra(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { llmConnected, assistantUsed, canManage, loadingExtra };
}

/**
 * FirstStepsStrip — секция «Первые шаги»: три обязательных шага + опциональный.
 * Скрывается целиком (return null), когда шаги 1-3 ВСЕ подтверждённо true.
 * Пока сигналы грузятся или деградировали (null), полоса остаётся видимой —
 * скрытие требует явного true, не просто «не false» (AC-6/AC-7).
 */
function FirstStepsStrip({ apps, appsLoading, navigate }) {
  const { llmConnected, assistantUsed, canManage, loadingExtra } = useFirstStepsSignals();

  const step1Done = typeof apps === 'number' && apps > 0;
  const step2Done = llmConnected === true;
  const step3Done = assistantUsed === true;

  // Скрытие: только когда все три обязательных сигнала подтверждённо true
  // (не когда appsLoading/loadingExtra ещё в процессе — тогда step*Done ещё
  // false, полоса остаётся видимой, что и требуется).
  const allMandatoryDone = step1Done && step2Done && step3Done;
  if (allMandatoryDone) return null;

  return (
    <section style={stepsSectionStyle} aria-label="Первые шаги">
      <div style={stepsHeadStyle}>Первые шаги</div>
      <StepRow
        label="Создайте приложение"
        done={step1Done}
        loading={appsLoading}
        ctaLabel="Создать приложение"
        onGo={() => navigate('/apps')}
      />
      <StepRow
        label="Подключите LLM-ключ"
        done={step2Done}
        loading={loadingExtra}
        ctaLabel="Подключить ключ"
        onGo={() => navigate('/llm-connections')}
      />
      <StepRow
        label="Спросите ассистента"
        done={step3Done}
        loading={loadingExtra}
        ctaLabel="Спросить ассистента"
        onGo={() => navigate('/assistant')}
      />
      {/* Шаг 4 — опционален, рендерится ТОЛЬКО при can_manage:true (AC-5);
          при false/403/сети структурно отсутствует, не «шаг без чека». */}
      {canManage === true && (
        <StepRow
          label="Настройте права"
          done={false}
          loading={false}
          ctaLabel="Настроить права"
          onGo={() => navigate('/rights')}
        />
      )}
    </section>
  );
}

function OverviewScreen() {
  const navigate = useNavigate();
  // null = ещё грузим; число = живое значение; undefined-маркер не нужен —
  // после загрузки оставшийся null означает «недоступно» (рисуем «—»).
  const [loading, setLoading] = useState(true);
  const [apps, setApps] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [procs, setProcs] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, t, p] = await Promise.all([
      fetchCount('/api/applications', (d) => (Array.isArray(d.applications) ? d.applications.length : null)),
      // counts.all = все открытые задачи тенанта (тот же источник, что вкладки инбокса).
      fetchCount('/api/inbox', (d) => (d && d.counts && typeof d.counts.all === 'number' ? d.counts.all : (Array.isArray(d.items) ? d.items.length : null))),
      fetchCount('/api/processes', (d) => (Array.isArray(d.instances) ? d.instances.length : null)),
    ]);
    setApps(a); setTasks(t); setProcs(p);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const tiles = [
    {
      icon: 'apps',
      title: 'Конструктор',
      description: 'Соберите своё решение из примитивов: приложения, поля и записи — без кода.',
      stats: [{ label: 'приложений', value: apps, loading }],
      cta: { label: 'Создать приложение', glyph: <KitIcon name="plus" /> },
      onGo: () => navigate('/apps'),
    },
    {
      icon: 'inbox',
      title: 'Работа',
      description: 'Берите задачи в работу и ведите процессы от запуска до завершения.',
      stats: [
        { label: 'открытых задач', value: tasks, loading },
        { label: 'процессов', value: procs, loading },
      ],
      cta: { label: 'Мои задачи', glyph: <Icon name="inbox" /> },
      onGo: () => navigate('/inbox'),
    },
    {
      icon: 'org',
      title: 'Исполнители и доступ',
      description: 'Кто работает и что им можно: оргструктура, агенты, права и доступ.',
      stats: [],
      cta: { label: 'Оргструктура', glyph: <Icon name="org" /> },
      onGo: () => navigate('/org'),
    },
    {
      icon: 'audit',
      title: 'Наблюдаемость',
      description: 'Смотрите, что происходит: уведомления и журнал аудита по тенанту.',
      stats: [],
      cta: { label: 'Уведомления', glyph: <Icon name="bell" /> },
      onGo: () => navigate('/notifications'),
    },
  ];

  return (
    <div className="chs-inbox">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 'var(--chs-space-5) var(--chs-space-6)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Обзор · точка входа в рабочее пространство
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)',
          fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
        }}>
          <Icon name="search" />
          Быстрый поиск раздела&nbsp;—&nbsp;
          <kbd style={{
            fontFamily: 'var(--chs-font-mono)', fontSize: 'var(--chs-text-2xs)',
            padding: '0 var(--chs-space-2)', borderRadius: 'var(--chs-radius-1)',
            border: '1px solid var(--chs-color-border)', color: 'var(--chs-color-text)',
            background: 'var(--chs-color-surface-2)',
          }}>⌘K</kbd>
        </span>
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-6)' }}>
        {/* T-0598 (находка №1): «Первые шаги» — скрывается сама, когда пройдена. */}
        <FirstStepsStrip apps={apps} appsLoading={loading} navigate={navigate} />
        <div style={gridStyle}>
          {tiles.map((t) => (
            <Tile
              key={t.title}
              icon={t.icon}
              title={t.title}
              description={t.description}
              stats={t.stats}
              cta={t.cta}
              onGo={t.onGo}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default OverviewScreen;
