// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@portal/lib/api';

import { ESXI_CERT } from '../pages/environments/testData';

import CertificatePrompt, { pendingCertificate } from './CertificatePrompt';

const err = (status: number, detail: Record<string, unknown>) =>
  new ApiError(status, String(detail.code), detail);

afterEach(cleanup);

describe('pendingCertificate', () => {
  it('reads a new certificate and a changed one', () => {
    expect(pendingCertificate(err(409, { code: 'tls_untrusted', ...ESXI_CERT }), 'save'))
      .toEqual({ kind: 'untrusted', what: 'save', cert: ESXI_CERT });
    expect(pendingCertificate(err(409, { code: 'tls_mismatch', expected: 'AA', actual: 'BB' }), 'test'))
      .toEqual({ kind: 'changed', what: 'test', expected: 'AA', actual: 'BB' });
  });

  it('is null for anything else, including a bare tls_untrusted', () => {
    expect(pendingCertificate(err(409, { code: 'tls_untrusted' }), 'save')).toBeNull();
    expect(pendingCertificate(new ApiError(409, 'tls_untrusted', null), 'save')).toBeNull();
    expect(pendingCertificate(err(409, { code: 'tls_mismatch', expected: 'AA' }), 'save')).toBeNull();
    expect(pendingCertificate(err(422, { code: 'esxi_url_invalid' }), 'save')).toBeNull();
    expect(pendingCertificate(new Error('x'), 'save')).toBeNull();
    expect(pendingCertificate(null, 'save')).toBeNull();
  });
});

describe('CertificatePrompt', () => {
  it('shows the certificate and trusts its fingerprint', () => {
    const onTrust = vi.fn();
    render(<CertificatePrompt pending={{ kind: 'untrusted', what: 'save', cert: ESXI_CERT }}
                              question="Is this the ESXi host's certificate?" busy={false} onTrust={onTrust} />);
    expect(screen.getByText("Is this the ESXi host's certificate?")).toBeTruthy();
    expect(screen.getByText(ESXI_CERT.fingerprint)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trust this certificate' }));
    expect(onTrust).toHaveBeenCalledWith(ESXI_CERT.fingerprint, 'save');
  });

  it('warns about a changed certificate', () => {
    const onTrust = vi.fn();
    render(<CertificatePrompt pending={{ kind: 'changed', what: 'test', expected: 'AA', actual: 'BB' }}
                              question="?" busy={false} onTrust={onTrust} />);
    fireEvent.click(screen.getByRole('button', { name: 'Trust the new certificate' }));
    expect(onTrust).toHaveBeenCalledWith('BB', 'test');
  });
});
