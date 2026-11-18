// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { grants, json, stubApi, type ApiCall } from '../testing/fakeApi';
import AppleSettingsPage from './AppleSettingsPage';

const EMPTY = {
  configured: false, team_id: null, key_id: null, issuer_id: null, cert_name: null,
  cert_expires_at: null, profiles: [], ios_owner_url: null,
};
const SAVED = {
  configured: true, team_id: 'TEAM123456', key_id: 'KEY1234567', issuer_id: '69a6de7e-0000-47e3-e053-5b8c7c11a4d1',
  cert_name: 'Apple Distribution: Test (TEAM123456)', cert_expires_at: '2027-06-01T12:00:00Z',
  profiles: [], ios_owner_url: null,
};
const NOTICE = 'Only one environment may hold these settings. iPhone installs on every other environment point here.';

function renderPage() {
  return render(<MemoryRouter><AppleSettingsPage /></MemoryRouter>);
}

const file = (name: string) => new File(['x'], name, { type: 'application/octet-stream' });
const writes = (calls: ApiCall[]) => calls.filter((c) => c.method !== 'GET');

async function fillAll() {
  await userEvent.type(await screen.findByLabelText('Team ID'), 'TEAM123456');
  await userEvent.type(screen.getByLabelText('Issuer ID'), 'issuer-1');
  await userEvent.type(screen.getByLabelText('Key ID'), 'KEY1234567');
  await userEvent.upload(screen.getByLabelText('API key (.p8)'), file('AuthKey_KEY1234567.p8'));
  await userEvent.upload(screen.getByLabelText('Distribution certificate (.p12)'), file('dist.p12'));
  await userEvent.type(screen.getByLabelText('Certificate password'), 'correct horse');
}

beforeEach(() => {
  auth.can = grants('view', 'add', 'change', 'delete');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppleSettingsPage', () => {
  it('opens with the one-environment notice', async () => {
    stubApi({ 'GET /api/apple': EMPTY });
    renderPage();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Apple settings' })).toBeTruthy();
  });

  it('Apple form requires all parts on first save', async () => {
    const calls = stubApi({ 'GET /api/apple': EMPTY });
    renderPage();
    await userEvent.type(await screen.findByLabelText('Team ID'), 'TEAM123456');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(
      'Add the missing parts: Issuer ID, Key ID, API key (.p8), Distribution certificate (.p12), Certificate password.',
    )).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('sends every part as a form on first save', async () => {
    const calls = stubApi({ 'GET /api/apple': EMPTY, 'PUT /api/apple': SAVED });
    renderPage();
    await fillAll();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Apple Distribution: Test (TEAM123456)');
    const [put] = writes(calls);
    expect(put.path).toBe('/api/apple');
    expect(put.method).toBe('PUT');
    const form = put.raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('team_id')).toBe('TEAM123456');
    expect(form.get('issuer_id')).toBe('issuer-1');
    expect(form.get('key_id')).toBe('KEY1234567');
    expect(form.get('p12_password')).toBe('correct horse');
    expect((form.get('p8') as File).name).toBe('AuthKey_KEY1234567.p8');
    expect((form.get('p12') as File).name).toBe('dist.p12');
  });

  it('after save shows cert name and no secret fields', async () => {
    const calls = stubApi({ 'GET /api/apple': SAVED, 'PUT /api/apple': SAVED });
    const { container } = renderPage();
    expect(await screen.findByText('Apple Distribution: Test (TEAM123456)')).toBeTruthy();
    expect(screen.getByText('2027-06-01')).toBeTruthy();
    expect(screen.getByText('KEY1234567')).toBeTruthy();
    expect(screen.getByLabelText('Replace API key (.p8)')).toBeTruthy();
    expect(screen.getByLabelText('Replace distribution certificate (.p12)')).toBeTruthy();
    // no password field (the saved one stays with the saved certificate)
    expect(screen.queryByLabelText('Certificate password')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    // the saved parts are kept: saving sends only the non-secret fields
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const form = writes(calls)[0].raw as FormData;
    expect(form.get('team_id')).toBe('TEAM123456');
    expect(form.get('p8')).toBeNull();
    expect(form.get('p12')).toBeNull();
    expect(form.get('p12_password')).toBeNull();
  });

  it('a replacement certificate needs its password', async () => {
    const calls = stubApi({ 'GET /api/apple': SAVED });
    renderPage();
    await userEvent.upload(await screen.findByLabelText('Replace distribution certificate (.p12)'), file('new.p12'));
    expect(screen.getByLabelText('Certificate password')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Add the missing parts: Certificate password.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it("shows the API's reason when Apple refuses", async () => {
    stubApi({
      'GET /api/apple': EMPTY,
      'PUT /api/apple': () => json(422, { detail: { code: 'bad_certificate', message: 'The certificate password is wrong.' } }),
    });
    renderPage();
    await fillAll();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The certificate password is wrong.')).toBeTruthy();
  });

  it('Clear requires confirm', async () => {
    let current: typeof SAVED | typeof EMPTY = SAVED;
    const calls = stubApi({
      'GET /api/apple': () => json(200, current),
      'DELETE /api/apple': () => { current = EMPTY; return json(204, null); },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Clear settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear Apple settings?' });
    expect(writes(calls)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes(calls)).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Clear settings' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([
      ['DELETE', '/api/apple', { confirm: 'clear' }],
    ]);
    // back to the empty form
    expect(await screen.findByLabelText('API key (.p8)')).toBeTruthy();
  });

  it('shows where iPhone installs are set up', async () => {
    stubApi({ 'GET /api/apple': { ...EMPTY, ios_owner_url: 'https://devices.serversherpa.com' } });
    renderPage();
    const link = await screen.findByRole('link', { name: 'https://devices.serversherpa.com' });
    expect(link.getAttribute('href')).toBe('https://devices.serversherpa.com');
  });

  it('without change permission: the no-permission notice, and no request', async () => {
    auth.can = grants('view');
    const calls = stubApi({ 'GET /api/apple': SAVED });
    renderPage();
    expect(screen.getByText("You don't have access to Apple settings")).toBeTruthy();
    expect(screen.queryByLabelText('Team ID')).toBeNull();
    expect(calls).toEqual([]);
  });
});
