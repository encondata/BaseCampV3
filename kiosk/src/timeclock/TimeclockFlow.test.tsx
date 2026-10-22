// @vitest-environment jsdom
/** The time clock flow against a fake backend: finding a person (a badge
 *  or QR scan into the hidden input, or the on-screen keyboard), the
 *  confirm and action screens, both punches, the badge branch, the error
 *  paths, and the timers that hand the screen back to the next person. */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no Web Audio API; the flow owes the Sound tab the call.
const sound = vi.hoisted(() => ({ playScanSound: vi.fn() }));
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return { ...actual, playScanSound: sound.playScanSound };
});

// The kiosk's sync status, driven by the tests (kiosk mode re-reads the
// people list when a sync finishes).
const syncStore = vi.hoisted(() => {
  let current: { phase: string } = { phase: 'idle' };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: { phase: string }) { current = next; listeners.forEach((fn) => fn()); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
});
vi.mock('../lib/sync', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useSyncStatus: () => useSyncExternalStore(syncStore.subscribe, syncStore.get) };
});

import { ApiError, type KioskPersonRow, type KioskTimeclockStatus } from '../lib/api';
import { DEFAULT_APPEARANCE, hslCss } from '../lib/appearance';
import { clearFlash, readFlash } from '../lib/flash';
import type { TimeclockBackend } from './backend';
import { DONE_MS, IDLE_MS, PRINTING_MS, type FlowMode } from './flow';
import { formatClock, formatPunch } from './format';
import TimeclockFlow from './TimeclockFlow';

const BADGE = '6f1c2a9e-1b2c-4d3e-8f90-1234567890ab';

const ALEX: KioskPersonRow = {
  id: 'p-alex', display_name: 'Alex Johnson', first_name: 'Alex', last_name: 'Johnson',
  preferred_name: null, rfid_tag: '000000000000100348', badge_uid: BADGE,
  job_title: 'Field Technician', external_id: '1042', is_worker: true, has_account: false,
};
const TINA: KioskPersonRow = {
  id: 'p-tina', display_name: 'Tina Nguyen', first_name: 'Tina', last_name: 'Nguyen',
  preferred_name: 'Tee', rfid_tag: null, job_title: 'Crew Lead', external_id: null,
  is_worker: true, has_account: false,
};
const SHORT_TAG: KioskPersonRow = {
  id: 'p-short', display_name: 'Short Tag', first_name: 'Short', last_name: 'Tag',
  preferred_name: null, rfid_tag: '1003', is_worker: true, has_account: false,
};
const LONG_TAG: KioskPersonRow = {
  id: 'p-long', display_name: 'Long Tag', first_name: 'Long', last_name: 'Tag',
  preferred_name: null, rfid_tag: '100348', is_worker: true, has_account: false,
};

const IN_AT = '2026-10-20T13:02:00Z';
const OUT_AT = '2026-10-20T17:00:00Z';
const BACK_AT = '2026-10-20T17:30:00Z';

function statusOf(
  p: KioskPersonRow, clockedIn: boolean, over: Partial<KioskTimeclockStatus> = {},
): KioskTimeclockStatus {
  return {
    person: {
      id: p.id, display_name: p.display_name, first_name: p.first_name, last_name: p.last_name,
      preferred_name: p.preferred_name, avatar_url: null, rfid_tag: p.rfid_tag,
      job_title: p.job_title ?? null, external_id: p.external_id ?? null,
    },
    clocked_in: clockedIn,
    entry: clockedIn ? {
      id: 'e-1', started_at: BACK_AT, initiative_id: null, initiative_name: null, site_id: null, site_name: null,
    } : null,
    last_entry: null,
    today_minutes: 0,
    today_entries: [],
    ...over,
  };
}

const ON_444 = (p: KioskPersonRow = ALEX) => statusOf(p, true, {
  today_minutes: 444,
  today_entries: [
    { clock_in_at: IN_AT, clock_out_at: OUT_AT, minutes: 238 },
    { clock_in_at: BACK_AT, clock_out_at: null, minutes: 206 },
  ],
});

type Fake = { [K in keyof TimeclockBackend]: ReturnType<typeof vi.fn> };

