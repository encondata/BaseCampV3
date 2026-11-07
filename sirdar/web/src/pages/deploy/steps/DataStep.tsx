/** Step 6: seed from a snapshot or a recipe, or start empty with a first super admin. */
import { useEffect, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';

import { Toggle } from '../../../components/AppsMail';
import { arrowNav } from '../../../lib/arrowNav';
import { snapshotLabel } from '../../environments/labels';
import { getRecipe, notOpen, openSnapshot, resolveSelection, seedErrorText, snapshotStatus } from '../../seed/seedApi';
import type { PkObject, SelectionBody } from '../../seed/selection';
import { OPEN_POLL_MS } from '../../seed/useScratchSnapshot';
import type { FlowState } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const hours = (minutes: number) => (minutes % 60 === 0
  ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`);

type AdminKey = 'adminFirst' | 'adminLast' | 'adminEmail' | 'adminPassword' | 'adminConfirm';

/** The recipe's ticked records (rows tables only: an All rows table takes
 *  whatever the snapshot has) and how many of them the snapshot lacks. */
export function recipeCounts(tables: SelectionBody, missing: Record<string, PkObject[]>) {
  let ticked = 0;
  let gone = 0;
  for (const [name, t] of Object.entries(tables)) {
    if (t.mode !== 'rows') continue;
    ticked += t.pks.length;
    gone += missing[name]?.length ?? 0;
  }
  return { ticked, found: ticked - gone, missing: gone };
}

const n = (v: number) => v.toLocaleString('en-US');

/** The found/missing line for a recipe applied to a snapshot: the snapshot
 *  is opened in the scratch database (polled while it restores, opened
 *  again when the scratch copy is gone), then the recipe is resolved. */
function useRecipeCounts(recipeId: string, snapshotId: string) {
  const [line, setLine] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    setLine(null);
    if (!recipeId || !snapshotId) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => new Promise<void>((done) => { timer = setTimeout(done, OPEN_POLL_MS); });
    const opened = async () => {
      let status = (await openSnapshot(snapshotId)).status;
      while (live && status !== 'ready') {
        if (status === 'failed') throw new Error('restore_failed');
        await wait();
        if (!live) return false;
        status = (await snapshotStatus(snapshotId)).status;
        if (status === 'absent') status = (await openSnapshot(snapshotId)).status;
      }
      return live;
    };
    (async () => {
      try {
        const recipe = await getRecipe(recipeId);
        for (let attempt = 0; ; attempt += 1) {
          if (!(await opened())) return;
          try {
            const r = await resolveSelection(snapshotId, recipe.tables);
            if (!live) return;
            const c = recipeCounts(recipe.tables, r.missing);
            setLine({ text: `${n(c.found)} of ${n(c.ticked)} ticked records found in this snapshot; ${n(c.missing)} missing`,
                      error: false });
            return;
          } catch (e) {
            if (!notOpen(e) || attempt >= 2) throw e;
          }
        }
      } catch (e) {
        if (!live) return;
        setLine({ error: true, text: e instanceof Error && e.message === 'restore_failed'
          ? "This snapshot's database couldn't be opened for browsing."
          : seedErrorText(e, "Couldn't check this snapshot.") });
      }
    })();
    return () => { live = false; clearTimeout(timer); };
  }, [recipeId, snapshotId]);
  return line;
}

export default function DataStep({ state, set, errors, ctx }: StepProps) {
  const fa = ctx.defaults.first_admin;
  const none = ctx.snapshots.length === 0;
  const noRecipe = ctx.recipes.length === 0;
  const production = state.type === 'production';
  const recipeMode = state.dataMode === 'recipe';
  const counts = useRecipeCounts(recipeMode ? state.recipeId : '', recipeMode ? state.recipeSnapshotId : '');
  const input = (id: string, label: string, key: AdminKey, type = 'text', errorId?: string) => (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={state[key]} autoComplete={type === 'password' ? 'new-password' : 'off'}
             spellCheck={false} aria-invalid={errorId ? true : undefined} aria-describedby={errorId}
             onChange={(e) => set({ [key]: e.target.value } as Partial<FlowState>)} />
    </div>
  );
  const nameErr = errors.adminName ? 'flow-admin-name-error' : undefined;
  const emailErr = errors.adminEmail ? 'flow-admin-email-error' : undefined;
  const pwErr = errors.adminPassword ? 'flow-admin-password-error' : undefined;
  const dataError = errors.data && <p className="form-error sirdar-span2" role="alert">{errors.data}</p>;
  /** The first super admin's fields, as Start empty has them (and From a recipe). */
  const adminFields = (showDataError: boolean) => (
    <>
      <p className="page-hint sirdar-span2">The first deploy creates this person as the environment's first super admin.</p>
      {production && (
        <p className="page-hint sirdar-span2">
          On production the first admin's email goes out through SMTP (Extras › Mail), so it never sits in Mailpit on the server.
        </p>
      )}
      {showDataError && dataError}
      {input('flow-admin-first', 'First name', 'adminFirst', 'text', nameErr)}
      {input('flow-admin-last', 'Last name', 'adminLast', 'text', nameErr)}
      {errors.adminName && <p className="form-error sirdar-span2" id="flow-admin-name-error" role="alert">{errors.adminName}</p>}
      <div className="sirdar-span2">
        {input('flow-admin-email', 'Email', 'adminEmail', 'text', emailErr)}
        {errors.adminEmail && <p className="form-error" id="flow-admin-email-error" role="alert">{errors.adminEmail}</p>}
      </div>
      <div className="sirdar-span2">
        <span className="field-label" id="flow-admin-pw-label">Their password</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-admin-pw-label">
          {([['typed', 'Type a password'], ['invite', 'Generate & invite']] as const).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={state.adminPasswordMode === m}
                    className={state.adminPasswordMode === m ? 'on' : ''} tabIndex={state.adminPasswordMode === m ? 0 : -1}
                    onKeyDown={arrowNav} onClick={() => set({ adminPasswordMode: m })}>{label}</button>
          ))}
        </div>
      </div>
      {state.adminPasswordMode === 'typed' ? (
        <>
          {input('flow-admin-password', 'Password', 'adminPassword', 'password', pwErr)}
          {input('flow-admin-confirm', 'Type it again', 'adminConfirm', 'password', pwErr)}
          <p className="page-hint sirdar-span2">
            At least {fa.password_min_length} characters (ServerSherpa's password policy). They get an email with a link to
            change it, valid {hours(fa.link_minutes)}. The password is never emailed.
          </p>
        </>
      ) : (
        <p className="page-hint sirdar-span2">
          Sirdar sends {state.adminEmail.trim() || 'them'} a link to set their password, valid {hours(fa.link_minutes)}.
          No password is ever emailed.
        </p>
      )}
      {errors.adminPassword && <p className="form-error sirdar-span2" id="flow-admin-password-error" role="alert">{errors.adminPassword}</p>}
    </>
  );
  return (
    <div className="sirdar-flow-grid">
      <div className="sirdar-span2">
        <span className="field-label" id="flow-data-label">Data</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-data-label">
          {([['empty', 'Start empty'], ['snapshot', 'From a snapshot'], ['recipe', 'From a recipe']] as const).map(([m, label]) => {
            const locked = (m === 'snapshot' && none) || (m === 'recipe' && (none || noRecipe));
            return (
              <button key={m} type="button" role="radio" aria-checked={state.dataMode === m} aria-disabled={locked || undefined}
                      className={state.dataMode === m ? 'on' : ''} tabIndex={state.dataMode === m ? 0 : -1} onKeyDown={arrowNav}
                      onClick={() => { if (!locked) set({ dataMode: m }); }}>{label}</button>
            );
          })}
        </div>
        {none && <p className="page-hint">No snapshot yet. Upload one or take one in Snapshots below.</p>}
        {!none && noRecipe && <p className="page-hint">No recipe yet. Make one in Seed Data.</p>}
      </div>
      {state.dataMode === 'snapshot' ? (
        <div className="sirdar-span2">
          <label className="field-label" htmlFor="flow-snapshot">Snapshot</label>
          <ComboBox inputId="flow-snapshot" ariaLabel="Snapshot" portal value={state.snapshotId} placeholder="Choose a snapshot…"
                    options={ctx.snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                    onChange={(v) => set({ snapshotId: v })} />
          <p className="page-hint">The first deploy restores its database and files. Its users sign in with their own passwords and 2FA.</p>
          {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
        </div>
      ) : recipeMode ? (
        <>
          <div className="sirdar-span2">
            <label className="field-label" htmlFor="flow-recipe">Recipe</label>
            <ComboBox inputId="flow-recipe" ariaLabel="Recipe" portal value={state.recipeId} placeholder="Choose a recipe…"
                      options={ctx.recipes.map((r) => ({ value: r.id, label: r.name }))}
                      onChange={(v) => set({ recipeId: v })} />
          </div>
          <div className="sirdar-span2">
            <label className="field-label" htmlFor="flow-recipe-snapshot">Snapshot</label>
            <ComboBox inputId="flow-recipe-snapshot" ariaLabel="Snapshot" portal value={state.recipeSnapshotId}
                      placeholder="Choose a snapshot…"
                      options={ctx.snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                      onChange={(v) => set({ recipeSnapshotId: v })} />
            {counts && (counts.error
              ? <p className="form-error" role="alert">{counts.text}</p>
              : <p className="page-hint" role="status">{counts.text}</p>)}
            {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
          </div>
          <div className="sirdar-span2">
            <span className="field-label" id="flow-passwords-label">Passwords</span>
            <div className="segmented" role="radiogroup" aria-labelledby="flow-passwords-label">
              {([[false, 'Keep passwords and 2FA'], [true, 'Make everyone reset their password']] as const).map(([reset, label]) => (
                <button key={label} type="button" role="radio" aria-checked={state.resetPasswords === reset}
                        className={state.resetPasswords === reset ? 'on' : ''} tabIndex={state.resetPasswords === reset ? 0 : -1}
                        onKeyDown={arrowNav} onClick={() => set({ resetPasswords: reset })}>{label}</button>
              ))}
            </div>
            <p className="page-hint">
              Every copied user gets no usable password and their 2FA is cleared; they set new ones from a reset link.
            </p>
          </div>
          {adminFields(false)}
        </>
      ) : (
        <>
          {adminFields(true)}
          <div className="sirdar-span2">
            <Toggle label="Seed starter content" checked={state.seedContent} onChange={(v) => set({ seedContent: v })} />
            <p className="page-hint">
              The first deploy loads the label builder's fonts and templates
              {state.apps.learn ? ', and the sample learning documents' : ''}. Zebra's TT0003M_.TTF still goes in by
              hand (Label builder › Fonts).
            </p>
          </div>
        </>
      )}
    </div>
  );
}
