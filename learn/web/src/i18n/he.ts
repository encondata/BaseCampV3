import type { Dictionary } from './en';

/** Hebrew (convenience translation; English governs). Right to left:
 *  lib/i18n.ts sets dir="rtl" on the page. */
export const he: Dictionary = {
  'app.name': 'ServerSherpa Learn',
  'app.short': 'Learn',
  'scene.sub': 'קראו וחתמו על ההדרכה לפני המשמרת הראשונה, מכל טלפון או מחשב.',

  'signin.title': 'הזינו את קוד הלמידה',
  'signin.hint': 'הוא נמצא בהודעת ההזמנה שקיבלתם במייל.',
  'signin.code': 'קוד למידה',
  'signin.codeBox': 'תו {n} מתוך 6',
  'signin.lastName': 'שם משפחה',
  'signin.continue': 'המשך',
  'signin.signingIn': 'מתחברים…',
  'signin.incomplete': 'הזינו את הקוד בן 6 התווים ואת שם המשפחה.',
  'signin.or': 'או',
  'signin.account': 'כניסה עם חשבון',
  'signin.useCode': 'כניסה עם קוד למידה',
  'signin.language': 'שפה',

  'error.learn_code_invalid':
    'הקוד ושם המשפחה אינם תואמים, או שהיו יותר מדי ניסיונות. בדקו את הודעת ההזמנה או המתינו כמה דקות.',
  'error.rate_limited': 'יותר מדי ניסיונות. המתינו כמה דקות ונסו שוב.',
  'error.network': 'אין חיבור לשרת. בדקו את החיבור ונסו שוב.',
  'error.unknown': 'משהו השתבש. נסו שוב.',

  'start.signingIn': 'מחברים אתכם…',
  'start.invalid': 'הקישור הזה כבר לא פעיל. היכנסו עם הקוד שבהודעת ההזמנה.',
  'start.enterCode': 'הזנת קוד',

  'crash.title': 'משהו השתבש',
  'crash.hint': 'אירעה שגיאה בדף. טעינה מחדש בדרך כלל פותרת את הבעיה.',
  'crash.reload': 'טעינה מחדש',
};
