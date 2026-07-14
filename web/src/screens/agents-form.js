/**
 * web/src/screens/agents-form.js — T-0271
 *
 * Pure, framework-free payload-assembly + validation + error-mapping for the
 * agents screen (screen-agents.jsx). JSX-free so it unit-tests in isolation
 * (mirrors org-crud.js / apps-validate.js / records-form.js).
 *
 * WIRED CONTRACTS (exact, read from src/http/agents.ts + src/http/secret-handle.ts):
 *   GET  /api/agents                         → 200 { agents: AgentPublic[] }  (metadata only, NO secrets)
 *   POST /api/agents/hire                     { position_id, slug, display_name } → 201 { employee_id, kc_client_id }
 *   POST /api/agents/:id/secret-handle        { handle_value } → 200 { ok:true }   (binds LLM key via opaque handle)
 *   GET  /api/agents/:id/secret-handle/status → 200 { bound:bool, summary? }       (redacted; never the raw handle)
 *
 * SECURITY — the central rule of this screen:
 *   The LLM key is a SECRET. The backend stores an OPAQUE HANDLE/REFERENCE
 *   (e.g. "vault://secret/...", "env://LLM_KEY"), NEVER a raw vendor key. The
 *   server's validateSecretHandleShape REJECTS raw keys (sk-/xai-/AIza prefixes,
 *   bare 32+ hex, JWT shape). So this form sends a handle reference, and we
 *   mirror that guard client-side to give an honest error BEFORE the round-trip.
 *   The handle value is never echoed back by the server (status returns only a
 *   redacted summary), and this module never stores or returns it.
 */

// EXACT mirror of the constructor slug grammar (src/http/applications.ts SLUG_RE).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DISPLAY_NAME_MAX = 256;

// EXACT mirror of the backend reject heuristics (src/core/secret-handle-validator.ts).
// Used to reject an obvious RAW vendor key client-side with a clear reason, so the
// user is told to paste a handle/reference instead of pasting their secret key.
const VENDOR_PREFIXES = ['sk-', 'xai-', 'AIza'];
const BARE_HEX_RE = /^[0-9a-fA-F]{32,}$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Trim-tolerant string coercion. */
function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Hire-agent validation + payload  (POST /api/agents/hire)
// ---------------------------------------------------------------------------

/**
 * Validate the "подключить агента" (hire) form.
 * position_id is REQUIRED by the backend (assertUuidShape); slug + display_name required.
 * @param {{position_id?,slug?,display_name?}} f
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
export function validateHire(f) {
  const errors = {};
  const slug = str(f?.slug);
  if (slug.length === 0) errors.slug = 'Укажите слаг';
  else if (!SLUG_RE.test(slug))
    errors.slug = 'Слаг: строчные латинские буквы, цифры и дефис (1–64 символа)';

  const name = str(f?.display_name).trim();
  if (name.length === 0) errors.display_name = 'Укажите отображаемое имя';
  else if (name.length > DISPLAY_NAME_MAX)
    errors.display_name = `Имя: не длиннее ${DISPLAY_NAME_MAX} символов`;

  if (str(f?.position_id).length === 0)
    errors.position_id = 'Выберите должность (агент подключается к работе через должность в оргструктуре)';

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Build the exact POST /api/agents/hire body. Optional fields are omitted (not
 * sent empty) so the server's typeof guards fall through to their null defaults.
 * NOTE: the LLM key is NOT sent here — binding the secret is a separate, explicit
 * step (POST /secret-handle) so the secret never rides along the hire request.
 * @returns body for POST /api/agents/hire
 */
export function buildHirePayload(f) {
  return {
    position_id: str(f.position_id),
    slug: str(f.slug),
    display_name: str(f.display_name).trim(),
  };
}

// ---------------------------------------------------------------------------
// Bind-LLM validation + payload  (POST /api/agents/:id/secret-handle)
// ---------------------------------------------------------------------------

/**
 * Classify a bind value the way the backend does. Returns null when acceptable,
 * else a reject reason CODE (matches src/core/secret-handle-validator.ts order):
 *   'too_short' | 'vendor_key_prefix' | 'bare_hex_token' | 'jwt_shape'
 * @param {string} value
 * @returns {string|null}
 */
