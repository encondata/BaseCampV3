// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { NO_INTEGRATIONS } from '../../environments/testData';
import { flowCtx } from '../flowFixtures';
import { initialState, type Errors, type FlowContext, type FlowState } from '../flowState';

import ExtrasStep from './ExtrasStep';

afterEach(cleanup);
function renderStep(over: Partial<FlowState> = {}, ctxOver: Partial<FlowContext> = {}, errors: Errors = {}) {
  const ctx = flowCtx(ctxOver);
  const set = vi.fn();
  render(<ExtrasStep state={{ ...initialState(ctx), name: 'qa', target: 'ssh:lab', ...over }} set={set} errors={errors} ctx={ctx} />);
  return set;
}

it('apps: API and Portal always, four switches', async () => {
  const set = renderStep();
  expect(screen.getByText('API and Portal always run.')).toBeTruthy();
  for (const label of ['Wiki', 'Kiosk', 'Status page', 'Mailpit']) expect(screen.getByLabelText(label)).toBeTruthy();
  await userEvent.click(screen.getByLabelText('Wiki'));
  expect(set).toHaveBeenCalledWith({ apps: { wiki: false, kiosk: true, status: true, mailpit: true } });
});

it('turning Mailpit off switches mail to SMTP', async () => {
  const set = renderStep();
  await userEvent.click(screen.getByLabelText('Mailpit'));
  expect(set).toHaveBeenCalledWith({ apps: { wiki: true, kiosk: true, status: true, mailpit: false }, mailMode: 'smtp' });
});

it('with Mailpit off, SMTP is required and the flow says so', () => {
  renderStep({ apps: { wiki: true, kiosk: true, status: true, mailpit: false }, mailMode: 'smtp' });
  expect(screen.getByRole('radio', { name: 'Mailpit' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText(/Mailpit is off, so mail needs SMTP/)).toBeTruthy();
});

it('Publish DNS: on with both integrations, off is sent', async () => {
  const set = renderStep();
  expect((screen.getByLabelText('Publish DNS') as HTMLInputElement).checked).toBe(true);
  await userEvent.click(screen.getByLabelText('Publish DNS'));
  expect(set).toHaveBeenCalledWith({ publish: false });
});

it('without both integrations Publish is off and says where to set them up', () => {
  renderStep({ publish: false }, { integrations: NO_INTEGRATIONS });
  expect((screen.getByLabelText('Publish DNS') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish/)).toBeTruthy();
});

it('DigitalOcean always publishes: no Publish switch', () => {
  renderStep({ target: 'digitalocean' });
  expect(screen.queryByLabelText('Publish DNS')).toBeNull();
  expect(screen.getByText(/DigitalOcean environments always publish/)).toBeTruthy();
});

it('SMTP fields appear for SMTP, the password write-only', async () => {
  const set = renderStep({ mailMode: 'smtp' });
  for (const label of ['SMTP host', 'SMTP port', 'User name', 'SMTP password', 'From address', 'STARTTLS'])
    expect(screen.getByLabelText(label)).toBeTruthy();
  const pw = screen.getByLabelText('SMTP password') as HTMLInputElement;
  expect(pw.type).toBe('password');
  expect(pw.autocomplete).toBe('new-password');
  expect(screen.getAllByText(/Saved encrypted; never shown again/).length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('radio', { name: 'Mailpit' }));
  expect(set).toHaveBeenCalledWith({ mailMode: 'mailpit' });
});

it('the port and STARTTLS sit with the host', async () => {
  const set = renderStep({ mailMode: 'smtp' });
  const group = screen.getByRole('group', { name: 'SMTP server' });
  expect(group.contains(screen.getByLabelText('SMTP host'))).toBe(true);
  expect(group.contains(screen.getByLabelText('SMTP port'))).toBe(true);
  expect(group.contains(screen.getByLabelText('STARTTLS'))).toBe(true);
  expect((screen.getByLabelText('SMTP port') as HTMLInputElement).value).toBe('587');
  await userEvent.click(screen.getByLabelText('STARTTLS'));
  expect(set).toHaveBeenCalledWith({ smtpStarttls: false });
});

it('no SMTP fields for Mailpit', () => {
  renderStep();
  expect(screen.queryByLabelText('SMTP host')).toBeNull();
});

it('the Anthropic key is write-only', () => {
  renderStep();
  expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).type).toBe('password');
  expect(screen.getByText(/For the Makes \/ Models spec lookup/)).toBeTruthy();
});

it('DigitalOcean hosting: standby and the staging certificate; production has no staging', () => {
  renderStep({ target: 'digitalocean' });
  expect(screen.getByLabelText('Standby node')).toBeTruthy();
  expect(screen.getByRole('radio', { name: "Let's Encrypt staging" })).toBeTruthy();
  cleanup();
  renderStep({ target: 'digitalocean', type: 'production', servers: 'bluegreen' });
  expect(screen.queryByRole('radio', { name: "Let's Encrypt staging" })).toBeNull();
  expect(screen.queryByLabelText('Activate automatically')).toBeNull();
});

it('Blue/Green offers auto-activate', () => {
  renderStep({ target: 'esxi', servers: 'bluegreen' });
  expect(screen.getByLabelText('Activate automatically')).toBeTruthy();
});

it('a single LAN server has nothing to set for hosting', () => {
  renderStep();
  expect(screen.getByText('Nothing to set for this target.')).toBeTruthy();
});

it('shows the errors', () => {
  renderStep({}, {}, {
    apps: 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.',
    mail: 'Use an SMTP port from 1 to 65535.', aiKey: 'That key is bad.', publish: 'Publish problem.', hosting: 'Hosting problem.',
  });
  for (const t of [/turn Mailpit on, or choose SMTP/, /SMTP port from 1 to 65535/, /That key is bad/, /Publish problem/, /Hosting problem/])
    expect(screen.getByText(t)).toBeTruthy();
});

it('never renders a native select', () => {
  const { container } = render(<div />);
  renderStep({ mailMode: 'smtp', target: 'digitalocean' });
  expect(container.ownerDocument.querySelector('select')).toBeNull();
});

it('the SMTP fields and the API key point at their errors', () => {
  renderStep({ mailMode: 'smtp' }, {}, { mail: 'Enter the SMTP server\'s host name or address.', aiKey: "That key can't be saved." });
  for (const label of ['SMTP host', 'SMTP port', 'User name', 'SMTP password', 'From address']) {
    const input = screen.getByLabelText(label);
    expect(input.getAttribute('aria-invalid'), label).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!.split(' ').pop()!)?.textContent, label)
      .toBe("Enter the SMTP server's host name or address.");
  }
  const key = screen.getByLabelText('Anthropic API key');
  expect(key.getAttribute('aria-invalid')).toBe('true');
  expect(key.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent))
    .toContain("That key can't be saved.");
});

it('without errors nothing is marked invalid', () => {
  renderStep({ mailMode: 'smtp' });
  for (const label of ['SMTP host', 'From address', 'Anthropic API key'])
    expect(screen.getByLabelText(label).getAttribute('aria-invalid'), label).toBeNull();
});

it('the section headings sit under the step title (h3)', () => {
  renderStep();
  for (const name of ['Apps', 'Hosting', 'Integrations']) expect(screen.getByRole('heading', { name, level: 3 })).toBeTruthy();
});
