/**
 * The asset list's shared column set: the column definitions, per-column sort
 * values, CSV columns and the read-only cell renderer. The Assets page and a
 * container's contents list both build on these, so an asset reads the same
 * everywhere it is listed. Page-only behavior (god-mode editing, the
 * duplicate-serial chip, Archived / Pending delete chips) stays with the page
 * and is composed around `AssetCell`.
 */

import type { CSSProperties, ReactNode } from 'react';

import type { AssetItem } from '../../lib/api';
import { placementText } from '../../lib/assets';
import { displayRfid } from '../../lib/format';
import { titleFor, type ColumnDef } from '../../lib/listTools';
import StatusHover from '../StatusHover';
import AssetLocation from './AssetLocation';

// Fit: default columns + trailing ≤ LIST_FIT.page
// (1172px — .portal-page at a 1512px window, nav expanded).
export const ASSET_COLUMNS: ColumnDef[] = [
  // The identity trio: the combined serial+name cell stays the default,
  // with its two halves offered as separate columns for anyone who wants
  // them side by side (or only one of them).
  {
    key: 'primary', label: 'Serial / Name', short: 'Serial/Name',
    width: '2.2fr', default: true, min: 180,
  },
  { key: 'serial', label: 'Serial', width: '1.2fr', default: false, min: 100 },
  { key: 'name', label: 'Name', width: '1.4fr', default: false, min: 140 },
  { key: 'asset_id', label: 'Asset ID', width: '0.7fr', default: true, min: 100 },
  { key: 'model', label: 'Make / Model', short: 'Model', width: '1.5fr', default: true },
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: false },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'pod', label: 'Pod #', width: '0.7fr', default: false },
  { key: 'rfid', label: 'RFID', width: '1fr', default: false },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false, min: 96 },
  { key: 'has_rails', label: 'Rails', width: '0.8fr', default: false, godOnly: true },
];

/** Sort value per column key — deliberately separate from `assetCellText`:
 *  that accessor's job is display/filter text (dashes for blanks, formatted
 *  dates), which would sort wrong (e.g. localized last-seen dates sort
 *  lexicographically by month, not chronologically). This stays lowercase/
 *  raw so naturalCompare orders rows the way a user expects. */
export function assetSortValue(a: AssetItem, key: string): string {
  switch (key) {
    case 'primary': return (a.serial_number ?? '').toLowerCase();
    case 'serial': return (a.serial_number ?? '').toLowerCase();
    case 'name': return (a.name ?? '').toLowerCase();
    case 'asset_id': return a.legacy_id != null ? String(a.legacy_id).padStart(12, '0') : '';
    case 'model': return a.model ? `${a.model.make} ${a.model.model}`.toLowerCase() : '';
    case 'category': return (a.model?.category_label ?? '').toLowerCase();
    case 'client': return (a.client_name ?? '').toLowerCase();
    case 'site': return (a.site_name ?? '').toLowerCase();
    case 'status': return a.status_label.toLowerCase();
    case 'ru': return String(a.model?.ru_size ?? 0);
    case 'location': return placementText(a).toLowerCase();
    case 'rfid': return (a.rfid_tag ?? '').toLowerCase();
    case 'pod': return (a.pod_number ?? '').toLowerCase();
    case 'last_seen': return a.last_seen_at ?? '';
    case 'has_rails': return a.has_rails === null ? '' : a.has_rails ? 'yes' : 'no';
    case 'archived': return a.archived_at ? '1' : '0';
    default: return '';
  }
}

export const ASSET_CSV_COLUMNS: [string, (a: AssetItem) => string][] = [
  ['Asset ID', (a) => (a.legacy_id != null ? String(a.legacy_id) : '')],
  ['ID', (a) => a.id],
  ['Serial', (a) => a.serial_number ?? ''],
  ['Name', (a) => a.name ?? ''],
  ['Make', (a) => a.model?.make ?? ''],
  ['Model', (a) => a.model?.model ?? ''],
  ['Category', (a) => a.model?.category_label ?? ''],
  ['Client', (a) => a.client_name ?? ''],
  ['Site', (a) => a.site_name ?? ''],
  ['Location', (a) => placementText(a)],
  ['Pod #', (a) => a.pod_number ?? ''],
  ['Status', (a) => a.status_label],
  ['RFID', (a) => a.rfid_tag ?? ''],
  ['Has rails', (a) => (a.has_rails === null ? '' : String(a.has_rails))],
  ['Last seen', (a) => a.last_seen_at ?? ''],
  ['Created', (a) => a.created_at],
];

/** The read-only cell for one asset and one column key. `statusExtras` are
 *  page-only chips (Archived, Pending delete) rendered after the status chip
 *  inside the same `.chips` box. Unknown keys render nothing. */
export function AssetCell({ asset: a, colKey, statusExtras }: {
  asset: AssetItem; colKey: string; statusExtras?: ReactNode;
}) {
  switch (colKey) {
    case 'primary':
      return <div className="pn"><b>{a.serial_number ?? '—'}</b><span>{a.name ?? '—'}</span></div>;
    case 'serial': {
      const text = a.serial_number ?? '—';
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'name': {
      const text = a.name ?? '—';
      return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'asset_id': {
      const text = a.legacy_id != null ? String(a.legacy_id) : '—';
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'model': {
      const text = a.model ? `${a.model.make} ${a.model.model}` : '—';
      return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'category':
      return a.model?.category_color
        ? (
          <span className="chip custom" style={{ '--chip': a.model.category_color } as CSSProperties}>
            <span className="dot" />{a.model.category_label}
          </span>
        )
        : <span className="chip tag">{a.model?.category_label ?? '—'}</span>;
    case 'client': {
      const text = a.client_name ?? 'House';
      return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'site': {
      const text = a.site_name ?? '—';
      return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'status':
      return (
        <div className="chips">
          <StatusHover entityType="asset" entityId={a.id} status={a.status}>
            <span className="chip custom" style={{ '--chip': a.status_color } as CSSProperties}>
              <span className="dot" />{a.status_label}
            </span>
          </StatusHover>
          {statusExtras}
        </div>
      );
    case 'ru': {
      const text = a.model?.ru_size != null ? String(a.model.ru_size) : '—';
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'location':
      return <AssetLocation asset={a} className="cell-top cell-line" />;
    case 'rfid':
      return <span className="mono cell-line" title={a.rfid_tag ?? undefined}>{displayRfid(a.rfid_tag)}</span>;
    case 'pod': {
      const text = a.pod_number ?? '—';
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'last_seen': {
      const text = a.last_seen_at ? new Date(a.last_seen_at).toLocaleDateString() : '—';
      return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
    }
    case 'has_rails': {
      const text = a.has_rails === null ? 'Unknown' : a.has_rails ? 'Yes' : 'No';
      return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
    }
    default:
      return null;
  }
}
