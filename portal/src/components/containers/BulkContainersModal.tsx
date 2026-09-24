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

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, bulkCreateContainers, type ContainerItem, type InitiativeItem, type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  autoPad, clampTags, MAX_PAD, numberOverflow, previewNames, TAG_ASSIGNMENT_ORDER,
  type NamingConfig, type TagCounts,
} from '../../lib/bulkContainers';
import { TAG_TYPES } from '../../labels/tagTypes';
import ComboBox from '../ComboBox';
import LabelTagCounts from './LabelTagCounts';
import '../../styles/reports.css';       // rgm-* (roomy header)
import '../../styles/bulkContainers.css';

// API's `naming.prefix`/`naming.suffix` max_length — see
// ContainerBulkCreateIn (bc-api-report.md); bounding the inputs keeps a
// too-long value from reaching the server as a generic (uncoded) 422.
const PAD_CHOICES = [2, 3, 4];
const NAMING_PART_MAX_LENGTH = 40;

const BULK_ERRORS: Record<string, string> = {
  bad_container_type: 'Pick a container type from the list.',
  tags_exceed_count: 'Label tag counts cannot exceed the container count.',
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
    .map((key) => `${trimmed[key]} ${TAG_TYPES[key].label}`);
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
  // Free-typed text for the Count field — kept separate from the clamped
  // numeric `count` derived below so the field can be emptied/retyped
  // without a forced snap-back on every keystroke (that snap-back is what
  // made the field impossible to clear, and walking through a transient
  // small value while retyping used to trigger a spurious tag clamp).
  const [countText, setCountText] = useState('1');
  const [containerType, setContainerType] = useState('');
  const [namingBase, setNaming] = useState<Omit<NamingConfig, 'pad'>>({ prefix: '', start: 1, suffix: '' });
  const [initiativeId, setInitiativeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [tags, setTags] = useState<TagCounts>({});
  const [clampNotice, setClampNotice] = useState('');
  const [collisionNames, setCollisionNames] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // The clamped 1..500 integer used everywhere else (preview, summary,
  // footer label, tag-stepper `+` gating) — always well-formed even while
  // `countText` is transiently empty or out of range mid-edit.
  const count = useMemo(() => {
    const n = Math.round(Number(countText));
    return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 1;
  }, [countText]);

  // Escape closes the dialog (GenerateReportModal's own convention) —
  // skipped while a request is in flight, same as the backdrop click below.
  // `!e.defaultPrevented` is the same convention GenerateReportModal uses
  // for its nested CompleteSiteSurveyModal: an open ComboBox's own Escape
  // handler (scoped to just closing its list) calls preventDefault, so
  // that Escape dismisses the list only, not the whole form underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  // Lowering Count below the tag total clamps it back down from the LAST
  // tag in assignment order — same rule the API applies — and explains
  // what happened. Applied on Count blur (below) and again right before
  // submit (Enter submits the form without ever blurring the field) —
  // deliberately NOT on every keystroke: `count` is derived from
  // `countText` above, and a per-keystroke effect on it would trim tags
  // against transient values (e.g. an empty or momentarily-small string
  // while retyping), losing counts the user never actually asked to
  // reduce to. `clampTags` is a no-op when the total already fits, so
  // calling this after Count only ever *increases* is harmless.
  const applyCountClamp = () => {
    const { tags: next, trimmed } = clampTags(tags, count);
    if (Object.keys(trimmed).length > 0) {
      setTags(next);
      setClampNotice(clampNoticeText(trimmed));
      return next;
    }
    setClampNotice('');
    return tags;
  };

  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.key, label: t.label })), [types]);

  const initiativeOptions = useMemo(() => [...initiatives]
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))
    .map((i) => ({ value: i.id, label: i.name, sub: i.client_name ?? undefined })), [initiatives]);

  const siteOptions = useMemo(() => sites
    .filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })), [sites]);

  const [padChoice, setPadChoice] = useState<number | null>(null);   // null = automatic
  const minPad = autoPad(namingBase.start, count);
  const pad = Math.min(MAX_PAD, Math.max(minPad, padChoice ?? 0));
  const overflow = numberOverflow(namingBase.start, count);
  const naming: NamingConfig = useMemo(() => ({ ...namingBase, pad }), [namingBase, pad]);
  const preview = useMemo(() => previewNames(naming, count), [naming, count]);

  const onCountBlur = () => {
    setCountText(String(count));
    applyCountClamp();
  };
  const setStart = (raw: string) => {
    const n = Math.round(Number(raw));
    setNaming((f) => ({ ...f, start: Number.isFinite(n) ? Math.max(0, n) : 0 }));
  };

  const valid = count >= 1 && !!containerType && !overflow;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    // Enter submits the form without ever blurring Count, so the clamp
    // (normally applied on blur — see `applyCountClamp` above) needs its
    // own pass here too: the payload must never carry a tag total the
    // current Count can't fit, regardless of how submit was triggered.
    const safeTags = applyCountClamp();
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
        tags: Object.fromEntries(TAG_ASSIGNMENT_ORDER.map((key) => [key, safeTags[key] ?? 0])),
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
      <div className="modal-card reports-modal-card rgm-card bc-card">
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
            <div className="bc-grid">
              <section className="bc-col" aria-label="Batch">
                <div className="modal-section">Batch</div>
                <div className="pf-form bc-form">
                  <div>
                    <label htmlFor="bulk-count">Count</label>
                    <input id="bulk-count" type="number" min={1} max={500} disabled={saving}
                           value={countText} onChange={(e) => setCountText(e.target.value)}
                           onBlur={onCountBlur} />
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
                  <div>
                    <label>Initiative</label>
                    <ComboBox
                      placeholder="Type to search initiatives…"
                      value={initiativeId}
                      clearable
                      disabled={saving}
                      onChange={setInitiativeId}
                      options={initiativeOptions}
                    />
                  </div>
                  <div>
                    <label>Site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={siteId}
                      clearable
                      disabled={saving}
                      onChange={setSiteId}
                      options={siteOptions}
                    />
                  </div>
                </div>

                <div className="modal-section">Naming convention</div>
                <div className="pf-form bc-form bc-naming">
                  <div><label htmlFor="bulk-prefix">Prefix</label>
                    <input id="bulk-prefix" value={naming.prefix} disabled={saving}
                           maxLength={NAMING_PART_MAX_LENGTH}
                           onChange={(e) => setNaming((f) => ({ ...f, prefix: e.target.value }))} /></div>
                  <div><label htmlFor="bulk-start">Start number</label>
                    <input id="bulk-start" type="number" min={0} disabled={saving}
                           value={naming.start} onChange={(e) => setStart(e.target.value)} /></div>
                  <div>
                    <label id="bulk-pad-label">Zero-pad</label>
                    <div className="segmented" role="tablist" aria-labelledby="bulk-pad-label">
                      {PAD_CHOICES.map((p) => (
                        <button key={p} type="button" role="tab" aria-selected={pad === p}
                                className={pad === p ? 'on' : ''}
                                disabled={saving || p < minPad}
                                title={p < minPad ? `At least ${minPad} digits are needed for this batch` : undefined}
                                onClick={() => setPadChoice(p)}>
                          {p} digits
                        </button>
                      ))}
                    </div>
                    <p className="page-hint" id="bulk-pad" style={{ margin: '4px 0 0' }}>
                      {padChoice !== null && padChoice > minPad
                        ? `Override · the batch needs at least ${minPad}`
                        : `Automatic minimum for ${count} starting at ${namingBase.start} (one leading zero, up to 4 digits)`}
                    </p>
                  </div>
                  <div><label htmlFor="bulk-suffix">Suffix</label>
                    <input id="bulk-suffix" value={naming.suffix} disabled={saving}
                           maxLength={NAMING_PART_MAX_LENGTH}
                           onChange={(e) => setNaming((f) => ({ ...f, suffix: e.target.value }))} /></div>
                </div>
                <div className="bc-preview">
                  <span className="eyebrow">Preview</span>
                  <p className="page-hint" id="bulk-preview">{preview}</p>
                  {overflow && (
                    <p className="pf-error">Numbers can't go past 9999 — lower the start number or the count.</p>
                  )}
                  {collisionNames && collisionNames.length > 0 && (
                    <p className="pf-error">Already exists: {collisionNames.join(', ')}</p>
                  )}
                </div>
              </section>

              <section className="bc-col" aria-label="Label tags">
                <div className="modal-section">Label tags</div>
                <p className="page-hint">
                  Assigned in order — the first containers get Priority, then Vendor, Accessories, Warehouse, and E-Waste.
                </p>
                <LabelTagCounts count={count} tags={tags} disabled={saving} notice={clampNotice}
                                onChange={(next) => { setClampNotice(''); setTags(next); }} />
              </section>
            </div>
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
