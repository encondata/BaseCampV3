/** The portal's ToastHost, with inbox links resolved for the wiki: portal
 *  paths open on the portal, wiki links in-app (see lib/inboxLinks). */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import ToastHost from '@portal/components/ToastHost';

import { leaveFor, resolveInboxLink } from '../lib/inboxLinks';

export default function WikiToastHost() {
  const navigate = useNavigate();
  const openLink = useCallback((link: string) => {
    const target = resolveInboxLink(link);
    if (target.kind === 'app') navigate(target.to);
    else leaveFor(target.href);
  }, [navigate]);
  return <ToastHost openLink={openLink} />;
}
