/** The paths libraries had while the UI called them "spaces": /s/<key>,
 *  /s/<key>/settings, /s/<key>/due, /trash/<key> and /spaces/new. Old
 *  bookmarks and links in older notifications land on the same place under
 *  /library/<key>… (see lib/paths), keeping ?query and #hash. */
import { Navigate, Route, useLocation, useParams } from 'react-router-dom';

import { libraryPath, NEW_LIBRARY_PATH, type LibrarySection } from '../lib/paths';

function LegacyLibraryRedirect({ section }: { section?: LibrarySection }) {
  const { spaceKey = '' } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`${libraryPath(spaceKey, section)}${search}${hash}`} replace />;
}

/** Route elements to spread inside a <Routes> (a function, not a
 *  component: <Routes> only reads <Route> elements and fragments). */
export function legacyLibraryRoutes() {
  return (
    <>
      <Route path="/spaces/new" element={<Navigate to={NEW_LIBRARY_PATH} replace />} />
      <Route path="/s/:spaceKey" element={<LegacyLibraryRedirect />} />
      <Route path="/s/:spaceKey/settings" element={<LegacyLibraryRedirect section="settings" />} />
      <Route path="/s/:spaceKey/due" element={<LegacyLibraryRedirect section="due" />} />
      <Route path="/trash/:spaceKey" element={<LegacyLibraryRedirect section="trash" />} />
    </>
  );
}
