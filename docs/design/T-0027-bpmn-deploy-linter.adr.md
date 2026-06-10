# ADR · T-0027 — BPMN Deploy-time Linter

**Status:** ready (no founder escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E2.6 — BPMN deploy-time linter: reject raw-object bindings (handle-only) at deploy
**Spec:** `docs/specs/T-0027-bpmn-deploy-linter.spec.md` + `docs/specs/T-0027.spec.contract.json` (FR-1..FR-11, NF-1..NF-7, AC-1..AC-15)
**Foundation (does NOT contradict):**
- `docs/design/T-0015-object-handles.adr.md` — `parseHandle(s): ObjectHandle` (the single definition of "valid handle"); the linter is a **consumer** of this contract, not a reimplementation.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` §5 — explicitly deferred FF-R9/AC-15 to T-0027 (deploy-gate placeholder).
- `docs/design/stack-and-fleet-ops.md` §1 — Flowable 7 is the target BPMN engine; BPMN 2.0 XML is the authoritative interchange format it consumes at deploy time.

**Consumed by:** T-0058 (Flowable: BPMN deploy endpoint), T-0064 (external-task bridge). Both MUST call `lintBpmn(xml)` and reject on `ok: false`.

---

## 1. Context

Choros has no Flowable integration yet (T-0058/T-0064 are future tasks). T-0015 closed the *runtime* variable-map boundary — `assertVariableValue` rejects record-shaped values at engine runtime. But a process definition *deployed* with a raw-object binding has already escaped the type system before it runs; the runtime guard fires too late. E2.6 moves enforcement **left, to deploy time**: a BPMN process that binds a raw object into any variable is **rejected before it ever runs**.

The linter is a standalone library + CLI. It does not integrate with a running engine. The integration contract (`lintBpmn(xml)→LintResult`, reject on `ok:false`) is a **frozen deferral stub** for T-0058/T-0064.

The **key architectural risk** (mandated by the orchestrator): **parser differential** — the linter uses a custom parser; Flowable uses its own XML parser. Any construct the linter does not fully recognize but Flowable does = a bypass. The design **must be fail-closed-whitelist**: anything the parser does not recognize unambiguously → **reject**, not skip. This section is the load-bearing engineering analysis.

---

## 2. Decision

**Build `src/core/bpmn-linter.ts` (library) + `src/cli/lint-bpmn.ts` (CLI thin wrapper) with a custom, zero-dependency, fail-closed-whitelist XML tokenizer contained entirely in `src/core/bpmn-xml-parser.ts`. The parser is NOT a general SAX/DOM parser — it is a *security-oriented minimal tokenizer* whose design invariant is: if a byte sequence is not unambiguously recognized as a known, safe token class, it returns a `MalformedOrAmbiguous` error and the linter rejects. Whitelist, not blacklist. `parseHandle` is imported read-only from `src/core/object-handle.ts` (single source of truth for "is this a valid handle"). No new runtime npm dependencies are added.**

### 2.1 Why a custom parser over a maintained XML library (the crux)

The spec (NF-1) mandates zero production dependencies. The architect has analyzed whether this constraint is worth keeping or should be overridden.

**Parser differential risk with a maintained library (e.g. `xmldom` or `fast-xml-parser` as dev-dep used at runtime):**
- Any maintained library STILL has a differential versus Flowable's internal parser — it is just a different, potentially smaller one. The attack surface narrows, but the class of risk is not eliminated.
- Adding a production dependency violates NF-1, which is a stated Demiurge convention (capability-not-text, zero-dep on stdlib). The convention exists for supply-chain and audit reasons, not just aesthetics.
- A maintained library adds transitive audit surface to a security-critical gate.

**Why a custom parser is *not* unreasonably risky — given the fail-closed-whitelist constraint:**
The critical insight is that the risk of a custom parser is not "it parses XML wrong" — it is "it fails to reject an ambiguous construct that Flowable then parses differently". The mitigation is not parser correctness; it is **fail-closed-whitelist disposition**: every ambiguous, unrecognized, or strange construct causes a rejection, not a pass. This inverts the risk: under whitelist semantics, an unknown construct is a false-positive (rejects a valid process), not a false-negative (passes a malicious one). False-positives are operationally acceptable; false-negatives break the E2.6 invariant.

**Conclusion:** a custom fail-closed-whitelist tokenizer is the correct architecture for this specific security gate. The analyst's zero-dep decision is upheld. The design in §3 enumerates every XML edge class and commits the parser to explicit reject/normalize behavior for each.

### 2.2 Parser differential analysis — XML edge classes

The following table enumerates every XML construct that could create a parser differential. For each, the linter's behavior is specified. "Reject" means `lintBpmn` returns `ok: false, type: "malformed_xml"` before any lint rule runs.

| Edge class | Flowable behavior | Linter behavior | Rationale |
|---|---|---|---|
| `<!DOCTYPE ...>` declarations | Accepts; may expand internal DTD entities | **Reject** | DOCTYPE enables entity injection (billion-laughs, XXE variants). Any DOCTYPE in a BPMN deploy artifact is anomalous and must be rejected. |
| XML entities (`&foo;`, `&#x...;`) beyond the 5 predefined XML entities (`&lt; &gt; &amp; &apos; &quot;`) | Expands defined entities; may resolve system entities | **Reject** for non-predefined entities | Non-predefined entities require a DTD or an entity declaration; those are themselves rejected. Predefined 5 entities are normalized (unescaped to their character) before lint scanning. |
| Duplicate attribute names on a single element (e.g. `value="a" value="b"`) | Second declaration wins (XML1.0 §3.1 undefined behavior; implementations differ) | **Reject** | Differential exploit: linter reads first value (safe), Flowable reads second (raw object). Reject any element with duplicate attribute names. |
| Namespace prefix tricks (e.g. `bpmn2:serviceTask` vs `serviceTask` vs `tns:serviceTask`) | Resolves per namespace binding; `bpmn2:serviceTask` and `serviceTask` are the same local name | **Normalize**: strip everything up to and including the first `:`, get local name only. Reject if local name is empty after stripping. | Local name normalization is safe because the linter only gates on known element local names. Unknown local names in relevant positions → covered by unknown-element whitelist. |
| Namespace declarations (`xmlns:*`) | Parsed and tracked | **Ignore** (do not track namespace bindings). Only local name normalization is applied. | We do not validate namespace semantics; we normalize away prefixes. Any prefix that changes the semantics unexpectedly is neutralized by local-name-only matching. |
| Multiple namespace bindings for the same prefix (malformed) | Undefined behavior | **Reject** | Ambiguous parsing — reject. |
| Processing instructions (`<?foo ... ?>`) | Passed through to engine; may carry Flowable-specific directives | **Reject** | Processing instructions are not part of the BPMN 2.0 grammar this linter validates. Any PI in a deploy artifact is anomalous. |
| CDATA sections (`<![CDATA[...]]>`) | Content treated as character data | **Parse and scan** CDATA content for raw-object patterns (the AC-9 adversarial case). Nested `]]>` (which is illegal in XML) → Reject. | CDATA is a legitimate carrier of expression text in BPMN extension elements. Its content MUST be scanned. |
| Comments (`<!-- ... -->`) | Stripped before parsing content | **Strip** (ignore) | Comments cannot carry semantic content in XML. However, a comment that contains `-->` inside it (illegal) → Reject. |
| Encoding anomalies (non-UTF-8, BOM, invalid byte sequences) | Flowable/JVM may re-interpret encoding; ICU normalization | **Reject on invalid UTF-8 sequences** or conflicting encoding declarations. Accept BOM (strip it). | JVM's ICU layer may accept byte sequences Node's `Buffer.toString('utf8')` silently replaces with U+FFFD; those replacement characters in a binding value could mask a raw-object pattern. Reject any XML byte that is not valid UTF-8 (no silent replacement). |
| Encoding declaration mismatches (`<?xml encoding="latin-1"?>` on a UTF-8 file) | JVM re-decodes the file per the declared encoding | **Reject** if `encoding` attribute in the XML declaration specifies anything other than `utf-8` or `utf8` (case-insensitive). | Encoding mismatch is a known differential attack vector; BPMN deploy artifacts must be UTF-8. |
| Unclosed tags / malformed nesting | Parse error (engine-dependent behavior) | **Reject** (FR-8, AC-6) | Any fatal parse error is a reject. |
| Empty element shorthand (`<foo/>` vs `<foo></foo>`) | Semantically equivalent | **Accept and normalize** to "element with no text content" | Not a differential risk; both forms are unambiguous. |
| Deeply nested elements (stack overflow risk) | JVM deep stack | **Limit nesting depth to 200 levels**; beyond → Reject | Prevents stack overflow in the recursive tokenizer and closes a degenerate-input DoS path. |
| Attribute values with mixed quoting and escaped quotes | Parser-dependent handling | **Accept** standard XML quoting (`'` or `"`); reject raw unquoted attribute values | Strict per XML1.0 §3.1. |
| Numeric character references (`&#65;` = 'A') | Expanded to character | **Expand and scan** the resulting character in attribute values and text content | Numeric refs that expand to `{`, `}`, `"` etc. could form a raw-object pattern post-expansion. Expand before scanning. |
| Null bytes (`\0`) anywhere in the document | JVM often silently strips | **Reject** | Null bytes in an XML document are illegal (XML1.0 §2.2) and can create parser differentials. |
| XML 1.1 documents (`<?xml version="1.1"?>`) | JVM supports XML 1.1 | **Reject** (only XML 1.0 is accepted) | BPMN 2.0 is defined over XML 1.0. XML 1.1 has different character validity rules; treating it as 1.0 creates differentials. |
| Very long attribute values or text content (>1MB) | JVM parses | **Reject** elements where a single attribute value or text content node exceeds 512KB | A raw-object disguised in a huge blob could defeat simple substring scanning; a legitimate binding value has no reason to be >512KB. |

### 2.3 Raw-object detection — formal definition

A "raw-object binding" in the context of the BPMN linter is defined as:

A string value `v` (from an attribute value, element text, or CDATA content) that, when parsed as JSON, produces a plain JavaScript object (not an array, not a primitive) containing at least one of the following **record-identity or record-payload keys**:

```
registryId | recordId | applicationId | data | fields | payload | view
```

Additionally: any such value that passes `parseHandle(v)` without throwing is NOT a raw-object binding — it is a valid handle. The detection pipeline is:

1. Extract the candidate string value `v`.
2. If `v` starts with `{` (after trimming whitespace): attempt `JSON.parse(v)`.
   - If `JSON.parse` throws: `v` is not valid JSON → not a raw-object → continue (not a violation on this path).
   - If `JSON.parse` succeeds and the result is an object (not null, not array): check for record keys → if any present, proceed to step 3.
3. Attempt `parseHandle(v)` (T-0015):
   - If `parseHandle` succeeds (does not throw): `v` is a valid handle → **not a violation**.
   - If `parseHandle` throws: `v` is a raw object that is NOT a valid handle → **violation**.

This pipeline ensures:
- Handles always pass (AC-7, FR-6).
- Any raw object that looks like record identity or payload fails (AC-2..AC-5, AC-8, AC-9).
- EL expressions like `${someVar}` do not start with `{` in JSON-parseable form → not a violation (AC-10).
- Primitives, empty strings, plain strings → not a violation (FR-7).

**Note on EL expressions containing object literals:** An EL expression `${execution.setVariable('x', {registryId: 'y'})}` embeds an object literal inside a script string. The detection pipeline for `<conditionExpression>` and extension element script values applies a **secondary scan**: after the outer EL/script wrapper is identified, any embedded `{...}` substring is extracted and subjected to the same JSON-parse + record-key check. This closes the FR-4 (conditionExpression) adversarial path.

---

## 3. Module structure

```
src/
  core/
    bpmn-xml-parser.ts    — fail-closed-whitelist XML tokenizer (private to linter)
    bpmn-linter.ts        — lintBpmn(xml): LintResult + type exports
  cli/
    lint-bpmn.ts          — CLI entry-point (node dist/cli/lint-bpmn.js <file>)
ci/
  checks/
    bpmn-linter-isolation.sh  — asserts zero forbidden imports in bpmn-linter.ts / bpmn-xml-parser.ts
src/__tests__/
  bpmn-linter.test.ts     — vitest AC corpus (adversarial fixtures required)
docs/
  design/
    T-0027-bpmn-deploy-linter.adr.md       (this file)
    T-0027-bpmn-linter-deploy-contract.md  — deploy-gate deferral stub (JSDoc source)
  design/
    T-0027.adr.contract.json
```

### 3.1 `src/core/bpmn-xml-parser.ts` — the tokenizer

Responsibility: tokenize a BPMN 2.0 XML string into a flat sequence of typed events sufficient for the linter's needs. NOT a full DOM builder.

**Token stream types (pseudo-TS):**
```ts
type TokenKind =
  | "open-tag"        // <elementLocalName attrs:[{name, value}]>
  | "close-tag"       // </elementLocalName>
  | "self-close-tag"  // <elementLocalName attrs:[{name, value}]/>
  | "text"            // decoded text content (CDATA already extracted, decoded, merged)
  | "parse-error";    // fatal — any of the §2.2 reject conditions

interface OpenTagToken  { kind: "open-tag";       localName: string; attrs: Attr[]; }
interface CloseTagToken { kind: "close-tag";       localName: string; }
interface SelfCloseToken{ kind: "self-close-tag";  localName: string; attrs: Attr[]; }
interface TextToken     { kind: "text";            value: string; }          // post-decode
interface ParseErrorToken { kind: "parse-error";   reason: string; }

interface Attr { name: string; value: string; } // both post-decode (entities, numeric refs expanded)
```

**Tokenizer contract:**
- Iterates the input string left-to-right (single pass, no backtracking beyond current token).
- On encountering any §2.2 reject condition, emits a single `parse-error` token and stops iteration.
- CDATA content is decoded and emitted as `text` tokens (invisible to consumers — they see plain text).
- Comments are consumed and discarded.
- Attribute values: entity-decoded, numeric-ref-expanded before emission.
- Encoding: input is expected as a JS string (UTF-16 internally, source bytes validated prior to tokenization by the linter entry-point using `Buffer` API).

### 3.2 `src/core/bpmn-linter.ts` — the linter

**Public surface (the only exports):**
```ts
export type LintViolationType =
  | "raw_object_binding"
  | "malformed_xml";

export interface LintViolation {
  type: LintViolationType;
  elementId: string;      // BPMN element id attribute, or "" if absent
  elementKind: string;    // "serviceTask" | "userTask" | "sendTask" | "conditionExpression" | "dataObject" | "dataObjectReference" | "malformed_xml"
  message: string;
}

export type LintResult =
  | { ok: true }
  | { ok: false; violations: LintViolation[] };

/**
 * @deploy-gate-contract
 * Pure function. No I/O. No network. No DB.
 * Returns { ok: true } iff the BPMN XML contains no raw-object bindings and is
 * well-formed per the linter's whitelist parser.
 *
 * T-0058/T-0064 MUST call this before accepting any BPMN deploy request and
 * MUST reject with HTTP 422 if ok: false. See docs/design/T-0027-bpmn-linter-deploy-contract.md.
 */
export function lintBpmn(xml: string): LintResult;
```

**Linting algorithm (stateful walk over token stream):**

1. Feed the XML through the tokenizer from §3.1. If a `parse-error` token is emitted, return `{ ok: false, violations: [{ type: "malformed_xml", elementId: "", elementKind: "malformed_xml", message: token.reason }] }` immediately (fail-closed).
2. Maintain a stack of open elements (local name + `id` attribute if present).
3. On `open-tag` for a **scoped element** (see §3.3), push a scan context: `{ elementKind, elementId, inExtension: false }`.
4. On `open-tag` for `extensionElements` (or `flowable:field`, `camunda:field`, `activiti:field`, `flowable:executionListener`, etc.) within a scoped element: set `inExtension: true` on the current context.
5. On `text` or attribute value within an extension context, or within `conditionExpression` / `dataObject` / `dataObjectReference`: run the raw-object detector (§2.3).
6. If a violation is found, append to violations list (do not abort early — collect all).
7. On `close-tag` matching the current scoped element, pop the context.
8. Return `{ ok: true }` if violations is empty, else `{ ok: false, violations }`.

### 3.3 Scoped elements and binding extraction points

| BPMN element local name | Binding locations to scan |
|---|---|
| `serviceTask` | Extension element attribute values; extension element text/CDATA content |
| `sendTask` | Same as `serviceTask` |
| `userTask` | Same as `serviceTask` |
| `conditionExpression` | Full element text content (EL/script; secondary embedded-object scan) |
| `dataObject` | Child element text/attributes for `initialValue` extension conventions |
| `dataObjectReference` | Same as `dataObject` |

**Extension element patterns to scan (union of Flowable + Camunda + Activiti conventions, normalized by local name):**
- `field` (with `name` attribute + `string`/`expression` child, or `stringValue`/`expression` attribute)
- `in` / `out` (mapping elements with `sourceExpression` / `target`)
- `executionListener` / `taskListener` (script body, field elements)
- `properties` / `property` (name/value pairs)
- `formProperty` / `formField` (default-value attribute)

For each of these, both **attribute values** and **text/CDATA content** are scanned.

### 3.4 `src/cli/lint-bpmn.ts` — CLI

- Reads file from `process.argv[2]` using `node:fs` (the CLI is the I/O boundary; the library is pure).
- Calls `lintBpmn(xml)`.
- On `ok: true`: prints nothing to stderr, exits 0.
- On `ok: false`: prints `JSON.stringify(violations)` to stderr, exits 1.
- No `--json` flag needed (stderr is always JSON; stdout unused by linter).

### 3.5 Deploy contract stub

`docs/design/T-0027-bpmn-linter-deploy-contract.md` — a stub that records the frozen wiring contract for T-0058/T-0064:

```
(a) lintBpmn is called on the BPMN XML bytes before the deploy endpoint accepts the definition.
(b) ok: false => HTTP 422; violations array returned to caller.
(c) malformed_xml type is also HTTP 422 (fail-closed).
(d) lintBpmn itself is pure; file I/O is the deploy endpoint's responsibility.
(e) T-0058 replaces the mock deploy test in bpmn-linter.test.ts with the real endpoint.
```

---

## 4. Rejected alternatives

| Option | Why not |
|---|---|
| **Use `xmldom` or `fast-xml-parser` as a production runtime dependency** | Violates NF-1 (zero prod dep, Demiurge convention). Adds supply-chain audit surface to a security gate. The differential risk vs Flowable is reduced but not eliminated; the fail-closed-whitelist design (§2.2) is the correct mitigation regardless of parser choice. |
| **Use Node.js `node:xml` (does not exist) or WHATWG `DOMParser` (browser-only)** | Neither is available in Node ≥20 built-ins. The spec §6 acknowledges this. |
| **Regex-based detection without a tokenizer** | Regex on raw XML without parsing is trivially bypassable (CDATA, attribute quoting, encoding). Rejected categorically: the linter must tokenize to find binding sites. |
| **Full BPMN 2.0 schema validation (XSD)** | Out of scope per spec §8. The linter checks handle-discipline only. Full schema validation would require a maintained XML/XSD library (violates NF-1) and is not the E2.6 requirement. |
| **Fail-open on unknown constructs (skip-and-continue)** | Directly contradicts NF-4 and the orchestrator's fail-closed-whitelist requirement. Skipping unknown constructs is the parser-differential exploit path. Rejected categorically. |
| **Scan raw XML bytes with string search instead of tokenizing** | Cannot reliably distinguish binding values from element names, comments, CDATA boundaries. The AC-8/AC-9 adversarial cases (attribute value, CDATA) require tokenized extraction to avoid false-negatives. |
| **Use a maintained XML parser as a dev-dependency only (e.g. `xmldom` in devDeps, bundled or inlined at build time)** | The "inlined at build time" approach would bundle third-party code into the production module — indistinguishable from a production dependency from an audit perspective, and adds build complexity disproportionate to the problem size. The custom tokenizer is <300 lines and fully testable. |

---

## 5. Object model

### 5.1 Exported types (`src/core/bpmn-linter.ts`)

| Entity | Fields | Notes |
|---|---|---|
| `LintViolationType` | `"raw_object_binding" \| "malformed_xml"` | Enum string literal |
| `LintViolation` | `type: LintViolationType`, `elementId: string`, `elementKind: string`, `message: string` | All fields required; `elementId` = `""` if BPMN element has no `id` attribute |
| `LintResult` | `{ ok: true }` or `{ ok: false; violations: LintViolation[] }` | `violations` non-empty when `ok: false` |

### 5.2 Internal types (`src/core/bpmn-xml-parser.ts`, not exported)

| Entity | Fields | Notes |
|---|---|---|
| `Attr` | `name: string`, `value: string` | Both entity-decoded; name is local name (no prefix) |
| `OpenTagToken` | `kind: "open-tag"`, `localName: string`, `attrs: Attr[]` | |
| `CloseTagToken` | `kind: "close-tag"`, `localName: string` | |
| `SelfCloseToken` | `kind: "self-close-tag"`, `localName: string`, `attrs: Attr[]` | |
| `TextToken` | `kind: "text"`, `value: string` | Decoded; CDATA merged in |
| `ParseErrorToken` | `kind: "parse-error"`, `reason: string` | Ends token stream |
| `ScanContext` | `elementKind: string`, `elementId: string`, `depth: number`, `inExtension: boolean` | Maintained by linter walker; not exported |

### 5.3 Compatibility surface (FE-W23-0008)

The linter imports **only** `parseHandle` from `src/core/object-handle.ts` (read-only import, no modification). No export of `object-handle.ts`, `grant-resolver.ts`, `grant-lattice.ts`, `types.ts`, or `jobStore.ts` is touched. This is enforced by FF-5 (CI isolation check).

---

## 6. Contracts

```ts
// src/core/bpmn-linter.ts — exported API surface (frozen; T-0058/T-0064 wire against this)
export type LintViolationType = "raw_object_binding" | "malformed_xml";
export interface LintViolation {
  type: LintViolationType;
  elementId: string;
  elementKind: string;
  message: string;
}
export type LintResult = { ok: true } | { ok: false; violations: LintViolation[] };
export function lintBpmn(xml: string): LintResult;

// Import from T-0015 (read-only, not re-exported)
import { parseHandle } from "./object-handle.js";

// src/cli/lint-bpmn.ts — CLI invocation
// node dist/cli/lint-bpmn.js <file.bpmn>
// exit 0: ok; exit 1: violations (JSON to stderr) or malformed XML
```

**Deploy-gate invariants T-0058/T-0064 MUST preserve:**
- (a) `lintBpmn` called before deploy endpoint accepts the definition.
- (b) `ok: false` → HTTP 422, violations array returned.
- (c) `type: "malformed_xml"` → also HTTP 422 (fail-closed).
- (d) `lintBpmn` is pure; file/HTTP I/O is caller's responsibility.

---

## 7. Fitness functions

| ID | Rule | ci_check |
|---|---|---|
| **FF-1** | `lintBpmn` returns `ok: true` for handle-shaped and primitive bindings; `ok: false` for raw-object bindings in all scoped element types | `vitest run src/__tests__/bpmn-linter.test.ts` — AC-1..AC-10, AC-14, AC-15 green |
| **FF-2** | Adversarial corpus: malformed XML (AC-6), raw object in attribute (AC-8), raw object in CDATA (AC-9) all return `ok: false` | Same vitest run — these three ACs must be green (adversarial subset) |
| **FF-3** | `LintViolation` shape: all fields present, `elementId: ""` when id absent | `vitest run` — AC-11 |
| **FF-4** | `lintBpmn` is a pure function: no `process.exit`, no `fs.*`, no `http.*`, no `pg.*`, no global state mutation | `tsc --noEmit` + FF-5 isolation check |
| **FF-5** | `bpmn-linter.ts` and `bpmn-xml-parser.ts` import nothing from `jobStore`, `http`, `pg`, `fs`, `net`, or any package outside existing `devDependencies` | `ci/checks/bpmn-linter-isolation.sh` — grep for forbidden imports, exit 1 if found |
| **FF-6** | No existing export of `object-handle.ts`, `grant-resolver.ts`, `grant-lattice.ts`, `types.ts`, `jobStore.ts` is modified | `ci/checks/bpmn-linter-isolation.sh` — `git diff --name-only` must not touch those files; existing test suite for those modules stays green |
| **FF-7** | CLI exits 0 on passing BPMN, exits 1 on violations or malformed XML; violations on stderr as JSON | `vitest run` — AC-14 (integration fixture using `execa` or `node:child_process`) |
| **FF-8** | Parser differential — all §2.2 reject conditions produce `ok: false`: DOCTYPE, non-predefined entities, duplicate attributes, processing instructions, invalid UTF-8, XML 1.1, null bytes, deeply nested (>200 levels) | `vitest run` — dedicated adversarial XML fixtures for each §2.2 row; fixture file: `src/__tests__/fixtures/bpmn-parser-adversarial/` |
| **FF-9** | No new entry in `package.json` `dependencies` (only `devDependencies` allowed for test tooling) | `ci/checks/bpmn-linter-isolation.sh` — `node -e "const p=require('./package.json'); const keys=Object.keys(p.dependencies||{}); if(keys.some(k=>k.includes('xml')||k.includes('bpmn'))) process.exit(1)"` |

---

## 8. Adversarial test fixture corpus (required)

The vitest suite in `src/__tests__/bpmn-linter.test.ts` MUST include the following XML fixtures as inline strings or files under `src/__tests__/fixtures/bpmn/`:

| Fixture | Expected result | AC |
|---|---|---|
| `handle-only.bpmn` — serviceTask with valid serialized `ObjectHandle` string value | `ok: true` | AC-1, AC-7 |
| `primitive-bindings.bpmn` — serviceTask with string / number / boolean variables | `ok: true` | AC-1 |
| `el-expression.bpmn` — conditionExpression with `${someVar}` | `ok: true` | AC-10 |
| `empty-process.bpmn` — BPMN with no service/user/send tasks | `ok: true` | §9 table row |
| `raw-object-service-task.bpmn` — serviceTask extension with `{"registryId":"x","recordId":"y"}` | `ok: false`, `elementKind: "serviceTask"` | AC-2 |
| `raw-object-user-task.bpmn` — userTask extension with `{"data":{"name":"Alice"}}` | `ok: false`, `elementKind: "userTask"` | AC-3 |
| `raw-object-condition.bpmn` — conditionExpression embedding `{"fields":["name"]}` | `ok: false`, `elementKind: "conditionExpression"` | AC-4 |
| `raw-object-data-object.bpmn` — dataObject with `{"applicationId":"a","registryId":"b"}` | `ok: false`, `elementKind: "dataObject"` | AC-5 |
| `malformed-unclosed-tag.xml` — `<serviceTask id="t1"> <!-- no close` | `ok: false`, `type: "malformed_xml"` | AC-6 |
| `adversarial-attr-value.bpmn` — serviceTask with inline raw object in attribute: `value="{registryId:'x',recordId:'y'}"` | `ok: false` | AC-8 |
| `adversarial-cdata.bpmn` — extensionElement with `<![CDATA[{"registryId":"x","recordId":"y"}]]>` | `ok: false` | AC-9 |
| `adversarial-doctype.xml` — `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-entity.xml` — BPMN with `&custom_entity;` in a value | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-duplicate-attr.xml` — element with `value="safe" value="{registryId:'x'}"` | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-processing-instruction.xml` — `<?flowable-deploy execute="bypass"?>` | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-null-byte.xml` — XML with `\0` inside a binding value | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-xml-1-1.xml` — `<?xml version="1.1"?>` declaration | `ok: false`, `type: "malformed_xml"` | FF-8 |
| `adversarial-deep-nesting.xml` — 201 levels of nested elements | `ok: false`, `type: "malformed_xml"` | FF-8 |
| Mock deploy test | `mockDeploy(rawObjectBpmn)` = rejected; `mockDeploy(handleBpmn)` = accepted | AC-15 |

---

## 9. Traceability

| AC | Covered by |
|---|---|
| AC-1 | §3.2 linting algorithm + handle detection pipeline (§2.3) + FF-1 |
| AC-2 | §3.3 scoped elements (serviceTask) + §2.3 raw-object detector + FF-1 |
| AC-3 | §3.3 (userTask) + §2.3 + FF-1 |
| AC-4 | §3.3 (conditionExpression) + §2.3 secondary embedded-object scan + FF-1 |
| AC-5 | §3.3 (dataObject/dataObjectReference) + §2.3 + FF-1 |
| AC-6 | §3.1 tokenizer fail-closed + §2.2 (unclosed tags → parse-error) + FF-2, FF-8 |
| AC-7 | §2.3 detection pipeline step 3 (parseHandle succeeds → not a violation) + FF-1 |
| AC-8 | §3.1 attribute value extraction + §2.3 + FF-2 (adversarial corpus) |
| AC-9 | §3.1 CDATA → text token + §2.3 + FF-2 (adversarial corpus) |
| AC-10 | §2.3 pipeline step 1 (EL `${...}` does not start with `{` after trimming in JSON sense, or JSON.parse throws) + FF-1 |
| AC-11 | §5.1 `LintViolation` interface all fields required + FF-3 |
| AC-12 | §3 module boundary (no forbidden imports) + FF-5, FF-9 |
| AC-13 | §5.3 compatibility surface (additive, no modification to frozen exports) + FF-6 |
| AC-14 | §3.4 CLI design + FF-7 |
| AC-15 | §3.5 deploy contract stub + §8 mock deploy fixture + FF-1 |

---

## 10. Runtime target

**Local** (same envelope as T-0015/T-0018/T-0021): `npm run ci` — `tsc --noEmit && eslint src && npm run fitness && vitest run`. No external resource. The linter is a pure-TS library; it runs wherever Node ≥20 runs. No new infra is provisioned by T-0027.

When Flowable integration lands (T-0058), the linter runs as an in-process call inside the Node.js API server before forwarding the BPMN to the Flowable deploy REST API. No separate process, no RPC.

---

## 11. Escalation

None. This is a bounded security-gate library within the GT-1-signed RBAC hypothesis. The parser-differential risk is addressed by the fail-closed-whitelist design in §2.2; the analyst's zero-dep decision is upheld with architectural justification. No product direction fork; no founder gate required.

The one non-obvious design choice (custom tokenizer vs maintained parser) is documented in §2.1 with the full tradeoff analysis. The conclusion (custom tokenizer is safer under whitelist semantics) is defensible and not reversible without violating NF-1 — but it is not a product-level decision requiring founder approval.

Status: `ready`.

---

## 12. Consequences

**Positive:**
- Raw-object bindings are rejected at deploy time, before a process definition ever runs (the E2.6 deploy-gate guarantee). The runtime guard (T-0028) becomes a defense-in-depth, not the last line.
- The `lintBpmn(xml): LintResult` contract is frozen and available for T-0058/T-0064 to wire against; the deploy-gate placeholder test (AC-15) gives those tasks a compliance test to pass.
- The fail-closed-whitelist parser makes the linter's security properties auditable and non-bypassable by construction: every XML edge class has an explicit documented behavior.
- `parseHandle` is the single source of truth for "is this a valid handle" — no divergence between T-0015 and the linter.

**Negative / accepted costs:**
- The custom tokenizer is ~200–300 lines that must be maintained. This is proportionate (rubric axis 5) to the narrow scope; the alternative (a maintained parser) adds supply-chain surface to a security gate.
- The fail-closed-whitelist means any BPMN that uses a genuinely uncommon but valid XML feature (e.g. a processing instruction added by a third-party toolchain) will be rejected. This is an acceptable false-positive: the BPMN linter is a deploy gate; an operator can fix their toolchain. The inverse (a false-negative that passes a raw-object binding) breaks the E2.6 invariant.
- The adversarial fixture corpus must be maintained alongside the tokenizer; each row in §2.2 must have a corresponding test.
