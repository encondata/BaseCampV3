/** The thin orange progress bar (training list, quiz). `value` of `max`. */
export default function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="learn-pbar" role="progressbar" aria-label={label}
         aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ inlineSize: `${pct}%` }} />
    </div>
  );
}
