/* T-0655 (§6.4) — unit tests for the PURE org-tree move/DnD helpers. DB/DOM-free,
   mirrors sidebar-dnd.test.js. */

import { describe, it, expect } from 'vitest';
import {
  computeEmployeeDrop,
  computeMoveEmployeeToPosition,
  buildRenamePayload,
  MOVE_ENDPOINT,
} from './org-move-dnd.js';

const idMaps = {
  employees: { 'e-jo': 'emp-uuid-1', 'a-bot': 'emp-uuid-2' },
  positions: { 'pos-a': 'pos-uuid-a', 'pos-b': 'pos-uuid-b' },
};

describe('computeEmployeeDrop', () => {
  it('resolves employee + target position uuids into a PATCH payload', () => {
    const r = computeEmployeeDrop({
      employeeSlug: 'e-jo', fromPositionSlug: 'pos-a', toPositionSlug: 'pos-b', idMaps,
    });
    expect(r).toEqual({ employeeId: 'emp-uuid-1', body: { position_id: 'pos-uuid-b' } });
  });

  it('no-op when dropped onto the same position', () => {
    expect(computeEmployeeDrop({
      employeeSlug: 'e-jo', fromPositionSlug: 'pos-a', toPositionSlug: 'pos-a', idMaps,
    })).toBeNull();
  });

  it('refuses (null) when the employee slug does not resolve', () => {
    expect(computeEmployeeDrop({
      employeeSlug: 'unknown', fromPositionSlug: 'pos-a', toPositionSlug: 'pos-b', idMaps,
    })).toBeNull();
  });

  it('refuses (null) when the target position does not resolve', () => {
    expect(computeEmployeeDrop({
      employeeSlug: 'e-jo', fromPositionSlug: 'pos-a', toPositionSlug: 'pos-zzz', idMaps,
    })).toBeNull();
  });

  it('refuses (null) with missing slugs', () => {
    expect(computeEmployeeDrop({ employeeSlug: '', toPositionSlug: 'pos-b', idMaps })).toBeNull();
    expect(computeEmployeeDrop({ employeeSlug: 'e-jo', toPositionSlug: '', idMaps })).toBeNull();
  });
});

describe('computeMoveEmployeeToPosition', () => {
  it('builds a position_id body from a chosen target', () => {
    expect(computeMoveEmployeeToPosition('emp-uuid-1', 'pos-uuid-a'))
      .toEqual({ body: { position_id: 'pos-uuid-a' } });
  });
  it('null target → снять с должности (position_id: null)', () => {
    expect(computeMoveEmployeeToPosition('emp-uuid-1', null))
      .toEqual({ body: { position_id: null } });
    expect(computeMoveEmployeeToPosition('emp-uuid-1', undefined))
      .toEqual({ body: { position_id: null } });
  });
});

describe('buildRenamePayload', () => {
  it('department/employee rename → display_name', () => {
    expect(buildRenamePayload('department', 'Финансы')).toEqual({ display_name: 'Финансы' });
    expect(buildRenamePayload('employee', 'Джо')).toEqual({ display_name: 'Джо' });
  });
  it('position rename → title', () => {
    expect(buildRenamePayload('position', 'Ведущий')).toEqual({ title: 'Ведущий' });
  });
  it('trims and rejects blank', () => {
    expect(buildRenamePayload('department', '  X  ')).toEqual({ display_name: 'X' });
    expect(buildRenamePayload('department', '   ')).toEqual({});
    expect(buildRenamePayload('unknown', 'X')).toEqual({});
  });
});

describe('MOVE_ENDPOINT', () => {
  it('maps entity kinds to path segments', () => {
    expect(MOVE_ENDPOINT).toEqual({
      department: 'departments', position: 'positions', employee: 'employees',
    });
  });
});
