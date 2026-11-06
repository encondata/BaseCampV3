# Learning Slides Reading Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-document reading style (Document or Slides): Slides documents read one slide at a time in the learn app, forward one unseen slide at a time, and can't be signed until every slide was reached.

**Architecture:** A new `reading_style` column on `learning_documents`. The API splits the HTML it serves at top-level `<h2>` into slides (`learning/slides.py`), stores the furthest slide reached on the assignment (keyed by version and language), and refuses signing until the last slide was reached. The learn Reader gets a `SlideDeck` for Slides documents; the portal gets the setting, a slide count, a slides preview and "N slides" on sign-offs.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Postgres; React + TypeScript (Vite) for `learn/web` and `portal`; pytest, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-05-learning-slides-design.md`

## Global Constraints

- American English in all copy, comments and docs.
- Existing documents stay Document style: column default `document`.
- Every new UI follows light/dark theme; no default browser scrollbars; every keyboard shortcut also has a visible button.
- Learn UI copy lives in `learn/web/src/i18n/en.ts`; `he.ts`, `ja.ts`, `ko.ts` are typed `Dictionary` (every key required), so every new key gets an entry in all four.
- Learn imports from the portal only through the `@portal/...` allowlist test (`portalImports`); don't add portal imports.
- Migration number 0121 (`down_revision = "0120"`); renumber at merge if 0121 is taken.
- API tests run with an own DB: `SS_TEST_DB=serversherpa_test_slides`. Don't commit `api/src/serversherpa/_dev_reload.py`.
- `reading_style` values: `"document"` | `"slides"`. New error codes: 422 `slides_required` (sign), 422 `slide_not_reached`, 422 `slide_out_of_range`, 409 `version_changed` and 409 `not_slides` (progress).

## Review Focus

1. A page with no `<h2>` in Slides style → exactly one slide; Next disabled, signing allowed once it is shown (slide 0 reached on open). Test in Task 2 and Task 4.
2. An `<h2>` nested inside another element (callout, table cell) must not start a slide; only top-level ones do. Test in Task 2.
3. A new version published while a worker is mid-deck → progress starts over for the new version (not carried over with a different slide count). Test in Task 3.
4. A worker reading in a language whose translation has a different heading count → the sign gate counts the slides of the language the progress was recorded in. Test in Task 3.
5. Switching a document from Slides back to Document → signing no longer checks slides and `require_scroll` works as before. Test in Task 3.

---

### Task 1: Reading style setting (DB, model, schemas, seed)

**Files:**
- Create: `api/migrations/versions/0121_learning_slides.py`
- Modify: `api/src/serversherpa/learning/models.py` (`LearningDocument`, `LearningAssignment`, `LearningSignoff`)
- Modify: `api/src/serversherpa/learning/schemas.py` (`DocumentSettings`, `DocumentPatchIn`, `DocumentOut`, `_NOT_NULL`)
- Modify: `api/src/serversherpa/api/routes/learning/library.py` (`_document_out`)
- Modify: `api/src/serversherpa/learning/seed_content.py` (Dress code settings)
- Test: `api/tests/test_learning_library.py`, `api/tests/test_learning_seed.py`

**Interfaces:**
- Produces: `LearningDocument.reading_style: str` (server default `'document'`, check constraint `reading_style IN ('document','slides')`); `LearningAssignment.slide_reached: int | None`, `.slide_version_id: uuid | None` (FK `learning_document_versions.id` ON DELETE SET NULL), `.slide_language: str | None`; `LearningSignoff.slides_viewed: int | None`.
- Produces: `schemas.ReadingStyle = Literal["document", "slides"]`; `DocumentSettings.reading_style: ReadingStyle = "document"`; `DocumentPatchIn.reading_style: ReadingStyle | None`; `DocumentOut.reading_style: str`, `DocumentOut.slide_count: int | None`, `DocumentOut.current_slides: list[str] | None`.
- `slide_count` / `current_slides` are filled in Task 2 (`slides.split_slides`); in this task set both to `None`.

- [ ] **Step 1: Write the failing tests**

In `test_learning_library.py`:
```python
async def test_reading_style_defaults_to_document_and_patches(client, db, seeded_user):
    # create a document as the existing create tests do; GET it
    assert body["reading_style"] == "document"
    r = await client.patch(f"/learning/documents/{doc_id}", headers=hdrs,
                           json={"reading_style": "slides"})
    assert r.status_code == 200 and r.json()["reading_style"] == "slides"
    # audit row learning_document_update has {"reading_style": ...} in changes
    assert (await client.patch(..., json={"reading_style": "deck"})).status_code == 422
    assert (await client.patch(..., json={"reading_style": None})).status_code == 422
