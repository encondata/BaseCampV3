// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import HostKeyModal from './HostKeyModal';

afterEach(cleanup);

const base = { host: 'srv.example.com', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc123',
               canTrust: true, busy: false, error: '' };

it('shows the fingerprint and trusts or cancels', async () => {
  const onTrust = vi.fn();
  const onCancel = vi.fn();
  render(<HostKeyModal {...base} onTrust={onTrust} onCancel={onCancel} />);
  expect(screen.getByText('Trust this server?')).toBeTruthy();
  expect(screen.getByText(/srv\.example\.com:22/)).toBeTruthy();
  expect(screen.getByText('SHA256:abc123')).toBeTruthy();
  expect(screen.getByText('ssh-ed25519')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
  expect(onTrust).toHaveBeenCalled();
  await userEvent.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalled();
});

it('without deploy:change the trust button is disabled and says who can', () => {
  render(<HostKeyModal {...base} canTrust={false} onTrust={vi.fn()} onCancel={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Trust and connect' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/ask someone with permission to change deployments/i)).toBeTruthy();
});

it('shows an error inline', () => {
  render(<HostKeyModal {...base} error="Try again." onTrust={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('alert').textContent).toContain('Try again.');
});
