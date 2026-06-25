/* ============================================================================
   CHOROS — Floor2Sandbox.jsx  (T-0481 · E-FORMS F2)

   THE CLASS-B (custom widget) HOST — the sandbox-iframe for a form-document
   `custom` node. This is the §6 ESCAPE path (the rare, flagged 1%): a truly-new
   custom widget that draws bespoke markup over a named-binding contract, isolated
   in an opaque-origin iframe.

   ISOLATION CONTRACT — reuses the EXISTING forms-sandbox-iframe (T-0101):
   - sandbox="allow-scripts" WITHOUT allow-same-origin → opaque origin ('null'),
     so the widget code cannot reach the parent document, cookies, localStorage,
     or any authority API;
   - the ONLY seam out is the height-postMessage channel, validated by
     acceptFrameHeight (frame-height.js, T-0101) — exactly the gate Floor-1 forms
     and the T-0076 Floor2Viewer use;
   - the widget receives ONLY the named-binding fields the document node declared
     (it binds through the contract; it NEVER touches the process directly —
     ADR §4 invariant). The backend remains the authority on any submitted value.

   WHY a web-local host (not the src/core-coupled Floor2Viewer.jsx): web/** is not
   bundled with src/** (rollup cannot resolve the src/core/*.js twin — the same
   layer boundary frame-height.js documents). This host reuses the T-0101
   isolation MECHANISM (frame-height.js + the sandbox attribute) web-locally,
   keeping the build integration-honest (D-056) while honoring the spec's "reuse
   the forms-sandbox-iframe with its isolation."

   GOVERNANCE: a custom widget is the flagged path. `descriptor.flagged !== true`
   → the host refuses to mount the code and shows a governance notice (mirrors the
   FLOOR2_CUSTOM_FLAG_KEY gate of T-0076 §9.10). The code is never embedded
   without the explicit opt-in.

   Theming: --chs-* tokens only (gate G2/G6).
   ============================================================================ */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { acceptFrameHeight, FRAME_MIN_HEIGHT, FRAME_HEIGHT_MESSAGE_TYPE } from './frame-height.js';

// The sandbox attribute — allow-scripts WITHOUT allow-same-origin. Kept as a
// constant so it is statically verifiable (forms-sandbox-iframe.sh pattern).
export const SANDBOX_ATTR = 'allow-scripts';

/**
 * Pure decision for how to render a class-b descriptor — extracted so it is
 * unit-testable without invoking React hooks. `flagged` gates whether the custom
 * code is embedded at all (§9.10 governance); `sandboxAttr` is the constant
 * isolation attribute (never includes allow-same-origin).
 *
 * @param {{flagged?:boolean}} descriptor
 * @returns {{ flagged:boolean, sandboxAttr:string }}
 */
export function decideSandboxRender(descriptor = {}) {
  return { flagged: descriptor.flagged === true, sandboxAttr: SANDBOX_ATTR };
}

/**
 * Build the iframe srcdoc for a class-b widget. The widget's bound field VALUES
 * are injected read-only as a JSON island; the widget code renders over them and
 * posts its height back. No parent reach is possible (opaque origin).
 *
 * @param {{componentId?:string, code?:string}} descriptor
 * @param {Array<{key:string,label?:string,type?:string,value?:any}>} fields
 * @returns {string} srcdoc HTML
 */
export function buildSandboxSrcdoc(descriptor, fields) {
  // The binding island the widget reads. JSON.stringify is the trust boundary:
  // only plain data crosses in; no functions, no parent refs.
  const island = JSON.stringify({
    componentId: descriptor.componentId || null,
    fields: (fields || []).map((f) => ({ key: f.key, label: f.label || f.key, type: f.type || 'string', value: f.value })),
  });
  // The agent code runs inside the opaque-origin sandbox. We wrap it so a height
  // message is posted after render. The code only sees the `binding` global.
  const userCode = typeof descriptor.code === 'string' ? descriptor.code : '';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>body{margin:0;font-family:system-ui,sans-serif;font-size:14px;color:#222}</style>',
    '</head><body><div id="root"></div><script>',
    `var binding=${island};`,
    'try{',
    userCode || 'document.getElementById("root").textContent = (binding.fields||[]).map(function(f){return f.label+": "+(f.value==null?"\\u2014":f.value)}).join("\\n");',
    '}catch(e){document.getElementById("root").textContent="widget error";}',
    `function postH(){try{parent.postMessage({type:${JSON.stringify(FRAME_HEIGHT_MESSAGE_TYPE)},h:document.documentElement.scrollHeight},"*");}catch(_){}}`,
    'postH();setTimeout(postH,50);',
    '</script></body></html>',
  ].join('');
}

/**
 * Floor2Sandbox — host one class-b widget in an isolated iframe.
 *
 * @param {object} props
 * @param {{componentId?:string, code?:string, flagged?:boolean}} props.descriptor
 * @param {Array} props.fields  named-binding fields (with values) the widget may read
 * @param {Function} [props.onError]
 */
function Floor2Sandbox({ descriptor = {}, fields = [], onError }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(FRAME_MIN_HEIGHT);

  // Governance gate: custom code mounts ONLY when explicitly flagged (§9.10).
  const { flagged } = decideSandboxRender(descriptor);

  const srcdoc = useMemo(() => {
    if (!flagged) return null;
    return buildSandboxSrcdoc(descriptor, fields);
  }, [descriptor, fields, flagged]);

  // Origin-validated height receiver (T-0101 contract): accepts ONLY from our
  // iframe + opaque origin 'null' + correct message shape.
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

  useEffect(() => { setHeight(FRAME_MIN_HEIGHT); }, [descriptor]);

  if (!flagged) {
    // Mirrors CUSTOM_FLAG_MISSING (T-0076): the code is NOT embedded without the
    // explicit governance opt-in.
    if (onError) onError({ code: 'CUSTOM_FLAG_MISSING' });
    return (
      <div className="chs-floor2-flag" role="alert" style={{ padding: 'var(--chs-space-3)', border: '1px dashed var(--chs-color-warning)', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
        Код-виджет «{descriptor.componentId || 'custom'}» не подтверждён — требуется явный флаг (§9.10).
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      className="chs-floor2-sandbox"
      title={`Код-виджет: ${descriptor.componentId || 'custom'}`}
      srcDoc={srcdoc}
      // SECURITY CRITICAL: allow-scripts WITHOUT allow-same-origin → opaque
      // origin. The widget cannot reach the parent, storage, or authority APIs.
      // DO NOT add allow-same-origin — it would defeat the isolation.
      sandbox={SANDBOX_ATTR}
      style={{ height: height + 'px', width: '100%', border: 'none' }}
      data-component-id={descriptor.componentId}
    />
  );
}

export default Floor2Sandbox;
