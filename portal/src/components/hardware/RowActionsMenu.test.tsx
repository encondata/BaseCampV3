// @vitest-environment jsdom
/**
 * RowActionsMenu — compact row-actions trigger + pop-menu, replacing
 * per-row button strips on the device lists. Covers: trigger label,
 * items hidden until opened, click order + destructive class, select
 * closes the menu and fires onSelect, Escape closes, outside mousedown
 * closes (including a mousedown on the portaled menu itself NOT
 * counting as outside), the menu portaling to document.body so
 * .dir-list's overflow:hidden can't clip it, and an empty actions list
 * renders nothing at all.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { RowActionsMenu, type RowAction } from './RowActionsMenu';

afterEach(cleanup);

function actions(): RowAction[] {
  return [
    { key: 'edit', label: 'Edit', onSelect: vi.fn() },
    { key: 'register', label: 'Register', onSelect: vi.fn() },
    { key: 'delete', label: 'Delete', destructive: true, onSelect: vi.fn() },
  ];
}

it('renders the "Actions ▾" trigger; menu items are hidden until clicked, then shown in order with destructive class', async () => {
  const user = userEvent.setup();
  const acts = actions();
  render(<RowActionsMenu actions={acts} />);

  const trigger = screen.getByRole('button', { name: 'Actions ▾' });
  expect(screen.queryByRole('menuitem')).toBeNull();

  await user.click(trigger);

  const items = screen.getAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['Edit', 'Register', 'Delete']);
  expect(items[2].className).toContain('danger');
  expect(items[0].className).not.toContain('danger');
});

it('selecting an item calls its onSelect and closes the menu', async () => {
  const user = userEvent.setup();
  const acts = actions();
  render(<RowActionsMenu actions={acts} />);

  await user.click(screen.getByRole('button', { name: 'Actions ▾' }));
  await user.click(screen.getByRole('menuitem', { name: 'Register' }));

  expect(acts[1].onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menuitem')).toBeNull();
});

it('Escape closes the menu', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions ▾' }));
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

it('a mousedown outside the menu closes it', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions ▾' }));
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);

  fireEvent.mouseDown(document.body);
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

it('a mousedown on the portaled menu itself is not treated as outside', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions ▾' }));
  const items = screen.getAllByRole('menuitem');
  expect(items).not.toHaveLength(0);

  // The menu is portaled straight onto document.body, outside the
  // trigger's own subtree, so a mousedown on a menu item must not be
  // caught by the outside-close check the way a mousedown on
  // document.body itself is above.
  fireEvent.mouseDown(items[0]);
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);
});

it('renders the open menu as a child of document.body, not the .row-actions wrapper', async () => {
  const user = userEvent.setup();
  const { container } = render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions ▾' }));

  const menu = screen.getByRole('menu');
  expect(menu.parentElement).toBe(document.body);
  expect(container.querySelector('.row-actions')?.contains(menu)).toBe(false);
});

it('renders nothing at all when actions is empty', () => {
  const { container } = render(<RowActionsMenu actions={[]} />);
  expect(container.firstChild).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('supports a custom label', async () => {
  render(<RowActionsMenu label="Row" actions={actions()} />);
  expect(screen.getByRole('button', { name: 'Row ▾' })).not.toBeNull();
});

it('when menu flips upward (spaceBelow < 200px), clears the CSS class top rule by setting inline top: auto', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  const trigger = screen.getByRole('button', { name: 'Actions ▾' });

  // Stub getBoundingClientRect to force upward flip: trigger near bottom, not enough space below
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 700,
    bottom: 750,
    left: 100,
    right: 150,
    width: 50,
    height: 50,
    x: 100,
    y: 700,
    toJSON: () => ({}),
  });

  await user.click(trigger);

  const menu = screen.getByRole('menu');
  // When flipping upward, both top and bottom must be set to clear the CSS class rules
  expect(menu.style.top).toBe('auto');
  expect(menu.style.bottom).not.toBe('');
  expect(menu.style.bottom).not.toBe('auto');
  // Verify bottom is a numeric value (the portal position is calculated)
  expect(Number.isFinite(parseFloat(menu.style.bottom))).toBe(true);
});
