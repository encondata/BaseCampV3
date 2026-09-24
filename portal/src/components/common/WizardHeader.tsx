/**
 * WizardHeader — the page-level header every multi-screen tool shares: an
 * eyebrow, "Step x of N · Title", a one-line description, and the numbered
 * step row in Generate Report's `rgm-steps` look (done / current / upcoming).
 */
import { Fragment } from 'react';

import '../../styles/reports.css';   // rgm-steps / rgm-step
import '../../styles/wizard.css';

export interface WizardStep { key: string; label: string }

interface Props {
  steps: readonly WizardStep[];
  current: number;            // 0-based
  title: string;
  description: string;
  allDone?: boolean;
  eyebrow?: string;
}

export default function WizardHeader({
  steps, current, title, description, allDone = false, eyebrow = 'Bulk Actions',
}: Props) {
  return (
    <div className="wiz-top">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="page-title">Step {current + 1} of {steps.length} · {title}</h1>
      <p className="page-hint">{description}</p>
      <div className="rgm-steps wiz-steps">
        {steps.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && <span className="rgm-step-sep" />}
            <span className={`rgm-step ${i === current && !allDone ? 'on' : ''} ${
              i < current || allDone ? 'done' : ''}`}
                  aria-current={i === current ? 'step' : undefined}>
              <span className="rgm-step-num">{i + 1}</span>
              <span className="rgm-step-label">{s.label}</span>
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