function fakeBackend(people: KioskPersonRow[] = [ALEX, TINA]): Fake {
  return {
    people: vi.fn(async () => people),
    status: vi.fn(async (id: string) => statusOf(people.find((p) => p.id === id) ?? ALEX, false)),
    clockIn: vi.fn(async (id: string) => statusOf(people.find((p) => p.id === id) ?? ALEX, true)),
    clockOut: vi.fn(async (id: string) => statusOf(people.find((p) => p.id === id) ?? ALEX, false)),
  };
}

let backend: Fake;
let user: ReturnType<typeof userEvent.setup>;

function renderFlow(
  mode: FlowMode = 'station',
  extra: { onExit?: () => void; paused?: boolean; keyMissing?: boolean } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<TimeclockFlow mode={mode} backend={backend as unknown as TimeclockBackend} {...extra} />}
        />
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const scanInput = () => screen.getByLabelText('Scan your code') as HTMLInputElement;
const searchBox = () => screen.getByPlaceholderText('Start typing your name…') as HTMLInputElement;
const heading = (name: string | RegExp) => screen.findByRole('heading', { name });
/** A paragraph whose words are split across inline elements. */
const textOf = (text: string) => screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text);

/** Waits for the people list (the hidden input matches against it). */
async function peopleLoaded() {
  await waitFor(() => expect(backend.people).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
}

async function scan(code: string) {
  await peopleLoaded();
  await user.type(scanInput(), code);
}

async function toAction(code = `${BADGE}{Enter}`) {
  await scan(code);
  await user.click(await screen.findByRole('button', { name: /Yes, that's me/ }));
  await heading('What would you like to do?');
}

beforeEach(() => {
  syncStore.set({ phase: 'idle' });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  backend = fakeBackend();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearFlash();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Welcome (station)', () => {
  it('greets and offers both ways in; the hidden input holds focus', async () => {
    renderFlow();
    expect(await heading('Welcome!')).toBeTruthy();
    expect(screen.getByText('Please identify yourself to continue.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Scan Your QR Code/ }).textContent)
      .toContain('Scan your code with the reader');
    expect(screen.getByRole('button', { name: /Enter Your Name/ }).textContent).toContain('Type your name on screen');
    await waitFor(() => expect(document.activeElement).toBe(scanInput()));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('shows the brand header, the footer line, and a Settings gear that goes to sign-in', async () => {
    renderFlow();
    expect(screen.getByText('DATACENTER RELOCATION TOOLS')).toBeTruthy();
    expect(screen.getByText('TRACK | MONITOR | VERIFY | COMPLETE')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Login page')).toBeTruthy();
  });

  it('keeps the date and time live', async () => {
    vi.setSystemTime(new Date('2026-10-20T15:24:10'));
    renderFlow();
    const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(screen.getByText(time(new Date('2026-10-20T15:24:10')))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(time(new Date('2026-10-20T15:25:10')))).toBeTruthy();
  });

  it('a badge UUID + Enter shows Is this you? with name, job title and employee ID', async () => {
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    expect(await heading('Is this you?')).toBeTruthy();
    expect(screen.getByText('Alex Johnson')).toBeTruthy();
    expect(screen.getByText('Field Technician')).toBeTruthy();
    expect(screen.getByText('Employee ID 1042')).toBeTruthy();
    expect(backend.status).toHaveBeenCalledWith('p-alex');
    expect(sound.playScanSound).toHaveBeenCalledWith('good');
    expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.good_scan));
  });

  it('a person with no photo shows initials; a photo shows the image', async () => {
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    await heading('Is this you?');
    expect(screen.getByText('AJ')).toBeTruthy();
    cleanup();

    backend.status.mockResolvedValue({
      ...statusOf(ALEX, false), person: { ...statusOf(ALEX, false).person, avatar_url: '/a.png' },
    });
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    await heading('Is this you?');
    expect(document.querySelector('img.tcx-avatar')?.getAttribute('src')).toBe('/a.png');
    expect(screen.queryByText('AJ')).toBeNull();
  });

  it('an RFID with leading zeros selects its owner without Enter', async () => {
    renderFlow();
    await scan('000000000000100348');
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-alex'));
  });

  it('an unknown code flashes not-found and stays on Welcome', async () => {
    renderFlow();
    await scan('nope123{Enter}');
    expect(await screen.findByText("We couldn't find that code.")).toBeTruthy();
    expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
    expect(readFlash()?.color).toBe(hslCss(DEFAULT_APPEARANCE.not_found_scan));
    expect(screen.getByRole('heading', { name: 'Welcome!' })).toBeTruthy();
    expect(backend.status).not.toHaveBeenCalled();
    expect(scanInput().value).toBe('');
  });

  it('a value that is also a prefix of a longer RFID waits for the rest', async () => {
    backend = fakeBackend([SHORT_TAG, LONG_TAG]);
    renderFlow();
    await scan('1003');
    expect(backend.status).not.toHaveBeenCalled();
    await user.type(scanInput(), '48');
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-long'));
  });

  it('Enter still selects the exact match even though it is an ambiguous prefix', async () => {
    backend = fakeBackend([SHORT_TAG, LONG_TAG]);
    renderFlow();
    await scan('1003{Enter}');
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-short'));
  });

  it('a partial value with no Enter is cleared after 1.5 s of quiet', async () => {
    renderFlow();
    await scan('zz9');
    expect(scanInput().value).toBe('zz9');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(scanInput().value).toBe('zz9');
    act(() => { vi.advanceTimersByTime(600); });
    expect(scanInput().value).toBe('');
    expect(backend.status).not.toHaveBeenCalled();
  });

  it('an ambiguous prefix that never gets Enter selects its exact match after 1.5 s', async () => {
    backend = fakeBackend([SHORT_TAG, LONG_TAG]);
    renderFlow();
    await scan('1003');
    expect(backend.status).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1_600); });
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-short'));
  });

  it('a hung lookup that times out releases the input and says the portal is unreachable', async () => {
    backend.status.mockImplementation(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new ApiError(0, 'network')), 10_000);
    }));
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    await waitFor(() => expect(scanInput().disabled).toBe(true));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(await screen.findByText("Can't reach the portal. Try again.")).toBeTruthy();
    expect(scanInput().disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(scanInput()));
  });

  it('a lookup that answers after the flow unmounted does nothing', async () => {
    let resolve!: (s: KioskTimeclockStatus) => void;
    backend.status.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { unmount } = renderFlow();
    await scan(`${BADGE}{Enter}`);
    await waitFor(() => expect(backend.status).toHaveBeenCalled());
    unmount();
    clearFlash();
    sound.playScanSound.mockClear();
    await act(async () => { resolve(statusOf(ALEX, false)); });
    expect(sound.playScanSound).not.toHaveBeenCalled();
    expect(readFlash()).toBeNull();
  });

  it('paused: says so, and both cards are disabled', async () => {
    renderFlow('station', { paused: true });
    expect(await screen.findByText(
      'This time clock is paused. Ask an administrator to sign in here or renew this kiosk on Kiosk Devices.',
    )).toBeTruthy();
    expect((screen.getByRole('button', { name: /Scan Your QR Code/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Enter Your Name/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('waiting for the station key: says so, and both cards are disabled', async () => {
    renderFlow('station', { paused: true, keyMissing: true });
    expect(await screen.findByText(
      'This time clock is waiting for its station key. Check the connection, or ask an administrator to sign in here.',
    )).toBeTruthy();
    expect(screen.queryByText(/This time clock is paused\./)).toBeNull();
    expect((screen.getByRole('button', { name: /Scan Your QR Code/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Enter Your Name/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a status lookup that cannot reach the portal says so and stays put', async () => {
    backend.status.mockRejectedValue(new ApiError(0, 'network'));
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    expect(await screen.findByText("Can't reach the portal. Try again.")).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Welcome!' })).toBeTruthy();
  });
});

describe('Enter Your Name', () => {
  it('on-screen keys T, I, N find the person; a result row confirms them', async () => {
    localStorage.setItem('ss.kiosk.tcKeyboard', 'shown');
    renderFlow();
    await peopleLoaded();
    await user.click(screen.getByRole('button', { name: /Enter Your Name/ }));
    expect(await heading('Enter Your Name')).toBeTruthy();
    expect(screen.getByText('Type your name below to find your account.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(searchBox()));

    for (const key of ['T', 'I', 'N']) await user.click(screen.getByRole('button', { name: key }));
    expect(searchBox().value).toBe('Tin');
    // the keys never pull focus off the box a badge reader types into
    expect(document.activeElement).toBe(searchBox());

    await user.click(await screen.findByRole('button', { name: /Tina Nguyen/ }));
    expect(await heading('Is this you?')).toBeTruthy();
    expect(backend.status).toHaveBeenCalledWith('p-tina');
    expect(screen.queryByText(/Employee ID/)).toBeNull();
  });

  describe('keyboard toggle', () => {
    const KEY = 'ss.kiosk.tcKeyboard';
    const kb = () => screen.queryByRole('group', { name: 'On-screen keyboard' });
    const showBtn = () => screen.getByRole('button', { name: 'Show on-screen keyboard' });
    const hideBtn = () => screen.getByRole('button', { name: 'Hide on-screen keyboard' });
    async function toName() {
      renderFlow();
      await peopleLoaded();
      await user.click(screen.getByRole('button', { name: /Enter Your Name/ }));
      await heading('Enter Your Name');
      await waitFor(() => expect(document.activeElement).toBe(searchBox()));
    }

    it('is hidden by default, the box has focus, and the toggle is not pressed', async () => {
      await toName();
      expect(kb()).toBeNull();
      expect(showBtn().getAttribute('aria-pressed')).toBe('false');
    });

    it('the toggle shows and hides the keyboard, keeps focus in the box, and is remembered', async () => {
      await toName();
      await user.click(showBtn());
      expect(kb()).toBeTruthy();
      expect(hideBtn().getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(searchBox());
      expect(localStorage.getItem(KEY)).toBe('shown');
      await user.click(hideBtn());
      expect(kb()).toBeNull();
      expect(document.activeElement).toBe(searchBox());
      expect(localStorage.getItem(KEY)).toBe('hidden');
    });

    it('restores a stored "shown" choice on a fresh mount', async () => {
      localStorage.setItem(KEY, 'shown');
      await toName();
      expect(kb()).toBeTruthy();
      expect(hideBtn()).toBeTruthy();
    });

    it('typing plus Enter with one match picks that person, keyboard hidden or shown', async () => {
      await toName();
      await user.type(searchBox(), 'tina{Enter}');
      await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-tina'));
      expect(await heading('Is this you?')).toBeTruthy();
      cleanup();
      backend.status.mockClear();
      localStorage.setItem(KEY, 'shown');
      await toName();
      await user.type(searchBox(), 'nguyen{Enter}');
      await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-tina'));
    });

    it('Enter with no match shows the not-found message', async () => {
      await toName();
      await user.type(searchBox(), 'zzzz{Enter}');
      expect(await screen.findByText('No one matches that name.')).toBeTruthy();
    });

    it('a scanned value still selects at once with the keyboard hidden and shown', async () => {
      await toName();
      await user.type(searchBox(), BADGE);
      await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-alex'));
      cleanup();
      backend.status.mockClear();
      localStorage.setItem(KEY, 'shown');
      await toName();
      await user.type(searchBox(), BADGE);
      await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-alex'));
    });

    it('physical typing counts as activity for the idle timer', async () => {
      await toName();
      await act(async () => { vi.advanceTimersByTime(IDLE_MS - 1_000); });
      await user.type(searchBox(), 'a');
      await act(async () => { vi.advanceTimersByTime(IDLE_MS - 1_000); });
      expect(screen.getByRole('heading', { name: 'Enter Your Name' })).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(await heading('Welcome!')).toBeTruthy();
    });

    it('a localStorage that throws still renders, hidden', async () => {
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
      try {
        await toName();
        expect(kb()).toBeNull();
        await user.click(showBtn());
        expect(kb()).toBeTruthy();
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });
  });

  it('a physical keyboard types into the box too, and a scan there selects at once', async () => {
    renderFlow();
    await peopleLoaded();
    await user.click(screen.getByRole('button', { name: /Enter Your Name/ }));
    await heading('Enter Your Name');
    await user.type(searchBox(), 'nguyen');
    expect(await screen.findByRole('button', { name: /Tina Nguyen/ })).toBeTruthy();
    await user.clear(searchBox());
    await user.type(searchBox(), BADGE);
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith('p-alex'));
  });

  it('No, search again returns to the name screen; Back there returns to Welcome', async () => {
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    await user.click(await screen.findByRole('button', { name: 'No, search again' }));
    expect(await heading('Enter Your Name')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('Welcome!')).toBeTruthy();
  });
});

describe('Clock In', () => {
  it('Clock Out is disabled; one Clock In punch (even on a double tap) → badge → My badge works → All Set → Welcome', async () => {
    let resolve!: (s: KioskTimeclockStatus) => void;
    backend.clockIn.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderFlow();
    await toAction();
    const tiles = screen.getByRole('group', { name: 'What would you like to do?' });
    expect((within(tiles).getByRole('button', { name: /Clock Out/ }) as HTMLButtonElement).disabled).toBe(true);
    const clockIn = within(tiles).getByRole('button', { name: /Clock In/ });
    expect(clockIn.textContent).toContain('Start your work day');

    await user.dblClick(clockIn);
    expect(backend.clockIn).toHaveBeenCalledTimes(1);
    expect(backend.clockIn).toHaveBeenCalledWith('p-alex');
    expect((clockIn as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolve(statusOf(ALEX, true)); });

    expect(await heading('Do you need a new badge?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'My badge works' }));
    expect(await heading("You're All Set!")).toBeTruthy();
    expect(textOf('Have a great day, Alex!')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(DONE_MS); });
    expect(await heading('Welcome!')).toBeTruthy();
  });

  it('Print a new badge → Printing → Verify after 3 s → Continue → Done', async () => {
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock In/ }));
    await user.click(await screen.findByRole('button', { name: 'Print a new badge' }));
    expect(await heading('Printing Your Badge')).toBeTruthy();
    expect(screen.getByText('Please wait while we print your badge…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    act(() => { vi.advanceTimersByTime(PRINTING_MS); });
    expect(await heading('Verify Your Badge')).toBeTruthy();
    expect(screen.getByText("Place your badge against the reader to check it's working.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await heading("You're All Set!")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await heading('Welcome!')).toBeTruthy();
  });

  it('the All Set greeting uses the preferred name', async () => {
    renderFlow();
    await peopleLoaded();
    await user.click(screen.getByRole('button', { name: /Enter Your Name/ }));
    await user.type(searchBox(), 'tina');
    await user.click(await screen.findByRole('button', { name: /Tina Nguyen/ }));
    await user.click(await screen.findByRole('button', { name: /Yes, that's me/ }));
    await user.click(await screen.findByRole('button', { name: /Clock In/ }));
    await user.click(await screen.findByRole('button', { name: 'My badge works' }));
    expect(textOf('Have a great day, Tee!')).toBeTruthy();
  });

  it('already_clocked_in returns to the choice with a notice and re-reads the status', async () => {
    backend.clockIn.mockRejectedValue(new ApiError(409, 'already_clocked_in'));
    backend.status.mockResolvedValueOnce(statusOf(ALEX, false)).mockResolvedValueOnce(statusOf(ALEX, true));
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock In/ }));
    expect(await screen.findByText('Your status changed. Please choose again.')).toBeTruthy();
    await waitFor(() => expect(backend.status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(
      (screen.getByRole('button', { name: /Clock Out/ }) as HTMLButtonElement).disabled,
    ).toBe(false));
    expect((screen.getByRole('button', { name: /Clock In/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a network failure says the punch was not recorded; Try again re-sends it', async () => {
    backend.clockIn.mockRejectedValueOnce(new ApiError(0, 'network'));
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock In/ }));
    expect(await screen.findByText("Can't reach the portal. Your punch was not recorded. Try again."))
      .toBeTruthy();
    expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await heading('Do you need a new badge?')).toBeTruthy();
    expect(backend.clockIn).toHaveBeenCalledTimes(2);
  });

  it('a punch that answers after the screen idled out is ignored', async () => {
    let resolve!: (s: KioskTimeclockStatus) => void;
    backend.clockIn.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock In/ }));
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(await heading('Welcome!')).toBeTruthy();
    await act(async () => { resolve(statusOf(ALEX, true)); });
    expect(screen.getByRole('heading', { name: 'Welcome!' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Do you need a new badge?' })).toBeNull();
  });
});

describe('Clock Out', () => {
  it('shows the day so far, then Confirm Clock Out punches and lands on All Set', async () => {
    vi.setSystemTime(new Date(BACK_AT).getTime() + 60_000);
    backend.status.mockResolvedValue(ON_444());
    renderFlow();
    await toAction();
    expect((screen.getByRole('button', { name: /Clock In/ }) as HTMLButtonElement).disabled).toBe(true);
    const out = screen.getByRole('button', { name: /Clock Out/ });
    expect(out.textContent).toContain('End your work day');
    await user.click(out);

    expect(await heading('Clock Out')).toBeTruthy();
    expect(screen.getByText("You've been working for")).toBeTruthy();
    expect(screen.getAllByText('7h 24m').length).toBe(2);   // the big total and the table's Total
    expect(screen.getByText('today')).toBeTruthy();
    const rows = within(screen.getByRole('table')).getAllByRole('row').map((r) => r.textContent);
    // a punch on an earlier local day than now would carry a day prefix
    const now = new Date();
    expect(rows).toEqual([
      `Clock In${formatPunch(IN_AT, now)}`,
      `Clock Out${formatPunch(OUT_AT, now)}`,
      `Clock In${formatPunch(BACK_AT, now)}`,
      'Clock Outnow',
      'Total7h 24m',
    ]);

    await user.click(screen.getByRole('button', { name: /Confirm Clock Out/ }));
    expect(backend.clockOut).toHaveBeenCalledTimes(1);
    expect(backend.clockOut).toHaveBeenCalledWith('p-alex');
    expect(await heading("You're All Set!")).toBeTruthy();
  });

  it('an overnight span marks its Clock In as yesterday', async () => {
    vi.setSystemTime(new Date(2026, 9, 20, 6, 30));
    const lateIn = new Date(2026, 9, 19, 22, 0).toISOString();
    backend.status.mockResolvedValue(statusOf(ALEX, true, {
      today_minutes: 510,
      today_entries: [{ clock_in_at: lateIn, clock_out_at: null, minutes: 510 }],
    }));
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock Out/ }));
    expect(await heading('Clock Out')).toBeTruthy();
    const rows = within(screen.getByRole('table')).getAllByRole('row').map((r) => r.textContent);
    expect(rows[0]).toBe(`Clock Inyesterday ${formatClock(lateIn)}`);
    expect(rows[1]).toBe('Clock Outnow');
  });

  it('Back from Clock Out returns to the choice', async () => {
    backend.status.mockResolvedValue(ON_444());
    renderFlow();
    await toAction();
    await user.click(screen.getByRole('button', { name: /Clock Out/ }));
    await heading('Clock Out');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await heading('What would you like to do?')).toBeTruthy();
  });
});

describe('idle and exits', () => {
  it('20 s idle on Is this you? returns to Welcome in station mode', async () => {
    renderFlow();
    await scan(`${BADGE}{Enter}`);
    await heading('Is this you?');
    // (the fake clock also advances with real time, so stop a little short)
    act(() => { vi.advanceTimersByTime(IDLE_MS - 500); });
    expect(screen.getByRole('heading', { name: 'Is this you?' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(500); });
    expect(await heading('Welcome!')).toBeTruthy();
  });

  it('20 s idle on Is this you? calls onExit in kiosk mode', async () => {
    const onExit = vi.fn();
    renderFlow('kiosk', { onExit });
    await peopleLoaded();
    await user.type(searchBox(), BADGE);
    await heading('Is this you?');
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('kiosk mode starts on Enter Your Name; Back there calls onExit', async () => {
    const onExit = vi.fn();
    renderFlow('kiosk', { onExit });
    expect(await heading('Enter Your Name')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('kiosk mode with no people synced says so, and re-reads the list when a sync finishes', async () => {
    backend.people.mockResolvedValueOnce([]);
    renderFlow('kiosk', { onExit: vi.fn() });
    expect(await screen.findByText('No people on this kiosk. Sync from Kiosk Setup.')).toBeTruthy();

    act(() => { syncStore.set({ phase: 'running' }); });
    act(() => { syncStore.set({ phase: 'done' }); });
    await waitFor(() => expect(
      screen.queryByText('No people on this kiosk. Sync from Kiosk Setup.'),
    ).toBeNull());
    await user.type(searchBox(), 'alex');
    expect(await screen.findByRole('button', { name: /Alex Johnson/ })).toBeTruthy();
  });

  it('station mode never shows the kiosk sync hint', async () => {
    backend.people.mockResolvedValue([]);
    renderFlow();
    await peopleLoaded();
    expect(screen.queryByText('No people on this kiosk. Sync from Kiosk Setup.')).toBeNull();
  });

  it('Done in kiosk mode calls onExit', async () => {
    const onExit = vi.fn();
    renderFlow('kiosk', { onExit });
    await peopleLoaded();
    await user.type(searchBox(), BADGE);
    await user.click(await screen.findByRole('button', { name: /Yes, that's me/ }));
    await user.click(await screen.findByRole('button', { name: /Clock In/ }));
    await user.click(await screen.findByRole('button', { name: 'My badge works' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
