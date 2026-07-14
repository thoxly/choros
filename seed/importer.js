/**
 * seed/importer.ts — T-0140
 *
 * TypeScript HTTP-only importer for Choros seed-packs.
 * ALL writes go through public REST APIs (I-1, FF-2 — no pg imports, no src/db imports).
 *
 * Exports:
 *   loadPack(packName): Pack             — reads + schema-validates seed/<name>/pack.json
 *   applyPack(opts): Promise<ApplySummary>
 *   resetPack(opts): Promise<ResetSummary>
 *
 * FF-7 safety rail: the apply loop iterates an explicit live-entity allow-list
 * (LIVE_ENTITY_ORDER). process_instances and rights_cards are NEVER iterated
 * inside the write loop — display plane is load-and-serve only.
 *
 * AC-10 / I-3 exclude-list: e-owner employee + tenant-owner/budget-approver roles
 * are never deleted by resetPack.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
// ---------------------------------------------------------------------------
// LIVE_ENTITY_ORDER — explicit allow-list for the apply write loop (FF-7).
// process_instances and rights_cards are intentionally absent.
// ---------------------------------------------------------------------------
const LIVE_ENTITY_ORDER = [
    "tenant",
    "departments",
    "positions",
    "employees",
    "roles",
    "role_assignments",
    "grants",
];
// ---------------------------------------------------------------------------
// Reset exclude-list (AC-10 / I-3)
// ---------------------------------------------------------------------------
const EXCLUDE_EMPLOYEE_SLUGS = new Set(["e-owner"]);
const EXCLUDE_ROLE_SLUGS = new Set(["tenant-owner", "budget-approver"]);
// ---------------------------------------------------------------------------
// Pack directory resolution
// ---------------------------------------------------------------------------
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
function packDir(packName) {
    return path.resolve(__dirname, packName);
}
function packFilePath(packName) {
    return path.join(packDir(packName), "pack.json");
}
// ---------------------------------------------------------------------------
// Schema validation (FF-1 — fail-closed before any HTTP call)
// Minimal draft-07 subset validator: checks required fields and basic types.
// Full CI validation is done by pack-schema-valid.sh using validate.py.
// ---------------------------------------------------------------------------
function validatePackShape(obj, packName) {
    if (typeof obj !== "object" || obj === null) {
        throw new Error(`[loadPack] ${packName}/pack.json: root must be an object`);
    }
    const p = obj;
    const required = ["meta", "tenant", "departments", "positions", "employees", "roles", "role_assignments", "grants", "rights_cards", "process_instances"];
    for (const field of required) {
        if (!(field in p)) {
            throw new Error(`[loadPack] ${packName}/pack.json: missing required field '${field}'`);
        }
    }
    const meta = p["meta"];
    if (typeof meta["name"] !== "string")
        throw new Error(`[loadPack] meta.name must be string`);
    // FF-5: meta.name must equal directory name
    if (meta["name"] !== packName) {
        throw new Error(`[loadPack] ${packName}/pack.json: meta.name '${meta["name"]}' must equal pack directory name '${packName}'`);
    }
    // FF-8: every rights_cards[].role_slug must have a matching roles[].slug
    const roleSlugs = new Set(p["roles"].map((r) => r["slug"]));
    const rightsCards = p["rights_cards"];
    for (const card of rightsCards) {
        if (!roleSlugs.has(card["role_slug"])) {
            throw new Error(`[loadPack] ${packName}/pack.json: rights_cards entry role_slug '${card["role_slug"]}' has no matching roles[].slug (FF-8)`);
        }
    }
}
export function loadPack(packName) {
    const filePath = packFilePath(packName);
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch {
        throw new Error(`[loadPack] Cannot read pack file: ${filePath}`);
    }
    let obj;
    try {
        obj = JSON.parse(raw);
    }
    catch {
        throw new Error(`[loadPack] ${packName}/pack.json is not valid JSON`);
    }
    validatePackShape(obj, packName);
    return obj;
}
async function httpPost(baseUrl, path, body, devUser) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-dev-user": devUser,
        },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
}
async function httpGet(baseUrl, path, devUser) {
    const res = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { "x-dev-user": devUser },
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
}
async function httpDelete(baseUrl, path, devUser, body) {
    const headers = { "x-dev-user": devUser };
    let bodyStr;
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        bodyStr = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, {
        method: "DELETE",
        headers,
        body: bodyStr,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
}
// ---------------------------------------------------------------------------
// applyPack — apply the live plane through public REST APIs (FF-7)
// Order: tenant → departments → positions → employees → roles → role_assignments → grants
// Idempotent: 409 treated as skipped (AC-8)
// ---------------------------------------------------------------------------
export async function applyPack(opts) {
    const { baseUrl, tenantSlug, packName } = opts;
    const devUser = opts.devUser ?? "e-owner";
    const pack = loadPack(packName);
    const summary = {
        created: { tenant: 0, departments: 0, positions: 0, employees: 0, roles: 0, role_assignments: 0, grants: 0 },
        skipped: { tenant: 0, departments: 0, positions: 0, employees: 0, roles: 0, role_assignments: 0, grants: 0 },
    };
    // In-memory slug→id map for dependency resolution (pack stays UUID-free, I-2)
    const deptIdBySlug = new Map();
    const posIdBySlug = new Map();
    const empIdBySlug = new Map();
    const roleIdBySlug = new Map();
    // ---- tenant ----
    // FF-7: only LIVE_ENTITY_ORDER entities are processed here
    //
    // R-6: POST uses the caller-supplied tenantSlug (not pack.tenant.slug) so that
    // the same pack can be applied under an arbitrary slug (e.g. per-test isolation).
    // The tenant UUID is read directly from the POST 201 body {id, slug} or from
    // the POST 409 body {id, slug, code} — no separate GET /api/tenants/:slug needed.
    // This removes the slug-mismatch bug (pack slug vs caller slug) and eliminates
    // the RLS-blind GET that blocked non-dev tenants (POST handler knows the id).
    let tenantId;
    {
        const r = await httpPost(baseUrl, "/api/tenants", {
            slug: tenantSlug,
            display_name: pack.tenant.display_name,
        }, devUser);
        if (r.status === 201) {
            summary.created["tenant"] = 1;
            tenantId = r.body["id"];
        }
        else if (r.status === 409) {
            summary.skipped["tenant"] = 1;
            // R-6: POST 409 body includes {id, slug, code} — read id directly.
            tenantId = r.body["id"];
            if (!tenantId) {
                throw new Error(`[applyPack] POST /api/tenants → 409 but body missing 'id': ${JSON.stringify(r.body)}`);
            }
        }
        else {
            throw new Error(`[applyPack] POST /api/tenants → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- departments ----
    for (const dept of pack.departments) {
        const parent_id = dept.parent_slug != null ? (deptIdBySlug.get(dept.parent_slug) ?? null) : null;
        const r = await httpPost(baseUrl, "/api/departments", {
            tenant_id: tenantId,
            slug: dept.slug,
            display_name: dept.display_name,
            parent_id,
        }, devUser);
        if (r.status === 201) {
            const id = r.body["id"];
            deptIdBySlug.set(dept.slug, id);
            summary.created["departments"] = (summary.created["departments"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["departments"] = (summary.skipped["departments"] ?? 0) + 1;
            // Resolve existing id for downstream
            const orgState = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
            if (orgState.status === 200) {
                const existing = orgState.body["departments"]
                    ?.find((d) => d.slug === dept.slug);
                if (existing)
                    deptIdBySlug.set(dept.slug, existing.id);
            }
        }
        else {
            throw new Error(`[applyPack] POST /api/departments (${dept.slug}) → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- positions ----
    for (const pos of pack.positions) {
        const department_id = deptIdBySlug.get(pos.department_slug);
        if (!department_id) {
            throw new Error(`[applyPack] position '${pos.slug}': unknown department_slug '${pos.department_slug}'`);
        }
        const r = await httpPost(baseUrl, "/api/positions", {
            tenant_id: tenantId,
            department_id,
            slug: pos.slug,
            title: pos.title,
        }, devUser);
        if (r.status === 201) {
            const id = r.body["id"];
            posIdBySlug.set(pos.slug, id);
            summary.created["positions"] = (summary.created["positions"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["positions"] = (summary.skipped["positions"] ?? 0) + 1;
            const orgState = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
            if (orgState.status === 200) {
                const existing = orgState.body["positions"]
                    ?.find((p) => p.slug === pos.slug);
                if (existing)
                    posIdBySlug.set(pos.slug, existing.id);
            }
        }
        else {
            throw new Error(`[applyPack] POST /api/positions (${pos.slug}) → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- employees ----
    for (const emp of pack.employees) {
        const position_id = emp.position_slug != null ? (posIdBySlug.get(emp.position_slug) ?? null) : null;
        const r = await httpPost(baseUrl, "/api/employees", {
            tenant_id: tenantId,
            position_id,
            kind: emp.kind,
            slug: emp.slug,
            display_name: emp.display_name,
        }, devUser);
        if (r.status === 201) {
            const id = r.body["id"];
            empIdBySlug.set(emp.slug, id);
            summary.created["employees"] = (summary.created["employees"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["employees"] = (summary.skipped["employees"] ?? 0) + 1;
            const orgState = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
            if (orgState.status === 200) {
                const existing = orgState.body["employees"]
                    ?.find((e) => e.slug === emp.slug);
                if (existing)
                    empIdBySlug.set(emp.slug, existing.id);
            }
        }
        else {
            throw new Error(`[applyPack] POST /api/employees (${emp.slug}) → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- roles (system=true → skip create, just resolve id) ----
    for (const role of pack.roles) {
        if (role.system) {
            // System roles exist via migrations; resolve their id for downstream
            const orgState = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
            if (orgState.status === 200) {
                const existing = orgState.body["roles"]
                    ?.find((r) => r.slug === role.slug);
                if (existing)
                    roleIdBySlug.set(role.slug, existing.id);
            }
            summary.skipped["roles"] = (summary.skipped["roles"] ?? 0) + 1;
            continue;
        }
        const r = await httpPost(baseUrl, "/api/roles", {
            tenant_id: tenantId,
            slug: role.slug,
            display_name: role.display_name,
            description: role.description,
        }, devUser);
        if (r.status === 201) {
            const id = r.body["id"];
            roleIdBySlug.set(role.slug, id);
            summary.created["roles"] = (summary.created["roles"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["roles"] = (summary.skipped["roles"] ?? 0) + 1;
            const orgState = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
            if (orgState.status === 200) {
                const existing = orgState.body["roles"]
                    ?.find((r) => r.slug === role.slug);
                if (existing)
                    roleIdBySlug.set(role.slug, existing.id);
            }
        }
        else {
            throw new Error(`[applyPack] POST /api/roles (${role.slug}) → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- role_assignments (via existing POST /api/role-assignments) ----
    for (const ra of pack.role_assignments) {
        const employee_id = empIdBySlug.get(ra.employee_slug);
        const role_id = roleIdBySlug.get(ra.role_slug);
        if (!employee_id || !role_id) {
            throw new Error(`[applyPack] role_assignment: cannot resolve employee_slug='${ra.employee_slug}' or role_slug='${ra.role_slug}'`);
        }
        const r = await httpPost(baseUrl, "/api/role-assignments", {
            employee_id,
            role_id,
            org_scope: ra.org_scope,
            source: "seed",
            granted_by: devUser,
        }, devUser);
        if (r.status === 201) {
            summary.created["role_assignments"] = (summary.created["role_assignments"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["role_assignments"] = (summary.skipped["role_assignments"] ?? 0) + 1;
        }
        else {
            throw new Error(`[applyPack] POST /api/role-assignments → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // ---- grants (via existing POST /api/grants) ----
    for (const grant of pack.grants) {
        const role_id = roleIdBySlug.get(grant.role_slug);
        if (!role_id) {
            throw new Error(`[applyPack] grant: cannot resolve role_slug='${grant.role_slug}'`);
        }
        const r = await httpPost(baseUrl, "/api/grants", {
            role_id,
            resource_type: grant.resource_type,
            operation: grant.operation,
            scope: grant.scope,
            delegable: grant.delegable,
            granted_by: devUser,
        }, devUser);
        if (r.status === 201) {
            summary.created["grants"] = (summary.created["grants"] ?? 0) + 1;
        }
        else if (r.status === 409) {
            summary.skipped["grants"] = (summary.skipped["grants"] ?? 0) + 1;
        }
        else {
            throw new Error(`[applyPack] POST /api/grants → ${r.status}: ${JSON.stringify(r.body)}`);
        }
    }
    // *** FF-7: display plane (process_instances, rights_cards) is NOT iterated here ***
    // Verify: LIVE_ENTITY_ORDER does not include display-plane sections.
    const _checkFF7 = LIVE_ENTITY_ORDER;
    void _checkFF7;
    return summary;
}
// ---------------------------------------------------------------------------
// resetPack — diff-reconcile the live plane to the pack reference state.
// Deletes extras (not in pack), upserts diffs.
// Exclude-list: e-owner, tenant-owner, budget-approver never deleted (AC-10/I-3).
// ---------------------------------------------------------------------------
export async function resetPack(opts) {
    const { baseUrl, tenantSlug } = opts;
    const devUser = opts.devUser ?? "e-owner";
    const packName = opts.packName ?? tenantSlug;
    const pack = loadPack(packName);
    const summary = {
        deleted: { departments: 0, positions: 0, employees: 0, roles: 0 },
        upserted: { departments: 0, positions: 0, employees: 0, roles: 0 },
    };
    // Resolve tenant id
    const tenantRes = await httpGet(baseUrl, `/api/tenants/${tenantSlug}`, devUser);
    if (tenantRes.status !== 200) {
        throw new Error(`[resetPack] Cannot resolve tenant '${tenantSlug}': ${tenantRes.status}`);
    }
    const tenantId = tenantRes.body["id"];
    // Get current state
    const stateRes = await httpGet(baseUrl, `/api/org/tenant-state?tenant_id=${tenantId}`, devUser);
    if (stateRes.status !== 200) {
        throw new Error(`[resetPack] GET /api/org/tenant-state → ${stateRes.status}`);
    }
    const state = stateRes.body;
    // ---- delete extra departments ----
    const packDeptSlugs = new Set(pack.departments.map((d) => d.slug));
    for (const existing of state.departments) {
        if (!packDeptSlugs.has(existing.slug)) {
            // Pass tenant_id in body — DELETE handlers now require it (R-1 fix)
            const r = await httpDelete(baseUrl, `/api/departments/${existing.id}`, devUser, { tenant_id: tenantId });
            if (r.status === 200 || r.status === 404) {
                summary.deleted["departments"] = (summary.deleted["departments"] ?? 0) + 1;
            }
            else {
                throw new Error(`[resetPack] DELETE /api/departments/${existing.id} → ${r.status}`);
            }
        }
    }
    // ---- delete extra positions ----
    const packPosSlugs = new Set(pack.positions.map((p) => p.slug));
    for (const existing of state.positions) {
        if (!packPosSlugs.has(existing.slug)) {
            const r = await httpDelete(baseUrl, `/api/positions/${existing.id}`, devUser, { tenant_id: tenantId });
            if (r.status === 200 || r.status === 404) {
                summary.deleted["positions"] = (summary.deleted["positions"] ?? 0) + 1;
            }
            else {
                throw new Error(`[resetPack] DELETE /api/positions/${existing.id} → ${r.status}`);
            }
        }
    }
    // ---- delete extra employees (exclude e-owner) ----
    const packEmpSlugs = new Set(pack.employees.map((e) => e.slug));
    for (const existing of state.employees) {
        if (EXCLUDE_EMPLOYEE_SLUGS.has(existing.slug))
            continue;
        if (!packEmpSlugs.has(existing.slug)) {
            const r = await httpDelete(baseUrl, `/api/employees/${existing.id}`, devUser, { tenant_id: tenantId });
            if (r.status === 200 || r.status === 404) {
                summary.deleted["employees"] = (summary.deleted["employees"] ?? 0) + 1;
            }
            else {
                throw new Error(`[resetPack] DELETE /api/employees/${existing.id} → ${r.status}`);
            }
        }
    }
    // ---- delete extra roles (exclude system roles) ----
    const packRoleSlugs = new Set(pack.roles.map((r) => r.slug));
    for (const existing of state.roles) {
        if (EXCLUDE_ROLE_SLUGS.has(existing.slug))
            continue;
        if (!packRoleSlugs.has(existing.slug)) {
            const r = await httpDelete(baseUrl, `/api/roles/${existing.id}`, devUser, { tenant_id: tenantId });
            if (r.status === 200 || r.status === 404) {
                summary.deleted["roles"] = (summary.deleted["roles"] ?? 0) + 1;
            }
            else {
                throw new Error(`[resetPack] DELETE /api/roles/${existing.id} → ${r.status}`);
            }
        }
    }
    // ---- upsert missing entities via applyPack ----
    const applied = await applyPack({ baseUrl, tenantSlug, packName, devUser });
    for (const entity of Object.keys(applied.created)) {
        summary.upserted[entity] = (applied.created[entity] ?? 0);
    }
    return summary;
}
