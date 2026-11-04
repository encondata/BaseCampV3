// @vitest-environment jsdom
/**
 * NotificationDefaultsTab — System › Notifications › Defaults. Two cards, each
 * with its own Save: what people get by default (the Inbox / Email grid) and
 * which notifications are critical. A Save sends only its own card's part of
 * the settings (for the defaults, only the categories that changed), stays
 * disabled until the card differs from what the server last answered, and a
 * failed save says why in a sentence.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type NotificationKindSetting, type NotificationSettings, type SwitchPair,
} from '../../lib/api';

const auth = vi.hoisted(() => ({ canChange: true }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action: string) =>
      (resource === 'notifications' && action === 'change' ? auth.canChange : true),
  }),
}));

const api = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: NotificationDefaultsTab } = await import('./NotificationDefaultsTab');

const ON: SwitchPair = { inbox: true, email: true };

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
  watchable: false, everywhere: false, reaches: [], ...over,
});

/** What GET /notifications/settings answers: Reports email is off by default,
 *  Report failed is marked critical, the two security kinds are critical and
 *  locked, and two kinds are never emailed. */
const SETTINGS: NotificationSettings = {
  defaults: {
    approvals: ON, reports: { inbox: true, email: false }, wiki: ON, learning: ON,
    initiatives: ON, trucks: ON, devices: ON, status_rules: ON, bulk_actions: ON,
  },
  critical_kinds: ['report_failed'],
  kinds: [
    kind('membership_request', 'Group membership request', 'approvals'),
    kind('password_reset_request', 'Password reset request', 'approvals', { email: false }),
    kind('report_ready', 'Report ready', 'reports'),
    kind('report_failed', 'Report failed', 'reports', { critical: true }),
    kind('wiki_update', 'Page updated', 'wiki'),
    kind('learning_complete', 'Learning complete', 'learning'),
    kind('learning_quiz_locked', 'Quiz locked', 'learning', { email: false }),
    kind('password_expiring', 'Password expiring', 'security',
      { owner_always: true, critical: true, locked: true }),
    kind('totp_enrolled', 'Two-factor authentication enrolled', 'security',
      { owner_always: true, critical: true, locked: true }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.canChange = true;
  api.getNotificationSettings.mockResolvedValue(structuredClone(SETTINGS));
  api.updateNotificationSettings.mockReset();
});

afterEach(cleanup);

const DEFAULTS_NAME = 'What people get by default';
const CRITICAL_NAME = 'Critical notifications';

const defaultsCard = () => screen.getByRole('region', { name: DEFAULTS_NAME });
const criticalCard = () => screen.getByRole('region', { name: CRITICAL_NAME });

const saveIn = (card: HTMLElement) => within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement;

const gridSwitch = (channel: 'Inbox' | 'Email', category: string) =>
  within(defaultsCard()).getByRole('checkbox', { name: `${channel} for ${category}` }) as HTMLInputElement;

const critSwitch = (label: string) =>
  within(criticalCard()).getByRole('checkbox', { name: `Critical: ${label}` }) as HTMLInputElement;

/** Mount the tab and wait for both cards. */
async function mount() {
  const view = render(<NotificationDefaultsTab />);
  await screen.findByRole('region', { name: DEFAULTS_NAME });
  return view;
}

/** The notifications of the critical list, top to bottom. */
const criticalRows = () => within(criticalCard()).getAllByRole('row').slice(1)
  .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// ── loading ────────────────────────────────────────────────────────────

it('loads the settings once and renders both cards in one settings stack', async () => {
  const { container } = await mount();
  expect(api.getNotificationSettings).toHaveBeenCalledTimes(1);

  const stack = container.querySelector('.set-stack') as HTMLElement;
  expect(stack).not.toBeNull();
  const cards = [...stack.children];
  expect(cards).toHaveLength(2);
  cards.forEach((card) => {
    expect(card.tagName).toBe('SECTION');
    expect(card.classList.contains('set-section')).toBe(true);
    expect(card.querySelector('.set-head h3')).not.toBeNull();
  });
  expect(within(defaultsCard()).getByRole('heading', { name: DEFAULTS_NAME })).toBeTruthy();
  expect(within(criticalCard()).getByRole('heading', { name: CRITICAL_NAME })).toBeTruthy();
});

it('says Loading… until the settings arrive, then shows the cards', async () => {
  const pending = deferred<NotificationSettings>();
  api.getNotificationSettings.mockReturnValue(pending.promise);
  render(<NotificationDefaultsTab />);
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByRole('region', { name: DEFAULTS_NAME })).toBeNull();

  pending.resolve(structuredClone(SETTINGS));
  expect(await screen.findByRole('region', { name: DEFAULTS_NAME })).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
});

