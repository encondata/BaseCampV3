/** A punch that failed: what happened, and Try again (the same punch). */

export default function PunchError({ error, busy, onRetry }: {
  error: string; busy: boolean; onRetry(): void;
}) {
  return (
    <div className="tcx-punch-error" role="alert">
      <p>{error}</p>
      <button type="button" className="tcx-btn is-primary is-small" disabled={busy} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
