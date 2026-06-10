# Spec · T-0027 — BPMN Deploy-time Linter

**Phase:** SPEC · **Status:** ready (no blocking questions) · **Date:** 2026-06-10
**Task:** E2.6 — BPMN deploy-time linter: reject raw-object bindings (handle-only) at deploy
**Raw TZ:** `playbooks/rbac-backlog.md` §E2.6
**Deps:** E2.4 (T-0015 opaque object handles, `assertVariableValue`), E2.5 (T-0021 `grant_resolver` PDP)
**Consumed by:** T-0058 (Flowable integration: real deploy endpoint), T-0064 (engine external-task bridge)
**Hypothesis refs:** `playbooks/rbac-discovery-phase1-hypothesis.md` §1 (caveat), §6-A #1

---

## 0. Note on scope — standalone library, engine integration explicit deferral

Choros today has **no Flowable engine integration**: Flowable is ratified (stack ADR §1) but
T-0058 (deploy BPMN) and T-0064 (external-task bridge) are future tasks; T-0117 (OSS spike)
is running. Therefore T-0027 builds a **standalone linter library + CLI tool** that validates
BPMN XML for handle-discipline violations. It does **not** integrate with a running engine.

The integration point — "the deploy endpoint calls `lintBpmn()` and rejects on violations"
— is an **explicit deferral contract** (see §4). T-0058/T-0064 implement it; this spec fixes
the exact function signature and rejection semantics they must wire.

The linter parses BPMN XML using **Node `node:xml` (built-in)** — more precisely, the
standard `node:readline`/`Buffer` pipeline is insufficient; use Node's DOMParser available
via `xmldom` or a minimal hand-written SAX/streaming parser — decision resolved in §6.

---

## 1. What we are building (one sentence)

A **standalone TypeScript BPMN linter library** (`src/core/bpmn-linter.ts`) plus a thin
CLI entry-point (`src/cli/lint-bpmn.ts`) that parses a BPMN 2.0 XML document and rejects
any process that binds a raw-object (record payload) into a variable — instead of an opaque
handle — before the process can be deployed; handle-only and primitive bindings pass, and
malformed XML is rejected fail-closed.

---

## 2. Why this exists (load-bearing rationale)

The Choros authorization thesis (hypothesis §1 caveat): every object read/write routes
through the gateway (E2.5); a handle in a variable is safe because only `resolveHandle`
gives back fields; a **raw object in a variable bypasses the gateway entirely**. T-0015 built
the runtime variable guard (`assertVariableValue`) and the branded `ObjectHandle` type;
T-0021 built the PDP. But both guards operate at **runtime** — a process that was *deployed*
with a raw-object binding has already escaped the type system, and the runtime guard fires
too late (the payload is in the variable; the violation is the deploy, not the first use).

E2.6 moves the enforcement **left, to deploy time**: a BPMN process definition that binds a
raw object into any variable is **rejected before it ever runs**. This is the "deploy gate"
half of the E2.5 guarantee that T-0021 ADR §5 deferred to T-0027 (FF-R9 / AC-15 there).
T-0028 (E2.7) covers the runtime complement (engine mutation guard).

---

## 3. Functional requirements

- **FR-1 — `lintBpmn(xml)` function.** A pure function `lintBpmn(xml: string): LintResult`
  that accepts BPMN 2.0 XML and returns either `{ ok: true }` or
  `{ ok: false; violations: LintViolation[] }`. No I/O, no network, no DB.

- **FR-2 — Reject raw-object bindings in service tasks.** In `<serviceTask>` and
  `<sendTask>` elements: any `<extensionElements>` entry that specifies a process variable
  whose value is a raw-object literal (a JSON object containing record-identity fields
  `registryId`, `recordId`, `applicationId`, or a `data`/`fields`/`payload`/`view` key) is
  a violation.

- **FR-3 — Reject raw-object bindings in user tasks.** In `<userTask>` elements: same
  rule as FR-2 for extension element variable assignments.

- **FR-4 — Reject raw-object bindings in sequence flow condition expressions.** A BPMN
  `<conditionExpression>` that embeds a raw-object literal (same shape as FR-2) in an EL or
  JavaScript expression string is a violation.

- **FR-5 — Reject raw-object bindings in `<dataObject>` / `<dataObjectReference>`
  initialValue.** If a `<dataObject>` or `<dataObjectReference>` carries a value that is
  raw-object-shaped, it is a violation.

