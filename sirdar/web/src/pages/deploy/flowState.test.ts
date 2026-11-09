import { describe, expect, it } from 'vitest';

import { SWITCHYARD_ON } from '../environments/testData';

import { FLOW_INTEGRATIONS, flowCtx } from './flowFixtures';
import {
  CODE_FIELD, FIELD_STEP, FLOW_STEPS, buildBody, canPublish, initialState, nextStep, prevStep, stepErrors, stepOfCode,
  targetChoices, trafficPlan, vmNetworkProblem, withProxy, withRules, type FlowState,
} from './flowState';

const ctx = flowCtx();
const base = (over: Partial<FlowState> = {}) => withRules({ ...initialState(ctx), ...over }, ctx);
const ssh = (over: Partial<FlowState> = {}) => base({
  name: 'qa', type: 'custom', target: 'ssh:lab', proxyIp: '10.10.48.6', adminFirst: 'Ada', adminLast: 'Lovelace',
  adminEmail: 'ada@test.example.com', adminPassword: 'Correct-Horse-9', adminConfirm: 'Correct-Horse-9', ...over,
});

describe('the proxy', () => {
  const both = flowCtx({ integrations: { ...FLOW_INTEGRATIONS, switchyard: SWITCHYARD_ON } });
  it('preselects Switchyard, and its address', () => {
    const s = initialState(both);
    expect([s.proxy, s.proxyIp, s.publish]).toEqual(['switchyard', '10.10.48.8', true]);
  });
  it('preselects Nginx Proxy Manager when only it is set up', () => {
    expect(initialState(ctx).proxy).toBe('npm');
    const none = flowCtx({ integrations: { ...FLOW_INTEGRATIONS, npm: { ...FLOW_INTEGRATIONS.npm, configured: false } } });
    expect(initialState(none).proxy).toBe('switchyard');
  });
  it('a choice moves a prefilled Proxy IP and keeps a typed one', () => {
    const s = initialState(both);
    expect(withProxy(s, both, 'npm')).toEqual({ proxy: 'npm', publish: true, proxyIp: '10.10.48.6' });
    expect(withProxy({ ...s, proxyIp: '10.0.0.9' }, both, 'npm')).toEqual({ proxy: 'npm', publish: true });
    expect(withProxy({ ...s, publish: false }, both, 'npm').publish).toBe(false);     // as chosen
  });
  it('Publish needs Cloudflare and the chosen proxy', () => {
    const s = initialState(both);
    expect(canPublish(s, both)).toBe(true);
    expect(canPublish({ ...s, proxy: 'switchyard' }, ctx)).toBe(false);
    expect(canPublish({ ...s, proxy: 'npm' }, ctx)).toBe(true);
  });
  it('goes in the create body and the traffic plan', () => {
    const s = { ...ssh(), proxy: 'switchyard' as const };
    expect(buildBody(s, both).proxy).toBe('switchyard');
    expect(trafficPlan(s, both).rows[0].via).toBe('Switchyard (10.10.48.6)');
    expect(buildBody({ ...s, target: 'digitalocean' }, both).proxy).toBeUndefined();
  });
  it('Blue/Green needs the chosen proxy set up', () => {
    const s = base({ servers: 'bluegreen', target: 'esxi', proxy: 'switchyard' });
    expect(stepErrors('target', s, ctx).proxy).toBe(
      'Blue/Green switches traffic with the proxy: set up Switchyard in Settings › Integrations, or choose the other one.');
    expect(stepErrors('target', { ...s, proxy: 'npm' }, ctx).proxy).toBeUndefined();
    expect(stepOfCode('proxy_invalid')).toBe('target');
  });
});

describe('the steps', () => {
  it('are the spec seven, in order', () => {
    expect(FLOW_STEPS.map(([, label]) => label)).toEqual(
      ['Environment', 'Servers', 'Target', 'Extras', 'Traffic', 'Data', 'Review & Deploy']);
    expect(nextStep('environment')).toBe('servers');
    expect(prevStep('servers')).toBe('environment');
    expect(nextStep('review')).toBe('review');
  });
});

