// @vitest-environment jsdom
/**
 * WatchEventsEditor — which events a watch hears about. Controlled: "All events"
 * and "nothing picked yet" are different states, so `all` and `picked` are
 * separate props, and every change is handed to `onChange` as the next pair.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { NotificationKindSetting, WatchTarget } from '../../lib/api';
import WatchEventsEditor, { canSaveEvents, kindsToSave } from './WatchEventsEditor';

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
  watchable: false, everywhere: false, reaches: [], ...over,
});

// In registry order, as GET /notifications/settings lists them. "Kind A" reaches initiatives
// but is not marked everywhere, which is what tells an Everything watch apart from the rest.
const KINDS: NotificationKindSetting[] = [
  kind('report_ready', 'Report ready', 'reports'),
  kind('initiative_status_changed', 'Initiative status changed', 'initiatives',
    { watchable: true, everywhere: true, reaches: ['initiative', 'site'] }),
  kind('truck_status_changed', 'Truck status changed', 'trucks',
    { watchable: true, everywhere: true, reaches: ['truck', 'initiative', 'site'] }),
  kind('kind_a', 'Kind A', 'initiatives', { watchable: true, reaches: ['initiative'] }),
  kind('password_expiring', 'Password expiring', 'security', { owner_always: true, locked: true }),
];

afterEach(cleanup);

type Next = { all: boolean; picked: string[] };

function setup(over: Partial<{
  thing: WatchTarget; kinds: NotificationKindSetting[]; all: boolean; picked: string[];
}> = {}) {
  const onChange = vi.fn<(next: Next) => void>();
  const props = { thing: 'initiative' as WatchTarget, kinds: KINDS, all: true, picked: [] as string[], ...over };
  const view = render(<WatchEventsEditor {...props} onChange={onChange} />);
  return { onChange, view };
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const names = () => screen.queryAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));

it('shows an "All events" switch with its hint, on, and no list while All is on', () => {
  setup();

  expect(checkbox('All events').checked).toBe(true);
  expect(screen.getByText('Every event that applies to this.')).toBeTruthy();
  expect(names()).toEqual(['All events']);
  expect(screen.queryAllByRole('group')).toHaveLength(0);
});

it('turning All off hands over All off with no picks, whatever was picked before', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ all: true, picked: ['truck_status_changed'] });

  await user.click(checkbox('All events'));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith({ all: false, picked: [] });
});

it('turning All back on hands over All on with no picks', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ all: false, picked: ['truck_status_changed'] });

  await user.click(checkbox('All events'));

  expect(onChange).toHaveBeenCalledWith({ all: true, picked: [] });
});

it('with All off lists the events that apply to the thing, grouped under their category labels', () => {
  setup({ all: false });

  const groups = screen.getAllByRole('group');
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Initiatives', 'Trucks']);
  const switchesOf = (group: HTMLElement) => within(group).getAllByRole('checkbox')
    .map((c) => c.getAttribute('aria-label'));
  expect(switchesOf(groups[0])).toEqual(['Initiative status changed', 'Kind A']);
  expect(switchesOf(groups[1])).toEqual(['Truck status changed']);
  // Each group wears its category label as the house heading line.
  expect(within(groups[0]).getByText('Initiatives').closest('.modal-section')).not.toBeNull();
  expect(within(groups[1]).getByText('Trucks').closest('.modal-section')).not.toBeNull();
  // What nobody can watch for is never offered.
  expect(screen.queryByRole('checkbox', { name: 'Report ready' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Password expiring' })).toBeNull();
});

it('keeps the "All events" switch on top, and every kind has its own switch named by its label', () => {
  setup({ all: false, picked: ['kind_a'] });

  expect(names()).toEqual([
    'All events', 'Initiative status changed', 'Kind A', 'Truck status changed',
  ]);
  expect(checkbox('All events').checked).toBe(false);
  expect(checkbox('Kind A').checked).toBe(true);
  expect(checkbox('Initiative status changed').checked).toBe(false);
  expect(checkbox('Truck status changed').checked).toBe(false);
});

it('orders the groups by the category order, not by the order the kinds came in', () => {
  const reversed = [...KINDS].reverse();
  setup({ all: false, kinds: reversed });

  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks']);
});

it('a site lists what reaches sites, and a truck only what reaches trucks', () => {
  const { view } = setup({ thing: 'site', all: false });
  expect(names()).toEqual(['All events', 'Initiative status changed', 'Truck status changed']);

  view.unmount();
  setup({ thing: 'truck', all: false });
  expect(names()).toEqual(['All events', 'Truck status changed']);
  // A category with nothing to pick shows no heading.
  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Trucks']);
});

it('picking a kind hands over All off and the picks', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ all: false, picked: [] });

  await user.click(checkbox('Truck status changed'));

  expect(onChange).toHaveBeenCalledWith({ all: false, picked: ['truck_status_changed'] });
});

it('unpicking a kind takes it out and keeps the others', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({
    all: false, picked: ['initiative_status_changed', 'truck_status_changed'],
  });

  await user.click(checkbox('Initiative status changed'));

  expect(onChange).toHaveBeenCalledWith({ all: false, picked: ['truck_status_changed'] });
});

it('hands the picks over in registry order, whatever order they were picked in', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ all: false, picked: ['truck_status_changed'] });

  await user.click(checkbox('Initiative status changed'));

  expect(onChange).toHaveBeenCalledWith({
    all: false, picked: ['initiative_status_changed', 'truck_status_changed'],
  });
});

it('is controlled: it shows what it is given and changes nothing by itself', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ all: false, picked: [] });

  await user.click(checkbox('Kind A'));

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(checkbox('Kind A').checked).toBe(false);
});

it('Everything has no "All events" switch and always lists the events marked everywhere', () => {
  setup({ thing: 'everything', all: false });

  expect(screen.queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect(screen.queryByText('Every event that applies to this.')).toBeNull();
  expect(names()).toEqual(['Initiative status changed', 'Truck status changed']);
  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks']);
});

it('Everything lists its events even if it is handed All on', () => {
  setup({ thing: 'everything', all: true });

  expect(names()).toEqual(['Initiative status changed', 'Truck status changed']);
});

it('Everything hands over All off with the picks', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({ thing: 'everything', all: false, picked: [] });

  await user.click(checkbox('Truck status changed'));

  expect(onChange).toHaveBeenCalledWith({ all: false, picked: ['truck_status_changed'] });
});

it('shows only the All switch for a thing while the kinds are not loaded, and nothing for Everything', () => {
  const { view } = setup({ kinds: [], all: false });
  expect(names()).toEqual(['All events']);

  view.unmount();
  setup({ kinds: [], thing: 'everything', all: false });
  expect(names()).toEqual([]);
});

// The registry's Device offline: it reaches devices, sites and initiatives, and an Everything watch may name it.
const DEVICE_OFFLINE = kind('device_offline', 'Device offline', 'devices',
  { watchable: true, everywhere: true, reaches: ['device', 'site', 'initiative'] });

it('a device lists Device offline, under the Devices category label', () => {
  setup({ thing: 'device', all: false, kinds: [...KINDS, DEVICE_OFFLINE] });

  const groups = screen.getAllByRole('group');
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Devices']);
  expect(within(groups[0]).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Device offline']);
  expect(within(groups[0]).getByText('Devices').closest('.modal-section')).not.toBeNull();
});

it('Everything lists Device offline after Trucks, in the categories\' own order', () => {
  setup({ thing: 'everything', all: false, kinds: [DEVICE_OFFLINE, ...KINDS] });

  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks', 'Devices']);
  expect(names()).toEqual(['Initiative status changed', 'Truck status changed', 'Device offline']);
});

// The registry's Status rule matched: it reaches initiatives and sites, and an Everything watch may not name it.
const STATUS_RULE_MATCHED = kind('status_rule_matched', 'Status rule matched', 'status_rules',
  { watchable: true, everywhere: false, reaches: ['initiative', 'site'] });

it('an initiative and a site list Status rule matched after Devices, under the Status rules label', () => {
  const kinds = [STATUS_RULE_MATCHED, ...KINDS, DEVICE_OFFLINE];
  const { view } = setup({ thing: 'site', all: false, kinds });

  const groups = screen.getAllByRole('group');
  expect(groups.map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks', 'Devices', 'Status rules']);
  expect(within(groups[3]).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Status rule matched']);
  expect(within(groups[3]).getByText('Status rules').closest('.modal-section')).not.toBeNull();

  view.unmount();
  setup({ thing: 'initiative', all: false, kinds });
  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks', 'Devices', 'Status rules']);
  expect(checkbox('Status rule matched').checked).toBe(false);
});

it('a truck, a device and Everything never list Status rule matched', () => {
  const kinds = [...KINDS, DEVICE_OFFLINE, STATUS_RULE_MATCHED];
  const { view } = setup({ thing: 'truck', all: false, kinds });
  expect(screen.queryByRole('checkbox', { name: 'Status rule matched' })).toBeNull();

  view.unmount();
  const second = setup({ thing: 'device', all: false, kinds });
  expect(screen.queryByRole('checkbox', { name: 'Status rule matched' })).toBeNull();

  // Everything names only the events marked everywhere; a rule's notice is about its own initiative.
  second.view.unmount();
  setup({ thing: 'everything', all: false, kinds });
  expect(screen.queryByRole('checkbox', { name: 'Status rule matched' })).toBeNull();
  expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
    .toEqual(['Initiatives', 'Trucks', 'Devices']);
});

it('picking Status rule matched hands it over with the picks', async () => {
  const user = userEvent.setup();
  const { onChange } = setup({
    thing: 'initiative', all: false, picked: ['initiative_status_changed'],
    kinds: [...KINDS, STATUS_RULE_MATCHED],
  });

  await user.click(checkbox('Status rule matched'));

  expect(onChange).toHaveBeenCalledWith({
    all: false, picked: ['initiative_status_changed', 'status_rule_matched'],
  });
});

it('uses house controls only: every checkbox is a Switch, and there is no select', () => {
  const { view } = setup({ all: false, picked: ['kind_a'] });

  const boxes = view.container.querySelectorAll('input[type="checkbox"]');
  expect(boxes.length).toBe(4);
  for (const box of boxes) expect(box.closest('label.switch')).not.toBeNull();
  expect(view.container.querySelector('select')).toBeNull();
});

// ── the two rules both events dialogs share ─────────────────────────────

it('events can be saved when All events is on or at least one event is picked', () => {
  expect(canSaveEvents({ all: true, picked: [] })).toBe(true);
  expect(canSaveEvents({ all: false, picked: ['kind_a'] })).toBe(true);
  expect(canSaveEvents({ all: false, picked: [] })).toBe(false);
});

it('a save sends no kinds for All events, and the picks otherwise', () => {
  expect(kindsToSave({ all: true, picked: [] })).toEqual([]);
  expect(kindsToSave({ all: false, picked: ['initiative_status_changed', 'kind_a'] }))
    .toEqual(['initiative_status_changed', 'kind_a']);
  // All means none are named, whatever a stale pick says.
  expect(kindsToSave({ all: true, picked: ['kind_a'] })).toEqual([]);
});
