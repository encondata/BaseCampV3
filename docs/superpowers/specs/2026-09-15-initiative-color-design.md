# Initiative color — design

Jimmy, 2026-09-15: "add a color selector to the initiatives full edit page that
will be used for the calendar. a simple color wheel selector. when a new
initiative is created lets auto select a unique color which can be changed if
the user wants."

Answered when asked:

| Question | Choice |
|---|---|
| Control | **Wheel only** — a hue wheel plus a lightness slider and a hex readout. No preset swatch grid. |
| Where the color is used | **Calendar and timeline bars** both color by initiative. The initiatives list chip keeps coloring by status. |
| "Unique" means | Unique among **unarchived** initiatives. Archiving frees a color for reuse. |

## Why a stored color at all

Today every bar on /initiatives/timeline is painted from `status_color`, so a
month of work is four or five repeated colors and you cannot tell two scheduled
moves apart. Status is already legible from the filter pills, the tooltip, and
the list. Identity is what the calendar lacks, so the calendar colors by
initiative and the list keeps coloring by status.

## Data

`initiatives.color` — `text`, nullable, `#rrggbb` lowercase.

Nullable, not `NOT NULL DEFAULT`: a single server default would hand every row
the same color and defeat the point. The migration backfills existing rows from
the palette (round-robin over `created_at`, so the assignment is deterministic
and reproducible), `POST /initiatives` assigns on create, and every reader falls
back to `status_color` when the column is null. Null is therefore unreachable in
practice but harmless if it appears.

**Migration number.** `reports` is at 0063. A sibling session's unmerged
`timeclock` branch already holds `0064_time_entry_device.py` **and has applied it
to the shared dev database**. This branch's migration is therefore
`0065_initiative_color.py` with `down_revision = "0063"`, which keeps this
branch's own chain (and its test database) self-consistent. When the two
branches converge, whoever merges second re-points 0065's `down_revision` to
`"0064"`; there is no data dependency between them, only the chain. Live
verification here runs against a throwaway copy of the dev database stamped back
to 0063, never against the shared one.

### Palette

Twelve hues spaced around the wheel, each already legible through the
`.chip.custom` rule (which clamps lightness per theme, so the stored hex only
has to be a reasonable hue):

```
#1668a7 #0f7c86 #178a4c #5d8a17 #a36207 #c05a1f
#c03540 #b3316d #8b3fb8 #6d4fc4 #3f63c4 #51606f
```

Twelve is enough that a normal month of unarchived work gets distinct colors,
and the assignment degrades predictably past that.

### Assignment

`_next_color(db)` counts how many **unarchived** initiatives hold each palette
color and returns the least-used one, breaking ties by palette order. So the
first twelve initiatives get twelve different colors; the thirteenth starts the
second lap. A color the user typed by hand that is not in the palette simply
never participates in the counting.

## API

- `InitiativeItem.color: str | None` — the stored value, not a computed
  fallback. The portal does the falling back, so the edit modal can tell the
  difference between "set" and "never set".
- `InitiativeCreateIn.color` / `InitiativeUpdateIn.color` — optional. A
  `_normalize_color` field validator accepts `#rgb` or `#rrggbb` in any case and
  stores lowercase `#rrggbb`; anything else is 422 `invalid_color`. On create,
  omitted means "assign one". On update, present-and-null clears it back to
  status coloring (the UI does not offer this, but the API should not invent a
  reason to refuse it).
- `GET /initiatives/next-color` → `{"color": "#rrggbb"}`, gated on
  `initiatives:add`, returning exactly what a create would assign right now. The
  create modal opens with the wheel already on that color, so "auto select a
  unique color which can be changed" is visible before saving rather than a
  surprise afterwards. Registered before `/{id}` like `/trucks/map`.

Existing `require_permission` and `_require_global` gating is unchanged; color is
an ordinary field on the existing create/update routes.

## Portal

### `components/ColorWheel.tsx`

- A hue ring drawn with `conic-gradient`, with a draggable handle. Click or drag
  anywhere on the ring sets the hue from the angle.
- A lightness slider under it, drawn as a gradient of the current hue.
- A hex readout that is also an input, committed on blur or Enter, reusing
  `normalizeHex` from `lib/variables.ts`.
- A live preview of the real `.chip custom` shape, so what you pick is what the
  calendar bar will look like.
- Keyboard: the ring handle is a real `role="slider"` with `aria-valuenow` in
  degrees; Left/Right step a degree, Shift accelerates. The lightness slider is
  a native range input, which is the one native control the house style does
  allow (`.pf-form` already uses them).

Stored as hex, converted to and from HSL only inside the component, so nothing
else in the codebase has to learn a second color representation.

### `InitiativeEditModal`

A Color field in the Identity section, under Status. In create mode the wheel
opens on the color from `GET /initiatives/next-color` with the hint "Assigned
automatically — spin the wheel to choose your own." In edit mode it opens on the
initiative's stored color, falling back to its status color.

### Timeline page

`InitiativeTimeline.tsx` paints `--chip` from `i.color ?? i.status_color` for
the calendar span, the timeline's scheduled bar, and its real-dates bar. Nothing
else about either view changes.

## Out of scope

- The initiatives list chip, which stays status-colored.
- Any bulk "recolor everything" action.
- Per-client or per-type palettes.
