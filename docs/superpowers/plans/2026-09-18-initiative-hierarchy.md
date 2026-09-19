# Initiative Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show parent/child initiative structure as nested tree rows in the list and the timeline, and as parent-labeled, collapse-aware segments on the calendar.

**Architecture:** The API adds a visibility-filtered `parent_id` to list items. One pure `buildInitiativeTree` in `lib/initiatives.ts` turns any sorted, filtered item set into flat rows with depth/expansion/context flags, and both pages render those rows through their existing row markup. A shared `localStorage` collapsed set keeps the list and timeline in agreement. The API refuses a second parent so the tree stays a tree.

**Tech Stack:** FastAPI / SQLAlchemy 2 async / pytest; React + TypeScript / Vitest.

## Global Constraints

- Branch `initiative-hierarchy`, off `main` @ `9fdfc71`. Worktree `.claude/worktrees/timeclock`. Run every command from the worktree root.
- **API tests:** `PYTHONPATH=api/src api/.venv/bin/python -m pytest ...`. **One pytest run at a time** — `pgrep -f "pytest api/tests"` first. **No full API suite per task** (~21 min); targeted files only, full suite ONCE in Task 5.
- **Portal:** run the WHOLE suite (`npm --prefix portal test`, ~20s), plus `npx --prefix portal tsc --noEmit -p portal/tsconfig.json`. No `npm install`.
- No migration. Head stays `0067`.
- **Security invariant:** `parent_id` must be `null` whenever the parent is outside the actor's scope. This mirrors `links_count` at `routes/initiatives.py:166-168`; a test must pin it.
- American English. Never commit `api/src/serversherpa/_dev_reload.py`.
- End commit messages with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

## Key facts established by exploration

- `InitiativeLink(parent_id, child_id, role, sort_order, notes)`; any type may parent any type; API enforces acyclicity (`_ancestor_ids`). Dev DB: one link, `Parent Test Project`(project) → `Child Test Event`(event), role `Event 1`.
- `GET /initiatives` builds items around `routes/initiatives.py:150-231`; `links_count` uses `scope_conditions("initiatives", actor.access, actor.person.id)` joined on the far-end initiative.
- `POST /{id}/links` at `:632-690` already raises `self_link`, `initiative_not_found`, `duplicate_link`, `circular_link`. Error sentences live in `portal/src/lib/initiatives.ts:80-82`.
- `Initiatives.tsx` (819 lines): `visible` memo at `:252` (archived → type pill → column filters → search → sort); rows via `VirtualRows` at `:452`, primary cell `.pn` at `:470`. List prefs via `usePersistentListState('initiatives', ...)` at `:184`.
- `InitiativeTimeline.tsx` (546 lines): `filtered` memo at `:177`; `View = 'timeline' | 'calendar'`; timeline rows at `:361` (`.itl-row-label` + `.itl-row-bars`), "Unscheduled" divider at `:391`; calendar via `calendarWeeks(items, cells)` from `lib/timeline.ts`. Page prefs are plain `localStorage` (`loadPref`).
- Precedent for mixed row kinds through `VirtualRows`: `groupContainers` in `lib/containers.ts:202`.

---

### Task 1: `parent_id` on the list, and one parent per child

**Files:** `api/src/serversherpa/api/routes/initiatives.py`, `api/src/serversherpa/api/schemas.py`, test `api/tests/test_initiatives_links_api.py` (extend, or the file that already tests `/links`).

**Interfaces produced:** `InitiativeItem.parent_id: uuid.UUID | None`; `POST /{id}/links` → `409 {"code": "already_has_parent"}`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_list_carries_parent_id_for_a_visible_parent(client, db, admin):
    parent = await _initiative(db, "Parent P", "project")
    child = await _initiative(db, "Child E", "event")
    await _link(db, parent.id, child.id, role="Event 1")
    items = {i["name"]: i for i in (await client.get("/initiatives", headers=admin)).json()}
    assert items["Child E"]["parent_id"] == str(parent.id)
    assert items["Parent P"]["parent_id"] is None


async def test_parent_id_is_null_when_the_parent_is_out_of_scope(client, db, client_user):
    """Mirrors the links_count invariant: a child must not point at a parent
    the actor cannot see — that id alone confirms the parent exists."""
    parent = await _initiative(db, "Other client's project", "project", client_id=OTHER_CLIENT)
    child = await _initiative(db, "My event", "event", client_id=MY_CLIENT)
    await _link(db, parent.id, child.id)
    items = {i["name"]: i for i in (await client.get("/initiatives", headers=client_user)).json()}
    assert "Other client's project" not in items
    assert items["My event"]["parent_id"] is None


