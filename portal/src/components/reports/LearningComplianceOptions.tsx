/**
 * GenerateReportModal's options step for `report_type === 'learning_compliance'`.
 * Like the Timesheet there is no initiative pick step: the optional
 * initiative is one of the options here (blank = everyone, every active
 * initiative plus the general set), and becomes the run's `initiative_id`.
 * The run's options are {initiative_id, format}.
 */
import { useEffect, useState } from 'react';

import { listInitiatives, type ReportDefinition } from '../../lib/api';
import { sortNatural } from '../../lib/naturalSort';
import ComboBox, { type ComboOption } from '../ComboBox';
import { Switch } from '../Switch';
import { ChoiceCard, OptionGroup, OptionsGrid, PreviewCard } from './ReportOptionsLayout';

type Format = 'xlsx' | 'pdf';

export default function LearningComplianceOptions({ definition, onGenerate }: {
  definition: ReportDefinition;
  onGenerate: (payload: {
    initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
  }) => void;
}) {
  const [initiativeId, setInitiativeId] = useState('');
  const [format, setFormat] = useState<Format>(
    () => (definition.options.default_format === 'pdf' ? 'pdf' : 'xlsx'));
  const [notify, setNotify] = useState(false);
  const [initiatives, setInitiatives] = useState<ComboOption[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listInitiatives().then((list) => {
      if (!cancelled) {
        setInitiatives(sortNatural(list.filter((i) => !i.archived_at), (i) => i.name)
          .map((i) => ({ value: i.id, label: i.name })));
      }
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const scope = initiatives.find((i) => i.value === initiativeId)?.label;
  const generate = () => {
    const id = initiativeId || null;
    onGenerate({ initiative_id: id, options: { initiative_id: id, format }, notify });
  };

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Scope">
            <p className="page-hint">
              {scope
                ? `One row per worker and required document on ${scope}.`
                : 'One row per worker and required document, for every active initiative and the general set.'}
            </p>
          </PreviewCard>
        }>
          <OptionGroup title="Initiative"
                       hint="Leave blank to cover everyone, or pick one initiative.">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="lc-initiative">Initiative</label>
                <ComboBox inputId="lc-initiative" ariaLabel="Initiative" placeholder="All initiatives"
                          value={initiativeId} onChange={setInitiativeId}
                          options={[{ value: '', label: 'All initiatives' }, ...initiatives]} />
              </div>
            </div>
            {failed && <div className="pf-error">Couldn&apos;t load the initiatives.</div>}
          </OptionGroup>

          <OptionGroup title="Format">
            <div className="rgm-choice-cards" role="radiogroup" aria-label="Format">
              <ChoiceCard title="Excel workbook" description="A Summary sheet and a Compliance sheet"
                          selected={format === 'xlsx'} onSelect={() => setFormat('xlsx')} />
              <ChoiceCard title="PDF document" description="Printable, with a document tracking barcode"
                          selected={format === 'pdf'} onSelect={() => setFormat('pdf')} />
            </div>
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
        <button type="button" className="btn-solid" onClick={generate}>Generate Report</button>
      </div>
    </>
  );
}