export function classifyHandle(value) {
  const v = str(value);
  if (v.length < 8) return 'too_short';
  for (const p of VENDOR_PREFIXES) if (v.startsWith(p)) return 'vendor_key_prefix';
  if (BARE_HEX_RE.test(v)) return 'bare_hex_token';
  if (JWT_RE.test(v)) return 'jwt_shape';
  return null;
}

/** Human-readable Russian message for a reject reason code. */
export function handleRejectMessage(reason) {
  switch (reason) {
    case 'too_short':
      return 'Слишком короткая ссылка-хэндл (минимум 8 символов).';
    case 'vendor_key_prefix':
      return 'Похоже на СЫРОЙ ключ провайдера (sk-/xai-/AIza). Вставьте ссылку-хэндл на секрет (например vault://… или env://…), а не сам ключ.';
    case 'bare_hex_token':
      return 'Похоже на сырой токен (длинная hex-строка). Вставьте ссылку-хэндл на секрет, а не сам ключ.';
    case 'jwt_shape':
      return 'Похоже на JWT-токен. Вставьте ссылку-хэндл на секрет, а не сам токен.';
    default:
      return 'Недопустимая ссылка-хэндл.';
  }
}

/**
 * Validate the "привязать LLM" form. The provider + model are metadata; the
 * handle is the security-sensitive field — it must be a REFERENCE, not a raw key.
 * @param {{provider?,model?,handle?}} f
 * @returns {{valid:boolean, errors:Record<string,string>}}
 */
export function validateBind(f) {
  const errors = {};
  if (str(f?.provider).length === 0) errors.provider = 'Выберите провайдера';
  const reason = classifyHandle(str(f?.handle));
  if (reason !== null) errors.handle = handleRejectMessage(reason);
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Build the POST /api/agents/:id/secret-handle body. ONLY { handle_value } is
 * sent — exactly the backend contract. The provider/model are NOT part of this
 * endpoint (they would be set at hire time via llm_endpoint/llm_model); this
 * call binds the SECRET HANDLE only, keeping the secret path narrow.
 * @returns body for POST /api/agents/:id/secret-handle
 */
export function buildBindPayload(f) {
  return { handle_value: str(f.handle) };
}

// ---------------------------------------------------------------------------
// Error mapping — honest surfacing of the agents + secret-handle contracts.
// ---------------------------------------------------------------------------

/**
 * Map an HTTP failure to an actionable Russian message + optional field anchor.
 * Covers the union of agents.ts (hire) and secret-handle.ts (bind) error codes.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @param {string} [entity] label for the generic fallback
 * @returns {{ field?: string, message: string }}
 */
export function mapAgentError(status, body, entity = 'операцию') {
  const obj = body && typeof body === 'object' ? body : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 400 && code === 'INVALID_HANDLE') {
    // serverMsg is a reason CODE (never the value) — translate to a human hint.
    return { field: 'handle', message: handleRejectMessage(serverMsg) };
  }
  if (status === 409) {
    return { field: 'slug', message: 'Слаг агента уже занят в этом тенанте.' };
  }
  if (status === 403) {
    return {
      message:
        'Недостаточно прав: подключать агента и привязывать LLM может только администратор с соответствующим грантом.',
    };
  }
  if (status === 404) {
    return { message: serverMsg || 'Агент не найден (возможно, в другом тенанте).' };
  }
  if (status === 401) {
    return { message: 'Сессия не авторизована — войдите заново.' };
  }
  if (status === 503) {
    return { message: serverMsg || 'Сервис временно недоступен (Keycloak/БД). Повторите позже.' };
  }
  if (status === 400) {
    return { message: serverMsg || 'Проверьте корректность полей.' };
  }
  return { message: serverMsg || `Не удалось выполнить ${entity} (HTTP ${status}).` };
}

// ---------------------------------------------------------------------------
// Display helpers — pure, used by the screen for honest rendering.
// ---------------------------------------------------------------------------

/**
 * Russian label for an AgentPublic.status. The backend derives status from
 * config (llm_bound), never from a secret.
 * @param {string} status
 */
export function statusLabel(status) {
  if (status === 'configured') return 'LLM привязана';
  return 'Нужна LLM';
}

