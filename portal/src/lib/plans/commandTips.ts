/**
 * Every command on the Project plan page, in one table, for its hover tip
 * (components/Tip): the name its button carries (the button's accessible
 * name, so the tip and a screen reader say the same), one plain sentence
 * on what it does for people new to MS Project, and its shortcut's id in
 * lib/plans/shortcuts (the table the keys and the Keyboard shortcuts dialog
 * read, so the keycaps never disagree with what a key does). Then the
 * reasons a command is off, the tip's last line.
 *
 * American English, MS Project's vocabulary, one short sentence each.
 */
import { planShortcutKeys, type PlanShortcutId, type Platform } from './shortcuts';

export interface CommandTip {
  /** The button's name (its aria-label, or its text). */
  label: string;
  /** What it does, in one plain sentence. */
  desc: string;
  shortcut?: PlanShortcutId;
}

export const COMMAND_TIPS = {
  // the view switcher (Calendar and Board arrive in Plan C)
  viewGantt: { label: 'Gantt', desc: 'Show the task sheet with its Gantt chart.' },

  // Undo
  undo: { label: 'Undo', desc: 'Take back your last change.', shortcut: 'undo' },
  redo: { label: 'Redo', desc: 'Put back the change you just undid.', shortcut: 'redo' },

  // Schedule
  pct0: { label: '0% Complete', desc: 'Mark the selected tasks as not started.' },
  pct25: { label: '25% Complete', desc: 'Set the selected tasks to 25% complete.' },
  pct50: { label: '50% Complete', desc: 'Set the selected tasks to 50% complete.' },
  pct75: { label: '75% Complete', desc: 'Set the selected tasks to 75% complete.' },
  pct100: { label: '100% Complete', desc: 'Mark the selected tasks as finished.' },
  markOnTrack: { label: 'Mark on Track', desc: 'Set progress to where the task should be as of the status date.' },
  link: {
    label: 'Link Tasks', desc: 'Make each selected task follow the one before it (Finish-to-Start).', shortcut: 'link',
  },
  unlink: {
    label: 'Unlink Tasks', desc: 'Remove the links between the selected tasks, or all of one task’s links.',
    shortcut: 'unlink',
  },
  outdent: { label: 'Outdent', desc: 'Move the selected tasks up one outline level.', shortcut: 'outdent' },
  indent: { label: 'Indent', desc: 'Make the selected tasks subtasks of the task above.', shortcut: 'indent' },

  // Tasks
  auto: { label: 'Auto Schedule', desc: 'Let the plan set the selected tasks’ dates from their links and durations.' },
  manual: { label: 'Manually Schedule', desc: 'Keep the dates you enter on the selected tasks; links won’t move them.' },

  // Insert
  insertTask: { label: 'Insert Task', desc: 'Add a task above the selected one, or at the end.', shortcut: 'insert' },
  insertSummary: { label: 'Insert Summary Task', desc: 'Add a summary task, with a first subtask, above the selected one.' },
  insertMilestone: { label: 'Insert Milestone', desc: 'Add a zero-duration milestone above the selected task.' },

  // Properties
  info: { label: 'Information', desc: 'Open Task Information for the selected task.', shortcut: 'info' },
  notes: { label: 'Notes', desc: 'Open the selected task’s notes.' },
  timeline: { label: 'Add to Timeline', desc: 'Show the selected tasks on the timeline.' },
  color: { label: 'Task color', desc: 'Color the selected tasks’ bars on the Gantt chart.' },

  // Display
  critical: { label: 'Critical Path', desc: 'Show in red the tasks that set the project’s finish date.' },
  baseline: { label: 'Baseline', desc: 'Show the saved baseline under each bar.' },
  zoomOut: { label: 'Zoom Out', desc: 'Show more time in the chart, in less detail.' },
  zoomIn: { label: 'Zoom In', desc: 'Show less time in the chart, in more detail.' },
  fit: { label: 'Fit Project', desc: 'Zoom so the whole project fits in the chart.' },
  scrollToTask: {
    label: 'Scroll to Task', desc: 'Scroll the chart to the selected task’s bar.', shortcut: 'scrollToTask',
  },

  // the Gantt layout: one button at the end of Display, its menu's items
  layout: { label: 'Gantt Layout', desc: 'Choose where the Gantt chart goes: beside the sheet, below it, or hidden.' },
  layoutBeside: { label: 'Beside', desc: 'Show the Gantt chart beside the task sheet.' },
  layoutBelow: {
    label: 'Below',
    desc: 'Show the Gantt chart under the task sheet — for narrower screens; Full screen gives it the most room.',
  },
  layoutHidden: { label: 'Hidden', desc: 'Hide the Gantt chart and show only the task sheet.' },

  // the filter bar (Read-only people have it too)
  filter: {
    label: 'Filter',
    desc: 'Show only the tasks that match, their summary tasks dimmed to keep the outline. Tasks you add or '
      + 'change stay until you filter again.',
  },
  groupBy: {
    label: 'Group by',
    desc: 'List the tasks under each resource or status. The outline and the links come back with No Group.',
  },
  search: { label: 'Search', desc: 'Find tasks by name, notes or resource names.', shortcut: 'find' },

  // More, and what's around the toolbar
  // More: what its menu holds for you
  more: {
    label: 'More',
    desc: 'Set or clear the baseline, update the project, lock the schedule, change plan settings, choose '
      + 'columns, see the shortcuts, or delete the plan.',
  },
  moreNoDelete: {
    label: 'More',
    desc: 'Set or clear the baseline, update the project, lock the schedule, change plan settings, choose '
      + 'columns, or see the shortcuts.',
  },
  moreReadOnly: { label: 'More', desc: 'Choose the sheet’s columns, or see the keyboard shortcuts.' },
  moreReadOnlyDelete: {
    label: 'More', desc: 'Choose the sheet’s columns, see the keyboard shortcuts, or delete the plan.',
  },
  fullScreen: { label: 'Full screen', desc: 'Give the plan the whole window.' },
  exitFullScreen: {
    label: 'Exit full screen', desc: 'Show the portal’s menus and page header again.', shortcut: 'exitFullScreen',
  },
  unlock: { label: 'Unlock', desc: 'Let the schedule change again: dates, links and the outline.' },
} as const satisfies Record<string, CommandTip>;

