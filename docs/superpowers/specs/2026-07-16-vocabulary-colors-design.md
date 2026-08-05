# Free-picked vocabulary colours + creating site types and worker levels

**Date:** 2026-07-16
**Status:** approved
**Builds on:** `2026-07-15-status-values-design.md`

## Problem

Two gaps in the Variables page, both reported by the plan owner.

**The colour picker is a list of seven.** `status_values.color` stores a *token
name* (`c-green`), and the seven tokens are the only choices. The picker is a
native `<select>` over that list.

**Site types and worker levels can't be created** — only edited. And they have
no colour at all: `site_types` has an `icon`, `worker_levels` has neither.

Two things found while scoping, which change the shape of the work:

- **Worker levels already have colours.** `Workers.tsx:66` holds a hardcoded
  `LEVEL_COLORS` map of raw hex driving the badge background. So this isn't
  inventing a feature — it's moving colours that already exist out of the
  frontend into the table where they can be edited.
- **Site types already render as chips** (`Sites.tsx:210`, `chip tag`) — just
  permanently grey.

## Why the seven tokens exist

They are not an arbitrary shortlist. A token is a *class name* that CSS expands
into three values, and **each token has a different value per theme**:

| token | light | dark |
|---|---|---|
| `c-green` | `#178a4c` | `#3ddc84` |
| `c-aqua` | `#0f7c86` | `#35e0c8` |

Light values are dark colours; dark values are bright. Same hue, opposite
lightness — because chip text must contrast against the card, and the card
flips. A single hex written into both themes is unreadable in one of them.

That is the real problem behind "make it a true colour picker", and it is why
this is a design change rather than swapping a widget.

## Approach

Store one hex per value. Preserve **hue and saturation** exactly as picked;
let **lightness** adapt to the theme at render. The user picks a colour; the
chip stays readable in both themes.

Two rendering shapes, because the colour plays opposite roles:

- **Chip** (statuses, site types) — colour is the **text**, on a 12% tint of
  itself. Text must contrast the card → clamp lightness *dark* on light theme,
  *light* on dark theme.
- **Level badge** — colour is the **background**, with fixed near-black text
  (`.lvl-badge b { color: #0c1117 }`, no dark override). Text must contrast the
  colour → clamp lightness **bright in both themes**, which is what every
  current `LEVEL_COLORS` value happens to be. No dark override needed; today's
  appearance is preserved.

### Decisions

| Question | Decision |
|---|---|
| Colour on site types / worker levels | Yes — new NOT NULL columns on both |
| Theme handling | One hex; clamp lightness per theme, preserve hue |
| Picker | Native `<input type="color">` + the 7 as preset swatches + dual-theme preview |
| Existing tokens | Stay, for hardcoded UI chips. Only *vocabulary* colour goes hex |
| New worker level's rank | Gap picker — insert before/between/after; server shifts |
| Level key naming | Free text; the modal shows the resulting order rather than policing it |
| Colour validation | `^#[0-9a-f]{6}$` server-side — a deviation, see below |

**Deviation from the status-values spec, deliberate.** That spec said colour is
"deliberately NOT validated server-side — no existing lookup validates colour".
That held when colour was a token chosen from a fixed `<select>`. It is now free
input that lands in a CSS custom property, so the format is checked. This is a
format check, not a taste judgment — any hex is allowed.

## Data model — migration 0013

**1. `status_values.color`: token → hex.** Map each of the seven tokens to its
**light-theme** hex. Light is the correct source: it preserves today's
light-mode appearance byte-for-byte, and the dark clamp raises lightness back
to approximately today's dark value (same hue). The mapping is by token, not by
row — a custom status created since 0012 carries a token too.

```
c-green → #178a4c   c-amber → #a36207   c-red    → #c03540   c-blue → #1668a7
c-violet → #6d4fc4  c-aqua  → #0f7c86   c-slate  → #51606f
```

Any value not in that map (impossible today — the picker only offered the
seven) falls back to `#51606f`, matching the existing `UNKNOWN_COLOR = "c-slate"`
in `status/labels.py`. That constant becomes the hex.

**2. New colour columns**, both `text NOT NULL`:

- `site_types.color` — seeded per type. No prior colour existed (they rendered
  grey), so these are new choices: `datacenter #1668a7`, `office #6d4fc4`,
  `warehouse #a36207`, `colo #0f7c86`, `partner_office #178a4c`,
  `other #51606f`.
