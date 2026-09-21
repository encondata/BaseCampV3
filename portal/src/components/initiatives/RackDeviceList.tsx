/**
 * RackDeviceList — the "manifest" panel beside the rack elevations: one
 * row per real device, ordered exactly as the rack reads (top of rack
 * first), grouped under FRONT/REAR subheads only when a rear elevation is
 * shown. Pure presentation over lib/initiatives' deviceListRows.
 */
import type { DeviceListRow } from '../../lib/initiatives';
import { UNCATEGORIZED_FILL } from '../../lib/initiatives';

export default function RackDeviceList({ rows, grouped }: {
  rows: DeviceListRow[]; grouped: boolean;
}) {
  let lastGroup: string | null = null;
  return (
    <div className="rack-device-list">
      {rows.map((r) => {
        const head = grouped && r.group !== lastGroup ? r.group : null;
        lastGroup = r.group;
        return (
          <div key={r.id}>
            {head && <div className="rack-list-group">{head}</div>}
            <div className={`rack-list-row${r.indent ? ' rack-list-child' : ''}`
              + `${r.orphan ? ' rack-list-orphan' : ''}`}>
              <span className="rack-list-swatch"
                    style={{ background: r.categoryColor ?? UNCATEGORIZED_FILL }} />
              <span className="rack-list-name">{r.orphan ? `! ${r.name}` : r.name}</span>
              <span className="rack-list-model">{r.makeModel}</span>
              <span className="rack-list-ru">{r.ruText}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