/**
 * agentStatusBadge — T-0655 (§6.4/§1C): collapse an agent's repeated degradations
 * ("должность не назначена" + "нет LLM", once per card ×N) into ONE status badge
 * descriptor. Returns { tone, label, issues } where:
 *   - issues[] is the ordered list of gaps that block the agent from working, each
 *     { key, label, action } — the .jsx renders one on-the-spot action per issue.
 *   - tone/label: 'ok'+'готов' when nothing blocks; 'warn'+the joined gaps otherwise.
 *
 * A system/assistant agent (has_org_place=false) legitimately has NO org-place —
 * that is architectural (migration 093), NOT a degradation — so it does NOT get an
 * "assign position" issue; it is labelled honestly as вне оргструктуры without a CTA.
 *
 * @param {{ has_org_place?: boolean, agent_type?: string, llm_bound?: boolean, position?: string|null }} agent
 * @returns {{ tone: 'ok'|'warn', label: string, issues: Array<{key:string,label:string,action:string}> }}
 */
export function agentStatusBadge(agent) {
  const issues = [];
  const isWorkforce = Boolean(agent && agent.has_org_place);
  // Only a workforce agent (org-attached) can be "not on a position"; a system/
  // assistant agent is off-org by design and is not flagged.
  if (isWorkforce && !agent.position) {
    issues.push({ key: 'position', label: 'нет должности', action: 'Назначить должность' });
  }
  if (!agent || !agent.llm_bound) {
    issues.push({ key: 'llm', label: 'нет LLM', action: 'Привязать LLM' });
  }
  if (issues.length === 0) {
    return { tone: 'ok', label: 'готов', issues: [] };
  }
  return { tone: 'warn', label: issues.map((i) => i.label).join(' · '), issues };
}

/**
 * Human label for the agent function taxonomy (migration 093 / T-0473).
 *   workforce → исполнитель задач в оргструктуре (имеет оргместо)
 *   system    → действует над платформой (конфигуратор, доки, внедрение)
 *   assistant → общий чат-помощник тенанта
 * Unknown / missing → 'Агент' (defensive; never throws).
 * @param {string} agentType one of 'workforce' | 'system' | 'assistant'
 * @returns {string} short Russian label for the registry badge
 */
export function agentTypeLabel(agentType) {
  switch (agentType) {
    case 'workforce': return 'Рабочий';
    case 'system': return 'Системный';
    case 'assistant': return 'Ассистент';
    default: return 'Агент';
  }
}

/**
 * Human display name for an agent — strips the provisioning marker that leaks
 * into seeded display_name values ("Config-агент (seed)", "Агент-документатор
 * (seed)") so the user never sees the "(seed)" dev-jargon (principles.md §3,
 * audit finding #6). Underlying id/slug are untouched — only the VISIBLE label
 * is cleaned. Tolerates English/Cyrillic spelling and trailing whitespace.
 * @param {string} name raw display_name from GET /api/agents
 * @returns {string} cleaned label (falls back to the trimmed input if nothing to strip)
 */
export function displayAgentName(name) {
  const raw = str(name).trim();
  // Strip a trailing "(seed)" / "(сид)" provisioning marker (case-insensitive),
  // optionally preceded by whitespace; collapse the leftover trailing space.
  const cleaned = raw.replace(/\s*\((?:seed|сид)\)\s*$/i, '').trim();
  return cleaned.length > 0 ? cleaned : raw;
}

/**
 * Build the position dropdown options from a GET /api/org/tenant-state positions
 * array. Returns [{ id, label }]. Defensive against missing fields.
 * @param {Array<{id?:string, slug?:string, title?:string}>} rows
 * @returns {Array<{id:string,label:string}>}
 */
export function positionOptions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.id === 'string' && r.id.length > 0)
    .map((r) => ({
      id: r.id,
      label: str(r.title) || str(r.slug) || r.id,
    }));
}

// ---------------------------------------------------------------------------
// T-0498 — LLM-connection selector (PUT /api/agents/:id/llm-connection)
//
// WIRED CONTRACTS (exact, read from src/http/agents.ts + src/http/llm-connections.ts):
//   GET /api/llm-connections                      → 200 { connections: [{id,name,provider,model,...}] }
//   PUT /api/agents/:id/llm-connection            { llm_connection_id: string|null } → 200
//                                                   { ok:true, llm_connection_id, connection_summary? }
//
// The connection carries the agent's LLM endpoint + (server-side) key handle. The
// raw key NEVER travels: this dropdown only ever sends a connection id (a UUID) or
// null (detach). The server resolves both agent and connection inside the actor's
// tenant, so a foreign id → 400 (honest error, no rebind).
// ---------------------------------------------------------------------------

