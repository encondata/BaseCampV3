// @vitest-environment jsdom
/** The static scene behind the sign-in form, shared by the portal, the
 *  wiki and the kiosk: real logo, the Dallas → Las Vegas route map,
 *  headline, features and status line. Only the headline and the line
 *  under it are per-app; everything else is fixed. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import LoginScene from './LoginScene';

afterEach(cleanup);

it('shows the real logo, name and tagline', () => {
  render(<LoginScene />);
  const logo = screen.getByAltText('ServerSherpa logo') as HTMLImageElement;
  expect(logo.getAttribute('src')).toBe('/images/serversherpa-logo.png');
  expect(screen.getByText('Datacenter Relocation Tools')).toBeTruthy();
});

it('draws both pins, the route, the Route 07 card and four state names inside a hidden map', () => {
  const { container } = render(<LoginScene />);
  const map = container.querySelector('.lx-map');
  if (!map) throw new Error('no .lx-map');
  expect(map.getAttribute('aria-hidden')).toBe('true');
  const text = map.textContent ?? '';
  for (const s of [
    'ORIGIN · DAL-7', 'Dallas, TX · HALL B', '32.7767° N / 96.7970° W', "ELEV. 438'",
    'DESTINATION · LAS-9', 'Las Vegas, NV · HALL D', '36.1696° N / 115.1398° W', "ELEV. 2,061'",
    'ROUTE 07', '1,241 ASSETS', 'RACK 83 · ETA 2h 14m',
  ]) expect(text).toContain(s);
  expect([...map.querySelectorAll('.lx-state')].map((n) => n.textContent))
    .toEqual(['NEVADA', 'CALIFORNIA', 'ARIZONA', 'TEXAS']);
  expect(map.querySelector('.lx-route')).not.toBeNull();
  expect(map.querySelectorAll('.lx-pin')).toHaveLength(2);
});

it('keeps the headline, description, features and status as readable text', () => {
  render(<LoginScene />);
  expect(screen.getByRole('heading', { level: 1 }).textContent)
    .toBe('Migration Control. From First Scan to Final Rack.');
  expect(screen.getByText(/Track relocation progress, review manifests, verify assets/)).toBeTruthy();
  expect(screen.getAllByRole('listitem').map((li) => li.textContent))
    .toEqual(['Track assets', 'Monitor progress', 'Verify work', 'Complete on time']);
  const status = screen.getByText('ALL SYSTEMS OPERATIONAL');
  expect(status.closest('.lx-status')?.textContent).toContain('STATUS.SERVERSHERPA.COM');
});

it('takes a per-app headline and description', () => {
  render(
    <LoginScene
      lead={null}
      accent="Kiosk"
      sub="Sign in to start scanning."
    />,
  );
  // lead={null} is how an app asks for a one-line hero; OMITTING lead
  // keeps the portal's default, which is what the wiki relies on
  expect(screen.getByRole('heading', { level: 1 }).textContent)
    .toBe('Kiosk');
  expect(screen.getByText('Sign in to start scanning.')).toBeTruthy();
  // and the rest of the scene is the same page
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByText('ALL SYSTEMS OPERATIONAL')).toBeTruthy();
});

it('renders a two-line hero when a lead is given', () => {
  const { container } = render(<LoginScene lead="One." accent="Two." />);
  expect(container.querySelectorAll('.lx-hero span')).toHaveLength(2);
  expect(container.querySelector('.lx-hero .accent')?.textContent).toBe('Two.');
});

it('hides the decorative layers from screen readers and uses the light art', () => {
  const { container } = render(<LoginScene />);
  for (const sel of ['.lx-topo', '.lx-mountains', '.lx-map']) {
    expect(container.querySelector(sel)?.getAttribute('aria-hidden')).toBe('true');
  }
  container.querySelectorAll('.lx-features svg').forEach((svg) => {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
  expect(container.querySelector('.lx-mountains')?.getAttribute('src'))
    .toBe('/images/login-mountains-light.webp');
});

it('hides the status separator from screen readers', () => {
  const { container } = render(<LoginScene />);
  expect(container.querySelector('.lx-status-sep')?.getAttribute('aria-hidden')).toBe('true');
});
