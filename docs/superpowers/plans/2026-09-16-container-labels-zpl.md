# Container Labels as ZPL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print container labels on a Zebra printer from a 4" x 6" ZPL template in both 203 and 300 dpi, with containers becoming first-class citizens of the label worker and the Print Labels page.

**Architecture:** Two seeded `design`-kind label templates (`container` printed x5, `container_info` printed x1), each existing as a 203 and a 300 dpi row sharing one design JSON. Three additive properties on the label element model (`TextEl.reverse`, `TextEl.lines`, `BarcodeEl.module_in`) give the ZPL compiler what the design needs; all three are absent-means-unchanged so no shipped template's output moves. The label-generation runner, which today hardcodes `entity_type="asset"`, grows a per-label-type roster so container types walk containers instead.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy 2 async / Alembic / pytest on the API side; React + TypeScript / Vitest on the portal side. ZPL II for the Zebra output, rendered for inspection through the existing Labelary integration.

## Global Constraints

- Branch `container-labels-zpl`, off `main` @ `046fc5e`. Worktree: `.claude/worktrees/container-zpl`. **Run every command from the worktree root.**
- Migration head is `0065`; this feature's migration is `0066` and is the only one it adds.
- **API tests in this worktree require `PYTHONPATH`**: run them as `PYTHONPATH=api/src api/.venv/bin/python -m pytest ...` from the worktree root. The venv's editable install points at the MAIN checkout's `src`, so omitting this gives false greens against unmodified code.
- Never assert a specific alembic revision string in a test; assert there is a single head.
- **American English** in all copy, comments and docs (color, customize, recognize).
- Do not run `npm install` inside this worktree — it replaces the `node_modules` symlink with a real copy and desyncs the main checkout. Every dependency this plan needs is already installed.
- Absent-means-unchanged is a hard requirement for the three new model properties: existing templates must compile byte-identically.
- Portal tests: `npm --prefix portal test -- <path>` (Vitest).

---

### Task 1: Move-date off-by-one

`initiatives.scheduled_start` is `TIMESTAMP(timezone=True)` holding midnight UTC for a date-only value. Both existing formatters convert into a local zone before reading the day, so west of UTC they name the previous day. This task fixes both and adds the correctly-written `move_date_long`.

**Files:**
- Modify: `api/src/serversherpa/labels/generate/values.py`
- Modify: `portal/src/labels/containerLabelSheet.ts:102-110`
- Test: `api/tests/test_label_generate_values.py`
- Test: `portal/src/labels/containerLabelSheet.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `move_date` (corrected, `MM/DD/YYYY`) and `move_date_long` (`DD-MON-YYYY`, e.g. `15-SEP-2026`) as keys in the dict returned by `placeholder_values(...)`. Task 6 reuses the same two formatters for containers; Task 3 seeds a `move_date_long` placeholder row.

- [ ] **Step 1: Write the failing API tests**

Add to `api/tests/test_label_generate_values.py`:

```python
def test_move_date_reads_the_stored_day_not_the_local_one(monkeypatch):
    """scheduled_start is a date-only field stored at midnight UTC. Converting
    it into a zone west of UTC lands on the previous evening, which used to
    print the day BEFORE the one the user picked."""
    import zoneinfo
    from serversherpa.labels.generate import values as values_mod
    monkeypatch.setattr(values_mod, "report_timezone",
                        lambda: zoneinfo.ZoneInfo("America/New_York"))
    initiative = _initiative(scheduled_start=datetime(2026, 9, 15, tzinfo=UTC))
    out = placeholder_values(_asset_row(), initiative, _sites(),
                             ["move_date", "move_date_long"])
    assert out["move_date"] == "09/15/2026"
    assert out["move_date_long"] == "15-SEP-2026"


def test_move_date_is_empty_without_a_scheduled_start():
    out = placeholder_values(_asset_row(), _initiative(scheduled_start=None),
                             _sites(), ["move_date", "move_date_long"])
    assert out["move_date"] == ""
    assert out["move_date_long"] == ""
```

Reuse whatever `_initiative` / `_asset_row` / `_sites` helpers the file already defines; if it builds those inline, follow the file's existing style rather than introducing helpers. Ensure `datetime`, `UTC` and `placeholder_values` are imported at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_values.py -k move_date -v`
Expected: FAIL — `test_move_date_reads_the_stored_day_not_the_local_one` asserts `09/15/2026` but gets `09/14/2026`; the `move_date_long` lookup returns `""` because the key does not exist yet.

- [ ] **Step 3: Fix the formatters in values.py**

Replace the `move_date` block inside `placeholder_values` (currently lines 122-125):

```python
    move_date = move_date_long = ""
    if initiative.scheduled_start is not None:
        day = _stored_day(initiative.scheduled_start)
        move_date = day.strftime("%m/%d/%Y")
        move_date_long = (f"{day.day:02d}-{_MONTHS_UPPER[day.month - 1]}-"
                          f"{day.year}")
```

And add at module level, just above `_format_ru`:

