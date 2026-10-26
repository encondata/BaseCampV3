/** "Sign in with an account": the portal's own sign-in page, named for
 *  the learn site, with a way back to the code form. Loaded on demand
 *  (SignIn lazy-imports it): its two-factor enrollment brings the QR
 *  encoder, which a worker typing a code never needs. */
import Login from '@portal/pages/Login';

import { t, useLang } from '../lib/i18n';

export default function AccountSignIn({ onUseCode }: { onUseCode: () => void }) {
  useLang();
  return (
    <Login
      eyebrow={t('app.name')}
      notice={(
        <button type="button" className="learn-back" onClick={onUseCode}>
          {t('signin.useCode')}
        </button>
      )}
    />
  );
}
