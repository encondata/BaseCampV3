// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import InfraTree from './InfraTree';
import { CLOUD_TREE, DEMO_TREE } from './testData';

afterEach(cleanup);

const rowNames = () => screen.getAllByRole('row').slice(1)
  .map((r) => r.querySelector('.sd-tree-name')!.textContent);
const expanded = (name: RegExp) => screen.getByRole('row', { name }).getAttribute('aria-expanded');

type Props = Parameters<typeof InfraTree>[0];
const props = (over: Partial<Props> = {}): Props => ({
  source: 'demo', error: null, tree: DEMO_TREE, selected: 'production', refreshing: false,
  onRefresh: vi.fn(), ...over,
});
function show(over: Partial<Props> = {}) {
  const p = props(over);
  const view = render(<InfraTree {...p} />);
  return { ...p, rerender: (more: Partial<Props>) => view.rerender(<InfraTree {...p} {...more} />) };
}

it('the selected environment comes first, expanded; the others are collapsed', () => {
  show();
  const grid = screen.getByRole('treegrid');
  const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers).toEqual(['Instance / resource', 'Type', 'Status', 'Region', 'Endpoint']);
  expect(rowNames()).toEqual([
    'Production', 'Blue', 'prod-blue-api', 'Green', 'prod-green-api',
    'Shared production resources', 'prod-db', 'prod-spaces', 'Development', 'UAT',
  ]);
  expect(screen.getByRole('row', { name: /^Production/ }).getAttribute('aria-level')).toBe('1');
  expect(expanded(/^Production/)).toBe('true');
  expect(expanded(/^Development/)).toBe('false');
  const api = screen.getByRole('row', { name: /prod-blue-api/ });
  expect(api.getAttribute('aria-level')).toBe('3');
  expect(api.hasAttribute('aria-expanded')).toBe(false);
  expect(within(api).getByText('10.20.0.10')).toBeTruthy();
  expect(screen.getByText('Blue + Green').className).toMatch(/sd-badge/);
  expect(screen.getByText('Droplet instances and shared resources')).toBeTruthy();
});

it('order: the selected environment, the rest in card order, then the other resources', () => {
  show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'uat' });
  expect(rowNames()).toEqual([
    'uat', 'Nginx Proxy Manager', 'Lab box', 'Certificate', 'prod', 'uat9', 'Other DigitalOcean resources',
  ]);
  expect(expanded(/^Other DigitalOcean resources/)).toBe('false');
});

it('a new selection moves to the top and expands; the old one collapses back', () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  expect(rowNames().slice(0, 4)).toEqual(['prod', 'ss-prod-lb', 'Blue (live)', 'Green (idle)']);
  rerender({ selected: 'uat9' });
  expect(rowNames()).toEqual([
    'uat9', 'Orange (live)', 'Purple (idle)', 'prod', 'uat', 'Other DigitalOcean resources',
  ]);
  expect(expanded(/^prod/)).toBe('false');
});

it('an environment the user expanded by hand stays expanded when the selection moves on', async () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  await userEvent.click(screen.getByRole('button', { name: 'Expand uat' }));
  rerender({ selected: 'uat9' });
  expect(expanded(/^uat9/)).toBe('true');
  expect(expanded(/^prod/)).toBe('false');
  expect(expanded(/^uat$/)).toBe('true');
  rerender({ selected: 'uat' });              // uat9 was only opened by the selection
  expect(rowNames()[0]).toBe('uat');
  expect(expanded(/^uat9/)).toBe('false');
  rerender({ selected: 'prod' });             // uat was opened by hand first: it stays
  expect(expanded(/^uat$/)).toBe('true');
});

it('the selected environment the user collapsed by hand reopens when picked again', async () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  await userEvent.click(screen.getByRole('button', { name: 'Collapse prod' }));
  expect(expanded(/^prod/)).toBe('false');
  rerender({ selected: 'uat' });
  rerender({ selected: 'prod' });
  expect(expanded(/^prod/)).toBe('true');
});

it('a selection with no environment node (a placeholder) keeps the order, all collapsed', () => {
  show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'beta' });
  expect(rowNames()).toEqual(['prod', 'uat9', 'uat', 'Other DigitalOcean resources']);
});

it('new data with the same nodes keeps what is open', async () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  await userEvent.click(screen.getByRole('button', { name: 'Expand Other DigitalOcean resources' }));
  rerender({ tree: CLOUD_TREE.map((x) => ({ ...x })) });
  expect(expanded(/^Other DigitalOcean resources/)).toBe('true');
  expect(expanded(/^prod/)).toBe('true');
});

it('collapses and expands one node with its chevron', async () => {
  show();
  await userEvent.click(screen.getByRole('button', { name: 'Collapse Blue' }));
  expect(rowNames()).not.toContain('prod-blue-api');
  expect(expanded(/^Blue/)).toBe('false');
  await userEvent.click(screen.getByRole('button', { name: 'Expand Blue' }));
  expect(rowNames()).toContain('prod-blue-api');
});

