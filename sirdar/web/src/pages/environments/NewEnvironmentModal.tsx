/** New environment: Create (Basics › Services › Data › Review) makes a new
 *  environment record with generated secrets, empty or seeded from a snapshot
 *  its first deploy restores; on Proxmox a Machine step sizes the VM the
 *  first deploy builds and sets its address. Adopt (Basics › Result) reads a
 *  hand-built environment's .env and checkout over SSH and changes nothing. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { arrowNav } from '../../lib/arrowNav';
import { NAME_HELP, ipv4Problem, nameProblem, portProblem, refProblem } from '../../lib/envRules';
import {
  adoptEnvironment, createEnvironment, deployErrorText, getDeployTargets, getEnvironmentDefaults, getIntegrations,
  listSnapshots,
  type AdoptEnvironmentBody, type AdoptedEnvironment, type DeployTarget, type EnvType, type Environment,
  type EnvironmentDefaults, type NewEnvironmentBody, type Snapshot,
} from '../../lib/sirdarApi';

import { TYPE_LABEL, envTargets, gbOf, mbOf, snapshotLabel, sshTargets, vmNetwork, vmSize } from './labels';

type Mode = 'new' | 'adopt';
type Step = 'basics' | 'machine' | 'services' | 'data' | 'review' | 'result';
type DataMode = 'empty' | 'snapshot';
type IpMode = 'static' | 'dhcp';
type Field = 'name' | 'target' | 'ref' | 'domain' | 'proxy' | 'bind' | 'machine' | 'services' | 'data' | 'form';
type Errors = Partial<Record<Field, string>>;
/** One submission, kept whole so a host-key retry replays exactly what failed. */
type Attempt = { mode: 'new'; body: NewEnvironmentBody } | { mode: 'adopt'; body: AdoptEnvironmentBody };

