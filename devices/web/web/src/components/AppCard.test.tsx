// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform', () => ({ viewerPlatform: () => 'desktop' }));
vi.mock('../lib/goTo', () => ({ goTo: vi.fn() }));
vi.mock('@portal/lib/qr', () => ({ qrDataUrl: () => 'data:image/png;qr' }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import type { AppOut } from '../lib/appsApi';
import { androidApp, iosApp, stubApi, version } from '../testing/fakeApi';
import AppCard from './AppCard';

function renderCard(app: unknown) {
  return render(
    <MemoryRouter>
      <AppCard app={app as AppOut} deviceRef={null} onChanged={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:icon-1');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppCard', () => {
  it('shows the app, its current version, who uploaded it and what is new', async () => {
    const calls = stubApi({
      'GET /api/apps/app-a/icon': () => new Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } }),
    });
    const { container } = renderCard(androidApp());
    expect(screen.getByText('ServerSherpa Kiosk')).toBeTruthy();
    expect(screen.getByText('Android')).toBeTruthy();
    expect(screen.getByText('0.1.1 (2)')).toBeTruthy();
    expect(screen.getByText('Uploaded 2026-11-09 by J. Henderson')).toBeTruthy();
    expect(screen.getByText("What's new:")).toBeTruthy();
    expect(screen.getByText('QR label changes')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Previous versions' }).getAttribute('href')).toBe('/apps/app-a');
    // the icon needs the bearer, so it comes through the API, not a bare <img src>
    await waitFor(() => expect(container.querySelector('img.devices-app-icon')?.getAttribute('src')).toBe('blob:icon-1'));
    expect(calls[0].path).toBe('/api/apps/app-a/icon');
  });

  it('an app without an icon gets a neutral tile; no notes, no What\'s new', () => {
    stubApi({});
    const { container } = renderCard(iosApp({ current: version({ notes: '' }) }));
    expect(container.querySelector('.devices-app-icon.placeholder')).toBeTruthy();
    expect(container.querySelector('img.devices-app-icon')).toBeNull();
    expect(screen.getByText('iOS')).toBeTruthy();
    expect(screen.queryByText("What's new:")).toBeNull();
  });

  it('an app with no version yet says so and offers no install', () => {
    stubApi({});
    renderCard(androidApp({ icon_url: null, current: null }));
    expect(screen.getByText('No version yet.')).toBeTruthy();
    expect(screen.queryByText('Open this page on the phone to install.')).toBeNull();
  });
});