it('Collapse all and Expand all affect every node', async () => {
  show();
  await userEvent.click(screen.getByRole('button', { name: /Collapse all/ }));
  expect(rowNames()).toEqual(['Production', 'Development', 'UAT']);
  await userEvent.click(screen.getByRole('button', { name: /Expand all/ }));
  expect(rowNames()).toHaveLength(13);
});

it('Expand all is not opening by hand: the old pick still closes when the selection moves', async () => {
  const { rerender } = show();
  await userEvent.click(screen.getByRole('button', { name: /Expand all/ }));
  rerender({ selected: 'dev' });
  expect(rowNames()).toEqual(['Development', 'dev-web', 'dev-new', 'Production', 'UAT', 'Lab box']);
});

it('Collapse all forgets what was opened by hand', async () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  await userEvent.click(screen.getByRole('button', { name: 'Expand uat' }));
  await userEvent.click(screen.getByRole('button', { name: /Collapse all/ }));
  rerender({ selected: 'uat' });               // the selection opens it, not the hand
  rerender({ selected: 'prod' });
  expect(expanded(/^uat$/)).toBe('false');
});

it('status pills get classes by status', () => {
  show({ selected: null });
  fireEvent.click(screen.getByRole('button', { name: /Expand all/ }));
  const pill = (name: RegExp) => screen.getByRole('row', { name }).querySelector('.sd-status')!.className;
  expect(pill(/prod-blue-api/)).toMatch(/is-ok/);
  expect(pill(/prod-db/)).toMatch(/is-ok/);
  expect(pill(/prod-spaces/)).toMatch(/is-ok/);
  expect(pill(/prod-green-api/)).toMatch(/is-muted/);
  expect(pill(/dev-web/)).toMatch(/is-muted/);
  expect(pill(/dev-new/)).toMatch(/is-warn/);
});

it('a part missing from the inventory is red: Not found', () => {
  const tree = [{ ...CLOUD_TREE[0], children: [{ ...CLOUD_TREE[0].children[0], status: 'not_found',
                                                 status_label: 'Not found' }] }];
  show({ source: 'digitalocean', tree, selected: 'prod' });
  expect(screen.getByRole('row', { name: /ss-prod-lb/ }).querySelector('.sd-status')!.className).toMatch(/is-bad/);
});

it('keyboard: arrows move between rows, Left/Right collapse and expand', () => {
  show();
  const rows = () => screen.getAllByRole('row').slice(1);
  rows()[0].focus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Blue/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(expanded(/^Blue/)).toBe('false');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Green/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(expanded(/^Blue/)).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Production/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^UAT/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(expanded(/^UAT/)).toBe('true');
});

const tabStops = () => screen.getAllByRole('row').slice(1).filter((r) => r.tabIndex === 0)
  .map((r) => r.getAttribute('aria-label'));

it('after a reorder the tab stop goes back to the first row, and the arrows follow the new order', () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  screen.getByRole('row', { name: /^uat9/ }).focus();
  (document.activeElement as HTMLElement).blur();           // focus has left the tree
  rerender({ selected: 'uat' });
  expect(tabStops()).toEqual(['uat']);
  screen.getByRole('row', { name: /^uat$/ }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: 'Nginx Proxy Manager' }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: 'Other DigitalOcean resources' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^uat9/ }));
});

it('a reorder while focus is inside the tree keeps the focused row as the tab stop', () => {
  const { rerender } = show({ source: 'digitalocean', tree: CLOUD_TREE, selected: 'prod' });
  screen.getByRole('row', { name: /^uat9/ }).focus();
  rerender({ selected: 'uat' });
  expect(tabStops()).toEqual(['uat9']);
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^uat9/ }));
});

it('a certificate inside its renewal window is amber', () => {
  const tree = [{ ...CLOUD_TREE[2], children: [{ ...CLOUD_TREE[2].children[2], status: 'expiring',
                                                 status_label: '10 days left' }] }];
  show({ source: 'digitalocean', tree, selected: 'uat' });
  expect(screen.getByRole('row', { name: 'Certificate' }).querySelector('.sd-status')!.className).toMatch(/is-warn/);
});

it('Refresh calls back and spins while refreshing', async () => {
  const { onRefresh } = show();
  await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  expect(onRefresh).toHaveBeenCalled();
  cleanup();
  show({ refreshing: true });
  expect(screen.getByRole('button', { name: /Refresh/ }).className).toMatch(/is-spinning/);
});

it('no source: the connect hint and an empty table', () => {
  show({ source: 'none', tree: [] });
  expect(screen.getByText('Connect DigitalOcean on the Deploy page to see your droplets and resources.')).toBeTruthy();
  expect(screen.getByText('No droplets or resources to show.')).toBeTruthy();
});

it('an inventory error shows the reason inline', () => {
  show({ source: 'digitalocean', tree: [], error: 'DigitalOcean rejected the token.' });
  expect(screen.getByRole('alert').textContent).toMatch(/DigitalOcean rejected the token\./);
});

it('the shared group folder is green by node.tone, other folders blue', () => {
  show();
  const folder = (name: RegExp) => screen.getByRole('row', { name }).querySelector('.sd-ico')!.getAttribute('class')!;
  expect(folder(/^Shared production resources/)).toMatch(/is-green/);
  expect(folder(/^Blue/)).toMatch(/is-blue/);
});