```python
_MONTHS_UPPER = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                 "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _stored_day(value: datetime) -> date:
    """The calendar day a date-only field holds.

    `scheduled_start` and friends are TIMESTAMP(timezone=True) columns that
    carry a plain YYYY-MM-DD input as MIDNIGHT UTC. Converting that into the
    report timezone lands on the previous evening anywhere west of UTC, which
    named the day BEFORE the one the user picked (fixed 2026-09-16; the same
    class of bug was found on the initiatives timeline on 2026-09-15). Read the
    UTC date parts instead — for a midnight-UTC value they ARE the picked day,
    and for a genuine timestamp this is still the UTC calendar day, which is
    the closest defensible reading of a field used as a date."""
    return value.astimezone(UTC).date()
```

Add `from datetime import UTC, date, datetime` to the imports (the module currently imports none of these; check and extend the existing import block rather than duplicating it).

Then add both keys to the `computed` dict, replacing the single `"move_date": move_date,` entry:

```python
        "move_date": move_date,
        "move_date_long": move_date_long,
```

`report_timezone` may now be unused in this module — if so, remove the import. If it is still used elsewhere in the file, leave it.

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_label_generate_values.py -v`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Write the failing portal test**

Add to the `describe('formatLabelDate', ...)` block in `portal/src/labels/containerLabelSheet.test.ts`:

```ts
  it('names the stored day for a midnight-UTC date-only value', () => {
    // scheduled_start arrives as midnight UTC; `new Date(iso)` then getDate()
    // used to name the previous day in any zone west of UTC.
    expect(formatLabelDate('2026-09-15T00:00:00Z')).toBe('15-SEP-2026');
    expect(formatLabelDate('2026-01-01T00:00:00Z')).toBe('01-JAN-2026');
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm --prefix portal test -- src/labels/containerLabelSheet.test.ts -t formatLabelDate`
Expected: FAIL — receives `14-SEP-2026` (assuming the runner's zone is west of UTC; if the machine runs UTC the test passes vacuously, which is why step 7's implementation must not depend on the ambient zone).

- [ ] **Step 7: Fix formatLabelDate**

Replace the body of `formatLabelDate` in `portal/src/labels/containerLabelSheet.ts`:

```ts
export function formatLabelDate(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  // Date-only fields (scheduled_start) arrive as MIDNIGHT UTC, so reading the
  // day through local time names the day before anywhere west of UTC. Read the
  // Y-M-D digits straight off the string when it has them — the same approach
  // `parseApiDay` in lib/timeline.ts takes — and fall back to UTC parts for
  // anything else. (Fixed 2026-09-16; V2 had this bug too, so the exactness
  // test's embedded V2 routine calls this same function and still matches.)
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (ymd) {
    const [, y, m, d] = ymd;
    const month = Number(m);
    if (month >= 1 && month <= 12) {
      return `${d}-${MONTHS_UPPER[month - 1]}-${y}`;
    }
  }
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return 'N/A';
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dd}-${MONTHS_UPPER[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
}
```

- [ ] **Step 8: Run the whole container-label sheet suite**

Run: `npm --prefix portal test -- src/labels/containerLabelSheet.test.ts`
Expected: PASS, including the V2 exactness cases. The exactness test embeds V2's routine and calls this same `formatLabelDate`, so both sides of the comparison move together and no expected value needs updating. **If any exactness case fails, stop and report it — do not edit the expected values.**

- [ ] **Step 9: Commit**

```bash
git add api/src/serversherpa/labels/generate/values.py api/tests/test_label_generate_values.py portal/src/labels/containerLabelSheet.ts portal/src/labels/containerLabelSheet.test.ts
git commit -m "fix(labels): date-only move dates named the previous day west of UTC

scheduled_start is a TIMESTAMP column carrying a plain date as midnight
UTC; both formatters converted it into a local zone before reading the
day, so a move scheduled Sep 15 printed Sep 14. Adds move_date_long
(15-SEP-2026) written correctly from the start.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Element model — reverse, lines and module_in

Three additive properties. **Every one must be absent-means-unchanged**: the existing seeded templates have to compile byte-identically after this task.

**Files:**
- Modify: `api/src/serversherpa/labels/model.py`
- Modify: `api/src/serversherpa/labels/zpl.py`
- Modify: `api/src/serversherpa/labels/brother_escp.py` (comment only)
- Modify: `api/src/serversherpa/labels/brother_ptouch.py` (comment only)
- Test: `api/tests/test_labels_zpl.py`
- Test: `api/tests/test_labels_design_model.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TextEl.reverse: bool`, `TextEl.lines: int`, `BarcodeEl.module_in: float | None` on the parsed dataclasses, accepted from design JSON as `reverse`, `lines`, `moduleIn`. Task 3's seeded designs use all three.

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_labels_zpl.py`:

```python
def test_reverse_text_emits_field_reverse():
    d = parse_design({"size": {"w": 4, "h": 6}, "elements": [
        {"id": "t1", "type": "text", "x": 0.2, "y": 0.5, "w": 3.6, "h": 0.36,
         "rotation": 0, "content": "PRIORITY", "fontSizePt": 26,
         "bold": True, "align": "center", "reverse": True}]})
    out = compile_zpl(d, 203)
    assert "^FR^FH_^FDPRIORITY^FS" in out


def test_lines_wraps_and_forces_a_field_block_even_when_left_aligned():
    d = parse_design({"size": {"w": 4, "h": 6}, "elements": [
        {"id": "t1", "type": "text", "x": 0.2, "y": 0.5, "w": 3.6, "h": 1.0,
         "rotation": 0, "content": "{container_name}", "fontSizePt": 28,
         "bold": True, "align": "left", "lines": 2}]})
    assert "^FB731,2,0,L,0" in compile_zpl(d, 203)


def test_module_in_sets_narrow_bar_width_per_dpi():
    design = {"size": {"w": 4, "h": 6}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0.8, "y": 1.6, "w": 2.4, "h": 1.2,
         "rotation": 0, "symbology": "code128", "data": "crate-17",
         "showText": False, "moduleIn": 0.01}]}
    assert "^BY2^BCN,244,N,N,N" in compile_zpl(parse_design(design), 203)
    assert "^BY3^BCN,360,N,N,N" in compile_zpl(parse_design(design), 300)


def test_absent_properties_compile_byte_identically():
    """Absent-means-unchanged: the three new properties must not perturb any
    design that does not use them."""
    out = compile_zpl(parse_design(SIMPLE), 203)
    assert out == (
        "^XA\n"
        "^PW812\n"
        "^LL406\n"
        "^CI28\n"
        "^FO51,102^A0N,34,34^FH_^FDHello^FS\n"
        "^XZ")
    bare = {"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3, "h": 0.8,
         "rotation": 0, "symbology": "code128", "data": "A1", "showText": True}]}
    assert "^BY2^BCN,162,Y,N,N" in compile_zpl(parse_design(bare), 203)
