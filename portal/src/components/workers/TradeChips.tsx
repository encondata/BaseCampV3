import { splitTrades } from '../../lib/workers';

/** A worker's comma-separated trade text as one chip per value. With no
 *  trades it renders the fallback as plain text (no chips wrapper), so
 *  callers can place it exactly where the old text sat. */
export default function TradeChips({ trade, fallback = '—' }: { trade: string | null | undefined; fallback?: string }) {
  const trades = splitTrades(trade);
  if (trades.length === 0) return <>{fallback}</>;
  return (
    <div className="chips">
      {trades.map((t) => <span key={t} className="chip tag" title={t}>{t}</span>)}
    </div>
  );
}
