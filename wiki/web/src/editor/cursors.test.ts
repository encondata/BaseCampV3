// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { renderCursor, renderSelection, safeColor } from './extensions/cursors';
import { wikiExtensions } from './schema';

const HOSTILE = 'red; background-image: url(https://tracker.example/x.png)';

describe('collaborator cursors', () => {
  it('only lets a plain #rrggbb color through', () => {
    expect(safeColor('#1f6feb')).toBe('#1f6feb');
    expect(safeColor(HOSTILE)).toBe('#667085');
    expect(safeColor('url(x)')).toBe('#667085');
    expect(safeColor(42)).toBe('#667085');
  });

  it('draws a hostile color and name inertly', () => {
    const el = renderCursor({ name: '<img src=x onerror=alert(1)>', color: HOSTILE });
    expect(el.getAttribute('style')).not.toContain('url(');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(renderSelection({ color: HOSTILE }).style).toBe('background-color: #66708540');
  });

  it('is what the shared schema draws cursors with', () => {
    const exts = wikiExtensions({ collab: { doc: new Y.Doc(), provider: { awareness: null } } });
    const cursor = exts.find((e) => e.name === 'collaborationCursor');
    expect(cursor?.options.render).toBe(renderCursor);
    expect(cursor?.options.selectionRender).toBe(renderSelection);
  });
});
