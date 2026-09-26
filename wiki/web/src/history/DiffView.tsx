/** Two versions side by side in one column: unchanged blocks plain, added
 *  blocks green, removed blocks red and struck through, and changed blocks
 *  with their words marked inline. */
import type { DiffBlock, DiffWord } from './diff';

function Words({ words }: { words: DiffWord[] }) {
  return (
    <>
      {words.map((w, i) => {
        if (w.op === 'add') return <ins key={i}>{w.text}</ins>;
        if (w.op === 'remove') return <del key={i}>{w.text}</del>;
        return <span key={i}>{w.text}</span>;
      })}
    </>
  );
}

function blockClass(type: string): string {
  switch (type) {
    case 'heading': return 'is-heading';
    case 'listItem':
    case 'taskItem': return 'is-item';
    case 'tableRow': return 'is-row';
    case 'codeBlock': return 'is-code';
    default: return '';
  }
}

const OP_LABEL = { add: 'Added', remove: 'Removed', change: 'Changed' } as const;

export default function DiffView({ blocks, from, to }: { blocks: DiffBlock[]; from: string; to: string }) {
  const counts = { add: 0, remove: 0, change: 0 };
  for (const b of blocks) if (b.op !== 'same') counts[b.op] += 1;
  const unchanged = counts.add + counts.remove + counts.change === 0;

  return (
    <div className="wiki-diff" data-testid="diff-view">
      <div className="wiki-diff-head">
        <span>Changes from <b>{from}</b> to <b>{to}</b></span>
        <span className="wiki-diff-legend">
          <span className="chip c-green">{counts.add} added</span>
          <span className="chip c-red">{counts.remove} removed</span>
          <span className="chip c-amber">{counts.change} changed</span>
        </span>
      </div>
      {unchanged && <p className="page-hint">These versions have the same content.</p>}
      <div className="wiki-diff-body">
        {blocks.map((b, i) => {
          const block = (b.b ?? b.a)!;
          const cls = `wiki-diff-block ${b.op} ${blockClass(block.type)}`;
          const label = b.op === 'same' ? undefined : OP_LABEL[b.op];
          if (b.op === 'change') {
            return <div key={i} className={cls} title={label}><Words words={b.words ?? []} /></div>;
          }
          if (b.op === 'add') return <div key={i} className={cls} title={label}><ins>{block.text || ' '}</ins></div>;
          if (b.op === 'remove') return <div key={i} className={cls} title={label}><del>{block.text || ' '}</del></div>;
          return <div key={i} className={cls}>{block.text || ' '}</div>;
        })}
      </div>
    </div>
  );
}
