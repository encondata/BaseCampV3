// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SystemBanners from './SystemBanners';
import type { SystemStatus } from '../lib/systemStatus';

let current: SystemStatus = { read_only: false, read_only_message: '', workers_paused: false, banner: null };
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: current, refresh: vi.fn() }),
}));

afterEach(cleanup);

describe('SystemBanners', () => {
  it('renders nothing when everything is off', () => {
    const { container } = render(<SystemBanners />);
    expect(container.querySelector('.sys-banner')).toBeNull();
  });
  it('shows read-only (with message) and broadcast bars, read-only first', () => {
    current = { read_only: true, read_only_message: 'Cutover until 14:00',
                workers_paused: true, banner: 'Welcome to the new portal' };
    const { container } = render(<SystemBanners />);
    const bars = [...container.querySelectorAll('.sys-banner')];
    expect(bars.map((b) => b.textContent)).toEqual([
      'Read-only maintenance mode — Cutover until 14:00',
      'Welcome to the new portal',
    ]);
    expect(bars[0].className).toContain('sys-banner-readonly');
    expect(bars[1].className).toContain('sys-banner-broadcast');
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });
  it('omits the dash when the read-only message is blank', () => {
    current = { read_only: true, read_only_message: '', workers_paused: false, banner: null };
    render(<SystemBanners />);
    expect(screen.getByRole('status').textContent).toBe('Read-only maintenance mode');
  });
});