```
In `test_learning_seed.py`, in `test_seed_creates_space_pages_documents_packets_rule` add to the Dress code assertions: `assert dress.reading_style == "slides"`, and for every other seeded title `assert documents[title].reading_style == "document"`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_slides .venv/bin/pytest tests/test_learning_library.py tests/test_learning_seed.py -q -k "reading_style or seed_creates"`
Expected: FAIL (`reading_style` missing).

- [ ] **Step 3: Migration 0121 and model columns**

Migration docstring in the house style (what it adds, what downgrade drops, `Design: docs/superpowers/specs/2026-11-05-learning-slides-design.md`). Upgrade adds the four assignment/document/signoff columns above plus the check constraint; downgrade drops them.

- [ ] **Step 4: Schemas and `_document_out`**

Add `reading_style` to `_NOT_NULL`, `DocumentSettings`, `DocumentPatchIn`, `DocumentOut` (`SETTING_FIELDS` picks it up). `DocumentOut` gains `slide_count: int | None = None` and `current_slides: list[str] | None = None`.

- [ ] **Step 5: Seed**

Dress code's settings dict gains `"reading_style": "slides"`.

- [ ] **Step 6: Run the tests**

Run: `cd api && SS_TEST_DB=serversherpa_test_slides .venv/bin/pytest tests/test_learning_library.py tests/test_learning_seed.py tests/test_learning_migration.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0121_learning_slides.py api/src/serversherpa/learning/models.py api/src/serversherpa/learning/schemas.py api/src/serversherpa/api/routes/learning/library.py api/src/serversherpa/learning/seed_content.py api/tests/test_learning_library.py api/tests/test_learning_seed.py
git commit -m "feat(learning): reading style setting (document | slides)"
```

---

### Task 2: Splitting into slides and the worker read

**Files:**
- Create: `api/src/serversherpa/learning/slides.py`
- Modify: `api/src/serversherpa/learning/worker.py` (`read`)
- Modify: `api/src/serversherpa/learning/schemas.py` (`AssignmentReadOut`)
- Modify: `api/src/serversherpa/api/routes/learning/library.py` (`_document_out`: fill `slide_count`, `current_slides`)
- Test: `api/tests/test_learning_slides.py` (new), `api/tests/test_learn_training.py`, `api/tests/test_learning_library.py`

**Interfaces:**
- Consumes: Task 1 columns and `DocumentOut` fields.
- Produces: `slides.split_slides(html: str) -> list[str]` — always at least one item; `slides.slide_count(html: str) -> int`; `worker.served_html(db, version, lang) -> tuple[str, str]` returning `(content_html_without_presign, language_served)` — the translation's `content_html` when a published translation exists for `lang`, else the version's, with `ENGLISH` as the language. `worker.effective_reached(assignment, version_id, language) -> int | None` — `assignment.slide_reached` when `slide_version_id == version_id and slide_language == language`, else `None`.
- `AssignmentReadOut` gains `reading_style: str`, `slides: list[str] | None` (presigned HTML per slide, only in Slides style), `slide_count: int | None`, `slide_reached: int | None`.