- **FR-6 — Pass handle-shaped string values.** A variable value that is a valid serialized
  `ObjectHandle` (passes `parseHandle` from T-0015 without throwing) is **not** a violation.
  The linter MUST call `parseHandle` from `src/core/object-handle.ts` to confirm
  handle-shaped strings. The linter is a consumer of T-0015, not a reimplementation.

- **FR-7 — Pass primitive literals.** String, number, boolean, and null/empty variable
  values that do NOT carry record-identity or payload keys are not violations.

- **FR-8 — Fail-closed on malformed XML.** XML that cannot be parsed (invalid UTF-8,
  unclosed tags, fatal parse error) MUST be treated as a violation: `lintBpmn` returns
  `{ ok: false, violations: [{ type: "malformed_xml", ... }] }`. The linter never returns
  `ok: true` for XML it could not fully parse.

- **FR-9 — LintViolation carries location context.** Each `LintViolation` carries at minimum:
  `type` (string enum), `elementId` (the BPMN element's `id` attribute if present, or empty
  string), `elementKind` (e.g. `"serviceTask"`, `"userTask"`, `"conditionExpression"`,
  `"dataObject"`, `"malformed_xml"`), and `message` (human-readable description).

- **FR-10 — CLI entry-point.** `src/cli/lint-bpmn.ts` (runnable as
  `node dist/cli/lint-bpmn.js <file.bpmn>`) reads a BPMN file, calls `lintBpmn`, exits 0
  on pass and 1 on violations, printing violations to stderr in a machine-parseable JSON
  format. Usable in CI pipelines independently of a running Flowable instance.

- **FR-11 — Explicit deploy-gate contract (deferral to T-0058/T-0064).** The module
  exports a clearly named `lintBpmn(xml: string): LintResult` function with stable
  semantics (see §4) that T-0058/T-0064 MUST call and MUST reject deployment on
  `ok: false`. This contract is stated in a JSDoc block on the exported function and in a
  `docs/design/T-0027-bpmn-linter-deploy-contract.md` stub.

---

## 4. The deploy-gate deferral contract (for T-0058/T-0064)

```
lintBpmn(xml: string): LintResult
  LintResult = { ok: true } | { ok: false; violations: LintViolation[] }

Invariants T-0058/T-0064 MUST preserve when wiring:
  (a) lintBpmn is called on the BPMN XML before it is accepted by the deploy endpoint.
  (b) If ok: false, the deploy is rejected with HTTP 422 (or equivalent) and the
      violations array is returned to the caller.
  (c) Malformed XML (ok: false, type "malformed_xml") also results in rejection (fail-closed).
  (d) The linter is called at deploy time, not at runtime (the runtime complement is T-0028).
  (e) lintBpmn itself is a pure function; any I/O (file read, HTTP) is the caller's responsibility.
```

This contract is checked in CI by T-0027's own fitness gate (AC-15 placeholder): the deploy
stub test (a mock deploy function) calls `lintBpmn` and asserts it cannot succeed with a
raw-object binding. When T-0058 ships, it replaces the mock with the real endpoint.

---

## 5. Non-functional requirements

- **NF-1 — Zero production dependencies.** The linter library has **no third-party runtime
  dependencies** beyond Node.js built-ins. XML parsing uses Node's built-in SAX-like stream
  or a minimal hand-written recursive-descent XML parser contained within the module
  (decision: §6). No `npm install` additions to `package.json` `dependencies` for the
  library module itself. (Dev/test dependencies are fine.)

- **NF-2 — Pure function, no side effects.** `lintBpmn(xml)` is a total pure function:
  same input → same output; no I/O; no global state mutation; no process exit.

- **NF-3 — TS strict, additive.** New files: `src/core/bpmn-linter.ts`,
  `src/cli/lint-bpmn.ts`, `ci/checks/bpmn-linter-isolation.sh`, and the deploy contract
  stub. No modification to existing exports of `object-handle.ts`, `grant-resolver.ts`,
  `grant-lattice.ts`, `types.ts`, or `jobStore.ts` (architect rule 7 / FE-W23-0008).

- **NF-4 — Fail-closed by default.** When in doubt (parse ambiguity, unknown extension
  element format, unrecognized binding syntax), the linter **rejects, never silently passes**.
  A linter that misses a violation is worse than one that rejects a valid process — the
  constraint is one-sided.

- **NF-5 — vitest fitness suite.** The AC suite (§7) is implemented as `src/__tests__/
  bpmn-linter.test.ts` using vitest, consistent with the existing test convention.

