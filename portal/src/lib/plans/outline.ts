/**
 * Outline math for the sheet. An op answers only the rows it changed, plus
 * the whole outline order when it moved anything, so the client renumbers
 * every task itself: display IDs, WBS, outline levels, summaries and the
 * Predecessors / Successors text, by the API's own rules (plans/service.py:
 * _ordered_ids, _children, _walk, _outline, tasks_out). Plus the collapsed
 * view and the walks up and down the outline.
 */
import type { Units } from './durations';
import type { PlanLink, PlanTask } from './api';
import { formatPredecessors, type PredSpec } from './predecessors';

export type OutlineTask = Pick<PlanTask, 'id' | 'parent_id' | 'position'>;
export type OutlineLink = Pick<PlanLink, 'predecessor_id' | 'successor_id' | 'link_type' | 'lag_minutes'
  | 'lag_unit' | 'lag_elapsed'>;

export interface OutlineRow {
  displayId: number;          // index + 1 in outline order
  wbs: string;                // "1", "1.2", "1.2.1"
  level: number;              // 1 at the top
  isSummary: boolean;
  predecessors: string;       // "2,3SS+1 day", by display ID
  successors: string;
}

/** Every task's row, in outline order. */
export type Outline = Map<string, OutlineRow>;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `order` (the ids it names that the plan has, once each), then any task
 *  it misses, by position then id. */
function orderedIds(tasks: readonly OutlineTask[], order: readonly string[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (byId.has(id) && !seen.has(id)) {
      listed.push(id);
      seen.add(id);
    }
  }
  const rest = tasks.filter((t) => !seen.has(t.id))
    .sort((a, b) => a.position - b.position || byText(a.id, b.id));
  return [...listed, ...rest.map((t) => t.id)];
}

/** Each parent's direct subtasks in `ordered` order; null holds the top
 *  level. A parent the plan does not have reads as top level. */
function childrenOf(tasks: readonly Pick<PlanTask, 'id' | 'parent_id'>[], ordered: readonly string[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string | null, string[]>();
  for (const id of ordered) {
    const parent = byId.get(id)?.parent_id ?? null;
    const key = parent !== null && byId.has(parent) ? parent : null;
    const list = children.get(key);
    if (list) list.push(id); else children.set(key, [id]);
  }
  return children;
}

/**
 * Display IDs, WBS, levels, summaries and the link text of every task, the
 * way the API numbers them. `order` is the outline order (the plan's task
 * order, or an op's `order`); `units` are the plan calendar's (unitsOf).
 */
export function computeOutline(
  tasks: readonly OutlineTask[], order: readonly string[], links: readonly OutlineLink[], units: Units,
): Outline {
  const ordered = orderedIds(tasks, order);
  const children = childrenOf(tasks, ordered);
  const display = new Map(ordered.map((id, i) => [id, i + 1]));

  // depth first, each parent before its subtasks; a parent loop (never
  // valid) is not reached and is numbered flat below
  const wbs = new Map<string, string>();
  const level = new Map<string, number>();
  const stack: [string, string, number][] = (children.get(null) ?? [])
    .map((id, i): [string, string, number] => [id, String(i + 1), 1]).reverse();
  while (stack.length) {
    const [id, number, depth] = stack.pop()!;
    if (wbs.has(id)) continue;
    wbs.set(id, number);
    level.set(id, depth);
    const kids = children.get(id) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push([kids[i], `${number}.${i + 1}`, depth + 1]);
  }

  const into = new Map<string, OutlineLink[]>();
  const outOf = new Map<string, OutlineLink[]>();
  const add = (map: Map<string, OutlineLink[]>, key: string, link: OutlineLink) => {
    const list = map.get(key);
    if (list) list.push(link); else map.set(key, [link]);
  };
  for (const link of links) {
    add(into, link.successor_id, link);
    add(outOf, link.predecessor_id, link);
  }
  const linkText = (list: readonly OutlineLink[] | undefined, otherEnd: (l: OutlineLink) => string): string => {
    const specs: PredSpec[] = [];
    for (const link of list ?? []) {
      const displayId = display.get(otherEnd(link));
      if (displayId === undefined) continue;
      specs.push({
        displayId, linkType: link.link_type,
        lag: { minutes: link.lag_minutes, unit: link.lag_unit, elapsed: link.lag_elapsed },
      });
    }
    return formatPredecessors(specs.sort((a, b) => a.displayId - b.displayId), units);
  };

  const outline: Outline = new Map();
  for (const id of ordered) {
    const displayId = display.get(id)!;
    outline.set(id, {
      displayId,
      wbs: wbs.get(id) ?? String(displayId),
      level: level.get(id) ?? 1,
      isSummary: children.has(id),
      predecessors: linkText(into.get(id), (l) => l.predecessor_id),
      successors: linkText(outOf.get(id), (l) => l.successor_id),
    });
  }
  return outline;
}

/** The ancestors of `id`, nearest first; stops at a missing parent or a loop. */
export function ancestors(id: string, tasksById: ReadonlyMap<string, Pick<PlanTask, 'parent_id'>>): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let up = tasksById.get(id)?.parent_id ?? null;
  while (up !== null && tasksById.has(up) && !seen.has(up)) {
    out.push(up);
    seen.add(up);
    up = tasksById.get(up)?.parent_id ?? null;
  }
  return out;
}

/** The rows of `order` a person sees: every task with no collapsed summary
 *  above it (a collapsed summary itself stays). */
export function visibleRows(
  order: readonly string[], tasksById: ReadonlyMap<string, Pick<PlanTask, 'parent_id'>>,
  collapsed: ReadonlySet<string>,
): string[] {
  // a walk up per row: outlines are shallow, so this stays linear in practice
  return order.filter((id) => tasksById.has(id)
    && (!collapsed.size || !ancestors(id, tasksById).some((a) => collapsed.has(a))));
}

/** Every task below `id`, in outline order (the order of `tasks`). */
export function descendants(id: string, tasks: readonly Pick<PlanTask, 'id' | 'parent_id'>[]): string[] {
  const children = childrenOf(tasks, tasks.map((t) => t.id));
  const out: string[] = [];
  const seen = new Set([id]);
  const stack = [...(children.get(id) ?? [])].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    const kids = children.get(next) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}
