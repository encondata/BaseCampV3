/** Where a library's pages live in the app.
 *
 *  People see "library" and "libraries"; the code, the API (/wiki/spaces,
 *  space_key, space_id) and the database still say "space" — a library IS
 *  a space, only the word on screen changed. The old /s/<key>… and
 *  /trash/<key> paths redirect here (see WikiShell), so bookmarks and older
 *  links keep working. */
export type LibrarySection = 'settings' | 'due' | 'trash';

export function libraryPath(key: string, section?: LibrarySection): string {
  const base = `/library/${encodeURIComponent(key)}`;
  return section ? `${base}/${section}` : base;
}

/** The "New library" form (a modal over Home). */
export const NEW_LIBRARY_PATH = '/libraries/new';
