/** The result of a connection test: one chip, label and value per check. */
import type { DeployCheck } from '../lib/sirdarApi';

const CHIP: Record<DeployCheck['status'], [string, string]> = {
  pass: ['c-green', 'Pass'], warn: ['c-amber', 'Warning'], fail: ['c-red', 'Fail'],
};

export default function CheckList({ checks, label }: { checks: DeployCheck[]; label: string }) {
  return (
    <ul className="sirdar-checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.label}>
          <span className={`chip ${CHIP[c.status][0]}`}>{CHIP[c.status][1]}</span>
          <b>{c.label}</b>
          <span className="cell-sub">{c.value}</span>
        </li>
      ))}
    </ul>
  );
}
