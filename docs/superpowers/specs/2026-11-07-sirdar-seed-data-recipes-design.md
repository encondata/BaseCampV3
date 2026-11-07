# Sirdar: Seed Data recipes

Date: 2026-11-07. Branch: `sirdar`. Status: design approved for planning only when Jimmy says so; he asked not to start coding yet.

## Why

Sirdar can start a new environment empty (with a first super admin) or from a whole snapshot. Jimmy wants something in between: environments that carry only part of the data. They are for:

- demos;
- training;
- testing;
- a customer who needs their own instance that shares no data with anyone else.

His words (2026-11-07): "I know we already have the deploy from snapshot but I want to break that down to also be able to deploy only subsets."

Examples he gave:
- a basic set with users, workers, sites and partners but no asset data;
- a minimum set with only users, no workers;
- wiki articles and avatar images from Spaces.

## Goal

A **recipe** is a named, saved selection of database rows and Spaces files. The selection is made by hand from a snapshot. A new environment can be deployed from a recipe applied to a snapshot. Applying the same recipe to a newer snapshot gives fresh data.

## Decided with Jimmy

- **It lives in Sirdar, not the portal.** There is a new nav item, **Seed Data**, with two pages: **DB** and **Spaces**.
- **Sirdar knows nothing about clients or partners.** A recipe is only the rows and files Jimmy ticked, saved by name. Selecting and filtering, including picking one client's records, is his job.
- **Rows are picked by ticking them in a table view.** Every table view has:
  - **Check all** and **Deselect all**;
  - **shift-click**: click one row, shift-click another, and every row between takes the second row's state.
- **A recipe keeps exactly the rows that were ticked**, identified by primary key. Applied to a newer snapshot, it takes the same records. A ticked record that no longer exists is skipped and listed. Records added since are not included (ticks are not rules).
- **Needed rows are ticked automatically.** Ticking a row also ticks every row it can't exist without: the rows its foreign keys point to, followed all the way up. Sirdar shows what it added and why, for example "partners: Partner A, needed by worker_profiles row for Person D".
- **Files follow the records, and can be ticked by hand.** A file is kept when a kept row references it: an avatar of a kept person, an image on a kept wiki page. The Spaces page lists the snapshot's files with a "Kept because" column and lets Jimmy tick or untick any file. Check all, Deselect all and shift-click work as on the DB page.
- **Deploying:** the Data step of a new environment gets a third choice, **From a recipe**, beside Start empty and From a snapshot.
  - Jimmy picks the recipe.
  - He then chooses its snapshot exactly as "From a snapshot" does today: pick an existing snapshot, or take a new one.
- **Passwords:**
  - **By default**, copied users keep their passwords and 2FA, as a snapshot restore does today (the snapshot's pepper and TOTP key go with it).
  - **Option "Make everyone reset their password"** (name to settle in the UI): every copied user gets a random password nobody knows, and their 2FA is cleared. Each user then needs a reset link.
- **First super admin:** a recipe deploy also offers the first super admin fields, as Start empty does (name, email, password or Generate & invite). Without it, a reset-everyone deploy would leave nobody able to sign in.

The mockup Jimmy reviewed is at `.superpowers/brainstorm/62208-1794078203/content/seed-data.html`.

## How it works (my calls, marked; Jimmy can overrule)

- **Browsing a snapshot** *(my call)*: Sirdar restores the snapshot's `db.dump` into a scratch database of its own and reads the tables from there. It never touches a live environment, and it works for a snapshot of an environment that's down or deleted. The scratch database is dropped when Sirdar no longer needs it. The builder decides the lifetime, for example the browsing session or an idle timeout.
- **Needed rows** come from the scratch database's own foreign-key constraints (required links only; optional links to rows that aren't kept come over empty, see below). Sirdar needs no ServerSherpa-specific knowledge for them. They go one way only, to the rows a ticked row points at, never to rows that point at it. Ticking a person doesn't tick their user account; Jimmy ticks `user_accounts` himself.
- **Files referenced by rows** *(my call)*: a file is "referenced" when a kept row holds its storage key. That is the same idea `scripts/make-sql-seed-snapshot.sh` already uses: find every storage key the data references and bundle only those objects. The "Kept because" text names the table and row that reference the file.
- **What a recipe stores** *(my call)*:
  - its name;
  - per table, the primary keys ticked by hand. Composite keys are supported;
  - per file, a manual tick or untick that overrides "follows the records".

  Needed rows and record-following files are worked out again each time the recipe is applied. They aren't stored, so a newer snapshot's links are the ones used.
- **Applying a recipe** *(my call)*: at deploy time, Sirdar builds a **subset snapshot** from the chosen snapshot:
  - the database with only the kept rows;
  - `objects.tar` with only the kept files;
  - the same `keys.enc`;
  - its own manifest.

  The deploy then restores it through the existing "From a snapshot" path. Migrations run on deploy as they do today, so a subset of an older snapshot comes up on the current release. The subset snapshot is kept and listed like other snapshots. It's marked with the recipe and source snapshot it came from, so a deploy can be explained and retried.
