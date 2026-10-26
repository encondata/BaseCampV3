import type { Dictionary } from './en';

/** Korean (convenience translation; English governs). */
export const ko: Dictionary = {
  'app.name': 'ServerSherpa Learn',
  'app.short': 'Learn',
  'scene.sub': '첫 근무 전에 휴대폰이나 컴퓨터에서 교육 자료를 읽고 서명하세요.',

  'signin.title': '학습 코드를 입력하세요',
  'signin.hint': '초대 이메일에 있습니다.',
  'signin.code': '학습 코드',
  'signin.codeBox': '6자 중 {n}번째 문자',
  'signin.lastName': '성',
  'signin.continue': '계속',
  'signin.signingIn': '로그인 중…',
  'signin.incomplete': '6자리 코드와 성을 입력하세요.',
  'signin.or': '또는',
  'signin.account': '계정으로 로그인',
  'signin.useCode': '학습 코드로 로그인',
  'signin.language': '언어',

  'error.learn_code_invalid':
    '코드와 성이 일치하지 않거나 시도 횟수가 너무 많습니다. 초대 이메일을 확인하거나 몇 분 후에 다시 시도하세요.',
  'error.rate_limited': '시도 횟수가 너무 많습니다. 몇 분 후에 다시 시도하세요.',
  'error.network': '서버에 연결할 수 없습니다. 연결 상태를 확인하고 다시 시도하세요.',
  'error.unknown': '문제가 발생했습니다. 다시 시도하세요.',

  'start.signingIn': '로그인하는 중…',
  'start.invalid': '이 링크는 더 이상 사용할 수 없습니다. 초대 이메일에 있는 코드로 로그인하세요.',
  'start.enterCode': '코드 입력',

  'crash.title': '문제가 발생했습니다',
  'crash.hint': '이 페이지에서 오류가 발생했습니다. 새로고침하면 대개 해결됩니다.',
  'crash.reload': '새로고침',
};