const TYPES: EnvType[] = ['dev', 'beta', 'custom'];
const MODES: [Mode, string][] = [['new', 'Create new'], ['adopt', 'Adopt existing']];
const STEPS: Record<Mode, [Step, string][]> = {
  new: [['basics', 'Basics'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review']],
  adopt: [['basics', 'Basics'], ['result', 'Result']],
};
const PROXMOX_STEPS: [Step, string][] = [
  ['basics', 'Basics'], ['machine', 'Machine'], ['services', 'Services'], ['data', 'Data'], ['review', 'Review'],
];
const IP_MODES: [IpMode, string][] = [['static', 'Static'], ['dhcp', 'DHCP']];
const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
// The API's messages for vm_ip_invalid and vm_gateway_invalid.
const VM_IP_HELP = 'Use an address with its prefix, like 10.10.48.70/24.';
const VM_GATEWAY_HELP = "The gateway must be another address in the VM's network.";
/** Memory in GB with at most one decimal (what vmSize shows), so Review matches the request. */
const toInt = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);

/** The API's check_network for a static address, on the client: '' when the API would accept it. */
function vmNetworkProblem(cidr: string, gw: string): string {
  const m = CIDR_RE.exec(cidr.trim());
  const prefix = m ? Number(m[2]) : 0;
  if (!m || ipv4Problem(m[1], 'address') || prefix < 8 || prefix > 30) return VM_IP_HELP;
  const ip = toInt(m[1]);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const first = ip >>> 24;
  // network or broadcast, 0.0.0.0/8 (unspecified too), loopback, link-local, multicast and reserved (240/4)
  if (ip === network || ip === broadcast || first === 0 || first === 127 || first >= 224
      || (ip >>> 16) === 0xa9fe) return VM_IP_HELP;
  if (ipv4Problem(gw, 'gateway')) return VM_GATEWAY_HELP;
  const g = toInt(gw.trim());
  if (((g & mask) >>> 0) !== network || g === ip || g === network || g === broadcast) return VM_GATEWAY_HELP;
  return '';
}
const DATA_MODES: [DataMode, string][] = [['empty', 'Start empty'], ['snapshot', 'From a snapshot']];
type PublishChoice = 'on' | 'off';
const PUBLISH_CHOICES: [PublishChoice, string][] = [['on', 'On'], ['off', 'Off']];
const HINT: Record<Mode, string> = {
  new: 'Create an environment on an SSH target, or on a VM Sirdar builds on Proxmox. Sirdar generates its secrets; '
    + 'the first deploy builds it.',
  adopt: "Adopt an environment set up by hand. Sirdar reads its .env and git checkout over SSH and changes nothing.",
};
/** API error code → the field (and so the step) it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  name_invalid: 'name', name_reserved: 'name', environment_exists: 'name',
  target_invalid: 'target', target_not_configured: 'target', ref_invalid: 'ref',
  base_domain_invalid: 'domain', proxy_ip_required: 'proxy', proxy_ip_invalid: 'proxy',
  bind_ip_invalid: 'bind', port_invalid: 'services', ports_conflict: 'services', service_unknown: 'services',
  snapshot_not_found: 'data', snapshot_not_ready: 'data',
  integration_not_configured: 'target', adopt_not_allowed: 'target', vm_not_allowed: 'target',
  vm_cores_invalid: 'machine', vm_memory_invalid: 'machine', vm_disk_invalid: 'machine',
  vm_ip_mode_invalid: 'machine', vm_ip_invalid: 'machine', vm_gateway_invalid: 'machine', ip_in_use: 'machine',
};
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

export default function NewEnvironmentModal({ onCreated, onClose }: {
  onCreated: (env: Environment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [defaults, setDefaults] = useState<EnvironmentDefaults | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<Mode>('new');
  const [step, setStep] = useState<Step>('basics');
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvType>('dev');
  const [target, setTarget] = useState('');
  const [ref, setRef] = useState('main');
  const [domain, setDomain] = useState('');
  const [proxy, setProxy] = useState('');
  const [bind, setBind] = useState('0.0.0.0');
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [dataMode, setDataMode] = useState<DataMode>('empty');
  const [snapshotId, setSnapshotId] = useState('');
  const [publish, setPublish] = useState<PublishChoice>('on');
  const [cores, setCores] = useState('4');
  const [memoryGb, setMemoryGb] = useState('8');
  const [diskGb, setDiskGb] = useState('64');
  const [ipMode, setIpMode] = useState<IpMode>('static');
  const [ipCidr, setIpCidr] = useState('');
  const [gateway, setGateway] = useState('');
  // Both integrations set up (null until known). Without them Publish starts Off.
  const [canPublish, setCanPublish] = useState<boolean | null>(null);
  const publishChosen = useRef(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdoptedEnvironment | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: mode === 'new' ? 'Trust and create' : 'Trust and adopt',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: (message) => setErrors({ form: message }),
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  // The form is inert while the host-key modal is open. A layout effect, so inert is
  // lifted before HostKeyModal's passive cleanup hands focus back to its opener.
  // (@types/react 18 has no `inert` prop, hence the attribute.)
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    // Snapshots are optional: without them the Data step offers "Start empty" only.
    const snaps = listSnapshots().then((r) => r.snapshots.filter((s) => s.status === 'ready'))
      .catch(() => [] as Snapshot[]);
    Promise.all([getDeployTargets(), getEnvironmentDefaults(), snaps]).then(([t, d, ready]) => {
      if (!live) return;
      setSnapshots(ready);
      const usable = envTargets(t.targets);
      setTargets(usable);
      setDefaults(d);
      setTarget((cur) => cur || usable[0]?.id || '');
      setCores(String(d.vm.cores));
      setMemoryGb(gbOf(d.vm.memory_mb));
      setDiskGb(String(d.vm.disk_gb));
      setRef(d.git_ref);
      setBind(d.bind_ip);
      setPorts(Object.fromEntries(d.services.map((s) => [s.service, String(s.port)])));
    }).catch((e) => { if (live) setLoadError(deployErrorText(e, "Couldn't load the targets and defaults.")); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    getIntegrations().then((i) => {
      if (!live) return;
      const ready = i.cloudflare.configured && i.npm.configured;
      setCanPublish(ready);
      if (!publishChosen.current) setPublish(ready ? 'on' : 'off');
    }).catch(() => { /* the API's default (on) stands; a deploy says what's missing */ });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (defaults) nameRef.current?.focus(); }, [defaults]);
  // After a failed create or adopt, focus goes back to the Name (or, on a step
  // without it, the step's main button) once nothing else holds it: not while the
  // host-key prompt is open (its cleanup refocuses its opener first, and this
  // effect runs after that cleanup), and not while a replay is running.
  const refocus = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refocus.current || hostKey.open || busy) return;
    refocus.current = false;
    (nameRef.current ?? cardRef.current?.querySelector<HTMLElement>('.modal-foot .btn-solid'))?.focus();
  });

  const trimmed = name.trim();
  const services = defaults?.services ?? [];
  const effectiveDomain = domain.trim() || `${trimmed || '<name>'}.${defaults?.domain_suffix ?? 'serversherpa.com'}`;
  const targetName = (id: string) => targets?.find((t) => t.id === id)?.label ?? id;
  const onVm = mode === 'new' && target === 'proxmox';
  // Adopt reads a hand-built environment over SSH: Proxmox environments are only ones Sirdar builds.
  const offered = (targets ?? []).filter((t) => mode === 'new' || t.id !== 'proxmox');
  useEffect(() => {
    if (mode === 'adopt' && target === 'proxmox') setTarget(sshTargets(targets ?? [])[0]?.id ?? '');
  }, [mode, target, targets]);
  const limits = defaults?.vm.limits;
  const machine = { cores: Number(cores), memory_mb: mbOf(memoryGb), disk_gb: Number(diskGb),
                    ip_mode: ipMode, ip_cidr: ipCidr.trim() || null, gateway: gateway.trim() || null };

  const basicsErrors = (): Errors => only({
    name: trimmed ? nameProblem(trimmed) : 'Enter a name.',
    target: target ? '' : 'Choose a target.',
    ref: refProblem(ref),
    proxy: mode === 'new' ? ipv4Problem(proxy, 'proxy IP') : '',
    bind: mode === 'new' ? ipv4Problem(bind, 'bind IP') : '',
  });
  const servicesErrors = (): Errors => {
    for (const s of services) {
      const p = portProblem(ports[s.service] ?? '');
      if (p) return { services: `${s.service}: ${p}` };
    }
    const used = services.map((s) => Number(ports[s.service]));
    return new Set(used).size === used.length ? {} : { services: "Two services can't use the same port." };
  };

  const machineErrors = (): Errors => {
    if (!limits) return {};
    const inRange = (n: number, [low, high]: [number, number]) => n >= low && n <= high;
    const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : NaN);
    if (!inRange(whole(cores), limits.cores)) {
      return { machine: `Use ${limits.cores[0]} to ${limits.cores[1]} vCPUs.` };
    }
    if (!/^\d+(\.\d)?$/.test(memoryGb.trim()) || !inRange(mbOf(memoryGb), limits.memory_mb)) {
      return { machine: `Use ${gbOf(limits.memory_mb[0])} to ${gbOf(limits.memory_mb[1])} GB of memory.` };
    }
    if (!inRange(whole(diskGb), limits.disk_gb)) {
      return { machine: `Use a disk of ${limits.disk_gb[0]} to ${limits.disk_gb[1]} GB.` };
    }
    if (ipMode === 'dhcp') return {};
    const problem = vmNetworkProblem(ipCidr, gateway);
    return problem ? { machine: problem } : {};
  };

  const dataErrors = (): Errors => (dataMode === 'snapshot' && !snapshotId ? { data: 'Choose a snapshot.' } : {});
  // Only a snapshot the Data step still says to use: going Back to "Start empty" keeps
  // snapshotId but must not show (or send) it.
  const chosen = dataMode === 'snapshot' ? snapshots.find((s) => s.id === snapshotId) : undefined;

  const next = () => {
    const e = step === 'basics' ? basicsErrors() : step === 'machine' ? machineErrors()
      : step === 'services' ? servicesErrors() : dataErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    setStep(step === 'basics' ? (onVm ? 'machine' : 'services') : step === 'machine' ? 'services'
      : step === 'services' ? 'data' : 'review');
  };
  const back = () => {
    setErrors({});
    setStep(step === 'review' ? 'data' : step === 'data' ? 'services'
      : step === 'services' ? (onVm ? 'machine' : 'basics') : 'basics');
  };

  const fail = (err: unknown, attempt: Attempt) => {
    if (hostKey.handle(err, attempt.body.target, attempt)) return;
    const code = (err as { code?: string }).code ?? '';
    const field = CODE_FIELD[code] ?? 'form';
    setErrors({ [field]: deployErrorText(err, attempt.mode === 'new' ? "Couldn't create the environment." : "Couldn't adopt the environment.") });
    if (field === 'data') {
      // The snapshot is gone or no longer ready: clear the pick and stop offering it.
      const gone = attempt.mode === 'new' ? attempt.body.snapshot_id : undefined;
      setSnapshotId('');
      setSnapshots((list) => list.filter((s) => s.id !== gone));
    }
    if (field === 'services' || field === 'data' || field === 'machine') setStep(field);
    else if (field !== 'form') setStep('basics');
  };

  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    refocus.current = false;
    setBusy(true);
    setErrors({});
    try {
      if (attempt.mode === 'new') {
        onCreated(await createEnvironment(attempt.body));
        return;
      }
      setResult(await adoptEnvironment(attempt.body));
      setStep('result');
    } catch (err) {
      refocus.current = true;
      fail(err, attempt);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    if (busyRef.current) return;
    if (mode === 'adopt') {
      const e = basicsErrors();
      setErrors(e);
      if (Object.keys(e).length) return;
      void run({ mode, body: { name: trimmed, type, target, git_ref: ref.trim() } });
      return;
    }
    void run({ mode, body: {
      name: trimmed, type, target, git_ref: ref.trim(),
      ...(domain.trim() ? { base_domain: domain.trim() } : {}),
      proxy_ip: proxy.trim(), bind_ip: bind.trim(),
      ports: Object.fromEntries(services.map((s) => [s.service, Number(ports[s.service])])),
      ...(chosen ? { snapshot_id: chosen.id } : {}),
      publish: publish === 'on',
      ...(onVm ? { vm: {
        cores: machine.cores, memory_mb: machine.memory_mb, disk_gb: machine.disk_gb, ip_mode: ipMode,
        ...(ipMode === 'static' ? { ip_cidr: ipCidr.trim(), gateway: gateway.trim() } : {}),
      } } : {}),
    } });
  };

  const stepList = onVm ? PROXMOX_STEPS : STEPS[mode];
  const at = stepList.findIndex(([s]) => s === step);

  const radios = <T extends string>(items: [T, string][], value: T, set: (v: T) => void) => items.map(([v, label]) => (
    <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''}
            tabIndex={value === v ? 0 : -1} onKeyDown={arrowNav}
            onClick={() => { set(v); setErrors({}); }}>{label}</button>
  ));

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-envmodal-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-envmodal-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deploy</div>
              <h3 id="sirdar-envmodal-title">New environment</h3>
              <p className="page-hint">{HINT[mode]}</p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="rgm-steps">
            {stepList.map(([s, label], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rgm-step-sep" />}
                <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}>
                  <span className="rgm-step-num">{i + 1}</span>
                  <span className="rgm-step-label">{label}</span>
                </span>
              </Fragment>
            ))}
          </div>

          <div className="modal-body pf-form">
            {loadError && <p className="form-error" role="alert">{loadError}</p>}
            {!defaults && !loadError && <p className="page-hint">Loading…</p>}

            {defaults && step === 'basics' && (
              <div className="sirdar-env-grid">
                <div className="sirdar-span2">
                  <span className="field-label" id="env-mode-label">How to add it</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-mode-label">
                    {radios(MODES, mode, setMode)}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-name">Name</label>
                  <input id="env-new-name" ref={nameRef} type="text" value={name} maxLength={64} autoComplete="off"
                         spellCheck={false} aria-invalid={!!errors.name} aria-describedby="env-new-name-help"
                         onChange={(e) => setName(e.target.value)} />
                  <p id="env-new-name-help" className="page-hint">{NAME_HELP}</p>
                  {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
                </div>
                <div>
                  <span className="field-label" id="env-type-label">Type</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-type-label">
                    {radios(TYPES.map((t) => [t, TYPE_LABEL[t]] as [EnvType, string]), type, setType)}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-target">Target</label>
                  <ComboBox inputId="env-new-target" ariaLabel="Target" portal value={target}
                            placeholder="Choose a target…"
                            options={offered.map((t) => ({ value: t.id, label: t.label }))}
                            onChange={setTarget} />
                  {targets && offered.length === 0 && (
                    <p className="page-hint">
                      No target is ready. Add an SSH target under Target on the Deploy page, or set up Proxmox in
                      Settings › Integrations.
                    </p>
                  )}
                  {onVm && <p className="page-hint">Sirdar builds a VM for it on Proxmox on the first deploy.</p>}
                  {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="env-new-ref">Git ref</label>
                  <input id="env-new-ref" type="text" value={ref} maxLength={200} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.ref} onChange={(e) => setRef(e.target.value)} />
                  <p className="page-hint">The branch, tag or commit deploys use unless you pick another.</p>
                  {errors.ref && <p className="form-error" role="alert">{errors.ref}</p>}
                </div>
                {mode === 'new' && (
                  <>
                    <div>
                      <label className="field-label" htmlFor="env-new-domain">Base domain</label>
                      <input id="env-new-domain" type="text" value={domain} maxLength={253} autoComplete="off"
                             spellCheck={false} placeholder={effectiveDomain} aria-invalid={!!errors.domain}
                             onChange={(e) => setDomain(e.target.value)} />
                      <p className="page-hint">Leave empty for {effectiveDomain}.</p>
                      {errors.domain && <p className="form-error" role="alert">{errors.domain}</p>}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-new-proxy">Proxy IP</label>
                      <input id="env-new-proxy" type="text" value={proxy} maxLength={45} autoComplete="off"
                             spellCheck={false} aria-invalid={!!errors.proxy} onChange={(e) => setProxy(e.target.value)} />
                      <p className="page-hint">Nginx Proxy Manager's LAN address. The apps trust forwarded headers from it only.</p>
                      {errors.proxy && <p className="form-error" role="alert">{errors.proxy}</p>}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-new-bind">Bind IP</label>
                      <input id="env-new-bind" type="text" value={bind} maxLength={45} autoComplete="off"
                             spellCheck={false} aria-invalid={!!errors.bind} onChange={(e) => setBind(e.target.value)} />
                      <p className="page-hint">The address the target publishes the service ports on.</p>
                      {errors.bind && <p className="form-error" role="alert">{errors.bind}</p>}
                    </div>
                  </>
                )}
              </div>
            )}

            {defaults && step === 'machine' && (
              <div className="sirdar-env-grid">
                <p className="page-hint sirdar-span2">
                  Sirdar clones the Ubuntu template into a VM named ss-{trimmed} on Proxmox, then deploys to it. Sizes
                  can grow later in Settings; the network can't change.
                </p>
                <div>
                  <label className="field-label" htmlFor="env-vm-cores">vCPUs</label>
                  <input id="env-vm-cores" type="text" inputMode="numeric" value={cores}
                         onChange={(e) => setCores(e.target.value)} />
                </div>
                <div>
                  <label className="field-label" htmlFor="env-vm-memory">Memory (GB)</label>
                  <input id="env-vm-memory" type="text" inputMode="decimal" value={memoryGb}
                         onChange={(e) => setMemoryGb(e.target.value)} />
                </div>
                <div>
                  <label className="field-label" htmlFor="env-vm-disk">Disk (GB)</label>
                  <input id="env-vm-disk" type="text" inputMode="numeric" value={diskGb}
                         onChange={(e) => setDiskGb(e.target.value)} />
                </div>
                <div className="sirdar-span2">
                  <span className="field-label" id="env-vm-net-label">Network</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-vm-net-label">
                    {radios(IP_MODES, ipMode, setIpMode)}
                  </div>
                  <p className="page-hint">
                    {ipMode === 'static'
                      ? 'A fixed LAN address: the proxy hosts forward to it, so it should never move.'
                      : "The router's DHCP gives it an address; reserve it there so the proxy hosts keep working."}
                  </p>
                </div>
                {ipMode === 'static' && (
                  <>
                    <div>
                      <label className="field-label" htmlFor="env-vm-ip">Address</label>
                      <input id="env-vm-ip" type="text" value={ipCidr} placeholder="10.10.48.70/24" autoComplete="off"
                             spellCheck={false} onChange={(e) => setIpCidr(e.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="env-vm-gateway">Gateway</label>
                      <input id="env-vm-gateway" type="text" value={gateway} placeholder="10.10.48.1"
                             autoComplete="off" spellCheck={false} onChange={(e) => setGateway(e.target.value)} />
                    </div>
                  </>
                )}
                {errors.machine && <p className="form-error sirdar-span2" role="alert">{errors.machine}</p>}
              </div>
            )}

            {defaults && step === 'services' && (
              <>
                <p className="page-hint">
                  Every service runs on the chosen target. Public names point at the proxy; mailpit stays on the LAN.
                </p>
                <div>
                  <span className="field-label" id="env-publish-label">Publish DNS and proxy</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-publish-label">
                    {radios(PUBLISH_CHOICES, publish, (v) => { publishChosen.current = true; setPublish(v); })}
                  </div>
                  <p className="page-hint">
                    {publish === 'on'
                      ? 'Each deploy creates or updates a DNS record and a proxy host for every public name (Settings › '
                        + 'Integrations has the credentials). Hand-made records or proxy hosts already at those names '
                        + 'must be claimed on the Publish tab first.'
                      : 'DNS records and proxy hosts stay as they are: set them up by hand, or turn Publish on later.'}
                  </p>
                  {canPublish === false && (
                    <p className="page-hint">
                      Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.
                    </p>
                  )}
                </div>
                <DataTable
                  ariaLabel="Services"
                  columns={[
                    { key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                    { key: 'addr', label: 'Address' }, { key: 'port', label: 'Port', width: '120px' },
                  ]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [
                      <b className="cell-top">{s.service}</b>,
                      s.public ? `${s.service}.${effectiveDomain}` : '—',
                      <span className="cell-sub">{onVm ? "The VM's address" : "Target's address"}</span>,
                      <input className="sirdar-port-input" type="text" inputMode="numeric" aria-label={`${s.service} port`}
                             value={ports[s.service] ?? ''}
                             onChange={(e) => setPorts((p) => ({ ...p, [s.service]: e.target.value }))} />,
                    ],
                  }))}
                />
                {errors.services && <p className="form-error" role="alert">{errors.services}</p>}
              </>
            )}

            {defaults && step === 'data' && (
              <div className="sirdar-env-grid">
                <div className="sirdar-span2">
                  <span className="field-label" id="env-data-label">Data</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-data-label">
                    {DATA_MODES.map(([m, label]) => {
                      const locked = m === 'snapshot' && snapshots.length === 0;
                      return (
                        <button key={m} type="button" role="radio" aria-checked={dataMode === m} aria-disabled={locked}
                                className={dataMode === m ? 'on' : ''} tabIndex={dataMode === m ? 0 : -1}
                                onKeyDown={arrowNav}
                                onClick={() => { if (!locked) { setDataMode(m); setErrors({}); } }}>{label}</button>
                      );
                    })}
                  </div>
                  <p className="page-hint">
                    {dataMode === 'empty'
                      ? 'The first deploy starts an empty database; create its first admin afterward.'
                      : "The first deploy restores the snapshot's database and files. Its users sign in with their own passwords and 2FA."}
                  </p>
                  {snapshots.length === 0 && (
                    <p className="page-hint">No snapshot yet. Upload one or take one in Snapshots on the Deploy page.</p>
                  )}
                </div>
                {dataMode === 'snapshot' && (
                  <div className="sirdar-span2">
                    <label className="field-label" htmlFor="env-new-snapshot">Snapshot</label>
                    <ComboBox inputId="env-new-snapshot" ariaLabel="Snapshot" portal value={snapshotId}
                              placeholder="Choose a snapshot…"
                              options={snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                              onChange={(v) => { setSnapshotId(v); setErrors({}); }} />
                    {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
                  </div>
                )}
              </div>
            )}

            {defaults && step === 'review' && (
              <>
                <dl className="sirdar-kv">
                  <dt>Name</dt><dd className="mono">{trimmed}</dd>
                  <dt>Type</dt><dd>{TYPE_LABEL[type]}</dd>
                  <dt>Target</dt><dd>{targetName(target)}</dd>
                  {onVm && (
                    <>
                      <dt>Machine</dt>
                      <dd>{`${vmSize(machine)} · ${vmNetwork(machine)}`}</dd>
                    </>
                  )}
                  <dt>Git ref</dt><dd className="mono">{ref.trim()}</dd>
                  <dt>Folder on the target</dt><dd className="mono">{`${defaults.env_root}/${trimmed}`}</dd>
                  <dt>Base domain</dt><dd className="mono">{effectiveDomain}</dd>
                  <dt>Proxy IP</dt><dd className="mono">{proxy.trim()}</dd>
                  <dt>Bind IP</dt><dd className="mono">{bind.trim()}</dd>
                  <dt>Secrets</dt><dd>Generated by Sirdar and never shown</dd>
                  <dt>Data</dt>
                  <dd>{chosen ? `Snapshot ${chosen.name} (migration ${chosen.alembic_revision ?? '—'}), restored by the first deploy` : 'Empty'}</dd>
                  <dt>Publishing</dt>
                  <dd>{publish === 'on' ? 'On: Sirdar publishes the public names' : 'Off: DNS and the proxy are set up by hand'}</dd>
                </dl>
                <h4 className="sirdar-sub">Services</h4>
                <DataTable
                  ariaLabel="Services to create"
                  columns={[{ key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
                            { key: 'port', label: 'Port', mono: true },
                            { key: 'pub', label: 'DNS record and proxy host' }]}
                  rows={services.map((s) => ({
                    key: s.service,
                    cells: [<b className="cell-top">{s.service}</b>, s.public ? `${s.service}.${effectiveDomain}` : '—',
                            ports[s.service], s.public && publish === 'on' ? 'On the first deploy' : '—'],
                  }))}
                />
                <p className="page-hint">
                  {publish === 'on'
                    ? 'Nothing is installed until the first deploy, which also publishes the public names.'
                    : 'Nothing is installed until the first deploy. DNS records and proxy hosts are set up by hand.'}
                </p>
              </>
            )}

            {step === 'result' && result && (
              <>
                <p>Adopted <b>{result.name}</b>. Nothing on the target was changed.</p>
                <dl className="sirdar-kv">
                  <dt>Running commit</dt><dd className="mono">{result.current_sha ?? '—'}</dd>
                  <dt>Image tag</dt><dd className="mono">{result.image_tag ?? '—'}</dd>
                  <dt>Base domain</dt><dd className="mono">{result.base_domain}</dd>
                  <dt>Folder</dt><dd className="mono">{result.env_dir}</dd>
                </dl>
                <h4 className="sirdar-sub">Imported secrets</h4>
                <div className="sirdar-chips">
                  {result.imported_secrets.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                </div>
                <h4 className="sirdar-sub">Ignored keys</h4>
                {result.ignored_keys.length ? (
                  <>
                    <div className="sirdar-chips">
                      {result.ignored_keys.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                    </div>
                    <p className="page-hint">Sirdar doesn't use these. The next deploy writes the .env without them.</p>
                  </>
                ) : <p className="page-hint">None. Sirdar knows every key in that .env.</p>}
              </>
            )}

            {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          </div>

          <div className="modal-foot">
            {step === 'result' ? (
              <button type="button" className="btn-solid" onClick={() => { if (result) onCreated(result); }}>Open environment</button>
            ) : (
              <>
                <button type="button" className="btn-ghost" disabled={busy} onClick={step === 'basics' ? onClose : back}>
                  {step === 'basics' ? 'Cancel' : 'Back'}
                </button>
                {mode === 'adopt' ? (
                  <button type="button" className="btn-solid" disabled={!defaults || busy} onClick={submit}>
                    {busy ? 'Adopting…' : 'Adopt'}
                  </button>
                ) : step === 'review' ? (
                  <button type="button" className="btn-solid" disabled={busy} onClick={submit}>
                    {busy ? 'Creating…' : 'Create environment'}
                  </button>
                ) : (
                  <button type="button" className="btn-solid" disabled={!defaults} onClick={next}>Next</button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
