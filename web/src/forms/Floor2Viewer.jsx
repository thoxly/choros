/* ============================================================================
   CHOROS — Floor2Viewer.jsx
   T-0076 · E11.5: Floor-2 agent-authored React presentation in sandbox-iframe.

   Renders an agent-authored Floor-2 component over a named-binding key,
   inside an isolated sandbox-iframe (opaque origin — no parent-origin reach).

   D7-K boundary (T-0480): Floor-2 is the §6 ESCAPE path (1% — a truly-new custom
   React widget in an opaque sandbox), NOT a field renderer competing with the
   binding-contract catalog. It consumes the SAME BindingField[] contract (§4) but
   draws bespoke agent markup, deliberately outside the unified FieldControl. The
   99% authoring path (drag-n-drop OR AI-emitted form-document) renders through the
   ONE catalog renderer; this viewer is the flagged, sandboxed exception.

   Architecture:
   - Accepts a Floor2RenderDescriptor (vetted or custom) + current binding fields.
   - Validates the descriptor client-side (mirrors server-side validateFloor2Descriptor).
   - Builds srcdoc via buildFloor2Srcdoc — agent code NEVER executes in the parent.
   - Uses sandbox="allow-scripts" WITHOUT allow-same-origin (opaque origin 'null').
   - Height auto-adjusts via postMessage, validated by acceptFrameHeight (T-0101).

   SECURITY CONTRACT (§4 / §7 ADR):
   - The iframe sandbox MUST be "allow-scripts" only (no allow-same-origin).
   - Agent-authored code executes inside the opaque-origin sandbox.
   - The only seam out is the height-postMessage channel, origin-validated here.
   - For custom mode: FLOOR2_CUSTOM_FLAG_KEY must be set (§9.10 governance flag).
   - Backend validation (form-validator.ts T-0102) remains the authority on
     submitted values — the iframe presentation is UNTRUSTED (§4 invariant).

   Props:
   - descriptor:  Floor2RenderDescriptor (vetted | custom)
   - fields:      BindingField[] — current named-binding fields (§4 contract)
   - theme:       'dark' | 'light'
   - onError:     optional callback(errors) when descriptor validation fails
   ============================================================================ */

import React, { useEffect, useRef, useState, useMemo } from 'react';

// Pure renderer from core (browser-compatible — no Node.js I/O)
// NOTE: In the Vite build, we import from the TS source compiled by tsc;
// for the browser runtime the functions are bundled. In the web context
// the functions are self-contained pure JS after transpilation.
import {
  buildFloor2Srcdoc,
  FLOOR2_SANDBOX_ATTR,
  assertSandboxAttr,
} from '../../../src/core/floor2-renderer.js';

// Canonical height-channel receiver from T-0101 (mirrors frame-height.js but
// imported from the TS twin that's unit-tested).
import { acceptFrameHeight, FRAME_MIN_HEIGHT } from './frame-height.js';

const MIN_HEIGHT = FRAME_MIN_HEIGHT;

/**
 * Floor2Viewer — renders one Floor-2 component inside a sandboxed iframe.
 *
 * @param {object} props
 * @param {import('../../../src/core/floor2-renderer.js').Floor2RenderDescriptor} props.descriptor
 * @param {Array} props.fields  BindingField[] from the named-binding contract
 * @param {'dark'|'light'} [props.theme]
 * @param {Function} [props.onError]  callback({ errors }) on validation failure
 */
function Floor2Viewer({ descriptor, fields, theme, onError }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  // Development-time invariant assertion: sandbox attribute must not change.
  // FLOOR2_SANDBOX_ATTR is a constant — this is purely defensive.
  if (process.env.NODE_ENV !== 'production') {
    const check = assertSandboxAttr(FLOOR2_SANDBOX_ATTR);
    if (!check.ok) {
      // This is a programming error in the constant itself — surface loudly.
      throw new Error(
        `[Floor2Viewer] FLOOR2_SANDBOX_ATTR "${FLOOR2_SANDBOX_ATTR}" failed invariant check: ` +
        check.violations.join('; '),
      );
    }
  }

  // Build srcdoc from descriptor + binding fields.
  // useMemo: only rebuilds when descriptor or fields change.
  const srcdocResult = useMemo(() => {
    if (!descriptor || !fields) return null;
    return buildFloor2Srcdoc(descriptor, fields, theme || 'dark');
  }, [descriptor, fields, theme]);

  // Report validation errors to parent if descriptor is invalid.
  useEffect(() => {
    if (srcdocResult && !srcdocResult.ok && onError) {
      onError({ errors: srcdocResult.errors });
    }
  }, [srcdocResult, onError]);

  // Origin-validated postMessage receiver for auto-height (T-0101 contract).
  // Accepts ONLY from our iframe + opaque origin 'null' + correct shape.
  useEffect(() => {
    function onMessage(e) {
      const win = iframeRef.current && iframeRef.current.contentWindow;
      if (!win) return;
      const h = acceptFrameHeight(e, win);
      if (h !== null) setHeight(h);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Reset height on descriptor change (new component type / new binding).
  useEffect(() => {
    setHeight(MIN_HEIGHT);
  }, [descriptor]);

  // Render error state if validation failed.
  if (srcdocResult && !srcdocResult.ok) {
    return (
      <div
        className="chs-floor2-error"
        role="alert"
        aria-live="assertive"
        style={{ color: 'var(--color-error, #c00)', padding: '8px', fontSize: '0.875rem' }}
      >
        <strong>Floor-2 descriptor error:</strong>{' '}
        {srcdocResult.errors.map((e) => e.message).join(' | ')}
      </div>
    );
  }

  // Show loading state until srcdoc is ready.
  if (!srcdocResult || !srcdocResult.ok) {
    return <div className="chs-floor2-loading" aria-busy="true" style={{ minHeight: MIN_HEIGHT + 'px' }} />;
  }

  const srcdoc = srcdocResult.srcdoc;
  const mode = descriptor.mode;
  const bindingKey = descriptor.bindingKey;
  // sandboxAttr from srcdocResult is always FLOOR2_SANDBOX_ATTR — use constant directly
  // so the sandbox attribute is statically verifiable by CI (forms-sandbox-iframe.sh pattern).

  return (
    <iframe
      ref={iframeRef}
      className="chs-floor2-viewer"
      title={`Floor-2 component: ${bindingKey} (${mode})`}
      srcDoc={srcdoc}
      // SECURITY CRITICAL: sandbox="allow-scripts" without allow-same-origin.
      // This gives the agent code an opaque origin ('null') — it cannot reach
      // the parent document, localStorage, cookies, or authority APIs.
      // DO NOT add allow-same-origin here — it would defeat the isolation.
      sandbox="allow-scripts"
      style={{ height: height + 'px', width: '100%', border: 'none' }}
      aria-label={`Floor-2 presentation for field: ${bindingKey}`}
      data-floor2-mode={mode}
      data-binding-key={bindingKey}
    />
  );
}

export default Floor2Viewer;
