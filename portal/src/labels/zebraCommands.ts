/**
 * ZPL command builders for the Printers page tools (identity/status
 * queries, E: object management, media/quality settings, save/reset) and
 * the font-file helpers the Install Fonts flow shares with the API's
 * validation. Pure strings — the transport (`zebraUsb.ts`) sends them.
 */

export const HOST_IDENTIFICATION = '~HI';
export const HOST_STATUS = '~HS';
export const CALIBRATE = '~JC';
export const PRINT_CONFIGURATION_LABEL = '~WC';
export const SAVE_SETTINGS = '^XA^JUS^XZ';
export const FACTORY_DEFAULTS = '^XA^JUF^XZ';

export const configurationQuery = (): string => '^XA^HH^XZ';
export const directoryQuery = (drive = 'E'): string => `^XA^HW${drive}:*.*^XZ`;
export const deleteObject = (drive: string, name: string): string => `^XA^ID${drive}:${name}^XZ`;

/** `~DYd:name,B,T,<bytes>,,` — binary TrueType download; the file bytes
 *  follow the header on the same stream. */
export const downloadFontHeader = (drive: string, name: string, totalBytes: number): string =>
  `~DY${drive}:${name},B,T,${totalBytes},,`;

const clampInt = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min);

export const setDarkness = (n: number): string => `~SD${String(clampInt(n, 0, 30)).padStart(2, '0')}`;
export const setPrintSpeed = (ips: number): string => `^XA^PR${clampInt(ips, 2, 14)}^XZ`;

export type MediaTracking = 'W' | 'M' | 'N' | 'A';
export type PrintMode = 'T' | 'P' | 'C' | 'R';
export type PrintMethod = 'D' | 'T';

export const setMediaTracking = (m: MediaTracking): string => `^XA^MN${m}^XZ`;
export const setPrintMode = (m: PrintMode): string => `^XA^MM${m}^XZ`;
export const setPrintMethod = (m: PrintMethod): string => `^XA^MT${m}^XZ`;
/** `^LL` only makes sense on continuous media, where the printer can't
 *  measure the label length itself; pass `null` on gap/mark media to emit
 *  `^PW` alone. */
export const setLabelSize = (widthDots: number, lengthDots: number | null): string =>
  lengthDots === null
    ? `^XA^PW${Math.round(widthDots)}^XZ`
    : `^XA^PW${Math.round(widthDots)}^LL${Math.round(lengthDots)}^XZ`;

const FONT_NAME_RE = /^[A-Z0-9_]{1,8}\.TTF$/;

/** Zebra object name for a font file: bare filename, upper-cased, only
 *  valid as 8.3 `NAME.TTF` (letters, digits, underscore). */
export function fontObjectName(filename: string): string | null {
  const bare = filename.split(/[\\/]/).pop() ?? '';
  const name = bare.toUpperCase();
  return FONT_NAME_RE.test(name) ? name : null;
}

export function isTrueType(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b = bytes.subarray(0, 4);
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)
    || (b[0] === 0x74 && b[1] === 0x72 && b[2] === 0x75 && b[3] === 0x65); // 'true'
}

/** `~HI` reports dots per millimeter; Zebra's nominal DPIs are the usual
 *  203/300/600 rather than the exact conversion. */
export function dpiFromDotsPerMm(dpmm: number): number {
  const nominal: Record<number, number> = { 6: 150, 8: 203, 12: 300, 24: 600 };
  return nominal[dpmm] ?? Math.round(dpmm * 25.4);
}
