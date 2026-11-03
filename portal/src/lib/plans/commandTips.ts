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
import type { PlanPermissions } from './api';
import { planShortcutKeys, type PlanShortcutId, type Platform } from './shortcuts';

export interface CommandTip {
  /** The button's name (its aria-label, or its text). */
  label: string;
  /** What it does, in one plain sentence. */
  desc: string;
  shortcut?: PlanShortcutId;
}

/** More's menu in order: who has each part (`templates`: change or delete;
 *  `always`: everyone who sees the plan) and what it lets them do. */
const MORE_PARTS: readonly (readonly ['change' | 'add' | 'templates' | 'always' | 'delete', string])[] = [
  ['change', 'set or clear the baseline, update the project, lock the schedule, change plan settings'],
  ['add', 'save the plan as a template'],
  ['templates', 'manage templates'],
  ['change', 'import tasks from a file'],
  ['always', 'export the plan for MS Project or Excel'],
  ['always', 'choose the sheet’s columns'],
  ['always', 'see the keyboard shortcuts'],
  ['delete', 'delete the plan'],
];

/** More's sentence for these permissions: what its menu holds for them,
 *  in menu order ("Choose the sheet’s columns, or see the keyboard
 *  shortcuts."). PlanToolbar builds the menu by the same rules. */
export function moreDesc(p: PlanPermissions): string {
  const has = { change: p.change, add: p.add, templates: p.change || p.delete, always: true, delete: p.delete };
  const parts = MORE_PARTS.filter(([need]) => has[need]).map(([, text]) => text);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}` : parts[0];
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export const COMMAND_TIPS = {
  // the view switcher: one menu button named by the view on, these its items
  view: { label: 'View', desc: 'Choose how to see the plan: the Gantt, a month Calendar or the Board.' },
  viewGantt: { label: 'Gantt', desc: 'Show the task sheet with its Gantt chart.' },
  viewCalendar: { label: 'Calendar', desc: 'Show the tasks on a month calendar.' },
  viewBoard: {
    label: 'Board', desc: 'Show the tasks as cards in Not started, In progress and Complete; drag a card to update it.',
  },

  // the Calendar's month steps
  calPrev: { label: 'Previous month', desc: 'Show the month before.' },
  calToday: { label: 'Today', desc: 'Show the month of the plan’s today.' },
  calNext: { label: 'Next month', desc: 'Show the month after.' },
  // a Board card's menu (named for its task: "Actions for <name>")
  cardActions: { label: 'Actions', desc: 'Move the task to another column, or open its Task Information.' },
  cardActionsReadOnly: { label: 'Actions', desc: 'Open the task’s Task Information.' },

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
  strip: {
    label: 'Timeline strip', desc: 'Show the timeline above the Gantt: the project’s span and the tasks added to it.',
  },
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
  // More: what its menu holds with every permission (the tip itself is
  // moreDesc(): only what this person's menu holds)
  more: { label: 'More', desc: moreDesc({ view: true, add: true, change: true, delete: true }) },
  // More's template commands (Save as template…: add; Templates…: change or delete)
  saveTemplate: {
    label: 'Save as template…',
    desc: 'Keep this plan’s tasks, durations, links and calendar to start new plans from.',
  },
  templates: { label: 'Templates…', desc: 'Rename, describe or delete the saved plan templates.' },
  // More's import (`change`, an unlocked schedule) and its Export group (`view`; Task 10's PDF… joins it)
  importFile: {
    label: 'Import…',
    desc: 'Add tasks from an MS Project XML file, an Excel workbook or a CSV, after reviewing what each row does.',
  },
  exportGroup: { label: 'Export', desc: 'Download the plan to open in MS Project or Excel.' },
  exportXml: {
    label: 'MS Project XML',
    desc: 'Download the plan as an XML file MS Project opens: its tasks, links, calendar and resources.',
  },
  exportXlsx: {
    label: 'Excel', desc: 'Download the sheet’s visible columns as an Excel workbook, the names indented by outline.',
  },
  // a template's menu in the Templates dialog (named for it: "Actions for <name>")
  templateActions: { label: 'Actions', desc: 'Rename the template, edit its description, or delete it.' },
  templateActionsDelete: { label: 'Actions', desc: 'Delete the template.' },
  templateActionsEdit: { label: 'Actions', desc: 'Rename the template, or edit its description.' },
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
  ganttOnly: 'Switch to the Gantt view to use this',
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