it('a settings call that fails says so and shows no cards or Save', async () => {
  api.getNotificationSettings.mockRejectedValue(new ApiError(500, 'unknown_error'));
  render(<NotificationDefaultsTab />);
  expect((await screen.findByRole('alert')).textContent).toBe('Could not load notification settings.');
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.queryByText('Loading…')).toBeNull();
});

// ── the defaults card ──────────────────────────────────────────────────

it('the defaults grid shows the loaded defaults, with Account security as Always', async () => {
  await mount();
  expect(gridSwitch('Inbox', 'Reports & labels').checked).toBe(true);
  expect(gridSwitch('Email', 'Reports & labels').checked).toBe(false);
  expect(gridSwitch('Email', 'Approvals & requests').checked).toBe(true);
  expect(gridSwitch('Email', 'Wiki').checked).toBe(true);
  // the same grid as /me: no per-person state lines in defaults mode
  expect(within(defaultsCard()).queryByText('Company default')).toBeNull();
  expect(within(defaultsCard()).queryByText('Your choice')).toBeNull();
  // Account security has no switches
  const security = within(defaultsCard()).getByRole('row', { name: /Account security/ });
  expect(within(security).getAllByText('Always')).toHaveLength(2);
  expect(within(security).queryByRole('checkbox')).toBeNull();
});

it('admins set the defaults whether or not the server can send email', async () => {
  await mount();
  for (const category of ['Approvals & requests', 'Wiki', 'Learning']) {
    expect(gridSwitch('Email', category).disabled).toBe(false);
  }
  expect(within(defaultsCard()).queryByTitle("Email isn't set up on this server")).toBeNull();
});

it('Email needs Inbox here too, and the Email value behind it is kept', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockResolvedValue(structuredClone(SETTINGS));
  await mount();

  await user.click(gridSwitch('Inbox', 'Wiki'));
  expect(gridSwitch('Inbox', 'Wiki').checked).toBe(false);
  expect(gridSwitch('Email', 'Wiki').checked).toBe(false);
  expect(gridSwitch('Email', 'Wiki').disabled).toBe(true);
  expect(within(defaultsCard()).getAllByTitle('Turn on Inbox to get email')).toHaveLength(1);

  await user.click(saveIn(defaultsCard()));
  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1));
  expect(api.updateNotificationSettings.mock.calls[0][0].defaults.wiki).toEqual({ inbox: false, email: true });
});

it('each card\'s Save is disabled until something in that card changes', async () => {
  const user = userEvent.setup();
  await mount();
  expect(saveIn(defaultsCard()).disabled).toBe(true);
  expect(saveIn(criticalCard()).disabled).toBe(true);

  await user.click(gridSwitch('Email', 'Wiki'));
  expect(saveIn(defaultsCard()).disabled).toBe(false);
  expect(saveIn(criticalCard()).disabled).toBe(true);

  await user.click(critSwitch('Report ready'));
  expect(saveIn(criticalCard()).disabled).toBe(false);
});

it('flipping a switch back leaves Save disabled again, in both cards', async () => {
  const user = userEvent.setup();
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(gridSwitch('Email', 'Wiki'));
  expect(saveIn(defaultsCard()).disabled).toBe(true);

  await user.click(critSwitch('Report failed'));
  expect(saveIn(criticalCard()).disabled).toBe(false);
  await user.click(critSwitch('Report failed'));
  expect(saveIn(criticalCard()).disabled).toBe(true);
});

it('saving the defaults sends only `defaults`, with only the categories that changed', async () => {
  const user = userEvent.setup();
  const answer = {
    ...structuredClone(SETTINGS),
    defaults: { ...SETTINGS.defaults, wiki: { inbox: true, email: false } },
  };
  api.updateNotificationSettings.mockResolvedValue(answer);
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1));
  const body = api.updateNotificationSettings.mock.calls[0][0];
  expect(Object.keys(body)).toEqual(['defaults']);
  expect(body.defaults).toEqual({ wiki: { inbox: true, email: false } });
});