```

Add to `api/tests/test_labels_design_model.py`:

```python
def test_new_text_properties_default_off():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
         "rotation": 0, "content": "x", "fontSizePt": 10,
         "bold": False, "align": "left"}]})
    assert d.elements[0].reverse is False
    assert d.elements[0].lines == 1


def test_lines_must_be_a_positive_integer():
    with pytest.raises(DesignError) as err:
        parse_design({"size": {"w": 4, "h": 2}, "elements": [
            {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
             "rotation": 0, "content": "x", "fontSizePt": 10, "bold": False,
             "align": "left", "lines": 0}]})
    assert any("lines" in p for p in err.value.problems)


def test_module_in_must_be_positive_when_present():
    with pytest.raises(DesignError) as err:
        parse_design({"size": {"w": 4, "h": 2}, "elements": [
            {"id": "b1", "type": "barcode", "x": 0, "y": 0, "w": 2, "h": 0.5,
             "rotation": 0, "symbology": "code128", "data": "A",
             "showText": True, "moduleIn": 0}]})
    assert any("moduleIn" in p for p in err.value.problems)


def test_module_in_defaults_to_none():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0, "y": 0, "w": 2, "h": 0.5,
         "rotation": 0, "symbology": "code128", "data": "A",
         "showText": True}]})
    assert d.elements[0].module_in is None
```

Make sure `pytest`, `parse_design` and `DesignError` are imported in the model test file (check its existing imports first).

- [ ] **Step 2: Run them to verify they fail**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_labels_zpl.py api/tests/test_labels_design_model.py -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'reverse'` or `AttributeError: 'TextEl' object has no attribute 'reverse'`, and the `^BY3` / `^FB...,L,` assertions do not match.

- [ ] **Step 3: Extend the dataclasses in model.py**

Add the fields to `TextEl` and `BarcodeEl`:

```python
@dataclass(frozen=True)
class TextEl(_Base):
    content: str
    font_size_pt: float
    bold: bool
    align: str
    # `reverse` emits ZPL ^FR (knockout text, for text sitting on a filled
    # bar); `lines` is the ^FB line count, so a field can wrap. Both are
    # Zebra-only and default to the pre-2026-09-16 behavior.
    reverse: bool = False
    lines: int = 1


@dataclass(frozen=True)
class BarcodeEl(_Base):
    symbology: str
    data: str
    show_text: bool
    # Narrow-module width in INCHES. None keeps the historical hardcoded
    # ^BY2, which makes a barcode physically narrower at 300 dpi than at
    # 203; a design that needs the same physical width at both sets this.
    module_in: float | None = None
```

- [ ] **Step 4: Parse and validate them**

In `parse_design`, inside the `if etype == "text":` branch, before the `parsed.append(...)`:

```python
            lines = el.get("lines", 1)
            if not isinstance(lines, int) or isinstance(lines, bool) or lines < 1:
                p.append("lines must be an integer of 1 or more")
                lines = 1
```

and change that branch's append to:

```python
            parsed.append(TextEl(**base, content=content,
                                 font_size_pt=float(fs),
                                 bold=bool(el.get("bold", False)),
                                 align=align,
                                 reverse=bool(el.get("reverse", False)),
                                 lines=lines))
```

In the `elif etype == "barcode":` branch, before its append:

```python
            module_in = el.get("moduleIn")
            if module_in is not None:
                if not _num(module_in) or module_in <= 0:
                    p.append("moduleIn must be a positive number")
                    module_in = None
                else:
                    module_in = float(module_in)
```

and change that branch's append to:

```python
            parsed.append(BarcodeEl(**base, symbology=sym, data=data,
                                    show_text=bool(el.get("showText", True)),
                                    module_in=module_in))
```

- [ ] **Step 5: Emit them in zpl.py**

Replace `_text` and `_barcode` in `api/src/serversherpa/labels/zpl.py`:

```python
_JUST = {"left": "L", "center": "C", "right": "R"}


def _text(el: TextEl, dpi: int, subs) -> str:
    h = round(el.font_size_pt * dpi / 72)
    w = round(h * 1.2) if el.bold else h
    line = f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}"
    # A ^FB is needed for justification OR for wrapping. Left-aligned
    # single-line fields still emit none, so existing designs are untouched.
    if el.align != "left" or el.lines > 1:
        line += f"^FB{_dots(el.w, dpi)},{el.lines},0,{_JUST[el.align]},0"
    line += f"^A0{_ROT[el.rotation]},{h},{w}"
    if el.reverse:
        line += "^FR"
    return line + f"^FH_^FD{_fd(el.content, subs)}^FS"


def _barcode(el: BarcodeEl, dpi: int, subs) -> str:
    hd = _dots(el.h, dpi)
    flag = "Y" if el.show_text else "N"
    # None keeps the historical ^BY2 exactly; a module width in inches is
    # converted per dpi so the barcode holds its PHYSICAL width across dpi.
    module = 2 if el.module_in is None else max(1, min(10, _dots(el.module_in, dpi)))
    cmd = (f"^BC{_ROT[el.rotation]},{hd},{flag},N,N"
           if el.symbology == "code128"
           else f"^B3{_ROT[el.rotation]},N,{hd},{flag},N")
    return (f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^BY{module}{cmd}"
            f"^FH_^FD{_fd(el.data, subs)}^FS")
```

- [ ] **Step 6: Document the Brother no-op**

Both Brother compilers already read only `content`/`data`/`font_size_pt`/`bold`/`symbology`/`h`/`show_text`, so they ignore the new properties with no code change. Make that deliberate rather than accidental — append one sentence to each module docstring.

In `api/src/serversherpa/labels/brother_escp.py`, at the end of the docstring:

```
Zebra-only element properties (`reverse`, `lines`, `module_in`) are
ignored here by design — ESC/P has no field-reverse or narrow-module
concept, and this compiler is line-oriented so wrapping is the
printer's business.
```

In `api/src/serversherpa/labels/brother_ptouch.py`, at the end of the docstring:

```
Zebra-only element properties (`reverse`, `lines`, `module_in`) are
ignored here by design — a P-touch template's objects own their own
appearance on the printer; we only send data.
```

- [ ] **Step 7: Run the full label suite**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -k "labels or label_" -v`
Expected: PASS. The Brother golden tests and the existing ZPL goldens must be untouched — if any golden fails, the absent-means-unchanged rule has been broken; fix the compiler, never the golden.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/labels/ api/tests/test_labels_zpl.py api/tests/test_labels_design_model.py
git commit -m "feat(labels): reverse, lines and moduleIn on the label element model

reverse emits ^FR for knockout text on a filled bar; lines drives the
^FB line count so a field can wrap; moduleIn sets the narrow-bar width
in inches so a barcode keeps its physical width across dpi instead of
riding the hardcoded ^BY2. All three default to the previous behavior,
so existing templates compile byte-identically.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0066 — vocab, placeholders and the four seeded templates

One migration file, written and committed whole. Do **not** split it across commits: once it has run against the dev database, editing it will not re-apply.

**Files:**
- Create: `api/migrations/versions/0066_container_zpl_templates.py`
- Test: `api/tests/test_container_zpl_templates.py` (new)

**Interfaces:**
- Consumes: `TextEl.reverse`, `TextEl.lines`, `BarcodeEl.module_in` from Task 2; `move_date_long` from Task 1.
- Produces: four `label_templates` rows named `Container Label 4x6 203dpi`, `Container Label 4x6 300dpi`, `Container Info 4x6 203dpi`, `Container Info 4x6 300dpi`; `label_vocab` rows `("size","4x6")` and `("type","container_info")`; `label_placeholders` rows `label_tag` and `move_date_long`. Task 4 loads these rows from the database by name.

**A note on `generation_rules`:** leave it `{}` on all four. It is tempting to cap `container_name` with `length_limits`, but that mechanism truncates the placeholder **value**, which feeds the barcode and QR as well as the printed name — a capped name would produce a barcode that scans to the wrong string. An over-long name clipping in its text box is the correct trade; the barcode must always carry the full name.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_container_zpl_templates.py`:

```python
"""The seeded 4x6 container ZPL templates: they exist, they parse, and
they compile to plausible ZPL at both dpi."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import LabelPlaceholder, LabelTemplate, LabelVocab
from serversherpa.labels.model import parse_design
from serversherpa.labels.zpl import compile_zpl

NAMES = ("Container Label 4x6 203dpi", "Container Label 4x6 300dpi",
         "Container Info 4x6 203dpi", "Container Info 4x6 300dpi")


async def _template(db, name):
    return await db.scalar(select(LabelTemplate).where(LabelTemplate.name == name))


@pytest.mark.anyio
async def test_all_four_templates_are_seeded_and_active(db):
    for name in NAMES:
        tpl = await _template(db, name)
        assert tpl is not None, f"{name} was not seeded"
        assert tpl.is_active is True
        assert tpl.kind == "design"
        assert tpl.language_key == "zpl"
        assert tpl.size_key == "4x6"
        assert tpl.generation_rules == {}


@pytest.mark.anyio
async def test_the_pair_of_each_design_differs_only_in_dpi(db):
    for base in ("Container Label 4x6", "Container Info 4x6"):
        a = await _template(db, f"{base} 203dpi")
        b = await _template(db, f"{base} 300dpi")
        assert a.design == b.design
        assert (a.dpi_key, b.dpi_key) == ("203", "300")
        assert a.label_type == b.label_type


@pytest.mark.anyio
async def test_the_4x6_size_row_is_portrait(db):
    row = await db.get(LabelVocab, ("size", "4x6"))
    assert row is not None
    assert row.meta["width_in"] == 4
    assert row.meta["height_in"] == 6


@pytest.mark.anyio
async def test_container_types_carry_their_default_copies(db):
    assert (await db.get(LabelVocab, ("type", "container"))).meta["default_copies"] == 5
    assert (await db.get(LabelVocab, ("type", "container_info"))).meta["default_copies"] == 1


@pytest.mark.anyio
async def test_new_placeholders_are_scoped_to_the_container_types(db):
    tag = await db.get(LabelPlaceholder, "label_tag")
    assert set(tag.applies_to) == {"container", "container_info"}
    long_date = await db.get(LabelPlaceholder, "move_date_long")
    assert {"container_info", "top"} <= set(long_date.applies_to)
    for key in ("source_site", "destination_site"):
        assert "container_info" in (await db.get(LabelPlaceholder, key)).applies_to


@pytest.mark.anyio
async def test_container_label_compiles_with_a_reversed_tag_bar(db):
    tpl = await _template(db, "Container Label 4x6 203dpi")
    out = compile_zpl(parse_design(tpl.design), 203,
                      {"label_tag": "PRIORITY", "container_name": "crate-17",
                       "move_name": "NAP11 Migration"})
    assert "^PW812" in out and "^LL1218" in out
    assert "^GB731,162,162^FS" in out            # solid tag bar
    assert "^FR^FH_^FDPRIORITY^FS" in out        # knockout text
    assert "^BY2^BCN,244,N,N,N^FH_^FDcrate-17^FS" in out
    assert "^FDNAP11 Migration^FS" in out


@pytest.mark.anyio
async def test_container_info_compiles_with_the_qr_and_rfid_zone(db):
    tpl = await _template(db, "Container Info 4x6 300dpi")
    out = compile_zpl(parse_design(tpl.design), 300,
                      {"source_site": "NAP7", "destination_site": "NAP11",
                       "move_date_long": "15-SEP-2026", "container_name": "crate-17"})
    assert "^BQN,2," in out
    assert "^FDQA,crate-17^FS" in out
    assert "^FD15-SEP-2026^FS" in out
    assert "^FDRFID TAG HERE^FS" in out
    assert out.count("^GB") == 2                 # the two RFID rules only
```

Match the file's `db` fixture and async-test decorator to whatever `api/tests/conftest.py` provides — copy the header of an existing DB-backed test such as `api/tests/test_labels_templates_api.py` rather than assuming `pytest.mark.anyio`.

- [ ] **Step 2: Run it to verify it fails**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_container_zpl_templates.py -v`
Expected: FAIL — every template lookup returns `None`.

- [ ] **Step 3: Write the migration**

Create `api/migrations/versions/0066_container_zpl_templates.py`:

```python
"""Container labels as ZPL — a 4" x 6" barcode label and info label, each
seeded at 203 and 300 dpi, plus the vocab and placeholders they need.

The container label prints x5 and the info label x1 per container, which
is why their type rows carry `default_copies`; that mirrors the Avery
sheet's five barcode labels plus one info label without the sheet's
six-slot geometry dictating the count.

Design literals live here rather than being imported from the
application so this migration stays frozen (same reasoning as 0058).

`generation_rules` is deliberately `{}`: `length_limits` truncates the
placeholder VALUE, which feeds the barcode and QR as well as the printed
name, so capping `container_name` would produce a barcode that scans to
the wrong string.

Design: docs/superpowers/specs/2026-09-16-container-labels-zpl-design.md

Revision ID: 0066
Revises: 0065
Create Date: 2026-09-16
"""
import json
from collections.abc import Sequence

from alembic import op

revision: str = "0066"
down_revision: str | None = "0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_DESIGN = {
    "size": {"w": 4, "h": 6},
    "elements": [
        {"id": "tag_bar", "type": "box", "x": 0.2, "y": 0.3, "w": 3.6,
         "h": 0.8, "rotation": 0, "strokeIn": 0.8},
        {"id": "tag_text", "type": "text", "x": 0.2, "y": 0.52, "w": 3.6,
         "h": 0.36, "rotation": 0, "content": "{label_tag}",
         "fontSizePt": 26, "bold": True, "align": "center", "reverse": True},
        {"id": "barcode", "type": "barcode", "x": 0.8, "y": 1.6, "w": 2.4,
         "h": 1.2, "rotation": 0, "symbology": "code128",
         "data": "{container_name}", "showText": False, "moduleIn": 0.01},
        {"id": "name", "type": "text", "x": 0.2, "y": 3.1, "w": 3.6,
         "h": 1.0, "rotation": 0, "content": "{container_name}",
         "fontSizePt": 28, "bold": True, "align": "center", "lines": 2},
        {"id": "move_name", "type": "text", "x": 0.2, "y": 5.55, "w": 3.6,
         "h": 0.2, "rotation": 0, "content": "{move_name}",
         "fontSizePt": 10, "bold": False, "align": "center"},
    ],
}