describe('initial state', () => {
  it('starts from the defaults and the NPM address', () => {
    const s = initialState(ctx);
    expect([s.gitRef, s.bindIp, s.cores, s.memoryGb, s.diskGb, s.dropletSize, s.smtpPort]).toEqual(
      ['main', '0.0.0.0', '4', '8', '64', 's-2vcpu-4gb', '587']);
    expect(s.proxyIp).toBe('10.10.48.6');
    expect(s.apps).toEqual({ wiki: true, kiosk: true, learn: true, status: true, mailpit: true });
    expect(s.publish).toBe(true);
  });
  it('starts Publish off without both integrations', () => {
    const s = initialState(flowCtx({ integrations: { ...ctx.integrations!, npm: { ...ctx.integrations!.npm, configured: false } } }));
    expect(s.publish).toBe(false);
  });
});

describe('rules', () => {
  it('production offers only DigitalOcean and Blue/Green', () => {
    const s = base({ type: 'production', servers: 'single', target: 'ssh:lab', autoActivate: true, acmeStaging: true });
    expect([s.servers, s.target, s.autoActivate, s.acmeStaging, s.doAccount]).toEqual(
      ['bluegreen', '', false, false, 'production']);
    expect(targetChoices(s, ctx).map((t) => t.id)).toEqual(['digitalocean']);
  });
  it('Blue/Green never offers SSH', () => {
    expect(targetChoices(base({ servers: 'bluegreen' }), ctx).map((t) => t.id)).toEqual(
      ['esxi', 'proxmox', 'digitalocean']);
    expect(base({ servers: 'bluegreen', target: 'ssh:lab' }).target).toBe('');
  });
  it('a Blue/Green VM needs NPM to be ready', () => {
    const noNpm = flowCtx({ integrations: { ...ctx.integrations!, npm: { ...ctx.integrations!.npm, configured: false } } });
    const esxi = targetChoices(base({ servers: 'bluegreen' }), noNpm).find((t) => t.id === 'esxi')!;
    expect(esxi.ready).toBe(false);
    expect(esxi.why).toMatch(/Nginx Proxy Manager/);
  });
});

