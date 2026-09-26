import { generateHTML } from '@tiptap/html';
import { describe, expect, it } from 'vitest';

import { fixtureDoc } from '../../web/src/editor/fixtures';
import { EMPTY_DOC, wikiExtensions } from '../../web/src/editor/schema';
import { renderDocHtml } from './render';

describe('renderDocHtml', () => {
  // exports must look exactly like the page in the browser
  it('renders the same HTML as the shared schema does in the browser', () => {
    const html = renderDocHtml(fixtureDoc);
    expect(html).toBe(generateHTML(fixtureDoc, wikiExtensions()));
    expect(html).toContain('<div data-callout="warning">');
  });

  it('renders the empty document', () => {
    expect(renderDocHtml(EMPTY_DOC)).toBe('<p></p>');
  });

  it('drops a link the schema does not allow', () => {
    const html = renderDocHtml({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
        }],
      }],
    });
    expect(html).not.toContain('javascript:');
  });

  it.each([null, 'text', 42, [], { type: 'nope' }])('refuses %j', (doc) => {
    expect(() => renderDocHtml(doc)).toThrow();
  });
});
