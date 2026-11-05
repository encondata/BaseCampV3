/** Step 4: optional apps, hosting options and integrations. */
import { AppToggles, DigestsField, Field, MailFields, Segmented, Toggle } from '../../../components/AppsMail';
import { targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

export default function ExtrasStep({ state, set, errors, ctx }: StepProps) {
  const onDoTarget = targetKind(state.target) === 'digitalocean';
  const production = state.type === 'production';
  const bg = state.servers === 'bluegreen';
  const canPublish = !!(ctx.integrations?.cloudflare.configured && ctx.integrations?.npm.configured);
  return (
    <>
      <h3 className="sirdar-sub">Apps</h3>
      <AppToggles form={state} onChange={set} error={errors.apps} errorId="flow-apps-error" />
      {state.apps.kiosk && (
        <DigestsField id="flow-digests" value={state.digests} error={errors.digests} onChange={(v) => set({ digests: v })} />
      )}

      <h3 className="sirdar-sub">Hosting</h3>
      {onDoTarget && (
        <div className="sirdar-flow-grid">
          <Toggle label="Standby node" checked={state.dbStandby} onChange={(v) => set({ dbStandby: v })} />
          {!production && (
            <div>
              <Segmented id="flow-cert-label" caption="Certificate" value={state.acmeStaging}
                         options={[[false, "Let's Encrypt"], [true, "Let's Encrypt staging"]] as const}
                         onPick={(v) => set({ acmeStaging: v })} />
              <p className="page-hint">Staging certificates aren't trusted by browsers: for test environments.</p>
            </div>
          )}
        </div>
      )}
      {bg && !production && (
        <>
          <Toggle label="Activate automatically" checked={state.autoActivate} onChange={(v) => set({ autoActivate: v })} />
          <p className="page-hint">On: a deploy whose smoke test passes takes traffic by itself.</p>
        </>
      )}
      {!onDoTarget && !(bg && !production) && <p className="page-hint">Nothing to set for this target.</p>}
      {errors.hosting && <p className="form-error" id="flow-hosting-error" role="alert">{errors.hosting}</p>}

      <h3 className="sirdar-sub">Integrations</h3>
      {onDoTarget ? (
        <p className="page-hint">DigitalOcean environments always publish their DNS records.</p>
      ) : (
        <>
          <Toggle label="Publish DNS" checked={state.publish && canPublish} disabled={!canPublish}
                  onChange={(v) => set({ publish: v })} />
          <p className="page-hint">
            {canPublish
              ? bg ? 'On: each deploy keeps a Cloudflare record for every public name. Sirdar manages the proxy hosts either way.'
                : 'On: each deploy keeps a Cloudflare record and a proxy host for every public name.'
              : 'Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.'}
          </p>
          {errors.publish && <p className="form-error" id="flow-publish-error" role="alert">{errors.publish}</p>}
        </>
      )}
      <MailFields idPrefix="flow" form={state} onChange={set} error={errors.mail} showPassword />
      <Field id="flow-ai-key" label="Anthropic API key" type="password" value={state.aiKey}
             errorId={errors.aiKey ? 'flow-ai-key-error' : undefined} onChange={(v) => set({ aiKey: v })}
             hint="For the Makes / Models spec lookup. Optional. Saved encrypted; never shown again." />
      {errors.aiKey && <p className="form-error" id="flow-ai-key-error" role="alert">{errors.aiKey}</p>}
    </>
  );
}
