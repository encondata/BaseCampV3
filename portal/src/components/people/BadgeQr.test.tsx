// @vitest-environment jsdom
/** BadgeQr / printBadgeQr: the worker's time clock QR (people.badge_uid). */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const qr = vi.hoisted(() => ({ qrDataUrl: vi.fn((t: string) => `data:image/png;base64,QR-${t}`) }));
vi.mock('../../lib/qr', () => qr);

const { BadgeQr, printBadgeQr } = await import('./BadgeQr');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('renders the QR for the badge uid at the requested size', () => {
  render(<BadgeQr badgeUid="uid-1" size={240} />);
  const img = screen.getByAltText('Your time clock QR code') as HTMLImageElement;
  expect(qr.qrDataUrl).toHaveBeenCalledWith('uid-1');
  expect(img.getAttribute('src')).toBe('data:image/png;base64,QR-uid-1');
  expect(img.getAttribute('width')).toBe('240');
  expect(img.getAttribute('height')).toBe('240');
});

it('defaults to at least 220 px', () => {
  render(<BadgeQr badgeUid="uid-1" />);
  const img = screen.getByAltText('Your time clock QR code');
  expect(Number(img.getAttribute('width'))).toBeGreaterThanOrEqual(220);
});

it('prints a card with the escaped name above the QR and the uid below', () => {
  const doc = { write: vi.fn(), close: vi.fn() };
  const open = vi.fn(() => ({ document: doc }));
  vi.stubGlobal('open', open);
  printBadgeQr({ name: 'Wes <b>"Worker"</b> & Co', badgeUid: 'uid-2' });
  expect(open).toHaveBeenCalledWith('', '_blank');
  const html = doc.write.mock.calls[0][0] as string;
  expect(html).toContain('Wes &lt;b&gt;&quot;Worker&quot;&lt;/b&gt; &amp; Co');
  expect(html).not.toContain('<b>');
  expect(html).toContain('data:image/png;base64,QR-uid-2');
  expect(html).toContain('uid-2');
  expect(html.indexOf('Wes &lt;')).toBeLessThan(html.indexOf('<img'));
  expect(html.indexOf('<img')).toBeLessThan(html.indexOf('class="uid"'));
  expect(html).toContain('window.print()');
  expect(doc.close).toHaveBeenCalled();
});

it('is a quiet no-op when the popup is blocked', () => {
  vi.stubGlobal('open', vi.fn(() => null));
  expect(() => printBadgeQr({ name: 'Wes', badgeUid: 'uid-3' })).not.toThrow();
});