- **NF-6 — CLI non-zero exit on any violation (CI integration).** The CLI exits 1 on any
  `ok: false`, including malformed XML, so it gates CI pipelines directly without post-
  processing.

- **NF-7 — Handle-check reuses T-0015.** The linter does NOT reimplement the handle shape
  check. It imports and calls `parseHandle` from `src/core/object-handle.ts`. This keeps
  the definition of "a valid handle" single-sourced.

---

## 6. XML parsing — decision and rationale

**Decision: use a minimal hand-written SAX-style parser over the BPMN XML, contained within
`src/core/bpmn-linter.ts` (or a private helper `src/core/bpmn-xml-parser.ts`). Zero new
`npm` runtime dependencies.**

Rationale:

- The BPMN XML surface the linter must inspect is **narrow and well-defined**: `<serviceTask>`,
  `<userTask>`, `<sendTask>`, `<conditionExpression>`, `<dataObject>`, `<dataObjectReference>`,
  and their `<extensionElements>` children. A full DOM is not needed.
- Node's built-in `node:http`/`node:stream`/`Buffer` APIs provide byte-level access but no
  XML parser. Node does **not** ship an XML/DOM parser in built-ins (no `DOMParser` in Node
  without a browser runtime).
- Adding `xmldom` or `fast-xml-parser` as a production dependency violates NF-1 (zero-dep
  constraint, inherited from Demiurge conventions).
- A minimal recursive-descent (or regex-free SAX) parser over the known BPMN element tags
  is <200 lines, fully testable, and proportional (rubric axis 5). It only needs to:
  (a) tokenize opening tags + attributes, (b) extract text/CDATA content of known child
  elements, (c) detect fatal parse errors (unclosed tags, invalid encoding) to satisfy FR-8.
- **Out of scope for the parser:** namespace resolution beyond the literal tag names
  (`bpmn:serviceTask` vs `serviceTask` — both are accepted by normalizing the local name),
  XPath evaluation, full BPMN schema validation, and BPMN-DI diagram elements.

The architect (DESIGN phase) will decide the exact parser implementation shape; the spec
fixes the **requirement** (zero-dep, minimal, fail-closed on malformed XML).

---

## 7. Acceptance criteria

### Static-now (vitest + CI checks, runnable before engine integration)

| ID | Text | verifiable_as |
|---|---|---|
| AC-1 | `lintBpmn(validXml)` returns `{ ok: true }` for a BPMN with only handle-shaped variable values (serialized `ObjectHandle` strings that `parseHandle` accepts) and primitive literals in all bindings | test |
| AC-2 | `lintBpmn(xml)` returns `{ ok: false, violations: [...] }` for a BPMN where a `<serviceTask>` extension element assigns a raw-object literal with `registryId`/`recordId` to a process variable; violation carries `elementKind: "serviceTask"` and the element's `id` | test |
| AC-3 | `lintBpmn(xml)` returns `{ ok: false }` for a BPMN where a `<userTask>` extension element assigns a raw-object with a `data` key (record payload shape) to a variable; violation carries `elementKind: "userTask"` | test |
| AC-4 | `lintBpmn(xml)` returns `{ ok: false }` for a BPMN where a `<conditionExpression>` embeds a raw-object literal with `fields` or `payload` key in expression content | test |
| AC-5 | `lintBpmn(xml)` returns `{ ok: false }` for a BPMN where a `<dataObject>` initialValue carries a raw-object with `applicationId`/`registryId` identity keys | test |
| AC-6 | `lintBpmn(malformedXml)` returns `{ ok: false, violations: [{ type: "malformed_xml", ... }] }` for XML with unclosed tags; the function never returns `ok: true` for XML it cannot fully parse (fail-closed) | test |
| AC-7 | `lintBpmn(xml)` where every variable binding is a valid serialized handle string (accepted by `parseHandle`) returns `{ ok: true }` — handle strings are not false-positives | test |
| AC-8 | `lintBpmn(xml)` where a `<serviceTask>` binding is an inline raw-object in an attribute value (e.g. `value="{registryId:'x',recordId:'y'}"`) returns `{ ok: false }` — adversarial: raw object in attribute, not only in element body | test |
| AC-9 | `lintBpmn(xml)` where a raw object is nested inside an `<extensionElements>` CDATA section returns `{ ok: false }` — adversarial: payload in CDATA | test |
| AC-10 | `lintBpmn(xml)` where a binding value is an EL expression string that does NOT match any raw-object pattern (e.g. `"${someVar}"` or a plain string) returns `{ ok: true }` — non-object EL expressions are not violations | test |
| AC-11 | `LintViolation` objects carry all required fields: `type` (string), `elementId` (string), `elementKind` (string), `message` (string); a missing or empty `id` in the BPMN element results in `elementId: ""` | test |
| AC-12 | `bpmn-linter.ts` imports nothing from `jobStore`, `http`, `pg`, `fs`, `net`, or any third-party package that is not in the project's existing `devDependencies`; `ci/checks/bpmn-linter-isolation.sh` asserts this | fitness |
| AC-13 | No existing export of `object-handle.ts`, `grant-resolver.ts`, `grant-lattice.ts`, `types.ts`, `jobStore.ts` is modified; `git diff --name-only` after the build does not touch those files' exported symbols (NF-3 / architect rule 7) | fitness |
| AC-14 | The CLI `lint-bpmn.ts` exits 0 on a passing BPMN file and exits 1 on a file with violations or malformed XML; the violations are printed to stderr as JSON (NF-6) | test |

