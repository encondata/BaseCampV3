/** Settings tab: edit the environment record. Changes reach the target on
 *  the next deploy. Optional secrets are write-only. */
import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import SecretField, { type SecretAction } from '../../components/SecretField';
import { ipv4Problem, portProblem, refProblem } from '../../lib/envRules';
import {
  deployErrorText, errorDetail, getEnvironmentDefaults, updateEnvironment,
  type DeployTarget, type Environment, type EnvironmentPatch,
} from '../../lib/sirdarApi';

import { sshTargets, targetLabel } from './labels';

const SECRET_LABELS: Record<string, string> = {
  SS_ANTHROPIC_API_KEY: 'Anthropic API key', SS_DB_TESTING_PASSWORD: 'Database testing password',
};
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
/** API error code → field key. Secret errors use `secret:<KEY>` from the error's `key`. */
const CODE_FIELD: Record<string, string> = {
  ref_invalid: 'ref', target_invalid: 'target', target_not_configured: 'target', base_domain_invalid: 'domain',
  proxy_ip_invalid: 'proxy', bind_ip_invalid: 'bind', keep_dumps_invalid: 'keep', bucket_invalid: 'bucket',
  log_level_invalid: 'level', port_invalid: 'services', host_ip_invalid: 'services', ports_conflict: 'services',
  service_unknown: 'services',
};

type Svc = { host_ip: string; port: string };
function fromEnv(env: Environment) {
  return {
    ref: env.git_ref, target: env.target, domain: env.base_domain, proxy: env.proxy_ip, bind: env.bind_ip,
    keep: String(env.keep_dumps), bucket: env.spaces_bucket, level: env.log_level,
    services: Object.fromEntries(env.services.map((s) => [s.service, { host_ip: s.host_ip, port: String(s.port) }])) as Record<string, Svc>,
  };
}
type Form = ReturnType<typeof fromEnv>;

