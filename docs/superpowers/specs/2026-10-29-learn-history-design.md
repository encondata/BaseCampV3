# Learn site: completed training history and review

## Why

A worker who signs in to the learn site (with an account or a code) and has
nothing open sees only "You're all caught up." Their finished sign-offs
vanish: a move's block drops off when the move ends, the general set drops
off once it is all signed, and a sign-off on an older version is hidden once
a newer version is assigned. People come back for two reasons: to check
whether anything is due, and to look back at what they already learned.
Jimmy asked for a history of completed sign-offs and a way to reopen and
review any document they signed.

Everything needed is already stored: each signed assignment keeps its
sign-off, which names the exact version and language signed, and the
reader already re-reads a signed assignment at the version it was signed at.

## Goals

- A list of everything the person has signed, newest first, that never
  disappears when a move ends or a new version arrives.
- Any row reopens the document, read-only, at the version they signed.
- The caught-up screen shows that list instead of only the one line.
- Signed rows on "My training" also open for review.

## Non-goals

- No certificate download, search, filters or export on the learn site
  (the portal already has the certificate).
- No change to what "My training" counts, locks or orders.
- No change to how signing works.

## Behavior

**API.** `GET /learn/history` (caller's own data, same auth as
`/learn/training`) returns one row per signed assignment of the caller
(status `signed`; cancelled and open ones excluded), newest `signed_at`
first: `assignment_id`, `title` and `version_no` of the version signed,
`initiative` (`{id, name}` or null for general training), `signed_at`,
`language` signed in, and `newer_version` (the document's current published
version is newer than the one signed). `GET /learn/assignments/{id}` adds
`signed_at` (null unless signed).

**Training page.** Signed rows link to the reader. With no groups: "You're
all caught up." then a "Completed training" heading and the history list.
With groups: below them, a "Completed training (N)" link to `/history`
when N > 0.

**History page** `/history` (needs a learner, like `/training`): back link
to `/training`, "Completed training" heading, the list, and "Nothing signed
yet." when empty. Each row: check icon, title, "Signed {date} · v{n}", the
scope (move name or "General training"), plus "Updated since" when
`newer_version`.

**Reader, review mode** (the assignment is signed): no agreement, signature,
quiz or reading gates; a banner "You signed this on {date} (version {n})."
and a "Back" button. Back (and the header arrow) returns to where the
reader was opened from: `/history` when opened from there, else
`/training`.

## Constraints

- American English; ja/ko/he get convenience translations of every new key
  (their dictionaries are type-checked against English).
- Reuse the learn site's existing row, banner, eyebrow and CTA styles.
- Every route acts on the caller's own assignments only.

## Calls made without asking (Claude's)

- History shows to code sign-ins too: it is the same person's own record.
- Review opens the signed version, not the current one; "Updated since"
  flags that a newer version exists.
- History lives on its own page plus inline on the caught-up screen, so the
  training list is not duplicated on one screen.
