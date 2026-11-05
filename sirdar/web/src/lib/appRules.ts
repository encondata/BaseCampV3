/** The optional apps, mail and kiosk signing digests, shared by the Deploy
 *  flow's Extras step and an environment's Settings › Apps & mail: the API's
 *  rules mirrored (apps.check_apps, check_mail, check_digests) so a form can
 *  answer before a round trip; the API stays the authority. Pure: no React, no I/O. */
import type { EnvMail, NewMail } from './sirdarApi';

export type OptionalApp = 'wiki' | 'kiosk' | 'learn' | 'status' | 'mailpit';
export const OPTIONAL_APPS: [OptionalApp, string][] = [
  ['wiki', 'Wiki'], ['kiosk', 'Kiosk'], ['learn', 'Learning'], ['status', 'Status page'], ['mailpit', 'Mailpit'],
];
export type AppSwitches = Record<OptionalApp, boolean>;
export interface MailForm {
  mailMode: 'mailpit' | 'smtp'; smtpHost: string; smtpPort: string; smtpUsername: string; smtpPassword: string;
  smtpFrom: string; smtpStarttls: boolean;
}
export interface AppsMailForm extends MailForm { apps: AppSwitches }

export const LEARN_NEEDS_WIKI = 'The learning site needs the wiki: turn the wiki on, or turn learning off.';
const MAILPIT_REQUIRED = 'Mail goes to Mailpit unless SMTP is set up: turn Mailpit on, or choose SMTP.';
export const DIGEST_HELP = 'Each digest is a SHA-256: 64 hex characters, colons allowed.';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/;
const USER_RE = /^[^\s"'$#`\\]{1,254}$/;
/** envfile.SECRET_VALUE_RE: what an optional secret in the .env may hold. */
export const SECRET_RE = /^[A-Za-z0-9._~+/=:@%^*!?,;-]{1,1024}$/;
export const SECRET_HELP = "can't be saved. Use letters, numbers and ._~+/=:@%^*!?,;- only, with no spaces or quotes.";
/** Control characters and line/paragraph separators (first_admins._clean refuses them too). */
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** A whole number as typed (NaN for anything else). */
export const whole = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw) : NaN);

/** One switch flipped, with the rules it brings: the learning site goes off
 *  with the wiki, and mail moves to SMTP when Mailpit goes off. */
export function switchApp(form: Pick<AppsMailForm, 'apps' | 'mailMode'>, app: OptionalApp, on: boolean): Partial<AppsMailForm> {
  const apps = { ...form.apps, [app]: on };
  if (app === 'wiki' && !on) apps.learn = false;
  return app === 'mailpit' && !on && form.mailMode === 'mailpit' ? { apps, mailMode: 'smtp' } : { apps };
}

export const appsOn = (apps: AppSwitches): OptionalApp[] => OPTIONAL_APPS.map(([a]) => a).filter((a) => apps[a]);

export function appsProblem(form: Pick<AppsMailForm, 'apps' | 'mailMode'>): string {
  if (form.apps.learn && !form.apps.wiki) return LEARN_NEEDS_WIKI;
  if (form.mailMode === 'mailpit' && !form.apps.mailpit) return MAILPIT_REQUIRED;
  return '';
}

/** SMTP's fields as the API checks them ('' when it would accept them). */
export function mailProblem(f: MailForm): string {
  const port = whole(f.smtpPort);
  return !HOST_RE.test(f.smtpHost.trim()) ? "Enter the SMTP server's host name or address."
    : !(port >= 1 && port <= 65535) ? 'Use an SMTP port from 1 to 65535.'
    : f.smtpUsername && !USER_RE.test(f.smtpUsername) ? "That SMTP user name can't be used: no spaces, quotes, $, # or backslashes."
    : f.smtpPassword && !SECRET_RE.test(f.smtpPassword) ? `That SMTP password ${SECRET_HELP}`
    : !EMAIL_RE.test(f.smtpFrom.trim()) || !USER_RE.test(f.smtpFrom.trim()) || CONTROL_RE.test(f.smtpFrom)
      ? 'Enter the address mail is sent from, like noreply@example.com.' : '';
}

/** The API's `mail`: Mailpit, or the SMTP server (the password only when asked for and typed). */
export function mailBody(f: MailForm, withPassword = true): NewMail {
  return f.mailMode === 'smtp'
    ? { mode: 'smtp', host: f.smtpHost.trim(), port: Number(f.smtpPort), ...(f.smtpUsername ? { username: f.smtpUsername } : {}),
        ...(withPassword && f.smtpPassword ? { password: f.smtpPassword } : {}), from_address: f.smtpFrom.trim(),
        starttls: f.smtpStarttls }
    : { mode: 'mailpit' };
}

/** The kiosk signing digests typed one per line (commas and spaces work too). */
export function parseDigests(text: string): { digests: string[]; problem: string } {
  const digests: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const d = raw.replace(/:/g, '').toLowerCase();
    if (!DIGEST_RE.test(d)) return { digests: [], problem: DIGEST_HELP };
    if (!digests.includes(d)) digests.push(d);
  }
  return { digests, problem: '' };
}

/** An environment's stored apps, mail and digests as the form holds them. */
export function formOfEnv(apps: string[], mail: EnvMail, digests: string[] | undefined, smtpPort: number)
  : AppsMailForm & { digests: string } {
  return {
    apps: Object.fromEntries(OPTIONAL_APPS.map(([a]) => [a, apps.includes(a)])) as AppSwitches,
    mailMode: mail.mode, smtpHost: mail.host ?? '', smtpPort: String(mail.port ?? smtpPort),
    smtpUsername: mail.username ?? '', smtpPassword: '', smtpFrom: mail.from_address ?? '', smtpStarttls: mail.starttls,
    digests: (digests ?? []).join('\n'),
  };
}
