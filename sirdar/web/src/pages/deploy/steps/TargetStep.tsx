/** Step 3: where Sirdar builds the environment, and that target's details. */
import { arrowNav } from '../../../lib/arrowNav';
import TargetPanel from '../TargetPanel';
import { CONNECT_TYPE, targetChoices, targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const IP_MODES: ['static' | 'dhcp', string][] = [['static', 'Static'], ['dhcp', 'DHCP']];

function Text({ id, label, value, onChange, placeholder, mode, invalid }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  mode?: 'numeric' | 'decimal'; invalid?: boolean;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} placeholder={placeholder} inputMode={mode} autoComplete="off"
             spellCheck={false} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export default function TargetStep({ state, set, errors, ctx, onTargetsChanged }: StepProps & { onTargetsChanged: () => void }) {
  const choices = targetChoices(state, ctx);
  const chosen = choices.find((t) => t.id === state.target);
  const kind = targetKind(state.target);
  const bg = state.servers === 'bluegreen';
  const name = state.name.trim() || '<name>';
  const account = ctx.accounts.find((a) => a.key === state.doAccount);
  const prodReady = !!ctx.accounts.find((a) => a.key === 'production')?.configured;
  const vmBad = !!errors.machine;
  return (
    <>
      <TargetPanel target={state.target} onTarget={(id) => set({ target: id })} connectType={CONNECT_TYPE[state.type]}
                   connectName={state.name} choosable={(id) => choices.some((t) => t.id === id && t.ready)}
                   onTargetsChanged={onTargetsChanged} doAccount={state.doAccount} />
      {chosen && !chosen.ready && <p className="page-hint sirdar-envnote">{chosen.why}</p>}
      {errors.target && <p className="form-error" role="alert">{errors.target}</p>}

      {kind === 'digitalocean' && (
        <div className="sirdar-flow-grid">
          <div className="sirdar-span2">
            <span className="field-label" id="flow-do-account-label">Account</span>
            <div className="segmented" role="radiogroup" aria-labelledby="flow-do-account-label">
              {ctx.accounts.map((a) => {
                // Production lives in the Production account once it's set up (flowState.withRules).
                const locked = state.type === 'production' && prodReady && a.key !== 'production';
                return (
                  <button key={a.key} type="button" role="radio" aria-checked={state.doAccount === a.key}
                          className={state.doAccount === a.key ? 'on' : ''} tabIndex={state.doAccount === a.key ? 0 : -1}
                          disabled={!a.configured} aria-disabled={!a.configured || locked || undefined} onKeyDown={arrowNav}
                          onClick={() => { if (a.configured && !locked && state.doAccount !== a.key) set({ doAccount: a.key }); }}>
                    {a.label}
                  </button>
                );
              })}
            </div>
            <p className="page-hint">{account?.region ? `Built in ${account.region}. ` : ''}An environment stays in the account it is built in.</p>
            {state.type === 'production' && state.doAccount === 'development' && (
              <p className="page-hint" role="note"><span className="chip c-amber">Warning</span>{' '}
                Production in the Development account shares its renewal token with every development droplet. Set up the
                Production account instead if you can.</p>
            )}
          </div>
          <Text id="flow-do-droplet" label="Droplet size" value={state.dropletSize} invalid={!!errors.cloud}
                onChange={(v) => set({ dropletSize: v.trim() })} />
          <Text id="flow-do-db" label="Database size" value={state.dbSize} invalid={!!errors.cloud}
                onChange={(v) => set({ dbSize: v.trim() })} />
          {errors.cloud && <p className="form-error sirdar-span2" role="alert">{errors.cloud}</p>}
        </div>
      )}

      {(kind === 'esxi' || kind === 'proxmox') && (
        <div className="sirdar-flow-grid">
          <p className="page-hint sirdar-span2">
            {bg ? `Sirdar builds three VMs: ss-${name}-data, ss-${name}-orange and ss-${name}-purple. `
              : kind === 'esxi' ? `Sirdar copies the Ubuntu seed VM's disk into a VM named ss-${name} on ESXi. `
                : `Sirdar clones the Ubuntu template into a VM named ss-${name} on Proxmox. `}
            Sizes can grow later in Settings; the network can't change.
          </p>
          <Text id="flow-vm-cores" label={bg ? 'App VM vCPUs' : 'vCPUs'} value={state.cores} mode="numeric" invalid={vmBad}
                onChange={(v) => set({ cores: v })} />
          <Text id="flow-vm-memory" label={bg ? 'App VM memory (GB)' : 'Memory (GB)'} value={state.memoryGb} mode="decimal"
                invalid={vmBad} onChange={(v) => set({ memoryGb: v })} />
          <Text id="flow-vm-disk" label={bg ? 'App VM disk (GB)' : 'Disk (GB)'} value={state.diskGb} mode="numeric"
                invalid={vmBad} onChange={(v) => set({ diskGb: v })} />
          {!bg && (
            <div className="sirdar-span2">
              <span className="field-label" id="flow-vm-net-label">Network</span>
              <div className="segmented" role="radiogroup" aria-labelledby="flow-vm-net-label">
                {IP_MODES.map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={state.ipMode === m} className={state.ipMode === m ? 'on' : ''}
                          tabIndex={state.ipMode === m ? 0 : -1} onKeyDown={arrowNav}
                          onClick={() => { if (state.ipMode !== m) set({ ipMode: m }); }}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {(bg || state.ipMode === 'static') && (
            <>
              <Text id="flow-vm-gateway" label="Gateway" value={state.gateway} placeholder="10.10.48.1" invalid={vmBad}
                    onChange={(v) => set({ gateway: v })} />
              <Text id="flow-vm-ip" label={bg ? 'Orange VM address' : 'Address'} value={state.ipCidr} placeholder="10.10.48.70/24"
                    invalid={vmBad} onChange={(v) => set({ ipCidr: v })} />
            </>
          )}
          {bg && (
            <>
              <Text id="flow-vm-purple" label="Purple VM address" value={state.purpleIpCidr} placeholder="10.10.48.71/24"
                    invalid={vmBad} onChange={(v) => set({ purpleIpCidr: v })} />
              <Text id="flow-vm-data" label="Data VM address" value={state.dataIpCidr} placeholder="10.10.48.72/24"
                    invalid={vmBad} onChange={(v) => set({ dataIpCidr: v })} />
              <Text id="flow-vm-data-cores" label="Data VM vCPUs" value={state.dataCores} mode="numeric" invalid={vmBad}
                    onChange={(v) => set({ dataCores: v })} />
              <Text id="flow-vm-data-memory" label="Data VM memory (GB)" value={state.dataMemoryGb} mode="decimal"
                    invalid={vmBad} onChange={(v) => set({ dataMemoryGb: v })} />
              <Text id="flow-vm-data-disk" label="Data VM disk (GB)" value={state.dataDiskGb} mode="numeric" invalid={vmBad}
                    onChange={(v) => set({ dataDiskGb: v })} />
            </>
          )}
          {errors.machine && <p className="form-error sirdar-span2" role="alert">{errors.machine}</p>}
        </div>
      )}

      {(kind === 'esxi' || kind === 'proxmox' || kind === 'ssh') && (
        <div className="sirdar-flow-grid">
          <div>
            <label className="field-label" htmlFor="flow-proxy">Proxy IP</label>
            <input id="flow-proxy" type="text" value={state.proxyIp} maxLength={45} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.proxyIp} onChange={(e) => set({ proxyIp: e.target.value })} />
            <p className="page-hint">Nginx Proxy Manager's LAN address. The apps trust forwarded headers from it only.</p>
            {errors.proxyIp && <p className="form-error" role="alert">{errors.proxyIp}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="flow-bind">Bind IP</label>
            <input id="flow-bind" type="text" value={state.bindIp} maxLength={45} autoComplete="off" spellCheck={false}
                   aria-invalid={!!errors.bindIp} onChange={(e) => set({ bindIp: e.target.value })} />
            <p className="page-hint">The address the server publishes the service ports on.</p>
            {errors.bindIp && <p className="form-error" role="alert">{errors.bindIp}</p>}
          </div>
        </div>
      )}
    </>
  );
}
