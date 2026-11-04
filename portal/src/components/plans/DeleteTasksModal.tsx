/**
 * Delete with a summary task selected (spec Keyboard map: "confirm if any
 * has subtasks"): what goes with it, then Delete or Cancel. Undo brings
 * everything back, so this asks once and says so.
 */
import { useState } from 'react';

import type { PlanTask } from '../../lib/plans/api';
import PlanModal from './PlanModal';

import '../../styles/profile.css';   // .btn-solid

export default function DeleteTasksModal({ tasks, subtasks, onConfirm, onClose }: {
  tasks: PlanTask[];
  subtasks: number;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const one = tasks.length === 1;
  const title = one ? `Delete “${tasks[0].name || 'Untitled task'}”?` : `Delete ${tasks.length} tasks?`;
  const with_ = `${subtasks} subtask${subtasks === 1 ? '' : 's'}`;
  const description = `${one ? 'Its' : 'Their'} ${with_} ${subtasks === 1 ? 'is' : 'are'} deleted too. Undo brings `
    + `${one && subtasks === 0 ? 'it' : 'them'} back.`;

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      onClose();
    }
  };

  return (
    <PlanModal title={title} description={description} busy={busy} onClose={onClose}
               footer={(
                 <>
                   <button type="button" className="btn-solid btn-danger" disabled={busy}
                           onClick={() => void confirm()}>Delete</button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                 </>
               )}>
      <ul className="pln-doomed" aria-label="Tasks to delete">
        {tasks.map((t) => (
          <li key={t.id}><span className="pln-doomed-id">{t.display_id}</span> {t.name || 'Untitled task'}</li>
        ))}
      </ul>
    </PlanModal>
  );
}
