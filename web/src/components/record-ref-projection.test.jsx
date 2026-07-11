// @vitest-environment jsdom
/* ============================================================================
   T-0756 (E16 §6, capstone T-0691 P1) — RecordRef `projection` prop.

   The process card «Запись-источник» used to fetch GET /api/records/:id and, on
   the 404 the acting participant hit (draft-hidden / not READ-granted), fall back
   to rendering the RAW UUID in a <MonoId> chip. RecordRef now accepts a
   server-resolved SAFE projection { id, title, typeLabel, canOpen, appId? } and
   renders it DIRECTLY — no fetch, human title always, «открыть» link ONLY when
   canOpen. These jsdom mount tests pin that behavior (mirrors the
   screen-record-detail.mount.test.jsx harness).
   ============================================================================ */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { RecordRef } from './components.jsx';

afterEach(() => cleanup());

const RECORD_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const APP_ID = 'bbbbbbbb-5555-6666-7777-888888888888';
const TITLE = 'человеко-заголовок записи';

describe('T-0756 RecordRef projection prop', () => {
  it('canOpen:true → renders the human title as a link to the record card, WITHOUT a fetch', () => {
    const fetchSpy = vi.fn();
    render(
      <RecordRef
        recordId={RECORD_ID}
        projection={{ id: RECORD_ID, title: TITLE, typeLabel: 'Заявка', canOpen: true, appId: APP_ID }}
        fetchImpl={fetchSpy}
      />,
    );
    const link = screen.getByText(TITLE);
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`/apps/${APP_ID}/records/${RECORD_ID}`);
    // The raw UUID never appears as the visible label.
    expect(link.textContent).toBe(TITLE);
    // The projection is authoritative — RecordRef must NOT fetch /api/records/:id.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('canOpen:false → renders the human title as PLAIN TEXT (no dead link, no raw UUID), no fetch', () => {
    const fetchSpy = vi.fn();
    const { container } = render(
      <RecordRef
        recordId={RECORD_ID}
        projection={{ id: RECORD_ID, title: TITLE, typeLabel: 'Заявка', canOpen: false }}
        fetchImpl={fetchSpy}
      />,
    );
    const el = screen.getByText(TITLE);
    expect(el.tagName).not.toBe('A');       // no navigable link when it can't be opened
    expect(el.querySelector('a')).toBeNull();
    // The raw record UUID must NOT be rendered anywhere.
    expect(container.textContent).not.toContain(RECORD_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projection with an empty title → honest sentinel, never the raw UUID', () => {
    const { container } = render(
      <RecordRef recordId={RECORD_ID} projection={{ id: RECORD_ID, title: '', canOpen: false }} fetchImpl={vi.fn()} />,
    );
    expect(container.textContent).not.toContain(RECORD_ID);
    expect(container.textContent.length).toBeGreaterThan(0);
  });

  it('no projection → existing fetch/deny fallback is UNCHANGED (backward compat)', async () => {
    // A 404 with no projection keeps the pre-T-0756 behavior: the honest MonoId
    // chip (raw id, secondary) — the projection path does not alter it.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    render(<RecordRef recordId={RECORD_ID} headers={{}} fetchImpl={fetchImpl} />);
    // Fetch IS attempted on the no-projection path.
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalled();
  });
});