/**
 * Build the dropdown options from a GET /api/llm-connections `connections` array.
 * Returns [{ id, label }] where label = "Имя · провайдер · модель" (provider/model
 * appended only when present). Defensive against missing fields / non-arrays.
 * @param {Array<{id?:string,name?:string,provider?:string,model?:string}>} rows
 * @returns {Array<{id:string,label:string}>}
 */
export function connectionOptions(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.id === 'string' && r.id.length > 0)
    .map((r) => {
      const name = str(r.name) || r.id;
      const provider = str(r.provider);
      const model = str(r.model);
      const tail = [provider, model].filter((x) => x.length > 0).join(' · ');
      return { id: r.id, label: tail ? `${name} · ${tail}` : name };
    });
}

/**
 * Build the PUT /api/agents/:id/llm-connection body. An empty/falsy selection maps
 * to null (detach) — exactly the backend contract (UUID | null).
 * @param {string} connectionId selected connection id, or '' for "not set"
 * @returns {{ llm_connection_id: string|null }}
 */
export function buildLlmConnectionPayload(connectionId) {
  const id = str(connectionId);
  return { llm_connection_id: id.length > 0 ? id : null };
}

/**
 * Map a PUT /api/agents/:id/llm-connection failure to an actionable Russian
 * message. Covers the route's error codes (agents.ts handleSetAgentLlmConnection):
 *   400 LLM_CONNECTION_NOT_FOUND / VALIDATION, 401, 403 ADMIN_GATE_REJECTED, 404.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {string}
 */
export function mapLlmConnectionError(status, body) {
  const obj = body && typeof body === 'object' ? body : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 400 && code === 'LLM_CONNECTION_NOT_FOUND') {
    return 'Подключение не найдено в вашем тенанте. Обновите список и выберите своё подключение.';
  }
  if (status === 400) {
    return serverMsg || 'Проверьте выбор подключения.';
  }
  if (status === 401) return 'Сессия не авторизована — войдите заново.';
  if (status === 403) {
    return 'Недостаточно прав: привязывать LLM-подключение к агенту может только администратор с грантом управления агентами.';
  }
  if (status === 404) return 'Агент не найден (возможно, в другом тенанте).';
  return serverMsg || `Не удалось сохранить LLM-подключение (HTTP ${status}).`;
}

// ---------------------------------------------------------------------------
// T-0499 — Agent ACTIVITY panel (GET /api/agents/:id/activity)
//
// WIRED CONTRACT (exact, read from src/http/agents.ts handleGetAgentActivity +
// src/db/agent-activity-dao.ts):
//   GET /api/agents/:id/activity?limit=&cursor=
//     → 200 { items: [{ id, ts, outcome, process_key?, step?, instance_id?, summary? }],
//             nextCursor: string|null }
//
// outcome ∈ 'proceeded' | 'deferred' | 'blocked'. The backend ALREADY redacts:
// no raw payload, no secret, no LLM text — only the safe allow-list above. This
// module just maps the outcome to a human chip + label, and ts to a human time.
// ---------------------------------------------------------------------------

/**
 * Map an agent outcome to a StatusChip `status` + a human Russian label.
 *   proceeded → done    («Выполнил сам»)
 *   deferred  → waiting («Отложил человеку»)
 *   blocked   → failed  («Заблокирован»)
 * Unknown / missing → neutral ('paused' chip, 'Событие').
 * @param {string} outcome
 * @returns {{ chip: string, label: string }}
 */
export function outcomeMeta(outcome) {
  switch (outcome) {
    case 'proceeded':
      return { chip: 'done', label: 'Выполнил сам' };
    case 'deferred':
      return { chip: 'waiting', label: 'Отложил человеку' };
    case 'blocked':
      return { chip: 'failed', label: 'Заблокирован' };
    default:
      return { chip: 'paused', label: 'Событие' };
  }
}

/**
 * Human, locale-formatted time for an activity event ts (epoch ms). Returns ''
 * for a missing / non-finite ts (honest blank, never "Invalid Date").
 * @param {number} ts epoch ms
 * @returns {string}
 */
export function formatActivityTime(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleString('ru-RU');
  } catch {
    return '';
  }
}

