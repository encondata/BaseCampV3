/** A person's stable collaborator color — the same answer the API gives
 *  (api/src/serversherpa/wiki/pages.py::person_color: the uuid as a
 *  128-bit integer, modulo the palette). Keep PERSON_COLORS in step with
 *  the API's. */
export const PERSON_COLORS = [
  '#1f6feb', '#c2410c', '#15803d', '#9333ea', '#be123c', '#0e7490',
  '#a16207', '#4d7c0f', '#7c3aed', '#b91c1c', '#0369a1', '#9d174d',
] as const;

export function personColor(personId: string): string {
  const hex = personId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return PERSON_COLORS[0];
  return PERSON_COLORS[Number(BigInt(`0x${hex}`) % BigInt(PERSON_COLORS.length))];
}
