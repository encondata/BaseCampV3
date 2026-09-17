// @vitest-environment jsdom
/**
 * ClearOfflineKiosksModal — the last thing an operator sees before an
 * irreversible bulk delete, so the test is about what the list actually
 * names: every kiosk, its registration state as a chip, and a last-seen
 * time that says "Never" rather than a blank. Presentational only, so
 * there is no API to mock — the page owns the call.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ClearOfflineKioskItem } from '../../lib/api';
import ClearOfflineKiosksModal from './ClearOfflineKiosksModal';

afterEach(cleanup);

const ROWS: ClearOfflineKioskItem[] = [
  {
    id: 'a', name: 'kiosk-dock-01', sub_type: 'laptop',
    registration: 'expired', last_seen_at: '2026-09-14T10:00:00Z',
  },
  {
    id: 'b', name: 'kiosk-pi-07', sub_type: 'pi',
    registration: 'unregistered', last_seen_at: null,
  },
];

it('names every kiosk that will be deleted', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText('kiosk-dock-01')).toBeTruthy();
  expect(screen.getByText('kiosk-pi-07')).toBeTruthy();
  expect(screen.getByText('Unregistered')).toBeTruthy();
  expect(screen.getByText('Expired')).toBeTruthy();
  expect(screen.getByText('Laptop')).toBeTruthy();
  expect(screen.getByText('Pi')).toBeTruthy();
});

it('states the rule in the header: silence, not expiry', () => {
  // The rule is staleness alone; header copy that promises to clear expired
  // kiosks would describe a button that no longer exists. (Rows may still
  // carry an Expired chip — that is reporting, not the rule, so the negative
  // assertion is scoped to the header.)
  const { container } = render(
    <ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                             onConfirm={() => {}} onClose={() => {}} />);
  const head = container.querySelector('.rgm-head-text') as HTMLElement;
  expect(within(head).getByRole('heading', { name: 'Clear offline kiosks' })).toBeTruthy();
  expect(within(head).getByText(/not been seen in the last 24 hours/)).toBeTruthy();
  expect(head.textContent).not.toMatch(/expire/i);
});

it('says never for a kiosk that has never been seen', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText('Never')).toBeTruthy();
});

it('colors the registration chips and covers the registered state too', () => {
  // Registration decides nothing — a kiosk holding a valid token is cleared
  // once it goes silent — so `registered` reaches this component on a row
  // about to be deleted, and the chip must not fall through to a bare
  // literal.
  const withRegistered: ClearOfflineKioskItem[] = [...ROWS, {
    id: 'c', name: 'kiosk-back-online', sub_type: 'web',
    registration: 'registered', last_seen_at: '2026-09-16T10:00:00Z',
  }];
  render(<ClearOfflineKiosksModal
    kiosks={withRegistered} totalMatched={withRegistered.length}
    busy={false} onConfirm={() => {}} onClose={() => {}} />);

  expect(screen.getByText('Expired').className).toContain('c-red');
  expect(screen.getByText('Unregistered').className).toContain('c-slate');
  expect(screen.getByText('Registered').className).toContain('c-green');
});

it('degrades to a neutral chip for an unexpected registration value instead of throwing', () => {
  // The union matches the Python `Literal` today, but a lookup miss must
  // never throw inside the modal that fronts an irreversible delete.
  const oddball = [{
    id: 'z', name: 'kiosk-mystery', sub_type: 'pi',
    registration: 'something-new' as unknown as ClearOfflineKioskItem['registration'],
    last_seen_at: null,
  }];
  render(<ClearOfflineKiosksModal kiosks={oddball} totalMatched={oddball.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText('Unknown')).toBeTruthy();
});

it('counts the kiosks in the confirm button', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /Delete 2 kiosks/ })).toBeTruthy();
});

it('says "1 kiosk", not "1 kiosks", for a single match', () => {
  render(<ClearOfflineKiosksModal kiosks={[ROWS[0]]} totalMatched={1} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: 'Delete 1 kiosk' })).toBeTruthy();
});

it('hands the confirm back to the caller', () => {
  const onConfirm = vi.fn();
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={onConfirm} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Delete 2 kiosks/ }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('offers only Close when nothing matches', () => {
  const { container } = render(<ClearOfflineKiosksModal kiosks={[]} totalMatched={0} busy={false}
                                                        onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText(/Nothing to clear/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  const foot = container.querySelector('.modal-foot') as HTMLElement;
  expect(within(foot).getByRole('button', { name: 'Close' })).toBeTruthy();
});

it('disables the confirm while a delete is in flight', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /Deleting/ })).toHaveProperty('disabled', true);
});

it('renders the rows in the house table, not a bare list', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  const table = screen.getByRole('table');
  expect(within(table).getByText('Last seen')).toBeTruthy();
  expect(within(table).getByText('Registration')).toBeTruthy();
});

it('tells the operator when the batch was capped below the real match count', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length + 499} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.getByText(/Showing the first 2 of 501 matches/)).toBeTruthy();
});

it('shows no truncation note when the batch was not capped', () => {
  render(<ClearOfflineKiosksModal kiosks={ROWS} totalMatched={ROWS.length} busy={false}
                                  onConfirm={() => {}} onClose={() => {}} />);
  expect(screen.queryByText(/Showing the first/)).toBeNull();
});
