// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import doc from './zebra-ds22.json';
import WikiDoc, { type DocNode } from './WikiDoc';

afterEach(cleanup);

function images(n: DocNode, out: DocNode[] = []): DocNode[] {
  if (n.type === 'wikiImage') out.push(n);
  n.content?.forEach((c) => images(c, out));
  return out;
}

it('renders the shipped doc with its appendix heading', () => {
  render(<WikiDoc doc={doc as DocNode} />);
  expect(screen.getByRole('heading', { name: 'Appendix: programming barcodes' })).toBeTruthy();
});

it('renders each barcode image in a wiki-barcode figure at its width', () => {
  const { container } = render(<WikiDoc doc={doc as DocNode} />);
  const expected = images(doc as DocNode);
  expect(expected).toHaveLength(5);
  const imgs = Array.from(container.querySelectorAll('img'));
  expect(imgs).toHaveLength(5);
  imgs.forEach((img, i) => {
    const attrs = expected[i].attrs as { alt: string; width: number; caption?: string };
    expect(img.getAttribute('alt')).toBe(attrs.alt);
    expect(img.closest('.wiki-barcode')).not.toBeNull();
    expect(img.style.width).toBe(`${attrs.width}px`);
    expect(img.getAttribute('src')).toBeTruthy();
  });
});

it('renders bold text in strong', () => {
  const { container } = render(<WikiDoc doc={doc as DocNode} />);
  expect(container.querySelector('strong')).not.toBeNull();
});

it('renders callouts, lists and tables', () => {
  const { container } = render(<WikiDoc doc={doc as DocNode} />);
  expect(container.querySelector('table th')).not.toBeNull();
  expect(container.querySelector('.portal-banner')).not.toBeNull();
  expect(container.querySelector('ul li, ol li')).not.toBeNull();
});

it('skips unknown nodes without throwing', () => {
  const { container } = render(
    <WikiDoc doc={{ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      { type: 'mystery', content: [{ type: 'text', text: 'hidden words' }] },
    ] }}
    />,
  );
  expect(container.textContent).toContain('kept');
  expect(container.textContent).not.toContain('hidden words');
});
