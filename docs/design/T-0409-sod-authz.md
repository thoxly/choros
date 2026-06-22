# ADR · T-0409 — SoD Constraint Authz: Owner-Only vs Scoped-Admin

**Phase:** DESIGN · **Status:** accepted · **Date:** 2026-06-22
**Task:** T-0409 [D6-FU] — harden the SoD feature (follow-up to T-0386)

---

## 1. Decision

SoD constraint writes (`POST/PUT/DELETE /api/rights/sod-rules`) are gated on
**`isGenesisOwner` (owner-only)**. They are NOT aligned to the scoped-admin model
(`validateAdminDelegation` with `mgmt_object:sod`).

---

## 2. Context

T-0386 introduced the SoD constraint admin API and chose `isGenesisOwner`. A review
(T-0409 gap-3) flagged this as a possible consistency gap because sibling write APIs
in the rights surface — grants, role-assignments, hire/fire intents — use
`validateAdminDelegation` (scoped-admin, `mgmt_object:grant` / `mgmt_object:role`).

The two authz models available were:

**Option A — Scoped-admin (`validateAdminDelegation` / `mgmt_object:sod`)**
The caller holds a covering, delegable `mgmt_object:sod` grant. Consistent with the
grant/assignment write surface. Allows sub-tenant delegation (department-level SoD
admins).

**Option B — Owner-only (`isGenesisOwner`)**
Only the genesis owner of the tenant may author SoD constraints. Same gate used by
seed-write.ts org-structural endpoints (org creation, employee provisioning).

---

## 3. Rationale — why owner-only

SoD constraints are **tenant-structural, not scoped**: a constraint of the form
"role Инициатор and role Согласующий are incompatible" applies across the ENTIRE
tenant, not within a department scope. Scoped delegation of SoD authoring would
create a class of sub-admins who could silently disable the constraints that govern
OTHER sub-admins, allowing a finance department admin to remove the SoD rule that
protects the procurement cycle of a different department.

This is structurally different from grant/assignment delegation:
- A grant/assignment is **scoped to an org node** — a delegated admin can only write
  within their sub-tree, so misuse is bounded.
- A SoD constraint is **tenant-wide** — any actor who can write a SoD constraint can
  affect ALL SoD evaluation across the tenant.

Owner-only (`isGenesisOwner`) mirrors the gate on other tenant-wide structural writes
(seed-write.ts org structure). The consistency principle "align to sibling writes" does
NOT apply here because the OBJECT being written is categorically different: SoD
constraints govern the entire rights lattice, not a slice of it.

**When to revisit**: if a future use-case emerges where large tenants need multiple
SoD administrators, introduce `mgmt_object:sod` at that point with an explicit scope
model that prevents cross-scope constraint manipulation (e.g., constraints are
namespace-scoped). That design work is deferred; owner-only is the safe default.

---

## 4. Rejected alternative

**Scoped-admin with `mgmt_object:sod`** — rejected because:
1. There is no `scope` model on `sod_constraint` that would bound the blast radius of
   a delegated SoD admin. A `mgmt_object:sod` grant scoped to `org:fin` would still
   allow its holder to create constraints covering `org:cs` (sod_constraint scope is
   the OBJECT scope the constraint guards, not the admin's authority scope).
2. Adding scope-binding to `sod_constraint` would require a new schema design that
   is out of scope for T-0409 (a follow-up hardening task, not a new feature task).
3. No current business requirement needs sub-tenant SoD delegation.

---

## 5. Consequences

- Simple: `loadAdminContext` + `isGenesisOwner` check, no `mgmt_object:sod` grant needed.
- Every SoD write is audited (T-0409 gap-1: hash-chained `audit_event`).
- Friction: tenants with multiple admins who share SoD authoring must share an owner
  credential — acceptable for the current product scope (solo founder / small team).
- Follow-up: if scoped SoD delegation is ever needed, introduce `mgmt_object:sod` with
  an explicit blast-radius-bounding scope model and a new task (do not edit frozen code).
