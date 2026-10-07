/** Test fixtures shaped like GET /api/dashboard (demo and real/empty). */
import type { DashboardData, DashCert, DashEnvironment, DashFlow, DashNode, DashServer } from '../../lib/sirdarApi';

/** A card with nothing built (a placeholder). */
export const NONE_FLOW: DashFlow = {
  kind: 'none', middle: { label: 'Not built yet', sub: '', status: 'unknown' },
  servers: [{ id: 'none', label: 'Server', sub: 'Not built yet', state: 'empty', health: 'unknown', version: null,
              deployed: false }],
  active_slot: null, certificate: null, deploying_slot: null, failed_slot: null,
};

export function n(id: string, name: string, kind: string, status: string, children: DashNode[] = [],
                  extra: Partial<DashNode> = {}): DashNode {
  return {
    id, name, kind, type_label: kind === 'droplet' ? 'Droplet' : kind, status,
    status_label: status[0].toUpperCase() + status.slice(1), region: 'NYC3', endpoint: '—',
    badge: null, dot: 'green', tone: null, children, ...extra,
  };
}

export const DEMO_TREE: DashNode[] = [
  n('production', 'Production', 'environment', 'active', [
    n('prod-blue', 'Blue', 'deployment', 'active', [
      n('prod-blue-api', 'prod-blue-api', 'droplet', 'running', [], { endpoint: '10.20.0.10' }),
    ]),
    n('prod-green', 'Green', 'deployment', 'standby', [
      n('prod-green-api', 'prod-green-api', 'droplet', 'standby', [], { dot: 'blue' }),
    ], { dot: 'blue' }),
    n('prod-shared', 'Shared production resources', 'group', 'healthy', [
      n('prod-db', 'prod-db', 'database', 'healthy', [], { endpoint: 'prod-db.internal' }),
      n('prod-spaces', 'prod-spaces', 'spaces', 'available'),
    ], { badge: 'Blue + Green', tone: 'shared' }),
  ]),
  n('dev', 'Development', 'environment', 'inactive', [
    n('dev-web', 'dev-web', 'droplet', 'stopped', [], { dot: 'gray' }),
    n('dev-new', 'dev-new', 'droplet', 'provisioning'),
  ], { dot: 'gray' }),
];

const server = (id: string, label: string, sub: string, state: DashServer['state'], health: string,
                version: string | null): DashServer => ({ id, label, sub, state, health, version, deployed: version !== null });
/** Every host of `domain` answering with the same date. */
export const certFor = (domain: string, days: number, expires: string, tone: 'ok' | 'warn' | 'bad' = 'ok'): DashCert => ({
  days_left: days, expires_at: expires, tone,
  hosts: ['api', 'portal'].map((s) => ({ hostname: `${s}.${domain}`, expires_at: expires, days_left: days, error: null })),
});
export const lbFlow = (servers: DashServer[], active: string | null, extra: Partial<DashFlow> = {}): DashFlow => ({
  kind: 'load_balancer', middle: { label: 'Load balancer', sub: '203.0.113.50', status: 'ok' }, servers,
  active_slot: active, certificate: certFor('serversherpa.com', 64, '2026-12-09T12:00:00+00:00'),
  deploying_slot: null, failed_slot: null, ...extra,
});
export const lanFlow = (version: string | null, extra: Partial<DashFlow> = {}): DashFlow => ({
  kind: 'proxy', middle: { label: 'Nginx Proxy Manager', sub: '10.10.48.6', status: 'ok' },
  servers: [server('host', 'Lab box', '10.10.48.63', version ? 'live' : 'empty', version ? 'healthy' : 'unknown', version)],
  active_slot: version ? 'host' : null, certificate: null, deploying_slot: null, failed_slot: null, ...extra,
});
const card = (id: string, label: string, sub: string | null, state: string, version: string | null,
              environment: string | null, production: boolean, flow: DashFlow, action: string,
              primary = false): DashEnvironment => ({
  id, label, sub, state, version, last_release: version, last_release_at: version ? '2026-10-03T12:00:00+00:00' : null,
  action_label: action, environment, production, primary, retiring: false, running: false,
  portal_url: environment ? `https://portal.${environment}.serversherpa.com` : null, flow,
});
export const PLACEHOLDER_PROD = card('production', 'Production', null, 'empty', null, null, true, NONE_FLOW,
                                     'Set up Production', true);
/** A real two-slot production: blue live, green deployed and idle. */
export const PROD_CARD = card('prod', 'prod', 'Production', 'active', 'e73b99ca', 'prod', true, lbFlow([
  server('blue', 'Blue', '203.0.113.11', 'live', 'healthy', 'e73b99ca'),
  server('green', 'Green', '203.0.113.12', 'idle', 'healthy', 'f00dbabe')], 'blue'), 'Deploy prod', true);
