/** Every block the editor can insert — one list shared by the slash menu
 *  and the toolbar, so they always offer the same things and insert them
 *  the same way. */
import type { ChainedCommands, Editor, Range } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import type { CalloutVariant } from './extensions/Callout';
import type { IconName } from './icons';

/** The pickers a block may need (an image or file upload, a page search). */
export interface BlockActions {
  pickImage: () => void;
  pickFile: () => void;
  pickPage: () => void;
}

export interface BlockItem {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  keywords: string[];
  /** Inserts the block; `range` (the typed "/query") is removed first. */
  run: (editor: Editor, actions: BlockActions, range?: Range) => void;
}

function start(editor: Editor, range?: Range): ChainedCommands {
  const chain = editor.chain().focus();
  return range ? chain.deleteRange(range) : chain;
}

/** Wraps the current block in a callout. */
export function insertCallout(editor: Editor, variant: CalloutVariant = 'info', range?: Range): void {
  start(editor, range).wrapIn('callout', { variant }).run();
}

/** A collapsible section after (or in place of an empty) current block,
 *  with the cursor in its summary. */
export function insertDetails(editor: Editor, range?: Range): void {
  start(editor, range)
    .insertContent({
      type: 'details',
      content: [
        { type: 'detailsSummary' },
        { type: 'detailsContent', content: [{ type: 'paragraph' }] },
      ],
    })
    .command(({ tr }) => {
      const { $from } = tr.selection;
      for (let d = $from.depth; d > 0; d -= 1) {
        if ($from.node(d).type.name === 'details') {
          tr.setSelection(TextSelection.create(tr.doc, $from.before(d) + 2));
          return true;
        }
      }
      return true;
    })
    .run();
}

export function insertTable(editor: Editor, range?: Range): void {
  start(editor, range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
}

export const BLOCKS: BlockItem[] = [
  {
    id: 'paragraph', label: 'Text', hint: 'Plain paragraph', icon: 'paragraph', keywords: ['paragraph', 'plain'],
    run: (e, _a, r) => { start(e, r).setParagraph().run(); },
  },
  ...([1, 2, 3] as const).map((level): BlockItem => ({
    id: `heading${level}`,
    label: `Heading ${level}`,
    hint: ['Large section heading', 'Medium section heading', 'Small section heading'][level - 1],
    icon: `heading${level}` as IconName,
    keywords: ['heading', 'title', `h${level}`],
    run: (e, _a, r) => { start(e, r).setHeading({ level }).run(); },
  })),
  {
    id: 'bulletList', label: 'Bulleted list', hint: 'A simple list', icon: 'bulletList', keywords: ['bullet', 'unordered', 'ul'],
    run: (e, _a, r) => { start(e, r).toggleBulletList().run(); },
  },
  {
    id: 'orderedList', label: 'Numbered list', hint: 'A list with numbers', icon: 'orderedList', keywords: ['ordered', 'number', 'ol'],
    run: (e, _a, r) => { start(e, r).toggleOrderedList().run(); },
  },
  {
    id: 'taskList', label: 'To-do list', hint: 'Track tasks with checkboxes', icon: 'taskList', keywords: ['task', 'todo', 'checkbox', 'check'],
    run: (e, _a, r) => { start(e, r).toggleTaskList().run(); },
  },
  {
    id: 'blockquote', label: 'Quote', hint: 'Set a quotation apart', icon: 'quote', keywords: ['blockquote', 'citation'],
    run: (e, _a, r) => { start(e, r).toggleBlockquote().run(); },
  },
  {
    id: 'codeBlock', label: 'Code block', hint: 'Commands and code, highlighted', icon: 'codeBlock', keywords: ['code', 'pre', 'snippet', 'shell'],
    run: (e, _a, r) => { start(e, r).toggleCodeBlock().run(); },
  },
  {
    id: 'callout', label: 'Callout', hint: 'Info, tip, warning or danger box', icon: 'callout', keywords: ['note', 'info', 'tip', 'warning', 'danger', 'alert'],
    run: (e, _a, r) => insertCallout(e, 'info', r),
  },
  {
    id: 'details', label: 'Collapsible section', hint: 'Content that opens and closes', icon: 'details', keywords: ['toggle', 'details', 'collapse', 'expand', 'accordion'],
    run: (e, _a, r) => insertDetails(e, r),
  },
  {
    id: 'table', label: 'Table', hint: 'Rows and columns', icon: 'table', keywords: ['grid', 'columns', 'rows'],
    run: (e, _a, r) => insertTable(e, r),
  },
  {
    id: 'horizontalRule', label: 'Divider', hint: 'A line between sections', icon: 'divider', keywords: ['horizontal rule', 'hr', 'line', 'separator'],
    run: (e, _a, r) => { start(e, r).setHorizontalRule().run(); },
  },
  {
    id: 'image', label: 'Image', hint: 'Upload a picture', icon: 'image', keywords: ['picture', 'photo', 'screenshot', 'upload'],
    run: (e, a, r) => { start(e, r).run(); a.pickImage(); },
  },
  {
    id: 'file', label: 'File', hint: 'Embed a wiki file or upload one', icon: 'paperclip', keywords: ['attachment', 'pdf', 'video', 'embed', 'upload'],
    run: (e, a, r) => { start(e, r).run(); a.pickFile(); },
  },
  {
    id: 'pageLink', label: 'Page link', hint: 'Link to another page (or type [[)', icon: 'pageLink', keywords: ['link', 'page', 'mention', 'reference'],
    run: (e, a, r) => { start(e, r).run(); a.pickPage(); },
  },
];

/** The blocks matching `query` — label words first, then keywords. */
export function filterBlocks(query: string): BlockItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCKS;
  const starts = (s: string) => s.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))
    || s.toLowerCase().startsWith(q);
  const byLabel = BLOCKS.filter((b) => starts(b.label));
  const byKeyword = BLOCKS.filter((b) => !byLabel.includes(b) && b.keywords.some(starts));
  return [...byLabel, ...byKeyword];
}
