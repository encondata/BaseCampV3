# Container Labels as ZPL — Phase Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make containers first-class in the label-generation worker and on the Print Labels page, so the 4x6 ZPL container templates seeded in phase one can actually be generated and printed from the UI.

**Architecture:** The runner today hardcodes `entity_type="asset"` and walks one asset roster. Phase two makes the roster per-label-type: a single `ENTITY_FOR_TYPE` map decides whether a label type walks assets or containers, `values.py` grows a `ContainerRow` beside `AssetRow`, and `entity_type` is threaded through the existing-label lookup and the upsert. Only once the runner can actually produce container labels is the `CONTAINER_LABEL_TYPES` gate opened. The Print Labels page gets a sibling container list rather than a contorted shared one, reusing the generic list machinery (ColumnMenu, VirtualRows, persisted prefs) that `PrintAssetList` already sits on.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy 2 async / pytest on the API side; React + TypeScript / Vitest on the portal side.

## Global Constraints

- Branch `container-labels-zpl-phase2`, off `main` @ `9da05af` (phase one merged). Worktree: `.claude/worktrees/container-zpl-p2`. **Run every command from the worktree root.**
- **API tests require `PYTHONPATH`**: `PYTHONPATH=api/src api/.venv/bin/python -m pytest ...` from the worktree root. The venv symlinks the main checkout's editable install, so omitting this tests unmodified code and gives false greens.
- **Only one pytest run against the test database at a time.** Concurrent runs deadlock on the `TRUNCATE` in `clean_db` and produce dozens of meaningless failures. Check `pgrep -f "pytest api/tests"` before starting a run.
- **`api/tests/conftest.py` hand-duplicates migration 0042 + 0066 vocab and placeholder seeds.** If you change seeded vocab or placeholders, update that baseline too, and re-run the WHOLE suite, not a `-k` subset — that file is shared by every test.
- Portal tests: `npm --prefix portal test -- <path>`. Do NOT run `npm install` in this worktree.
- No new migration is expected. If you believe you need one, stop and escalate — phase one's is `0066` and is the head.
- American English in all copy, comments and docs.
- End commit messages with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Key facts established by exploration

