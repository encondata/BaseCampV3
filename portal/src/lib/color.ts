/** WCAG-relative-luminance text-color pick for arbitrary fills (rack
 *  faceplates colored by user-managed asset-category colors). Accepts
 *  #rgb / #rrggbb (case-insensitive); anything else falls back to dark
 *  text so malformed vocab colors never produce white-on-white. */
export function readableTextColor(hex: string): '#111827' | '#ffffff' {
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(hex.trim());
  if (!m) return '#111827';
  const raw = m[1] ? [...m[1]].map((c) => c + c).join('') : m[2];
  const channel = (i: number) => {
    const v = parseInt(raw.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return lum > 0.45 ? '#111827' : '#ffffff';
}
