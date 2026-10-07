// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { SNAP } from '../../environments/testData';
import { flowCtx } from '../flowFixtures';
import { initialState, type FlowState } from '../flowState';

import ReviewStep from './ReviewStep';

afterEach(cleanup);
function renderStep(over: Partial<FlowState>, extra: { problem?: string; created?: string | null } = {}) {
  const ctx = flowCtx();
  const state = { ...initialState(ctx), name: 'qa', type: 'custom' as const, target: 'ssh:lab', ...over };
  render(<MemoryRouter><ReviewStep state={state} set={vi.fn()} errors={{}} ctx={ctx} busy={false}
                                   problem={extra.problem ?? ''} created={extra.created ?? null} /></MemoryRouter>);
}

it('lists every choice and never a secret', () => {
  renderStep({ adminFirst: 'Ada', adminLast: 'Lovelace', adminEmail: 'ada@test.example.com', adminPassword: 'Correct-Horse-9',
               mailMode: 'smtp', smtpHost: 'smtp.example.com', smtpPassword: 'Mail-Secret-1', aiKey: 'sk-ant-1' });
  for (const text of ['qa', 'Custom', 'Lab box', 'Single server', 'smtp.example.com', 'Ada Lovelace · ada@test.example.com'])
    expect(screen.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
  for (const secret of ['Correct-Horse-9', 'Mail-Secret-1', 'sk-ant-1']) expect(document.body.textContent).not.toContain(secret);
  expect(screen.getAllByText('Set (hidden)').length).toBe(3);
});

it('Publish off is shown; apps that are off are left out', () => {
  renderStep({ publish: false, apps: { wiki: false, kiosk: true, status: true, mailpit: true } });
  expect(screen.getByText('Set up by hand')).toBeTruthy();
  expect(screen.getByText('API, Portal, Kiosk, Status page, Mailpit')).toBeTruthy();
});

it('a snapshot start names the snapshot and has no first admin', () => {
  renderStep({ dataMode: 'snapshot', snapshotId: SNAP.id });
  expect(screen.getByText(new RegExp(`Snapshot ${SNAP.name}`))).toBeTruthy();
  expect(screen.queryByText('First super admin')).toBeNull();
});

it('an invited admin reads Generated', () => {
  renderStep({ adminPasswordMode: 'invite' });
  expect(screen.getByText(/Generated: they get a set-password link/)).toBeTruthy();
});

it('a start that failed after the create links to the environment', () => {
  renderStep({}, { created: 'qa', problem: 'A deployment is already running.' });
  expect(screen.getByRole('alert').textContent).toContain("Created qa, but its first deployment didn't start: A deployment is already running.");
  expect(screen.getByRole('link', { name: 'Open the environment' }).getAttribute('href')).toBe('/deploy/environments/qa');
});

it('a create problem with nothing created is shown alone', () => {
  renderStep({}, { problem: 'Something went wrong.' });
  expect(screen.getByRole('alert').textContent).toBe('Something went wrong.');
  expect(screen.queryByRole('link')).toBeNull();
});

it('created with no problem (a host-key prompt canceled) still links to the environment', () => {
  renderStep({}, { created: 'qa' });
  expect(screen.getByText(/Created qa\. Deploy starts its first deployment\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the environment' }).getAttribute('href')).toBe('/deploy/environments/qa');
});
