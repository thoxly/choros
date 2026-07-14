/**
 * e2e/bootstrap-tel.ts — T-0283 (ADR T-0278 §E / §2.4, FF-4 / NF3 / AC-10).
 *
 * DETERMINISTIC, IDEMPOTENT bootstrap for the deploy-acceptance gate. Prepares the
 * live stack so the U1→U5 click-through has something real to drive — WITHOUT mocks,
 * WITHOUT paid LLM, and re-runnable as a no-op (FF-4 / NF3).
 *
 * Two steps, both against the REAL stack (FF-3 / NF1 / D-056):
 *
 *   1. deployBpmn(config/flowable/processes/tel-linear.bpmn20.xml, key telLinear)
 *      to Flowable REST — the SAME REST mechanism as
 *      ci/checks/flowable/tel-linear-smoke.sh / customer-onboarding-smoke.sh.
 *      Flowable versions a deployment BY process-definition-key, so a repeat deploy
 *      yields a new version of the SAME key that is still startable by key —
 *      idempotent at the gate's contract level (a started telLinear instance exists).
 *
 *   2. Assert the seeded org actors exist in the acceptance tenant (read-only):
 *      the initiator (e-orlov) and approver (e-larina) personas (seed/demo/
 *      tel-scenario.ts S1/S4). These are seeded into the `dev` tenant by the choros
 *      migrations (013) that the live stack already ran; the bootstrap VERIFIES
 *      their presence rather than re-inserting them, so a repeat run is a pure
 *      no-op (FF-4). The acceptance server is launched with DEMO_TENANT_SLUG=dev so
 *      the login picker (/api/users) and resolveActorTenant both resolve to the
 *      `dev` tenant whose id (a0000000-…-0001) matches the UI LaunchModal's
 *      hardcoded x-tenant-id (web/src/screens/screen-processes.jsx).
 *
 * NO paid LLM (AC-10 / NF3): the intake agent-slot (a-intake) is DORMANT
 * (agent_card llm_* NULL, seed/demo/tel-scenario.ts) — nothing here configures or
 * calls an LLM. The serviceTask «Триаж» is a deterministic external-task slot; the
 * linear projection (process-projection.ts) surfaces the U4 approval task to the
 * approver role directly on start, so the gate never depends on a live LLM worker.
 *
 * Zero product deps: uses node:fs + global fetch only (Node 18+). Compiled by
 * Playwright at run time; not part of tsconfig `include` (["src"]) so it never
 * affects the zero-dep `ci` job.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const FLOWABLE_PORT = process.env["FLOWABLE_PORT"] ?? "8082";
const FLOWABLE_BASE =
  process.env["FLOWABLE_REST_BASE_URL_LOCAL"] ??
  `http://localhost:${FLOWABLE_PORT}/flowable-rest/service`;
const ADMIN_USER = process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin";
const ADMIN_PASS =
  process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"] ?? "choros_flowable_dev_pw";

const SERVER_BASE = process.env["ACCEPTANCE_BASE_URL"] ?? "http://localhost:3100";

const TEL_BPMN = resolve(ROOT, "config/flowable/processes/tel-linear.bpmn20.xml");
const PROCESS_KEY = "telLinear";

/** The personas the click-through drives (S1 initiator / S4 approver). */
const REQUIRED_ACTORS = ["e-orlov", "e-larina"] as const;

function authHeader(): string {
  return "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");
}

/**
 * Step 1 — deploy the canonical linear ТЭЛ BPMN to Flowable (idempotent by key).
 * Mirrors the multipart POST /repository/deployments of the smoke scripts.
 */
async function deployTelBpmn(): Promise<void> {
  const xml = readFileSync(TEL_BPMN, "utf8");

  // multipart/form-data with a single `deployment` part — same as the smoke curl.
  const boundary = "----choros-acceptance-" + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="deployment"; filename="tel-linear.bpmn20.xml"\r\n` +
    `Content-Type: application/xml\r\n\r\n` +
    xml +
    `\r\n--${boundary}--\r\n`;

  const res = await fetch(`${FLOWABLE_BASE}/repository/deployments`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (res.status !== 201) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `bootstrap: tel-linear deploy expected HTTP 201, got ${res.status}: ${text}`,
    );
  }
}

/**
 * Step 2 — verify the started process-definition is queryable by key (so U1 has a
 * real definition to launch). Read-only; confirms the deploy took.
 */
async function assertProcessDefinitionPresent(): Promise<void> {
  const res = await fetch(
    `${FLOWABLE_BASE}/repository/process-definitions?key=${PROCESS_KEY}&latest=true`,
    { headers: { Authorization: authHeader() } },
  );
  if (!res.ok) {
    throw new Error(
      `bootstrap: process-definition lookup failed (HTTP ${res.status})`,
    );
  }
  const data = (await res.json()) as { total?: number };
  if (!data.total || data.total < 1) {
    throw new Error(
      `bootstrap: no process-definition with key '${PROCESS_KEY}' after deploy`,
    );
  }
}

/**
 * Step 3 — verify the click-through actors exist in the acceptance tenant
 * (read-only; the migrations already seeded them). A repeat run asserts the same
 * invariant → no-op (FF-4 idempotent).
 */
async function assertActorsSeeded(): Promise<void> {
  const res = await fetch(`${SERVER_BASE}/api/users`);
  if (!res.ok) {
    throw new Error(
      `bootstrap: /api/users not reachable on acceptance server ${SERVER_BASE} (HTTP ${res.status}) — is the worktree server up?`,
    );
  }
  const data = (await res.json()) as { users?: Array<{ id: string }> };
  const ids = new Set((data.users ?? []).map((u) => u.id));
  const missing = REQUIRED_ACTORS.filter((a) => !ids.has(a));
  if (missing.length > 0) {
    throw new Error(
      `bootstrap: acceptance tenant is missing required actors ${missing.join(", ")} ` +
        `(have: ${[...ids].join(", ") || "none"}). Launch the server with DEMO_TENANT_SLUG=dev.`,
    );
  }
}

/** Run the full deterministic bootstrap. Throws on any failure (fail-honest). */
export async function bootstrapTel(): Promise<void> {
  await deployTelBpmn();
  await assertProcessDefinitionPresent();
  await assertActorsSeeded();
}

/**
 * Playwright globalSetup entry. When ACCEPTANCE_SKIP_BOOTSTRAP is set (the
 * acceptance:tel script runs the bootstrap as a separate idempotent step before
 * `playwright test`), this is a no-op so the bootstrap is not double-run.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env["ACCEPTANCE_SKIP_BOOTSTRAP"]) return;
  await bootstrapTel();
}

// Allow `tsx e2e/bootstrap-tel.ts` as a standalone idempotent step.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]).startsWith(resolve(HERE));
if (invokedDirectly) {
  bootstrapTel()
    .then(() => {
      process.stdout.write("[bootstrap-tel] OK (deploy + actors verified)\n");
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[bootstrap-tel] FAIL: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
