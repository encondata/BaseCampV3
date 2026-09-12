/**
 * GenerateReportModal's options step for `report_type === 'container_labels'`.
 * The initiative is picked by the shared "pick" step (Next stays disabled
 * until one is picked, same as Move Scan History) — this component loads
 * that initiative's containers into the same `ContainerPickList` the
 * standalone `/labels/containers` page uses, so Reports users select
 * containers and tags identically, then hands `{ container_ids, tags }`
 * back to GenerateReportModal's own progress step.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, listContainers, type ContainerItem, type InitiativeItem, type ReportDefinition,
} from '../../lib/api';
import { buildRunOptions, tagsInUse } from '../../lib/containerLabels';
import { TAG_TYPES, type TagKey } from '../../labels/containerLabelSheet';
import ContainerPickList from '../labels/ContainerPickList';
import { Switch } from '../Switch';
import { InitiativeSummary, OptionGroup, OptionsGrid, PreviewCard, summaryFromInitiative } from './ReportOptionsLayout';

export default function ContainerLabelsOptions({ initiative, onBack, onGenerate }: {
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
  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, TagKey>>({});
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    if (!initiative) { setContainers(null); return; }
    let cancelled = false;
    setContainers(null);
    setLoadError('');
    setSelected([]);
    setTags({});
    listContainers({ initiative_id: initiative.id })
      .then((rows) => { if (!cancelled) setContainers(rows); })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load containers.");
      });
    return () => { cancelled = true; };
  }, [initiative]);

  const inUse = tagsInUse(selected, tags);

  const generate = () => {
    if (!initiative || selected.length === 0) return;
    onGenerate({ initiative_id: initiative.id, options: buildRunOptions(selected, tags), notify });
  };

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Preview">
            <InitiativeSummary
              initiative={initiative ? summaryFromInitiative(initiative) : null}
              emptyText="Pick an initiative to see its details here."
            />
            {containers !== null && (
              <p className="page-hint">{containers.length} container{containers.length === 1 ? '' : 's'} on this initiative.</p>
            )}
            {selected.length > 0 && (
              <>
                <p className="page-hint">{selected.length} selected — {selected.length} sheet{selected.length === 1 ? '' : 's'}.</p>
                {inUse.length > 0 && (
                  <div className="cl-generate-summary">
                    {inUse.map((key) => (
                      <span key={key} className="chip tag">{TAG_TYPES[key].label}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </PreviewCard>
        }>
          <OptionGroup title="Containers"
                       hint={!initiative
                         ? 'Pick an initiative to see its containers.'
                         : undefined}>
            {loadError && <div className="pf-error">{loadError}</div>}
            {!loadError && initiative && containers === null && <p className="page-hint">Loading containers…</p>}
            {!loadError && initiative && containers !== null && containers.length === 0 && (
              <p className="page-hint">No containers on this initiative.</p>
            )}
            {!loadError && initiative && containers !== null && containers.length > 0 && (
              <ContainerPickList containers={containers} selected={selected} tags={tags}
                                  onSelectedChange={setSelected} onTagsChange={setTags} />
            )}
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
        <button type="button" className="btn-solid" disabled={!initiative || selected.length === 0}
                onClick={generate}>
          Generate Report
        </button>
      </div>
    </>
  );
}
