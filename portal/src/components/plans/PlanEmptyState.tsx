/**
 * An initiative with no plan yet: "No project plan yet" and, for
 * `project_plans:add` holders, the three ways to start as ChoiceCards.
 * Templates and import arrive in Plan C; until then their cards are shown
 * disabled with "Coming soon" (Plan C removes the hint and wires them).
 */

import { ChoiceCard } from '../reports/ReportOptionsLayout';

import '../../styles/reports.css';   // .rgm-choice-card
import '../../styles/plans.css';

const COMING_SOON = 'Coming soon';

export default function PlanEmptyState({ canAdd, onBlank }: {
  canAdd: boolean;
  onBlank: () => void;
}) {
  return (
    <section className="init-panel pln-empty" aria-labelledby="pln-empty-title">
      <p className="eyebrow-sm">Project plan</p>
      <h2 id="pln-empty-title" className="pln-empty-title">No project plan yet</h2>
      <p className="page-hint">
        {canAdd
          ? 'Schedule this initiative’s work like in MS Project: tasks, durations, links, resources and progress.'
          : 'Once someone starts a schedule for this initiative, it shows up here.'}
      </p>
      {canAdd && (
        <div className="rgm-choice-cards pln-empty-cards">
          <ChoiceCard variant="button" selected={false} onSelect={onBlank}
                      title="Blank plan"
                      description="Start from an empty schedule and add the tasks yourself." />
          <ChoiceCard variant="button" selected={false} onSelect={() => undefined} disabled
                      hint={COMING_SOON}
                      title="From a template"
                      description="Copy the tasks, durations and links of a saved plan." />
          <ChoiceCard variant="button" selected={false} onSelect={() => undefined} disabled
                      hint={COMING_SOON}
                      title="Import from MS Project or Excel"
                      description="Bring in an XML file saved from MS Project, or an Excel sheet." />
        </div>
      )}
    </section>
  );
}