- `worker_levels.color` — seeded **from the `LEVEL_COLORS` map being deleted**,
  so the badges look identical after this ships:
  `L1 #8a93a6`, `L2 #4dd0ff`, `L3 #35e0c8`, `L4 #3ddc84`, `L5 #a78bfa`,
  `L6 #ffb84d`.

**3. `worker_levels.rank` unique constraint → `DEFERRABLE INITIALLY IMMEDIATE`.**
`0007_workers.py:25` declares it `unique=True`, non-deferrable — and a
non-deferrable unique constraint is checked **per row**, so a single
`UPDATE ... SET rank = rank + 1 WHERE rank >= n` can fail mid-statement
depending on row order (ascending, it sets 3→4 while a row still holds 4).

Declaring it `DEFERRABLE` is what fixes that, and the mechanism is worth
stating precisely because it is easy to get wrong: **declaring a unique
constraint deferrable moves its check from per-row to end-of-statement, even
under `INITIALLY IMMEDIATE`.** So the shift lands as one statement whose final
state is unique, and no `SET CONSTRAINTS ... DEFERRED` is needed. Verified on
PG 16.14: non-deferrable + that UPDATE errors; `DEFERRABLE INITIALLY IMMEDIATE`
+ the same UPDATE, with no `SET CONSTRAINTS`, succeeds.

`INITIALLY IMMEDIATE` rather than `INITIALLY DEFERRED` is deliberate: a genuine
violation then still surfaces at the offending statement rather than at
`COMMIT`, where it is far harder to attribute.

Downgrade reverses all three, and is lossy in the same way 0012's is. It
reverse-maps the seven known hexes back to their tokens; **any other hex becomes
`c-slate`**, because a token vocabulary cannot represent an arbitrary colour and
there is no honest nearest-match — a colour-distance function would be inventing
a wrong answer rather than admitting the loss. So a colour picked after this
migration does not survive a downgrade. Document that in `downgrade()`, as 0012
does for its own lossy paths.

## Rendering

One CSS rule replaces the per-token classes **for vocabulary colours only**:

```css
@property --chip { syntax: '<color>'; inherits: true; initial-value: #51606f; }

.chip.custom {
  color: oklch(from var(--chip) clamp(0.30, l, 0.50) c h);
  background: color-mix(in srgb, var(--chip) 12%, transparent);
  border-color: color-mix(in srgb, var(--chip) 28%, transparent);
}
.portal-shell[data-theme='dark'] .chip.custom {
  color: oklch(from var(--chip) clamp(0.72, l, 0.92) c h);
}
```

Only the text clamps. Background and border are alpha mixes, which composite
correctly over either card colour without adaptation.

The level badge takes the inverse:

```css
@property --lvl { syntax: '<color>'; inherits: true; initial-value: #8a93a6; }

.lvl-badge b {
  background: oklch(from var(--lvl) clamp(0.70, l, 0.88) c h);
  /* color: #0c1117 stays — the clamp guarantees a bright background */
}
```

Set via an inline custom property: `<span className="chip custom"
style={{ '--chip': value.color }}>`. React sets custom properties through
`CSSStyleDeclaration.setProperty`, so the value cannot break out of the
declaration; an unparseable colour makes the declaration invalid and the chip
falls back to inherited text colour rather than breaking the page.

**Browser support**: relative colour syntax (`oklch(from …)`) is Chrome 119+,
Safari 16.4+, Firefox 128+. If unsupported, the `color` declaration is dropped
and text inherits — degraded, not broken.

The seven tokens and their `.chip.c-*` classes **stay**. They back hardcoded UI
chips that are not vocabulary — org kinds (`External.tsx:270`), the
active/inactive flag (`Variables.tsx:206`), the access matrix. Only values that
live in a table become hex.

## API

**Colour on the two lookups**: `SiteLookupOut` gains `color`;
`SiteLookupUpdateIn` gains `color` **back** — with a note, since
`ae198dd` removed it as vestigial. It is no longer vestigial: `site_types` now
has the column. `WorkerLevelOut`/`WorkerLevelUpdateIn` gain `color`.

**Create — site types.** `POST /site-types`, `devtools:add`, mirroring
`POST /status-values`: `key` (`^[a-z0-9_]+$`, 1-40), `label`, `description`,
`sort_order`, `icon`, `color`. 409 `site_type_exists` on a duplicate key.