/** A two-slot dev environment: orange live, purple idle, its certificate inside 14 days. */
export const DO_CARD = card('uat9', 'uat9', 'Development', 'active', 'e73b99ca', 'uat9', false, lbFlow([
  server('orange', 'Orange', '203.0.113.21', 'live', 'healthy', 'e73b99ca'),
  server('purple', 'Purple', '203.0.113.22', 'idle', 'healthy', 'f00dbabe')], 'orange',
  { certificate: certFor('uat9.serversherpa.com', 10, '2026-10-16T12:00:00+00:00', 'warn') }), 'Deploy uat9');
/** uat9's Activate of purple failed: orange still serves. */
export const FAILED_DO_CARD: DashEnvironment = { ...DO_CARD, state: 'failed', flow: { ...DO_CARD.flow, failed_slot: 'purple' } };
/** A LAN environment behind Nginx Proxy Manager: its portal answers, its kiosk didn't. */
export const LAN_CARD = card('uat', 'uat', 'Development', 'active', 'e73b99ca', 'uat', false, lanFlow('e73b99ca', {
  certificate: { days_left: 47, expires_at: '2026-11-22T12:00:00+00:00', tone: 'ok', hosts: [
    { hostname: 'portal.uat.serversherpa.com', expires_at: '2026-11-22T12:00:00+00:00', days_left: 47, error: null },
    { hostname: 'kiosk.uat.serversherpa.com', expires_at: null, days_left: null, error: 'Timed out' }] },
}), 'Deploy uat');
const placeholder = (id: string, label: string, action: string) =>
  card(id, label, null, 'empty', null, null, false, NONE_FLOW, action);

export const DEMO: DashboardData = {
  demo: true, generated_at: '2026-10-02T00:52:43Z', health: { status: 'healthy', label: 'All systems healthy' },
  environments: [
    { ...PROD_CARD, id: 'production', label: 'Production', environment: null, action_label: 'Deploy production' },
    { ...DO_CARD, id: 'dev', label: 'Development', environment: null, action_label: 'Deploy to Dev' },
    { ...LAN_CARD, label: 'UAT', sub: 'Custom', environment: null, action_label: 'Deploy to UAT' },
  ],
  infrastructure: { source: 'demo', error: null, tree: DEMO_TREE },
};
export const EMPTY: DashboardData = {
  demo: false, generated_at: '2026-10-02T00:52:43Z', health: { status: 'unknown', label: 'No environments deployed' },
  environments: [PLACEHOLDER_PROD, placeholder('dev', 'Development', 'Set up Dev'), placeholder('beta', 'Beta', 'Set up Beta'),
                 placeholder('qa-east', 'Qa East', 'Set up Qa East')],
  infrastructure: { source: 'none', error: null, tree: [], accounts: [] },
};
/** Real mode: no production yet, uat (LAN, deployed), a Beta placeholder, a custom environment whose deploy failed. */
export const REAL: DashboardData = {
  ...EMPTY, health: { status: 'degraded', label: 'A deployment failed' },
  environments: [PLACEHOLDER_PROD, LAN_CARD, placeholder('beta', 'Beta', 'Set up Beta'),
                 card('qa-east', 'qa-east', 'Custom', 'failed', null, 'qa-east', false,
                      lanFlow(null, { failed_slot: 'host' }), 'Deploy qa-east')],
};
/** Real mode with DigitalOcean: production first, then uat9 and uat. */
export const CLOUD: DashboardData = {
  ...EMPTY, health: { status: 'healthy', label: 'Environments deployed' },
  environments: [PROD_CARD, DO_CARD, LAN_CARD],
};

/** The real tree for CLOUD: every environment (card ids, card order), then the
 *  resources Sirdar doesn't manage. */
export const CLOUD_TREE: DashNode[] = [
  n('prod', 'prod', 'environment', 'active', [
    n('prod:lb', 'ss-prod-lb', 'load_balancer', 'active', [], { endpoint: '203.0.113.50' }),
    n('prod:slot-blue', 'Blue (live)', 'droplet', 'running'),
    n('prod:slot-green', 'Green (idle)', 'droplet', 'running'),
  ]),
  n('uat9', 'uat9', 'environment', 'active', [
    n('uat9:slot-orange', 'Orange (live)', 'droplet', 'running'),
    n('uat9:slot-purple', 'Purple (idle)', 'droplet', 'running'),
  ]),
  n('uat', 'uat', 'environment', 'active', [
    n('uat:npm', 'Nginx Proxy Manager', 'proxy', 'active'),
    n('uat:server', 'Lab box', 'server', 'healthy'),
    n('uat:certificate', 'Certificate', 'certificate', 'healthy'),
  ]),
  n('other:production', 'Other DigitalOcean resources', 'group', 'active', [
    n('other:production:droplet-9', 'hand-made', 'droplet', 'running'),
  ]),
];
export const CLOUD_WITH_TREE: DashboardData = {
  ...CLOUD,
  infrastructure: { source: 'digitalocean', error: null, tree: CLOUD_TREE,
                    accounts: [{ key: 'production', label: 'Production', error: null }] },
};
