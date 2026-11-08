/** React-free, so the kiosk can import it (lib/assets.ts pulls in React
 *  through ./godEdit). */

/** An asset's Location as shown: "<container> · on <truck>", "<container>",
 *  or the location text ('' when there is none — callers add their '—').
 *  The one text every Location column sorts, filters, searches and exports
 *  by, so it always matches what AssetLocation renders. */
export function placementText(p: {
  location_detail?: string | null; container_name?: string | null; truck_name?: string | null;
}): string {
  if (p.container_name) return p.truck_name ? `${p.container_name} · on ${p.truck_name}` : p.container_name;
  return p.location_detail ?? '';
}
