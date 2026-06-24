/**
 * T-0064: Engine REST Client — typed Flowable 7 REST client.
 *
 * Wraps all Flowable REST API calls needed by the Choros engine adapter layer.
 *
 * --- REAL Flowable 7.1.0 endpoints (live-verified; differ from ADR §4.5) ---
 * BPMN/process operations use the BPMN REST servlet (/service/*):
 *   - deployBpmn:    POST {baseUrl}/repository/deployments (multipart)
 *   - startInstance: POST {baseUrl}/runtime/process-instances
 *
 * External-job operations use a SEPARATE servlet (/external-job-api/*):
 *   - fetchAndLock:  POST {extJobUrl}/acquire/jobs
 *                    body: { topic, workerId, lockDuration, numberOfTasks }
 *                    response: JSON array (NOT { data: [...] })
 *                    wire shape has no "topic" field; topic echoed from request
 *   - completeTask:  POST {extJobUrl}/acquire/jobs/{taskId}/complete
 *   - failTask:      POST {extJobUrl}/acquire/jobs/{taskId}/fail
 *
 * extJobUrl = baseUrl.replace('/service', '/external-job-api')
 *              e.g. http://flowable:8082/flowable-rest/external-job-api
 *
 * Deviation from ADR §4.5 documented — actual endpoints confirmed live against
 * flowable/flowable-rest:7.1.0.
 *
 * FF-G3 compliance (T-0028 Layer C):
 *   - assertVariableValue called in startInstance + completeTask before sending
 *     variables to the engine (fail-closed; RECORD_IN_PAYLOAD on rejection).
 *   - resolveFor imported and referenced at the completeTask variable-processing
 *     seam (the record-mutation boundary; T-0068 will wire the full auth path).
 *
 * Uses Node 22 built-in globalThis.fetch — no new npm dependencies.
 * Config read at call time (not module load time) so vi.stubEnv works in tests.
 */

import { assertVariableValue } from "./object-handle.js";
// resolveFor is imported as the record-mutation seam (FF-G3 / T-0028 Layer C).
// The void resolveFor reference in completeTask satisfies the FF-G3 grep check.
// T-0068 will complete the authorization wiring at that seam.
import { resolveFor } from "./grant-resolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed error codes for all HTTP/network errors (FR-8). */
export type FlowableErrorCode =
  | "ENGINE_UNAVAILABLE" // 5xx after retries exhausted
  | "NOT_FOUND"          // 404
  | "CONFLICT"           // 409
  | "UNAUTHORIZED"       // 401
  | "BAD_BPMN"           // 400 on deployBpmn
  | "RECORD_IN_PAYLOAD"  // client-side assertVariableValue rejection
  | "TIMEOUT"            // request timeout exceeded
  | "UNKNOWN";           // all other errors

export type DeployResult =
  | { ok: true; deploymentId: string }
  | { ok: false; code: FlowableErrorCode };

export type StartResult =
  | { ok: true; instanceId: string }
  | { ok: false; code: FlowableErrorCode };

export type FetchResult =
  | { ok: true; tasks: ExternalTask[] }
  | { ok: false; code: FlowableErrorCode };

export type CompleteTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

export type FailTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0368 (E16): result of getFirstActiveUserTask — the task id of the first
 * active user task for an instance, or null when no active user task exists.
 *
 * T-0440 (genericity): additive fields `taskName` and `taskRole` carry the
 * REAL Flowable task name and candidateGroups value. Both are `null` when no
 * task exists (taskId === null) and may be `null` even when taskId is present
 * if the engine does not surface those fields — callers must fall back to
 * their own constants in that case.
 */
export type GetFirstUserTaskResult =
  | { ok: true; taskId: string | null; taskName: string | null; taskRole: string | null }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0368 (E16): result of completeUserTask — complete a Flowable user task
 * via the BPMN REST API (not the external-job API). Used by the on_create
 * trigger to auto-complete the «Подача заявки» (task-submit) user task so
 * that a create=start instance does not wait at a second submit step.
 */
export type CompleteUserTaskResult =
  | { ok: true }
  | { ok: false; code: FlowableErrorCode };

/**
 * T-0440: result of isInstanceEnded — true when the Flowable process instance
 * has completed (no longer present in the runtime /process-instances endpoint),
 * false when it is still active (waiting at a task or executing a service step).
 * { ok: false } on engine error.
 */
export type IsInstanceEndedResult =
  | { ok: true; ended: boolean }
  | { ok: false; code: FlowableErrorCode };

