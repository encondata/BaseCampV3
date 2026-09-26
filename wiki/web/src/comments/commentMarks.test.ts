// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wikiExtensions } from '../editor/schema';
import type { CommentThread } from '../lib/types';
import {
  captureSelection, resolveCapture, threadAnchors, useCommentMarks,
} from './commentMarks';

const mark = (threadId: string) => ({ type: 'commentThread', attrs: { threadId } });
const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Check the ' },
      { type: 'text', text: 'spare ', marks: [mark('b')] },
      { type: 'text', text: 'PDU', marks: [mark('b'), mark('a')] },
      { type: 'text', text: ' stock.', marks: [mark('a')] },
    ] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'Then ' },
      { type: 'text', text: 'call it in', marks: [mark('r')] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'wait', marks: [mark('b')] },
    ] },
  ],
};

let editor: Editor;
beforeEach(() => {
  document.body.replaceChildren();
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions: wikiExtensions(), content: DOC });
});
afterEach(() => { cleanup(); editor.destroy(); });

function thread(id: string, resolved = false): CommentThread {
  return { thread_id: id, anchor: true, resolved_at: resolved ? '2026-09-22T00:00:00Z' : null,
    resolved_by: null, comments: [] };
}

/** Each decorated run: its text and its classes (beyond the base one). */
const decorated = () => Array.from(editor.view.dom.querySelectorAll('.wiki-comment-anchor'))
  .map((el) => [el.textContent, [...el.classList].filter((c) => c !== 'wiki-comment-anchor').sort().join(' ')]);

describe('threadAnchors', () => {
  it('finds each thread\'s first position and its text, in document order', () => {
    const anchors = threadAnchors(editor.state.doc);
    expect([...anchors.keys()]).toEqual(['b', 'a', 'r']);
    expect(anchors.get('b')).toEqual({ pos: 11, text: 'spare PDU wait' });
    expect(anchors.get('a')?.text).toBe('PDU stock.');
    expect(anchors.get('a')!.pos).toBeGreaterThan(anchors.get('b')!.pos);
  });
});

describe('useCommentMarks', () => {
  it('reads the anchors and marks the active, resolved and stale threads without touching the document', () => {
    const before = JSON.stringify(editor.getJSON());
    const onMarkClick = vi.fn();
    const { result, rerender } = renderHook(({ active, threads }) => useCommentMarks(editor, {
      active, threads, onMarkClick,
    }), { initialProps: { active: null as string | null, threads: null as CommentThread[] | null } });
    expect([...(result.current ?? new Map()).keys()]).toEqual(['b', 'a', 'r']);
    expect(editor.view.dom.classList.contains('wiki-comment-marks')).toBe(true);
    // before the threads load, every run is plain
    expect(decorated().every(([, cls]) => cls === '')).toBe(true);

    // 'b' is gone (deleted), 'r' is resolved, 'a' is open and active
    rerender({ active: 'a', threads: [thread('a'), thread('r', true)] });
    expect(decorated()).toEqual([
      ['spare ', 'is-stale'],
      ['PDU', 'is-active'],
      [' stock.', 'is-active'],
      ['call it in', 'is-resolved'],
      ['wait', 'is-stale'],
    ]);
    expect(JSON.stringify(editor.getJSON())).toBe(before);

    // clicking marked text names its threads, innermost first
    const pdu = [...editor.view.dom.querySelectorAll('.wiki-comment-anchor')][1] as HTMLElement;
    pdu.click();
    expect(onMarkClick).toHaveBeenCalledWith(['a', 'b']);
  });

  it('follows the document as it changes', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCommentMarks(editor, { active: null, threads: [], onMarkClick: () => {} }));
      expect(result.current?.has('r')).toBe(true);
      act(() => { editor.commands.unsetCommentThread('r'); });
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(result.current?.has('r')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes its highlights when unmounted', () => {
    const { unmount } = renderHook(() => useCommentMarks(editor, { active: 'a', threads: [thread('a')], onMarkClick: () => {} }));
    expect(decorated().length).toBeGreaterThan(0);
    unmount();
    expect(decorated()).toEqual([]);
    expect(editor.view.dom.classList.contains('wiki-comment-marks')).toBe(false);
  });
});

describe('capturing a selection to comment on', () => {
  it('keeps the range while the text is there, and gives it up once it changed', () => {
    editor.commands.setTextSelection({ from: 1, to: 6 });     // "Check"
    const captured = captureSelection(editor)!;
    expect(captured.text).toBe('Check');
    expect(resolveCapture(editor, captured)).toEqual({ from: 1, to: 6 });
    editor.commands.insertContentAt(1, 'Re');
    expect(resolveCapture(editor, captured)).toBeNull();
  });

  it('needs selected text', () => {
    editor.commands.setTextSelection(3);
    expect(captureSelection(editor)).toBeNull();
  });
});
