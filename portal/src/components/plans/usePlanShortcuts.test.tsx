// @vitest-environment jsdom
/**
 * components/plans/usePlanShortcuts.ts and lib/plans/shortcuts.ts: the
 * plan's MS Project keyboard map, heard in the capture phase on the tab
 * root. Review Focus 3: Delete, Insert, arrows and Alt+Shift+→ act on the
 * sheet only when no cell editor, input or dialog has focus — inside an
 * editor they type.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { matchPlanShortcut, type PlanShortcutId, type ShortcutKey } from '../../lib/plans/shortcuts';
import ColumnsModal from './ColumnsModal';
import { usePlanShortcuts, type PlanShortcutHandlers } from './usePlanShortcuts';

afterEach(cleanup);

function Harness({ handlers, platform = 'win', columns = false }: {
  handlers: PlanShortcutHandlers; platform?: 'win' | 'mac'; columns?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(columns);
  usePlanShortcuts(handlers, { root, platform });
  return (
    <div ref={root}>
      <div role="grid" aria-label="Task sheet" tabIndex={0} />
      <input aria-label="Task Name" />
      <div className="pln-editor"><div role="combobox" tabIndex={0} aria-label="Mode" /></div>
      <button type="button">Indent</button>
      {open && <ColumnsModal onClose={() => setOpen(false)} />}
    </div>
  );
}

const key = (init: Partial<ShortcutKey>): ShortcutKey => ({
  key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init,
});

describe('matchPlanShortcut', () => {
  const cases: [Partial<ShortcutKey>, 'win' | 'mac', PlanShortcutId | null][] = [
    [{ key: 'Insert' }, 'win', 'insert'],
    [{ key: 'Help' }, 'mac', 'insert'],
    [{ key: 'Delete' }, 'win', 'delete'],
    [{ key: 'Backspace' }, 'mac', null],                     // the sheet's own
    [{ key: 'ArrowRight', altKey: true, shiftKey: true }, 'win', 'indent'],
    [{ key: 'ArrowLeft', altKey: true, shiftKey: true }, 'mac', 'outdent'],
    [{ key: 'ArrowRight', altKey: true }, 'win', null],
    [{ key: 'F2', ctrlKey: true }, 'win', 'link'],
    [{ key: 'F2', metaKey: true, shiftKey: true }, 'mac', 'unlink'],
    [{ key: 'F2', shiftKey: true }, 'win', 'info'],
    [{ key: 'z', ctrlKey: true }, 'win', 'undo'],
    [{ key: 'z', ctrlKey: true }, 'mac', null],               // ⌘ on a Mac
    [{ key: 'z', metaKey: true }, 'mac', 'undo'],
    [{ key: 'y', ctrlKey: true }, 'win', 'redo'],
    [{ key: 'Z', ctrlKey: true, shiftKey: true }, 'win', 'redo'],
    [{ key: 'F5', ctrlKey: true, shiftKey: true }, 'win', 'scrollToTask'],
    [{ key: 'F5', ctrlKey: true }, 'win', null],              // the browser's reload
    // ⌥⇧− types an em dash on a Mac: the physical key counts
    [{ key: '—', code: 'Minus', altKey: true, shiftKey: true }, 'mac', 'collapse'],
    [{ key: '+', code: 'Equal', altKey: true, shiftKey: true }, 'win', 'expand'],
    [{ key: 'f', ctrlKey: true }, 'win', 'find'],
    [{ key: '?', shiftKey: true }, 'win', 'help'],
    [{ key: 'c', metaKey: true }, 'mac', 'copy'],
    [{ key: 'x', ctrlKey: true }, 'win', 'cut'],
    [{ key: 'v', ctrlKey: true }, 'win', 'paste'],
    [{ key: 'a' }, 'win', null],
  ];
  it.each(cases)('%o on %s is %s', (init, platform, id) => {
    expect(matchPlanShortcut(key(init), platform)).toBe(id);
  });
});

describe('usePlanShortcuts', () => {
  it('Alt+Shift+→ on the sheet indents, and the key goes no further', () => {
    const indent = vi.fn();
    render(<Harness handlers={{ indent }} />);
    const grid = screen.getByRole('grid');
    grid.focus();
    const after = vi.fn();
    grid.addEventListener('keydown', after);
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    grid.dispatchEvent(e);
    expect(indent).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(after).not.toHaveBeenCalled();
  });

  it('the same key with focus in an input does nothing (it types there)', () => {
    const indent = vi.fn();
    render(<Harness handlers={{ indent }} />);
    const input = screen.getByRole('textbox', { name: 'Task Name' });
    input.focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(indent).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('Delete and Insert inside a cell editor do nothing', () => {
    const del = vi.fn();
    const insert = vi.fn();
    render(<Harness handlers={{ delete: del, insert }} />);
    const box = screen.getByRole('combobox', { name: 'Mode' });
    fireEvent.keyDown(box, { key: 'Delete' });
    fireEvent.keyDown(box, { key: 'Insert' });
    expect(del).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('Delete with the Columns dialog open does nothing', () => {
    const del = vi.fn();
    render(<Harness handlers={{ delete: del }} columns />);
    expect(document.querySelector('.modal-scrim')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' });
    expect(del).not.toHaveBeenCalled();
  });

  it('a key that is part of an IME composition is never a shortcut', () => {
    const insert = vi.fn();
    render(<Harness handlers={{ insert }} />);
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Insert', isComposing: true });
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Insert', keyCode: 229 });
    expect(insert).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Insert' });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('⌘ is Ctrl on a Mac', () => {
    const undo = vi.fn();
    render(<Harness handlers={{ undo }} platform="mac" />);
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('copy, cut and paste run but leave the browser its clipboard event', () => {
    const copy = vi.fn();
    render(<Harness handlers={{ copy }} />);
    const e = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByRole('grid').dispatchEvent(e);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('a handler that declines (Ctrl+F before the search box exists) leaves the key to the browser', () => {
    const find = vi.fn(() => false);
    render(<Harness handlers={{ find }} />);
    const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByRole('grid').dispatchEvent(e);
    expect(find).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('on a toolbar button the keyboard map still works', () => {
    const undo = vi.fn();
    render(<Harness handlers={{ undo }} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Indent' }), { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
