/** Renders the wiki's ProseMirror JSON for a bundled troubleshooting
 *  topic. Supports only the nodes the guard test allows; an unknown node
 *  renders nothing. Barcode images sit on a white panel in both themes. */

import type { ReactNode } from 'react';

import { topicImageUrl } from './topics';

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string }[];
}

function kids(n: DocNode): ReactNode[] {
  return (n.content ?? []).map((c, i) => renderNode(c, i));
}

function renderNode(n: DocNode, key: number): ReactNode {
  switch (n.type) {
    case 'text': {
      const bold = n.marks?.some((m) => m.type === 'bold');
      return bold ? <strong key={key}>{n.text}</strong> : n.text;
    }
    case 'paragraph': return <p key={key}>{kids(n)}</p>;
    case 'heading': return n.attrs?.level === 3
      ? <h3 key={key}>{kids(n)}</h3>
      : <h2 key={key}>{kids(n)}</h2>;
    case 'bulletList': return <ul key={key}>{kids(n)}</ul>;
    case 'orderedList': return <ol key={key}>{kids(n)}</ol>;
    case 'listItem': return <li key={key}>{kids(n)}</li>;
    case 'table': return (
      <div key={key} className="wiki-table-wrap"><table className="wiki-table"><tbody>{kids(n)}</tbody></table></div>
    );
    case 'tableRow': return <tr key={key}>{kids(n)}</tr>;
    case 'tableHeader': return <th key={key}>{kids(n)}</th>;
    case 'tableCell': return <td key={key}>{kids(n)}</td>;
    case 'callout': {
      const variant = String(n.attrs?.variant ?? 'info');
      return <div key={key} className={`portal-banner wiki-callout is-${variant}`}>{kids(n)}</div>;
    }
    case 'wikiImage': {
      const a = n.attrs ?? {};
      const width = typeof a.width === 'number' ? a.width : undefined;
      const alt = typeof a.alt === 'string' ? a.alt : '';
      const caption = typeof a.caption === 'string' ? a.caption : '';
      return (
        <figure key={key} className="wiki-barcode">
          <img src={topicImageUrl(String(a.assetId ?? ''))} alt={alt} style={width ? { width: `${width}px` } : undefined} />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      );
    }
    default: return null;
  }
}

export default function WikiDoc({ doc }: { doc: DocNode }) {
  return <div className="wiki-doc">{kids(doc)}</div>;
}
