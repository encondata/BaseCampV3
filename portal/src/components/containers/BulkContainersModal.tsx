/**
 * BulkContainersModal — "+ Add in bulk" on the Containers page. One call
 * to `POST /containers/bulk` creates a numbered batch (name = prefix +
 * zero-padded(start + i) + suffix) and pre-assigns label tags in a fixed
 * order (Priority, Vendor, Accessories, Warehouse, E-Waste — Jimmy's
 * spec). All the naming/tag math is `lib/bulkContainers.ts`'s pure
 * helpers; this component is just the form and the request. Chrome
 * borrows GenerateReportModal's roomy header (`rgm-head-text`/`rgm-card`)
 * and its `OptionsGrid`/`OptionGroup` two-column layout (see
 * ReportOptionsLayout.tsx) even though this isn't a report — those are
 * the established "wide modal, left card + right options" pieces, and
 * reusing them keeps this dialog visually consistent with the rest of
 * the app instead of inventing a third layout.
 */

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';

import {
  ApiError, bulkCreateContainers, type ContainerItem, type InitiativeItem, type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  buildNames, clampTags, previewNames, summaryText, tagTotal, TAG_ASSIGNMENT_ORDER,
  type NamingConfig, type TagCounts,
} from '../../lib/bulkContainers';
import { LABEL_TAG_OPTIONS } from '../../lib/labelTags';
import { OptionGroup, OptionsGrid, PreviewCard } from '../reports/ReportOptionsLayout';
import ComboBox from '../ComboBox';
import '../../styles/reports.css';       // rgm-* (roomy header, two-column grid)

const ZERO_PAD_CHOICES = [0, 2, 3, 4];

const BULK_ERRORS: Record<string, string> = {
  bad_container_type: 'Pick a container type from the list.',
  tags_exceed_count: 'Label tag counts cannot exceed the container count.',
  empty_name: 'That naming convention produces an empty name — check the prefix/suffix.',
  initiative_not_found: 'That initiative no longer exists — pick another.',
  site_not_found: 'That site no longer exists — pick another.',
  forbidden: 'You do not have permission to add containers.',
};

function mapError(err: unknown): string {
  if (err instanceof ApiError) return BULK_ERRORS[err.code] ?? 'Could not create containers — try again.';
  return 'Network error.';
}

/** "Trimmed 2 Vendor, 1 E-Waste to fit the new count." — the clamp
 *  notice shown when lowering Count pushes the tag total back down. */
function clampNoticeText(trimmed: TagCounts): string {
  const parts = TAG_ASSIGNMENT_ORDER
    .filter((key) => (trimmed[key] ?? 0) > 0)
    .map((key) => `${trimmed[key]} ${LABEL_TAG_OPTIONS.find((o) => o.key === key)!.label}`);
  return `Count dropped below the tag total — trimmed ${parts.join(', ')} to fit.`;
}

interface Props {
  types: StatusValue[];
  sites: SiteItem[];
  initiatives?: InitiativeItem[];
  onClose: () => void;
  onCreated: (created: ContainerItem[]) => Promise<void> | void;
}

