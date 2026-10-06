/**
 * BulkConvertRawFt — /bulk/convert-raw-ft: Convert Raw F-T in three steps
 * (Upload, Match, Download), the same WizardHeader / WizardFooter chrome as
 * Create a move in steps. Our template's columns come from the server (they
 * are the guide and the match targets); the state lives in useRawFtConvert
 * for the whole session, so Back keeps everything. Nothing is uploaded or
 * saved, so there is no draft and no leave prompt.
 * Super admins who can change moves get a fourth step, Import, that hands the
 * converted file to a move's From-To import page.
 * Specs: docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md,
 *        docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md,
 *        docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import DownloadStep from '../components/bulk/rawFt/DownloadStep';
import ImportStep from '../components/bulk/rawFt/ImportStep';
import MatchStep from '../components/bulk/rawFt/MatchStep';
import { RAW_FT_STEPS } from '../components/bulk/rawFt/steps';
import UploadStep from '../components/bulk/rawFt/UploadStep';
import { useRawFtConvert } from '../components/bulk/rawFt/useRawFtConvert';
import WizardFooter from '../components/common/WizardFooter';
import WizardHeader from '../components/common/WizardHeader';
import { SUPER_ADMIN_RANK } from '../lib/access';
import { ApiError, getMoveAssetTemplateColumns, type MoveAssetTemplateColumn } from '../lib/api';
import { handOffImportFile } from '../lib/importHandoff';
import '../styles/bulk.css';

type Steps = typeof RAW_FT_STEPS;

export default function BulkConvertRawFt() {
  const { maxRank, can } = useAuth();
  const canImport = maxRank >= SUPER_ADMIN_RANK && can('initiatives', 'change');
  const steps = canImport ? RAW_FT_STEPS : RAW_FT_STEPS.slice(0, 3);
  const [columns, setColumns] = useState<MoveAssetTemplateColumn[] | null>(null);
  const [failed, setFailed] = useState<'forbidden' | 'error' | null>(null);

  useEffect(() => {
    let live = true;
    getMoveAssetTemplateColumns()
      .then((c) => { if (live) setColumns(c); })
      .catch((e) => { if (live) setFailed(e instanceof ApiError && e.status === 403 ? 'forbidden' : 'error'); });
    return () => { live = false; };
  }, []);

  return columns === null
    ? <Chrome steps={steps} step={0}>
        {failed === 'forbidden' ? <p className="pf-error">This tool needs company-wide access to moves. Ask an administrator.</p>
          : failed ? <p className="pf-error">Couldn't load our template columns. Reload the page to try again.</p>
          : <p className="page-hint">Loading our template columns…</p>}
      </Chrome>
    : <RawFtWizard template={columns} steps={steps} canImport={canImport} />;
}

function Chrome({ steps, step, children }: { steps: Steps; step: number; children: ReactNode }) {
  const meta = steps[step]!;
  return (
    <div className="portal-page">
      <WizardHeader steps={steps} current={step} title={meta.title} description={meta.description} />
      <div className="wiz-body">{children}</div>
    </div>
  );
}

function RawFtWizard({ template, steps, canImport }: {
  template: MoveAssetTemplateColumn[]; steps: Steps; canImport: boolean;
}) {
  const convert = useRawFtConvert(template);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [moveId, setMoveId] = useState('');

  /** Build the converted file in memory, hand it to the move's From-To import page, and go there. */
  const openImport = () => {
    const file = convert.toFile();
    if (!file || !moveId) return;
    handOffImportFile(moveId, file);
    navigate(`/initiatives/${moveId}/import-assets`);
  };

  return (
    <Chrome steps={steps} step={step}>
      {step === 0 && (
        <>
          <UploadStep convert={convert} template={template} />
          <WizardFooter onNext={() => setStep(1)} nextDisabled={!convert.sheet || convert.busy} />
        </>
      )}
      {step === 1 && (
        <>
          <MatchStep convert={convert} template={template} />
          <WizardFooter onBack={() => setStep(0)} onNext={() => setStep(2)} nextDisabled={convert.matched === 0} />
        </>
      )}
      {step === 2 && (
        <>
          <DownloadStep convert={convert} onStartOver={() => setStep(0)} />
          <WizardFooter onBack={() => setStep(1)} nextLabel="Download converted file"
                        onNext={convert.download} nextDisabled={convert.matched === 0}
                        secondary={canImport
                          ? { label: 'Import into a move', onClick: () => setStep(3), disabled: convert.matched === 0 }
                          : undefined} />
        </>
      )}
      {step === 3 && canImport && (
        <>
          <ImportStep moveId={moveId} onMove={setMoveId} />
          <WizardFooter onBack={() => setStep(2)} nextLabel="Open the import" nextDisabled={!moveId}
                        onNext={openImport} />
        </>
      )}
    </Chrome>
  );
}
