/** After a Clock In (the punch is already recorded): a new badge or not. */

export default function BadgeQuestion({ onNew, onExisting }: { onNew(): void; onExisting(): void }) {
  return (
    <section className="tcx-screen tcx-badge">
      <h1 className="tcx-title">Do you need a new badge?</h1>
      <div className="tcx-buttons">
        <button type="button" className="tcx-btn is-primary" onClick={onNew}>Print a new badge</button>
        <button type="button" className="tcx-btn is-ghost" onClick={onExisting}>My badge works</button>
      </div>
    </section>
  );
}