export type CommandTipId = keyof typeof COMMAND_TIPS;

/** Why a command is off: the tip's last line. */
export const OFF_NOTES = {
  locked: 'Schedule is locked',
  select: 'Select a task first',
  selectTwo: 'Select two or more tasks',
  noUndo: 'Nothing to undo',
  noRedo: 'Nothing to redo',
  zoomedOut: 'Zoomed out all the way',
  zoomedIn: 'Zoomed in all the way',
  noChart: 'Show the Gantt chart to use this',
  noBaseline: 'No baseline set',
  grouped: 'Turn off Group by to change the outline',
} as const;

/** Undo's sentence, naming the step it takes back ("Indent") when there is one. */
export function undoDesc(step: string | null): string {
  return step ? `Take back your last change: ${step}.` : COMMAND_TIPS.undo.desc;
}

/** Redo's sentence, naming the step it puts back when there is one. */
export function redoDesc(step: string | null): string {
  return step ? `Put back the change you just undid: ${step}.` : COMMAND_TIPS.redo.desc;
}

/** A command's keys as `platform` shows them, one keycap per binding (the
 *  tip splits on " / "); "" for none. */
export function tipKeys(id: CommandTipId, platform: Platform): string {
  const tip: CommandTip = COMMAND_TIPS[id];
  return tip.shortcut ? planShortcutKeys(tip.shortcut, platform).split(' or ').join(' / ') : '';
}