- **Password reset** happens while the subset is built, so the reset environment never receives the old password hashes or 2FA secrets.
  - Every copied user's password hash is replaced with one for a random password.
  - Their 2FA is cleared: TOTP secret, backup codes and trusted browsers.
  - Sessions and reset tokens are left out: `auth_sessions`, `password_reset_tokens`, `trusted_devices`, `totp_backup_codes`.
  - The builder lists exactly which columns and tables that means from the ServerSherpa schema, and the design's tests pin them.
- **Where the scratch database runs** *(my call)*: in a Postgres container of its own beside Sirdar, at ServerSherpa's major version (16). It's separate from Sirdar's own database, so a large restore can't crowd Sirdar's metadata, and `pg_restore` matches the dumps. The Sirdar image gains the Postgres 16 client tools (`pg_restore`, `pg_dump`) if it lacks them. The installer and compose file add the container and its volume. One scratch database per snapshot being browsed, shared by everyone browsing it, is dropped after it has sat idle. A deploy that builds a subset uses a scratch database of its own.
- **How the subset is built** *(my call)*:
  - restore the snapshot's schema into a fresh database;
  - copy in only the kept rows, with constraint checks deferred during the load;
  - check every foreign key once the load is done;
  - dump the result.

  Circular and self-referencing keys (a wiki page's parent page) load in any order this way. A row whose parent isn't kept fails the build and is named, per the anti-goal.
- **Which columns hold file keys** *(my call)*: the same rule the seed script uses, by column name: `storage_key`, `preview_key`, `avatar_key`, `logo_key`, `file_key`, or a name ending in `_storage_key`. That's a naming rule, not ServerSherpa knowledge. Keys inside free text (wiki markdown, JSON) aren't followed; tick those files by hand on the Spaces page.
- **Password reset is the one ServerSherpa-specific part** *(my call)*: the tables and columns it changes live in one small, documented list in Sirdar's code. If the snapshot doesn't have one of them (a much older or newer schema), the build fails and names it, rather than leaving a secret in place. The first super admin is created the same way Start empty creates it today (the deploy's first-admin step), not inserted into the subset.
- **A recipe against a different schema** *(my call)*: a table or column the recipe names that the snapshot doesn't have is skipped and listed with the missing records. Primary keys are stored with their column types.
- **Before a recipe deploy starts** *(my call)*, the Data step shows how many of the recipe's ticked records the chosen snapshot has and how many are missing. There's no threshold that blocks the deploy; the numbers are there to read.
- **Access** *(my call)*: a new Sirdar access resource `seed_data`, granted to the same roles as `deploy` by default. It governs both the nav item and its API. Deploying from a recipe also needs `deploy`, as today.

## Decided after the builder check (Jimmy, 2026-11-07: "go with your recommendations on all three")

- **Tables with nothing ticked come over empty.** Any table can be marked **All rows**, a table-level switch beside Check all. An All rows table takes every row of whichever snapshot the recipe is applied to, including rows added since. Lookup and settings tables the app needs (roles, permissions, system settings, status values and the like) are marked All rows in the recipe by hand. The migration version table always comes whole, since it's Sirdar's restore path's business, not data.
- **Big tables:** the table view pages, sorts, and filters by column value. With a filter on, **Check all** and **Deselect all** act on every row matching the filter, across all pages. With no filter, they act on the whole table. Shift-click works on the rows as shown.
- **Optional links to rows that aren't kept come over empty.** Example: a kept site's "created by" points at a person not in the recipe; in the new environment that link is blank. Required links (NOT NULL foreign keys; a generated column, such as ServerSherpa's constant status_record_type, counts as set, since it can't be blanked) still auto-tick the row they point to, as decided above. A required link into a table marked empty still pulls in just the row it needs. Generated columns are never copied: the new database computes them.

## Non-goals

- Editing record contents in Sirdar. Clean demo data comes from curating an environment through the portal and snapshotting it.
- Rules or filters that pick records by value ("all sites of partner X").
- Scrubbing or replacing personal data such as names and emails.
- Anything in the portal.
- Sharing recipes between Sirdar installs.

## Anti-goals

- Sirdar reading from or writing to a live environment's database to build a recipe.
- A subset that breaks foreign keys. Every kept row's parents are kept, or the build fails and says which.
- Reset-everyone leaking the old password hashes or 2FA secrets into the new environment.
- Client or partner concepts in Sirdar's code or UI.

## Testing (outline)

- **Ticking:** Check all, Deselect all (whole table, and every row matching a filter across pages) and shift-click range select (ticking and unticking). All rows tables take rows added since.
- **Optional links:** a kept row's optional link to a row that isn't kept is empty in the subset; a required link pulls its row in.
- **Needed rows:** they follow foreign keys up multiple levels, including composite keys and self-references (a wiki page's parent page), and the "added because" list matches.
- **Files:** they follow kept rows. A manual untick beats following, and a manual tick keeps an unreferenced file.
- **Applying a recipe to a newer snapshot:** the same keys are kept, missing ones are listed, and new rows are not included.
- **The subset snapshot:** it restores through the existing path, migrations run, and its foreign keys are all satisfied.
- **Reset-everyone:** no copied user's old password works, no 2FA secret, backup code, session or trusted browser survives, and the first super admin can sign in.
- **Access:** without `seed_data` the nav item and API are refused.
- **Live:** build a recipe from a demo snapshot and deploy it to a new environment, in both password modes.
