/**
 * src/keycloak/admin-port.ts — T-0042 (E5.2) + T-0342 (E14) + T-0470: Live Keycloak Admin REST adapter.
 *
 * Implements KeycloakAdminPort against the Keycloak Admin REST API:
 *   - Obtains an admin token via client_credentials using choros-registrar (T-0470).
 *   - POST /admin/realms/<realm>/clients — creates the confidential OIDC client
 *     with serviceAccountsEnabled:true, directAccessGrantsEnabled:false.
 *   - Sets actor_type=agent attribute on the auto-created service-account user.
 *   - DELETE /admin/realms/<realm>/clients/<id> — best-effort orphan cleanup (NF-4).
 *
 * T-0342 adds KeycloakUserPort — human user management via a registrar service-account:
 *   - createHumanUser: POST /admin/realms/<realm>/users with actor_type=["human"] + password (FF-3)
 *   - deleteUser: DELETE /admin/realms/<realm>/users/<id> — best-effort compensation (FF-2)
 *
 * T-0470 (admin-port fix — Option A, least-change):
 *   Admin operations (createServiceAccountClient / deleteClient) now use the SAME
 *   choros-registrar confidential client that handles human-user creation. The
 *   realm-choros.json fixture grants choros-registrar's service-account the
 *   manage-clients role (in addition to existing manage-users/view-users) so one
 *   client_credentials flow covers both operations. Previously resolveConfig()
 *   defaulted to "admin-cli" (a public client) which KC rejects with
 *   "unauthorized_client" on service-account token requests.
 *
 * Credentials read from environment variables (NF-6):
 *   KEYCLOAK_BASE_URL          — e.g. http://localhost:8080
 *   KEYCLOAK_REALM             — e.g. choros
 *   KC_REGISTRAR_CLIENT_ID     — confidential client used for ALL admin ops (default: choros-registrar)
 *   KC_REGISTRAR_CLIENT_SECRET — its client_secret (DEV fixture only, RL-1)
 *   KEYCLOAK_DEV_CLIENT_SECRET — optional dev secret stamped on newly created agent clients
 *
 * No production secrets are committed here (NF-6 / RL-1).
 *
 * This file is SEPARATE from src/core/agent-hire.ts so the pure core never
 * imports http (AC-16 / NF-7 / FF-HIRE-6).
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import type { KeycloakAdminPort, KcClientSpec } from "../core/agent-hire.js";

// ---------------------------------------------------------------------------
// T-0342: KeycloakUserPort — human user management via registrar service-account
// ---------------------------------------------------------------------------

/** Specification for creating a human user in Keycloak (T-0342 / FF-3). */
export interface KcHumanUserSpec {
  // T-0628: `username` is free-form (a non-email login, e.g. `ivan.petrov`,
  // is legitimate) and DISTINCT from `email` — the caller (user-mgmt.ts) no
  // longer duplicates the same value into both fields (T-0583/T-0625 history).
  username: string;
  email: string;
  password: string;
  actorType: "human";  // MANDATORY: verifyClaims checks for actor_type (FF-3)
  /**
   * T-0741 (follow-up on T-0734 §5): the caller's free-text display name
   * (e.g. "Иван Петров"), used ONLY to derive Keycloak's firstName/lastName
   * (see splitDisplayName below) — NOT stored verbatim as a KC attribute.
   * OPTIONAL and back-compat: omitted/empty means createHumanUser sends no
   * firstName/lastName at all (prior behavior, unchanged) — this is what
   * src/core/register.ts (self-registration, no real name collected — its
   * `display_name` is the email address itself) still does; splitting an
   * email would be nonsense. src/http/user-mgmt.ts's POST /api/users DOES
   * pass it (the "Создать учётку" form already collects a real display name
   * — reusing it costs the caller nothing extra to type).
   */
  displayName?: string;
}

// ---------------------------------------------------------------------------
// T-0741: derive Keycloak firstName/lastName from a free-text display name.
// ---------------------------------------------------------------------------

