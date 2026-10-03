import { useEffect, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';

import {
  createSshTarget, errorText, getSshTarget, listKeyFiles, updateSshTarget,
  type SshTarget, type SshTargetBody,
} from '../lib/sirdarApi';

import SecretField, { type SecretAction } from './SecretField';

type Field = 'name' | 'host' | 'port' | 'user' | 'key' | 'auth' | 'password' | 'passphrase' | 'sudo' | 'form';
type Errors = Partial<Record<Field, string>>;

const NONE = '__none__';
const AUTH_MSG = 'Add a password or choose a key file.';

const CODE_FIELD: Record<string, [Field, string]> = {
  name_invalid: ['name', 'Use up to 64 characters, including at least one letter or number.'],
  name_taken: ['name', 'A target with that name already exists.'],
  host_invalid: ['host', "That host isn't valid. Use a hostname or IP address."],
  port_invalid: ['port', 'Port must be a number from 1 to 65535.'],
  user_invalid: ['user', "That user name isn't valid."],
  key_file_invalid: ['key', "That key file name isn't valid."],
  key_file_not_found: ['key', "That key file isn't in sirdar/deploy-keys/ on the Sirdar host."],
  auth_required: ['auth', AUTH_MSG],
  password_too_long: ['password', 'That password is too long.'],
  passphrase_too_long: ['passphrase', 'That passphrase is too long.'],
  sudo_password_too_long: ['sudo', 'That sudo password is too long.'],
  value_invalid: ['form', "One of the values has a character that can't be saved. Remove line breaks and control characters."],
  targets_file_unwritable: ['form', "Sirdar couldn't save deploy-targets.env. Check that it's writable; see the README."],
};

export default function SshTargetModal({ mode, slug, onSaved, onClose }: {
  mode: 'add' | 'edit'; slug?: string; onSaved: (slug: string) => void; onClose: () => void;
}) {
  const adding = mode === 'add';
  const [loaded, setLoaded] = useState(adding);
  const [loadError, setLoadError] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [saved, setSaved] = useState<SshTarget | null>(null);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [keyFile, setKeyFile] = useState('');
  const [pwAction, setPwAction] = useState<SecretAction>('keep');
  const [pw, setPw] = useState('');
  const [ppAction, setPpAction] = useState<SecretAction>('keep');
  const [pp, setPp] = useState('');
  const [sdAction, setSdAction] = useState<SecretAction>('keep');
  const [sd, setSd] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  savingRef.current = saving;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !savingRef.current) onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    listKeyFiles().then((r) => { if (live) setFiles(r.files); }).catch(() => { /* the picker just stays empty */ });
    if (!adding && slug) {
      getSshTarget(slug).then((t) => {
        if (!live) return;
        setSaved(t); setName(t.name); setHost(t.host); setPort(String(t.port)); setUser(t.user);
        setKeyFile(t.key_path ?? ''); setLoaded(true);
      }).catch((e) => { if (live) setLoadError(errorText(e, "Couldn't load that target.")); });
    }
    return () => { live = false; };
  }, [adding, slug]);

  useEffect(() => { if (loaded) nameRef.current?.focus(); }, [loaded]);

  const pwIsSet = !!saved?.password_set;
  const ppIsSet = !!saved?.passphrase_set;
  const sdIsSet = !!saved?.sudo_password_set;
  const pwNew = adding || pwAction === 'set';
  const ppNew = adding || ppAction === 'set';
  const sdNew = adding || sdAction === 'set';

  const validate = (): Errors => {
    const e: Errors = {};
    if (!name.trim()) e.name = 'Enter a name.';
    else if (name.trim().length > 64) e.name = 'The name can be up to 64 characters.';
    if (!host.trim()) e.host = 'Enter a host.';
    const p = Number(port);
    if (!/^\d+$/.test(port.trim()) || p < 1 || p > 65535) e.port = 'Port must be a number from 1 to 65535.';
    if (!user.trim()) e.user = 'Enter a user.';
    const hasPw = pwNew ? pw !== '' : pwAction === 'keep' && pwIsSet;
    if (pwNew && pw === '' && !adding) e.password = 'Enter a password, or choose Keep to keep the saved one.';
    if (!hasPw && !keyFile) e.auth = AUTH_MSG;
    if (keyFile && ppNew && pp === '' && !adding) e.passphrase = 'Enter a passphrase, or choose Keep to keep the saved one.';
    if (!adding && sdAction === 'set' && sd === '') {
      e.sudo = sdIsSet ? 'Enter a sudo password, or choose Keep to keep the saved one.'
        : 'Enter a sudo password, or choose Keep to leave it unset.';
    }
    return e;
  };

  const save = async () => {
    if (savingRef.current) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Partial<SshTargetBody> = { name: name.trim(), host: host.trim(), port: Number(port), user: user.trim() };
    if (pwNew) { if (pw) body.password = pw; }
    else if (pwAction === 'clear') body.password = '';
    if (keyFile) {
      body.key_path = keyFile;
      if (ppNew) { if (pp) body.key_passphrase = pp; }
      else if (ppAction === 'clear') body.key_passphrase = '';
    } else if (!adding) {
      body.key_path = '';
      if (ppIsSet) body.key_passphrase = '';
    }
    if (sdNew) { if (sd) body.sudo_password = sd; }
    else if (sdAction === 'clear') body.sudo_password = '';
    setSaving(true);
    try {
      const out = adding ? await createSshTarget(body as SshTargetBody) : await updateSshTarget(slug!, body);
      onSaved(out.slug);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const [field, msg] = CODE_FIELD[code] ?? ['form', errorText(err, "Couldn't save the target.")];
      setErrors({ [field]: msg });
      setSaving(false);
    }
  };

  // The saved passphrase belongs to the saved key: picking a different key (or
  // none) defaults it to Clear; picking the saved key again restores Keep.
  const changeKey = (v: string) => {
    const next = v === NONE ? '' : v;
    setKeyFile(next);
    if (adding || !ppIsSet) return;
    if (next !== (saved?.key_path ?? '')) { if (ppAction === 'keep') setPpAction('clear'); }
    else if (ppAction === 'clear') setPpAction('keep');
  };
  const keyChanged = !adding && ppIsSet && keyFile !== '' && keyFile !== (saved?.key_path ?? '');

  const options = [{ value: NONE, label: 'None' },
    ...[...new Set([...files, ...(keyFile ? [keyFile] : [])])].map((f) => ({ value: f, label: f }))];

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-sshtarget-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-sshtarget-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Deploy</div>
            <h3 id="sirdar-sshtarget-title">{adding ? 'Add SSH target' : 'Edit SSH target'}</h3>
            <p className="page-hint">
              Saved to deploy-targets.env on the Sirdar host. Passwords and passphrases are write-only.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={saving} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form className="modal-body pf-form sirdar-sshtarget-form" noValidate
              onSubmit={(e) => { e.preventDefault(); save(); }}>
          {loadError && <p className="form-error" role="alert">{loadError}</p>}
          {!loaded && !loadError && <p className="page-hint">Loading…</p>}
          {loaded && (
            <>
              <div className="sirdar-sshtarget-grid">
                <div className="sirdar-span2">
                  <label className="field-label" htmlFor="ssh-name">Name</label>
                  <input id="ssh-name" ref={nameRef} type="text" value={name} maxLength={200} autoComplete="off"
                         aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
                  {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="ssh-host">Host</label>
                  <input id="ssh-host" type="text" value={host} maxLength={300} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.host} onChange={(e) => setHost(e.target.value)} />
                  {errors.host && <p className="form-error" role="alert">{errors.host}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="ssh-port">Port</label>
                  <input id="ssh-port" type="text" inputMode="numeric" value={port} autoComplete="off"
                         aria-invalid={!!errors.port} onChange={(e) => setPort(e.target.value)} />
                  {errors.port && <p className="form-error" role="alert">{errors.port}</p>}
                </div>
                <div className="sirdar-span2">
                  <label className="field-label" htmlFor="ssh-user">User</label>
                  <input id="ssh-user" type="text" value={user} maxLength={200} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.user} onChange={(e) => setUser(e.target.value)} />
                  {errors.user && <p className="form-error" role="alert">{errors.user}</p>}
                </div>
              </div>

              <h4 className="sirdar-sshtarget-sub">Authentication</h4>
              <SecretField id="ssh-password" label="Password" isSet={pwIsSet} adding={adding} action={pwAction}
                           value={pw} error={errors.password}
                           onAction={setPwAction} onValue={setPw} />
              <div>
                <label className="field-label" htmlFor="ssh-key">Key file</label>
                <ComboBox inputId="ssh-key" ariaLabel="Key file" portal value={keyFile || NONE}
                          options={options} placeholder="None"
                          onChange={changeKey} />
                <p className="page-hint">Put key files in sirdar/deploy-keys/ on the Sirdar host (chmod 600).</p>
                {errors.key && <p className="form-error" role="alert">{errors.key}</p>}
              </div>
              {keyFile && (
                <SecretField id="ssh-passphrase" label="Key passphrase" isSet={ppIsSet} adding={adding}
                             action={ppAction} value={pp} error={errors.passphrase}
                             onAction={setPpAction} onValue={setPp} />
              )}
              {keyFile && keyChanged && ppAction === 'clear' && (
                <p className="page-hint">The saved passphrase belonged to the previous key, so it will be cleared. Choose Replace to enter a new one.</p>
              )}
              <SecretField id="ssh-sudo" label="Sudo password" isSet={sdIsSet} adding={adding} action={sdAction}
                           value={sd} error={errors.sudo} onAction={setSdAction} onValue={setSd} />
              <p className="page-hint">Optional. Deploy steps that need root use it; without one they use the SSH password.</p>
              {errors.auth && <p className="form-error" role="alert">{errors.auth}</p>}
              {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
              <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
            </>
          )}
        </form>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!loaded || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
