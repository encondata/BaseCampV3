import type { Dictionary } from './en';

/** Japanese (convenience translation; English governs). */
export const ja: Dictionary = {
  'app.name': 'ServerSherpa Learn',
  'app.short': 'Learn',
  'scene.sub': '初出勤の前に、スマートフォンやパソコンから研修資料を読んで署名してください。',

  'signin.title': '学習コードを入力してください',
  'signin.hint': '招待メールに記載されています。',
  'signin.code': '学習コード',
  'signin.codeBox': '{n} 文字目（全 6 文字）',
  'signin.lastName': '姓',
  'signin.continue': '続ける',
  'signin.signingIn': 'サインイン中…',
  'signin.incomplete': '6 文字のコードと姓を入力してください。',
  'signin.or': 'または',
  'signin.account': 'アカウントでサインイン',
  'signin.useCode': '学習コードを使う',
  'signin.language': '言語',

  'error.learn_code_invalid':
    'コードと姓が一致しないか、試行回数が多すぎます。招待メールを確認するか、数分待ってからもう一度お試しください。',
  'error.rate_limited': '試行回数が多すぎます。数分待ってからもう一度お試しください。',
  'error.network': 'サーバーに接続できませんでした。接続を確認して、もう一度お試しください。',
  'error.unknown': '問題が発生しました。もう一度お試しください。',

  'start.signingIn': 'サインインしています…',
  'start.invalid': 'このリンクは使用できなくなりました。招待メールに記載のコードでサインインしてください。',
  'start.enterCode': 'コードを入力',

  'crash.title': '問題が発生しました',
  'crash.hint': 'このページでエラーが発生しました。再読み込みすると、たいていは解決します。',
  'crash.reload': '再読み込み',
};