/**
 * splitDisplayName — T-0741 (follow-up on T-0734 §5 "out of scope" finding):
 * derive Keycloak firstName/lastName from the SAME free-text `display_name`
 * already collected by the "Создать учётку" form (web/src/screens/screen-users.jsx)
 * — no second name field, no second typing pass (less friction beats a
 * "technically correct" split of an inherently ambiguous free-text name).
 *
 * WHY this matters (proven LIVE against KC 25.0.6, container t-0633-keycloak-1,
 * 2026-07-10 — see docs/live-proof/T-0741-firstname-lastname.live-proof.md):
 * config/keycloak/realm-choros.json's declarative user profile keeps
 * firstName/lastName `required.roles:["user"]` — the unmodified KC-25 default,
 * untouched by T-0734. `createHumanUser` previously sent NEITHER. This is NOT
 * just an extra browser screen: a user created without them gets
 * `POST /protocol/openid-connect/token grant_type=password` → `400
 * invalid_grant "Account is not fully set up"` — KC refuses to issue ANY
 * token (direct grant OR, per T-0734's own note, an interactive VERIFY_PROFILE
 * detour on the browser flow) until the required attributes are filled.
 * Populating both fields at create time removes the gap outright.
 *
 * Convention (matches this codebase's OWN seed data, migrations/016_employee.sql
 * — e.g. slug=`e-petrov`: KC firstName="И." lastName="Петров", employee
 * display_name="И. Петров"): the FIRST whitespace-separated token is
 * firstName, the REMAINDER (rejoined with single spaces) is lastName. A name
 * with no space (one token) is duplicated into BOTH fields — KC requires
 * firstName AND lastName to be independently non-empty; leaving either blank
 * still trips the same "Account is not fully set up" gap this fix closes. An
 * empty/whitespace-only input (should not happen — user-mgmt.ts's
 * validateCreateBody already rejects an empty display_name before this point)
 * returns `{firstName:"", lastName:""}` so the caller can detect it and omit
 * both rather than send KC a rejected empty required field.
 *
 * No transliteration, no case-folding, no script assumption — Cyrillic,
 * Latin, mixed, hyphenated, or apostrophe'd names all pass through unchanged
 * (KC's own `person-name-prohibited-characters` validator is the authority on
 * what characters are legal, not this function; T-0741 anti-case: a name
 * containing characters KC itself rejects still surfaces as KC's own 400, not
 * a silent local mutation).
 */
export function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const normalized = displayName.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return { firstName: "", lastName: "" };
  const spaceIdx = normalized.indexOf(" ");
  if (spaceIdx === -1) return { firstName: normalized, lastName: normalized };
  return {
    firstName: normalized.slice(0, spaceIdx),
    lastName: normalized.slice(spaceIdx + 1),
  };
}

/**
 * Port for managing human users in Keycloak (T-0342).
 * Live implementation: makeHttpKeycloakUserPort.
 * Test/dev fake implementation: InMemoryKeycloakUserPort (fake-user-port.ts).
 */
