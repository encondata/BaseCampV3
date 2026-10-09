// @vitest-environment jsdom
/**
 * CleanupTab — Developer › Database › Cleanup. Covers the three group cards
 * (toggles, age fields), preview counts, Delete gating + confirm + results,
 * age validation, API errors, and the duplicate finder. The three API calls
 * are mocked per the contract in docs/superpowers/specs/2026-10-09-data-
 * cleanup-design.md — a portal-only unit test, not a live check.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type CleanupDuplicatesOut, type CleanupGroupPreview, type CleanupPreviewOut,
} from '../../lib/api';
import CleanupTab from './CleanupTab';

const auth = vi.hoisted(() => ({ canChange: true }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => auth.canChange }),
}));

const api = vi.hoisted(() => ({
  getCleanupPreview: vi.fn(),
  runCleanup: vi.fn(),
  getCleanupDuplicates: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

function cat(key: string, label: string, rows: number, files = 0) {
  return { key, label, description: `${label} description`, rows, files };
}

function previewOut(overrides: Record<string, number[]> = {}): CleanupPreviewOut {
  const n = (k: string, i: number, d: number) => overrides[k]?.[i] ?? d;
  const groups: CleanupGroupPreview[] = [
    {
      key: 'signin', label: 'Sign-in leftovers', description: 'x', needs_age: false,
      categories: [
        cat('sessions', 'Expired sessions', n('sessions', 0, 3)),
        cat('reset_links', 'Used or expired password-reset links', n('reset_links', 0, 0)),
        cat('trusted_browsers', 'Expired or revoked trusted browsers', n('trusted_browsers', 0, 0)),
      ],
    },
    {
      key: 'history', label: 'Old history', description: 'x', needs_age: true,
      categories: [
        cat('mail', 'Sent, failed and skipped mail', n('mail', 0, 1204), n('mail', 1, 38)),
        cat('notifications', 'Read or hidden notifications', n('notifications', 0, 7)),
        cat('imports', 'Finished import jobs', 0),
        cat('reports', 'Report runs', 0),
        cat('label_runs', 'Label generation runs', 0),
        cat('spec_lookups', 'Finished spec lookups', 0),
        cat('rule_logs', 'Status rule run logs', 0),
      ],
    },
    {
      key: 'deleted', label: 'Deleted files', description: 'x', needs_age: true,
      categories: [
        cat('attachments', 'Deleted files', 0),
        cat('notes', 'Deleted notes', 0),
        cat('label_fonts', 'Deleted label fonts', 0),
      ],
    },
  ];
  return { groups };
}

function runOut(group: string, categories: string[]) {
  return {
    group, older_than_days: null,
    categories: categories.map((key) => ({
      key, rows_deleted: 3, files_deleted: 2, files_kept: 1, files_failed: 0,
    })),
  };
}

const confirmSpy = vi.fn();

beforeEach(() => {
  auth.canChange = true;
  api.getCleanupPreview.mockReset().mockResolvedValue(previewOut());
  api.runCleanup.mockReset();
  api.getCleanupDuplicates.mockReset();
  confirmSpy.mockReset().mockReturnValue(true);
  vi.stubGlobal('confirm', confirmSpy);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderTab(onShowBackups = vi.fn()) {
  const user = userEvent.setup();
  render(<MemoryRouter><CleanupTab onShowBackups={onShowBackups} /></MemoryRouter>);
  return { user, onShowBackups };
}

const card = (name: string) => screen.getByRole('region', { name });

it('shows the intro with a link to the Backups tab', async () => {
  const { user, onShowBackups } = renderTab();
  expect(screen.getByText(/Take a backup first/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Go to Backups' }));
  expect(onShowBackups).toHaveBeenCalledTimes(1);
});

it('renders the three group cards with every category toggled on', () => {
  renderTab();
  const expected: Record<string, string[]> = {
    'Sign-in leftovers': ['Expired sessions', 'Used or expired password-reset links',
      'Expired or revoked trusted browsers'],
    'Old history': ['Sent, failed and skipped mail', 'Read or hidden notifications',
      'Finished import jobs', 'Report runs', 'Label generation runs',
      'Finished spec lookups', 'Status rule run logs'],
    'Deleted files': ['Deleted files', 'Deleted notes', 'Deleted label fonts'],
  };
  for (const [group, labels] of Object.entries(expected)) {
    const c = within(card(group));
    for (const label of labels) {
      expect((c.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(true);
    }
  }
});

it('gives History and Deleted an "Older than" field of 90 and Sign-in none', () => {
  renderTab();
  expect(within(card('Sign-in leftovers')).queryByLabelText(/Older than/)).toBeNull();
  for (const g of ['Old history', 'Deleted files']) {
    const field = within(card(g)).getByLabelText(/Older than/) as HTMLInputElement;
    expect(field.value).toBe('90');
  }
});

it('shows a dash before any preview', () => {
  renderTab();
  expect(within(card('Old history')).getAllByText('—').length).toBe(7);
});

it('previews with the edited age and shows rows and files', async () => {
  const { user } = renderTab();
  const history = within(card('Old history'));
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());
  expect(api.getCleanupPreview).toHaveBeenLastCalledWith(90);
  // a category with no files shows rows only
  expect(history.getByText('7 rows')).toBeTruthy();

  const age = history.getByLabelText(/Older than/);
  await user.clear(age);
  await user.type(age, '30');
  // changing the age invalidates the counts
  expect(history.queryByText('1,204 rows · 38 files')).toBeNull();
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(api.getCleanupPreview).toHaveBeenLastCalledWith(30));
});

it('only fills in the card that was previewed', async () => {
  const { user } = renderTab();
  await user.click(within(card('Sign-in leftovers')).getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(within(card('Sign-in leftovers')).getByText('3 rows')).toBeTruthy());
  expect(within(card('Old history')).queryByText('1,204 rows · 38 files')).toBeNull();
});

it('keeps Delete disabled until a preview with something to delete', async () => {
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  const del = signin.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement;
  expect(del.disabled).toBe(true);
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(del.disabled).toBe(false));
  // turning off the only non-zero category disables it again
  await user.click(signin.getByRole('checkbox', { name: 'Expired sessions' }));
  expect(del.disabled).toBe(true);
});

it('keeps Delete disabled when the preview finds nothing', async () => {
  api.getCleanupPreview.mockResolvedValue(previewOut({ sessions: [0] }));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getAllByText('0 rows').length).toBe(3));
  expect((signin.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it('confirms with totals, sends the toggled categories, shows results and re-previews', async () => {
  api.runCleanup.mockResolvedValue({
    group: 'history', older_than_days: 90,
    categories: [{ key: 'mail', rows_deleted: 1204, files_deleted: 36, files_kept: 2, files_failed: 0 }],
  });
  const { user } = renderTab();
  const history = within(card('Old history'));
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());
  // turn off notifications -> only mail (+ zero-count ones) remain
  await user.click(history.getByRole('checkbox', { name: 'Read or hidden notifications' }));

  api.getCleanupPreview.mockClear().mockResolvedValue(previewOut({ mail: [0, 0] }));
  await user.click(history.getByRole('button', { name: 'Delete selected' }));

  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(confirmSpy.mock.calls[0][0]).toContain('1,204 rows');
  expect(confirmSpy.mock.calls[0][0]).toContain('38 files');
  expect(api.runCleanup).toHaveBeenCalledTimes(1);
  const body = api.runCleanup.mock.calls[0][0];
  expect(body.group).toBe('history');
  expect(body.older_than_days).toBe(90);
  expect(body.categories).toContain('mail');
  expect(body.categories).not.toContain('notifications');

  await waitFor(() => expect(history.getByText(/1,204 rows deleted/)).toBeTruthy());
  expect(history.getByText(/36 files deleted/)).toBeTruthy();
  expect(history.getByText(/2 files kept/)).toBeTruthy();
  await waitFor(() => expect(api.getCleanupPreview).toHaveBeenCalledWith(90));
});

it('does not run when the confirm is declined', async () => {
  confirmSpy.mockReturnValue(false);
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  expect(api.runCleanup).not.toHaveBeenCalled();
});

it('omits the age for the Sign-in group', async () => {
  api.runCleanup.mockResolvedValue(runOut('signin', ['sessions']));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(api.runCleanup).toHaveBeenCalled());
  expect(api.runCleanup.mock.calls[0][0].older_than_days).toBeUndefined();
});

it('shows partial results and the message when a run fails', async () => {
  api.runCleanup.mockRejectedValue(new ApiError(500, 'cleanup_failed', {
    code: 'cleanup_failed', message: 'storage went away',
    categories: [{ key: 'sessions', rows_deleted: 2, files_deleted: 0, files_kept: 0, files_failed: 0 }],
  }));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(signin.getByText(/storage went away/)).toBeTruthy());
  expect(signin.getByText(/2 rows deleted/)).toBeTruthy();
});

it('shows category descriptions only once the preview supplies them', async () => {
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  expect(signin.queryByText('Expired sessions description')).toBeNull();
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  expect(await signin.findByText('Expired sessions description')).toBeTruthy();
});

it('drops the preview, results and Delete when the age is edited', async () => {
  api.runCleanup.mockResolvedValue({
    group: 'history', older_than_days: 90,
    categories: [{ key: 'mail', rows_deleted: 5, files_deleted: 0, files_kept: 0, files_failed: 0 }],
  });
  const { user } = renderTab();
  const history = within(card('Old history'));
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());
  await user.click(history.getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(history.getByText(/5 rows deleted/)).toBeTruthy());
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());

  const age = history.getByLabelText(/Older than/);
  await user.clear(age);
  await user.type(age, '45');
  expect(history.queryByText('1,204 rows · 38 files')).toBeNull();
  expect(history.queryByText(/5 rows deleted/)).toBeNull();
  expect((history.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it('changes the confirm totals when a category is toggled after the preview', async () => {
  const { user } = renderTab();
  const history = within(card('Old history'));
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());
  await user.click(history.getByRole('checkbox', { name: 'Sent, failed and skipped mail' }));
  api.runCleanup.mockResolvedValue({ group: 'history', older_than_days: 90, categories: [] });
  await user.click(history.getByRole('button', { name: 'Delete selected' }));
  const text = confirmSpy.mock.calls[0][0] as string;
  expect(text).toContain('7 rows');
  expect(text).not.toContain('1,204');
  expect(text).not.toContain('files');
});

it.each([
  ['invalid_age', 'Enter a whole number of days from 1 to 3650.'],
  ['unknown_category', 'The server does not recognize one of these categories — reload the page.'],
  ['whatever', 'The cleanup failed — try again.'],
])('maps a %s run error to its message', async (code, message) => {
  api.runCleanup.mockRejectedValue(new ApiError(422, code, { code }));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  expect((await signin.findByText(message)).className).toContain('pf-error');
});

it('keeps the part-way message when the refresh after a failed run also fails', async () => {
  api.runCleanup.mockRejectedValue(new ApiError(500, 'cleanup_failed', {
    code: 'cleanup_failed', message: 'storage went away',
    categories: [{ key: 'sessions', rows_deleted: 2, files_deleted: 0, files_kept: 0, files_failed: 0 }],
  }));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  api.getCleanupPreview.mockClear().mockRejectedValue(new ApiError(500, 'boom'));
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  await waitFor(() => expect(api.getCleanupPreview).toHaveBeenCalled());
  await waitFor(() => expect(
    (signin.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false));
  expect(signin.getByText(/storage went away/).className).toContain('pf-error');
  // partial counts from a failed run are not styled as a success
  const partial = signin.getByText(/2 rows deleted/);
  expect(partial.className).not.toContain('set-ok');
});

it('styles a clean run result as a success', async () => {
  api.runCleanup.mockResolvedValue(runOut('signin', ['sessions']));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(signin.getByText('3 rows')).toBeTruthy());
  await user.click(signin.getByRole('button', { name: 'Delete selected' }));
  expect((await signin.findByText(/3 rows deleted/)).className).toContain('set-ok');
});

it('blocks Preview and Delete for an age outside 1 to 3650', async () => {
  const { user } = renderTab();
  const history = within(card('Old history'));
  await user.click(history.getByRole('button', { name: 'Preview' }));
  await waitFor(() => expect(history.getByText('1,204 rows · 38 files')).toBeTruthy());
  const age = history.getByLabelText(/Older than/);
  for (const bad of ['0', '3651', '']) {
    await user.clear(age);
    if (bad) await user.type(age, bad);
    expect(history.getByText('Enter a whole number of days from 1 to 3650.')
      .className).toContain('pf-error');
    expect((history.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((history.getByRole('button', { name: 'Delete selected' }) as HTMLButtonElement).disabled)
      .toBe(true);
  }
  await user.clear(age);
  await user.type(age, '3650');
  expect(history.queryByText('Enter a whole number of days from 1 to 3650.')).toBeNull();
});

it('shows API errors in the card', async () => {
  api.getCleanupPreview.mockRejectedValue(new ApiError(500, 'boom'));
  const { user } = renderTab();
  const signin = within(card('Sign-in leftovers'));
  await user.click(signin.getByRole('button', { name: 'Preview' }));
  const err = await signin.findByText('Could not load the preview — try again.');
  expect(err.className).toContain('pf-error');
  expect(within(card('Old history')).queryByText('Could not load the preview — try again.'))
    .toBeNull();
});

it('hides Delete without devtools:change', () => {
  auth.canChange = false;
  renderTab();
  expect(screen.queryByRole('button', { name: 'Delete selected' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Preview' }).length).toBe(3);
});

// ── duplicate finder ───────────────────────────────────────────────

const dupes: CleanupDuplicatesOut = {
  assets: [{
    serial: 'SN-1',
    items: [
      { id: 'a1', name: 'Switch A', serial_number: 'SN-1', site_name: 'Dallas',
        status_label: 'In service', href: '/assets/a1' },
      { id: 'a2', name: 'Switch B', serial_number: 'sn-1 ', site_name: null,
        status_label: 'Staged', href: null },
    ],
  }],
  people: [{
    name: 'jimmy henderson',
    items: [
      { id: 'p1', display_name: 'Jimmy Henderson', email: 'j@x.com', has_login: true,
        is_worker: false, href: '/people/users/p1' },
      { id: 'p2', display_name: 'Jimmy  Henderson', email: null, has_login: false,
        is_worker: true, href: null },
    ],
  }],
};

it('lists duplicates with record links and plain text where there is no link', async () => {
  api.getCleanupDuplicates.mockResolvedValue(dupes);
  const { user } = renderTab();
  const c = within(card('Duplicate finder'));
  await user.click(c.getByRole('button', { name: 'Find duplicates' }));
  const link = await c.findByRole('link', { name: 'Switch A' });
  expect(link.getAttribute('href')).toBe('/assets/a1');
  expect(c.queryByRole('link', { name: 'Switch B' })).toBeNull();
  expect(c.getByText('Switch B')).toBeTruthy();
  expect(c.getByRole('link', { name: 'Jimmy Henderson' }).getAttribute('href'))
    .toBe('/people/users/p1');
  expect(c.queryByRole('link', { name: 'Jimmy  Henderson' })).toBeNull();
  expect(c.getByText('SN-1')).toBeTruthy();
  expect(c.queryByText('No duplicates found.')).toBeNull();
});

it('says so when there are no duplicates', async () => {
  api.getCleanupDuplicates.mockResolvedValue({ assets: [], people: [] });
  const { user } = renderTab();
  const c = within(card('Duplicate finder'));
  expect(c.queryByText('No duplicates found.')).toBeNull();
  await user.click(c.getByRole('button', { name: 'Find duplicates' }));
  expect(await c.findByText('No duplicates found.')).toBeTruthy();
});

it('shows a duplicate-finder error in its card', async () => {
  api.getCleanupDuplicates.mockRejectedValue(new ApiError(500, 'boom'));
  const { user } = renderTab();
  const c = within(card('Duplicate finder'));
  await user.click(c.getByRole('button', { name: 'Find duplicates' }));
  const err = await c.findByText('Could not look for duplicates — try again.');
  expect(err.className).toContain('pf-error');
});
