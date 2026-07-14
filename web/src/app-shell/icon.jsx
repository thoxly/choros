/* ============================================================================
   CHOROS — icon.jsx
   Простые линейные иконки (минимальная геометрия).
   Вынесены отдельно чтобы избежать circular imports между shell.jsx и screens.
   ============================================================================ */

import React from 'react';

function Icon({ name, className }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {name === "inbox" && (<><path {...p} d="M2 4.5h12v7H2z" /><path {...p} d="M2 9.5h3l1 1.5h4l1-1.5h3" /></>)}
      {name === "org" && (<><rect {...p} x="6" y="2" width="4" height="3" /><rect {...p} x="1.5" y="11" width="4" height="3" /><rect {...p} x="10.5" y="11" width="4" height="3" /><path {...p} d="M8 5v3M3.5 11V8h9v3" /></>)}
      {name === "process" && (<><circle {...p} cx="3.5" cy="8" r="1.8" /><circle {...p} cx="12.5" cy="8" r="1.8" /><path {...p} d="M5.3 8h5.4" /></>)}
      {name === "audit" && (<><path {...p} d="M8 2v12" /><circle {...p} cx="8" cy="4" r="1.4" /><circle {...p} cx="8" cy="8" r="1.4" /><circle {...p} cx="8" cy="12" r="1.4" /></>)}
      {name === "budget" && (<><rect {...p} x="2" y="3" width="12" height="10" rx="1" /><path {...p} d="M2 9.5h5l1-2 1.5 3 1-1.5H14" /></>)}
      {name === "search" && (<><circle {...p} cx="7" cy="7" r="4.2" /><path {...p} d="M10.2 10.2L14 14" /></>)}
      {name === "chevron" && (<path {...p} d="M6 4l4 4-4 4" />)}
      {name === "moon" && (<path {...p} d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" />)}
      {name === "sun" && (<><circle {...p} cx="8" cy="8" r="3" /><path {...p} d="M8 1.5v1.5M8 13v1.5M2.4 2.4l1 1M12.6 12.6l1 1M1.5 8H3M13 8h1.5M2.4 13.6l1-1M12.6 3.4l1-1" /></>)}
      {name === "check" && (<path {...p} d="M3 8.5l3.2 3L13 5" />)}
      {name === "filter" && (<path {...p} d="M2.5 4h11l-4.2 5v3.5L6.7 14V9z" />)}
      {name === "plus" && (<path {...p} d="M8 3v10M3 8h10" />)}
      {name === "dots" && (<><circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" /></>)}
      {name === "split" && (<><path {...p} d="M4 2.5v4M4 6.5c0 4 8 1 8 5" /><circle {...p} cx="4" cy="2" r="1.2" /><circle {...p} cx="12" cy="13" r="1.2" /></>)}
      {name === "rights" && (<><path {...p} d="M8 1.8l5 1.7v4.1c0 3-2.1 5.1-5 6.4-2.9-1.3-5-3.4-5-6.4V3.5z" /><circle {...p} cx="8" cy="7" r="1.3" /><path {...p} d="M8 8.3v2.1" /></>)}
      {name === "forms" && (<><rect {...p} x="3" y="2" width="10" height="12" rx="1" /><path {...p} d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" /></>)}
      {name === "bell" && (<><path {...p} d="M4 6.5a4 4 0 018 0c0 3 1 4 1.5 5h-11C3 10.5 4 9.5 4 6.5z" /><path {...p} d="M6.5 13a1.5 1.5 0 003 0" /></>)}
      {name === "apps" && (<><rect {...p} x="2" y="2" width="5" height="5" rx="1" /><rect {...p} x="9" y="2" width="5" height="5" rx="1" /><rect {...p} x="2" y="9" width="5" height="5" rx="1" /><rect {...p} x="9" y="9" width="5" height="5" rx="1" /></>)}
      {name === "assistant" && (<><path {...p} d="M2.5 3.5h11a1 1 0 011 1v6.5a1 1 0 01-1 1H9l-3 2v-2H3.5a1 1 0 01-1-1V4.5a1 1 0 011-1z" /><path {...p} d="M5.5 7.5h5M5.5 9.5h3" /></>)}
    </svg>
  );
}

export { Icon };
export default Icon;