Split rule: walk the HTML with `html.parser.HTMLParser`, tracking element depth (void elements don't nest); every `<h2>` start tag at depth 0 starts a new slide; content before the first top-level `<h2>` is the opening slide and is dropped when it is only whitespace; no top-level `<h2>` → `[html]`; empty html → `[""]`. Slides are exact substrings of the input (no re-serialization), so presigned image tags survive.

- [ ] **Step 1: Write the failing tests** (`test_learning_slides.py`, plain functions)

```python
def test_split_at_top_level_h2():
    html = "<p>Intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>"
    assert split_slides(html) == ["<p>Intro</p>", "<h2>A</h2><p>a</p>", "<h2>B</h2><p>b</p>"]

def test_no_intro_when_page_starts_with_h2():
    assert split_slides("<h2>A</h2><p>a</p><h2>B</h2>") == ["<h2>A</h2><p>a</p>", "<h2>B</h2>"]
    assert split_slides("  \n<h2>A</h2>") == ["<h2>A</h2>"]

def test_no_h2_is_one_slide():
    assert split_slides("<p>x</p><h3>y</h3>") == ["<p>x</p><h3>y</h3>"]
    assert split_slides("") == [""]

def test_nested_h2_does_not_split():
    html = '<div data-callout="info"><h2>In a callout</h2></div><h2>A</h2><img src="x"><p>a</p>'
    assert split_slides(html) == ['<div data-callout="info"><h2>In a callout</h2></div>',
                                  '<h2>A</h2><img src="x"><p>a</p>']

def test_dress_code_html_is_four_slides():
    # the stored Dress code v2 HTML shape: intro + figure + ul, then three h2 sections
    assert slide_count(DRESS_HTML) == 4
```
In `test_learn_training.py` (helper: set the current version's `content_html` directly):
```python
async def test_read_slides_document_returns_slides(client, db, seeded_user):
    doc = await _plain_doc(db, reading_style="slides")
    # version.content_html = "<p>Intro</p><h2>A</h2><p>a</p>"
    body = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert body["reading_style"] == "slides"
    assert body["slides"] == ["<p>Intro</p>", "<h2>A</h2><p>a</p>"]
    assert body["slide_count"] == 2 and body["slide_reached"] is None

async def test_read_document_style_has_no_slides(client, db, seeded_user):
    assert body["reading_style"] == "document" and body["slides"] is None
    assert body["slide_count"] is None
```
In `test_learning_library.py`: a Slides document's GET has `slide_count == 2` and `current_slides` of length 2; a Document one has both `None`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_slides .venv/bin/pytest tests/test_learning_slides.py tests/test_learn_training.py tests/test_learning_library.py -q -k "slide"`
Expected: FAIL (module/fields missing).

- [ ] **Step 3: Implement `slides.py`** with the split rule above.

- [ ] **Step 4: `worker.read`** — add `served_html` and `effective_reached`; in Slides style split the presigned HTML that `read` already builds into `slides` and report `slide_count` / `slide_reached` (effective, for the served version and language). Document style: `slides`, `slide_count`, `slide_reached` are `None`. `_document_out` fills `slide_count` / `current_slides` from `current_html` in Slides style.

- [ ] **Step 5: Run the tests** (same command) — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/learning/slides.py api/src/serversherpa/learning/worker.py api/src/serversherpa/learning/schemas.py api/src/serversherpa/api/routes/learning/library.py api/tests/test_learning_slides.py api/tests/test_learn_training.py api/tests/test_learning_library.py
git commit -m "feat(learning): split Slides documents at top-level h2 for readers and managers"
```

---

### Task 3: Slide progress, the sign gate and the sign-off record

**Files:**
- Modify: `api/src/serversherpa/learning/worker.py` (new `reach_slide`, `sign`)
- Modify: `api/src/serversherpa/api/routes/learn/training.py` (new route)
- Modify: `api/src/serversherpa/learning/schemas.py` (`SlideReachIn`, `SlideReachOut`, sign-off out schemas)
- Modify: `api/src/serversherpa/learning/library.py` (`list_signoffs`), `api/src/serversherpa/learning/stats.py` (person sign-off record, ~line 432)
- Test: `api/tests/test_learn_training.py`, `api/tests/test_learning_library.py`, `api/tests/test_learning_stats.py`

**Interfaces:**
- Consumes: `slides.slide_count`, `worker.served_html`, `worker.effective_reached` (Task 2).
- Produces: `POST /learn/assignments/{assignment_id}/slides/{n}` (`n: int`, path, `ge=0`), body `SlideReachIn {version_no: int, language: str (LANG_PATTERN)}` → `SlideReachOut {slide_reached: int, slide_count: int}`. Service: `worker.reach_slide(db, person_id, assignment_id, n: int, *, version_no: int, language: str) -> dict`.
- Produces: sign-off rows in `GET /learning/documents/{id}/signoffs` and the person's learning history carry `slides_viewed: int | None`.

Rules for `reach_slide` (refusals in this order): 404 not own; 409 `already_signed`; `require_unlocked`; 409 `version_changed` when `version_no` isn't the shown version's; 409 `not_slides` when the document isn't Slides style; then count = `slide_count(served_html(version, language)[0])`, language = the served language; `n >= count` → 422 `slide_out_of_range`; `n > (effective_reached ?? -1) + 1` → 422 `slide_not_reached`; else store `slide_reached = max(effective or -1, n)`, `slide_version_id`, `slide_language`, and set `opened_at`/status like `read` does if still unset. Idempotent for already-reached `n`.

Sign: in Slides style skip the `scroll_required` check; in its place, `effective_reached(assignment, version.id, served_language) != count - 1` → 422 `slides_required` (served language = `language` if a published translation exists, else English — the rule the sign-off's language already uses). The sign-off stores `slides_viewed = count` (Document style: `None`). Update `sign`'s docstring refusal list.

- [ ] **Step 1: Write the failing tests** (`test_learn_training.py`; doc content `<p>Intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>`, 3 slides)

```python
async def test_slides_reach_one_at_a_time(client, db, seeded_user):
    url = f"/learn/assignments/{row.id}/slides"
    body = {"version_no": v, "language": "en"}
    assert (await client.post(f"{url}/1", headers=hdrs, json=body)).json()["detail"]["code"] == "slide_not_reached"
    assert (await client.post(f"{url}/0", headers=hdrs, json=body)).json() == {"slide_reached": 0, "slide_count": 3}
    assert (await client.post(f"{url}/1", headers=hdrs, json=body)).json()["slide_reached"] == 1
    assert (await client.post(f"{url}/0", headers=hdrs, json=body)).json()["slide_reached"] == 1  # going back keeps the furthest
    assert (await client.post(f"{url}/3", headers=hdrs, json=body)).json()["detail"]["code"] == "slide_out_of_range"
    # GET now reports slide_reached == 1

async def test_sign_slides_requires_last_slide(client, db, seeded_user):
    # reach 0 and 1 of 3, opened_ago=600
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    # reach 2, sign again (scrolled_to_end False still) → 200; signoff.slides_viewed == 3

async def test_slide_progress_restarts_on_new_version(client, db, seeded_user):
    # reach 0..2, publish a new version (as test_sign_refuses_a_version_published_after_it_was_shown does)
    # GET → slide_reached is None; sign → 422 slides_required; reach with the old version_no → 409 version_changed

async def test_slide_progress_is_per_language(client, db, seeded_user):
    # published 'ja' translation with 2 slides (switch ja on via offer_languages as the translation tests do)
    # reach 0..2 in en; GET ?lang=ja → slide_reached None, slide_count 2; sign with language "ja" → 422 slides_required
    # reach 0..1 in ja; sign with language "ja" → 200, slides_viewed == 2

async def test_document_style_ignores_slides(client, db, seeded_user):
    # reading_style "slides" → switch to "document" with require_scroll True: sign without scrolled_to_end → 422 scroll_required
    # with scrolled_to_end → 200, slides_viewed None; POST .../slides/0 → 409 not_slides

async def test_one_slide_document_signs_after_slide_zero(client, db, seeded_user):
    # content without h2: reach 0 → {"slide_reached": 0, "slide_count": 1}; sign → 200
```
In `test_learning_library.py`: the signoffs list row has `slides_viewed`. In `test_learning_stats.py`: the person history record has `slides_viewed`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_slides .venv/bin/pytest tests/test_learn_training.py tests/test_learning_library.py tests/test_learning_stats.py -q -k "slide"`
Expected: FAIL.

- [ ] **Step 3: Implement `reach_slide`, the route, the sign gate and `slides_viewed` in both lists.** Route commits like the other learn routes; takes the assignment `for_update=True`.

- [ ] **Step 4: Run all learning API tests**

Run: `cd api && SS_TEST_DB=serversherpa_test_slides .venv/bin/pytest tests/test_learn_*.py tests/test_learning_*.py -q`
Expected: PASS (no regressions in `test_sign_validations`).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/learning/worker.py api/src/serversherpa/api/routes/learn/training.py api/src/serversherpa/learning/schemas.py api/src/serversherpa/learning/library.py api/src/serversherpa/learning/stats.py api/tests/test_learn_training.py api/tests/test_learning_library.py api/tests/test_learning_stats.py
git commit -m "feat(learning): slide progress, slides_required sign gate, slides viewed on sign-offs"
```

---

### Task 4: Learn reader in Slides style

**Files:**
- Create: `learn/web/src/components/SlideDeck.tsx`, `learn/web/src/components/SlideDeck.test.tsx`
- Modify: `learn/web/src/lib/training.ts` (`AssignmentRead`, new `reachSlide`)
- Modify: `learn/web/src/pages/Reader.tsx`, `learn/web/src/pages/Reader.test.tsx`
- Modify: `learn/web/src/i18n/en.ts`, `he.ts`, `ja.ts`, `ko.ts`
- Modify: `learn/web/src/styles/learn.css`

**Interfaces:**
- Consumes: `GET /learn/assignments/{id}` fields `reading_style`, `slides`, `slide_count`, `slide_reached`; `POST /learn/assignments/{id}/slides/{n}` (Task 3).
- Produces: `AssignmentRead` gains `reading_style: 'document' | 'slides'; slides: string[] | null; slide_count: number | null; slide_reached: number | null`. `reachSlide(id: string, n: number, body: { version_no: number; language: string }) => Promise<{ slide_reached: number; slide_count: number }>`.
- `SlideDeck` props: `{ slides: string[]; reached: number | null; review: boolean; lang: string; dir: 'ltr' | 'rtl'; onReach: (n: number) => Promise<number | null> }` — `onReach` returns the server's `slide_reached` (or `null` when the call failed) so the deck shows what the server recorded.

Behavior (spec "Reader (learn app), Slides style"):
- Opens at `reached ?? 0`; on mount, if `reached === null` and not `review`, calls `onReach(0)`.
- Row: Back, numbered dot buttons, `"{k} / {n}"`, Next (`learn-cta`-styled primary). Dots `> reached` disabled with `title` = `t('slides.notReached')`. In review, all dots enabled and nothing is reported.
- Next on slide `i` moves to `i + 1` and calls `onReach(i + 1)` when `i + 1 > reached`; Next disabled on the last slide. ArrowLeft/ArrowRight on the deck region do the same as Back/Next.
- When `onReach` returns `null` (offline, 4xx), stay on the current slide and show `t('slides.saveFailed')` in the deck's status line.
- Status line (not in review): `t('slides.progress', { seen, n })` until every slide reached, then nothing (the Reader's existing reading-time/ready line takes over).

Reader changes (Slides style only; Document style untouched):
- Render `SlideDeck` in place of the `learn-doc` scroll box; `scrolled` is replaced by `allSeen = reachedNow === slide_count - 1` (reachedNow = latest from the deck).
- Sign stays always tappable (existing pattern); new first-unmet reason after the signature checks: `!allSeen → { key: 'sign.slidesRequired' }` (in place of the scroll reason). Server code `slides_required` maps to the same key.
- Quiz: "Take the quiz" shows only when `allSeen`; before that the slot shows the `slides.progress` line instead.
- `alreadyRead` (quiz passed) does not bypass `allSeen` in Slides style.
- `scrolled_to_end` sent as `allSeen`.

New keys (en; translate for he/ja/ko): `'slides.region': 'Slides'`, `'slides.back': 'Back'`, `'slides.next': 'Next'`, `'slides.count': '{k} / {n}'`, `'slides.goTo': 'Go to slide {k}'`, `'slides.notReached': 'Not reached yet'`, `'slides.progress': 'Go through every slide to sign. ({seen} of {n} seen)'`, `'slides.saveFailed': "Couldn't save your place. Check your connection and try again."`, `'sign.slidesRequired': 'Go through every slide first.'`.

- [ ] **Step 1: Write the failing tests** (`SlideDeck.test.tsx`)

```tsx
it('moves forward one unseen slide at a time and reports each new one', ...)
  // slides ['<p>one</p>','<p>two</p>','<p>three</p>'], reached null → onReach(0) on mount;
  // dot 3 disabled; click Next → shows "two", onReach(1); dot 2 enabled, dot 3 still disabled
it('opens at the furthest slide reached and allows jumping back', ...)
  // reached 2 → shows "three", "3 / 3", Next disabled; click dot 1 → "one", onReach not called
it('stays put and says so when saving the place fails', ...)
  // onReach resolves null on Next → still "one", text "Couldn't save your place…"
it('review mode: every dot enabled, nothing reported', ...)
it('arrow keys move like Back and Next', ...)
```
`Reader.test.tsx`:
```tsx
it('Slides: sign says go through every slide first until the last slide', ...)
it('Slides: quiz link appears only after the last slide', ...)
it('Slides: slides_required from the server shows the same reason', ...)
it('Document style still uses the scroll box', ...)   // existing tests keep passing
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix learn test -- --run src/components/SlideDeck.test.tsx src/pages/Reader.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** `training.ts` additions, `SlideDeck`, the Reader changes, the i18n keys in all four dictionaries, and CSS (`learn-slides`, `learn-slide`, `learn-slides-row`, `learn-slides-dot` + `.seen`/`.current`; slide images `max-width: 100%`; row wraps on narrow phones; theme tokens only).

- [ ] **Step 4: Run the learn suite and type check**

Run: `npm --prefix learn test -- --run && npm --prefix learn run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add learn/web/src
git commit -m "feat(learn): Slides reader — one slide at a time, forward to the next unseen slide"
```

---

### Task 5: Portal setting, preview and sign-off display

**Files:**
- Modify: `portal/src/lib/learning.ts` (`DocumentSettings`, `LearningDocument`, sign-off row types)
- Modify: `portal/src/components/learning/DocumentRulesPanel.tsx` (+ its test)
- Create: `portal/src/components/learning/SlidesPreview.tsx`, `SlidesPreview.test.tsx`
- Modify: `portal/src/pages/learning/LearningDocument.tsx` (+ test)
- Modify: `portal/src/components/learning/SignoffsPanel.tsx`, `LearningHistoryPanel.tsx` (+ tests)

**Interfaces:**
- Consumes: `DocumentOut.reading_style`, `slide_count`, `current_slides` (Tasks 1–2); `slides_viewed` on sign-off rows (Task 3).
- Produces: `type ReadingStyle = 'document' | 'slides'`; `SlidesPreview({ slides }: { slides: string[] })` — Back/Next, numbered dots, all enabled, `"{k} / {n}"`.

Behavior:
- Rules panel, under "How they sign": a **Reading style** row using the existing `segmented` control (`Document`, `Slides`), saving `{ reading_style }` through `apply`. View-only managers see the label as `lrn-val`.
- In Slides style the "Must scroll to the end" toggle row is replaced by the line `Readers go through every slide before they can sign.` plus `{n} slides` (or `1 slide`) from `doc.slide_count`; when `slide_count === 1`: `This page has no ## headings, so it shows as one slide. Each ## heading starts a new slide.`
- The read-only `kv` list gains `Reading style` (`Document` / `Slides`) and drops the scroll row in Slides style.
- `LearningDocument.tsx` content preview: `doc.current_slides ? <SlidesPreview slides={doc.current_slides} /> : <existing lrn-prose div>`.
- Sign-off read cells: `readTime(s.read_seconds)` + ` · {n} slides` when `slides_viewed` is a number.

- [ ] **Step 1: Write the failing tests**

```tsx
// DocumentRulesPanel.test.tsx
it('saves reading style from the segmented control', ...)       // click Slides → onSave({ reading_style: 'slides' })
it('Slides replaces the scroll toggle with the every-slide line and slide count', ...)  // slide_count 4 → "4 slides", no "Must scroll to the end"
it('one-slide note when the page has no ## headings', ...)
it('view-only shows Reading style in the summary', ...)
// SlidesPreview.test.tsx
it('steps through slides with Back/Next and dots', ...)
// SignoffsPanel / LearningHistoryPanel tests
it('shows slides viewed next to the reading time', ...)          // "1 min · 4 slides"
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix portal test -- --run src/components/learning src/pages/learning`
Expected: FAIL.

- [ ] **Step 3: Implement** the types, panel row, preview component, page switch and sign-off cells (portal tokens, light/dark).

- [ ] **Step 4: Run the portal learning tests and build**

Run: `npm --prefix portal test -- --run src/components/learning src/pages/learning && npm --prefix portal run build`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Slides reading style setting, slides preview, slides viewed on sign-offs"
```

---

### Task 6: Live check on the dev stack

**Files:** none (verification only).

- [ ] **Step 1:** Upgrade the dev DB (`api/.venv/bin/alembic upgrade head` from `api/`) after confirming database testing mode is off (Developer › Database › Testing, or the sign-in banner).
- [ ] **Step 2:** In the portal, set Learning › Library › Dress code › Reading style to Slides; confirm "4 slides" and the slides preview.
- [ ] **Step 3:** In the learn app (:5179) as a learner with an open Dress code assignment: Next walks 1→4, dots beyond the furthest are disabled, Sign before the last slide says "Go through every slide first.", after slide 4 and 60 s it signs; the portal sign-offs tab shows "· 4 slides". Reload mid-deck resumes at the furthest slide. Check light and dark and a phone width.
- [ ] **Step 4:** Report with screenshots; no commit.
