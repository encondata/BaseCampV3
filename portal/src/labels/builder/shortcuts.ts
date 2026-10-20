/**
 * The builder's keyboard shortcuts: every binding of spec §5, with `/` for
 * the field search and ⇧0 for true size (the browser keeps ⌘1 for its first
 * tab). ⌘K stays the portal's command palette and ⌘\ the sidebar toggle,
 * so neither is bound here. "Mod" is ⌘ on a Mac and Ctrl everywhere else.
 *
 * A binding is written `Mod+Shift+Alt+Key` (any of the modifiers, the key
 * last). Pointer gestures (⇧-drag, ⌥-drag, Space-drag, ⇧-resize) are listed
 * for the shortcut sheet but never match a key press; the canvas reads
 * them from the pointer events.
 */

export type Platform = 'mac' | 'win';

export interface Shortcut {
  id: string;
  /** One or more bindings, any of which triggers the shortcut. */
  keys: string[];
  /** The bindings as a Mac shows them (`⌘⇧Z`). */
  mac: string;
  /** The bindings as Windows and Linux show them (`Ctrl+Shift+Z`). */
  win: string;
  label: string;
  group: 'Tools' | 'Move and size' | 'Edit' | 'Format' | 'Align' | 'Canvas' | 'Workflow';
  /** `always`: also while typing in a box (save, test print, the sheet);
   *  `canvas`: only when focus is not in a text box. */
  when: 'canvas' | 'always';
  /** A pointer gesture: listed, never matched from the keyboard. */
  pointer?: true;
}