- The seeded ZPL templates use `label_type` values **`container` and `container_info`** — exactly the two keys currently excluded. Phase two **removes the exclusion**; it does not introduce new type keys.
- `CONTAINER_LABEL_TYPES` exists in **three** places kept in sync by comment only: `api/src/serversherpa/labels/generate/__init__.py:42`, imported by `api/src/serversherpa/api/routes/labels.py:49`, and duplicated as a TS `Set` in `portal/src/lib/generateLabels.ts:222`.
- Three hardcoded `entity_type == "asset"` filters: `labels/generate/runner.py:109` (`_load_existing_for_type`), `runner.py:120` (`_upsert_label`), `api/routes/labels.py:908` (the bundle endpoint), plus `labels.py:824` (preview counts) and `labels.py:882` (`list_generated_labels`'s `is_asset`).
- Already entity-agnostic, reuse as-is: `bundleByEntity`, `applyPrintSettings`, `batchBounds`, `batchCount`, `blankLabelsZpl`, `labelStatusFor` (its parameter is only used as a map key despite being named `assetId`).
- Asset-shaped and needing a container counterpart: `printOrder` and `rackOf` in `portal/src/lib/printLabels.ts`, and all of `PrintAssetList`'s `COLUMNS` / `assetCellText` / `sortRows` / `searchText`.
- `ContainerItem` (`portal/src/lib/api.ts:1514`) has **no `legacy_id`**, though `Container.legacy_id` exists on the model — `containers.py`'s `_item()` never serializes it.
- `GET /containers?initiative_id=` requires **`containers:view`**, a different permission from `labels:view`.
- `GET /containers` does **not** filter `archived_at`.

## Explicitly out of scope

- **Offline cache for container rosters.** `labelCache.CachedInitiative.roster` is typed `InitiativeAssetRow[]` and keyed by initiative id alone, with no room for a second roster. Container printing will work online; the offline fallback stays asset-only. Deferred deliberately — say so in the UI rather than failing silently (Task 7).
- Any change to the Avery PDF path or the `/labels/containers` page.
- Brother versions of the container templates.

---

### Task 1: `ContainerRow` and its placeholder values

**Files:**
- Modify: `api/src/serversherpa/labels/generate/values.py`
- Test: `api/tests/test_label_generate_values.py`

**Interfaces:**
- Consumes: `_stored_day` and `_MONTHS_UPPER`, already in `values.py` from phase one.
- Produces:
  - `class ContainerRow(NamedTuple)` with fields `container_uuid: object`, `legacy_id: int | None`, `name: str | None`, `label_tag: str | None`, and a property `entity_id` returning `container_uuid`.
  - `def container_placeholder_values(row: ContainerRow, initiative: Initiative, sites: Sites, catalog_keys: list[str], *, generation_rules: dict | None = None) -> dict[str, str]`
  - `def values_for_row(row, initiative, sites, catalog_keys, *, generation_rules=None) -> dict[str, str]` — dispatches on row type.
  - `AssetRow` gains an `entity_id` property returning `self.asset_id`.

Task 3's runner calls `values_for_row` and `row.entity_id` and never branches on row type itself.

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_label_generate_values.py`. Match the file's existing helpers for building `Initiative` and `Sites` — read it first; it defines `_initiative()` and `_sites()` (and `_row()` for assets).

```python
from serversherpa.labels.generate.values import (
    ContainerRow, container_placeholder_values, values_for_row,
)

CONTAINER_CATALOG = ["container_name", "container_id", "label_tag",
                     "move_name", "move_date", "move_date_long",
                     "source_site", "destination_site", "asset_name"]


def _container(name="crate-17", legacy_id=17, label_tag="priority"):
    return ContainerRow(container_uuid="c-uuid", legacy_id=legacy_id,
                        name=name, label_tag=label_tag)


def test_container_values_cover_the_container_catalog():
    out = container_placeholder_values(_container(), _initiative(), _sites(),
                                       CONTAINER_CATALOG)
    assert out["container_name"] == "crate-17"
    assert out["container_id"] == "17"
    assert out["label_tag"] == "PRIORITY"
    assert out["move_date_long"] == "15-SEP-2026"
    # asset-only keys resolve empty for a container, never raise
    assert out["asset_name"] == ""


def test_an_untagged_container_falls_back_to_the_word_container():
    """A static template cannot omit the tag bar, so the bar must never be
    blank — see the phase-one design's 'Empty tag' decision."""
    out = container_placeholder_values(_container(label_tag=None), _initiative(),
                                       _sites(), CONTAINER_CATALOG)
    assert out["label_tag"] == "CONTAINER"


def test_label_tag_uses_the_display_label_upper_cased():
    out = container_placeholder_values(_container(label_tag="ewaste"), _initiative(),
                                       _sites(), CONTAINER_CATALOG)
    assert out["label_tag"] == "E-WASTE"


def test_a_container_without_a_legacy_id_has_an_empty_container_id():
    out = container_placeholder_values(_container(legacy_id=None), _initiative(),
                                       _sites(), CONTAINER_CATALOG)
    assert out["container_id"] == ""


def test_values_for_row_dispatches_on_row_type():
    ini, sites = _initiative(), _sites()
    keys = ["container_name", "asset_name"]
    from_container = values_for_row(_container(), ini, sites, keys)
    from_asset = values_for_row(_row(), ini, sites, keys)
    assert from_container["container_name"] == "crate-17"
    assert from_container["asset_name"] == ""
    assert from_asset["container_name"] == ""


def test_both_row_types_expose_entity_id():
    assert _container().entity_id == "c-uuid"
    assert _row().entity_id == _row().asset_id
```

The existing `_initiative()` helper uses an 18:00 UTC `scheduled_start`; `move_date_long` for 2026-09-15 is `15-SEP-2026` either way. If that helper's date differs, adjust the expected value to match it rather than changing the helper.

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_values.py -v`
Expected: FAIL — `ImportError: cannot import name 'ContainerRow'`.

- [ ] **Step 3: Implement in values.py**

Add the import for the tag labels at the top of the file:

```python
from serversherpa.labels.tags import LABEL_TAG_LABELS
```

Add an `entity_id` property to the existing `AssetRow` (NamedTuples support properties):

```python
    @property
    def entity_id(self) -> object:
        """The `generated_labels.entity_id` for this row. Named the same on
        ContainerRow so the runner never branches on row type."""
        return self.asset_id
```

Add below `AssetRow`:

```python
# The word an untagged container prints in its tag bar. A design template
# cannot omit an element, so the bar would otherwise print solid black with
# nothing in it — see the 2026-09-16 design's "Empty tag" decision.
UNTAGGED_LABEL = "CONTAINER"


class ContainerRow(NamedTuple):
    """One container's worth of fields `container_placeholder_values` needs —
    built by the runner from the Container table."""

    container_uuid: object              # uuid.UUID — GeneratedLabel.entity_id
    legacy_id: int | None
    name: str | None
    label_tag: str | None

    @property
    def entity_id(self) -> object:
        return self.container_uuid
```

Add the two functions after `placeholder_values`:

```python
def _move_dates(initiative: Initiative) -> tuple[str, str]:
    """`move_date` and `move_date_long`, shared by both row kinds."""
    if initiative.scheduled_start is None:
        return "", ""
    day = _stored_day(initiative.scheduled_start)
    return (day.strftime("%m/%d/%Y"),
            f"{day.day:02d}-{_MONTHS_UPPER[day.month - 1]}-{day.year}")


def container_placeholder_values(
    row: ContainerRow, initiative: Initiative, sites: Sites,
    catalog_keys: list[str], *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """The container counterpart of `placeholder_values`. Same contract:
    every requested catalog key is present, and anything this row kind has
    no value for resolves to "" rather than raising — so an asset-only key
    on a container template is blank, not an error."""
    move_date, move_date_long = _move_dates(initiative)
    tag = row.label_tag or ""
    computed = {
        "container_name": row.name or "",
        "container_id": str(row.legacy_id) if row.legacy_id is not None else "",
        "label_tag": (LABEL_TAG_LABELS.get(tag, tag) or UNTAGGED_LABEL).upper(),
        "source_site": sites.origin.name if sites.origin else "",
        "destination_site": sites.destination.name if sites.destination else "",
        "move_name": initiative.name or "",
        "move_date": move_date,
        "move_date_long": move_date_long,
    }
    out = {key: computed.get(key, "") for key in catalog_keys}
    if generation_rules:
        _apply_length_limits(out, generation_rules)
    return out


def values_for_row(
    row, initiative: Initiative, sites: Sites, catalog_keys: list[str],
    *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """Dispatch a roster row to its own value builder, so the runner stays
    free of row-kind branching."""
    if isinstance(row, ContainerRow):
        return container_placeholder_values(
            row, initiative, sites, catalog_keys, generation_rules=generation_rules)
    return placeholder_values(
        row, initiative, sites, catalog_keys, generation_rules=generation_rules)
```

Note `container_placeholder_values` applies only `_apply_length_limits`, not `_apply_position_rules` — position rules split an asset's rack location and have no container equivalent.

Then refactor `placeholder_values` to use `_move_dates` instead of its own inline date block, so there is exactly one place that formats a move date.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_values.py -v`
Expected: PASS, including the phase-one date tests, which must not change behavior.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/labels/generate/values.py api/tests/test_label_generate_values.py
git commit -m "feat(labels): ContainerRow and its placeholder values

Adds the container counterpart of placeholder_values, with the CONTAINER
fallback for an untagged container and the tag rendered as its upper-cased
display label. Both row kinds now expose entity_id, and values_for_row
dispatches, so the runner need not branch on row type.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The entity map and the runner's per-type roster

The heart of phase two. The runner walks one asset roster and writes `entity_type="asset"`; after this task it picks a roster per label type and writes the matching entity type. **The gate stays closed** — Task 3 opens it, so that at no point can a run be enqueued that the runner cannot serve.

**Files:**
- Modify: `api/src/serversherpa/labels/generate/__init__.py`
- Modify: `api/src/serversherpa/labels/generate/runner.py`
- Test: `api/tests/test_label_generate_runner.py`

**Interfaces:**
- Consumes: `ContainerRow`, `values_for_row`, `row.entity_id` from Task 1.
- Produces:
  - `ENTITY_FOR_TYPE: dict[str, str]` and `entity_for_type(label_type: str) -> str` in `labels/generate/__init__.py`. `container`/`container_info` map to `"container"`; every other key maps to `"asset"`.
  - `_load_container_roster(db, initiative_id) -> list[ContainerRow]` in `runner.py`.
  - `_load_existing_for_type` and `_upsert_label` both take a new keyword-only `entity_type: str`.

Task 3 imports `entity_for_type`; Task 4 imports it in the bundle route.

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_label_generate_runner.py`. Read the file first — it has helpers for building an initiative with a roster and for seeding a template; reuse them rather than inventing new ones. The container roster needs `Container` rows with `initiative_id` set.

```python
async def test_a_container_type_walks_containers_not_assets(db):
    """The whole point of phase two: a container label type must produce one
    label per CONTAINER, stamped entity_type='container'."""
    initiative = await _initiative_with_assets(db, asset_count=3)
    await _add_containers(db, initiative, ["crate-17", "crate-18"])
    await _seed_template(db, label_type="container")

    run = await _run(db, initiative, ["container"])
    await process_run(db, run, sessionmaker=_sessionmaker())

    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.initiative_id == initiative.id,
        GeneratedLabel.label_type == "container"))).scalars().all()
    assert len(rows) == 2
    assert {r.entity_type for r in rows} == {"container"}
    assert run.generated == 2


async def test_archived_containers_are_not_labeled(db):
    initiative = await _initiative_with_assets(db, asset_count=0)
    await _add_containers(db, initiative, ["live-crate"])
    await _add_containers(db, initiative, ["old-crate"], archived=True)
    await _seed_template(db, label_type="container")

    run = await _run(db, initiative, ["container"])
    await process_run(db, run, sessionmaker=_sessionmaker())
    assert run.generated == 1


async def test_a_mixed_run_totals_each_type_against_its_own_roster(db):
    """total used to be len(roster) * len(label_types); with two entity
    kinds the rosters differ in length and that arithmetic is wrong."""
    initiative = await _initiative_with_assets(db, asset_count=3)
    await _add_containers(db, initiative, ["crate-17", "crate-18"])
    await _seed_template(db, label_type="top")
    await _seed_template(db, label_type="container")

    run = await _run(db, initiative, ["top", "container"])
    await process_run(db, run, sessionmaker=_sessionmaker())
    assert run.total == 5          # 3 assets + 2 containers, not 2 * 2 or 3 * 2
    assert run.generated == 5


async def test_container_and_asset_labels_do_not_collide_on_upsert(db):
    """generated_labels is keyed on (entity_type, entity_id, initiative,
    label_type); a container and an asset must never overwrite each other."""
    initiative = await _initiative_with_assets(db, asset_count=1)
    await _add_containers(db, initiative, ["crate-17"])
    await _seed_template(db, label_type="top")
    await _seed_template(db, label_type="container")

    run = await _run(db, initiative, ["top", "container"])
    await process_run(db, run, sessionmaker=_sessionmaker())
    rows = (await db.execute(select(GeneratedLabel).where(
        GeneratedLabel.initiative_id == initiative.id))).scalars().all()
    assert {(r.entity_type, r.label_type) for r in rows} == {
        ("asset", "top"), ("container", "container")}


async def test_rerunning_a_container_type_skips_unchanged_labels(db):
    initiative = await _initiative_with_assets(db, asset_count=0)
    await _add_containers(db, initiative, ["crate-17"])
    await _seed_template(db, label_type="container")

    first = await _run(db, initiative, ["container"])
    await process_run(db, first, sessionmaker=_sessionmaker())
    second = await _run(db, initiative, ["container"])
    await process_run(db, second, sessionmaker=_sessionmaker())
    assert second.skipped == 1 and second.generated == 0
```

Write `_add_containers(db, initiative, names, *, archived=False)` beside the file's existing helpers: it inserts `Container` rows with `initiative_id=initiative.id`, `name=<name>`, `label_tag="priority"`, and `archived_at=datetime.now(UTC)` when `archived`.

Also add a unit test for the map, in `api/tests/test_label_generate_api.py` or beside the runner tests:

```python
def test_entity_for_type_maps_container_types_and_defaults_to_asset():
    assert entity_for_type("container") == "container"
    assert entity_for_type("container_info") == "container"
    assert entity_for_type("top") == "asset"
    assert entity_for_type("something_new") == "asset"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_runner.py -v`
Expected: FAIL — the container tests produce 0 rows (or one label per asset), and the mixed-run test asserts `total == 5` against the current `len(roster) * len(label_types)` of 6.

- [ ] **Step 3: Add the entity map**

In `api/src/serversherpa/labels/generate/__init__.py`, beside `CONTAINER_LABEL_TYPES`:

```python
# The single source of truth for which entity kind a label type describes.
# `generated_labels.entity_type` and the runner's roster both come from here,
# so adding a container-shaped type means editing one dict.
ENTITY_FOR_TYPE: dict[str, str] = {"container": "container",
                                   "container_info": "container"}


def entity_for_type(label_type: str) -> str:
    """'container' for the container label types, 'asset' for everything
    else — an unknown type is an asset label, matching how every type
    behaved before container types existed."""
    return ENTITY_FOR_TYPE.get(label_type, "asset")
```

- [ ] **Step 4: Generalize the runner**

In `api/src/serversherpa/labels/generate/runner.py`:

Add `Container` to the `serversherpa.db.models` import, add `ContainerRow` and `values_for_row` to the `values` import (keeping `AssetRow`, `Sites`), and import `entity_for_type` from `serversherpa.labels.generate`.

Add beside `_load_roster`:

```python
async def _load_container_roster(db: AsyncSession,
                                 initiative_id: uuid.UUID) -> list[ContainerRow]:
    """The initiative's live containers. Archived containers are excluded:
    a crate that has been archived should not be getting fresh labels (the
    Avery PDF path still labels them — see that feature's follow-ups)."""
    rows = (await db.execute(
        select(Container)
        .where(Container.initiative_id == initiative_id,
               Container.archived_at.is_(None))
        .order_by(Container.name))).scalars().all()
    return [ContainerRow(container_uuid=c.id, legacy_id=c.legacy_id,
                         name=c.name, label_tag=c.label_tag)
            for c in rows]
```

Change `_item_label` to handle both kinds:

```python
def _item_label(row) -> str:
    """What the run's progress and error rows call this item."""
    if isinstance(row, ContainerRow):
        return row.name or str(row.legacy_id or "unknown")
    if row.serial_number:
        return row.serial_number
    return str(row.legacy_id) if row.legacy_id is not None else "unknown"
```

Give `_load_existing_for_type` an `entity_type` parameter, replacing its hardcoded filter:

```python
async def _load_existing_for_type(
    db: AsyncSession, initiative_id: uuid.UUID, label_type: str,
    *, entity_type: str,
) -> dict[uuid.UUID, tuple[uuid.UUID, int, bool]]:
```
and in its `.where(...)`, `GeneratedLabel.entity_type == entity_type`.

Give `_upsert_label` an `entity_type` parameter and use `row.entity_id`:

```python
async def _upsert_label(db: AsyncSession, *, initiative_id: uuid.UUID, run_id: uuid.UUID,
                        row, label_type: str, entity_type: str, template: LabelTemplate,
                        code: str, values: dict) -> None:
    fields = dict(
        entity_type=entity_type, entity_id=row.entity_id, initiative_id=initiative_id,
        ...
```
Everything else in that function, including the `NIL_UUID_SQL` inline-literal `on_conflict_do_update`, is unchanged.

In `_generate_one`, take `entity_type` as a keyword, look the existing row up by `row.entity_id`, call `values_for_row` instead of `placeholder_values`, and pass `entity_type` through to `_upsert_label`:

```python
    existing = existing_by_entity.get(row.entity_id)
    ...
        values = values_for_row(row, initiative, sites, catalog_keys,
                                generation_rules=template.generation_rules)
```
Rename the parameter `existing_by_asset` to `existing_by_entity` at both its definition and its call site.

In `process_run`, replace the single roster load and the `total` arithmetic:

```python
        rosters: dict[str, list] = {}

        async def roster_for(label_type: str) -> list:
            """One roster per ENTITY KIND, loaded at most once per run."""
            kind = entity_for_type(label_type)
            if kind not in rosters:
                rosters[kind] = (await _load_container_roster(db, initiative_id)
                                 if kind == "container"
                                 else await _load_roster(db, initiative_id))
            return rosters[kind]

        # total is a SUM, not len(roster) * len(label_types) — with two entity
        # kinds in one run the rosters have different lengths.
        total = 0
        for label_type in label_types:
            total += len(await roster_for(label_type))
```

Then inside the per-type loop, replace `for row in roster:` with:

```python
            entity_type = entity_for_type(label_type)
            roster = await roster_for(label_type)
            ...
                existing_by_entity = await _load_existing_for_type(
                    db, initiative_id, label_type, entity_type=entity_type)
            for row in roster:
```
and pass `entity_type=entity_type` into `_generate_one`.

- [ ] **Step 5: Run the runner tests**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_runner.py -v`
Expected: PASS, including every pre-existing asset test. The asset path must be behaviorally identical — if an existing test fails, the generalization changed asset behavior and is wrong.

- [ ] **Step 6: Run the whole suite**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -q`
Expected: PASS. Check `pgrep -f "pytest api/tests"` first — a concurrent run will deadlock and produce meaningless failures.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/labels/generate/ api/tests/test_label_generate_runner.py api/tests/test_label_generate_api.py
git commit -m "feat(labels): the label runner walks containers as well as assets

ENTITY_FOR_TYPE is the single source of truth for which entity kind a
label type describes; the runner loads a roster per kind, threads
entity_type through the existing-label lookup and the upsert, and totals
each type against its own roster instead of len(roster) * len(types).
Archived containers are not labeled. The enqueue gate stays closed until
the next commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Open the gate

Only now that the runner can serve container types does Generate Labels offer them.

**Files:**
- Modify: `api/src/serversherpa/labels/generate/__init__.py`
- Modify: `api/src/serversherpa/api/routes/labels.py`
- Modify: `portal/src/lib/generateLabels.ts`
- Modify: `portal/src/pages/GenerateLabels.tsx`
- Test: `api/tests/test_label_generate_api.py`, `portal/src/lib/generateLabels.test.ts`

**Interfaces:**
- Consumes: `entity_for_type` from Task 2.
- Produces: container types accepted by `enqueue_run`, offered by `GET /labels/generate/preview`, and shown in the portal's type picker. `CONTAINER_LABEL_TYPES` and `isAssetLabelType` are **deleted** in all three places.

- [ ] **Step 1: Write the failing tests**

In `api/tests/test_label_generate_api.py`, replace the existing tests that assert container types are rejected — do not leave them asserting the old behavior. Read them first; they were added in phase one and assert both the preview exclusion and the `enqueue_run` rejection.

```python
async def test_container_types_can_now_be_enqueued(db, ...):
    """Phase two: the runner walks containers, so the gate is open."""
    run = await enqueue_run(db, initiative_id=initiative.id,
                            label_types=["container", "container_info"],
                            regenerate_existing=False, requested_by=person.id,
                            notify=False)
    assert list(run.label_types) == ["container", "container_info"]


async def test_the_generate_preview_offers_the_container_types(client, ...):
    body = (await client.get(f"/labels/generate/preview?initiative_id={initiative.id}")).json()
    assert {"container", "container_info"} <= {t["key"] for t in body["types"]}


async def test_the_preview_counts_containers_for_a_container_type(client, ...):
    """A container type's current/stale counts must come from container
    labels, not from the asset count."""
    body = (await client.get(f"/labels/generate/preview?initiative_id={initiative.id}")).json()
    by_key = {t["key"]: t for t in body["types"]}
    assert by_key["container"]["current"] == 2      # two containers labeled
    assert by_key["top"]["current"] == 3            # three assets labeled
```

In `portal/src/lib/generateLabels.test.ts`, replace the phase-one tests that assert `isAssetLabelType` excludes the container keys.

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_api.py -v`
Expected: FAIL — `enqueue_run` raises `InvalidLabelTypes`, and the preview omits the container types.

- [ ] **Step 3: Remove the gate**

In `api/src/serversherpa/labels/generate/__init__.py`: delete `CONTAINER_LABEL_TYPES` and the `container_keys` rejection block inside `enqueue_run` (the block that raises `InvalidLabelTypes` with "container labels are generated from the Container Labels page"). Update the module docstring, which describes the gate.

In `api/src/serversherpa/api/routes/labels.py`:
- Remove the `CONTAINER_LABEL_TYPES` import and the `LabelVocab.key.notin_(CONTAINER_LABEL_TYPES)` filter in the preview route.
- In the preview's current/stale counting, replace the hardcoded `GeneratedLabel.entity_type == "asset"` with the type's own kind: count per label type using `entity_for_type(key)`.

In `portal/src/lib/generateLabels.ts`: delete `CONTAINER_LABEL_TYPES` and `isAssetLabelType`.

In `portal/src/pages/GenerateLabels.tsx`: drop the `.filter((v) => isAssetLabelType(v.key))` from `typeVocab` and remove the now-unused import.

Grep for any remaining reference before committing:
`grep -rn "CONTAINER_LABEL_TYPES\|isAssetLabelType" api/src portal/src` must return nothing.

- [ ] **Step 4: Verify**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -q` and `npm --prefix portal test -- src/lib/generateLabels.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add api/src portal/src api/tests portal/src/lib/generateLabels.test.ts
git commit -m "feat(labels): Generate Labels offers the container label types

The runner walks containers now, so the exclusion that kept container
and container_info out of the type picker, the preview and enqueue_run
is removed from all three places that carried a copy of it. Preview
counts come from each type's own entity kind.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The bundle endpoint serves container labels

**Files:**
- Modify: `api/src/serversherpa/api/routes/labels.py` (the `/generated/bundle` route, and `list_generated_labels`'s `is_asset` branch)
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_label_print_bundle_api.py`

**Interfaces:**
- Consumes: `entity_for_type` from Task 2.
- Produces: `GeneratedLabelBundleItemOut` gains `entity_name: str | None` and its `entity_type` is tightened to `Literal["asset", "container"]`. The bundle route derives its entity filter from `label_type` instead of hardcoding `"asset"`. Task 5's container list reads `entity_name`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_the_bundle_serves_container_labels_for_a_container_type(client, db, ...):
    """The route hardcoded entity_type == 'asset', so a container type
    returned an empty bundle however many labels existed."""
    body = (await client.get(
        f"/labels/generated/bundle?initiative_id={initiative.id}&label_type=container")).json()
    assert len(body["labels"]) == 2
    assert {l["entity_type"] for l in body["labels"]} == {"container"}
    assert {l["entity_name"] for l in body["labels"]} == {"crate-17", "crate-18"}


async def test_an_asset_bundle_is_unchanged_and_carries_asset_names(client, db, ...):
    body = (await client.get(
        f"/labels/generated/bundle?initiative_id={initiative.id}&label_type=top")).json()
    assert {l["entity_type"] for l in body["labels"]} == {"asset"}
    assert all(l["entity_name"] for l in body["labels"])


async def test_a_container_bundle_never_leaks_asset_labels(client, db, ...):
    """Both kinds exist on this initiative; each bundle must be pure."""
    container = (await client.get(
        f"/labels/generated/bundle?initiative_id={initiative.id}&label_type=container")).json()
    assert all(l["entity_type"] == "container" for l in container["labels"])
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_print_bundle_api.py -v`
Expected: FAIL — the container bundle is empty, and `entity_name` is not a field.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/schemas.py`, add to `GeneratedLabelBundleItemOut`:

```python
    entity_type: Literal["asset", "container"]
    entity_name: str | None = None
```
(replacing the existing `entity_type: str`). Add `Literal` to the file's `typing` import if it is not already there.

In the bundle route, derive the entity kind and outer-join the right name source:

```python
    entity_type = entity_for_type(label_type)
    name_col = (Container.name if entity_type == "container" else Asset.name)
    query = (select(GeneratedLabel, LabelTemplate.name, name_col)
             .join(LabelTemplate, LabelTemplate.id == GeneratedLabel.template_id)
             .where(GeneratedLabel.initiative_id == ini.id,
                    GeneratedLabel.entity_type == entity_type,
                    GeneratedLabel.label_type == label_type)
             .order_by(GeneratedLabel.generated_at, GeneratedLabel.id))
    if entity_type == "container":
        query = query.outerjoin(Container, Container.id == GeneratedLabel.entity_id)
    else:
        query = query.outerjoin(Asset, Asset.id == GeneratedLabel.entity_id)
```
and unpack the third column into `entity_name=` on each item. Import `Container` in this module if it is not already imported.

**The outer join matters:** a label whose entity was deleted must still come back with `entity_name=None` rather than vanishing from the bundle, so the print page can show it as an orphan instead of silently printing fewer labels than the operator selected.

Leave `list_generated_labels`'s `is_asset` branch alone unless a test demands otherwise — it populates asset-only columns and returning `None` for a container there is already correct.

- [ ] **Step 4: Verify and commit**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -q`
Expected: PASS.

```bash
git add api/src/serversherpa/api/routes/labels.py api/src/serversherpa/api/schemas.py api/tests/test_label_print_bundle_api.py
git commit -m "feat(labels): the print bundle serves container labels

The endpoint derives its entity filter from the label type instead of
hardcoding asset, and carries entity_name so a print list has something
to show without a second fetch. entity_type is now a Literal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The container list on Print Labels

**Files:**
- Create: `portal/src/components/labels/PrintContainerList.tsx`
- Modify: `portal/src/pages/PrintLabels.tsx`
- Modify: `portal/src/lib/printLabels.ts`
- Modify: `portal/src/lib/api.ts` (`listContainers` already exists — confirm its signature)
- Test: `portal/src/lib/printLabels.test.ts`, and a new `portal/src/components/labels/PrintContainerList.test.tsx`

**Interfaces:**
- Consumes: `entity_name` on the bundle item (Task 4).
- Produces: `PrintContainerList` with props mirroring `PrintAssetList` but over `ContainerItem`; `containerPrintOrder(selectedIds, displayed, settings)` in `printLabels.ts`.

**Three traps established by exploration — do not rediscover them:**
1. **`PRINT_LIST_PAGE_KEY = 'labels-print'` is a per-user, backend-persisted prefs key.** The container list MUST use a different key (`'labels-print-containers'`) or the two lists will silently overwrite each other's column visibility, sort and filters.
2. **`GET /containers` requires `containers:view`**, not `labels:view`. A user who can print asset labels may get a 403 here. Handle that explicitly: show "You do not have permission to list containers" rather than an empty list that looks like "no containers".
3. **`GET /containers` does not filter `archived_at`.** Filter archived containers out client-side so the print list matches what the runner actually labels (Task 2 excludes them).

- [ ] **Step 1: Write the failing tests**

```ts
describe('containerPrintOrder', () => {
  it('is the selection intersected with the displayed rows, in display order', () => {
    const displayed = [row('a'), row('b'), row('c')];
    expect(containerPrintOrder(['c', 'a', 'zzz'], displayed, DEFAULT_PRINT_SETTINGS))
      .toEqual(['a', 'c']);
  });

  it('ignores printByRack, which has no container meaning', () => {
    const displayed = [row('a'), row('b')];
    const settings = { ...DEFAULT_PRINT_SETTINGS, printByRack: true };
    expect(containerPrintOrder(['a', 'b'], displayed, settings)).toEqual(['a', 'b']);
  });
});
```

And for the component, a test that it excludes archived containers and uses its own prefs key:

```tsx
it('does not list archived containers', () => {
  render(<PrintContainerList rows={[live, archived]} {...noopProps} />);
  expect(screen.queryByText('old-crate')).toBeNull();
  expect(screen.getByText('live-crate')).toBeTruthy();
});

it('uses a prefs key distinct from the asset list', () => {
  expect(PRINT_CONTAINER_LIST_PAGE_KEY).not.toBe(PRINT_LIST_PAGE_KEY);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix portal test -- src/lib/printLabels.test.ts src/components/labels/PrintContainerList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build `PrintContainerList`**

Model it on `PrintAssetList`, reusing the same generic machinery (`ColumnMenu`, `passesColumnFilters`, `usePersistentListState`, `ColumnsButton`, `applyColumnOrder`, `useSearchHaystacks`, `VirtualRows`, the Ready/Missing segmented filter). Change only what is container-specific:

```ts
export const PRINT_CONTAINER_LIST_PAGE_KEY = 'labels-print-containers';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Container', width: 'minmax(160px, 1.6fr)', default: true },
  { key: 'type', label: 'Type', width: 'minmax(110px, 1fr)', default: true },
  { key: 'tag', label: 'Label tag', width: '120px', default: true },
  { key: 'site', label: 'Site', width: 'minmax(110px, 1fr)', default: true },
  { key: 'assets', label: 'Assets', width: '80px', default: true },
  { key: 'status', label: 'Status', width: 'minmax(110px, 0.9fr)', default: true },
  { key: 'label', label: 'Label', width: '110px', default: true },
];
```
Selection is keyed by `row.id`. Sorting is `naturalCompare` on the chosen column with no rack tie-break — the asset list's rack/RU secondary sort is a V2 rule with no container meaning. Search covers name, type label, tag and site.

Filter archived rows at the top of the component, before any sorting or filtering:
```ts
const live = useMemo(() => rows.filter((r) => !r.archived_at), [rows]);
```

- [ ] **Step 4: Add `containerPrintOrder`**

In `portal/src/lib/printLabels.ts`, beside `printOrder`:

```ts
/** The container counterpart of `printOrder`: selection intersected with the
 *  displayed rows, in display order. There is no rack ordering — `printByRack`
 *  and `blanksBetweenRacks` are asset concepts and are ignored here. */
