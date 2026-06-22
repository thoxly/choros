/* ============================================================================
   CHOROS — ra-criticality.jsx
   ЭКРАН 2: КРИТИЧНОСТЬ И DUAL-CONTROL.

   T-0375 [D2]: removed hardcoded SCENARIOS mock — screen now shows an honest
   empty state.  Real implementation requires:
     GET  /api/rights/change-requests          — pending change requests (paged)
     POST /api/rights/change-requests/:id/approve|reject — dual-control action
   These endpoints do not exist yet.  Follow-up: T-0375-FU-criticality-api.
   ============================================================================ */

import React from 'react';
import { EmptyState } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';

function CriticalityScreen() {
  return (
    <div className="chs-crit-screen">
      <div className="chs-crit-screen__inner">
        <EmptyState
          icon={<Icon name="rights" />}
          title="Запросов на изменение прав нет"
          description="Когда кто-то запросит изменение роли, требующее подтверждения, оно появится здесь. Критичные изменения требуют двух аппруверов (dual-control)."
        />
      </div>
    </div>
  );
}

export default CriticalityScreen;
