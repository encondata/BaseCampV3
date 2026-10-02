// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import InfraTree from './InfraTree';
import { DEMO_TREE } from './testData';

afterEach(cleanup);

const rowNames = () => screen.getAllByRole('row').slice(1)
  .map((r) => r.querySelector('.sd-tree-name')!.textContent);

function show(props: Partial<Parameters<typeof InfraTree>[0]> = {}) {
  const onRefresh = vi.fn();
  render(<InfraTree source="demo" error={null} tree={DEMO_TREE} refreshing={false}
                    onRefresh={onRefresh} {...props} />);
  return { onRefresh };
}

it('renders every node expanded with its columns', () => {
  show();
  const grid = screen.getByRole('treegrid');
  const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent);
  expect(headers).toEqual(['Instance / resource', 'Type', 'Status', 'Region', 'Endpoint']);
  expect(rowNames()).toEqual([
    'Production', 'Blue', 'prod-blue-api', 'Green', 'prod-green-api',
    'Shared production resources', 'prod-db', 'prod-spaces', 'Development', 'dev-web', 'dev-new',
  ]);
  const prod = screen.getByRole('row', { name: /^Production/ });
  expect(prod.getAttribute('aria-level')).toBe('1');
  expect(prod.getAttribute('aria-expanded')).toBe('true');
  const api = screen.getByRole('row', { name: /prod-blue-api/ });
  expect(api.getAttribute('aria-level')).toBe('3');
  expect(api.hasAttribute('aria-expanded')).toBe(false);
  expect(within(api).getByText('10.20.0.10')).toBeTruthy();
  expect(screen.getByText('Blue + Green').className).toMatch(/sd-badge/);
  expect(screen.getByText('Droplet instances and shared resources')).toBeTruthy();
});

it('collapses and expands one node with its chevron', async () => {
  show();
  await userEvent.click(screen.getByRole('button', { name: 'Collapse Blue' }));
  expect(rowNames()).not.toContain('prod-blue-api');
  expect(screen.getByRole('row', { name: /^Blue/ }).getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(screen.getByRole('button', { name: 'Expand Blue' }));
  expect(rowNames()).toContain('prod-blue-api');
});

it('Collapse all and Expand all affect every node', async () => {
  show();
  await userEvent.click(screen.getByRole('button', { name: /Collapse all/ }));
  expect(rowNames()).toEqual(['Production', 'Development']);
  await userEvent.click(screen.getByRole('button', { name: /Expand all/ }));
  expect(rowNames()).toHaveLength(11);
});

it('status pills get classes by status', () => {
  show();
  const pill = (name: RegExp) => screen.getByRole('row', { name }).querySelector('.sd-status')!.className;
  expect(pill(/prod-blue-api/)).toMatch(/is-ok/);
  expect(pill(/prod-db/)).toMatch(/is-ok/);
  expect(pill(/prod-spaces/)).toMatch(/is-ok/);
  expect(pill(/prod-green-api/)).toMatch(/is-muted/);
  expect(pill(/dev-web/)).toMatch(/is-muted/);
  expect(pill(/dev-new/)).toMatch(/is-warn/);
});

it('keyboard: arrows move between rows, Left/Right collapse and expand', () => {
  show();
  const rows = () => screen.getAllByRole('row').slice(1);
  rows()[0].focus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Blue/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(screen.getByRole('row', { name: /^Blue/ }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Green/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(screen.getByRole('row', { name: /^Blue/ }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Production/ }));
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