export function containerPrintOrder(
  selectedIds: string[], displayedRows: ContainerItem[], _s: PrintSettings,
): string[] {
  const chosen = new Set(selectedIds);
  return displayedRows.filter((r) => chosen.has(r.id)).map((r) => r.id);
}
```

- [ ] **Step 5: Wire the page**

In `portal/src/pages/PrintLabels.tsx`, add container state beside the asset state (`containerRoster`, `containerSelected`, `containerDisplayed`) and derive which mode the page is in from the selected label type using the same `entity_for_type` logic — add a small TS helper `isContainerLabelType(key)` in `printLabels.ts` mirroring the server's map, and **note in its docstring that it is the SECOND copy of that mapping** — the other is `ENTITY_FOR_TYPE` in `labels/generate/__init__.py` — so a future type addition is not missed. Task 3 deleted the three-way `CONTAINER_LABEL_TYPES` duplication; do not reintroduce a third copy here.

Load `listContainers({ initiative_id })` when the mode is container; render `PrintContainerList` instead of `PrintAssetList`; make `zplFor` look up `byEntity` by container id; and use `containerPrintOrder` for `printableIds`. `bundleByEntity`, `applyPrintSettings`, `batchBounds`, `batchCount`, `blankLabelsZpl` and `labelStatusFor` all work unchanged.

Update the card heading from the literal "Assets to print" to reflect the mode.

- [ ] **Step 6: Verify and commit**

Run: `npm --prefix portal test -- src/lib/printLabels.test.ts src/components/labels/` and `npm --prefix portal run build`
Expected: PASS and a clean build.

```bash
git add portal/src
git commit -m "feat(labels): Print Labels lists containers for a container label type