describe('checks', () => {
  it('environment and target', () => {
    expect(stepErrors('environment', base(), ctx)).toEqual({ name: 'Enter a name.' });
    expect(stepErrors('environment', base({ name: 'Bad Name' }), ctx).name).toMatch(/lowercase/);
    expect(stepErrors('environment', base({ name: 'qa', gitRef: '' }), ctx).gitRef).toBe('Enter a branch, tag or commit.');
    expect(stepErrors('target', ssh({ proxyIp: 'x' }), ctx).proxyIp).toBe('The proxy IP must be an IPv4 address.');
    expect(stepErrors('target', ssh({ target: '' }), ctx).target).toBe('Choose a target.');
    expect(stepErrors('target', ssh(), ctx)).toEqual({});
  });
  it('a VM, single and Blue/Green', () => {
    const vm = ssh({ target: 'esxi', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1' });
    expect(stepErrors('target', vm, ctx)).toEqual({});
    expect(stepErrors('target', { ...vm, cores: '99' }, ctx).machine).toBe('Use 1 to 64 vCPUs.');
    expect(stepErrors('target', { ...vm, ipMode: 'dhcp', ipCidr: '', gateway: '' }, ctx)).toEqual({});
    const bg = withRules({ ...vm, servers: 'bluegreen', purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24' }, ctx);
    expect(stepErrors('target', bg, ctx)).toEqual({});
    expect(stepErrors('target', { ...bg, purpleIpCidr: '10.10.48.70/24' }, ctx).machine)
      .toBe('The data VM and the two app VMs need three different addresses.');
    expect(stepErrors('target', { ...bg, ipMode: 'dhcp' }, ctx).machine)
      .toBe('Blue/Green needs a static address for each of the three VMs.');
    expect(stepErrors('target', { ...bg, dataIpCidr: '10.10.48.72/16' }, ctx).machine)
      .toBe('The data VM and the two app VMs need addresses on the same network.');
  });
  it('the network like the API', () => {
    expect(vmNetworkProblem('10.10.48.70/24', '10.10.48.1')).toBe('');
    expect(vmNetworkProblem('10.10.48.0/24', '10.10.48.1')).toMatch(/prefix/);
    expect(vmNetworkProblem('10.10.48.70/24', '10.10.49.1')).toMatch(/gateway/);
  });
  it('extras: SMTP and Mailpit', () => {
    const smtp = ssh({ mailMode: 'smtp', smtpHost: 'smtp.example.com', smtpFrom: 'ops@example.com' });
    expect(stepErrors('extras', smtp, ctx)).toEqual({});
    expect(stepErrors('extras', { ...smtp, smtpHost: '' }, ctx).mail).toBe("Enter the SMTP server's host name or address.");
    expect(stepErrors('extras', { ...smtp, smtpPassword: 'has space' }, ctx).mail).toMatch(/can't be saved/);
    expect(stepErrors('extras', ssh({ apps: { wiki: true, kiosk: true, learn: true, status: true, mailpit: false } }), ctx).apps)
      .toBe('Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.');
    expect(stepErrors('extras', ssh({ aiKey: 'with space' }), ctx).aiKey).toMatch(/can't be saved/);
  });
  it('extras: the From address refuses what the user name refuses', () => {
    const smtp = ssh({ mailMode: 'smtp', smtpHost: 'smtp.example.com', smtpFrom: 'ops@example.com' });
    for (const bad of ['o$ps@example.com', 'o"ps@example.com', "o'ps@example.com", 'o`ps@example.com', 'o#ps@example.com',
                       'o\\ps@example.com', 'o\u0001ps@example.com', 'ops@exa\u2028mple.com', 'o ps@example.com', 'ops@example.com\tx'])
      expect(stepErrors('extras', { ...smtp, smtpFrom: bad }, ctx).mail, bad).toBeTruthy();
    expect(stepErrors('extras', { ...smtp, smtpFrom: 'no-reply+ops@mail.example.com' }, ctx)).toEqual({});
  });
  it('data: the first admin against the policy hint, never a rule of our own', () => {
    expect(stepErrors('data', ssh(), ctx)).toEqual({});
    expect(stepErrors('data', ssh({ adminPassword: 'short', adminConfirm: 'short' }), ctx).adminPassword)
      .toBe('Use at least 8 characters (ServerSherpa\'s password policy).');
    expect(stepErrors('data', ssh({ adminConfirm: 'Different-Horse-9' }), ctx).adminPassword)
      .toBe("The two passwords don't match.");
    expect(stepErrors('data', ssh({ adminPasswordMode: 'invite', adminPassword: '', adminConfirm: '' }), ctx)).toEqual({});
    expect(stepErrors('data', ssh({ adminEmail: 'nope' }), ctx).adminEmail).toMatch(/valid email/);
    expect(stepErrors('data', ssh({ adminPassword: '         ', adminConfirm: '         ' }), ctx).adminPassword)
      .toMatch(/at least 8/);   // all-whitespace counts as none, like first_admins.check
    expect(stepErrors('data', ssh({ dataMode: 'snapshot', snapshotId: '' }), ctx).data).toBe('Choose a snapshot.');
  });
});

describe('the create body', () => {
  it('SSH: proxy, bind, publish, default ports, the first admin, no vm', () => {
    expect(buildBody(ssh(), ctx)).toEqual({
      name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy: 'npm', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
      publish: true, ports: { api: 8000, portal: 8091, kiosk: 8090, wiki: 8096, learn: 8092, spaces: 9000, status: 8095, mailpit: 8025 },
      apps: ['wiki', 'kiosk', 'learn', 'status', 'mailpit'], mail: { mode: 'mailpit' },
      first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'typed',
                     password: 'Correct-Horse-9' },
    });
  });
  it('a snapshot body has no first admin; an invite has no password', () => {
    expect(buildBody(ssh({ dataMode: 'snapshot', snapshotId: 's1' }), ctx)).toMatchObject({ snapshot_id: 's1' });
    expect(buildBody(ssh({ dataMode: 'snapshot', snapshotId: 's1' }), ctx).first_admin).toBeUndefined();
    expect(buildBody(ssh({ adminPasswordMode: 'invite' }), ctx).first_admin).toEqual({
      first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com', password_mode: 'invite', password: null });
  });
  it('a single VM, DHCP sends no address', () => {
    expect(buildBody(ssh({ target: 'esxi', ipMode: 'dhcp' }), ctx).vm).toEqual(
      { cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'dhcp' });
  });
  it('Blue/Green VMs', () => {
    const s = withRules(ssh({ target: 'proxmox', servers: 'bluegreen', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1',
                              purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24', autoActivate: true }), ctx);
    expect(buildBody(s, ctx).vm).toEqual({
      cores: 4, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1',
      slots: 2, purple_ip_cidr: '10.10.48.71/24', data_ip_cidr: '10.10.48.72/24',
      data: { cores: 4, memory_mb: 8192, disk_gb: 64 }, auto_activate: true });
  });
  it('DigitalOcean: one droplet, two slots, production', () => {
    const one = buildBody(ssh({ target: 'digitalocean', doAccount: 'development' }), ctx);
    expect(one.do).toEqual({ account: 'development', slots: 1, droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb',
                             db_standby: false, acme_staging: false });
    expect(one.proxy_ip).toBeUndefined();
    const prod = buildBody(withRules(ssh({ type: 'production', target: 'digitalocean' }), ctx), ctx);
    expect(prod.do).toEqual({ account: 'production', droplet_size: 's-2vcpu-4gb', db_size: 'db-s-2vcpu-4gb', db_standby: false });
  });
  it('SMTP, apps off and the AI key', () => {
    const body = buildBody(ssh({ apps: { wiki: false, kiosk: true, learn: false, status: false, mailpit: false }, mailMode: 'smtp',
                                 smtpHost: 'smtp.example.com', smtpPort: '2525', smtpUsername: 'mailer',
                                 smtpPassword: 'Mail-Secret-1', smtpFrom: 'ops@example.com', aiKey: 'sk-ant-1' }), ctx);
    expect([body.apps, body.mail, body.secrets]).toEqual([['kiosk'], {
      mode: 'smtp', host: 'smtp.example.com', port: 2525, username: 'mailer', password: 'Mail-Secret-1',
      from_address: 'ops@example.com', starttls: true }, { SS_ANTHROPIC_API_KEY: 'sk-ant-1' }]);
  });
});

describe('errors', () => {
  it('every code maps to a step', () => {
    for (const [code, field] of Object.entries(CODE_FIELD)) expect(FIELD_STEP[field], code).toBeTruthy();
    expect(stepOfCode('vm_name_invalid')).toBe('environment');
    expect(stepOfCode('base_domain_not_in_zone')).toBe('environment');
    expect(stepOfCode('ip_in_use')).toBe('target');
    expect(stepOfCode('integration_not_configured')).toBe('target');
    expect(stepOfCode('smtp_from_invalid')).toBe('extras');
    expect(stepOfCode('first_admin_password_too_short')).toBe('data');
    expect(stepOfCode('snapshot_not_ready')).toBe('data');
    expect(stepOfCode('vm_name_taken')).toBe('environment');
    expect(stepOfCode('vm_subnet_mismatch')).toBe('target');
    expect(stepOfCode('vm_static_required')).toBe('target');
    expect(stepOfCode('bluegreen_not_allowed')).toBe('target');
    expect(stepOfCode('first_admin_email_invalid')).toBe('data');
    expect(stepOfCode('mailpit_required')).toBe('extras');
    expect(stepOfCode('smtp_required_for_first_admin')).toBe('data');
    expect(stepOfCode('first_admin_required')).toBe('data');
    expect(stepOfCode('something_else')).toBe('review');
  });
});

describe('traffic', () => {
  it('LAN: each public app through NPM to the first server; spaces to the data VM', () => {
    const s = withRules(ssh({ target: 'esxi', servers: 'bluegreen', ipCidr: '10.10.48.70/24', gateway: '10.10.48.1',
                              purpleIpCidr: '10.10.48.71/24', dataIpCidr: '10.10.48.72/24',
                              apps: { wiki: false, kiosk: true, learn: false, status: true, mailpit: true } }), ctx);
    const plan = trafficPlan(s, ctx);
    expect(plan.kind).toBe('proxy');
    expect(plan.rows.map((r) => [r.hostname, r.to])).toEqual([
      ['api.qa.serversherpa.com', '10.10.48.70:8000'], ['portal.qa.serversherpa.com', '10.10.48.70:8091'],
      ['kiosk.qa.serversherpa.com', '10.10.48.70:8090'], ['spaces.qa.serversherpa.com', '10.10.48.72:9000'],
      ['status.qa.serversherpa.com', '10.10.48.70:8095']]);
  });
  it('DigitalOcean: the load balancer, no spaces name', () => {
    const plan = trafficPlan(ssh({ target: 'digitalocean' }), ctx);
    expect(plan.kind).toBe('load_balancer');
    expect(plan.rows.map((r) => r.hostname)).not.toContain('spaces.qa.serversherpa.com');
  });
});

describe('learn, digests and seeding', () => {
  it('learning without the wiki is an Extras error; a bad digest too', () => {
    const ctx = flowCtx();
    expect(stepErrors('extras', ssh({ apps: { wiki: false, kiosk: true, learn: true, status: true, mailpit: true } }), ctx).apps)
      .toBe('The learning site needs the wiki: turn the wiki on, or turn learning off.');
    expect(stepErrors('extras', ssh({ digests: 'nope' }), ctx).digests)
      .toBe('Each digest is a SHA-256: 64 hex characters, colons allowed.');
    expect(stepOfCode('learn_needs_wiki')).toBe('extras');
    expect(stepOfCode('signing_digest_invalid')).toBe('extras');
  });
  it('the body carries learn and the digests', () => {
    const body = buildBody(ssh({ digests: 'AB:'.repeat(31) + 'AB' }), flowCtx());
    expect(body.apps).toEqual(['wiki', 'kiosk', 'learn', 'status', 'mailpit']);
    expect(body.kiosk_signing_digests).toEqual(['ab'.repeat(32)]);
    expect(buildBody(ssh(), flowCtx())).not.toHaveProperty('kiosk_signing_digests');
  });
  it('starts with every app on and seeding on', () => {
    const s = initialState(flowCtx());
    expect(s.apps.learn && s.seedContent).toBe(true);
    expect(s.digests).toBe('');
  });
});

describe('From a recipe', () => {
  const NO_ADMIN = { adminFirst: '', adminLast: '', adminEmail: '', adminPassword: '', adminConfirm: '' };
  const recipe = (over: Partial<FlowState> = {}) =>
    ssh({ dataMode: 'recipe', recipeId: 'r1', recipeSnapshotId: 's1', ...over });
  it('starts on Keep passwords and 2FA', () => {
    const s = initialState(ctx);
    expect([s.recipeId, s.recipeSnapshotId, s.resetPasswords]).toEqual(['', '', false]);
  });
  it('needs a recipe and a snapshot', () => {
    expect(stepErrors('data', recipe({ recipeId: '' }), ctx)).toEqual({ recipe: 'Choose a recipe.' });
    expect(stepErrors('data', recipe({ recipeSnapshotId: '' }), ctx).data).toBe('Choose a snapshot.');
    expect(stepErrors('data', recipe(), ctx)).toEqual({});
  });
  it('the first super admin is optional when keeping passwords, required when resetting', () => {
    expect(stepErrors('data', recipe(NO_ADMIN), ctx)).toEqual({});
    expect(stepErrors('data', recipe({ ...NO_ADMIN, adminEmail: 'nope' }), ctx).adminEmail).toMatch(/valid email/);
    const reset = stepErrors('data', recipe({ ...NO_ADMIN, resetPasswords: true }), ctx);
    expect(reset.adminName).toBeTruthy();
    expect(reset.adminEmail).toBeTruthy();
    expect(reset.adminPassword).toBeTruthy();
    expect(stepErrors('data', recipe({ resetPasswords: true }), ctx)).toEqual({});
  });
  it('the body sends the built snapshot and the first admin when given', () => {
    const body = buildBody(recipe({ resetPasswords: true }), ctx, 'built-1');
    expect(body.snapshot_id).toBe('built-1');
    expect(body.first_admin).toEqual({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.example.com',
                                       password_mode: 'typed', password: 'Correct-Horse-9' });
    expect(buildBody(recipe(NO_ADMIN), ctx, 'built-1').first_admin).toBeUndefined();
  });
});
