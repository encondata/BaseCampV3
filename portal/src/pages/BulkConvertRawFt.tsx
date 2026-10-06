/**
 * BulkConvertRawFt — /bulk/convert-raw-ft: Convert Raw F-T in three steps
 * (Upload, Match, Download), the same WizardHeader / WizardFooter chrome as
 * Create a move in steps. Our template's columns come from the server (they
 * are the guide and the match targets); the state lives in useRawFtConvert
 * for the whole session, so Back keeps everything. Nothing is uploaded or
 * saved, so there is no draft and no leave prompt.
 * Specs: docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md,
 *        docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md
 */
import { useEffect, useState, type ReactNode } from 'react';

import DownloadStep from '../components/bulk/rawFt/DownloadStep';
import MatchStep from '../components/bulk/rawFt/MatchStep';
import { RAW_FT_STEPS } from '../components/bulk/rawFt/steps';
import UploadStep from '../components/bulk/rawFt/UploadStep';
import { useRawFtConvert } from '../components/bulk/rawFt/useRawFtConvert';
import WizardFooter from '../components/common/WizardFooter';
import WizardHeader from '../components/common/WizardHeader';
import { ApiError, getMoveAssetTemplateColumns, type MoveAssetTemplateColumn } from '../lib/api';

export default function BulkConvertRawFt() {
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
    ? <Chrome step={0}>
        {failed === 'forbidden' ? <p className="pf-error">This tool needs company-wide access to moves. Ask an administrator.</p>
          : failed ? <p className="pf-error">Couldn't load our template columns. Reload the page to try again.</p>
          : <p className="page-hint">Loading our template columns…</p>}
      </Chrome>
    : <RawFtWizard template={columns} />;
}

function Chrome({ step, children }: { step: number; children: ReactNode }) {
  const meta = RAW_FT_STEPS[step]!;
  return (
    <div className="portal-page">
      <WizardHeader steps={RAW_FT_STEPS} current={step} title={meta.title} description={meta.description} />
      <div className="wiz-body">{children}</div>
    </div>
  );
}

function RawFtWizard({ template }: { template: MoveAssetTemplateColumn[] }) {
  const convert = useRawFtConvert(template);
  const [step, setStep] = useState(0);
  return (
    <Chrome step={step}>
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
                        onNext={convert.download} nextDisabled={convert.matched === 0} />
        </>
      )}
    </Chrome>
  );
}
