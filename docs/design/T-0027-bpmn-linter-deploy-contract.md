# Deploy-gate contract · T-0027 → T-0058 / T-0064

**Status:** frozen stub (this doc is the authoritative contract; T-0058/T-0064 implement the wire)
**Date:** 2026-06-10

---

## Contract

```
lintBpmn(xml: string): LintResult
  LintResult = { ok: true } | { ok: false; violations: LintViolation[] }
```

### Invariants T-0058 / T-0064 MUST preserve when wiring

| ID | Invariant |
|---|---|
| DG-1 | `lintBpmn` is called on the raw BPMN XML bytes (as a UTF-8 string) before the deploy endpoint accepts the process definition. The call happens before any Flowable REST call. |
| DG-2 | If `ok: false`, the deploy is rejected with HTTP 422 (Unprocessable Entity) and the `violations` array is returned in the response body. |
| DG-3 | A `violations` entry with `type: "malformed_xml"` also produces HTTP 422 (fail-closed — malformed XML is not a valid deployment candidate). |
| DG-4 | `lintBpmn` itself is a pure function; any file read or HTTP I/O is the caller's (deploy endpoint's) responsibility. |
| DG-5 | The linter is called at deploy time, not at runtime. The runtime complement is T-0028. |

### Mock deploy test (AC-15)

`src/__tests__/bpmn-linter.test.ts` contains a mock deploy function that validates the above invariants. When T-0058 ships the real Flowable deploy endpoint, the mock MUST be replaced by an integration fixture against the real endpoint; until then, the mock is the compliance test.

```ts
// Pseudocode — exact fixture is in bpmn-linter.test.ts
function mockDeploy(xml: string): { accepted: boolean; violations?: LintViolation[] } {
  const result = lintBpmn(xml);
  if (!result.ok) return { accepted: false, violations: result.violations };
  // ... would forward to Flowable
  return { accepted: true };
}

// AC-15 assertions:
expect(mockDeploy(rawObjectBpmn).accepted).toBe(false);
expect(mockDeploy(handleOnlyBpmn).accepted).toBe(true);
```

---

*This stub is intentionally minimal. T-0058 owns the Flowable deploy endpoint spec; this doc fixes only the linter wire contract it must satisfy.*