it('a category left alone is not sent, so a tab loaded before another admin\'s save keeps their change', async () => {
  const user = userEvent.setup();
  // Meanwhile another admin turned Learning Email off. The server merges per category.
  const server = { ...SETTINGS.defaults, learning: { inbox: true, email: false } };
  api.updateNotificationSettings.mockImplementation(async (body: { defaults?: Record<string, SwitchPair> }) => ({
    ...structuredClone(SETTINGS), defaults: { ...server, ...body.defaults },
  }));
  await mount();
  expect(gridSwitch('Email', 'Learning').checked).toBe(true);   // this tab still shows the old value

  // Learning flipped and flipped back is left alone too
  await user.click(gridSwitch('Email', 'Learning'));
  await user.click(gridSwitch('Email', 'Learning'));
  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1));
  const sent = api.updateNotificationSettings.mock.calls[0][0].defaults;
  expect(Object.keys(sent)).toEqual(['wiki']);
  expect(sent).not.toHaveProperty('learning');
  // the answer carries the other admin's change, and the grid shows it
  await waitFor(() => expect(gridSwitch('Email', 'Learning').checked).toBe(false));
  expect(gridSwitch('Email', 'Wiki').checked).toBe(false);
  expect(saveIn(defaultsCard()).disabled).toBe(true);
});

it('after the defaults save the grid shows what the server answered, and Save is disabled', async () => {
  const user = userEvent.setup();
  // the server also reports a change somebody else made to Learning meanwhile
  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS),
    defaults: {
      ...SETTINGS.defaults,
      wiki: { inbox: true, email: false },
      learning: { inbox: true, email: false },
    },
  });
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(gridSwitch('Email', 'Learning').checked).toBe(false));
  expect(gridSwitch('Email', 'Wiki').checked).toBe(false);
  expect(saveIn(defaultsCard()).disabled).toBe(true);
});

// ── the critical card ──────────────────────────────────────────────────

it('the critical list: every kind that can be emailed, in registry order, with its category and a switch', async () => {
  await mount();
  const table = within(criticalCard()).getByRole('table');
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Notification', 'Category', 'Critical']);
  expect(criticalRows().map(([label, category]) => [label, category])).toEqual([
    ['Group membership request', 'Approvals & requests'],
    ['Report ready', 'Reports & labels'],
    ['Report failed', 'Reports & labels'],
    ['Page updated', 'Wiki'],
    ['Learning complete', 'Learning'],
    ['Password expiring', 'Account security'],
    ['Two-factor authentication enrolled', 'Account security'],
  ]);
  // the category is a chip
  expect(within(criticalCard()).getByText('Wiki').classList.contains('chip')).toBe(true);
  // The list sits in .nd-crit: the scope of its themed scrollbar and of the narrow-width rule
  // that steps the second column (Category) aside so the switches stay in view.
  expect(criticalCard().querySelector('.nd-crit > .data-table-scroll > table')).not.toBeNull();
  expect(criticalCard().querySelectorAll('.nd-crit colgroup > col')).toHaveLength(3);
});

it('Critical switches follow the marked kinds: Report failed is on, the rest are off', async () => {
  await mount();
  expect(critSwitch('Report failed').checked).toBe(true);
  for (const label of ['Group membership request', 'Report ready', 'Page updated', 'Learning complete']) {
    expect(critSwitch(label).checked).toBe(false);
  }
});

it('the two security kinds say Always instead of a switch', async () => {
  await mount();
  const card = within(criticalCard());
  expect(card.getAllByText('Always')).toHaveLength(2);
  for (const label of ['Password expiring', 'Two-factor authentication enrolled']) {
    const row = card.getByRole('row', { name: new RegExp(label) });
    expect(within(row).getByText('Always').classList.contains('chip')).toBe(true);
    expect(within(row).queryByRole('checkbox')).toBeNull();
  }
});

it('kinds that are never emailed are absent, and the foot note says so', async () => {
  await mount();
  const card = within(criticalCard());
  expect(card.queryByText('Password reset request')).toBeNull();
  expect(card.queryByText('Quiz locked')).toBeNull();
  expect(card.getByText("Password reset requests and Quiz locked are never emailed, and project plan notices send their own email under each plan's settings, so they aren't listed."))
    .toBeTruthy();
});

it('saving the critical list sends only `critical_kinds`, in registry order', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), critical_kinds: ['report_ready', 'report_failed', 'wiki_update'],
  });
  await mount();

  // clicked out of registry order on purpose
  await user.click(critSwitch('Page updated'));
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1));
  const body = api.updateNotificationSettings.mock.calls[0][0];
  expect(Object.keys(body)).toEqual(['critical_kinds']);
  expect(body.critical_kinds).toEqual(['report_ready', 'report_failed', 'wiki_update']);
});

