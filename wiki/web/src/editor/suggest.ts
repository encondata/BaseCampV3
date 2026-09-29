/** What the typed-trigger menus (the "/" slash menu, the "[[" page picker,
 *  the "@" mention picker) share: finding the trigger text before the cursor, following it as the
 *  editor changes (with Escape dismissing it for that spot), and taking
 *  the arrow/Enter/Escape keys from the editor while a menu is open. */
import type { Editor, Range } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Trigger extends Range {
  /** The text typed after the trigger characters. */
  query: string;
}

const LEAF = '￼';

/** "/" + an optional query as the whole of the current block. */
export const SLASH_PATTERN = /^\/([^\n/￼]{0,32})$/;
/** "[[" + an optional query ending at the cursor, anywhere in a block. */
export const PAGE_LINK_PATTERN = /\[\[([^[\]\n￼]{0,80})$/;
/** "@" at the start of a block or after a space (not inside a word, so an
 *  email address doesn't open it) + an optional name of up to two words
 *  ending at the cursor. The lookbehind keeps the space out of the range. */
export const MENTION_PATTERN = /(?<=^|[\s￼])@((?:[^\s@￼]{1,40}(?: [^\s@￼]{0,40})?)?)$/;

export function findTrigger(
  state: EditorState, pattern: RegExp, opts: { wholeBlock?: boolean } = {},
): Trigger | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if (opts.wholeBlock && $from.parentOffset !== parent.content.size) return null;
  const before = parent.textBetween(0, $from.parentOffset, undefined, LEAF);
  const match = pattern.exec(before);
  if (!match) return null;
  return { from: $from.pos - match[0].length, to: $from.pos, query: match[1] ?? '' };
}

function sameTrigger(a: Trigger | null, b: Trigger | null): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to && a.query === b.query);
}

/** The trigger under the cursor, re-read on every editor change. Escape
 *  (`dismiss`) hides it until the trigger goes away, and so does leaving
 *  the editor. */
export function useTrigger(
  editor: Editor | null, find: (state: EditorState) => Trigger | null,
): [Trigger | null, () => void] {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const dismissedAt = useRef<number | null>(null);
  const shown = useRef<Trigger | null>(null);
  const findRef = useRef(find);
  findRef.current = find;

  useEffect(() => {
    if (!editor) return undefined;
    const update = () => {
      const found = editor.isDestroyed ? null : findRef.current(editor.state);
      if (!found) dismissedAt.current = null;
      const next = found && found.from !== dismissedAt.current ? found : null;
      // most transactions (other people typing elsewhere) leave it as it
      // was: don't even queue a state update for those
      if (sameTrigger(shown.current, next)) return;
      shown.current = next;
      setTrigger(next);
    };
    const onBlur = () => {
      const found = findRef.current(editor.state);
      if (found) dismissedAt.current = found.from;
      shown.current = null;
      setTrigger(null);
    };
    update();
    editor.on('transaction', update);
    editor.on('blur', onBlur);
    return () => {
      editor.off('transaction', update);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  const dismiss = useCallback(() => {
    if (shown.current) dismissedAt.current = shown.current.from;
    shown.current = null;
    setTrigger(null);
  }, []);

  return [trigger, dismiss];
}

let keySeq = 0;

/** While `active`, the editor hands its key presses to `onKey` first; a
 *  `true` answer means the menu took the key. */
export function useMenuKeys(
  editor: Editor | null, active: boolean, onKey: (event: KeyboardEvent) => boolean,
): void {
  const handler = useRef(onKey);
  handler.current = onKey;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    keySeq += 1;
    const key = new PluginKey(`wikiMenuKeys${keySeq}`);
    // first in line, ahead of the keymaps (Enter would split the block)
    editor.registerPlugin(new Plugin({
      key,
      props: {
        handleKeyDown: (_view, event) => activeRef.current && handler.current(event),
      },
    }), (plugin, plugins) => [plugin, ...plugins]);
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor]);
}

/** Where a menu opened at document position `pos` goes: fixed, below the
 *  text (or above it when the viewport runs out). */
export function menuPosition(editor: Editor, pos: number, height = 340): { top: number; left: number } {
  let rect = { left: 0, top: 0, bottom: 0 };
  try {
    rect = editor.view.coordsAtPos(pos);
  } catch {
    /* not laid out (tests) */
  }
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const below = rect.bottom + 6;
  const top = below + height > vh && rect.top - height - 6 > 0 ? rect.top - height - 6 : below;
  return { top, left: Math.max(8, Math.min(rect.left, vw - 328)) };
}

/** Wraps `index + step` around `count` items. */
export function cycle(index: number, step: number, count: number): number {
  if (count === 0) return 0;
  return (index + step + count) % count;
}
