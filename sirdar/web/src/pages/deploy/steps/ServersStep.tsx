/** Step 2: one server, or Blue/Green (two, with Activate moving traffic). */
import { arrowNav } from '../../../lib/arrowNav';
import type { Servers } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const CHOICES: [Servers, string][] = [['single', 'Single server'], ['bluegreen', 'Blue/Green']];

export default function ServersStep({ state, set }: StepProps) {
  const production = state.type === 'production';
  const hint = state.servers === 'single'
    ? 'One server: each deploy updates it in place. SSH targets run a single server.'
    : production ? 'Blue and Green: each deploy goes to the idle one; Activate moves traffic to it.'
      : 'Orange and Purple: each deploy goes to the idle one; Activate (or auto-activate, in Extras) moves traffic to it. '
        + 'On ESXi or Proxmox a third VM holds the data both use.';
  return (
    <div>
      <span className="field-label" id="flow-servers-label">Servers</span>
      <div className="segmented" role="radiogroup" aria-labelledby="flow-servers-label">
        {CHOICES.map(([v, label]) => {
          const locked = production && v === 'single';
          return (
            <button key={v} type="button" role="radio" aria-checked={state.servers === v} aria-disabled={locked || undefined}
                    className={state.servers === v ? 'on' : ''} tabIndex={state.servers === v ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => { if (!locked && v !== state.servers) set({ servers: v }); }}>{label}</button>
          );
        })}
      </div>
      <p className="page-hint">{hint}</p>
      {production && <p className="page-hint">Production always runs Blue and Green.</p>}
    </div>
  );
}
