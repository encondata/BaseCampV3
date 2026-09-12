/**
 * Shared building blocks for GenerateReportModal's "pick" step summary
 * aside and every report type's options step — Move Scan History
 * (`MoveScanHistoryOptions`) was the only one styled as a two-column
 * "preview card + choice cards / option groups" layout; Move Report
 * (`MoveReportOptions`) and Site & Move Survey (`SiteMoveSurveyOptions`)
 * now share the same pieces so all three (and the pick step's own
 * "Selected initiative" aside) read as one consistent design instead of
 * scan history alone looking presentable.
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import type { InitiativeItem } from '../../lib/api';
import { fmtDate } from '../../lib/reports';

/** Two-column grid: a `PreviewCard` on the left, the options column
 *  (everything else) on the right — collapses to one column under
 *  760px, same breakpoint as the pick step's own `.rgm-pick-cols`. */
export function OptionsGrid({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  return (
    <div className="rgm-grid">
      {preview}
      <div className="rgm-options">{children}</div>
    </div>
  );
}

/** The bordered card (the pick step's own `.rgm-summary` look) that
 *  hosts a `modal-section` title plus arbitrary preview content. */
export function PreviewCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="rgm-summary">
      <div className="modal-section">{title}</div>
      {children}
    </aside>
  );
}

/** A `modal-section` header (with optional trailing actions, e.g. Select
 *  all / Deselect all) and an optional hint, wrapping a group of
 *  controls — used for every labeled block on an options step's right
 *  column (Format, Sections, Partner, Sites, …). */
export function OptionGroup({ title, hint, actions, children }: {
  title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="rgm-group">
      <div className="modal-section rgm-group-head">
        <span>{title}</span>
        {actions && <span className="rgm-group-actions">{actions}</span>}
      </div>
      {hint && <p className="page-hint">{hint}</p>}
      {children}
    </div>
  );
}

/** The fields `InitiativeSummary` renders — a subset shared by
 *  `InitiativeItem` (the pick step, Move Report) and Move Scan History's
 *  own preview payload (which names its source/destination fields
 *  differently and carries no type/status), so both can feed the same
 *  component without reshaping their own data models. */
export interface InitiativeSummaryFields {
  name: string;
  clientName: string | null;
  typeLabel?: string | null;
  typeColor?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;
  scheduledStart: string | null;
  scheduledEnd?: string | null;
  originName?: string | null;
  destinationName?: string | null;
}

/** Maps a full `InitiativeItem` (the pick step's own picker rows, and
 *  what Move Report / Site & Move Survey's options steps receive) onto
 *  `InitiativeSummaryFields`. */
export function summaryFromInitiative(i: InitiativeItem): InitiativeSummaryFields {
  return {
    name: i.name, clientName: i.client_name,
    typeLabel: i.type_label, typeColor: i.type_color,
    statusLabel: i.status_label, statusColor: i.status_color,
    scheduledStart: i.scheduled_start, scheduledEnd: i.scheduled_end,
    originName: i.origin_site_name, destinationName: i.destination_site_name,
  };
}

/** The pick step's own "name / client / type+status chips / scheduled
 *  dates / source → destination" block, shared with every options
 *  step's `PreviewCard` so the same initiative reads identically at
 *  every stage of the Generate flow. `initiative: null` renders
 *  `emptyText` instead (the pick step's own "no pick yet" copy, or a
 *  report-type-specific "no initiative" hint). */
export function InitiativeSummary({ initiative, emptyText }: {
  initiative: InitiativeSummaryFields | null;
  emptyText: string;
}) {
  if (!initiative) return <p className="page-hint">{emptyText}</p>;
  const {
    name, clientName, typeLabel, typeColor, statusLabel, statusColor,
    scheduledStart, scheduledEnd, originName, destinationName,
  } = initiative;
  return (
    <>
      <div className="cell-top">{name}</div>
      <div className="cell-sub">{clientName ?? '—'}</div>
      {(typeLabel || statusLabel) && (
        <div className="rgm-summary-chips">
          {typeLabel && (
            <span className="chip custom" style={{ '--chip': typeColor } as CSSProperties}>
              {typeLabel}
            </span>
          )}
          {statusLabel && (
            <span className="chip custom" style={{ '--chip': statusColor } as CSSProperties}>
              <span className="dot" />{statusLabel}
            </span>
          )}
        </div>
      )}
      <div className="cell-sub">
        Scheduled: {fmtDate(scheduledStart)}{scheduledEnd ? ` → ${fmtDate(scheduledEnd)}` : ''}
      </div>
      <div className="cell-sub">{originName ?? '—'} → {destinationName ?? '—'}</div>
    </>
  );
}

/** A big selectable card, either radio semantics (generalizes Move Scan
 *  History's former format cards — one `role="radio"` member of its
 *  parent's `role="radiogroup"`, arrow keys rove focus and selection
 *  between siblings) or checkbox semantics (Generate Labels' label-type
 *  multi-select — one independent `role="checkbox"`, no roving group).
 *  Arrow-key roving is found via the closest `[role="radiogroup"]`
 *  ancestor, so a group of any size works without each caller wiring its
 *  own refs; it's a no-op for the checkbox variant (no radiogroup to
 *  find). `disabled` renders a native-disabled button (inert to click/
 *  key) with an optional `hint` explaining why — Generate Labels uses
 *  this for a type with no active template instead of hiding it. */
export function ChoiceCard({
  title, description, selected, onSelect, variant = 'radio', disabled = false, hint,
}: {
  title: string; description: string; selected: boolean; onSelect: () => void;
  variant?: 'radio' | 'checkbox'; disabled?: boolean; hint?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const group = e.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      const cards = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      const idx = cards.indexOf(e.currentTarget);
      if (idx === -1) return;
      const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      const next = cards[(idx + dir + cards.length) % cards.length];
      next?.focus();
      next?.click();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <button type="button" role={variant} aria-checked={selected} disabled={disabled}
            tabIndex={variant === 'radio' ? (selected ? 0 : -1) : 0}
            className={`rgm-choice-card ${selected ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
            onClick={onSelect} onKeyDown={onKeyDown}>
      <span className="rgm-choice-title">{title}</span>
      <span className="rgm-choice-desc">{description}</span>
      {hint && <span className="rgm-choice-hint">{hint}</span>}
    </button>
  );
}
