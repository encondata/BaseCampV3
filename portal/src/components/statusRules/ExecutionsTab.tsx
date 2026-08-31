/** Executions tab — stub. Task 12 replaces this with the per-fire log
 *  (listStatusRuleExecutions), so the page shell compiles and the tab
 *  bar has somewhere to switch to in the meantime. */

export default function ExecutionsTab({ onCount: _onCount }: {
  onCount: (n: number | null) => void;
}) {
  return <div className="dir-empty">Execution history arrives with the next task.</div>;
}
