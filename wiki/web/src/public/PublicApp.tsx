/** The whole app at a public share link: one route, no session. */
import { Route, Routes } from 'react-router-dom';

import PublicView from './PublicView';

/** `/p/<token>` (a trailing slash is fine) — what `Root` serves signed out. */
export function isPublicPath(pathname: string): boolean {
  return /^\/p\/[^/]+\/?$/.test(pathname);
}

export default function PublicApp() {
  return (
    <Routes>
      <Route path="/p/:token" element={<PublicView />} />
    </Routes>
  );
}
