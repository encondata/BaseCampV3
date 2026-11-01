/**
 * ChannelChips — a group's (or a member's) channels as chips, for every
 * notification list. Only live channels show (lib/notifications.ts
 * LIVE_CHANNELS — Email today); stored text/push/web values stay stored but
 * are never listed. When nothing in the list can send, a slate "No email"
 * chip says so instead of leaving the cell blank.
 */

import { CHANNEL_LABELS, liveChannels } from '../../lib/notifications';

/** What a list with no live channel reads as — the same words the Channels
 *  filter, search and export use. */
export const NO_EMAIL = 'No email';

export default function ChannelChips({ channels }: { channels: readonly string[] }) {
  const live = liveChannels(channels);
  return (
    <div className="chips">
      {live.length === 0
        ? <span className="chip c-slate">{NO_EMAIL}</span>
        : live.map((c) => <span key={c} className="chip c-blue">{CHANNEL_LABELS[c]}</span>)}
    </div>
  );
}
