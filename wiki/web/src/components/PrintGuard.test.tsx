// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));

import PrintGuard from './PrintGuard';

afterEach(() => { cleanup(); toast.mockReset(); });

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
};

describe('PrintGuard', () => {
  it('stops Ctrl+P and ⌘P and says why, while active', () => {
    render(<PrintGuard active />);
    expect(press({ key: 'p', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'P', metaKey: true }).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith('Printing is turned off for this page.');
  });

  it('also stops P by its key code, for other layouts and ⌥⌘P', () => {
    render(<PrintGuard active />);
    expect(press({ key: 'з', code: 'KeyP', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: 'π', code: 'KeyP', metaKey: true, altKey: true }).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(press({ key: 'з', code: 'KeyP' }).defaultPrevented).toBe(false);
  });

  it('leaves other keys alone', () => {
    render(<PrintGuard active />);
    expect(press({ key: 'p' }).defaultPrevented).toBe(false);
    expect(press({ key: 's', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does nothing while inactive', () => {
    render(<PrintGuard active={false} />);
    expect(press({ key: 'p', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(document.body.dataset.noPrint).toBeUndefined();
    expect(document.querySelector('.wiki-print-blocked')).toBeNull();
  });

  it('sets body[data-no-print] only while active', () => {
    const { rerender, unmount } = render(<PrintGuard active />);
    expect(document.body.dataset.noPrint).toBe('1');
    rerender(<PrintGuard active={false} />);
    expect(document.body.dataset.noPrint).toBeUndefined();
    rerender(<PrintGuard active />);
    expect(document.body.dataset.noPrint).toBe('1');
    unmount();
    expect(document.body.dataset.noPrint).toBeUndefined();
    expect(press({ key: 'p', ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('puts the print notice directly under <body>', () => {
    render(<div><PrintGuard active /></div>);
    const notice = document.querySelector('.wiki-print-blocked') as HTMLElement;
    expect(notice.parentElement).toBe(document.body);
    expect(notice.textContent).toBe('Printing is turned off for this page.');
  });

  it('shares the flag and the one notice between overlapping guards', () => {
    const one = render(<PrintGuard active />);
    const two = render(<PrintGuard active />);
    expect(document.querySelectorAll('.wiki-print-blocked')).toHaveLength(1);
    // one key press: one toast, however many guards
    expect(press({ key: 'p', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    one.unmount();
    expect(document.body.dataset.noPrint).toBe('1');
    expect(document.querySelectorAll('.wiki-print-blocked')).toHaveLength(1);
    two.unmount();
    expect(document.body.dataset.noPrint).toBeUndefined();
    expect(document.querySelector('.wiki-print-blocked')).toBeNull();
  });
});