A sibling PrintContainerList over ContainerItem, on the same generic list
machinery as the asset list but with its own columns, its own prefs key
(sharing 'labels-print' would have silently overwritten the asset list's
column state) and no rack ordering. Archived containers are filtered out
to match what the runner labels.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `default_copies` and the offline-cache gap

**Files:**
- Modify: `portal/src/pages/PrintLabels.tsx`
- Modify: `portal/src/lib/printLabels.ts`
- Test: `portal/src/lib/printLabels.test.ts`

**Interfaces:**
- Consumes: the `default_copies` meta seeded on the `container` (5) and `container_info` (1) type vocab rows in phase one's migration 0066.
- Produces: `defaultCopiesFor(vocab, labelType): number | null`.

- [ ] **Step 1: Write the failing test**

```ts
describe('defaultCopiesFor', () => {
  it('reads default_copies from the type vocab meta', () => {
    expect(defaultCopiesFor(vocab, 'container')).toBe(5);
    expect(defaultCopiesFor(vocab, 'container_info')).toBe(1);
  });
  it('is null for a type that carries no default', () => {
    expect(defaultCopiesFor(vocab, 'top')).toBeNull();
  });
  it('ignores a non-numeric or out-of-range meta value', () => {
    expect(defaultCopiesFor(vocabWith('container', { default_copies: 'five' }), 'container')).toBeNull();
    expect(defaultCopiesFor(vocabWith('container', { default_copies: 0 }), 'container')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

```ts
/** The per-type copies default seeded on the `type` vocab meta (migration
 *  0066): 5 for a container barcode label, 1 for its info label. Null when
 *  the type carries no default or the value is not a usable count — the
 *  caller then leaves the copies setting alone. */
