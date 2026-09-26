/** A document that exercises every node and mark in the shared schema,
 *  written the way the editor stores it (every attribute present). The
 *  schema tests round-trip it through HTML, and the wiki server's render
 *  test asserts it renders identically on both sides. */
import type { JSONContent } from '@tiptap/core';

export const FIXTURE_IMAGE_ASSET = '0f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
export const FIXTURE_FILE_NODE = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const FIXTURE_PAGE_NODE = 'b7c8d9e0-f1a2-4b3c-9d4e-5f6a7b8c9d0e';

const LINK_ATTRS = { target: '_blank', rel: 'noopener noreferrer nofollow', class: null };

const text = (value: string, marks?: JSONContent['marks']): JSONContent =>
  (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });

const para = (...content: JSONContent[]): JSONContent =>
  ({ type: 'paragraph', attrs: { textAlign: null }, content });

const cell = (type: 'tableHeader' | 'tableCell', value: string): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: null },
  content: [para(text(value))],
});

export const fixtureDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { textAlign: null, level: 2 },
      content: [text('Rack power runbook')],
    },
    para(
      text('Check the '),
      text('breaker', [{ type: 'bold' }]),
      text(', the '),
      text('label', [{ type: 'italic' }, { type: 'underline' }]),
      text(' and '),
      text('the vendor guide', [
        { type: 'link', attrs: { href: 'https://example.com/guide', ...LINK_ATTRS } },
      ]),
      text('. '),
      text('Critical', [{ type: 'highlight' }]),
      text(' H'),
      text('2', [{ type: 'subscript' }]),
      text('O, 10'),
      text('3', [{ type: 'superscript' }]),
      text(' '),
      text('ls -la', [{ type: 'code' }]),
    ),
    {
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [
        text('See '),
        { type: 'pageLink', attrs: { nodeId: FIXTURE_PAGE_NODE, title: 'Cabling standards' } },
        text(' or '),
        text('the checklist', [
          { type: 'link', attrs: { href: `/n/${FIXTURE_PAGE_NODE}`, ...LINK_ATTRS } },
        ]),
        text('.'),
      ],
    },
    {
      type: 'callout',
      attrs: { variant: 'warning' },
      content: [para(text('Never hot-swap the PDU.'))],
    },
    {
      type: 'wikiImage',
      attrs: {
        assetId: FIXTURE_IMAGE_ASSET,
        alt: 'Rack front view',
        caption: 'Rack 12, front',
        width: 480,
      },
    },
    {
      type: 'fileEmbed',
      attrs: {
        nodeId: FIXTURE_FILE_NODE,
        assetId: null,
        filename: 'pdu-manual.pdf',
        contentType: 'application/pdf',
      },
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('Power off'))] },
        { type: 'listItem', content: [para(text('Unplug'))] },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 1, type: null },
      content: [{ type: 'listItem', content: [para(text('Label the cables'))] }],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para(text('Photos taken'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [para(text('Ticket closed'))] },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Port'), cell('tableHeader', 'Device')] },
        { type: 'tableRow', content: [cell('tableCell', 'A1'), cell('tableCell', 'Core switch')] },
      ],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'bash' },
      content: [text('ipmitool power status')],
    },
    { type: 'blockquote', content: [para(text('Measure twice.'))] },
    { type: 'horizontalRule' },
    para(text('Line one'), { type: 'hardBreak' }, text('line two', [{ type: 'strike' }])),
  ],
};
