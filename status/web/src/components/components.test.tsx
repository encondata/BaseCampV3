import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DayBar, ServiceSummary } from '../lib/summary';
import ServiceCard from './ServiceCard';
import StatusBanner from './StatusBanner';
import UptimeStrip from './UptimeStrip';

function days(fill: (i: number) => DayBar['ok']): DayBar[] {
  return Array.from({ length: 90 }, (_, i) => {
    const ok = fill(i);
    return { day: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, ok, total: ok === null ? null : 10 };
  });
}

const up: ServiceSummary = {
  key: 'api', name: 'API', state: 'up', last_checked_at: '2026-09-23T12:00:00Z',
  latency_ms: 42, uptime_90d: 99.99, days: days(() => 10),
};

describe('StatusBanner', () => {
  it('operational', () => {
    render(<StatusBanner overall="operational" services={[up]} />);
    expect(screen.getByRole('status').textContent).toContain('All systems operational');
  });
  it('degraded names the count', () => {
    render(<StatusBanner overall="degraded" services={[up, { ...up, key: 'k', name: 'Kiosk', state: 'down' }]} />);
    expect(screen.getByRole('status').textContent).toContain('1 service down');
  });
  it('plural', () => {
    const down = { ...up, state: 'down' as const };
    render(<StatusBanner overall="degraded" services={[down, down]} />);
    expect(screen.getByRole('status').textContent).toContain('2 services down');
  });
  it('unknown', () => {
    render(<StatusBanner overall="unknown" services={[]} />);
    expect(screen.getByRole('status').textContent).toContain('Checking');
  });
});

describe('ServiceCard', () => {
  it('shows name, state, latency, uptime', () => {
    render(<ServiceCard service={up} />);
    expect(screen.getByRole('heading', { name: 'API' })).toBeTruthy();
    expect(screen.getByText('Operational')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('99.99%')).toBeTruthy();
  });
  it('down', () => {
    render(<ServiceCard service={{ ...up, state: 'down', latency_ms: null }} />);
    expect(screen.getByText('Down')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('UptimeStrip', () => {
  it('renders 90 bars with tones', () => {
    const { container } = render(
      <UptimeStrip days={days((i) => (i < 10 ? null : i === 50 ? 7 : 10))} />,
    );
    expect(container.querySelectorAll('.ss-bar')).toHaveLength(90);
    expect(container.querySelectorAll('.ss-bar-none')).toHaveLength(10);
    expect(container.querySelectorAll('.ss-bar-down')).toHaveLength(1);
    expect(container.querySelectorAll('.ss-bar-up')).toHaveLength(79);
    // the oldest 60 carry the class the phone layout hides
    expect(container.querySelectorAll('.ss-bar-old')).toHaveLength(60);
  });
  it('bars are labeled for assistive tech', () => {
    render(<UptimeStrip days={days(() => 10)} />);
    expect(screen.getAllByRole('img')[89].getAttribute('aria-label')).toMatch(/100%/);
  });
  it('axis marks today as UTC, since daily bars are UTC calendar days', () => {
    render(<UptimeStrip days={days(() => 10)} />);
    expect(screen.getByText('Today (UTC)')).toBeTruthy();
  });
  it('tooltip date line is suffixed UTC', () => {
    const allDays = days(() => 10);
    render(<UptimeStrip days={allDays} />);
    const lastBar = screen.getAllByRole('img')[89];
    fireEvent.focus(lastBar);
    // The tooltip's day line renders formatDay(day) + ' UTC'.
    const tipDay = document.querySelector('.ss-tip-day');
    expect(tipDay?.textContent?.endsWith(' UTC')).toBe(true);
  });
});
