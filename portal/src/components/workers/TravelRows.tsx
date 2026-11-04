import type { WorkerItem } from '../../lib/workers';

/** A worker's travel answers as rows for a profile `dl.kv`: Will travel
 *  always (Yes, No, or a dash when not set); region and restrictions only
 *  when filled in. */
export default function TravelRows({ worker }: {
  worker: Pick<WorkerItem, 'will_travel' | 'travel_region' | 'travel_restrictions'>;
}) {
  return (
    <>
      <dt>Will travel</dt>
      <dd>{worker.will_travel == null ? '—' : worker.will_travel ? 'Yes' : 'No'}</dd>
      {worker.travel_region && (
        <><dt>Travel region</dt><dd>{worker.travel_region}</dd></>
      )}
      {worker.travel_restrictions && (
        <><dt>Travel restrictions</dt><dd>{worker.travel_restrictions}</dd></>
      )}
    </>
  );
}