export default function BulkContainersModal({
  types, sites, initiatives = [], onClose, onCreated,
}: Props) {
  const [count, setCount] = useState(1);
  const [containerType, setContainerType] = useState('');
  const [naming, setNaming] = useState<NamingConfig>({ prefix: '', start: 1, pad: 3, suffix: '' });
  const [initiativeId, setInitiativeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [tags, setTags] = useState<TagCounts>({});
  const [clampNotice, setClampNotice] = useState('');
  const [collisionNames, setCollisionNames] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Escape closes the dialog (GenerateReportModal's own convention) —
  // skipped while a request is in flight, same as the backdrop click below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // Lowering Count below the tag total clamps it back down from the LAST
  // tag in assignment order — same rule the API applies — and explains
  // what happened. Bumping Count (or leaving it alone) never trims
  // anything (clampTags is a no-op when the total already fits).
  useEffect(() => {
    setTags((prev) => {
      const { tags: next, trimmed } = clampTags(prev, count);
      setClampNotice(Object.keys(trimmed).length > 0 ? clampNoticeText(trimmed) : '');
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.key, label: t.label })), [types]);

  const initiativeOptions = useMemo(() => [...initiatives]
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))
    .map((i) => ({ value: i.id, label: i.name, sub: i.client_name ?? undefined })), [initiatives]);

  const siteOptions = useMemo(() => sites
    .filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })), [sites]);

  const names = useMemo(() => buildNames(naming, count), [naming, count]);
  const preview = useMemo(() => previewNames(naming, count), [naming, count]);
  const total = tagTotal(tags);

  const setCountClamped = (raw: string) => {
    const n = Math.round(Number(raw));
    setCount(Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 1);
  };
  const setStart = (raw: string) => {
    const n = Math.round(Number(raw));
    setNaming((f) => ({ ...f, start: Number.isFinite(n) ? Math.max(0, n) : 0 }));
  };

  const inc = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    if (total >= count) return;
    setClampNotice('');
    setTags((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 }));
  };
  const dec = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    setClampNotice('');
    setTags((t) => (t[key] ? { ...t, [key]: t[key]! - 1 } : t));
  };

  const valid = count >= 1 && count <= 500 && !!containerType
    && names.length > 0 && names.every((n) => n.trim().length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError('');
    setCollisionNames(null);
    try {
      const payload = {
        count,
        container_type: containerType,
        naming: { prefix: naming.prefix, start: naming.start, pad: naming.pad, suffix: naming.suffix },
        initiative_id: initiativeId || null,
        site_id: siteId || null,
        status: null,
        tags: Object.fromEntries(TAG_ASSIGNMENT_ORDER.map((key) => [key, tags[key] ?? 0])),
      };
      const { created } = await bulkCreateContainers(payload);
      await onCreated(created);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_collision') {
        const collidingNames = (err.detail as { names?: string[] } | undefined)?.names ?? [];
        setCollisionNames(collidingNames);
        setError('Some of those names already exist — adjust the naming convention.');
      } else {
        setError(mapError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card reports-modal-card rgm-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Containers</div>
            <h3>Add containers in bulk</h3>
            <p className="page-hint">Create a numbered batch of containers and pre-assign label tags.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <OptionsGrid preview={
              <PreviewCard title="Batch">
                <div className="pf-form">
                  <div>
                    <label htmlFor="bulk-count">Count</label>
                    <input id="bulk-count" type="number" min={1} max={500} disabled={saving}
                           value={count} onChange={(e) => setCountClamped(e.target.value)} />
                  </div>
                  <div>
                    <label>Type</label>
                    <ComboBox
                      placeholder="Type to search types…"
                      value={containerType}
                      disabled={saving}
                      onChange={setContainerType}
                      options={typeOptions}
                    />
                  </div>

                  <div><label htmlFor="bulk-prefix">Prefix</label>
                    <input id="bulk-prefix" value={naming.prefix} disabled={saving}
                           onChange={(e) => setNaming((f) => ({ ...f, prefix: e.target.value }))} /></div>
                  <div><label htmlFor="bulk-start">Start number</label>
                    <input id="bulk-start" type="number" min={0} disabled={saving}
                           value={naming.start} onChange={(e) => setStart(e.target.value)} /></div>
                  <div>
                    <label id="bulk-pad-label">Zero-pad</label>
                    <div className="segmented" role="tablist" aria-labelledby="bulk-pad-label">
                      {ZERO_PAD_CHOICES.map((p) => (
                        <button key={p} type="button" role="tab" aria-selected={naming.pad === p}
                                className={naming.pad === p ? 'on' : ''} disabled={saving}
                                onClick={() => setNaming((f) => ({ ...f, pad: p }))}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div><label htmlFor="bulk-suffix">Suffix</label>
                    <input id="bulk-suffix" value={naming.suffix} disabled={saving}
                           onChange={(e) => setNaming((f) => ({ ...f, suffix: e.target.value }))} /></div>

                  <div className="full">
                    <p className="page-hint">Preview: {preview}</p>
                    {collisionNames && collisionNames.length > 0 && (
                      <p className="pf-error">Already exists: {collisionNames.join(', ')}</p>
                    )}
                  </div>

                  <div><label>Initiative</label>
                    <ComboBox
                      placeholder="Type to search initiatives…"
                      value={initiativeId}
                      clearable
                      disabled={saving}
                      onChange={setInitiativeId}
                      options={initiativeOptions}
                    /></div>
                  <div><label>Site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={siteId}
                      clearable
                      disabled={saving}
                      onChange={setSiteId}
                      options={siteOptions}
                    /></div>
                </div>
              </PreviewCard>
            }>
              <OptionGroup title="Label tags"
                           hint="Assigned in order — the first containers get Priority, then Vendor, Accessories, Warehouse, and E-Waste.">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {TAG_ASSIGNMENT_ORDER.map((key) => {
                    const opt = LABEL_TAG_OPTIONS.find((o) => o.key === key)!;
                    const n = tags[key] ?? 0;
                    return (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="chip custom" style={{ '--chip': opt.color } as CSSProperties}>
                          <span className="dot" />{opt.label}
                        </span>
                        <span style={{ flex: 1 }} />
                        <button type="button" className="mini-btn" aria-label={`Fewer ${opt.label}`}
                                disabled={saving || n <= 0} onClick={() => dec(key)}>−</button>
                        <span className="mono">{n}</span>
                        <button type="button" className="mini-btn" aria-label={`More ${opt.label}`}
                                disabled={saving || total >= count} onClick={() => inc(key)}>+</button>
                      </div>
                    );
                  })}
                </div>
                <p className="page-hint">{summaryText(count, tags)}</p>
                {clampNotice && <p className="pf-error">{clampNotice}</p>}
              </OptionGroup>
            </OptionsGrid>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!valid || saving}>
              {saving ? 'Creating…' : `Create ${count} container${count === 1 ? '' : 's'}`}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
