import type { CSSProperties } from 'react';

import type { WorkerLevelDef } from '../../lib/workers';

export default function LevelBadge({ level, levels }: { level: string | null; levels: WorkerLevelDef[] }) {
  if (!level) return <span className="chip tag">unleveled</span>;
  const def = levels.find((l) => l.level === level);
  return (
    <span className="lvl-badge" title={def ? `${def.title} — ${def.description}` : level}>
      <b style={{ '--lvl': def?.color ?? '#8a93a6' } as CSSProperties}>{level}</b>
      <span>{def?.title ?? ''}</span>
    </span>
  );
}
