/** English: the governing text. Every other dictionary carries exactly
 *  these keys (typed against this one, and checked by lib/i18n.test.ts).
 *  `{name}` placeholders are filled by `t(key, vars)`. */
export const en = {
  'app.name': 'ServerSherpa Learn',
  'app.short': 'Learn',
  'scene.sub': 'Read and sign your training before your first shift, from any phone or computer.',

  'signin.title': 'Enter your learning code',
  'signin.hint': "It's in your invite email.",
  'signin.code': 'Learning code',
  'signin.codeBox': 'Character {n} of 6',
  'signin.lastName': 'Last name',
  'signin.continue': 'Continue',
  'signin.signingIn': 'Signing in…',
  'signin.incomplete': 'Enter the 6-character code and your last name.',
  'signin.or': 'or',
  'signin.account': 'Sign in with an account',
  'signin.useCode': 'Use a learning code instead',
  'signin.language': 'Language',

  'error.learn_code_invalid':
    "That code and last name don't match, or there have been too many tries. Check your invite email or wait a few minutes.",
  'error.rate_limited': 'Too many tries. Wait a few minutes and try again.',
  'error.network': "Couldn't reach the server. Check your connection and try again.",
  'error.unknown': 'Something went wrong. Try again.',

  'start.signingIn': 'Signing you in…',
  'start.invalid': "This link doesn't work anymore. Sign in with the code from your invite email.",
  'start.enterCode': 'Enter your code',

  'crash.title': 'Something went wrong',
  'crash.hint': 'This page hit an error. Reloading usually fixes it.',
  'crash.reload': 'Reload',
};

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;