CONTAINER_INFO_DESIGN = {
    "size": {"w": 4, "h": 6},
    "elements": [
        {"id": "qr", "type": "qr", "x": 2.5, "y": 0.3, "w": 1.2, "h": 1.2,
         "rotation": 0, "data": "{container_name}"},
        {"id": "source_label", "type": "text", "x": 0.3, "y": 0.4, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "Source:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "source_value", "type": "text", "x": 0.5, "y": 0.7, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "{source_site}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "dest_label", "type": "text", "x": 0.3, "y": 1.1, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "Dest:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "dest_value", "type": "text", "x": 0.5, "y": 1.4, "w": 1.9,
         "h": 0.25, "rotation": 0, "content": "{destination_site}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "date_label", "type": "text", "x": 0.3, "y": 1.8, "w": 3.0,
         "h": 0.25, "rotation": 0, "content": "Date:", "fontSizePt": 14,
         "bold": True, "align": "left"},
        {"id": "date_value", "type": "text", "x": 0.5, "y": 2.1, "w": 3.0,
         "h": 0.25, "rotation": 0, "content": "{move_date_long}",
         "fontSizePt": 14, "bold": False, "align": "left"},
        {"id": "container_label", "type": "text", "x": 0.3, "y": 2.5,
         "w": 3.0, "h": 0.25, "rotation": 0, "content": "Container:",
         "fontSizePt": 14, "bold": True, "align": "left"},
        {"id": "container_value", "type": "text", "x": 0.5, "y": 2.8,
         "w": 3.0, "h": 0.6, "rotation": 0, "content": "{container_name}",
         "fontSizePt": 14, "bold": False, "align": "left", "lines": 2},
        {"id": "rfid_rule_top", "type": "line", "x": 0.4, "y": 4.6, "w": 3.2,
         "h": 0.01, "rotation": 0, "strokeIn": 0.01},
        {"id": "rfid_text", "type": "text", "x": 0.4, "y": 4.85, "w": 3.2,
         "h": 0.25, "rotation": 0, "content": "RFID TAG HERE",
         "fontSizePt": 14, "bold": False, "align": "center"},
        {"id": "rfid_rule_bottom", "type": "line", "x": 0.4, "y": 5.15,
         "w": 3.2, "h": 0.01, "rotation": 0, "strokeIn": 0.01},
    ],
}

TEMPLATES = [
    ("Container Label 4x6 203dpi", "container", "203",
     "Crate barcode label: tag bar, Code 128 and the container name.",
     CONTAINER_DESIGN),
    ("Container Label 4x6 300dpi", "container", "300",
     "Crate barcode label: tag bar, Code 128 and the container name.",
     CONTAINER_DESIGN),
    ("Container Info 4x6 203dpi", "container_info", "203",
     "Crate info label: QR, source, destination, date and the RFID zone.",
     CONTAINER_INFO_DESIGN),
    ("Container Info 4x6 300dpi", "container_info", "300",
     "Crate info label: QR, source, destination, date and the RFID zone.",
     CONTAINER_INFO_DESIGN),
]