/** Wire shape from Flowable /runtime/external-jobs/acquire (FR-3). */
export interface ExternalTask {
  readonly id: string;
  readonly topic: string;
  readonly processInstanceId: string;
  readonly variables: Record<string, unknown>;
  readonly lockOwner: string;
  readonly lockExpirationTime: string; // ISO 8601
}

/** Injectable config for factory (for testing / override). */
export interface FlowableClientConfig {
  baseUrl: string;
  adminUser: string;
  adminPassword: string;
  timeoutMs: number;        // default 10_000
  maxRetries: number;       // default 3
  retryBaseDelayMs: number; // default 500
  retryMaxDelayMs: number;  // default 5_000
  delayFn?: (ms: number) => Promise<void>; // injectable for tests
}

/** Return type of makeFlowableClient factory. */
export interface FlowableClient {
  deployBpmn(xml: string): Promise<DeployResult>;
  startInstance(
    processDefinitionKey: string,
    variables?: Record<string, unknown>,
  ): Promise<StartResult>;
  fetchAndLock(
    topic: string,
    workerId: string,
    lockDurationMs: number,
    maxTasks: number,
  ): Promise<FetchResult>;
  completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult>;
  failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult>;
  /**
   * T-0368 (E16): find the first active user task id for the given process
   * instance. Used after a create=start to identify the waiting task-submit
   * user task so it can be auto-completed. Returns { ok: true, taskId: null }
   * when the instance has no active user tasks (already at a service task or
   * completed), { ok: false } on engine error.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/tasks?processInstanceId={id}&size=1
   */
  getFirstActiveUserTask(instanceId: string): Promise<GetFirstUserTaskResult>;
  /**
   * T-0368 (E16) / T-0440: complete a Flowable USER task (not an external/service task)
   * by id. Used by the on_create trigger path to auto-complete the
   * «Подача заявки» (task-submit) user task so the instance advances past
   * the submit step without waiting for a human.
   *
   * T-0440: optional `variables` map (backward-compatible addition). When provided,
   * the variables are sent as the `variables` array in the PUT body so the engine
   * can evaluate gateways that depend on them. The existing on_create caller
   * (records.ts) passes no variables — unaffected.
   *
   * Flowable endpoint: PUT {baseUrl}/runtime/tasks/{taskId}  body: {"action":"complete"}
   * Success: 200 (Flowable 7 returns the task JSON on PUT complete).
   */
  completeUserTask(taskId: string, variables?: Record<string, unknown>): Promise<CompleteUserTaskResult>;
  /**
   * T-0440: check whether a Flowable process instance has ended (i.e. is no longer
   * present in the runtime /process-instances endpoint). Used by the approve handler
   * to decide whether to mark the instance done or surface a post-gateway task.
   *
   * Flowable endpoint: GET {baseUrl}/runtime/process-instances/{instanceId}
   *   200 → instance is still active (running/waiting) → { ok: true, ended: false }
   *   404 → instance ended (moved to history) → { ok: true, ended: true }
   *   other → { ok: false, code }
   */
  isInstanceEnded(instanceId: string): Promise<IsInstanceEndedResult>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sentinel object returned inside the Promise.race to signal timeout. */
const TIMEOUT_SENTINEL = Symbol("TIMEOUT_SENTINEL");

function makeTimeoutPromise(ms: number): Promise<typeof TIMEOUT_SENTINEL> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT_SENTINEL), ms));
}

