import { expect, it } from 'vitest';

import { safeHref } from './safeHref';

it('allows http and https URLs through unchanged', () => {
  expect(safeHref('https://example.com')).toBe('https://example.com');
  expect(safeHref('http://example.com/path?x=1')).toBe('http://example.com/path?x=1');
});

it('trims surrounding whitespace on an otherwise-safe URL', () => {
  expect(safeHref('  https://example.com  ')).toBe('https://example.com');
});

it('rejects javascript: URLs', () => {
  expect(safeHref('javascript:alert(1)')).toBeNull();
});

it('rejects data: URLs', () => {
  expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
});

it('rejects mailto: (and other non-http schemes)', () => {
  expect(safeHref('mailto:x@y.example')).toBeNull();
});

it('rejects a relative path (no absolute scheme to trust)', () => {
  expect(safeHref('/some/path')).toBeNull();
});

it('rejects empty, whitespace-only, null, and undefined', () => {
  expect(safeHref('')).toBeNull();
  expect(safeHref('   ')).toBeNull();
  expect(safeHref(null)).toBeNull();
  expect(safeHref(undefined)).toBeNull();
});