/** What matchShortcut reads from a KeyboardEvent. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

type Def = Omit<Shortcut, 'mac' | 'win' | 'when'> & { when?: Shortcut['when'] };

const MODIFIERS = ['Mod', 'Shift', 'Alt'] as const;

const ARROWS = [
  ['Left', 'ArrowLeft', 'left'], ['Right', 'ArrowRight', 'right'],
  ['Up', 'ArrowUp', 'up'], ['Down', 'ArrowDown', 'down'],
] as const;

const SIZES = [
  ['wider', 'ArrowRight', 'Make wider'], ['narrower', 'ArrowLeft', 'Make narrower'],
  ['taller', 'ArrowDown', 'Make taller'], ['shorter', 'ArrowUp', 'Make shorter'],
] as const;

const DEFS: Def[] = [
  // Tools
  { id: 'tool.select', keys: ['V'], label: 'Select', group: 'Tools' },
  { id: 'tool.text', keys: ['T'], label: 'Text', group: 'Tools' },
  { id: 'tool.barcode', keys: ['K'], label: 'Barcode', group: 'Tools' },
  { id: 'tool.qr', keys: ['Q'], label: 'QR code', group: 'Tools' },
  { id: 'tool.box', keys: ['R'], label: 'Box', group: 'Tools' },
  { id: 'tool.line', keys: ['L'], label: 'Line', group: 'Tools' },
  { id: 'tool.escape', keys: ['Escape'], label: 'Back to select', group: 'Tools' },
  // Move and size
  ...ARROWS.map(([, key, dir]): Def => (
    { id: `move.${dir}`, keys: [key], label: `Move ${dir} 1 dot`, group: 'Move and size' })),
  ...ARROWS.map(([, key, dir]): Def => (
    { id: `move.${dir}10`, keys: [`Shift+${key}`], label: `Move ${dir} 10 dots`, group: 'Move and size' })),
  ...SIZES.map(([name, key, label]): Def => (
    { id: `size.${name}`, keys: [`Alt+${key}`], label: `${label} by 1 dot`, group: 'Move and size' })),
  ...SIZES.map(([name, key, label]): Def => (
    { id: `size.${name}10`, keys: [`Shift+Alt+${key}`], label: `${label} by 10 dots`, group: 'Move and size' })),
  { id: 'move.axisLock', keys: ['Shift+Drag'], label: 'Drag along one axis', group: 'Move and size', pointer: true },
  { id: 'resize.keepRatio', keys: ['Shift+Resize'], label: 'Resize keeping proportions', group: 'Move and size', pointer: true },
  { id: 'move.duplicate', keys: ['Alt+Drag'], label: 'Drag a copy', group: 'Move and size', pointer: true },
  // Edit
  { id: 'edit.undo', keys: ['Mod+Z'], label: 'Undo', group: 'Edit' },
  { id: 'edit.redo', keys: ['Mod+Shift+Z'], label: 'Redo', group: 'Edit' },
  { id: 'edit.copy', keys: ['Mod+C'], label: 'Copy', group: 'Edit' },
  { id: 'edit.paste', keys: ['Mod+V'], label: 'Paste', group: 'Edit' },
  { id: 'edit.cut', keys: ['Mod+X'], label: 'Cut', group: 'Edit' },
  { id: 'edit.duplicate', keys: ['Mod+D'], label: 'Duplicate', group: 'Edit' },
  // a Mac's delete key is Backspace
  { id: 'edit.delete', keys: ['Delete', 'Backspace'], label: 'Delete', group: 'Edit' },
  { id: 'select.all', keys: ['Mod+A'], label: 'Select all', group: 'Edit' },
  { id: 'select.next', keys: ['Tab'], label: 'Next element', group: 'Edit' },
  { id: 'select.previous', keys: ['Shift+Tab'], label: 'Previous element', group: 'Edit' },
  { id: 'edit.content', keys: ['Enter'], label: 'Edit the text', group: 'Edit' },
  { id: 'arrange.back', keys: ['Mod+['], label: 'Send backward', group: 'Edit' },
  { id: 'arrange.forward', keys: ['Mod+]'], label: 'Bring forward', group: 'Edit' },
  { id: 'arrange.toBack', keys: ['Mod+Shift+['], label: 'Send to back', group: 'Edit' },
  { id: 'arrange.toFront', keys: ['Mod+Shift+]'], label: 'Bring to front', group: 'Edit' },
  { id: 'edit.lock', keys: ['Mod+L'], label: 'Lock or unlock', group: 'Edit' },
  // Format
  { id: 'format.bold', keys: ['Mod+B'], label: 'Bold', group: 'Format' },
  { id: 'format.inverted', keys: ['Mod+Shift+I'], label: 'Inverted', group: 'Format' },
  // Align
  { id: 'align.left', keys: ['Alt+A'], label: 'Align left edges', group: 'Align' },
  { id: 'align.right', keys: ['Alt+D'], label: 'Align right edges', group: 'Align' },
  { id: 'align.top', keys: ['Alt+W'], label: 'Align top edges', group: 'Align' },
  { id: 'align.bottom', keys: ['Alt+S'], label: 'Align bottom edges', group: 'Align' },
  { id: 'align.center', keys: ['Alt+H'], label: 'Align horizontal centers', group: 'Align' },
  { id: 'align.middle', keys: ['Alt+V'], label: 'Align vertical centers', group: 'Align' },
  { id: 'align.distributeH', keys: ['Shift+Alt+H'], label: 'Distribute horizontally', group: 'Align' },
  { id: 'align.distributeV', keys: ['Shift+Alt+V'], label: 'Distribute vertically', group: 'Align' },
  // Canvas
  { id: 'canvas.zoomIn', keys: ['Mod+='], label: 'Zoom in', group: 'Canvas' },
  { id: 'canvas.zoomOut', keys: ['Mod+-'], label: 'Zoom out', group: 'Canvas' },
  { id: 'canvas.fit', keys: ['Mod+0'], label: 'Zoom to fit', group: 'Canvas' },
  { id: 'canvas.trueSize', keys: ['Shift+0'], label: 'True size (one dot per pixel)', group: 'Canvas' },
  { id: 'canvas.pan', keys: ['Space+Drag'], label: 'Pan', group: 'Canvas', pointer: true },
  { id: 'canvas.grid', keys: ["Mod+'"], label: 'Show or hide the grid', group: 'Canvas' },
  { id: 'canvas.snap', keys: ["Mod+Shift+'"], label: 'Snap to the grid on or off', group: 'Canvas' },
  { id: 'canvas.rulers', keys: ['Mod+R'], label: 'Show or hide the rulers', group: 'Canvas' },
  { id: 'canvas.samples', keys: ['Mod+E'], label: 'Field names / sample values', group: 'Canvas' },
  // Workflow
  { id: 'workflow.save', keys: ['Mod+S'], label: 'Save', group: 'Workflow', when: 'always' },
  { id: 'workflow.testPrint', keys: ['Mod+P'], label: 'Test print', group: 'Workflow', when: 'always' },
  { id: 'workflow.fieldSearch', keys: ['/'], label: 'Search fields', group: 'Workflow' },
  { id: 'workflow.shortcutSheet', keys: ['Mod+/'], label: 'Keyboard shortcuts', group: 'Workflow', when: 'always' },
];

interface Combo {
  mods: Set<string>;
  key: string;
}

function parse(binding: string): Combo {
  const parts = binding.split('+');
  // a binding never ends in "+" (Mod+= is zoom in), so the last part is the key
  const key = parts.pop() as string;
  return { mods: new Set(parts), key };
}

/** A binding with its modifiers in one order (Mod, Shift, Alt), for comparing. */
export function canonical(binding: string): string {
  const { mods, key } = parse(binding);
  const held = [...MODIFIERS.filter((m) => mods.has(m)), ...[...mods].filter((m) => !(MODIFIERS as readonly string[]).includes(m))];
  return [...held, key].join('+');
}