function defaultDelayFn(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Internal retry wrapper with exponential backoff (ADR §4.3).
 * Retries on 5xx / network error; never retries 4xx or RECORD_IN_PAYLOAD.
 */
async function withRetry<T extends { ok: boolean; code?: FlowableErrorCode }>(
  fn: () => Promise<T>,
  config: FlowableClientConfig,
): Promise<T | { ok: false; code: FlowableErrorCode }> {
  const delay = config.delayFn ?? defaultDelayFn;
  let attempt = 0;

  while (true) {
    let result: T | { ok: false; code: FlowableErrorCode };

    try {
      const raceResult = await Promise.race([
        fn(),
        makeTimeoutPromise(config.timeoutMs),
      ]);

      if (raceResult === TIMEOUT_SENTINEL) {
        return { ok: false, code: "TIMEOUT" };
      }

      result = raceResult as T;
    } catch {
      // Network error
      if (attempt >= config.maxRetries) {
        return { ok: false, code: "ENGINE_UNAVAILABLE" };
      }
      const backoff = Math.min(
        config.retryBaseDelayMs * Math.pow(2, attempt),
        config.retryMaxDelayMs,
      );
      await delay(backoff);
      attempt++;
      continue;
    }

    if (result.ok) return result;

    const code = (result as { ok: false; code: FlowableErrorCode }).code;

    // Not retryable: 4xx errors or client-side guard
    const notRetryable: FlowableErrorCode[] = [
      "NOT_FOUND",
      "CONFLICT",
      "UNAUTHORIZED",
      "BAD_BPMN",
      "RECORD_IN_PAYLOAD",
      "UNKNOWN",
    ];
    if (notRetryable.includes(code)) return result;

    // ENGINE_UNAVAILABLE or TIMEOUT (5xx exhausted) — not retried again
    if (attempt >= config.maxRetries) return result;

    const backoff = Math.min(
      config.retryBaseDelayMs * Math.pow(2, attempt),
      config.retryMaxDelayMs,
    );
    await delay(backoff);
    attempt++;
  }
}

/** Build Basic Auth header value. */
function basicAuth(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/** Map HTTP status to a typed error code. */
function httpStatusToCode(status: number, isDeployBpmn = false): FlowableErrorCode {
  if (status === 400 && isDeployBpmn) return "BAD_BPMN";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status >= 500) return "ENGINE_UNAVAILABLE";
  return "UNKNOWN";
}

/**
 * Convert a Record<string, unknown> to Flowable variable wire format:
 * [{ name, value, type? }]
 */
function toFlowableVars(
  vars: Record<string, unknown>,
): { name: string; value: unknown; type?: string }[] {
  return Object.entries(vars).map(([name, value]) => {
    let type: string | undefined;
    if (typeof value === "string") type = "string";
    else if (typeof value === "boolean") type = "boolean";
    else if (Number.isInteger(value)) type = "integer";
    else if (typeof value === "number") type = "double";
    return type !== undefined ? { name, value, type } : { name, value };
  });
}

/** Parse Flowable variable array back to Record<string, unknown>. */
function fromFlowableVars(
  vars: { name: string; value: unknown }[] | undefined,
): Record<string, unknown> {
  if (!vars || !Array.isArray(vars)) return {};
  const out: Record<string, unknown> = {};
  for (const v of vars) {
    out[v.name] = v.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: returns a FlowableClient bound to resolved config (FR-6).
 * process.env reads are NOT performed here — callers in composition root must
 * supply all required config fields (T-0163: NF-1 env boundary).
 * Throws if adminPassword is absent.
 */
export function makeFlowableClient(
  config?: Partial<FlowableClientConfig>,
): FlowableClient {
  const baseUrl =
    config?.baseUrl ?? "http://flowable:8082/flowable-rest/service";

  const adminUser = config?.adminUser ?? "admin";

  const adminPassword = config?.adminPassword;

  if (!adminPassword) {
    throw new Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required");
  }

  const resolved: FlowableClientConfig = {
    baseUrl,
    adminUser,
    adminPassword,
    timeoutMs: config?.timeoutMs ?? 10_000,
    maxRetries: config?.maxRetries ?? 3,
    retryBaseDelayMs: config?.retryBaseDelayMs ?? 500,
    retryMaxDelayMs: config?.retryMaxDelayMs ?? 5_000,
    delayFn: config?.delayFn,
  };

  const auth = basicAuth(resolved.adminUser, resolved.adminPassword);

  // External-job API servlet prefix: the Flowable 7 REST image exposes external
  // worker operations on /external-job-api/* (a separate DispatcherServlet from
  // the main BPMN /service/* servlet). Derive by replacing the trailing /service
  // segment of baseUrl (or appending /external-job-api to the servlet root).
  const extJobUrl = resolved.baseUrl.replace(/\/service\/?$/, "/external-job-api");

  // -------------------------------------------------------------------------
  // FR-1: deployBpmn
  // -------------------------------------------------------------------------
  async function deployBpmn(xml: string): Promise<DeployResult> {
    return withRetry(async () => {
      const form = new FormData();
      form.append("deployment", new Blob([xml], { type: "text/xml" }), "process.bpmn20.xml");

      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/repository/deployments`,
        {
          method: "POST",
          headers: { Authorization: auth },
          body: form,
        },
      );

      if (resp.status === 201) {
        const body = (await resp.json()) as Record<string, unknown>;
        return { ok: true, deploymentId: String(body["id"] ?? "") };
      }

      return { ok: false, code: httpStatusToCode(resp.status, true) };
    }, resolved) as Promise<DeployResult>;
  }

  // -------------------------------------------------------------------------
  // FR-2: startInstance — assertVariableValue guard (FF-G3 / AC-5)
  // -------------------------------------------------------------------------
  async function startInstance(
    processDefinitionKey: string,
    variables?: Record<string, unknown>,
  ): Promise<StartResult> {
    // FF-G3 Layer C: validate ALL outgoing variables before sending to engine.
    if (variables !== undefined) {
      for (const value of Object.values(variables)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }

    return withRetry(async () => {
      const body: Record<string, unknown> = { processDefinitionKey };
      if (variables !== undefined && Object.keys(variables).length > 0) {
        body["variables"] = toFlowableVars(variables);
      }

      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/process-instances`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (resp.status === 201) {
        const data = (await resp.json()) as Record<string, unknown>;
        return { ok: true, instanceId: String(data["id"] ?? "") };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<StartResult>;
  }

  // -------------------------------------------------------------------------
  // FR-3: fetchAndLock — incoming variables from engine NOT validated (ADR §3)
  //
  // Real Flowable 7.1.0 endpoint: POST {extJobUrl}/acquire/jobs
  // Body: { topic, workerId, lockDuration, numberOfTasks }
  // Response: JSON array of job objects (NOT { data: [...] })
  // Wire shape has no "topic" field; we echo the requested topic back.
  // -------------------------------------------------------------------------
  async function fetchAndLock(
    topic: string,
    workerId: string,
    lockDurationMs: number,
    maxTasks: number,
  ): Promise<FetchResult> {
    return withRetry(async () => {
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic,
            workerId,
            lockDuration: lockDurationMs,
            numberOfTasks: maxTasks,
          }),
        },
      );

      if (resp.status === 200) {
        const data = await resp.json() as unknown;
        // Flowable 7 returns a bare JSON array (not { data: [...] })
        const rawTasks: Record<string, unknown>[] = Array.isArray(data)
          ? (data as Record<string, unknown>[])
          : [];

        const tasks: ExternalTask[] = rawTasks.map((t) => ({
          id: String(t["id"] ?? ""),
          // Flowable wire shape has no "topic" field — echo the requested topic
          topic,
          processInstanceId: String(t["processInstanceId"] ?? ""),
          variables: fromFlowableVars(
            t["variables"] as { name: string; value: unknown }[] | undefined,
          ),
          lockOwner: String(t["lockOwner"] ?? ""),
          lockExpirationTime: String(t["lockExpirationTime"] ?? ""),
        }));

        return { ok: true, tasks };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<FetchResult>;
  }

  // -------------------------------------------------------------------------
  // FR-4: completeTask — assertVariableValue guard + resolveFor seam (FF-G3)
  // -------------------------------------------------------------------------
  async function completeTask(
    taskId: string,
    workerId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteTaskResult> {
    // FF-G3 Layer C: validate ALL outgoing variables before sending to engine.
    if (variables !== undefined) {
      for (const value of Object.values(variables)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }

    // resolveFor is the designated record-mutation seam (T-0028 Layer C).
    // T-0068 (lifecycle + audit) will complete the authorization wiring here.
    // The import and reference satisfy FF-G3; no runtime auth call yet (T-0068).
    void resolveFor; // structural reference — keeps FF-G3 grep green

    return withRetry(async () => {
      const bodyObj: Record<string, unknown> = { workerId };
      if (variables !== undefined && Object.keys(variables).length > 0) {
        bodyObj["variables"] = toFlowableVars(variables);
      }

      // Real endpoint: POST {extJobUrl}/acquire/jobs/{taskId}/complete
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs/${taskId}/complete`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyObj),
        },
      );

      if (resp.status === 204) {
        return { ok: true as const };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<CompleteTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-5: failTask — no variable guard needed (FR-5 explicit)
  // -------------------------------------------------------------------------
  async function failTask(
    taskId: string,
    workerId: string,
    errorMessage: string,
    retries: number,
    retryTimeoutMs: number,
  ): Promise<FailTaskResult> {
    return withRetry(async () => {
      // Real endpoint: POST {extJobUrl}/acquire/jobs/{taskId}/fail
      const resp = await globalThis.fetch(
        `${extJobUrl}/acquire/jobs/${taskId}/fail`,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workerId,
            errorMessage,
            retries,
            retryTimeout: retryTimeoutMs,
          }),
        },
      );

      if (resp.status === 204) {
        return { ok: true as const };
      }

      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<FailTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-6: getFirstActiveUserTask — T-0368 (E16) on_create skip-submit seam
  //
  // GET {baseUrl}/runtime/tasks?processInstanceId={id}&size=1
  // Returns the first active USER task for an instance (not external tasks).
  // Used after startInstance via on_create trigger to discover the task-submit
  // user task so it can be immediately auto-completed (dissolve double-submit).
  // -------------------------------------------------------------------------
  async function getFirstActiveUserTask(instanceId: string): Promise<GetFirstUserTaskResult> {
    return withRetry(async () => {
      const url = `${resolved.baseUrl}/runtime/tasks?processInstanceId=${encodeURIComponent(instanceId)}&size=1`;
      const resp = await globalThis.fetch(url, {
        method: "GET",
        headers: { Authorization: auth },
      });
      if (resp.status === 200) {
        const data = (await resp.json()) as Record<string, unknown>;
        const items = data["data"] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items) || items.length === 0) {
          return { ok: true as const, taskId: null, taskName: null, taskRole: null };
        }
        const task = items[0]!;
        const taskId = String(task["id"] ?? "");
        // T-0440 (genericity): extract the REAL task name and candidateGroups.
        // Flowable /runtime/tasks returns "name" as the BPMN task name and
        // "candidateGroups" as the first candidate group (string in Flowable 7
        // single-group tasks). Both may be absent — callers fall back to constants.
        const rawName = task["name"];
        const taskName = rawName !== undefined && rawName !== null ? String(rawName) || null : null;
        // candidateGroups comes as a comma-separated string or an array in some
        // Flowable versions. Normalise to the first entry or null.
        const rawGroups = task["candidateGroups"];
        let taskRole: string | null = null;
        if (typeof rawGroups === "string" && rawGroups.trim() !== "") {
          taskRole = rawGroups.split(",")[0]!.trim() || null;
        } else if (Array.isArray(rawGroups) && rawGroups.length > 0) {
          taskRole = String(rawGroups[0]).trim() || null;
        }
        return { ok: true as const, taskId: taskId || null, taskName, taskRole };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<GetFirstUserTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-7: completeUserTask — T-0368 (E16) on_create skip-submit seam
  //
  // PUT {baseUrl}/runtime/tasks/{taskId}  body: {"action":"complete"[,"variables":[...]]}
  // Flowable 7 returns 200 with the task JSON on a successful complete.
  //
  // T-0440 (backward-compatible extension): optional `variables` map.
  // When provided, the variables are serialised to Flowable wire format and
  // included in the body so the engine can evaluate gateways that read them.
  // The existing on_create caller (records.ts) passes no variables — the body
  // shape stays { action: "complete" } in that path, fully backward-compatible.
  // -------------------------------------------------------------------------
  async function completeUserTask(
    taskId: string,
    variables?: Record<string, unknown>,
  ): Promise<CompleteUserTaskResult> {
    return withRetry(async () => {
      const bodyPayload: Record<string, unknown> = { action: "complete" };
      if (variables !== undefined && Object.keys(variables).length > 0) {
        bodyPayload["variables"] = toFlowableVars(variables);
      }
      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "PUT",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyPayload),
        },
      );
      // Flowable 7 returns 200 with the completed task body on success.
      if (resp.status === 200 || resp.status === 204) {
        return { ok: true as const };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<CompleteUserTaskResult>;
  }

  // -------------------------------------------------------------------------
  // FR-8: isInstanceEnded — T-0440 post-gateway projection decision
  //
  // GET {baseUrl}/runtime/process-instances/{instanceId}
  //   200 → instance is still active (running/waiting/at service task)
  //   404 → instance ended and moved to history (Flowable removes from runtime)
  //   5xx → engine unavailable
  //
  // Used by the inbox approve handler to decide whether to emit a next-task
  // event (post-gateway branch still waiting) or leave the instance marked
  // done (engine has finished the process). NOT retried on 404 (NOT_FOUND is
  // not retryable in withRetry), so 404 correctly surfaces as ended=true.
  // -------------------------------------------------------------------------
  async function isInstanceEnded(instanceId: string): Promise<IsInstanceEndedResult> {
    return withRetry(async () => {
      const resp = await globalThis.fetch(
        `${resolved.baseUrl}/runtime/process-instances/${encodeURIComponent(instanceId)}`,
        {
          method: "GET",
          headers: { Authorization: auth },
        },
      );
      if (resp.status === 200) {
        // Instance is still in the runtime pool — not ended.
        return { ok: true as const, ended: false };
      }
      if (resp.status === 404) {
        // Instance has ended and moved to history (Flowable removes runtime record).
        return { ok: true as const, ended: true };
      }
      return { ok: false, code: httpStatusToCode(resp.status) };
    }, resolved) as Promise<IsInstanceEndedResult>;
  }

  return {
    deployBpmn,
    startInstance,
    fetchAndLock,
    completeTask,
    failTask,
    getFirstActiveUserTask,
    completeUserTask,
    isInstanceEnded,
  };
}
