import { describe, expect, it } from 'vitest';

import { SHORTCUTS, canonical, detectPlatform, matchShortcut, type KeyLike, type Platform } from './shortcuts';

function key(k: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

function matched(e: KeyLike, platform: Platform = 'mac'): string | null {
  return matchShortcut(e, platform)?.id ?? null;
}

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

// every binding of spec §5, with `/` for field search in place of ⌘K
const SPEC = [
  'V', 'T', 'K', 'Q', 'R', 'L', 'Escape',
  ...ARROWS, ...ARROWS.map((a) => `Shift+${a}`), ...ARROWS.map((a) => `Alt+${a}`),
  ...ARROWS.map((a) => `Shift+Alt+${a}`),
  'Shift+Drag', 'Shift+Resize', 'Alt+Drag',
  'Mod+Z', 'Mod+Shift+Z', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+D', 'Delete', 'Mod+A', 'Tab', 'Shift+Tab',
  'Enter', 'Mod+[', 'Mod+]', 'Mod+Shift+[', 'Mod+Shift+]', 'Mod+L',
  'Mod+B', 'Mod+Shift+I',
  'Alt+A', 'Alt+D', 'Alt+W', 'Alt+S', 'Alt+H', 'Alt+V', 'Shift+Alt+H', 'Shift+Alt+V',
  'Mod+=', 'Mod+-', 'Mod+0', 'Mod+1', 'Space+Drag', "Mod+'", "Mod+Shift+'", 'Mod+R', 'Mod+E',
  'Mod+S', 'Mod+P', '/', 'Mod+/',
];

describe('SHORTCUTS', () => {
  const combos = SHORTCUTS.flatMap((s) => s.keys.map(canonical));

  it('lists every binding of spec §5', () => {
    for (const combo of SPEC) expect(combos, combo).toContain(canonical(combo));
  });

  it('never gives two shortcuts the same keys, or two shortcuts the same id', () => {
    expect(new Set(combos).size).toBe(combos.length);
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves ⌘K to the command palette and ⌘\\ to the sidebar', () => {
    expect(combos).not.toContain(canonical('Mod+K'));
    expect(combos).not.toContain(canonical('Mod+\\'));
    expect(matched(key('k', 'KeyK', { metaKey: true }), 'mac')).toBeNull();
    expect(matched(key('k', 'KeyK', { ctrlKey: true }), 'win')).toBeNull();
    expect(matched(key('\\', 'Backslash', { metaKey: true }), 'mac')).toBeNull();
  });

  it('shows ⌘ on a Mac and Ctrl elsewhere', () => {
    const byId = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
    expect(byId('edit.redo')).toMatchObject({ mac: '⌘⇧Z', win: 'Ctrl+Shift+Z' });
    expect(byId('align.distributeH')).toMatchObject({ mac: '⇧⌥H', win: 'Shift+Alt+H' });
    expect(byId('workflow.fieldSearch')).toMatchObject({ mac: '/', win: '/', when: 'canvas' });
    expect(byId('workflow.save')).toMatchObject({ mac: '⌘S', win: 'Ctrl+S', when: 'always' });
    expect(byId('canvas.pan')).toMatchObject({ mac: 'Space-drag', win: 'Space-drag', pointer: true });
    expect(byId('move.axisLock')).toMatchObject({ mac: '⇧-drag', win: 'Shift-drag' });
  });
});

describe('matchShortcut', () => {
  it('uses ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(matched(key('z', 'KeyZ', { metaKey: true }), 'mac')).toBe('edit.undo');
    expect(matched(key('z', 'KeyZ', { ctrlKey: true }), 'mac')).toBeNull();
    expect(matched(key('z', 'KeyZ', { ctrlKey: true }), 'win')).toBe('edit.undo');
    expect(matched(key('z', 'KeyZ', { metaKey: true }), 'win')).toBeNull();
    expect(matched(key('Z', 'KeyZ', { metaKey: true, shiftKey: true }))).toBe('edit.redo');
  });

  it('needs the exact modifiers', () => {
    expect(matched(key('v', 'KeyV'))).toBe('tool.select');
    expect(matched(key('V', 'KeyV'))).toBe('tool.select');          // Caps Lock
    expect(matched(key('V', 'KeyV', { shiftKey: true }))).toBeNull();
    expect(matched(key('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
  });

  it('reads the physical key when Shift or ⌥ changes the character', () => {
    expect(matched(key('{', 'BracketLeft', { metaKey: true, shiftKey: true }))).toBe('arrange.toBack');
    expect(matched(key('}', 'BracketRight', { metaKey: true, shiftKey: true }))).toBe('arrange.toFront');
    expect(matched(key('"', 'Quote', { metaKey: true, shiftKey: true }))).toBe('canvas.snap');
    expect(matched(key('å', 'KeyA', { altKey: true }))).toBe('align.left');
    expect(matched(key('Ó', 'KeyH', { altKey: true, shiftKey: true }))).toBe('align.distributeH');
  });

  it('prefers the character typed over the physical key', () => {
    // an AZERTY Z sits where QWERTY has W
    expect(matched(key('z', 'KeyW', { metaKey: true }))).toBe('edit.undo');
  });

  it('matches arrows, Delete on either key, Tab, Enter and the field search', () => {
    expect(matched(key('ArrowLeft', 'ArrowLeft'))).toBe('move.left');
    expect(matched(key('ArrowDown', 'ArrowDown', { shiftKey: true }))).toBe('move.down10');
    expect(matched(key('ArrowRight', 'ArrowRight', { altKey: true }))).toBe('size.wider');
    expect(matched(key('ArrowLeft', 'ArrowLeft', { altKey: true, shiftKey: true }))).toBe('size.narrower10');
    expect(matched(key('Backspace', 'Backspace'))).toBe('edit.delete');
    expect(matched(key('Delete', 'Delete'))).toBe('edit.delete');
    expect(matched(key('Tab', 'Tab', { shiftKey: true }))).toBe('select.previous');
    expect(matched(key('Enter', 'Enter'))).toBe('edit.content');
    expect(matched(key('Escape', 'Escape'))).toBe('tool.escape');
    expect(matched(key('/', 'Slash'))).toBe('workflow.fieldSearch');
    expect(matched(key('/', 'Slash', { ctrlKey: true }), 'win')).toBe('workflow.shortcutSheet');
  });

  it('never matches a pointer gesture from the keyboard', () => {
    expect(matched(key(' ', 'Space'))).toBeNull();
  });
});

describe('detectPlatform', () => {
  it('reads the navigator', () => {
    expect(detectPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('mac');
    expect(detectPlatform({ platform: '', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32', userAgent: 'Windows NT' })).toBe('win');
    expect(detectPlatform(null)).toBe('win');
  });
});