async def test_a_second_parent_is_refused(client, db, admin):
    p1 = await _initiative(db, "P1", "project"); p2 = await _initiative(db, "P2", "project")
    child = await _initiative(db, "C", "event")
    ok = await client.post(f"/initiatives/{p1.id}/links", json={"child_id": str(child.id)}, headers=admin)
    assert ok.status_code == 200
    dup = await client.post(f"/initiatives/{p2.id}/links", json={"child_id": str(child.id)}, headers=admin)
    assert dup.status_code == 409
    assert dup.json()["detail"]["code"] == "already_has_parent"
```

Read the existing links test file first and reuse its `_initiative`/`_link`/actor helpers and its client-scoping fixtures; adapt the placeholder names above to what exists.

- [ ] **Step 2: Run to verify they fail** — `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -k "initiativ and link" -v`. Expected: `parent_id` KeyError; second link returns 200.

- [ ] **Step 3: Implement**

Schema: add `parent_id: uuid.UUID | None = None` to `InitiativeItem`.

Route, beside the `children_q` count (`:166-175`), one more scoped query keyed by child:

```python
    # parent_id obeys the SAME scope as links_count: a child whose parent the
    # actor cannot see gets None, so the id alone never confirms that an
    # out-of-scope initiative exists. First link wins if a legacy row somehow
    # has two — the tree builder tolerates that too.
    parent_q = (select(InitiativeLink.child_id, InitiativeLink.parent_id)
                .join(Initiative, Initiative.id == InitiativeLink.parent_id)
                .where(InitiativeLink.child_id.in_(ids), *cond)
                .order_by(InitiativeLink.child_id, InitiativeLink.created_at))
    parent_of: dict[uuid.UUID, uuid.UUID] = {}
    for child_id, parent_id in (await db.execute(parent_q)).all() if ids else []:
        parent_of.setdefault(child_id, parent_id)
```
and `"parent_id": parent_of.get(i.id)` in the item dict. Use the exact `cond` variable the count query already builds; do not re-derive scope.

`POST /{id}/links`, after the `duplicate_link` check and before `circular_link`:

```python
    # one parent per child: the list and timeline render a strict tree, and a
    # UI-only guard could be bypassed. Legacy multi-parent rows (none exist)
    # are tolerated by the readers; new ones are refused here.
    if await db.scalar(select(InitiativeLink.id)
                       .where(InitiativeLink.child_id == body.child_id).limit(1)):
        raise _err(409, "already_has_parent")
```

- [ ] **Step 4: Verify** — same `-k` run plus `-k initiativ` for neighbors. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(initiatives): list items carry a scope-filtered parent_id; one parent per child`

---

### Task 2: The tree builder

**Files:** `portal/src/lib/initiatives.ts`, `portal/src/lib/initiatives.test.ts` (extend), `portal/src/lib/api.ts` (add `parent_id: string | null` to `InitiativeItem`).

**Interfaces produced:**

```ts
export interface InitiativeTreeRow<T extends TreeItem> {
  item: T; depth: number; hasChildren: boolean; childCount: number;
  expanded: boolean; isContext: boolean; role: string | null;
}
export function buildInitiativeTree<T extends TreeItem>(
  items: readonly T[],            // already filtered to what the page may show, already sorted
  matched: ReadonlySet<string>,   // ids passing the page's own filters/search
  collapsed: ReadonlySet<string>,
): InitiativeTreeRow<T>[];
export function derivedSpan<T extends TreeItem>(node: T, children: readonly T[]): { start: string; end: string } | null;
export const COLLAPSED_KEY = 'initiatives.collapsed';
export function readCollapsed(): Set<string>;   // try/catch, [] on failure
export function writeCollapsed(s: ReadonlySet<string>): void;
```
`TreeItem` is `{ id: string; parent_id: string | null; scheduled_start?: string | null; scheduled_end?: string | null }`. `role` on a row comes from the child's link — since the list payload does not carry roles, Task 2 takes `role` from an optional `parent_role?: string | null` on the item; Task 1's `parent_of` map should therefore also carry the link's `role`, and the schema field is `parent_role`. **Amend Task 1 accordingly before starting it** (add `parent_role: str | None = None` and select `InitiativeLink.role` alongside `parent_id`).

- [ ] **Step 1: Failing tests** — table-driven per the spec: three-level chain yields depths 0/1/2; collapsed middle hides its subtree but keeps its own row with `expanded:false`; a matched grandchild with unmatched parent and grandparent yields both ancestors `isContext:true`; a child whose `parent_id` is not in `items` is a root at depth 0; sibling order equals input order; a defensive duplicate `(child under two parents)` appears once; `derivedSpan` returns `null` for no scheduled children, the envelope for mixed, and `null` when the node has its own dates.