### Deploy-gate placeholder (activates-in-T-0058/T-0064)

| ID | Text | verifiable_as |
|---|---|---|
| AC-15 | A mock deploy function that calls `lintBpmn` before accepting a BPMN definition rejects (returns `ok: false`) when given a raw-object binding, and accepts (returns `ok: true`) when given a handle-only BPMN — the deploy-gate contract (§4) is tested against the mock; the real wire happens in T-0058/T-0064 | test |

---

## 8. Out of scope

- **Flowable engine integration / real deploy endpoint** — T-0058 (Flowable: BPMN deploy API)
  and T-0064 (external-task bridge). This spec fixes the linter contract they consume; it
  does not build the integration itself.
- **Runtime engine mutation guard** (a process variable being set to a raw object at
  runtime) — T-0028 (E2.7). The linter runs at deploy time over static XML; runtime
  enforcement is T-0028.
- **Full BPMN 2.0 schema validation** — e.g. structural validity of gateways, event
  semantics, live-migration constraints. The linter checks only the handle-discipline
  invariant.
- **Namespace-qualified XML validation** — the linter normalizes BPMN element local names
  (stripping namespace prefix) and does not validate namespace URIs.
- **Compile-time/IDE plugin** — the linter is a deploy-gate library/CLI; IDE integration
  is out of scope.
- **Performance benchmarks / large-file stress** — target is process definition XML
  (typically <500KB); no throughput SLA is set at this stage.
- **Richer facet grammar / value-aware masking** — the linter checks *variable binding
  shape*, not the facet algebra (T-0033/E4.3).

---

## 9. Adversarial AC summary (fail-closed must-pass list)

| Scenario | Expected result |
|---|---|
| Raw object literal in extension element attribute value | `ok: false` |
| Raw object literal in extension element body text/CDATA | `ok: false` |
| Raw object nested in a `<conditionExpression>` | `ok: false` |
| Raw object in `<dataObject>` initialValue | `ok: false` |
| Malformed XML (fatal parse error) | `ok: false, type: "malformed_xml"` |
| Valid serialized ObjectHandle string | `ok: true` (not a false-positive) |
| Plain primitive string / number in binding | `ok: true` (not a false-positive) |
| EL expression `"${someVar}"` with no raw-object pattern | `ok: true` (not a false-positive) |
| Empty BPMN (no process elements) | `ok: true` |

---

## 10. Traceability

| Source | Covered by |
|---|---|
| rbac-backlog.md §E2.6 (reject raw-object bindings at deploy) | FR-1–FR-10, AC-1–AC-6 |
| T-0015 ADR §4.4 `assertVariableValue` contract (FR-3) | FR-6/NF-7 (linter calls `parseHandle`, reuses T-0015 definition) |
| T-0021 ADR §5 deferred FF-R9/AC-15 (deploy linter) | AC-15 (deploy-gate placeholder) |
| hypothesis §1 (caveat: gateway is only real if nothing routes around it) | FR-2–FR-5, FR-8 (fail-closed), NF-4 |
| hypothesis §6-A #1 (gateway chokepoint, day-1) | FR-8, NF-4 |
| Demiurge conventions (zero-dep, capability-not-text) | NF-1, NF-7 |
| stack ADR §1 (Flowable not yet integrated; T-0058/T-0064 future) | §0 (explicit deferral), §4, AC-15 |
