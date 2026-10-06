/** Settings of a DigitalOcean environment: Activate automatically
 *  (non-production, two slots), Add a second slot (non-production, one slot),
 *  grow the sizes, and mark a production environment retiring (or un-retire it). */
import { useEffect, useRef, useState } from 'react';

import { Switch } from '@portal/components/Switch';

import {
  addSlot, deployErrorText, updateEnvironment, type Deployment, type DoSizes, type Environment,
} from '../../lib/sirdarApi';

export default function DoSettingsSection({ env, disabled, onSaved, onDeployStarted }: {
  env: Environment; disabled: boolean; onSaved: (env: Environment) => void; onDeployStarted: (dep: Deployment) => void;
}) {
  const d = env.do!;
  const production = env.type === 'production';
  const [droplet, setDroplet] = useState(d.droplet_size);
  const [db, setDb] = useState(d.db_size);
  const [standby, setStandby] = useState(d.db_standby);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const off = busy || disabled;
  // A reload (the page polls while a deploy runs, and a save returns the environment) re-seeds the sizes
  // unless they were edited since the last seed.
  const seed = useRef({ droplet: d.droplet_size, db: d.db_size, standby: d.db_standby });
  const form = useRef({ droplet, db, standby });
  form.current = { droplet, db, standby };
  useEffect(() => {
    const was = seed.current;
    const now = form.current;
    const dirty = now.droplet !== was.droplet || now.db !== was.db || now.standby !== was.standby;
    seed.current = { droplet: d.droplet_size, db: d.db_size, standby: d.db_standby };
    if (!dirty) { setDroplet(d.droplet_size); setDb(d.db_size); setStandby(d.db_standby); }
  }, [d.droplet_size, d.db_size, d.db_standby]);
  // Both sizes are required: an empty one is never sent.
  const missing = !droplet || !db;

  const act = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(deployErrorText(e, fallback)); } finally { setBusy(false); }
  };
  const sizes = (): DoSizes => ({
    ...(droplet !== d.droplet_size ? { droplet_size: droplet } : {}),
    ...(db !== d.db_size ? { db_size: db } : {}),
    ...(standby !== d.db_standby ? { db_standby: standby } : {}),
  });

  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-settings">
      <h2 id="sirdar-do-settings">DigitalOcean</h2>
      <div className="sirdar-docloud-form">
        {!production && env.slots.length === 2 && (
          <div className="sirdar-switch-row sirdar-span2">
            <Switch checked={env.auto_activate} disabled={off} label="Activate automatically"
                    onChange={(on) => void act(async () => onSaved(await updateEnvironment(env.name, { auto_activate: on })),
                                               "Couldn't change that.")} />
            <span aria-hidden="true">Activate automatically: a deploy whose smoke test passes takes traffic by itself</span>
          </div>
        )}
        {!production && env.slots.length === 1 && (
          <div className="sirdar-span2">
            <button type="button" className="mini-btn" disabled={off}
                    onClick={() => void act(async () => {
                      const { environment, deployment } = await addSlot(env.name);
                      onSaved(environment);
                      if (deployment) onDeployStarted(deployment);
                    }, "Couldn't add the slot.")}>Add a second slot</button>
            <p className="page-hint">
              Builds the purple droplet, lets it reach the database, and deploys the running commit to it. Traffic stays
              on orange; then each deploy goes to the idle slot.
            </p>
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="do-droplet-size">Droplet size</label>
          <input id="do-droplet-size" type="text" value={droplet} spellCheck={false} autoComplete="off" disabled={off}
                 required aria-invalid={!droplet} onChange={(e) => setDroplet(e.target.value.trim())} />
        </div>
        <div>
          <label className="field-label" htmlFor="do-db-size">Database size</label>
          <input id="do-db-size" type="text" value={db} spellCheck={false} autoComplete="off" disabled={off}
                 required aria-invalid={!db} onChange={(e) => setDb(e.target.value.trim())} />
        </div>
        <div className="sirdar-switch-row sirdar-span2">
          <Switch checked={standby} disabled={d.db_standby || off} label="Standby node" onChange={setStandby} />
          <span aria-hidden="true">Standby node</span>
        </div>
        <p className="page-hint sirdar-span2">
          Sizes only grow. A bigger droplet size is applied to a slot on its next deploy, and that droplet stops for a few
          minutes{env.slots.length === 1 ? ': with one slot the site is down meanwhile' : ''}.
        </p>
        <div className="sirdar-span2">
          {missing && <p className="form-error">Enter both sizes.</p>}
          <button type="button" className="mini-btn" disabled={off || missing || !Object.keys(sizes()).length}
                  onClick={() => void act(async () => onSaved(await updateEnvironment(env.name, { do: sizes() })),
                                          "Couldn't save the sizes.")}>Save sizes</button>
        </div>
        {production && !env.retiring && (
          <div className="sirdar-span2">
            <label className="field-label" htmlFor="do-retire-confirm">Type {env.name} to confirm</label>
            <input id="do-retire-confirm" type="text" value={confirm} autoComplete="off" spellCheck={false}
                   disabled={off} onChange={(e) => setConfirm(e.target.value)} />
            <button type="button" className="mini-btn danger" disabled={off || confirm !== env.name}
                    onClick={() => void act(async () => {
                      onSaved(await updateEnvironment(env.name, { retiring: true, confirm_name: env.name }));
                      setConfirm('');   // the other action's gate starts empty
                    }, "Couldn't mark it retiring.")}>
              Mark retiring
            </button>
            <p className="page-hint">
              Once another environment serves production's names: a retiring production can be deactivated, then deleted.
            </p>
          </div>
        )}
        {production && env.retiring && (
          <div className="sirdar-span2">
            <p className="page-hint">Retiring. Deactivate it on the Overview, then Delete; or un-retire it to deploy it again.</p>
            <label className="field-label" htmlFor="do-unretire-confirm">Type {env.name} to confirm</label>
            <input id="do-unretire-confirm" type="text" value={confirm} autoComplete="off" spellCheck={false}
                   disabled={off} onChange={(e) => setConfirm(e.target.value)} />
            <button type="button" className="mini-btn" disabled={off || confirm !== env.name}
                    onClick={() => void act(async () => {
                      onSaved(await updateEnvironment(env.name, { retiring: false, confirm_name: env.name }));
                      setConfirm('');   // the other action's gate starts empty
                    }, "Couldn't un-retire it.")}>
              Un-retire
            </button>
          </div>
        )}
        {error && <p className="form-error sirdar-span2" role="alert">{error}</p>}
      </div>
    </section>
  );
}
