// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ status: 'anon', person: null }) }));
vi.mock('@portal/lib/qr', () => ({ qrDataUrl: vi.fn((text: string) => `data:image/png;base64,QR-${text}`) }));

import { qrDataUrl } from '@portal/lib/qr';

import { setToken } from '../lib/session';
import Done from './Done';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const signed = (n: number) => ({
  assignment_id: `a-${n}`, title: `Doc ${n}`, status: 'signed', minutes: 3, has_quiz: false,
  locked: false, signed_at: '2026-11-04T15:00:00Z',
});

function renderDone() {
  return render(
    <MemoryRouter initialEntries={['/done']}>
      <Routes>
        <Route path="/done" element={<Done />} />
        <Route path="/training" element={<p>training page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { sessionStorage.clear(); setToken('tok', LATER, 'Kenji'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Done', () => {
  it('shows the time clock QR with a download link and the notes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      groups: [{ initiative: null, due_on: null, items: [signed(1), signed(2)] }],
      complete: true, badge_uid: 'badge-123',
    })));
    renderDone();
    expect(await screen.findByText("You're all set, Kenji")).toBeTruthy();
    expect(screen.getByText('All 2 signed.')).toBeTruthy();
    expect(qrDataUrl).toHaveBeenCalledWith('badge-123');
    const img = screen.getByRole('img', { name: 'Your time clock QR code' });
    expect(img.getAttribute('src')).toBe('data:image/png;base64,QR-badge-123');
    const save = screen.getByRole('link', { name: 'Save to phone' });
    expect(save.getAttribute('download')).toBe('serversherpa-timeclock-qr.png');
    expect(save.getAttribute('href')).toBe('data:image/png;base64,QR-badge-123');
    expect(screen.getByText('Your time clock code. Scan it at the station when you clock in.')).toBeTruthy();
    expect(screen.getByText("We also emailed it to you. Don't share it: it clocks you in.")).toBeTruthy();
  });

  it('sends a worker with work left back to the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      groups: [{ initiative: null, due_on: null, items: [{ ...signed(1), status: 'assigned', signed_at: null }] }],
      complete: false, badge_uid: null,
    })));
    renderDone();
    expect(await screen.findByText('training page')).toBeTruthy();
  });

  it('says so when the QR cannot be drawn, and offers no download', async () => {
    vi.mocked(qrDataUrl).mockImplementationOnce(() => { throw new Error('no canvas'); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      groups: [{ initiative: null, due_on: null, items: [signed(1)] }], complete: true, badge_uid: 'badge-123',
    })));
    renderDone();
    expect((await screen.findByRole('alert')).textContent)
      .toBe("We couldn't draw your time clock code. Reload this page to try again.");
    expect(screen.queryByRole('img', { name: 'Your time clock QR code' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Save to phone' })).toBeNull();
  });
});
