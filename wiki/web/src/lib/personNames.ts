/** Current names of people the @mention picker has listed, so a mention
 *  shows who it is now rather than the name stored when it was made. Fed
 *  only by the picker's answers (no lookup of its own): a mention of
 *  someone not seen this session shows its stored label. */
import type { PersonRef } from './types';

const names = new Map<string, string>();

export function rememberPersonNames(people: readonly PersonRef[]): void {
  for (const person of people) names.set(person.id, person.name);
}

export function personName(id: string): string | undefined {
  return names.get(id);
}

/** Forget every name (sign-out; tests). */
export function clearPersonNames(): void {
  names.clear();
}
