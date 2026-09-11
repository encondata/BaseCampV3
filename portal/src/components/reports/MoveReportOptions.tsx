/**
 * GenerateReportModal's options step for `report_type === 'move_report'`.
 * The initiative is picked by the shared "pick" step (this report type
 * has no "No initiative" choice, like Move Scan History) — this
 * component lets the requester choose which of the report's eight
 * sections to include and hands the result back to GenerateReportModal's
 * own progress step exactly like `MoveScanHistoryOptions` and
 * `SiteMoveSurveyOptions` do.
 */
import { useState } from 'react';

import type { InitiativeItem, ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';
import { Switch } from '../Switch';
import { InitiativeSummary, OptionGroup, OptionsGrid, PreviewCard, summaryFromInitiative } from './ReportOptionsLayout';

export default function MoveReportOptions({ definition, initiative, onBack, onGenerate }: {
  definition: ReportDefinition;
  /** Already picked by GenerateReportModal's shared "pick" step. This
   *  report type always requires one, so it's only ever `null` for the
   *  brief instant before the pick step's Next click. */
  initiative: InitiativeItem | null;
  onBack: () => void;
  onGenerate: (payload: {
    initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
  }) => void;
}) {
  const [options, setOptions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, !!definition.options[s.key]])));
  const [notify, setNotify] = useState(false);

  const enabledCount = MOVE_REPORT_SECTIONS.filter((s) => options[s.key]).length;
  const setAll = (v: boolean) =>
    setOptions(Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, v])));

  const generate = () => {
    if (!initiative) return;
    onGenerate({ initiative_id: initiative.id, options, notify });
  };

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Selected initiative">
            <InitiativeSummary
              initiative={initiative ? summaryFromInitiative(initiative) : null}
              emptyText="Pick an initiative to see its details here."
            />
            <p className="cell-sub">
              {enabledCount} of {MOVE_REPORT_SECTIONS.length} sections · PDF
            </p>
          </PreviewCard>
        }>
          <OptionGroup title="Sections" actions={
            <>
              <button type="button" className="mini-btn" onClick={() => setAll(true)}>Select All</button>
              <button type="button" className="mini-btn" onClick={() => setAll(false)}>Deselect All</button>
            </>
          }>
            <div className="mini-list report-sections">
              {MOVE_REPORT_SECTIONS.map((s) => (
                <label key={s.key} className="mini-row report-section-row">
                  <Switch checked={!!options[s.key]}
                          onChange={(v) => setOptions((o) => ({ ...o, [s.key]: v }))} />
                  <span className="report-section-text">
                    <span className="cell-top">{s.title}</span>
                    <span className="cell-sub">{s.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {enabledCount === 0 && <div className="pf-error">Turn on at least one section</div>}
          </OptionGroup>

          <OptionGroup title="Notify">
            <div className="mini-list report-sections">
              <label className="mini-row report-section-row">
                <Switch checked={notify} onChange={setNotify} />
                <span className="report-section-text">
                  <span className="cell-top">Notify me</span>
                  <span className="cell-sub">Get an inbox notification when the report is ready.</span>
                </span>
              </label>
            </div>
          </OptionGroup>
        </OptionsGrid>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onBack}>Back</button>
        <button type="button" className="btn-solid" disabled={!initiative || enabledCount === 0}
                onClick={generate}>
          Generate Report
        </button>
      </div>
    </>
  );
}
