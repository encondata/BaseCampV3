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

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  // named by its label; the ▾ only marks the menu (hidden from the name)
  const trigger = screen.getByRole('button', { name: 'Actions' });
  expect(trigger.textContent).toBe('Actions ▾');
  expect(trigger.querySelector('[aria-hidden="true"]')?.textContent).toBe(' ▾');
  // label and caret are one flex child of the inline-flex button, so its 7px
  // gap doesn't come between them (the trigger stays as wide as it was)
  expect(trigger.children).toHaveLength(1);
  expect(trigger.children[0].tagName).toBe('SPAN');
  expect(trigger.children[0].textContent).toBe('Actions ▾');
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

  await user.click(screen.getByRole('button', { name: 'Actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Register' }));

  expect(acts[1].onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menuitem')).toBeNull();
});

it('Escape closes the menu', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions' }));
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

it('the Escape that closes the menu is marked handled (a full-screen view or dialog behind stays); a later one is not', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);
  await user.click(screen.getByRole('button', { name: 'Actions' }));

  // a host listening on document after the menu (full screen, a dialog)
  const seen: boolean[] = [];
  const host = (e: KeyboardEvent) => { if (e.key === 'Escape') seen.push(e.defaultPrevented); };
  document.addEventListener('keydown', host);
  try {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  } finally {
    document.removeEventListener('keydown', host);
  }
  expect(seen).toEqual([true, false]);
});

it('a mousedown outside the menu closes it', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions' }));
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);

  fireEvent.mouseDown(document.body);
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

it('a mousedown on the portaled menu itself is not treated as outside', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  await user.click(screen.getByRole('button', { name: 'Actions' }));
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

  await user.click(screen.getByRole('button', { name: 'Actions' }));

  const menu = screen.getByRole('menu');
  expect(menu.parentElement).toBe(document.body);
  expect(container.querySelector('.row-actions')?.contains(menu)).toBe(false);
});

it('inside a .portal-shell, the menu goes into the shell, where the theme tokens (dark mode) are', async () => {
  const user = userEvent.setup();
  render(
    <div className="portal-shell" data-theme="dark">
      <div className="dir-list"><RowActionsMenu actions={actions()} /></div>
    </div>,
  );
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  const menu = screen.getByRole('menu');
  expect(menu.parentElement).toBe(document.querySelector('.portal-shell'));
  expect(menu.closest('.dir-list')).toBeNull();
});