it('swapping one critical kind for another is still a change', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockResolvedValue({ ...structuredClone(SETTINGS), critical_kinds: ['report_ready'] });
  await mount();

  await user.click(critSwitch('Report ready'));
  await user.click(critSwitch('Report failed'));
  expect(saveIn(criticalCard()).disabled).toBe(false);
  await user.click(saveIn(criticalCard()));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledWith({ critical_kinds: ['report_ready'] }));
  await waitFor(() => expect(saveIn(criticalCard()).disabled).toBe(true));
});

it('turning the last critical kind off sends an empty list', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockResolvedValue({ ...structuredClone(SETTINGS), critical_kinds: [] });
  await mount();

  await user.click(critSwitch('Report failed'));
  await user.click(saveIn(criticalCard()));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledWith({ critical_kinds: [] }));
});

it('the security kinds are never sent: they are critical in code', async () => {
  const user = userEvent.setup();
  // Not something the server does (it lists only what an admin marked), but a save that
  // included an always-critical kind would be refused for good: the list must not carry it back.
  api.getNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), critical_kinds: ['report_failed', 'password_expiring'],
  });
  api.updateNotificationSettings.mockResolvedValue(structuredClone(SETTINGS));
  await mount();
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));
  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1));
  expect(api.updateNotificationSettings.mock.calls[0][0].critical_kinds).toEqual(['report_ready', 'report_failed']);
});

it('after the critical save the list shows what the server answered, and Save is disabled', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), critical_kinds: ['report_ready', 'report_failed', 'learning_complete'],
  });
  await mount();

  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));

  await waitFor(() => expect(critSwitch('Learning complete').checked).toBe(true));
  expect(critSwitch('Report ready').checked).toBe(true);
  expect(saveIn(criticalCard()).disabled).toBe(true);
});

// ── the cards save on their own ────────────────────────────────────────

it('saving one card keeps the other card\'s unsaved changes, and each Save sends only its own part', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockImplementation(async (body: { defaults?: Record<string, SwitchPair> }) => ({
    ...structuredClone(SETTINGS), defaults: { ...SETTINGS.defaults, ...body.defaults },
  }));
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(saveIn(defaultsCard()).disabled).toBe(true));
  // the critical edit is still there, and still unsaved
  expect(critSwitch('Report ready').checked).toBe(true);
  expect(saveIn(criticalCard()).disabled).toBe(false);
  expect(Object.keys(api.updateNotificationSettings.mock.calls[0][0])).toEqual(['defaults']);

  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), critical_kinds: ['report_ready', 'report_failed'],
  });
  await user.click(saveIn(criticalCard()));
  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledTimes(2));
  expect(api.updateNotificationSettings.mock.calls[1][0]).toEqual({ critical_kinds: ['report_ready', 'report_failed'] });
});

it('a card nobody touched stays clean when the other card is saved', async () => {
  const user = userEvent.setup();
  // the answer carries a critical list somebody else changed meanwhile
  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS),
    defaults: { ...SETTINGS.defaults, wiki: { inbox: true, email: false } },
    critical_kinds: ['report_ready', 'report_failed'],
  });
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(saveIn(defaultsCard()).disabled).toBe(true));
  expect(saveIn(criticalCard()).disabled).toBe(true);
});

// ── errors ─────────────────────────────────────────────────────────────

it('a read-only maintenance error shows the server\'s message, in the card it came from', async () => {
  const user = userEvent.setup();
  const message = 'The portal is in read-only maintenance mode — changes are disabled until it\'s lifted.';
  api.updateNotificationSettings.mockRejectedValue(new ApiError(423, 'read_only_mode', undefined, message));
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));

  const alert = await within(defaultsCard()).findByRole('alert');
  expect(alert.textContent).toBe(message);
  expect(alert.classList.contains('pf-error')).toBe(true);
  expect(within(criticalCard()).queryByRole('alert')).toBeNull();

  // and the same from the critical card
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));
  expect((await within(criticalCard()).findByRole('alert')).textContent).toBe(message);
  expect(within(defaultsCard()).queryByRole('alert')).toBeNull();
});

it('invalid_category and invalid_kind say that change isn\'t allowed', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockRejectedValue(new ApiError(422, 'invalid_category'));
  await mount();
  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));
  expect((await within(defaultsCard()).findByRole('alert')).textContent).toBe("That change isn't allowed.");

  api.updateNotificationSettings.mockRejectedValue(new ApiError(422, 'invalid_kind'));
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));
  expect((await within(criticalCard()).findByRole('alert')).textContent).toBe("That change isn't allowed.");
});

