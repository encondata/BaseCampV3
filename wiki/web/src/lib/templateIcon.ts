/** A template's `icon` is a glyph (an emoji) shown before its name. The
 *  builtins were first seeded with icon *names* ("compass"), which a
 *  database may still hold, and an icon typed by hand can be a word; a
 *  plain ASCII word is never printed as if it were a glyph. */
const NAMED: Record<string, string> = {
  'clipboard-list': '📋',
  compass: '🧭',
  wrench: '🔧',
  users: '👥',
};

const PLAIN_WORD = /^[\x20-\x7e]*$/;

/** The glyph to print for `icon`: a known icon name's emoji, nothing for
 *  any other plain-ASCII text, else the value itself. */
export function templateGlyph(icon: string | null | undefined): string {
  const value = (icon ?? '').trim();
  if (NAMED[value]) return NAMED[value];
  return PLAIN_WORD.test(value) ? '' : value;
}

/** A template's name with its glyph (if any) in front. */
export function templateTitle(t: { icon: string | null | undefined; name: string }): string {
  const glyph = templateGlyph(t.icon);
  return glyph ? `${glyph} ${t.name}` : t.name;
}
