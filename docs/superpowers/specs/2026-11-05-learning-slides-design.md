# Learning documents: slides reading style

## Why

Some learning modules are slide decks, not policies. The first is Dress code:
four slides, each a picture with a few lines of text (seeded in main
c4240e86). Today every learning document reads as one long page, so a
worker can swipe past the slides in two seconds and the only proof of
reading is "scrolled to the end." Jimmy wants slide modules shown one slide
at a time, with the worker clicking through each one before they can sign.

## Goals

- A per-document **reading style**: Document (today's behavior) or Slides.
- In Slides, the learn reader shows one slide at a time with Back / Next.
- The worker can only move forward one unseen slide at a time. Once a
  slide has been seen, they can jump to it freely (Jimmy's rule).
- Signing needs every slide seen, checked by the API, not just the page.
- The existing minimum reading time stays one total for the whole document
  (Jimmy's rule: total time spent, not per slide).
- Managers see the slides the same way in the portal.

## Non-goals

- **Video.** A "watch the whole embedded video" gate (YouTube embeds) was
  discussed and set aside for now (Jimmy: no immediate need). The design
  only has to leave room for it: whatever decides "Next is allowed" for a
  slide should be able to take another condition later.
- **Translations.** Ignored for now (Jimmy). No change to how translations
  are made or served. Only English is switched on today. The one rule
  needed so a translation can't break the gate is under "Progress and the
  sign gate".
- **Native apps.** Android and iOS only warn about outstanding training;
  reading happens in the learn web app. This is web only (Jimmy).
- No new wiki editor features. Authors keep writing ordinary wiki pages.
- No per-slide minimum time, no slide timers, no slide analytics.

## Anti-goals

- Existing documents must not change: they stay Document style.
- A slide module must not be signable by skipping slides through the API.

## Behavior

### Where slides come from (my call)

A Slides document is the same wiki page and the same published version
snapshot as today. The page is split into slides at its level-2 headings
(`##` in the editor): each heading starts a slide, and everything before
the first heading is the opening slide (dropped if it is empty). A page with
no level-2 headings is one slide. The Dress code page splits into exactly
its four slides this way.

Splitting happens from the version that is served (its stored HTML), at
read time, so nothing about publishing changes. Where the split lives (API
or reader) is the builder's call, but the API must know the slide count of
the version being read, because it enforces the sign gate.

### Setting (portal)

Learning › Library › document › the rules panel (`DocumentRulesPanel`)
gets **Reading style** with two choices, Document and Slides (use the
portal's existing segmented-control idiom). New column on
`learning_documents`, default `document`; a migration (next free number
after 0120 at merge time).

- In Slides, the "Must scroll to the end" switch is replaced by a line
  "Readers go through every slide before they can sign." The stored
  `require_scroll` value is left alone and ignored while the style is
  Slides (my call), so switching back restores it.
- The panel shows the current version's slide count ("4 slides"). When the
  page has no level-2 headings it says the page shows as one slide and
  that `##` headings start new slides.
- The read-only view (`kv` list) shows "Reading style: Slides" and drops
  the scroll row in that style.
- The document page's content preview shows the slides with free
  navigation (managers are never gated).

Changing the style is audited like other document settings.

### Reader (learn app), Slides style

The mockup that Jimmy reviewed: `.superpowers/brainstorm/34475-1793937564/content/slide-reader.html`
(local, not committed).

- One slide fills the document area: the slide's content (image, then its
  text) as the page's HTML renders it.
- Under it, one row: **Back**, numbered dots (one per slide), "2 / 4", and
  **Next** (primary). Visible buttons for everything; arrow keys may also
  move Back/Next, but keys are never the only way (house rule).
- Dots: the current slide filled, seen slides outlined in the accent
  color, unreached slides dimmed and disabled with a "Not reached yet"
  tooltip. Next is disabled on the last slide.
- Moving forward: Next always goes to the following slide. The furthest
  slide reached can only grow by one per Next. Any slide up to the furthest
  reached can be opened from the dots.
- A status line under the row says what is still needed: "Go through every
  slide to sign. (2 of 4 seen)", then the reading-time countdown, then
  "All slides seen. You can sign now."
- The agreement, name/signature and Sign button stay where they are today
  (below) and keep today's pattern (my call, overriding the greyed-out
  mockup): Sign always works, and tapping it early says why. "Go through
  every slide first" joins the existing reasons, next to the scroll one.
- **Quiz** (my call): when the document has a quiz, "Take the quiz" shows
  only once every slide has been seen, so the quiz can't be a way to start
  before reading. This is a reader rule; the quiz endpoints get no new
  gate, because signing already refuses until every slide is seen.
- **Resume:** reopening an unsigned assignment opens at the furthest slide
  reached, not slide 1, on any device (it is stored server side, below).
- Works on phone widths; the slide image scales to the width.
- Follows the light/dark theme like the rest of the learn app.

**Review mode** (a signed assignment opened from History): slides with
free navigation, no status line, no gates, same Back link as today.

Document style is unchanged.

### Progress and the sign gate (API)

- The worker's assignment read (`GET /learn/assignments/{id}`) adds
  `reading_style`, `slide_count` and `slide_reached` (0-based furthest
  slide reached, null before any). In Slides style the response also gives
  the slides themselves, already split, if the split lives in the API.
- New worker call to record reaching a slide, e.g.
  `POST /learn/assignments/{id}/slides/{n}` with the version number shown.
  It accepts `n <= slide_reached + 1` (opening slide 0 counts) and raises
  `slide_reached` to `n`; anything further ahead is refused (422), so the
  one-at-a-time rule holds against direct API calls. 409 `version_changed`
  when the version shown is no longer the one to sign, as signing does.
- Progress belongs to the version and the language being read (my call):
  the slides are split from whichever HTML is served (English, or a
  published translation), the slide call carries the language, and
  progress starts over when either changes. The sign gate counts the slides
  of the version and language the progress was recorded for.
- **Sign** in Slides style refuses with 422 `slides_required` unless
  `slide_reached` is the last slide. The reader maps that code to a message
  the same way it maps `scroll_required` today. The existing
  `min_read_seconds` check (from `opened_at`) is unchanged.
- The sign-off records how it was read: new sign-off column with the
  number of slides seen (null for Document style) (my call), shown where
  the portal shows a sign-off's reading details.

Switching a document's style while people are partway through: no special
handling. Their next read uses the new style; Slides progress starts from
nothing if none was recorded.

## Constraints

- American English in all copy, comments and docs.
- Portal and learn UI follow the existing idioms (segmented control,
  `lrn-toggle` rows, learn banners) and the light/dark theme; no default
  browser scrollbars in new scroll areas.
- The learn app's `portalImports` allowlist test applies if any portal
  component is reused.
- Tests: API (progress rules, sign gate, version change, Document style
  unaffected), learn reader (navigation rules, gating, resume, review
  mode), portal panel (style switch, slide count, one-slide note).
- Dress code ships as Slides in the seed (`seed_content.py`
  `"reading_style": "slides"` with its existing settings, `require_scroll`
  stays True and unused). The seed never changes an existing document, so
  the dev database's Dress code is switched to Slides by hand in the
  portal after the merge (my call); no migration data step.

## Left to the builder

- Splitting in the API or in the reader (the API needs the count either
  way), and how the split handles the rendered heading tags.
- Exact endpoint path and payload names, column names and types.
- Dot styling details, transitions, and whether arrow keys/swipe are added.
- How the portal preview reuses the reader component.
