// @vitest-environment jsdom
/**
 * lib/api.ts downloads: `dispositionFilename` reads the file name a
 * Content-Disposition header gives (RFC 5987 `filename*` first, as
 * browsers do, else the plain `filename`), and `saveBlob` hands a blob to
 * the browser as a download under a name, revoking its object URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispositionFilename, saveBlob } from './api';

afterEach(() => vi.restoreAllMocks());

describe('dispositionFilename', () => {
  it('prefers the RFC 5987 name, decoded', () => {
    expect(dispositionFilename(
      'attachment; filename="NAP11 - Project plan.xlsx"; '
      + "filename*=UTF-8''NAP11%20%E2%80%93%20Project%20plan.xlsx",
    )).toBe('NAP11 – Project plan.xlsx');
  });

  it('takes the plain name, quoted or not, when there is no filename*', () => {
    expect(dispositionFilename('attachment; filename="Hall move - Project plan.xml"'))
      .toBe('Hall move - Project plan.xml');
    expect(dispositionFilename('attachment; filename=plan.xml')).toBe('plan.xml');
  });

  it('never answers a path: only the last segment of the name', () => {
    expect(dispositionFilename('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(dispositionFilename("attachment; filename*=UTF-8''a%2Fb%5Cc.xml")).toBe('c.xml');
  });

  it('answers null for no header, no name, or a name that can’t be decoded', () => {
    expect(dispositionFilename(null)).toBeNull();
    expect(dispositionFilename('attachment')).toBeNull();
    expect(dispositionFilename('attachment; filename=""')).toBeNull();
    expect(dispositionFilename("attachment; filename*=UTF-8''%E2%80")).toBeNull();
    expect(dispositionFilename("attachment; filename*=UTF-8''%E2%80; filename=\"x.xml\"")).toBe('x.xml');
  });
});

describe('saveBlob', () => {
  it('clicks a download link for the blob under the name, then revokes its URL', () => {
    const create = vi.fn(() => 'blob:plan');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    const blob = new Blob(['<Project/>'], { type: 'application/xml' });
    saveBlob(blob, 'NAP11 - Project plan.xml');
    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: 'blob:plan', download: 'NAP11 - Project plan.xml' }]);
    expect(revoke).toHaveBeenCalledWith('blob:plan');
    // the link is gone again
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