export interface KeycloakUserPort {
  /**
   * Create a human user in Keycloak.
   * Sets actor_type=["human"] attribute so verifyClaims passes (FF-3).
   * Throws err.code="EMAIL_TAKEN" if the email already exists, or
   *   err.code="LOGIN_TAKEN" if the USERNAME/login already exists (T-0633
   *   round-3 — KC returns 409 for both; the caller maps LOGIN_TAKEN to a
   *   "login is taken" message and EMAIL_TAKEN to "email is taken"). A 409 body
   *   that cannot be disambiguated defaults to EMAIL_TAKEN (prior behavior).
   * Throws HttpError(400, "EMAIL_INVALID") if email is not a valid email
   *   address (T-0625 fix: KC rejects a non-email `email` with its own 400 —
   *   this must surface as an honest 400, NOT be folded into
   *   AUTH_UNAVAILABLE/503 like every other non-201/409 status). T-0628:
   *   `username` is free-form and NOT subject to this check.
   * Throws err.code="NAME_INVALID_CHARACTERS" (T-0748) if `displayName`
   *   produced a firstName/lastName Keycloak rejects for containing
   *   characters its `person-name-prohibited-characters` validator forbids
   *   (e.g. "Bot #1", "A&B") — disambiguated from EMAIL_INVALID by the KC
   *   error body's field-level messageKey so the owner is told the NAME is
   *   the problem, not the (perfectly valid) email.
   * Throws err.code="NAME_TOO_LONG" (T-0762, follow-up on T-0748's own R-2
   *   review finding) if `displayName` produced a firstName/lastName
   *   Keycloak rejects for exceeding its declarative `length:{max:255}`
   *   validator (messageKey `error-invalid-length-too-long`) — the sibling
   *   class T-0748 explicitly scoped out, disambiguated the same way.
   * Throws HttpError(503, "AUTH_UNAVAILABLE") if KC is unreachable.
   */
  createHumanUser(spec: KcHumanUserSpec): Promise<{ userId: string }>;
  /**
   * Delete a user by KC user UUID — best-effort compensation (FF-2).
   * Swallows all errors (orphan cleanup; called only on DB failure after KC create).
   */
  deleteUser(userId: string): Promise<void>;
  /**
   * T-0583: enable/disable a human user's Keycloak login (account
   * deactivation/reactivation) — PUT /admin/realms/<realm>/users/<userId>
   * {enabled}. A disabled user cannot obtain a new token (KC rejects auth at
   * the realm level regardless of role assignments). Throws
   * HttpError(503, "AUTH_UNAVAILABLE") if KC is unreachable — callers must
   * NOT flip the local `employee.deactivated_at` marker on failure (KC-first).
   */
  setUserEnabled(userId: string, enabled: boolean): Promise<void>;
  /**
   * T-0702 (ADR-T0702, followup on T-0658 §9 / T-0662 §3.7's own acknowledged
   * gap): revoke all LIVE Keycloak sessions for a user — POST
   * /admin/realms/<realm>/users/<userId>/logout. `setUserEnabled(false)`
   * only blocks a NEW token from being issued; an already-issued access
   * token stays cryptographically valid until its own exp (minutes). This
   * call shrinks that AUTHENTICATION window by killing the SSO session and
   * refresh tokens immediately.
   *
   * BEST-EFFORT BY DESIGN (ADR §2.2) — the AUTHORIZATION side is already
   * closed unconditionally by the T-0658/T-0662 `ACTOR_ACTIVE_SQL` resolver
   * gate regardless of whether this call succeeds; this is a defense-in-depth
   * window-shrink, not a security gate. NEVER throws — any failure (network,
   * non-2xx, KC down) is caught INSIDE the implementation and surfaces as
   * `{revoked:false}` so the caller can record the outcome in an audit event
   * without the deactivation request itself failing.
   */
  revokeUserSessions(userId: string): Promise<{ revoked: boolean }>;
}

// ---------------------------------------------------------------------------
// Config (agent-admin port — existing)
// ---------------------------------------------------------------------------

export interface KcAdminConfig {
  baseUrl: string;        // e.g. "http://localhost:8080"
  realm: string;          // e.g. "choros"
  adminClient: string;    // client_id for admin token request — MUST be a confidential client
                          // with serviceAccountsEnabled + manage-clients role (T-0470)
  adminSecret: string;    // client_secret for the confidential client
  devSecret?: string;     // optional dev client secret to set on created clients
}

/**
 * resolveConfig — T-0470 fix: reads choros-registrar credentials (confidential,
 * serviceAccountsEnabled, manage-clients role) instead of the former admin-cli
 * default which is a public client and cannot obtain a service-account token.
 *
 * Env vars: KC_REGISTRAR_CLIENT_ID / KC_REGISTRAR_CLIENT_SECRET (both already
 * injected into the app container by docker-compose via app-env).
 */
function resolveConfig(): KcAdminConfig {
  return {
    baseUrl: process.env["KEYCLOAK_BASE_URL"] ?? "http://localhost:8080",
    realm: process.env["KEYCLOAK_REALM"] ?? "choros",
    adminClient: process.env["KC_REGISTRAR_CLIENT_ID"] ?? "choros-registrar",
    adminSecret: process.env["KC_REGISTRAR_CLIENT_SECRET"] ?? "",
    devSecret: process.env["KEYCLOAK_DEV_CLIENT_SECRET"],
  };
}

// ---------------------------------------------------------------------------
// Minimal fetch helper (stdlib only — no node-fetch / axios)
// ---------------------------------------------------------------------------