function TextField({ id, label, value, error, hint, disabled, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string; disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} autoComplete="off" spellCheck={false} disabled={disabled}
             aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function EnvSettings({ env, targets, onSaved }: {
  env: Environment; targets: DeployTarget[]; onSaved: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const locked = !can('deploy', 'change');
  const deploying = env.status === 'deploying';
  const off = locked || deploying;
  const [form, setForm] = useState<Form>(() => fromEnv(env));
  const [secretAction, setSecretAction] = useState<Record<string, SecretAction>>({});
  const [secretValue, setSecretValue] = useState<Record<string, string>>({});
  const [levels, setLevels] = useState<string[]>([env.log_level]);
  const [optional, setOptional] = useState<string[]>(Object.keys(SECRET_LABELS));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // Another environment, or this form's own successful save, resets the form. A
  // reload (the page polls while a deploy runs, and deploys bump updated_at) never
  // does: it would wipe unsaved edits and typed secrets.
  const reset = (from: Environment) => { setForm(fromEnv(from)); setSecretAction({}); setSecretValue({}); };
  useEffect(() => { reset(env); }, [env.name]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    getEnvironmentDefaults().then((d) => { setLevels(d.log_levels); setOptional(d.optional_secrets); }).catch(() => { /* only the current level is offered */ });
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => { setForm((f) => ({ ...f, [key]: value })); setNotice(''); };
  const setSvc = (service: string, key: keyof Svc, value: string) => {
    setForm((f) => ({ ...f, services: { ...f.services, [service]: { ...f.services[service], [key]: value } } }));
    setNotice('');
  };
  const secretKeys = Object.keys(env.secrets_set);
  const ssh = sshTargets(targets).map((t) => ({ value: t.id, label: t.label }));
  const targetOptions = ssh.some((o) => o.value === form.target)
    ? ssh : [{ value: form.target, label: targetLabel(targets, form.target) }, ...ssh];

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const put = (key: string, message: string) => { if (message) e[key] = message; };
    put('ref', refProblem(form.ref));
    put('domain', form.domain.trim() ? '' : 'Enter a base domain.');
    put('proxy', ipv4Problem(form.proxy, 'proxy IP'));
    put('bind', ipv4Problem(form.bind, 'bind IP'));
    const keep = Number(form.keep);
    put('keep', /^\d+$/.test(form.keep.trim()) && keep >= 1 && keep <= 100 ? '' : 'Keep 1 to 100 dumps.');
    put('bucket', BUCKET_RE.test(form.bucket.trim()) ? ''
      : "That bucket name isn't valid (3–63 lowercase letters, numbers, dots and hyphens).");
    for (const s of env.services) {
      const v = form.services[s.service];
      const problem = ipv4Problem(v.host_ip, `${s.service} address`) || (portProblem(v.port) && `${s.service}: ${portProblem(v.port)}`);
      if (problem) { e.services = problem; break; }
    }
    if (!e.services) {
      const used = env.services.map((s) => Number(form.services[s.service].port));
      if (new Set(used).size !== used.length) e.services = "Two services can't use the same port.";
    }
    for (const key of secretKeys) {
      if (!optional.includes(key) || secretAction[key] !== 'set') continue;
      const v = secretValue[key] ?? '';
      put(`secret:${key}`, !v ? 'Enter a value, or choose Keep.'
        : SECRET_RE.test(v) ? '' : 'Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.');
    }
    return e;
  };

  const patchOf = (): EnvironmentPatch => {
    const t = (s: string) => s.trim();
    const patch: EnvironmentPatch = {};
    if (t(form.ref) !== env.git_ref) patch.git_ref = t(form.ref);
    if (form.target !== env.target) patch.target = form.target;
    if (t(form.domain) !== env.base_domain) patch.base_domain = t(form.domain);
    if (t(form.proxy) !== env.proxy_ip) patch.proxy_ip = t(form.proxy);
    if (t(form.bind) !== env.bind_ip) patch.bind_ip = t(form.bind);
    if (Number(form.keep) !== env.keep_dumps) patch.keep_dumps = Number(form.keep);
    if (t(form.bucket) !== env.spaces_bucket) patch.spaces_bucket = t(form.bucket);
    if (form.level !== env.log_level) patch.log_level = form.level;
    const services: NonNullable<EnvironmentPatch['services']> = {};
    for (const s of env.services) {
      const v = form.services[s.service];
      const change: { port?: number; host_ip?: string } = {};
      if (Number(v.port) !== s.port) change.port = Number(v.port);
      if (t(v.host_ip) !== s.host_ip) change.host_ip = t(v.host_ip);
      if (Object.keys(change).length) services[s.service] = change;
    }
    if (Object.keys(services).length) patch.services = services;
    const secrets: Record<string, string> = {};
    for (const key of secretKeys.filter((k) => optional.includes(k))) {
      if (secretAction[key] === 'set') secrets[key] = secretValue[key] ?? '';
      else if (secretAction[key] === 'clear') secrets[key] = '';
    }
    if (Object.keys(secrets).length) patch.secrets = secrets;
    return patch;
  };

  const save = async () => {
    if (saving) return;
    const e = validate();
    setErrors(e);
    setNotice('');
    if (Object.keys(e).length) return;
    const patch = patchOf();
    if (Object.keys(patch).length === 0) { setNotice('Nothing to save.'); return; }
    setSaving(true);
    try {
      const saved = await updateEnvironment(env.name, patch);
      onSaved(saved);
      reset(saved);
      setNotice('Saved. The next deploy applies these settings.');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const key = errorDetail<{ key?: string }>(err)?.key;
      const field = code.startsWith('secret_') && key ? `secret:${key}` : CODE_FIELD[code] ?? 'form';
      setErrors({ [field]: deployErrorText(err, "Couldn't save the settings.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="sirdar-section">
      {locked && <p className="page-hint">You can view these settings but not change them.</p>}
      {!locked && deploying && <p className="page-hint">Settings can't change while a deployment is running.</p>}
      <div className="pf-form sirdar-env-grid">
        <TextField id="env-set-ref" label="Default git ref" value={form.ref} error={errors.ref} disabled={off}
                   onChange={(v) => set('ref', v)} />
        <div>
          <label className="field-label" htmlFor="env-set-target">Target</label>
          <ComboBox inputId="env-set-target" ariaLabel="Target" portal value={form.target} options={targetOptions}
                    disabled={off} onChange={(v) => set('target', v)} />
          {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
        </div>
        <TextField id="env-set-domain" label="Base domain" value={form.domain} error={errors.domain} disabled={off}
                   hint={'Each service is named <service>.<base domain>.'} onChange={(v) => set('domain', v)} />
        <TextField id="env-set-proxy" label="Proxy IP" value={form.proxy} error={errors.proxy} disabled={off}
                   onChange={(v) => set('proxy', v)} />
        <TextField id="env-set-bind" label="Bind IP" value={form.bind} error={errors.bind} disabled={off}
                   onChange={(v) => set('bind', v)} />
        <TextField id="env-set-keep" label="Dumps to keep" value={form.keep} error={errors.keep} disabled={off}
                   hint="Pre-deploy database dumps kept on the target." onChange={(v) => set('keep', v)} />
        <TextField id="env-set-bucket" label="Spaces bucket" value={form.bucket} error={errors.bucket} disabled={off}
                   onChange={(v) => set('bucket', v)} />
        <div>
          <label className="field-label" htmlFor="env-set-level">Log level</label>
          <ComboBox inputId="env-set-level" ariaLabel="Log level" portal value={form.level} disabled={off}
                    options={levels.map((l) => ({ value: l, label: l }))} onChange={(v) => set('level', v)} />
          {errors.level && <p className="form-error" role="alert">{errors.level}</p>}
        </div>
      </div>

      <h3 className="sirdar-sub">Services</h3>
      <DataTable
        ariaLabel="Service addresses"
        columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                  { key: 'addr', label: 'Address', width: '200px' }, { key: 'port', label: 'Port', width: '120px' }]}
        rows={env.services.map((s) => ({
          key: s.service,
          cells: [
            <b className="cell-top">{s.service}</b>,
            s.hostname ?? '—',
            <input type="text" aria-label={`${s.service} address`} value={form.services[s.service]?.host_ip ?? ''}
                   disabled={off} onChange={(e) => setSvc(s.service, 'host_ip', e.target.value)} />,
            <input className="sirdar-port-input" type="text" inputMode="numeric" aria-label={`${s.service} port`}
                   value={form.services[s.service]?.port ?? ''} disabled={off}
                   onChange={(e) => setSvc(s.service, 'port', e.target.value)} />,
          ],
        }))}
      />
      {errors.services && <p className="form-error" role="alert">{errors.services}</p>}

      <h3 className="sirdar-sub">Secrets</h3>
      <p className="page-hint">Write-only. Sirdar generated the others and never shows them.</p>
      <div className="pf-form">
        {secretKeys.map((key) => (
          <SecretField key={key} id={`env-secret-${key}`} label={SECRET_LABELS[key] ?? key}
                       isSet={env.secrets_set[key]} adding={false} action={secretAction[key] ?? 'keep'}
                       value={secretValue[key] ?? ''} error={errors[`secret:${key}`]} disabled={off || !optional.includes(key)}
                       onAction={(a) => { setSecretAction((m) => ({ ...m, [key]: a })); setNotice(''); }}
                       onValue={(v) => setSecretValue((m) => ({ ...m, [key]: v }))} />
        ))}
      </div>

      {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
      {notice && <p className="page-hint" role="status">{notice}</p>}
      {!locked && (
        <div className="sirdar-actions">
          <button type="button" className="btn-solid" disabled={saving || deploying} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </section>
  );
}