**Create — worker levels.** `POST /worker-levels`, `devtools:add`:
`level` (key), `title`, `description`, `expected_skills`, `color`, and
**`after: str | None`** — required, nullable. It names the level to insert
after; `null` means first.

`after` rather than a rank integer, deliberately: the client sends a *position*
("after L2"), the server computes the rank. No client-side rank arithmetic, and
a stale client list cannot produce a wrong rank.

```
after = "L2"  → new rank = L2.rank + 1; UPDATE rank = rank + 1 WHERE rank >= that
after = null  → new rank = 1;           shift everything
after = last  → new rank = max + 1;     no shift
```

The shift and the insert run in one transaction. Each is a single statement
ending in a unique state, which the deferrable constraint's end-of-statement
check accepts — see the migration section above for why no `SET CONSTRAINTS`
is involved.
409 `worker_level_exists` on a duplicate key; 422 `unknown_level` if `after`
names a level that doesn't exist.

**`rank` remains un-patchable.** Creating at a position is in scope; *moving* an
existing level is not — that is reordering, still its own feature.

## Portal

**The picker** (`ColorField`, new shared component — three modals use it):
- Native `<input type="color">`.
- The seven current colours as one-click preset swatches, labelled by name.
- A live preview showing the chip rendered **in both themes side by side**. This
  is load-bearing, not decoration: it is what makes "you pick one colour and it
  adapts" honest instead of surprising. The dark half renders inside a
  `.portal-shell[data-theme='dark']` wrapper so it uses the real rule.
- Hex text input, so a brand colour can be pasted.

**The gap picker** (worker level create) — one native `<select>` listing every
insertion point, which is how "before, between, or after" is actually expressed:

```
Before L1 (first) · Between L1 and L2 · … · Between L5 and L6 · After L6 (last)
```

Default: last. Below it, a **live preview of the resulting badge order**. This
is where the key-naming consequence becomes visible: name a level `L7`, insert
it between L2 and L3, and the preview reads `L1 L2 L7 L3 L4` before you save —
so you can pick a better key. Keys are free text and are **never renamed**
(`worker_profiles.level` points at them; renaming is what the whole design
forbids). The UI shows the consequence; it does not police it.

**Consumers**:
- `Sites.tsx:210` — site type chip: `chip tag` → `chip custom`. Needs
  `type_color` denormalised in `sites.py:_item` alongside the existing
  `type_label`.
- `Sites.tsx:214`, `Workers.tsx:250`, `Workers.tsx:415`, `OrgDirectory.tsx` —
  status chips: `chip ${status_color}` → `chip custom` + `--chip`.
- `LevelBadge` (`Workers.tsx:110`) — reads `def.color`; **`LEVEL_COLORS` is
  deleted**.
- `Variables.tsx` — the colour column swatch renders the hex.

**Pure helpers** in `lib/variables.ts` with tests beside them, per convention:
hex validation/normalisation, the preset list, `insertionPoints(levels)`
building the gap options, and `rankAfter(levels, after)` for the preview.

## Testing

**API** (`test_vocabulary_colors.py`, plus additions to existing files):
- Migration: every seeded status/type/level has a valid hex; the token→hex map
  covers all seven; downgrade restores tokens.
- `POST /site-types` — created, gated on `devtools:add`, 409 on duplicate.
- `POST /worker-levels` — `after: "L2"` inserts at rank 3 and shifts L3-L6 up;
  `after: null` inserts first and shifts everything; `after` naming the last
  level appends with no shift; `after: "nope"` → 422.
- **The shift is the load-bearing test**: after inserting mid-scale, read every
  level back and assert the full rank sequence is contiguous with no duplicates.
  A test asserting only the new row's rank would pass against a broken shift.
- Colour validation: `#gggggg` → 422; `#178a4c` → 200; a token like `c-green`
  → 422 (the old format is now invalid).
- `rank` is still rejected in a `PATCH` body.

**Portal** (`lib/variables.test.ts`): hex normalisation, `insertionPoints`
(including a single-level and an empty list), `rankAfter`. The jsdom
environment merged from `2026-07-16-portal-component-testability-design.md`
now makes a `ColorField` component test possible — cover that the preset
swatches set the value and that a pasted hex normalises.

## Out of scope

- **Moving an existing level** (patching `rank`). Creating at a position is in;
  reordering is still its own feature.
- **Per-theme colour pairs.** One hex, auto-adapted, was the chosen trade.
- **Retiring the seven tokens** from hardcoded UI chips.
- **Colour on `roles`** — it has its own editor under `/access`.
