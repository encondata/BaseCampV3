import type { SaveState } from './usePreferenceSave';

/** The tab's lead line + transient "saved" / error state. */
export default function SaveHint({ state, children }: { state: SaveState; children: React.ReactNode }) {
  return (
    <p className="page-hint">
      {children}{' '}
      {state === 'saved' && <span className="save-state">saved</span>}
      {state === 'error' && (
        <span className="save-state error">could not save — changes are local only</span>
      )}
    </p>
  );
}
