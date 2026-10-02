// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import AddRouterModal from './AddRouterModal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the header, steps and the install command for this API', () => {
  render(<AddRouterModal apiBase="https://api.example.com" onClose={vi.fn()} />);
  expect(screen.getByText('Scanning Hardware')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Add a router' })).toBeTruthy();
  expect(screen.getByText(/--api https:\/\/api\.example\.com$/)).toBeTruthy();
  expect(screen.queryByText(/isn.t HTTPS/)).toBeNull();
});

it('copies the command', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<AddRouterModal apiBase="https://api.example.com" onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('install.sh | sh -s -- --api https://api.example.com'));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
});

it('warns when the API address is not HTTPS', () => {
  render(<AddRouterModal apiBase="http://localhost:8000" onClose={vi.fn()} />);
  expect(screen.getByText(/isn.t HTTPS/)).toBeTruthy();
});

it('closes from the footer button', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<AddRouterModal apiBase="https://api.example.com" onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
});
