/** Test fixtures shaped like GET /api/dashboard (demo and real/empty). */
import type { DashboardData, DashFlow, DashNode } from '../../lib/sirdarApi';

/** A card with nothing built (placeholders, and every card until Task 10's fixtures). */
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
  n('env-production', 'Production', 'environment', 'active', [
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
  n('env-dev', 'Development', 'environment', 'inactive', [
    n('dev-web', 'dev-web', 'droplet', 'stopped', [], { dot: 'gray' }),
    n('dev-new', 'dev-new', 'droplet', 'provisioning'),
  ], { dot: 'gray' }),
];

export const DEMO: DashboardData = {
  demo: true,
  generated_at: '2026-10-02T00:52:43Z',
  health: { status: 'healthy', label: 'All systems healthy' },
  production: {
    status: 'active', active_slot: 'blue',
    traffic: { label: 'Live traffic', sub: 'External users' },
    load_balancer: { label: 'Load balancer', sub: 'Blue active', present: true },
    slots: [
      { id: 'blue', label: 'Production Blue', state: 'active', health: 'healthy', version: 'v2.8.0',
        instances: { running: 3, total: 3 }, traffic_pct: 100 },
      { id: 'green', label: 'Production Green', state: 'standby', health: 'unknown', version: 'v2.7.9',
        instances: { running: 0, total: 3 }, traffic_pct: 0 },
    ],
  },
  environments: [
    { id: 'dev', label: 'Development', sub: null, state: 'empty', version: null, last_release: 'v2.8.1-dev',
      last_release_at: null, action_label: 'Deploy to Dev', environment: null,
      production: false, flow: NONE_FLOW },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: 'v2.8.1-rc.2',
      last_release_at: null, action_label: 'Deploy to Beta', environment: null,
      production: false, flow: NONE_FLOW },
  ],
  infrastructure: { source: 'demo', error: null, tree: DEMO_TREE },
};

export const EMPTY: DashboardData = {
  demo: false,
  generated_at: '2026-10-02T00:52:43Z',
  health: { status: 'unknown', label: 'No environments deployed' },
  production: {
    status: 'inactive', active_slot: null,
    traffic: { label: 'Live traffic', sub: 'External users' },
    load_balancer: { label: 'Load balancer', sub: 'Not configured', present: false },
    slots: ['blue', 'green'].map((s) => ({
      id: s, label: `Production ${s[0].toUpperCase()}${s.slice(1)}`, state: 'empty', health: 'unknown',
      version: null, instances: { running: 0, total: 0 }, traffic_pct: 0,
    })),
  },
  environments: [
    { id: 'dev', label: 'Development', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Dev', environment: null,
      production: false, flow: NONE_FLOW },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Beta', environment: null,
      production: false, flow: NONE_FLOW },
    { id: 'qa-east', label: 'Qa East', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Qa East', environment: null,
      production: false, flow: NONE_FLOW },
  ],
  infrastructure: { source: 'none', error: null, tree: [] },
};

/** Real mode with Sirdar environments: uat (dev type, deployed), a Beta
 *  placeholder and a custom environment whose last deploy failed. */
export const REAL: DashboardData = {
  ...EMPTY,
  health: { status: 'degraded', label: 'A deployment failed' },
  environments: [
    { id: 'uat', label: 'uat', sub: 'Development', state: 'active', version: 'e73b99ca', last_release: 'e73b99ca',
      last_release_at: '2026-10-03T12:00:00+00:00', action_label: 'Deploy uat', environment: 'uat',
      production: false, flow: NONE_FLOW },
    { id: 'beta', label: 'Beta', sub: null, state: 'empty', version: null, last_release: null,
      last_release_at: null, action_label: 'Set up Beta', environment: null,
      production: false, flow: NONE_FLOW },
    { id: 'qa-east', label: 'qa-east', sub: 'Custom', state: 'failed', version: null, last_release: null,
      last_release_at: null, action_label: 'Deploy qa-east', environment: 'qa-east',
      production: false, flow: NONE_FLOW },
  ],
};
