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

  'error.locked':
    "This document is locked right now. Finish the ones before it, or ask your lead if you're stuck.",
  'error.already_signed': 'You already signed this one.',
  'error.not_found': "We couldn't find that document.",
  'error.retry': 'Try again',

  'start.network':
    "We couldn't reach the server. Open the link from your email again once you're back online.",
  'start.rateLimited': 'Too many tries. Wait a few minutes, then open the link from your email again.',
  'start.failed': 'Something went wrong signing you in. Open the link from your email again, or enter your code.',

  'common.back': 'Back',
  'common.loading': 'Loading…',

  'training.hi': 'Hi {name}',
  'training.hiNoName': 'Hi',
  'training.general': 'General training',
  'training.progress': '{done} of {total} done',
  'training.progressDue': '{done} of {total} done · due {date}',
  'training.progressLabel': 'Training progress',
  'training.signed': 'Signed {date}',
  'training.minRead': '{n} min read',
  'training.minQuiz': '{n} min · short quiz',
  'training.locked': 'Locked',
  'training.continue': 'Continue: {title}',
  'training.caughtUp': "You're all caught up.",
  'training.showCode': 'Show my time clock code',

  'reader.position': '{k} of {n} · v{v}',
  'reader.versionOnly': 'v{v}',
  'reader.fallback': "This document isn't translated yet. You're reading the English version.",
  'reader.changed': 'What changed: {note}',
  'reader.body': 'Document text',
  'reader.readToEnd': 'Read to the end · {time}',
  'reader.agree': "I've read {title} and agree to follow it.",
  'reader.typeName': 'Type your full name to sign',
  'reader.drawSignature': 'Draw your signature',
  'reader.clear': 'Clear',
  'reader.sign': 'Sign and continue',
  'reader.takeQuiz': 'Take the quiz',
  'reader.signing': 'Signing…',
  'reader.versionChanged': 'This document was just updated. Read the new version, then sign.',

  'sign.mustAgree': "Tick the box to say you've read it and agree.",
  'sign.nameRequired': 'Type your full name to sign.',
  'sign.signatureRequired': 'Draw your signature to sign.',
  'sign.scrollRequired': 'Scroll to the end of the document first.',
  'sign.readTime': 'Keep reading: you can sign in {time}.',
  'sign.signatureInvalid': "That signature couldn't be saved. Clear it and draw it again.",

  'quiz.eyebrow': '{title} · quiz',
  'quiz.question': 'Question {n} of {total}',
  'quiz.pickOne': 'Choose one answer.',
  'quiz.pickMany': 'Choose every answer that applies.',
  'quiz.check': 'Check answer',
  'quiz.finish': 'See my score',
  'quiz.checking': 'Checking…',
  'quiz.score': 'You scored {score}%',
  'quiz.passed': 'You passed.',
  'quiz.continue': 'Continue to sign',
  'quiz.failed': "That's not a pass yet.",
  'quiz.triesLeft': '{n} tries left',
  'quiz.oneTryLeft': '1 try left',
  'quiz.tryAgain': 'Try again',
  'quiz.locked': "You've used all your tries. Your lead has been notified.",
  'quiz.readAgain': 'Read the document again',
  'quiz.back': 'Back to my training',

  'done.title': "You're all set, {name}",
  'done.titleNoName': "You're all set",
  'done.sub': 'All {n} signed.',
  'done.qrAlt': 'Your time clock QR code',
  'done.hint': 'Your time clock code. Scan it at the station when you clock in.',
  'done.save': 'Save to phone',
  'done.note': "We also emailed it to you. Don't share it: it clocks you in.",
  'done.qrFailed': "We couldn't draw your time clock code. Reload this page to try again.",
  'done.back': 'Back to my training',

  'crash.title': 'Something went wrong',
  'crash.hint': 'This page hit an error. Reloading usually fixes it.',
  'crash.reload': 'Reload',
};

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;
