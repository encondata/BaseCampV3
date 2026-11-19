/** Dates as YYYY-MM-DD and times as 24-hour HH:MM, in the viewer's time
 *  zone (the portal's own helpers are locale-formatted; its YYYY-MM-DD one
 *  lives in a module that pulls in the spreadsheet library). */
const pad2 = (n: number) => String(n).padStart(2, '0');

export function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayTime(iso: string): string {
  const d = new Date(iso);
  return `${day(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
