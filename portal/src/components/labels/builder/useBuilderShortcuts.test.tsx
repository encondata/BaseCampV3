// @vitest-environment jsdom
/**
 * useBuilderShortcuts: the builder's keyboard, on `document` in the capture
 * phase so it runs before the Topbar's own `/` handler and the browser's
 * ⌘S / ⌘P / ⌘R.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBuilderShortcuts, type ShortcutHandlers } from './useBuilderShortcuts';

function Harness({ handlers, enabled }: { handlers: ShortcutHandlers; enabled?: boolean }) {
  useBuilderShortcuts(handlers, { platform: 'mac', enabled });
  return (
    <div>
      <input aria-label="Name" />
      <button type="button">Save</button>
    </div>
  );
}

afterEach(cleanup);

describe('useBuilderShortcuts', () => {
  it('runs the matching handler and prevents the browser default', () => {
    const save = vi.fn();
    const rulers = vi.fn();
    render(<Harness handlers={{ 'workflow.save': save, 'canvas.rulers': rulers }} />);
    const ok = fireEvent.keyDown(document.body, { key: 's', code: 'KeyS', metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);   // defaultPrevented
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', metaKey: true });
    expect(rulers).toHaveBeenCalledTimes(1);
  });

  it('leaves a key with no handler alone', () => {
    render(<Harness handlers={{ 'workflow.save': vi.fn() }} />);
    expect(fireEvent.keyDown(document.body, { key: 'p', code: 'KeyP', metaKey: true })).toBe(true);
  });

  it('skips canvas shortcuts while typing, but not save', () => {
    const nudge = vi.fn();
    const save = vi.fn();
    const { getByLabelText } = render(<Harness handlers={{ 'move.right': nudge, 'workflow.save': save }} />);
    const input = getByLabelText('Name');
    expect(fireEvent.keyDown(input, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(true);
    expect(nudge).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 's', code: 'KeyS', metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('takes `/` before a document listener in the bubble phase (the Topbar)', () => {
    const topbar = vi.fn();
    document.addEventListener('keydown', topbar);
    const search = vi.fn();
    render(<Harness handlers={{ 'workflow.fieldSearch': search }} />);
    const ok = fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    document.removeEventListener('keydown', topbar);
    expect(search).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    expect(topbar).not.toHaveBeenCalled();
  });

  it('lets Escape reach the Topbar too (it closes popovers)', () => {
    const topbar = vi.fn();
    document.addEventListener('keydown', topbar);
    const escape = vi.fn();
    render(<Harness handlers={{ 'tool.escape': escape }} />);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    document.removeEventListener('keydown', topbar);
    expect(escape).toHaveBeenCalledTimes(1);
    expect(topbar).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter and Tab to a focused button', () => {
    const content = vi.fn();
    const next = vi.fn();
    const { getByText } = render(<Harness handlers={{ 'edit.content': content, 'select.next': next }} />);
    const button = getByText('Save');
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(button, { key: 'Tab', code: 'Tab' });
    expect(content).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('a widget that runs its own keys', () => {
    function Widgets({ handlers }: { handlers: ShortcutHandlers }) {
      useBuilderShortcuts(handlers, { platform: 'mac' });
      return (
        <div>
          <div role="listbox" tabIndex={-1} aria-label="Fonts"><div role="option" aria-selected="false">Roboto</div></div>
          <div role="menu" aria-label="Add"><button type="button" role="menuitem">Box</button></div>
          <button type="button" aria-haspopup="listbox">Font</button>
          <div data-builder-keys="own" tabIndex={0} aria-label="Fields on this label">
            <button type="button" aria-pressed="false">Bold</button>
          </div>
        </div>
      );
    }

    function setup() {
      const h = {
        nudge: vi.fn(), next: vi.fn(), remove: vi.fn(), tool: vi.fn(), escape: vi.fn(), search: vi.fn(), undo: vi.fn(),
      };
      const handlers: ShortcutHandlers = {
        'move.down': h.nudge, 'select.next': h.next, 'edit.delete': h.remove, 'tool.text': h.tool,
        'tool.escape': h.escape, 'workflow.fieldSearch': h.search, 'edit.undo': h.undo,
      };
      const utils = render(<Widgets handlers={handlers} />);
      const lists = [utils.getByLabelText('Fonts'), utils.getByText('Roboto'), utils.getByText('Box')];
      const others = [utils.getByText('Font'), utils.getByLabelText('Fields on this label'), utils.getByText('Bold')];
      return { h, lists, others };
    }

    it('keeps arrows and Tab; in an open list also letters and Escape', () => {
      const { h, lists, others } = setup();
      for (const target of [...lists, ...others]) {
        expect(fireEvent.keyDown(target, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);
      }
      fireEvent.keyDown(others[1], { key: 'Tab', code: 'Tab' });
      for (const target of lists) {
        fireEvent.keyDown(target, { key: 't', code: 'KeyT' });
        fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
      }
      expect(h.nudge).not.toHaveBeenCalled();
      expect(h.next).not.toHaveBeenCalled();
      expect(h.tool).not.toHaveBeenCalled();
      expect(h.escape).not.toHaveBeenCalled();
      // a trigger or the table leaves the tool letters to the canvas
      for (const target of others) fireEvent.keyDown(target, { key: 't', code: 'KeyT' });
      expect(h.tool).toHaveBeenCalledTimes(3);
      fireEvent.keyDown(document.body, { key: 'ArrowDown', code: 'ArrowDown' });
      expect(h.nudge).toHaveBeenCalledTimes(1);
    });

    it('never keeps `/`, Delete, ⌘ shortcuts, or Escape outside a list', () => {
      const { h, lists, others } = setup();
      const topbar = vi.fn();
      document.addEventListener('keydown', topbar);
      for (const target of [...lists, ...others]) {
        expect(fireEvent.keyDown(target, { key: '/', code: 'Slash' })).toBe(false);
        fireEvent.keyDown(target, { key: 'Delete', code: 'Delete' });
        fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', metaKey: true });
      }
      document.removeEventListener('keydown', topbar);
      // `/` is the field search, stopped before the Topbar's own
      expect(h.search).toHaveBeenCalledTimes(6);
      expect(topbar).not.toHaveBeenCalled();
      expect(h.remove).toHaveBeenCalledTimes(6);
      expect(h.undo).toHaveBeenCalledTimes(6);
      for (const target of others) fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
      expect(h.escape).toHaveBeenCalledTimes(3);
    });
  });

  it('does not prevent the default when a handler declines', () => {
    render(<Harness handlers={{ 'move.right': () => false }} />);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(true);
  });

  it('a second instance does not run a shortcut the first one handled', () => {
    const a = vi.fn();
    const b = vi.fn();
    function Two() {
      useBuilderShortcuts({ 'select.all': a }, { platform: 'mac' });
      useBuilderShortcuts({ 'select.all': b }, { platform: 'mac' });
      return null;
    }
    render(<Two />);
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA', metaKey: true });
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it('listens only while enabled, and stops on unmount', () => {
    const save = vi.fn();
    const { rerender, unmount } = render(<Harness handlers={{ 'workflow.save': save }} enabled={false} />);
    fireEvent.keyDown(document.body, { key: 's', code: 'KeyS', metaKey: true });
    expect(save).not.toHaveBeenCalled();
    rerender(<Harness handlers={{ 'workflow.save': save }} enabled />);
    fireEvent.keyDown(document.body, { key: 's', code: 'KeyS', metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document.body, { key: 's', code: 'KeyS', metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('calls the latest handler after a re-render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness handlers={{ 'select.all': first }} />);
    rerender(<Harness handlers={{ 'select.all': second }} />);
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA', metaKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