def _q(value: str) -> str:
    """Single-quoted SQL literal with quotes doubled."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def upgrade() -> None:
    op.execute("""
        INSERT INTO label_vocab (kind, key, label, description, meta, sort_order)
        VALUES ('size', '4x6', '4" x 6"', 'Zebra roll label, portrait.',
                '{"width_in": 4, "height_in": 6, "has_tab": false}', 7)
        ON CONFLICT (kind, key) DO NOTHING
    """)
    op.execute("""
        INSERT INTO label_vocab (kind, key, label, description, meta, sort_order)
        VALUES ('type', 'container_info', 'Container Info Label',
                'The crate''s QR, route, date and RFID zone.',
                '{"default_copies": 1}', 5)
        ON CONFLICT (kind, key) DO NOTHING
    """)
    op.execute("""
        UPDATE label_vocab SET meta = meta || '{"default_copies": 5}'::jsonb
        WHERE kind = 'type' AND key = 'container'
    """)

    # Placeholder scoping: the info label needs the site names, and both
    # container types need everything the `container` type already had.
    op.execute("""
        UPDATE label_placeholders
        SET applies_to = (
            SELECT array_agg(DISTINCT t)
            FROM unnest(applies_to || ARRAY['container', 'container_info']) AS t)
        WHERE key IN ('source_site', 'destination_site')
    """)
    op.execute("""
        UPDATE label_placeholders
        SET applies_to = (
            SELECT array_agg(DISTINCT t)
            FROM unnest(applies_to || ARRAY['container_info']) AS t)
        WHERE key IN ('move_name', 'move_date', 'container_name', 'container_id')
    """)
    op.execute("""
        INSERT INTO label_placeholders
            (key, label, description, sample_value, applies_to, sort_order)
        VALUES
            ('label_tag', 'Container tag',
             'Priority / Vendor / Accessories / Warehouse / E-Waste, upper-cased. '
             'Falls back to CONTAINER when the container has no tag.',
             'PRIORITY', '{container,container_info}', 17),
            ('move_date_long', 'Move date (long)',
             'The move date as DD-MON-YYYY, which reads unambiguously in every '
             'region the company operates in.',
             '01-SEP-2026', '{top,front,rail,container,container_info}', 18)
        ON CONFLICT (key) DO NOTHING
    """)

    for name, label_type, dpi_key, description, design in TEMPLATES:
        op.execute(f"""
            INSERT INTO label_templates
                (name, description, label_type, size_key, dpi_key,
                 language_key, kind, design, generation_rules, is_active)
            VALUES (
                {_q(name)}, {_q(description)}, {_q(label_type)}, '4x6',
                {_q(dpi_key)}, 'zpl', 'design',
                {_q(json.dumps(design))}::jsonb, '{{}}'::jsonb, true)
            ON CONFLICT (name) DO NOTHING
        """)


def downgrade() -> None:
    names = ", ".join(_q(t[0]) for t in TEMPLATES)
    op.execute(f"DELETE FROM label_templates WHERE name IN ({names})")
    op.execute("DELETE FROM label_placeholders WHERE key IN ('label_tag', 'move_date_long')")
    op.execute("""
        UPDATE label_placeholders
        SET applies_to = array_remove(applies_to, 'container_info')
    """)
    op.execute("""
        UPDATE label_placeholders
        SET applies_to = array_remove(applies_to, 'container')
        WHERE key IN ('source_site', 'destination_site')
    """)
    op.execute("UPDATE label_vocab SET meta = meta - 'default_copies' WHERE kind = 'type'")
    op.execute("DELETE FROM label_vocab WHERE kind = 'type' AND key = 'container_info'")
    op.execute("DELETE FROM label_vocab WHERE kind = 'size' AND key = '4x6'")
```

- [ ] **Step 4: Apply it to the dev database**

Run: `cd api && .venv/bin/alembic upgrade head && cd ..`
Expected: `Running upgrade 0065 -> 0066, Container labels as ZPL`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_container_zpl_templates.py -v`
Expected: PASS, all eight tests.

If the `^GB731,162,162^FS` assertion fails, read the actual value out of the failure and check the arithmetic — `0.8 * 203 = 162.4` rounds to 162 and `3.6 * 203 = 730.8` rounds to 731. Correct the **test** only if the arithmetic genuinely says so; a mismatch in the `^FR` or `^BY` assertions means Task 2's compiler is wrong, not this test.

- [ ] **Step 6: Confirm there is still exactly one alembic head**

Run: `cd api && .venv/bin/alembic heads && cd ..`
Expected: exactly one line, ending `(head)`.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0066_container_zpl_templates.py api/tests/test_container_zpl_templates.py
git commit -m "feat(labels): seed the 4x6 container ZPL templates at 203 and 300 dpi

A barcode label (tag bar, Code 128, container name) and an info label
(QR, route, date, RFID zone), each seeded at both dpi from one design.
Adds the 4x6 size row, the container_info type, default_copies on both
container types, and the label_tag and move_date_long placeholders.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Physical-size invariance and a look at the real labels

The point of shipping a 203 and a 300 dpi version is that they print the *same physical label*. This task proves that mechanically, then renders all four through Labelary so a human sees them before any of this reaches a printer.

**Files:**
- Test: `api/tests/test_container_zpl_templates.py` (extend)
- Create: `/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/f2cbb8c1-b993-4976-abfe-47006c86a67f/scratchpad/labelary/` (render output; not committed)

**Interfaces:**
- Consumes: the four seeded templates from Task 3, by name.
- Produces: nothing other tasks depend on. This is the verification gate for phase one.

- [ ] **Step 1: Write the failing invariance test**

Add `import re` to the imports at the TOP of `api/tests/test_container_zpl_templates.py`, then append the rest to the end of the file:

```python
_FO = re.compile(r"\^FO(\d+),(\d+)")
_GB = re.compile(r"\^GB(\d+),(\d+),(\d+)")
_BY = re.compile(r"\^BY(\d+)")


def _inches(zpl: str, dpi: int) -> dict[str, list[float]]:
    """Every geometric number in the ZPL, converted back to inches."""
    return {
        "fo": [v / dpi for m in _FO.finditer(zpl) for v in map(int, m.groups())],
        "gb": [v / dpi for m in _GB.finditer(zpl) for v in map(int, m.groups())],
        "by": [v / dpi for m in _BY.finditer(zpl) for v in map(int, m.groups())],
    }


@pytest.mark.anyio
@pytest.mark.parametrize("base", ["Container Label 4x6", "Container Info 4x6"])
async def test_both_dpi_describe_the_same_physical_label(db, base):
    """A 203 and a 300 dpi version must place ink in the same physical
    places. This is the test that would have caught the hardcoded ^BY2,
    which made a barcode 1.5x narrower at 300 dpi than at 203."""
    subs = {"label_tag": "PRIORITY", "container_name": "crate-17",
            "move_name": "NAP11 Migration", "source_site": "NAP7",
            "destination_site": "NAP11", "move_date_long": "15-SEP-2026"}
    lo = await _template(db, f"{base} 203dpi")
    hi = await _template(db, f"{base} 300dpi")
    a = _inches(compile_zpl(parse_design(lo.design), 203, subs), 203)
    b = _inches(compile_zpl(parse_design(hi.design), 300, subs), 300)

    assert set(a) == set(b)
    tolerance = 1 / 203          # one dot at the coarser resolution
    for kind in a:
        assert len(a[kind]) == len(b[kind]), f"{kind}: different element counts"
        for i, (lo_in, hi_in) in enumerate(zip(a[kind], b[kind])):
            assert abs(lo_in - hi_in) <= tolerance, (
                f"{kind}[{i}]: {lo_in:.4f}in at 203 vs {hi_in:.4f}in at 300")
```

- [ ] **Step 2: Run it to verify it fails, then confirm WHY**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_container_zpl_templates.py -k physical -v`
Expected: PASS, because Task 2 and Task 3 already did the work. **This is the one test in this plan that is expected to pass on first run**, so prove it is not vacuous: temporarily edit the seeded `moduleIn` out of `CONTAINER_DESIGN` in the migration, re-run `alembic upgrade head` against a fresh database (or edit the design in the test to drop `moduleIn`), and confirm the `by` assertion fails with `0.0099in at 203 vs 0.0067in at 300`. Then restore it. Record in the commit message that you did this.

- [ ] **Step 3: Render all four templates through Labelary**

Labelary is a network service (`labels/labelary.py` posts to labelary.com), so this is a live check, not an automated test. Run from the worktree root:

```bash
PYTHONPATH=api/src api/.venv/bin/python - <<'PY'
import asyncio, pathlib
from serversherpa.db.engine import dispose_engine, get_sessionmaker
from sqlalchemy import select
from serversherpa.db.models import LabelTemplate
from serversherpa.labels.model import parse_design
from serversherpa.labels.zpl import compile_zpl
from serversherpa.labels.labelary import render_png

OUT = pathlib.Path("/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/"
                   "f2cbb8c1-b993-4976-abfe-47006c86a67f/scratchpad/labelary")
SUBS = {"label_tag": "PRIORITY", "container_name": "scan-verify-crate",
        "move_name": "NAP11 Hall Migration", "source_site": "NAP7",
        "destination_site": "NAP11", "move_date_long": "15-SEP-2026"}

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with get_sessionmaker()() as db:
        for name in ("Container Label 4x6 203dpi", "Container Label 4x6 300dpi",
                     "Container Info 4x6 203dpi", "Container Info 4x6 300dpi"):
            tpl = await db.scalar(select(LabelTemplate).where(LabelTemplate.name == name))
            dpi = int(tpl.dpi_key)
            zpl = compile_zpl(parse_design(tpl.design), dpi, SUBS)
            png = await render_png(zpl, 4, 6, 8 if dpi == 203 else 12)
            path = OUT / f"{name.replace(' ', '_')}.png"
            path.write_bytes(png)
            print(path, len(png), "bytes")
    await dispose_engine()

asyncio.run(main())
PY
```

- [ ] **Step 4: Actually look at the renders**

Read each of the four PNGs and check, for both the 203 and 300 versions:

1. The tag bar is solid black with **legible white** `PRIORITY` inside it — not black-on-black (which means `^FR` is missing) and not overflowing the bar.
2. `scan-verify-crate` fits the name area without clipping. **If it clips, this is the expected outcome of the 28pt estimate** — reduce `fontSizePt` on the `name` element in the migration, re-run `alembic upgrade head` on a fresh database, and re-render until it fits. Record the final size.
3. The barcode is the same physical width on both, and the bars are not so fine they look grey.
4. On the info label, no value collides with the QR, and the RFID zone's two rules sit above and below its text.
5. Nothing runs off any edge of the 4 x 6 canvas.

Then substitute a long initiative name and an empty `label_tag` and re-render the container label to confirm the degenerate cases are still sane.

- [ ] **Step 5: Send the renders to Jimmy**

These are the first look at the actual labels; do not proceed to a printer without them being seen. Send the four PNGs with a caption naming the font size finally used for the container name.

- [ ] **Step 6: Run the full API label suite**

Run: `PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/ -k "labels or label_ or container" -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/tests/test_container_zpl_templates.py api/migrations/versions/0066_container_zpl_templates.py
git commit -m "test(labels): pin physical-size invariance across 203 and 300 dpi

Converts every ^FO/^GB/^BY number back to inches and asserts the two dpi
versions agree within one coarse dot. Verified non-vacuous by removing
moduleIn and watching the barcode assertion fail (0.0099in vs 0.0067in).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase two — not in this plan

The spec's sections 4 and 5 (containers as first-class entities in the label worker, and the container list on the Print Labels page) are deliberately **not** in this plan. They get their own plan, written once phase one has landed, because writing real code for them requires reading the Print Labels page and the generate runner's callers in detail rather than guessing at component shapes.

What phase two will cover, so nothing is lost:

- `ENTITY_FOR_TYPE` (`container`/`container_info` -> `"container"`, else `"asset"`), living beside `labels/tags.py`.
- `ContainerRow` and `container_placeholder_values(...)` in `values.py`, including the `CONTAINER` fallback for an untagged container and reuse of Task 1's `_stored_day`.
- `runner.py`: per-label-type rosters, `entity_type` parametrized through `_load_existing_for_type` and `_upsert_label`, `_item_label` handling both row kinds, and `total` as a sum over types rather than `len(roster) * len(label_types)`.
- The container roster: `initiative_id == run.initiative_id` **and `archived_at IS NULL`**.
- `GET /labels/generated/bundle`: derive `entity_type` from the label type instead of hardcoding `"asset"`, and carry an entity name so the print list has something to show.
- Print Labels: a container list beside `PrintAssetList`, and the copies field seeded from the selected type's `default_copies`.

Phase one on its own delivers a compiled, inspected, printable 4 x 6 ZPL container label at both dpi, editable in the template editor — which is the thing Jimmy asked to be able to do.