/**
 * Build a short context line for an activity item: «процесс · шаг» (only the
 * parts that are present). Returns '' when neither process nor step is known.
 * process_key / step / instance_id are SAFE identifiers (server-redacted).
 * @param {{process_key?:string, step?:string}} item
 * @returns {string}
 */
export function activityContext(item) {
  const proc = str(item?.process_key);
  const step = str(item?.step);
  return [proc, step].filter((x) => x.length > 0).join(' · ');
}

/**
 * Map a GET /api/agents/:id/activity failure to a human Russian message.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {string}
 */
export function mapActivityError(status, body) {
  const obj = body && typeof body === 'object' ? body : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;
  if (status === 401) return 'Сессия не авторизована — войдите заново.';
  if (status === 403) {
    return 'Недостаточно прав: смотреть активность агента может только администратор с грантом управления агентами.';
  }
  if (status === 404) return 'Агент не найден (возможно, в другом тенанте).';
  return serverMsg || `Не удалось загрузить активность агента (HTTP ${status}).`;
}

// ---------------------------------------------------------------------------
// T-0637 — Agent COMPETENCE INSTRUCTION (GET/PUT /api/agents/:id/instruction +
// publish via the existing POST /api/artifacts/:id/promote).
//
// WIRED CONTRACT (exact, read from src/http/agents.ts
// handleGetAgentInstruction / handleSetAgentInstruction):
//   GET /api/agents/:id/instruction
//     → 200 { employee_id, text: string|null, tier: 'draft'|'published'|null,
//             instruction_id: string|null }
//   PUT /api/agents/:id/instruction  { text: string }
//     → 200 { employee_id, instruction_id, tier: 'draft' }
//     → 409 PUBLISHED_LOCKED  (existing row is published — save a new draft
//                              cannot overwrite it directly)
// Publish: POST /api/artifacts/:instruction_id/promote { artifact_table: 'agent_instruction' }
//   → 200 { promoted:true, artifact_id, artifact_table, tier:'published' }
//   → 409 NOT_IN_DRAFT (already published)
//   → 403 NO_PROMOTE_GRANT (actor lacks mgmt_object:tier_promote authority)
// ---------------------------------------------------------------------------

/**
 * Map a GET/PUT /api/agents/:id/instruction failure to a human Russian message.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {string}
 */
export function mapAgentInstructionError(status, body) {
  const obj = body && typeof body === 'object' ? body : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 409 && code === 'PUBLISHED_LOCKED') {
    return 'Инструкция опубликована — измените и сохраните новый черновик поверх, затем опубликуйте снова.';
  }
  if (status === 400) return serverMsg || 'Проверьте текст инструкции.';
  if (status === 401) return 'Сессия не авторизована — войдите заново.';
  if (status === 403) {
    return 'Недостаточно прав: задавать инструкцию агенту может только администратор с грантом управления агентами.';
  }
  if (status === 404) return 'Агент не найден (возможно, в другом тенанте).';
  return serverMsg || `Не удалось сохранить инструкцию агента (HTTP ${status}).`;
}

/**
 * Map a POST /api/artifacts/:id/promote failure (publishing an agent instruction)
 * to a human Russian message.
 * @param {number} status
 * @param {unknown} body parsed JSON (may be null/non-object)
 * @returns {string}
 */
export function mapAgentInstructionPromoteError(status, body) {
  const obj = body && typeof body === 'object' ? body : undefined;
  const code = obj ? (obj.error?.code || obj.code) : undefined;
  const serverMsg = obj ? (obj.error?.message || obj.message) : undefined;

  if (status === 409 && code === 'NOT_IN_DRAFT') {
    return 'Инструкция уже опубликована.';
  }
  if (status === 403 && code === 'NO_PROMOTE_GRANT') {
    return 'Недостаточно прав для публикации: нужен грант продвижения артефактов (tier_promote).';
  }
  if (status === 403 && code === 'FORBIDDEN_AGENT_SELF_PROMOTE') {
    return 'Агенты не могут публиковать инструкцию сами — нужен человек-администратор.';
  }
  if (status === 401) return 'Сессия не авторизована — войдите заново.';
  if (status === 404) return 'Черновик инструкции не найден — сохраните его заново и повторите публикацию.';
  return serverMsg || `Не удалось опубликовать инструкцию (HTTP ${status}).`;
}