it('any other failure says Couldn\'t save. Try again., never the code', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockRejectedValue(new ApiError(500, 'something_new'));
  await mount();
  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));
  const alert = await within(defaultsCard()).findByRole('alert');
  expect(alert.textContent).toBe("Couldn't save. Try again.");
  expect(alert.textContent).not.toContain('something_new');

  // a network failure is no ApiError at all
  api.updateNotificationSettings.mockRejectedValue(new TypeError('Failed to fetch'));
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));
  expect((await within(criticalCard()).findByRole('alert')).textContent).toBe("Couldn't save. Try again.");
});

it('a failed save keeps the draft and Save, so it can be tried again; the next save clears the error', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));
  await within(defaultsCard()).findByRole('alert');
  expect(gridSwitch('Email', 'Wiki').checked).toBe(false);
  expect(saveIn(defaultsCard()).disabled).toBe(false);

  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), defaults: { ...SETTINGS.defaults, wiki: { inbox: true, email: false } },
  });
  await user.click(saveIn(defaultsCard()));
  await waitFor(() => expect(saveIn(defaultsCard()).disabled).toBe(true));
  expect(within(defaultsCard()).queryByRole('alert')).toBeNull();
  expect(api.updateNotificationSettings).toHaveBeenCalledTimes(2);
});

it('editing a card drops its own old error, and only its own', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockRejectedValue(new ApiError(500, 'unknown_error'));
  await mount();
  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));
  await within(defaultsCard()).findByRole('alert');

  // an edit in the other card leaves the defaults card's error where it is
  await user.click(critSwitch('Report ready'));
  expect(within(defaultsCard()).getByRole('alert')).toBeTruthy();

  // an edit in the card itself drops it
  await user.click(gridSwitch('Email', 'Learning'));
  expect(within(defaultsCard()).queryByRole('alert')).toBeNull();
});

it('a new save starts without the old error, whichever card it was in', async () => {
  const user = userEvent.setup();
  api.updateNotificationSettings.mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
  api.updateNotificationSettings.mockResolvedValue({
    ...structuredClone(SETTINGS), critical_kinds: ['report_ready', 'report_failed'],
  });
  await mount();
  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(saveIn(defaultsCard()));
  await within(defaultsCard()).findByRole('alert');

  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(criticalCard()));
  await waitFor(() => expect(saveIn(criticalCard()).disabled).toBe(true));
  expect(screen.queryByRole('alert')).toBeNull();
});

// ── while saving, and without the permission ───────────────────────────

it('while a save is on its way nothing can be changed or saved again', async () => {
  const user = userEvent.setup();
  const pending = deferred<NotificationSettings>();
  api.updateNotificationSettings.mockReturnValue(pending.promise);
  await mount();

  await user.click(gridSwitch('Email', 'Wiki'));
  await user.click(critSwitch('Report ready'));
  await user.click(saveIn(defaultsCard()));

  await waitFor(() => expect(saveIn(defaultsCard()).disabled).toBe(true));
  expect(saveIn(criticalCard()).disabled).toBe(true);
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes.every((b) => b.disabled)).toBe(true);
  await user.click(saveIn(criticalCard()));
  expect(api.updateNotificationSettings).toHaveBeenCalledTimes(1);

  pending.resolve({ ...structuredClone(SETTINGS), defaults: { ...SETTINGS.defaults, wiki: { inbox: true, email: false } } });
  await waitFor(() => expect(critSwitch('Report ready').disabled).toBe(false));
  expect(saveIn(criticalCard()).disabled).toBe(false);   // the critical edit is still waiting to be saved
});

it('without notifications:change every switch and both Saves are read-only', async () => {
  auth.canChange = false;
  await mount();
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes.length).toBeGreaterThan(0);
  expect(boxes.every((b) => b.disabled)).toBe(true);
  expect(saveIn(defaultsCard()).disabled).toBe(true);
  expect(saveIn(criticalCard()).disabled).toBe(true);
});

it('both Saves are the house solid button', async () => {
  await mount();
  expect(saveIn(defaultsCard()).classList.contains('btn-solid')).toBe(true);
  expect(saveIn(criticalCard()).classList.contains('btn-solid')).toBe(true);
});

it('uses no raw select, time input or bare checkbox outside the house Switch', async () => {
  const { container } = await mount();
  expect(container.querySelector('select')).toBeNull();
  expect(container.querySelector('input[type="time"]')).toBeNull();
  const bare = [...container.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => !box.closest('label.switch'));
  expect(bare).toHaveLength(0);
});
