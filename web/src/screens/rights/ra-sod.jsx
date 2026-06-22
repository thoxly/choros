/* ============================================================================
   CHOROS — ra-sod.jsx
   ЭКРАН 3: РАЗДЕЛЕНИЕ ОБЯЗАННОСТЕЙ (SoD).

   T-0375 [D2]: removed hardcoded SOD_SUBJECT / SOD_CANDIDATES mock data and
   the hardcoded SOD_RULES registry — screen now shows an honest empty state.
   Real implementation requires:
     GET  /api/rights/sod-rules                — tenant SoD rule registry
     GET  /api/rights/sod-check?candidate=:roleId&subjectId=:id  — live conflict check
   These endpoints do not exist yet.  Follow-up: T-0375-FU-sod-api.
   ============================================================================ */

import React from 'react';
import { EmptyState } from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';

function SoDScreen() {
  return (
    <div className="chs-sod-screen">
      <div className="chs-sod-screen__inner">
        <EmptyState
          icon={<Icon name="rights" />}
          title="Правила разделения обязанностей не настроены"
          description="Правила разделения обязанностей пока не настроены для этого тенанта. После добавления они будут проверяться автоматически при каждом назначении роли."
        />
      </div>
    </div>
  );
}

export default SoDScreen;
