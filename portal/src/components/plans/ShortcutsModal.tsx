/**
 * More › Keyboard shortcuts (and `?`): the plan's keyboard map as a grid,
 * Windows beside Mac (lib/plans/shortcuts, the table the keys and the
 * toolbar's tooltips use), then the sheet's own editing keys.
 */
import { PLAN_SHORTCUTS, SHEET_KEYS } from '../../lib/plans/shortcuts';
import PlanModal from './PlanModal';

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <PlanModal title="Keyboard shortcuts" size="wide" onClose={onClose}
               description="MS Project’s keys. They work while the sheet has focus, not while a cell is being edited."
               footer={<button type="button" className="btn-solid" onClick={onClose}>Done</button>}>
      <div className="pln-keys" role="table" aria-label="Keyboard shortcuts">
        <div className="pln-keys-cols" role="row">
          <span role="columnheader">Action</span>
          <span role="columnheader">Windows</span>
          <span role="columnheader">Mac</span>
        </div>
        {PLAN_SHORTCUTS.map((s) => (
          <div key={s.id} className="pln-keys-line" role="row">
            <span role="cell">{s.label}</span>
            <span role="cell"><kbd>{s.win}</kbd></span>
            <span role="cell"><kbd>{s.mac}</kbd></span>
          </div>
        ))}
        <div className="pln-keys-cols pln-keys-sub" role="row">
          <span role="columnheader">In the sheet</span>
          <span role="columnheader" aria-hidden="true" />
          <span role="columnheader" aria-hidden="true" />
        </div>
        {SHEET_KEYS.map((s) => (
          <div key={s.label} className="pln-keys-line" role="row">
            <span role="cell">{s.label}</span>
            <span role="cell"><kbd>{s.win}</kbd></span>
            <span role="cell"><kbd>{s.mac}</kbd></span>
          </div>
        ))}
      </div>
    </PlanModal>
  );
}
