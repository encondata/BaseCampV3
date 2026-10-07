/** Fixtures for the Deploy page flow's tests. */
import type { DeployTarget, Integrations } from '../../lib/sirdarApi';
import { DEFAULTS, DO_ACCOUNTS_BOTH, INTEGRATIONS, SNAP } from '../environments/testData';

import type { FlowContext } from './flowState';

export const FLOW_DEFAULTS = {
  ...DEFAULTS,
  apps: { optional: ['wiki', 'kiosk', 'status', 'mailpit'], always: ['api', 'portal'] },
  mail: { smtp_port: 587 },
  first_admin: { password_min_length: 8, role: 'super_admin', link_minutes: 240 },
};
export const FLOW_TARGETS: DeployTarget[] = [
  { id: 'aws', label: 'AWS', kind: 'aws', available: false, configured: false },
  { id: 'gcp', label: 'Google Cloud', kind: 'gcp', available: false, configured: false },
  { id: 'digitalocean', label: 'DigitalOcean', kind: 'digitalocean', available: true, configured: true },
  { id: 'ssh:lab', label: 'Lab box', kind: 'ssh', source: 'saved', available: true, configured: true },
  { id: 'esxi', label: 'VMware ESXi', kind: 'esxi', available: true, configured: true },
  { id: 'proxmox', label: 'Proxmox', kind: 'proxmox', available: true, configured: true },
];
export const FLOW_INTEGRATIONS: Integrations = {
  ...INTEGRATIONS,
  npm: { ...INTEGRATIONS.npm, configured: true, url: 'http://10.10.48.6:81' },
};
export const flowCtx = (over: Partial<FlowContext> = {}): FlowContext => ({
  targets: FLOW_TARGETS, defaults: FLOW_DEFAULTS, integrations: FLOW_INTEGRATIONS,
  accounts: DO_ACCOUNTS_BOTH, snapshots: [SNAP], ...over,
});
