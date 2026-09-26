/** Who else has the page open: an avatar per collaborator in their color
 *  (from the provider's awareness), the name as a tooltip. */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';

import { safeColor } from './extensions/cursors';

interface Person {
  key: string;
  name: string;
  color: string;
}

const MAX_SHOWN = 4;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** The other people in the document, one entry per person (several tabs
 *  of the same person show once). */
function othersOf(provider: HocuspocusProvider): Person[] {
  const awareness = provider.awareness;
  if (!awareness) return [];
  const seen = new Map<string, Person>();
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
    if (!user || typeof user.name !== 'string' || !user.name) return;
    const color = safeColor(user.color);   // set by their browser: never trusted
    const key = `${user.name}|${color}`;
    if (!seen.has(key)) seen.set(key, { key, name: user.name, color });
  });
  return [...seen.values()];
}

export default function PresenceStack({ provider }: { provider: HocuspocusProvider }) {
  const [people, setPeople] = useState<Person[]>(() => othersOf(provider));

  useEffect(() => {
    const update = () => setPeople(othersOf(provider));
    update();
    provider.on('awarenessChange', update);
    return () => { provider.off('awarenessChange', update); };
  }, [provider]);

  if (!people.length) return null;
  const shown = people.slice(0, MAX_SHOWN);
  const extra = people.length - shown.length;
  const names = people.map((p) => p.name).join(', ');
  return (
    <div className="we-presence" role="group" aria-label={`Also here: ${names}`}>
      {shown.map((p) => (
        <span key={p.key} className="we-presence-avatar" style={{ background: p.color }} title={p.name}>
          {initialsOf(p.name)}
        </span>
      ))}
      {extra > 0 && <span className="we-presence-avatar more" title={names}>+{extra}</span>}
    </div>
  );
}