it('renders nothing at all when actions is empty', () => {
  const { container } = render(<RowActionsMenu actions={[]} />);
  expect(container.firstChild).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('supports a custom label', async () => {
  render(<RowActionsMenu label="Row" actions={actions()} />);
  expect(screen.getByRole('button', { name: 'Row' })).not.toBeNull();
});

it('only one menu is open at a time, even for keyboard activation with no mousedown', () => {
  // Reproduces the live-verification bug: keyboard Enter/Space fires a
  // click with no preceding mousedown, so the outside-mousedown handler
  // (which incidentally saves mouse users) never runs. Without the
  // module-level singleton coordination, both portaled menus would
  // stack and a click could land on the wrong row's action.
  render(
    <>
      <RowActionsMenu
        actions={[{ key: 'a', label: 'First-Only Action', onSelect: vi.fn() }]}
      />
      <RowActionsMenu
        actions={[{ key: 'b', label: 'Second-Only Action', onSelect: vi.fn() }]}
      />
    </>,
  );

  const triggers = screen.getAllByRole('button', { name: 'Actions' });
  expect(triggers).toHaveLength(2);

  // Keyboard activation dispatches a plain click with no mousedown.
  fireEvent.click(triggers[0]);
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menuitem', { name: 'First-Only Action' })).not.toBeNull();

  fireEvent.click(triggers[1]);

  const menus = screen.getAllByRole('menu');
  expect(menus).toHaveLength(1);
  expect(screen.queryByRole('menuitem', { name: 'First-Only Action' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Second-Only Action' })).not.toBeNull();
});

it('when menu flips upward (spaceBelow < 200px), clears the CSS class top rule by setting inline top: auto', async () => {
  const user = userEvent.setup();
  render(<RowActionsMenu actions={actions()} />);

  const trigger = screen.getByRole('button', { name: 'Actions' });

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

it('a disabled item renders disabled, does not fire onSelect, and leaves the menu open', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <RowActionsMenu
      actions={[
        { key: 'remove', label: 'Remove', onSelect, disabled: true },
        { key: 'edit', label: 'Edit', onSelect: vi.fn() },
      ]}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Actions' }));

  const item = screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);

  await user.click(item);

  expect(onSelect).not.toHaveBeenCalled();
  // The row is busy, not finished: the menu stays open so the user can
  // pick something else or watch the item come back.
  expect(screen.queryAllByRole('menuitem')).not.toHaveLength(0);
});

it('a destructive item can also be disabled and keeps its danger class', async () => {
  const user = userEvent.setup();
  render(
    <RowActionsMenu
      actions={[{ key: 'delete', label: 'Delete', destructive: true, disabled: true, onSelect: vi.fn() }]}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Actions' }));

  const item = screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(item.className).toContain('danger');
});

it('still renders the trigger when every item is disabled', async () => {
  const user = userEvent.setup();
  // "All disabled" is not "empty": dropping the items would make the
  // trigger vanish mid-action on a single-action row.
  render(
    <RowActionsMenu
      actions={[
        { key: 'download', label: 'Download', onSelect: vi.fn(), disabled: true },
        { key: 'delete', label: 'Delete', destructive: true, onSelect: vi.fn(), disabled: true },
      ]}
    />,
  );

  const trigger = screen.getByRole('button', { name: 'Actions' });
  expect(trigger).not.toBeNull();

  await user.click(trigger);
  const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
  expect(items.map((i) => i.textContent)).toEqual(['Download', 'Delete']);
  expect(items.every((i) => i.disabled)).toBe(true);
});

it('a disabled item can say why it is off: a hint line that describes it', async () => {
  const user = userEvent.setup();
  render(
    <RowActionsMenu
      actions={[
        { key: 'rename', label: 'Rename…', onSelect: vi.fn(), disabled: true, hint: 'Deactivate it first to rename it' },
        { key: 'edit', label: 'Edit', onSelect: vi.fn() },
      ]}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  // the name stays the label; the hint shows under it and describes it
  const item = screen.getByRole('menuitem', { name: 'Rename…' }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  const hint = screen.getByText('Deactivate it first to rename it');
  expect(item.contains(hint)).toBe(true);
  expect(hint.className).toBe('pop-item-hint');
  expect(item.getAttribute('aria-describedby')).toBe(hint.id);
  // an item without a hint is as it was
  const edit = screen.getByRole('menuitem', { name: 'Edit' });
  expect(edit.textContent).toBe('Edit');
  expect(edit.getAttribute('aria-describedby')).toBeNull();
});

it('a choice among several: `checked` items are menuitemradios, the current one checked with a ✓', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(
    <RowActionsMenu
      actions={[
        { key: 'a', label: 'Beside', hint: 'Side by side.', checked: false, onSelect: pick },
        { key: 'b', label: 'Below', hint: 'Stacked.', checked: true, onSelect: vi.fn() },
        { key: 'c', label: 'Plain', onSelect: vi.fn() },
      ]}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  const radios = screen.getAllByRole('menuitemradio');
  expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Beside', 'Below']);
  expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  // the ✓ shows on the current one only, and is not part of the name
  expect(radios[1].classList.contains('on')).toBe(true);
  expect(radios[0].classList.contains('on')).toBe(false);
  expect(radios[1].querySelector('.pop-mark')?.textContent).toBe('✓');
  expect(radios[1].querySelector('.pop-mark')?.getAttribute('aria-hidden')).toBe('true');
  // the hint still describes it
  expect(screen.getByRole('menuitemradio', { name: 'Below' }).getAttribute('aria-describedby'))
    .toBe(screen.getByText('Stacked.').id);
  // an item without `checked` is a plain menuitem, as before
  expect(screen.getByRole('menuitem', { name: 'Plain' }).getAttribute('aria-checked')).toBeNull();
  await user.click(radios[0]);
  expect(pick).toHaveBeenCalledTimes(1);
});

it('an icon trigger: the icon in place of "label ▾", named by the label; its own class', () => {
  render(
    <RowActionsMenu label="Gantt Layout" icon={<svg data-testid="icon" aria-hidden="true" />}
                    triggerClassName="mini-btn pln-tbtn" actions={actions()} />,
  );
  const trigger = screen.getByRole('button', { name: 'Gantt Layout' });
  expect(trigger.getAttribute('aria-label')).toBe('Gantt Layout');
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.className).toBe('mini-btn pln-tbtn');
  expect(trigger.querySelector('[data-testid="icon"]')).not.toBeNull();
  expect(trigger.textContent).toBe('');
});

it('returnFocus: choosing an item puts focus back on the trigger; without it, as before', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<RowActionsMenu label="Pick" returnFocus actions={actions()} />);
  await user.click(screen.getByRole('button', { name: 'Pick' }));
  await user.click(screen.getByRole('menuitem', { name: 'Register' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pick' }));
  unmount();
  render(<RowActionsMenu label="Other" actions={actions()} />);
  await user.click(screen.getByRole('button', { name: 'Other' }));
  await user.click(screen.getByRole('menuitem', { name: 'Register' }));
  expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Other' }));
});

describe('the keyboard (the menu-button pattern)', () => {
  /** Edit, a disabled Rename, Register, Delete: the arrows skip Rename. */
  function withDisabled(): RowAction[] {
    return [
      { key: 'edit', label: 'Edit', onSelect: vi.fn() },
      { key: 'rename', label: 'Rename', onSelect: vi.fn(), disabled: true },
      { key: 'register', label: 'Register', onSelect: vi.fn() },
      { key: 'delete', label: 'Delete', destructive: true, onSelect: vi.fn() },
    ];
  }
  const trigger = () => screen.getByRole('button', { name: 'Actions' });
  const focused = () => document.activeElement?.textContent;

  it('Enter, Space or ↓ on the trigger opens the menu on its first enabled item; ↑ on its last', async () => {
    const user = userEvent.setup();
    render(<RowActionsMenu actions={[{ key: 'off', label: 'Off', onSelect: vi.fn(), disabled: true }, ...actions()]} />);
    for (const key of ['{Enter}', ' ', '{ArrowDown}']) {
      act(() => { trigger().focus(); });
      await user.keyboard(key);
      expect(screen.getByRole('menu'), key).toBeTruthy();
      expect(focused(), key).toBe('Edit');
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    }
    act(() => { trigger().focus(); });
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Delete');
  });

  it('a keyboard open lands on the checked item of a choice', async () => {
    const user = userEvent.setup();
    render(
      <RowActionsMenu actions={[
        { key: 'a', label: 'Beside', checked: false, onSelect: vi.fn() },
        { key: 'b', label: 'Below', checked: true, onSelect: vi.fn() },
        { key: 'c', label: 'Hidden', checked: false, onSelect: vi.fn() },
      ]} />,
    );
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Below' }));
  });

  it('a mouse open leaves focus on the trigger; the arrows from there go into the menu', async () => {
    const user = userEvent.setup();
    render(<RowActionsMenu actions={withDisabled()} />);
    await user.click(trigger());
    expect(document.activeElement).toBe(trigger());
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Edit');
    await user.keyboard('{Escape}');
    await user.click(trigger());
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Delete');
  });

  it('↑/↓ move between the enabled items, wrapping; Home and End go to the ends; items are tabIndex -1', async () => {
    const user = userEvent.setup();
    render(<RowActionsMenu actions={withDisabled()} />);
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('menuitem').map((i) => i.tabIndex)).toEqual([-1, -1, -1, -1]);
    expect(focused()).toBe('Edit');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Register');           // the disabled Rename is skipped
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Delete');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Edit');               // wraps
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Delete');             // and back
    await user.keyboard('{Home}');
    expect(focused()).toBe('Edit');
    await user.keyboard('{End}');
    expect(focused()).toBe('Delete');
  });

  it('Enter or Space picks the focused item; focus goes back to the trigger', async () => {
    const user = userEvent.setup();
    const acts = withDisabled();
    render(<RowActionsMenu actions={acts} />);
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(acts[2].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(acts[0].onSelect).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it('a pick that moves focus itself (a dialog, a field) keeps it there', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Name" />
        <RowActionsMenu actions={[{
          key: 'rename', label: 'Rename', onSelect: () => screen.getByRole('textbox', { name: 'Name' }).focus(),
        }]} />
      </>,
    );
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  });

  it('Escape closes it and puts focus back on the trigger, marked handled', async () => {
    const user = userEvent.setup();
    render(<RowActionsMenu actions={withDisabled()} />);
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}{ArrowDown}');
    expect(focused()).toBe('Register');
    const item = document.activeElement as HTMLElement;
    expect(fireEvent.keyDown(item, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Tab closes it and lets focus move on from the trigger (not held: the browser moves it)', async () => {
    const user = userEvent.setup();
    render(<RowActionsMenu actions={withDisabled()} />);
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}');
    const item = document.activeElement as HTMLElement;
    expect(screen.getByRole('menu').contains(item)).toBe(true);
    // the browser's own Tab goes on from where focus is when it acts: the trigger
    expect(fireEvent.keyDown(item, { key: 'Tab' })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    act(() => { trigger().focus(); });
    await user.keyboard('{Enter}');
    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
