import { describe, expect, it } from 'vitest';

import {
  LEARN_NEEDS_WIKI, OPTIONAL_APPS, appsOn, appsProblem, formOfEnv, mailBody, mailProblem, parseDigests, switchApp,
  type AppsMailForm,
} from './appRules';

const base: AppsMailForm = {
  apps: { wiki: true, kiosk: true, learn: true, status: true, mailpit: true },
  mailMode: 'mailpit', smtpHost: '', smtpPort: '587', smtpUsername: '', smtpPassword: '', smtpFrom: '', smtpStarttls: true,
};

describe('apps', () => {
  it('lists Learning between Kiosk and Status page', () => {
    expect(OPTIONAL_APPS.map(([, l]) => l)).toEqual(['Wiki', 'Kiosk', 'Learning', 'Status page', 'Mailpit']);
  });
  it('the learning site goes off with the wiki; Mailpit off moves mail to SMTP', () => {
    expect(switchApp(base, 'wiki', false)).toEqual({ apps: { ...base.apps, wiki: false, learn: false } });
    expect(switchApp(base, 'mailpit', false)).toEqual({ apps: { ...base.apps, mailpit: false }, mailMode: 'smtp' });
    expect(switchApp(base, 'kiosk', false)).toEqual({ apps: { ...base.apps, kiosk: false } });
  });
  it('appsOn keeps the canonical order; appsProblem mirrors the API', () => {
    expect(appsOn({ ...base.apps, kiosk: false })).toEqual(['wiki', 'learn', 'status', 'mailpit']);
    expect(appsProblem({ ...base, apps: { ...base.apps, wiki: false } })).toBe(LEARN_NEEDS_WIKI);
    expect(appsProblem({ ...base, apps: { ...base.apps, mailpit: false } }))
      .toBe('Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.');
    expect(appsProblem(base)).toBe('');
  });
});

describe('mail', () => {
  const smtp = { ...base, mailMode: 'smtp' as const, smtpHost: 'smtp.example.com', smtpFrom: 'ops@example.com' };
  it('checks SMTP as the API does', () => {
    expect(mailProblem({ ...smtp, smtpHost: 'smtp example.com' })).toBe("Enter the SMTP server's host name or address.");
    expect(mailProblem({ ...smtp, smtpPort: '70000' })).toBe('Use an SMTP port from 1 to 65535.');
    expect(mailProblem(smtp)).toBe('');
  });
  it('builds the body, with or without the password', () => {
    expect(mailBody(base)).toEqual({ mode: 'mailpit' });
    expect(mailBody({ ...smtp, smtpPassword: 'pw-1' })).toEqual({
      mode: 'smtp', host: 'smtp.example.com', port: 587, password: 'pw-1', from_address: 'ops@example.com', starttls: true });
    expect(mailBody({ ...smtp, smtpPassword: 'pw-1' }, false)).not.toHaveProperty('password');
  });
  it('formOfEnv reads an environment back', () => {
    const f = formOfEnv(['wiki', 'mailpit'], {
      mode: 'smtp', host: 'smtp.example.com', port: 2525, username: null, from_address: 'ops@example.com',
      starttls: false, password_set: true,
    }, ['ab'.repeat(32)], 587);
    expect(f.apps).toEqual({ wiki: true, kiosk: false, learn: false, status: false, mailpit: true });
    expect([f.mailMode, f.smtpPort, f.smtpStarttls, f.digests]).toEqual(['smtp', '2525', false, 'ab'.repeat(32)]);
  });
});

describe('digests', () => {
  it('splits on lines, commas and spaces, drops colons, lowercases, keeps each once', () => {
    const d = 'AB:'.repeat(31) + 'AB';
    expect(parseDigests(`${d}\n${'ab'.repeat(32)}, ${'cd'.repeat(32)}`))
      .toEqual({ digests: ['ab'.repeat(32), 'cd'.repeat(32)], problem: '' });
    expect(parseDigests('  ')).toEqual({ digests: [], problem: '' });
    expect(parseDigests('nope').problem).toBe('Each digest is a SHA-256: 64 hex characters, colons allowed.');
  });
});
