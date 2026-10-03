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

it('Escape cancels, but not while busy; focus lands on Cancel', async () => {
  const onCancel = vi.fn();
  const { rerender } = render(<HostKeyModal {...base} onTrust={vi.fn()} onCancel={onCancel} />);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  rerender(<HostKeyModal {...base} busy onTrust={vi.fn()} onCancel={onCancel} />);
  await userEvent.keyboard('{Escape}');
  expect(onCancel).not.toHaveBeenCalled();
  rerender(<HostKeyModal {...base} onTrust={vi.fn()} onCancel={onCancel} />);
  await userEvent.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('restores focus to the opener on close', () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const { unmount } = render(<HostKeyModal {...base} onTrust={vi.fn()} onCancel={vi.fn()} />);
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('the trust button can be relabeled for the action it retries', () => {
  render(<HostKeyModal {...base} trustLabel="Trust and deploy" onTrust={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Trust and deploy' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Trust and connect' })).toBeNull();
});
