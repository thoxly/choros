#!/usr/bin/env npx tsx
/**
 * scripts/demo-tel-walkthrough.ts — T-0218 DEMO-1 executable walkthrough.
 *
 * Drives the first-demo linear ТЭЛ scenario THROUGH the public API / importer
 * (I-1, T-0140) — NEVER direct PG.
 *
 * What it does:
 *   1. Applies the showcase pack (org/roles) via applyPack (importer.ts).
 *   2. Applies the additive demo actor-seed (role-intake-agent + a-intake +
 *      grants WITHOUT approve) via the public REST API (POST /api/*).
 *   3. Narrates the 5-screen linear flow S1..S5, marking where each agent slot
 *      (T-0219 intake on S2, T-0234 legal-precheck on S3) acts.
 *   4. Prints a structured JSON summary of the walkthrough.
 *
 * Idempotent: re-running is a no-op (importer/REST 409 → skipped).
 *
 * Usage:
 *   npx tsx scripts/demo-tel-walkthrough.ts [--base-url http://localhost:8080] [--tenant showcase] [--dry-run]
 *
 * --dry-run: narrate the flow + slot wiring WITHOUT any HTTP calls (no server
 *            needed). Used to verify the scenario shape offline.
 */

import { applyPack } from "../seed/importer.js";
import {
  AGENT_SLOTS,
  DEMO_SCREENS,
  DEMO_ROLE_INTAKE,
  DEMO_EMPLOYEE_INTAKE,
  DEMO_GRANTS_INTAKE,
  DEMO_DEAL,
  DEMO_DEAL_CONTEXT,
  legalGateFires,
  type DemoScreen,
} from "../seed/demo/tel-scenario.js";

type Args = { baseUrl: string; tenant: string; devUser: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== undefined && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }
  return {
    baseUrl: opts["base-url"] ?? "http://localhost:8080",
    tenant: opts["tenant"] ?? "showcase",
    devUser: opts["dev-user"] ?? "e-owner",
    dryRun: opts["dry-run"] === "true",
  };
}

async function httpPost(
  baseUrl: string,
  path: string,
  body: unknown,
  devUser: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dev-user": devUser },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function httpGet(
  baseUrl: string,
  path: string,
  devUser: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { "x-dev-user": devUser },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** Resolve tenant id + role id needed to apply the additive demo actor-seed. */
async function applyDemoActorSeed(args: Args): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const { baseUrl, tenant, devUser } = args;

  // tenant id (showcase already exists from applyPack)
  const tRes = await httpGet(baseUrl, `/api/tenants/${tenant}`, devUser);
  if (tRes.status !== 200) {
    throw new Error(`[demo-seed] cannot resolve tenant '${tenant}': ${tRes.status}`);
  }
  const tenantId = (tRes.body as Record<string, string>)["id"];

  // role-intake-agent (no approve grant — moat)
  const rRes = await httpPost(
    baseUrl,
    "/api/roles",
    {
      tenant_id: tenantId,
      slug: DEMO_ROLE_INTAKE.slug,
      display_name: DEMO_ROLE_INTAKE.display_name,
      description: DEMO_ROLE_INTAKE.description,
    },
    devUser,
  );
  let roleId: string | undefined;
  if (rRes.status === 201) {
    roleId = (rRes.body as Record<string, string>)["id"];
    created.push(`role:${DEMO_ROLE_INTAKE.slug}`);
  } else if (rRes.status === 409) {
    skipped.push(`role:${DEMO_ROLE_INTAKE.slug}`);
    const st = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
    if (st.status === 200) {
      roleId = (st.body as Record<string, Array<{ id: string; slug: string }>>)["roles"]?.find(
        (x) => x.slug === DEMO_ROLE_INTAKE.slug,
      )?.id;
    }
  } else {
    throw new Error(`[demo-seed] POST /api/roles → ${rRes.status}: ${JSON.stringify(rRes.body)}`);
  }

  // a-intake agent employee
  const eRes = await httpPost(
    baseUrl,
    "/api/employees",
    {
      tenant_id: tenantId,
      kind: DEMO_EMPLOYEE_INTAKE.kind,
      slug: DEMO_EMPLOYEE_INTAKE.slug,
      display_name: DEMO_EMPLOYEE_INTAKE.display_name,
    },
    devUser,
  );
  if (eRes.status === 201) created.push(`employee:${DEMO_EMPLOYEE_INTAKE.slug}`);
  else if (eRes.status === 409) skipped.push(`employee:${DEMO_EMPLOYEE_INTAKE.slug}`);
  else throw new Error(`[demo-seed] POST /api/employees → ${eRes.status}`);

  // grants for role-intake-agent (read request, update classification) — NO approve
  if (roleId) {
    for (const g of DEMO_GRANTS_INTAKE) {
      const gRes = await httpPost(
        baseUrl,
        "/api/grants",
        {
          role_id: roleId,
          resource_type: g.resource_type,
          operation: g.operation,
          scope: g.scope,
          delegable: g.delegable,
          granted_by: devUser,
        },
        devUser,
      );
      const tag = `grant:${g.resource_type}:${g.operation}`;
      if (gRes.status === 201) created.push(tag);
      else if (gRes.status === 409) skipped.push(tag);
      else throw new Error(`[demo-seed] POST /api/grants → ${gRes.status}`);
    }
  }

  return { created, skipped };
}

function narrateScreen(s: DemoScreen): Record<string, unknown> {
  const slot = s.slot ? AGENT_SLOTS.find((x) => x.id === s.slot) : undefined;
  return {
    screen: s.id,
    title: s.title,
    slice: s.slice,
    persona: s.persona,
    shows: s.shows,
    proof: s.proof,
    agent_slot: slot
      ? {
          id: slot.id,
          built_by: slot.built_by,
          consumes: slot.consumes,
          produces: slot.produces,
          ...(slot.trigger ? { trigger: slot.trigger } : {}),
          ...(slot.engine ? { engine: slot.engine } : {}),
        }
      : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const flow = DEMO_SCREENS.map(narrateScreen);
  const gateFires = legalGateFires(DEMO_DEAL.amount);

  const summary: Record<string, unknown> = {
    scenario: "T-0218 DEMO-1 — linear ТЭЛ (straight-through)",
    domain: "(a) expense/procurement as simplified linear ТЭЛ",
    one_flow: true,
    tenant: args.tenant,
    demo_deal: DEMO_DEAL,
    legal_gate_fires: gateFires,
    legal_precheck_deal_context: DEMO_DEAL_CONTEXT,
    flow,
  };

  if (args.dryRun) {
    summary["mode"] = "dry-run (no HTTP)";
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  // 1. apply showcase org/roles via importer (public API path)
  const applied = await applyPack({
    baseUrl: args.baseUrl,
    tenantSlug: args.tenant,
    packName: "showcase",
    devUser: args.devUser,
  });
  summary["showcase_apply"] = applied;

  // 2. additive demo actor-seed (role-intake-agent + a-intake + grants, NO approve)
  const demoSeed = await applyDemoActorSeed(args);
  summary["demo_actor_seed"] = demoSeed;
  summary["mode"] = "live (HTTP)";

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({ error: { code: "DEMO_WALKTHROUGH_FAILED", message: String(err) } }) + "\n",
  );
  process.exit(1);
});