export function defaultCopiesFor(vocab: LabelVocab[], labelType: string): number | null {
  const meta = vocab.find((v) => v.kind === 'type' && v.key === labelType)?.meta;
  const raw = (meta as Record<string, unknown> | undefined)?.default_copies;
  return typeof raw === 'number' && Number.isInteger(raw)
    && raw >= SETTING_LIMITS.copies.min && raw <= SETTING_LIMITS.copies.max
    ? raw : null;
}
```

In `PrintLabels.tsx`, when the label type changes, seed `settings.copies` from `defaultCopiesFor` when it returns a number. **Seed on the type change only — never overwrite a value the operator has typed since.**

- [ ] **Step 3: Say the offline gap out loud**

Container rosters are not cached offline (see "Explicitly out of scope"). When the page is in container mode and the network fetch fails, show the existing offline banner with copy that says container lists are not available offline, rather than an empty list that reads as "no containers". Add a test for that branch.

- [ ] **Step 4: Verify and commit**

Run: `npm --prefix portal test -- src/lib/printLabels.test.ts src/pages/` and `npm --prefix portal run build`

```bash
git add portal/src
git commit -m "feat(labels): seed copies from the label type's default_copies

A container barcode label defaults to 5 copies and its info label to 1,
read from the type vocab meta seeded in 0066, and still editable per
print. Container mode says plainly that it has no offline roster rather
than showing an empty list.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification on the running stack

Not a code task. Phase one was verified through Labelary renders; this verifies the actual pipeline.

- [ ] **Step 1: Bring up the dev stack and sign in as `claude-dev`.**

- [ ] **Step 2:** On `/labels/generate`, pick an initiative that has containers (the dev DB has `scan-verify-crate`, `Pallet A-01` and `D-Container D-02` on NAP11). Confirm "Container Label" and "Container Info Label" now appear in the type list, and that their counts reflect **containers**, not the asset count.

- [ ] **Step 3:** Run a generation for both container types. Confirm the run completes, `run.total` equals the container count times two, and `generated_labels` holds rows with `entity_type='container'`.

- [ ] **Step 4:** On `/labels/print`, select the same initiative and the Container Label type. Confirm the container list appears with the right rows, archived containers are absent, Ready/Missing statuses are right, and the copies field seeded to 5.

- [ ] **Step 5:** Confirm the asset path is untouched — pick an asset type on the same initiative and check the asset list, its columns and its rack sort still behave exactly as before.

- [ ] **Step 6:** Capture a screenshot of the container list and of a generated container label's ZPL, and report them.

- [ ] **Step 7:** Commit nothing; report findings. Any defect found here goes back through the normal fix-and-review loop.
