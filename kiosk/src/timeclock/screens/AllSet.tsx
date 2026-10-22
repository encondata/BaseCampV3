/** You're All Set! The flow returns to its start on its own after DONE_MS. */

import { IconCheck } from '../icons';

export default function AllSet({ name, onDone }: { name: string; onDone(): void }) {
  return (
    <section className="tcx-screen tcx-done">
      <IconCheck className="tcx-check" />
      <h1 className="tcx-hero is-done">You&apos;re All Set!</h1>
      <p className="tcx-lead tcx-farewell">Have a great day, <strong>{name}!</strong></p>
      <button type="button" className="tcx-btn is-blue" onClick={onDone}>Done</button>
    </section>
  );
}