function doRequest(
  url: string,
  method: string,
  body: string | null,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...headers,
          ...(body !== null ? { "Content-Length": Buffer.byteLength(body).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Admin token acquisition
// ---------------------------------------------------------------------------

/**
 * extractKcErrorMessage — pull Keycloak's human error string out of a JSON error
 * body ({"errorMessage":"User exists with same username"} or {"error":"..."})
 * for the 409 username-vs-email disambiguation (T-0633 round-3). Returns "" when
 * the body is empty or not JSON — the caller then falls back to EMAIL_TAKEN, so
 * a parse miss NEVER changes behavior (it stays the prior default).
 */
function extractKcErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const j = JSON.parse(body) as { errorMessage?: unknown; error?: unknown };
    if (typeof j.errorMessage === "string") return j.errorMessage;
    if (typeof j.error === "string") return j.error;
    return "";
  } catch {
    return "";
  }
}

/** One field-level validation failure from Keycloak's declarative user-profile validator. */
interface KcFieldError {
  field?: string;
  errorMessage?: string;
}

/**
 * extractKcFieldErrors — T-0748 (NF-1 from T-0741's own review): parse Keycloak's
 * declarative-user-profile 400 body for the field-level validator that failed,
 * so createHumanUser's 400 branch (below) can tell a firstName/lastName
 * character-validator rejection apart from a genuine bad `email`.
 *
 * LIVE-CONFIRMED shapes (KC 25.0.6, local `t-0633-keycloak-1`, 2026-07-11 —
 * see the T-0748 spec for the full transcript):
 *   Single field failing:
 *     {"field":"lastName","errorMessage":"error-person-name-invalid-character","params":["lastName"]}
 *   Multiple fields failing (e.g. email AND firstName both bad in the same request):
 *     {"errors":[{"field":"email","errorMessage":"error-invalid-email",...},
 *                {"field":"firstName","errorMessage":"error-person-name-invalid-character",...}]}
 * Returns [] on an empty/unparseable/unrecognized body — the caller's default
 * (EMAIL_INVALID) is then used, so a parse miss NEVER changes behavior for any
 * body shape this function doesn't recognize (mirrors extractKcErrorMessage's
 * own safe-default contract just above).
 */
function extractKcFieldErrors(body: string): KcFieldError[] {
  if (!body) return [];
  try {
    const j = JSON.parse(body) as {
      field?: unknown;
      errorMessage?: unknown;
      errors?: unknown;
    };
    if (Array.isArray(j.errors)) {
      return j.errors
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({
          field: typeof e["field"] === "string" ? e["field"] : undefined,
          errorMessage: typeof e["errorMessage"] === "string" ? e["errorMessage"] : undefined,
        }));
    }
    if (typeof j.field === "string" || typeof j.errorMessage === "string") {
      return [
        {
          field: typeof j.field === "string" ? j.field : undefined,
          errorMessage: typeof j.errorMessage === "string" ? j.errorMessage : undefined,
        },
      ];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * T-0748: true iff the parsed field errors show a KC declarative user-profile
 * "person name" character-validator failure on firstName or lastName — the
 * SAME `person-name-prohibited-characters` validator realm-choros.json
 * declares (see splitDisplayName's own doc comment above), which KC's error
 * body names via the messageKey `error-person-name-invalid-character` (live-
 * confirmed). Matched by substring ("person-name") rather than the exact key
 * so a KC point-release that appends/reorders suffix text on the same
 * validator still matches — narrow enough that it can only fire on
 * firstName/lastName, never on `email` or any other field.
 */
function isPersonNameCharacterError(fieldErrors: KcFieldError[]): boolean {
  return fieldErrors.some(
    (fe) =>
      (fe.field === "firstName" || fe.field === "lastName") &&
      typeof fe.errorMessage === "string" &&
      fe.errorMessage.includes("person-name"),
  );
}

/**
 * T-0762 (R-2 follow-up from T-0748's own review): true iff the parsed field
 * errors show a KC declarative user-profile "length" validator failure on
 * firstName or lastName. LIVE-CONFIRMED against KC 25.0.6 (t-0633-keycloak-1,
 * :8180, 2026-07-13 — the same container/realm T-0748's own live probe used):
 *
 *   Only ONE field over the 255-char cap (e.g. a long first token, ordinary
 *   second token — realm-choros.json declares `"length":{"max":255}` on both
 *   firstName/lastName, see extractKcFieldErrors' own doc):
 *     {"field":"firstName","errorMessage":"error-invalid-length-too-long","params":["firstName",null,255]}
 *
 *   BOTH fields over the cap in the SAME request — reproduced with a
 *   single-token (no-space) displayName near DISPLAY_NAME_MAX=256
 *   (web/src/screens/users-form.js), which splitDisplayName (above) DUPLICATES
 *   into both firstName AND lastName when it contains no space:
 *     {"errors":[{"field":"lastName","errorMessage":"error-invalid-length-too-long","params":["lastName",null,255]},
 *                {"field":"firstName","errorMessage":"error-invalid-length-too-long","params":["firstName",null,255]}]}
 *
 * No orphan KC user was left behind by either probe (KC rolls the create back
 * on validation failure — confirmed via GET .../users?username=... after
 * each). Matched by substring ("invalid-length") for the same KC point-
 * release-drift tolerance as isPersonNameCharacterError; narrow enough it can
 * only fire on firstName/lastName, never on `email` or any other field. This
 * check MUST run alongside (not instead of) isPersonNameCharacterError — a KC
 * 400 can carry either failure class on the SAME two fields, and the two are
 * disambiguated into DISTINCT error codes (NAME_INVALID_CHARACTERS vs
 * NAME_TOO_LONG) so the owner sees the honest reason, not a generic one.
 */
function isPersonNameLengthError(fieldErrors: KcFieldError[]): boolean {
  return fieldErrors.some(
    (fe) =>
      (fe.field === "firstName" || fe.field === "lastName") &&
      typeof fe.errorMessage === "string" &&
      fe.errorMessage.includes("invalid-length"),
  );
}

async function getAdminToken(cfg: KcAdminConfig): Promise<string> {
  const tokenUrl = `${cfg.baseUrl}/realms/${cfg.realm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.adminClient,
    client_secret: cfg.adminSecret,
  }).toString();
  const resp = await doRequest(tokenUrl, "POST", body, {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (resp.status !== 200) {
    throw new Error(`KC admin token failed: ${resp.status} ${resp.body}`);
  }
  const json = JSON.parse(resp.body) as { access_token: string };
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Live adapter factory
// ---------------------------------------------------------------------------

/**
 * makeHttpKeycloakAdminPort — the live HTTP adapter implementing KeycloakAdminPort.
 * Reads config from environment variables unless overridden via cfg parameter.
 * Injected into registerAgentRoutes; unit tests use InMemoryKeycloakAdminPort instead.
 */
export function makeHttpKeycloakAdminPort(cfg?: KcAdminConfig): KeycloakAdminPort {
  const config = cfg ?? resolveConfig();

  return {
    async createServiceAccountClient(spec: KcClientSpec): Promise<{ clientId: string }> {
      const token = await getAdminToken(config);
      const clientsUrl = `${config.baseUrl}/admin/realms/${config.realm}/clients`;

      const clientBody: Record<string, unknown> = {
        clientId: spec.clientId,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        publicClient: false,
        protocol: "openid-connect",
        ...(config.devSecret !== undefined
          ? { secret: config.devSecret, clientAuthenticatorType: "client-secret" }
          : {}),
      };

      const createResp = await doRequest(
        clientsUrl,
        "POST",
        JSON.stringify(clientBody),
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      );

      if (createResp.status !== 201) {
        throw new Error(`KC create client failed: ${createResp.status} ${createResp.body}`);
      }

      // Keycloak returns Location: .../clients/<uuid>. Resolve the client UUID
      // so we can set the service-account user attribute.
      // We use the Location header path to extract the internal UUID,
      // then GET the client by clientId to confirm it was created.
      const getResp = await doRequest(
        `${clientsUrl}?clientId=${encodeURIComponent(spec.clientId)}`,
        "GET",
        null,
        { Authorization: `Bearer ${token}` },
      );
      if (getResp.status !== 200) {
        throw new Error(`KC get client failed: ${getResp.status} ${getResp.body}`);
      }
      const clients = JSON.parse(getResp.body) as Array<{ id: string; clientId: string }>;
      if (clients.length === 0) {
        throw new Error(`KC client ${spec.clientId} not found after create`);
      }
      const kcId = clients[0].id;

      // Set actor_type=agent on the service-account user (FR-3 / AC-4).
      const saUserUrl = `${config.baseUrl}/admin/realms/${config.realm}/clients/${kcId}/service-account-user`;
      const saResp = await doRequest(saUserUrl, "GET", null, {
        Authorization: `Bearer ${token}`,
      });
      if (saResp.status === 200) {
        const saUser = JSON.parse(saResp.body) as { id: string; attributes?: Record<string, unknown> };
        const userId = saUser.id;
        // PATCH the user attributes to add actor_type=agent
        const updateUserUrl = `${config.baseUrl}/admin/realms/${config.realm}/users/${userId}`;
        const attributes = { ...(saUser.attributes ?? {}), actor_type: ["agent"] };
        await doRequest(
          updateUserUrl,
          "PUT",
          JSON.stringify({ ...saUser, attributes }),
          { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        );
      }

      return { clientId: spec.clientId };
    },

    async deleteClient(clientId: string): Promise<void> {
      try {
        const token = await getAdminToken(config);
        const clientsUrl = `${config.baseUrl}/admin/realms/${config.realm}/clients`;
        // Find the internal KC UUID first
        const getResp = await doRequest(
          `${clientsUrl}?clientId=${encodeURIComponent(clientId)}`,
          "GET",
          null,
          { Authorization: `Bearer ${token}` },
        );
        if (getResp.status !== 200) return; // best-effort: not found = already gone
        const clients = JSON.parse(getResp.body) as Array<{ id: string }>;
        if (clients.length === 0) return;
        const kcId = clients[0].id;
        await doRequest(`${clientsUrl}/${kcId}`, "DELETE", null, {
          Authorization: `Bearer ${token}`,
        });
      } catch {
        // Best-effort: swallow errors on orphan cleanup (NF-4)
      }
    },
  };
}

// ---------------------------------------------------------------------------
// T-0342: Registrar config + live KeycloakUserPort factory
// ---------------------------------------------------------------------------

export interface KcRegistrarConfig {
  baseUrl: string;         // e.g. "http://keycloak:8180"
  realm: string;           // e.g. "choros"
  clientId: string;        // KC_REGISTRAR_CLIENT_ID
  clientSecret: string;    // KC_REGISTRAR_CLIENT_SECRET
}

function resolveRegistrarConfig(): KcRegistrarConfig {
  return {
    baseUrl: process.env["KEYCLOAK_BASE_URL"] ?? "http://localhost:8080",
    realm: process.env["KEYCLOAK_REALM"] ?? "choros",
    clientId: process.env["KC_REGISTRAR_CLIENT_ID"] ?? "choros-registrar",
    clientSecret: process.env["KC_REGISTRAR_CLIENT_SECRET"] ?? "",
  };
}

async function getRegistrarToken(cfg: KcRegistrarConfig): Promise<string> {
  const tokenUrl = `${cfg.baseUrl}/realms/${cfg.realm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }).toString();
  const resp = await doRequest(tokenUrl, "POST", body, {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (resp.status !== 200) {
    const err = new Error(`KC registrar token failed: ${resp.status} ${resp.body}`);
    (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
    throw err;
  }
  const json = JSON.parse(resp.body) as { access_token: string };
  return json.access_token;
}

/**
 * makeHttpKeycloakUserPort — live HTTP adapter implementing KeycloakUserPort (T-0342).
 * Uses the choros-registrar service-account (realm-internal client_credentials —
 * no master-realm admin required). Reads config from env unless cfg is provided.
 */
export function makeHttpKeycloakUserPort(cfg?: KcRegistrarConfig): KeycloakUserPort {
  const config = cfg ?? resolveRegistrarConfig();

  return {
    async createHumanUser(spec: KcHumanUserSpec): Promise<{ userId: string }> {
      let token: string;
      try {
        token = await getRegistrarToken(config);
      } catch {
        const err = new Error("AUTH_UNAVAILABLE");
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }

      const usersUrl = `${config.baseUrl}/admin/realms/${config.realm}/users`;

      const userBody: Record<string, unknown> = {
        username: spec.username,
        email: spec.email,
        enabled: true,
        emailVerified: true,
        attributes: {
          actor_type: ["human"],   // MANDATORY for verifyClaims (FF-3)
        },
        credentials: [
          {
            type: "password",
            value: spec.password,
            temporary: false,
          },
        ],
      };

      // T-0741: derive firstName/lastName from spec.displayName when the
      // caller provided one (see splitDisplayName above + KcHumanUserSpec
      // doc). Omitted when displayName is absent/blank — preserves the prior
      // wire shape exactly for callers that don't pass it (register.ts).
      if (spec.displayName !== undefined && spec.displayName.trim().length > 0) {
        const { firstName, lastName } = splitDisplayName(spec.displayName);
        userBody["firstName"] = firstName;
        userBody["lastName"] = lastName;
      }

      const createResp = await doRequest(usersUrl, "POST", JSON.stringify(userBody), {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      });

      if (createResp.status === 409) {
        // T-0633 round-3 (minor): Keycloak returns 409 for BOTH a username
        // conflict AND an email conflict. Mapping every 409 to EMAIL_TAKEN
        // ("email already exists") is MISLEADING when the real clash is the
        // username/login — the owner is told to change the email while the
        // login is what's taken. KC's 409 body carries an `errorMessage` that
        // distinguishes them ("User exists with same username" vs "...same
        // email"). Parse it and surface LOGIN_TAKEN for a username clash;
        // DEFAULT to EMAIL_TAKEN when the body is absent/unparseable/ambiguous
        // (preserves the prior behavior — never a regression on the email path).
        const msg = extractKcErrorMessage(createResp.body).toLowerCase();
        const isUsernameClash = msg.includes("username");
        const code = isUsernameClash ? "LOGIN_TAKEN" : "EMAIL_TAKEN";
        const err = new Error(code);
        (err as NodeJS.ErrnoException).code = code;
        throw err;
      }
      // T-0625 fix (narrowed by T-0628): a real Keycloak realm rejects a
      // non-email `email` with 400 error-invalid-email. Before this fix, that
      // 400 fell through to the generic "createResp.status !== 201" branch
      // below and was mapped to AUTH_UNAVAILABLE — the caller (POST
      // /api/users) then returned 503 "account service unavailable" for what
      // is actually a client validation error. Surface it honestly as
      // EMAIL_INVALID (400) instead. (In practice user-mgmt.ts now validates
      // the email format BEFORE calling this port, so a real KC realm should
      // never reach this branch in the product's own flow — this is
      // defense-in-depth for any other caller of the port and for KC-side
      // validation drift. `username` is free-form since T-0628 and is not
      // expected to trigger this branch.)
      //
      // T-0748 (NF-1 from T-0741's own review): T-0741 started sending
      // firstName/lastName (derived from the caller's free-text
      // display_name), and Keycloak's declarative user-profile validates
      // BOTH with `person-name-prohibited-characters` (realm-choros.json).
      // A display_name with characters that validator rejects (e.g. "Bot #1",
      // "A&B") now ALSO produces a 400 from this same POST — but it is a
      // name-shape problem, not an email-shape one. Before this fix, EVERY
      // 400 here (including this new class) was folded into EMAIL_INVALID,
      // so user-mgmt.ts told the owner "email must be a valid email address"
      // for a perfectly valid email — a misattributed error pointing the
      // owner at the wrong field entirely. Disambiguate by the KC error
      // body's field-level messageKey (extractKcFieldErrors /
      // isPersonNameCharacterError above, LIVE-CONFIRMED against KC 25.0.6)
      // and surface the honest NAME_INVALID_CHARACTERS code instead. Any 400
      // that does NOT carry a firstName/lastName person-name error — an
      // actual bad email, an unparseable/empty body, or any other KC-side
      // validation drift — falls through to the EXACT prior default
      // (EMAIL_INVALID), so the existing email-error path is unchanged.
      // T-0762 (R-2 follow-up from T-0748's own review, filed as this task):
      // T-0748 fixed the CHARACTER-validator misattribution but explicitly
      // left the sibling LENGTH-validator class unhandled (spec.md §7 only
      // disclaimed re-implementing the character set, not the length cap).
      // A display_name near DISPLAY_NAME_MAX=256 with NO space (single
      // token) still trips KC's independent 255-char-per-field cap via
      // splitDisplayName's own documented duplication rule — and, before
      // this fix, fell to the SAME misleading EMAIL_INVALID default this
      // whole file exists to avoid. Checked ALONGSIDE (not instead of)
      // isPersonNameCharacterError — a firstName/lastName 400 is EITHER a
      // character problem OR a length problem, never both on the wire, but
      // both must be told apart from a genuine bad email.
      if (createResp.status === 400) {
        const fieldErrors = extractKcFieldErrors(createResp.body);
        if (isPersonNameCharacterError(fieldErrors)) {
          const err = new Error("NAME_INVALID_CHARACTERS");
          (err as NodeJS.ErrnoException).code = "NAME_INVALID_CHARACTERS";
          throw err;
        }
        if (isPersonNameLengthError(fieldErrors)) {
          const err = new Error("NAME_TOO_LONG");
          (err as NodeJS.ErrnoException).code = "NAME_TOO_LONG";
          throw err;
        }
        const err = new Error("EMAIL_INVALID");
        (err as NodeJS.ErrnoException).code = "EMAIL_INVALID";
        throw err;
      }
      if (createResp.status !== 201) {
        const err = new Error(`KC createHumanUser failed: ${createResp.status} ${createResp.body}`);
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }

      // GET the created user by username to obtain the KC user UUID (= future JWT sub)
      const searchResp = await doRequest(
        `${usersUrl}?username=${encodeURIComponent(spec.username)}&exact=true`,
        "GET",
        null,
        { Authorization: `Bearer ${token}` },
      );
      if (searchResp.status !== 200) {
        const err = new Error(`KC user lookup failed: ${searchResp.status} ${searchResp.body}`);
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }
      const users = JSON.parse(searchResp.body) as Array<{ id: string }>;
      if (users.length === 0) {
        const err = new Error("KC user not found after create");
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }
      return { userId: users[0].id };
    },

    async deleteUser(userId: string): Promise<void> {
      try {
        const token = await getRegistrarToken(config);
        const userUrl = `${config.baseUrl}/admin/realms/${config.realm}/users/${userId}`;
        await doRequest(userUrl, "DELETE", null, {
          Authorization: `Bearer ${token}`,
        });
      } catch {
        // Best-effort: swallow all errors (compensation only; FF-2)
      }
    },

    // T-0583: setUserEnabled — PUT user {enabled} via the SAME registrar token
    // path as createHumanUser/deleteUser (no second KC-integration module, N5).
    // Unlike deleteUser this is NOT best-effort: a failed disable must not be
    // masked as success (the caller decides deactivated_at only after this
    // resolves), so KC-unreachable surfaces as AUTH_UNAVAILABLE (503 at the
    // HTTP layer) rather than being swallowed.
    async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
      let token: string;
      try {
        token = await getRegistrarToken(config);
      } catch {
        const err = new Error("AUTH_UNAVAILABLE");
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }
      const userUrl = `${config.baseUrl}/admin/realms/${config.realm}/users/${userId}`;
      const resp = await doRequest(userUrl, "PUT", JSON.stringify({ enabled }), {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      });
      if (resp.status !== 204 && resp.status !== 200) {
        const err = new Error(`KC setUserEnabled failed: ${resp.status} ${resp.body}`);
        (err as NodeJS.ErrnoException).code = "AUTH_UNAVAILABLE";
        throw err;
      }
    },

    // T-0702 — POST /admin/realms/<realm>/users/<userId>/logout (live-confirmed
    // against t-0633-keycloak-1: 204 for an existing user, 404 for an unknown
    // one). Unlike setUserEnabled, this NEVER throws (ADR-T0702 §2.2 — the
    // caller's deactivation flow must not fail wholesale on a transient KC
    // hiccup at THIS step; setUserEnabled just above remains the hard gate).
    async revokeUserSessions(userId: string): Promise<{ revoked: boolean }> {
      try {
        const token = await getRegistrarToken(config);
        const logoutUrl = `${config.baseUrl}/admin/realms/${config.realm}/users/${userId}/logout`;
        const resp = await doRequest(logoutUrl, "POST", null, {
          Authorization: `Bearer ${token}`,
        });
        return { revoked: resp.status === 204 || resp.status === 200 };
      } catch {
        // Best-effort: any failure (network, KC down, unexpected status)
        // degrades to {revoked:false} — never propagates to the caller.
        return { revoked: false };
      }
    },
  };
}