const MAC_MODS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Space: 'Space' };
const WIN_MODS: Record<string, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Space: 'Space' };
const KEY_NAMES: Record<string, [string, string]> = {
  Escape: ['Esc', 'Esc'],
  ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'], ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'],
  Delete: ['⌦', 'Delete'], Backspace: ['⌫', 'Backspace'],
};

function show(binding: string, platform: Platform, pointer: boolean): string {
  const { mods, key } = parse(canonical(binding));
  const held = [...mods].map((m) => (platform === 'mac' ? MAC_MODS : WIN_MODS)[m] ?? m);
  if (pointer) return `${held.join(platform === 'mac' ? '' : '+')}-${key.toLowerCase()}`;
  const name = KEY_NAMES[key]?.[platform === 'mac' ? 0 : 1] ?? key;
  return platform === 'mac' ? [...held, name].join('') : [...held, name].join('+');
}

export const SHORTCUTS: Shortcut[] = DEFS.map((def) => ({
  ...def,
  when: def.when ?? 'canvas',
  mac: def.keys.map((k) => show(k, 'mac', !!def.pointer)).join(' / '),
  win: def.keys.map((k) => show(k, 'win', !!def.pointer)).join(' / '),
}));

/** A shortcut's keys as `platform` shows them ("⌘⇧Z", "Ctrl+Shift+Z"),
 *  or "" for no shortcut: what the toolbars' hover tips show as keycaps. */
export function shortcutKeys(id: string | null, platform: Platform): string {
  const s = id ? SHORTCUTS.find((x) => x.id === id) : undefined;
  return s ? (platform === 'mac' ? s.mac : s.win) : '';
}

// the physical keys the bindings use, for a press whose character Shift or ⌥ changed
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Quote: "'", Equal: '=', Minus: '-', Slash: '/',
  Backslash: '\\', Space: 'Space',
};

function codeKey(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEYS[code] ?? code;
}

function typedKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key.length === 1 ? key.toUpperCase() : key;
}

const MATCHABLE = SHORTCUTS
  .filter((s) => !s.pointer)
  .flatMap((s) => s.keys.map((k) => ({ shortcut: s, combo: parse(k) })));

/** The shortcut a key press triggers on `platform`, or null. Modifiers must
 *  match exactly (Mod is ⌘ on a Mac, Ctrl elsewhere); the key is the
 *  character typed. Only when Shift or ⌥ turned it into something other
 *  than a plain letter or digit (`{`, `å`, `)`) does the physical key
 *  count, so ⌘⇧[ and ⌥A match, and Dvorak's Ctrl+J (QWERTY's C key) is
 *  not Copy. The caller checks `when` against focus. */
export function matchShortcut(e: KeyLike, platform: Platform): Shortcut | null {
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  const other = platform === 'mac' ? e.ctrlKey : e.metaKey;
  if (other) return null;
  const candidates = MATCHABLE.filter(({ combo }) =>
    combo.mods.has('Mod') === mod && combo.mods.has('Shift') === e.shiftKey
    && combo.mods.has('Alt') === e.altKey);
  const typed = typedKey(e.key);
  const hit = candidates.find(({ combo }) => combo.key === typed);
  if (hit || /^[A-Z0-9]$/.test(typed)) return hit?.shortcut ?? null;
  const physical = codeKey(e.code);
  return candidates.find(({ combo }) => combo.key === physical)?.shortcut ?? null;
}

/** 'mac' on a Mac, iPhone or iPad; 'win' for everything else (and with no
 *  navigator, `null`). */
export function detectPlatform(nav: Pick<Navigator, 'platform' | 'userAgent'> | null =
  typeof navigator === 'undefined' ? null : navigator): Platform {
  if (!nav) return 'win';
  return /Mac|iPhone|iPad|iPod/i.test(`${nav.platform} ${nav.userAgent}`) ? 'mac' : 'win';
}
