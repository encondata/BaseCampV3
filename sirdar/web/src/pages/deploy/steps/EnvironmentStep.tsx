/** Step 1: always a new environment — its type and name (and, under
 *  Advanced, the git ref deploys use and the base domain). */
import { useEffect, useRef } from 'react';

import { arrowNav } from '../../../lib/arrowNav';
import { NAME_HELP } from '../../../lib/envRules';
import { KINDS, KIND_LABEL, effectiveDomain, type Errors, type FlowContext, type FlowState } from '../flowState';

export interface StepProps {
  state: FlowState; set: (patch: Partial<FlowState>) => void; errors: Errors; ctx: FlowContext;
}

export default function EnvironmentStep({ state, set, errors, ctx }: StepProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const defaultDomain = effectiveDomain({ ...state, baseDomain: '' }, ctx);
  return (
    <div className="sirdar-flow-grid">
      <div className="sirdar-span2">
        <span className="field-label" id="flow-type-label">Type</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-type-label">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={state.type === k} className={state.type === k ? 'on' : ''}
                    tabIndex={state.type === k ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => { if (state.type !== k) set({ type: k }); }}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="page-hint">
          {state.type === 'production'
            ? 'Production runs on DigitalOcean, as Blue and Green. Only one production is live at a time.'
            : 'Development, UAT and Custom run on any target.'}
        </p>
        {errors.type && <p className="form-error" role="alert">{errors.type}</p>}
      </div>
      <div className="sirdar-span2">
        <label className="field-label" htmlFor="flow-name">Name</label>
        <input id="flow-name" ref={nameRef} type="text" value={state.name} maxLength={64} autoComplete="off" spellCheck={false}
               aria-invalid={!!errors.name} aria-describedby="flow-name-help" onChange={(e) => set({ name: e.target.value })} />
        <p id="flow-name-help" className="page-hint">{NAME_HELP}</p>
        {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
      </div>
      <details className="sirdar-flow-details sirdar-span2" open={!!(errors.gitRef || errors.baseDomain) || undefined}>
        <summary>Advanced</summary>
        <div className="sirdar-flow-grid">
          <div>
            <label className="field-label" htmlFor="flow-ref">Git ref</label>
            <input id="flow-ref" type="text" value={state.gitRef} maxLength={200} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.gitRef} onChange={(e) => set({ gitRef: e.target.value })} />
            <p className="page-hint">The branch, tag or commit deploys use unless you pick another.</p>
            {errors.gitRef && <p className="form-error" role="alert">{errors.gitRef}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="flow-domain">Base domain</label>
            <input id="flow-domain" type="text" value={state.baseDomain} maxLength={253} autoComplete="off" spellCheck={false}
                   placeholder={defaultDomain} aria-invalid={!!errors.baseDomain}
                   onChange={(e) => set({ baseDomain: e.target.value })} />
            <p className="page-hint">Leave empty for {defaultDomain}.</p>
            {errors.baseDomain && <p className="form-error" role="alert">{errors.baseDomain}</p>}
          </div>
        </div>
      </details>
    </div>
  );
}
