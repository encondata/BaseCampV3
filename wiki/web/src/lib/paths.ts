/** Where a library's pages live in the app.
 *
 *  People see "library" and "libraries"; the code, the API (/wiki/spaces,
 *  space_key, space_id) and the database still say "space" — a library IS
 *  a space, only the word on screen changed. The old /s/<key>… and
 *  /trash/<key> paths redirect here (see WikiShell), so bookmarks and older
 *  links keep working. */
import { useEffect } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

export type LibrarySection = 'settings' | 'due' | 'trash';

export function libraryPath(key: string, section?: LibrarySection): string {
  const base = `/library/${encodeURIComponent(key)}`;
  return section ? `${base}/${section}` : base;
}

/** The "New library" form (a modal over Home). */
export const NEW_LIBRARY_PATH = '/libraries/new';

/** The ?library=<key> filter on /search and /analytics (the API still
 *  calls it `space`). An older ?space= link reads the same. */
export function libraryParam(params: URLSearchParams): string {
  return params.get('library') ?? params.get('space') ?? '';
}

/** Rewrites an older ?space=<key> to ?library=<key> in place (a replace
 *  navigation, so Back doesn't return to the old form). */
export function useLibraryParamUpgrade(params: URLSearchParams, setParams: SetURLSearchParams): void {
  const legacy = params.has('space');
  useEffect(() => {
    if (!legacy) return;
    setParams((cur) => {
      const p = new URLSearchParams(cur);
      const key = p.get('library') ?? p.get('space') ?? '';
      p.delete('space');
      if (key) p.set('library', key); else p.delete('library');
      return p;
    }, { replace: true });
  }, [legacy, setParams]);
}