- [ ] **Step 2: Run, fail, implement.** Build a `children: Map<parentId, T[]>` in input order (skip an item already placed — the defensive multi-parent rule), compute `hasMatchedDescendant` bottom-up, then emit depth-first from roots, stopping descent at collapsed nodes. `isContext = !matched.has(id) && hasMatchedDescendant`. Rows that are neither matched nor context are omitted.

- [ ] **Step 3: Verify** — whole portal suite + tsc. **Step 4: Commit** — `feat(initiatives): pure tree builder and derived span for the hierarchy views`

---

### Task 3: Tree rows in the list

**Files:** `portal/src/pages/Initiatives.tsx`, `portal/src/styles/directory.css` (or the initiatives stylesheet), `portal/src/pages/Initiatives.test.tsx`.

- [ ] **Step 1: Failing tests** — with the dev-DB shape (parent project + child event with role): the child renders indented under the parent with an `Event 1` chip; clicking the parent's chevron hides the child and the chevron flips; a search matching only the child still renders the parent as a dimmed context row; the result count reads `1` not `2` in that state; `localStorage['initiatives.collapsed']` round-trips.

- [ ] **Step 2: Implement.** Split today's `visible` memo into `matchedIds` (everything that passes archived/type/filters/search) and `sortedAll` (every non-archived item, sorted — archived stays excluded unless the filter shows it). Then `rows = buildInitiativeTree(sortedAll, matchedIds, collapsed)`. Render `rows` through `VirtualRows`; in `.cell-primary` prepend a chevron button (`aria-expanded`, stops propagation so it does not toggle the detail) when `hasChildren`, apply `style={{ '--depth': depth }}` for indent, append `<span className="chip c-slate">{role}</span>` when `role`, and add `context` to the row class when `isContext`. Result count = rows filtered `!isContext`. Keep the deep-link effect working: if `openId` is under a collapsed parent, expand that parent rather than clearing `openId`.

- [ ] **Step 3: Verify** — whole portal suite, tsc, build. **Step 4: Commit** — `feat(initiatives): nested tree rows with expand/collapse and context ancestors`

---

### Task 4: Timeline rows and calendar labels

**Files:** `portal/src/pages/InitiativeTimeline.tsx`, `portal/src/lib/timeline.ts` (if the calendar label helper belongs there), `portal/src/styles/` timeline stylesheet, `portal/src/pages/InitiativeTimeline.test.tsx`.

- [ ] **Step 1: Failing tests** — timeline: child row is indented under its parent; collapsing hides it; a dateless parent with a scheduled child gets an outline bar spanning the child and does NOT appear under "Unscheduled"; a dateless parent with no scheduled children still goes under "Unscheduled". Calendar: a child segment's label reads `Parent › Child`; collapsing the parent (via the shared key) removes the child's segments; a dateless parent draws no calendar segment.

- [ ] **Step 2: Implement.** Timeline: `matched` = ids passing the existing `filtered` predicate; `rows = buildInitiativeTree(sortForTimeline(nonArchived), matched, collapsed)`. For each row: real bar if the item has dates; else `derivedSpan(item, descendants)` → `.itl-bar.itl-bar-derived` (dashed, no fill, title "Derived from N scheduled initiatives"); else it is a candidate for the Unscheduled section — but only if `depth === 0` and no scheduled descendant. Chevron/indent in `.itl-row-label`. Calendar: filter `items` to those not under a collapsed parent before `calendarWeeks`; label = `parent ? \`${parent.name} › ${item.name}\` : item.name`. Read/write the collapsed set with the shared helpers from Task 2 so both pages agree.

- [ ] **Step 3: Verify** — whole portal suite, tsc, build. **Step 4: Commit** — `feat(initiatives): hierarchy on the timeline and calendar; derived spans for dateless parents`

---

### Task 5: Full suite and live verification

- [ ] Full API suite once (`pgrep` clear first). Expected: green; unrelated sites/survey/kiosk failures are the concurrent-session signature — re-run those files alone before believing them.
- [ ] Live on 5173/8000 as `claude-dev`: list shows `Child Test Event` indented under `Parent Test Project` with the `Event 1` chip; chevron collapses/expands and survives reload; searching `Child` keeps the parent as a dimmed context row and the count reads 1; timeline shows the same nesting and, if the parent has no dates, a dashed derived bar; calendar shows `Parent Test Project › Child Test Event` and hides it when the parent is collapsed on the timeline. On the detail page, adding `Child Test Event` under a second project is refused with the new message.
- [ ] Screenshot list + timeline; report the final state.
