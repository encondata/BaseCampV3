# Worker Full-Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated `/people/workers/:personId` full-detail page — profile-hero with photo (like `/me`), worker profile editing, person details editing, certifications, level card, initiative work history, import provenance, and notes/files.

**Architecture:** New `GET /workers/{person_id}` API endpoint returns a `WorkerDetailOut` (WorkerItem + person extras + initiative history + level definition); `"person"` joins `NOTE_HOSTS` so the shared NotesFilesPanel works. Portal: the worker-specific components already living inside `Workers.tsx` (`ProfileForm`, `CertsPanel`, `LevelBadge`) move verbatim to `components/workers/` so the new `WorkerDetailPage` and the existing list expansion share them. The page's chrome mirrors `/me` (`profile-hero` + `profile-grid` + `panel` from profile.css) with SiteDetail's back-link convention.

**Tech Stack:** FastAPI + SQLAlchemy async (api), React + react-router (portal), existing css systems (profile.css, directory.css, initiatives.css) — no new stylesheets.

## Global Constraints

- **Jimmy's UI rules (binding, from memory `ui-detail-surfaces`):** tabular data gets a REAL aligned table (house class `activity-changes`, one column per field, `—` per empty cell) — never joined strings; forms are label-above-control in a consistent 2-column grid (`pf-form` pattern from Profile.tsx), never a raw floating checkbox; section headings visually distinct from field labels; no duplicate adjacent headings. ALWAYS render and LOOK at the actual screen before calling UI work done.
- The house benchmark for detail pages is the initiative detail page; hero styling comes from `/me` (`profile-hero`, `profile-id`, `profile-meta`, `pm-role`, `pm-sub`, `profile-grid`, `panel`, `panel-head`, `panel-body`, `kv`, `pf-form` — all already in `portal/src/styles/profile.css`).
- Back-link + not-found + loading conventions copied from `SiteDetail.tsx` (`idet-back` link, `dir-empty` not-found, `page-hint` loading).
- API label conventions: worker status via `status_labels(db, "worker")` + `status_fields(...)`; level via `level_colors(db)` + `level_fields(...)`; initiative vocab via `StatusValue` record_types `initiative`, `initiative_type`, `initiative_work_type` with fallback color `"#51606f"` (mirrors `initiatives.py::_people_rows`).
- Scope/permission conventions: `workers:view` for the detail GET; `_require_worker` (404/422) then `_check_worker_scope` (404, never 403). Person-fields editing on the page uses a dedicated `PATCH /workers/{person_id}/person` (workers:change), NOT the users-directory `PATCH /users/{person_id}/profile` — that route requires the target to hold a `UserAccount` (404s on the 112 account-less imported workers) and forbids self-targeting (403s when the signed-in admin edits their own row). The workers endpoint reuses `ProfileUpdateIn` and applies the same rank guard as `upsert_profile`'s blacklist check, but only when the target holds an account and isn't the actor themselves.
- Person.notes is exposed as `person_notes` (avoid confusion with the Notes panel's note rows).
- API tests: mirror `api/tests/test_workers.py`'s harness (`client`, `seeded_user`, `db` fixtures; `_headers`; `_mk_worker`). Run from `api/` with `SS_TEST_DB=serversherpa_test_workers ./.venv/bin/python -m pytest <files> -v`, always FOREGROUND with a long timeout.
- Portal checks: from `portal/`, `npm test` and `npm run build`.
- Workers list behavior must be unchanged by the component extraction (same markup, same props) except for one added "Full details" button in the expansion's `detail-actions` (Initiatives.tsx:774 pattern: `btn-ghost` + `navigate(...)`).

---

### Task 1: API — `GET /workers/{person_id}` + person notes host

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (add two models after `WorkerItem`, which ends ~line 528)
- Modify: `api/src/serversherpa/api/routes/workers.py` (new endpoint after `list_workers`; extend imports)
- Modify: `api/src/serversherpa/api/routes/notes.py` (add `"person"` to `NOTE_HOSTS`, line 21-27)
- Test: `api/tests/test_workers_detail_api.py`

**Interfaces:**
- Consumes: existing `_require_worker`, `_check_worker_scope`, `status_labels`, `status_fields`, `level_colors`, `level_fields`, `presign_get`, models `Initiative`, `InitiativePerson`, `Site`, `StatusValue`, `WorkerLevel`.
- Produces: `GET /workers/{person_id}` → `WorkerDetailOut` (shape below) consumed by Task 2's `getWorker`. `POST/GET /notes?entity_type=person&entity_id=...` now authorized against the `workers` resource.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_workers_detail_api.py
"""GET /workers/{person_id} detail payload + person notes host."""

import uuid

from serversherpa.db.models import (
    Initiative, InitiativePerson, Person, WorkerProfile,
)
from tests.test_workers import PW, _headers, _mk_worker  # shared harness


async def test_worker_detail_returns_person_extras(client, seeded_user, db):
    worker = await _mk_worker(db)
    worker.job_title = "Rack tech"
    worker.city = "Las Vegas"
    worker.rfid_tag = "RF-001"
    worker.notes = "V2 rating: 4\nV2 work: Project #3"
    worker.source_ref = "backup_20260825_193157:people/7"
    db.add(WorkerProfile(person_id=worker.id, trade="Hardware", status="active"))
    await db.commit()

    headers = await _headers(client)
    resp = await client.get(f"/workers/{worker.id}", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Wan Worker"
    assert body["trade"] == "Hardware"
    assert body["status"] == "active"
    assert body["job_title"] == "Rack tech"
    assert body["city"] == "Las Vegas"
    assert body["rfid_tag"] == "RF-001"
    assert body["person_notes"].startswith("V2 rating: 4")
    assert body["source_ref"] == "backup_20260825_193157:people/7"
    assert body["badge_uid"]
    assert body["initiatives"] == []
    assert body["level_def"] is None


async def test_worker_detail_includes_initiative_history(client, seeded_user, db):
    worker = await _mk_worker(db)
    init = Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="active")
    db.add(init)
    await db.flush()
    db.add(InitiativePerson(initiative_id=init.id, person_id=worker.id,
                            work_type="project_manager", rating=4))
    await db.commit()

    headers = await _headers(client)
    body = (await client.get(f"/workers/{worker.id}", headers=headers)).json()
    assert len(body["initiatives"]) == 1
    row = body["initiatives"][0]
    assert row["initiative_id"] == str(init.id)
    assert row["initiative_name"] == "NAP11 Hall Migration"
    assert row["rating"] == 4
    assert row["status_label"]          # label resolved (or key fallback)
    assert row["added_at"]


async def test_worker_detail_level_def(client, seeded_user, db):
    worker = await _mk_worker(db)
    db.add(WorkerProfile(person_id=worker.id, level="L3", status="active"))
    await db.commit()
    headers = await _headers(client)
    body = (await client.get(f"/workers/{worker.id}", headers=headers)).json()
    assert body["level"] == "L3"
    assert body["level_def"]["title"] == "Technician"
    assert isinstance(body["level_def"]["expected_skills"], list)


async def test_worker_detail_404s(client, seeded_user, db):
    headers = await _headers(client)
    # unknown id
    resp = await client.get(f"/workers/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    # a person without the worker role is not a worker
    person = Person(first_name="No", last_name="Role")
    db.add(person)
    await db.commit()
    resp = await client.get(f"/workers/{person.id}", headers=headers)
    assert resp.status_code == 422


async def test_person_notes_host(client, seeded_user, db):
    worker = await _mk_worker(db)
    headers = await _headers(client)
    resp = await client.post("/notes", headers=headers, json={
        "entity_type": "person", "entity_id": str(worker.id),
        "body": "met on site"})
    assert resp.status_code == 201
    listing = (await client.get(
        f"/notes?entity_type=person&entity_id={worker.id}",
        headers=headers)).json()
    assert [n["body"] for n in listing] == ["met on site"]
```

NOTE for the implementer: check `test_workers.py`'s `_mk_worker` signature and the exact `/notes` POST/GET shapes against `routes/notes.py` before assuming the field names above (`body`, status codes); adjust the test to the real contract if they differ — the behavior under test (person-hosted notes round-trip) is what matters.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && SS_TEST_DB=serversherpa_test_workers ./.venv/bin/python -m pytest tests/test_workers_detail_api.py -v`
Expected: FAIL — 404s from the missing route / 422 unknown_entity_type from notes.

- [ ] **Step 3: Implement**

`api/src/serversherpa/api/schemas.py` — after `WorkerItem` (uses the existing `WorkerLevelOut` defined nearby; if `WorkerLevelOut` is declared after this point, place these two models after it):

```python
class WorkerInitiativeItem(BaseModel):
    initiative_id: uuid.UUID
    initiative_name: str
    type_label: str | None
    type_color: str | None
    status_label: str
    status_color: str
    work_type_label: str | None
    work_type_color: str | None
    site_worked_name: str | None
    rating: int | None
    added_at: datetime


class WorkerDetailOut(WorkerItem):
    """WorkerItem + the person-record extras and history the full-detail
    page shows. person_notes is Person.notes (the imported V2 leftovers
    live there) — distinct from the /notes entity rows."""

    preferred_name: str | None
    job_title: str | None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    country: str
    badge_uid: uuid.UUID
    rfid_tag: str | None
    person_notes: str | None
    source: str
    source_ref: str | None
    created_at: datetime
    level_def: WorkerLevelOut | None
    initiatives: list[WorkerInitiativeItem]
```

`api/src/serversherpa/api/routes/workers.py` — extend the schema import block with `WorkerDetailOut, WorkerInitiativeItem` and the models import with `Initiative, InitiativePerson, Site`; add after `list_workers`:

```python
_VOCAB_FALLBACK = "#51606f"     # mirrors initiatives.py's unmapped-key color


@router.get("/{person_id}", response_model=WorkerDetailOut)
async def get_worker(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> WorkerDetailOut:
    person = await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)

    profile = await db.get(WorkerProfile, person_id)
    partner = (await db.get(Partner, profile.partner_id)
               if profile and profile.partner_id else None)
    account = await db.get(UserAccount, person_id)
    labels = await status_labels(db, "worker")
    lvl_colors = await level_colors(db)
    level_row = (await db.get(WorkerLevel, profile.level)
                 if profile and profile.level else None)

    today = date.today()
    cert_total, cert_expired = (await db.execute(
        select(func.count(),
               func.count().filter(WorkerCertification.expires_on < today))
        .where(WorkerCertification.person_id == person_id))).one()

    def vocab(record_type: str) -> dict:
        return {}  # placeholder replaced below — see note

    # one query per vocabulary, mirroring initiatives.py::_people_rows
    vocab_rows = await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(
            ["initiative", "initiative_type", "initiative_work_type"])))
    vocabs: dict[str, dict[str, tuple[str, str]]] = {}
    for s in vocab_rows:
        vocabs.setdefault(s.record_type, {})[s.key] = (s.label, s.color)

    memberships = (await db.execute(
        select(InitiativePerson, Initiative, Site.name)
        .join(Initiative, Initiative.id == InitiativePerson.initiative_id)
        .outerjoin(Site, Site.id == InitiativePerson.site_worked_id)
        .where(InitiativePerson.person_id == person_id)
        .order_by(InitiativePerson.created_at.desc()))).all()
    initiatives = []
    for m, init, site_name in memberships:
        wt = (vocabs.get("initiative_work_type", {}).get(
                  m.work_type, (m.work_type, _VOCAB_FALLBACK))
              if m.work_type is not None else (None, None))
        t = vocabs.get("initiative_type", {}).get(
            init.initiative_type, (init.initiative_type, _VOCAB_FALLBACK))
        s = vocabs.get("initiative", {}).get(
            init.status, (init.status, _VOCAB_FALLBACK))
        initiatives.append(WorkerInitiativeItem(
            initiative_id=init.id, initiative_name=init.name,
            type_label=t[0], type_color=t[1],
            status_label=s[0], status_color=s[1],
            work_type_label=wt[0], work_type_color=wt[1],
            site_worked_name=site_name, rating=m.rating,
            added_at=m.created_at))

    return WorkerDetailOut(
        person_id=person.id,
        display_name=person.display_name,
        first_name=person.first_name,
        last_name=person.last_name,
        contact_email=person.email,
        phone=person.phone,
        avatar_url=presign_get(person.avatar_key),
        has_account=account is not None,
        trade=profile.trade if profile else None,
        **level_fields(profile.level if profile else None, lvl_colors),
        **status_fields(profile.status if profile else "active", labels),
        status_note=profile.status_note if profile else None,
        partner=(PartnerRef(id=partner.id, name=partner.name)
                 if partner else None),
        cert_count=cert_total or 0,
        certs_expired=cert_expired or 0,
        preferred_name=person.preferred_name,
        job_title=person.job_title,
        address_line1=person.address_line1,
        address_line2=person.address_line2,
        city=person.city,
        region=person.region,
        postal_code=person.postal_code,
        country=person.country,
        badge_uid=person.badge_uid,
        rfid_tag=person.rfid_tag,
        person_notes=person.notes,
        source=person.source,
        source_ref=person.source_ref,
        created_at=person.created_at,
        level_def=(WorkerLevelOut.model_validate(level_row)
                   if level_row else None),
        initiatives=initiatives,
    )
```

IMPLEMENTER NOTES for Step 3:
- Delete the `def vocab(...)` placeholder lines — they are a leftover in this plan text, not code to keep. Only the `vocab_rows`/`vocabs` block belongs.
- `WorkerLevelOut.model_validate(level_row)` requires `WorkerLevelOut.model_config` to allow from_attributes — check the class; if it lacks `from_attributes=True`, construct it field-by-field instead.
- ROUTE ORDER: FastAPI matches in declaration order; `GET /workers/{person_id}` must not shadow static routes. `list_certifications` is `/{person_id}/certifications` (deeper path — safe), and `levels_router` has its own prefix — safe. Place the new route directly after `list_workers`.

`api/src/serversherpa/api/routes/notes.py` — add to `NOTE_HOSTS` (imports: add `Person` to the models import):

```python
    "person": ("workers", Person),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && SS_TEST_DB=serversherpa_test_workers ./.venv/bin/python -m pytest tests/test_workers_detail_api.py tests/test_workers.py tests/test_notes_api.py -v`
Expected: PASS (all; the two existing files guard against regressions)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/workers.py api/src/serversherpa/api/routes/notes.py api/tests/test_workers_detail_api.py
git commit -m "feat(api): worker detail endpoint + person notes host"
```

---

### Task 2: Portal — extract shared worker components + client

**Files:**
- Create: `portal/src/components/workers/LevelBadge.tsx`
- Create: `portal/src/components/workers/ProfileForm.tsx`
- Create: `portal/src/components/workers/CertsPanel.tsx`
- Modify: `portal/src/lib/workers.ts` (types + `getWorker`)
- Modify: `portal/src/pages/Workers.tsx` (delete the moved code, import from the new files, add "Full details" button)

**Interfaces:**
- Consumes: the three components currently defined inside `portal/src/pages/Workers.tsx` (`LevelBadge`, `ProfileForm`, `CertsPanel` — plus whatever small helpers only they use, e.g. the `BLACKLIST` const and the page-local `LevelDef` type).
- Produces (used by Task 3):
  - `components/workers/LevelBadge.tsx` default export `LevelBadge({ level, levels })`
  - `components/workers/ProfileForm.tsx` default export `ProfileForm({ worker, levels, statuses, onDone, onCancel })`
  - `components/workers/CertsPanel.tsx` default export `CertsPanel({ personId, onChanged })`
  - `lib/workers.ts`: `export interface WorkerLevelDef { level: string; rank: number; title: string; description: string; expected_skills: string[]; color: string | null }` (the page-local `LevelDef` moved here, name-changed), `export const WORKER_BLACKLIST = 'blacklist'` (or the current `BLACKLIST` value — copy it verbatim), and:

```typescript
export interface WorkerInitiativeItem {
  initiative_id: string;
  initiative_name: string;
  type_label: string | null;
  type_color: string | null;
  status_label: string;
  status_color: string;
  work_type_label: string | null;
  work_type_color: string | null;
  site_worked_name: string | null;
  rating: number | null;
  added_at: string;
}

export interface WorkerDetailItem extends WorkerItem {
  preferred_name: string | null;
  job_title: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  badge_uid: string;
  rfid_tag: string | null;
  person_notes: string | null;
  source: string;
  source_ref: string | null;
  created_at: string;
  level_def: WorkerLevelDef | null;
  initiatives: WorkerInitiativeItem[];
}

export async function getWorker(personId: string): Promise<WorkerDetailItem> {
  const resp = await apiFetch(`/workers/${personId}`);
  if (!resp.ok) throw new Error(`worker_${resp.status}`);
  return await resp.json() as WorkerDetailItem;
}
```

  (If `lib/workers.ts` does not already import `apiFetch`, add `import { apiFetch } from './api';` — check for import cycles first: `api.ts` must not import `workers.ts`; it doesn't today.)

- [ ] **Step 1: Move the components verbatim**

Mechanical extraction — the components' JSX/logic must not change:
1. Copy `LevelBadge`, `ProfileForm`, `CertsPanel` (and any helper used ONLY by them) from `Workers.tsx` into the three new files as default exports, bringing exactly the imports each needs (`apiFetch`, `StatusValue`, `PartnerRef`/`WorkerItem` types, react hooks). Replace their references to the page-local `LevelDef` with `WorkerLevelDef` from `lib/workers.ts`; replace `BLACKLIST` with the shared `WORKER_BLACKLIST`.
2. In `Workers.tsx`: delete the moved definitions, import the three components and the shared const/type, and alias `WorkerLevelDef` if the page uses the `LevelDef` name widely (`type LevelDef = WorkerLevelDef`).
3. Add the "Full details" button as the FIRST element of the `detail-actions` row in `WorkerDetail` (the expansion component that remains in Workers.tsx), mirroring Initiatives.tsx:774:

```tsx
<button className="btn-ghost"
        onClick={() => navigate(`/people/workers/${worker.person_id}`)}>
  Full details
</button>
```

`WorkerDetail` needs `useNavigate()` (import from react-router-dom) — add `const navigate = useNavigate();` inside it. The button renders regardless of `canManage` — move it OUTSIDE the `(canManage || godVisible)` guard so read-only users can reach the page: change the guard so the `detail-actions` div always renders, with the Edit/GodDelete buttons still individually guarded inside it.

- [ ] **Step 2: Add the lib/workers.ts types + getWorker exactly as the Interfaces block above**

- [ ] **Step 3: Verify no behavior change**

Run: `cd portal && npm test && npm run build`
Expected: all tests pass (including existing `workers.test.ts` and `godmode.test.ts`), build clean.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/workers portal/src/lib/workers.ts portal/src/pages/Workers.tsx
git commit -m "refactor(portal): extract shared worker components; full-details entry"
```

---

### Task 3: Portal — WorkerDetailPage

**Files:**
- Create: `portal/src/pages/WorkerDetail.tsx`
- Modify: `portal/src/App.tsx` (import + route)

**Interfaces:**
- Consumes: `getWorker`, `WorkerDetailItem`, `WorkerLevelDef`, `WORKER_BLACKLIST` from `lib/workers.ts`; `ProfileForm`, `CertsPanel`, `LevelBadge` from `components/workers/`; `AvatarUpload`, `NotesFilesPanel` components; `apiFetch` + `StatusValue` from `lib/api`; `listWorkerStatuses`-equivalent (check how Workers.tsx loads its `statuses` and `levels` — reuse the same two calls); `longDate` from `lib/format`; `useAuth` (`can`).
- Produces: route `/people/workers/:personId`.

- [ ] **Step 1: Write the page**

```tsx
/**
 * WorkerDetail — full page for one worker: /me-style hero (photo, chips,
 * contact strip), worker profile + person details editing, level card,
 * certifications, initiative history, import provenance, notes/files.
 * Chrome mirrors Profile.tsx (hero/panels) + SiteDetail.tsx (back link).
 */
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import NotesFilesPanel from '../components/NotesFilesPanel';
import CertsPanel from '../components/workers/CertsPanel';
import LevelBadge from '../components/workers/LevelBadge';
import ProfileForm from '../components/workers/ProfileForm';
import { apiFetch, type StatusValue } from '../lib/api';
import { longDate } from '../lib/format';
import {
  getWorker, WORKER_BLACKLIST,
  type WorkerDetailItem, type WorkerLevelDef,
} from '../lib/workers';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';

const PERSON_FIELDS = [
  { key: 'first_name', label: 'First name', full: false, required: true },
  { key: 'last_name', label: 'Last name', full: false, required: true },
  { key: 'preferred_name', label: 'Preferred name', full: false, required: false },
  { key: 'job_title', label: 'Job title', full: false, required: false },
  { key: 'email', label: 'Contact email', full: false, required: false },
  { key: 'phone', label: 'Phone', full: false, required: false },
  { key: 'address_line1', label: 'Address line 1', full: true, required: false },
  { key: 'address_line2', label: 'Address line 2', full: true, required: false },
  { key: 'city', label: 'City', full: false, required: false },
  { key: 'region', label: 'State / region', full: false, required: false },
  { key: 'postal_code', label: 'Postal code', full: false, required: false },
  { key: 'country', label: 'Country (2-letter)', full: false, required: true },
] as const;
type PersonKey = (typeof PERSON_FIELDS)[number]['key'];

// WorkerDetailItem carries email as contact_email; the PATCH speaks person
// field names — map just that one key.
const valueFor = (w: WorkerDetailItem, key: PersonKey): string =>
  (key === 'email' ? w.contact_email : (w as unknown as Record<string, string | null>)[key]) ?? '';

const chip = (label: string | null, color: string | null) =>
  label ? (
    <span className="chip custom" style={{ '--chip': color ?? '#51606f' } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  ) : null;

export default function WorkerDetailPage() {
  const { personId } = useParams<{ personId: string }>();
  const { can, person: me } = useAuth();
  const canManage = can('workers', 'change');
  const canEditPerson = can('users', 'change');

  const [worker, setWorker] = useState<WorkerDetailItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [levels, setLevels] = useState<WorkerLevelDef[]>([]);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingPerson, setEditingPerson] = useState(false);
  const [personForm, setPersonForm] = useState<Record<PersonKey, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [personError, setPersonError] = useState('');

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      setWorker(await getWorker(personId));
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [personId]);

  useEffect(() => {
    void load();
    void apiFetch('/worker-levels').then(async (r) => {
      if (r.ok) setLevels(await r.json() as WorkerLevelDef[]);
    }).catch(() => {});
    void apiFetch('/status-values?record_type=worker').then(async (r) => {
      if (r.ok) setStatuses(await r.json() as StatusValue[]);
    }).catch(() => {});
  }, [load]);

  const startPersonEdit = () => {
    if (!worker) return;
    const form = {} as Record<PersonKey, string>;
    for (const f of PERSON_FIELDS) form[f.key] = valueFor(worker, f.key);
    setPersonForm(form);
    setPersonError('');
    setEditingPerson(true);
  };

  const savePerson = async (e: FormEvent) => {
    e.preventDefault();
    if (!personForm || !worker) return;
    setSaving(true);
    setPersonError('');
    const patch: Record<string, string | null> = {};
    for (const f of PERSON_FIELDS) {
      const now = personForm[f.key].trim();
      if (now !== valueFor(worker, f.key)) patch[f.key] = now === '' ? null : now;
    }
    try {
      if (Object.keys(patch).length > 0) {
        const resp = await apiFetch(`/users/${worker.person_id}/profile`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) throw new Error(String(resp.status));
      }
      setEditingPerson(false);
      void load();
    } catch {
      setPersonError('Could not save — check the fields and try again.');
    } finally {
      setSaving(false);
    }
  };

  const back = <Link to="/people/workers" className="idet-back">← Workers</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Worker not found</b>This person does not exist, is not a worker, or was removed.
        </div>
      </div>
    );
  }
  if (!worker) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const joined = [worker.city, worker.region].filter(Boolean).join(', ');

  return (
    <div className="portal-page">
      {back}

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={worker.display_name}
            url={worker.avatar_url}
            entityType="person"
            entityId={worker.person_id}
            editable={canManage}
            size={104}
            radius={26}
            onUploaded={() => void load()}
          />
          <div className="profile-meta">
            <h1>
              {worker.display_name}
              {chip(worker.status_label, worker.status_color)}
              <LevelBadge level={worker.level} levels={levels} />
            </h1>
            <div className="pm-role">
              {[worker.trade ?? 'No trade set',
                worker.partner?.name ?? 'Direct hire'].join(' · ')}
            </div>
            <div className="pm-sub">
              {worker.contact_email && <span>✉ {worker.contact_email}</span>}
              {worker.phone && <span>☏ {worker.phone}</span>}
              {joined && <span>⌖ {joined}</span>}
              <span>added {longDate(worker.created_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Worker profile</h3>
              {canManage && !editingProfile && (
                <button className="mini-btn" onClick={() => setEditingProfile(true)}>Edit</button>
              )}
            </div>
            <div className="panel-body">
              {editingProfile ? (
                <ProfileForm worker={worker} levels={levels} statuses={statuses}
                             onDone={() => { setEditingProfile(false); void load(); }}
                             onCancel={() => setEditingProfile(false)} />
              ) : (
                <dl className="kv">
                  <dt>Trade</dt><dd>{worker.trade ?? '—'}</dd>
                  <dt>Level</dt><dd><LevelBadge level={worker.level} levels={levels} /></dd>
                  <dt>Partner</dt><dd>{worker.partner?.name ?? 'Direct hire'}</dd>
                  <dt>Status</dt><dd>{chip(worker.status_label, worker.status_color)}</dd>
                  {worker.status_note && (
                    <><dt>Status note</dt><dd>{worker.status_note}</dd></>
                  )}
                  <dt>Login</dt>
                  <dd>{worker.has_account
                    ? (worker.status === WORKER_BLACKLIST
                      ? <span className="chip c-red"><span className="dot" />disabled (blacklist)</span>
                      : <span className="chip c-green"><span className="dot" />portal access</span>)
                    : <span className="chip tag">no account</span>}</dd>
                </dl>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>{editingPerson ? 'Edit person details' : 'Person details'}</h3>
              {canEditPerson && !editingPerson && (
                <button className="mini-btn" onClick={startPersonEdit}>Edit</button>
              )}
            </div>
            <div className="panel-body">
              {editingPerson && personForm ? (
                <form className="pf-form" onSubmit={savePerson} noValidate>
                  {PERSON_FIELDS.map((f) => (
                    <div key={f.key} className={f.full ? 'full' : ''}>
                      <label htmlFor={`wd-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                      <input id={`wd-${f.key}`} value={personForm[f.key]}
                             required={f.required}
                             onChange={(e) => setPersonForm({ ...personForm, [f.key]: e.target.value })} />
                    </div>
                  ))}
                  <div className="pf-form-actions">
                    <button className="btn-solid" type="submit" disabled={saving}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                    <button className="mini-btn" type="button" disabled={saving}
                            onClick={() => setEditingPerson(false)}>
                      Cancel
                    </button>
                    {personError && <span className="pf-error">{personError}</span>}
                  </div>
                </form>
              ) : (
                <dl className="kv">
                  <dt>Preferred name</dt><dd>{worker.preferred_name ?? '—'}</dd>
                  <dt>Job title</dt><dd>{worker.job_title ?? '—'}</dd>
                  <dt>Contact email</dt><dd className="mono">{worker.contact_email ?? '—'}</dd>
                  <dt>Phone</dt><dd className="mono">{worker.phone ?? '—'}</dd>
                  <dt>Address</dt>
                  <dd>
                    {[worker.address_line1, worker.address_line2,
                      [worker.city, worker.region, worker.postal_code].filter(Boolean).join(', '),
                      worker.country]
                      .filter((part) => part && String(part).length > 0)
                      .join(' · ') || '—'}
                  </dd>
                  <dt>Badge ID</dt><dd className="mono">{worker.badge_uid}</dd>
                  <dt>RFID tag</dt><dd className="mono">{worker.rfid_tag ?? '—'}</dd>
                  <dt>Added</dt><dd className="mono">{longDate(worker.created_at)}</dd>
                </dl>
              )}
            </div>
          </div>

          {worker.source_ref && (
            <div className="panel">
              <div className="panel-head"><h3>Import provenance</h3></div>
              <div className="panel-body">
                <dl className="kv">
                  <dt>Source</dt><dd>{worker.source}</dd>
                  <dt>Source ref</dt><dd className="mono">{worker.source_ref}</dd>
                </dl>
                {worker.person_notes && (
                  <p className="set-note" style={{ whiteSpace: 'pre-line', padding: '10px 0 0' }}>
                    {worker.person_notes}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          {worker.level_def && (
            <div className="panel">
              <div className="panel-head">
                <h3>{worker.level_def.level} · {worker.level_def.title}</h3>
              </div>
              <div className="panel-body">
                <p className="set-note" style={{ padding: '0 0 8px' }}>
                  {worker.level_def.description}
                </p>
                <div className="chips">
                  {worker.level_def.expected_skills.map((s) => (
                    <span key={s} className="chip c-blue">⚡ {s}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <h3>Certifications & compliance</h3>
              <span className="result-count">
                {worker.cert_count} on file{worker.certs_expired > 0
                  ? ` · ${worker.certs_expired} expired` : ''}
              </span>
            </div>
            <div className="panel-body">
              <CertsPanel personId={worker.person_id} onChanged={() => void load()} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Initiative history</h3>
              <span className="result-count">{worker.initiatives.length} initiatives</span>
            </div>
            <div className="panel-body">
              {worker.initiatives.length === 0 ? (
                <p className="set-note" style={{ padding: 0 }}>
                  Not on any initiative rosters yet.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="activity-changes">
                    <thead>
                      <tr>
                        <th>Initiative</th><th>Type</th><th>Status</th>
                        <th>Work type</th><th>Site</th><th>Rating</th><th>Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {worker.initiatives.map((i) => (
                        <tr key={`${i.initiative_id}-${i.added_at}`}>
                          <td><Link to={`/initiatives/${i.initiative_id}`}>{i.initiative_name}</Link></td>
                          <td>{chip(i.type_label, i.type_color) ?? '—'}</td>
                          <td>{chip(i.status_label, i.status_color)}</td>
                          <td>{chip(i.work_type_label, i.work_type_color) ?? '—'}</td>
                          <td>{i.site_worked_name ?? '—'}</td>
                          <td>{i.rating != null ? `★ ${i.rating}` : '—'}</td>
                          <td className="mono">{new Date(i.added_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-body">
              <NotesFilesPanel entityType="person" entityId={worker.person_id}
                               canWrite={canManage} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

IMPLEMENTER NOTES:
- `useAuth()` — check its actual return shape; if it exposes no `person`, drop the unused `person: me` destructure.
- Check how Workers.tsx actually fetches `levels` and `statuses` (exact endpoints/helpers — e.g. a `listWorkerStatuses()` helper may exist in lib/api.ts) and use the SAME calls instead of the raw `apiFetch` paths above if they differ.
- `NotesFilesPanel` props — check its real prop names (`entityType`/`entityId`/`canWrite` per SiteDetail.tsx usage) and match.
- Check `AvatarUpload`'s `onUploaded` signature (Profile.tsx passes a callback receiving the attachment) — a plain `() => void load()` is fine if the arg is optional.
- If `activity-changes` styles are scoped to a page stylesheet not imported here, import that stylesheet too (find where `.activity-changes` lives: likely profile.css or directory.css — verify with grep).

`portal/src/App.tsx` — import `WorkerDetailPage from './pages/WorkerDetail'` and add directly after the `/people/workers` route:

```tsx
            <Route path="/people/workers/:personId" element={
              <ProtectedRoute resource="workers"><WorkerDetailPage /></ProtectedRoute>
            } />
```

- [ ] **Step 2: Verify**

Run: `cd portal && npm test && npm run build`
Expected: PASS + clean build.

- [ ] **Step 3: Commit**

```bash
git add portal/src/pages/WorkerDetail.tsx portal/src/App.tsx
git commit -m "feat(portal): worker full-detail page"
```

---

### Task 4: Live verification (controller-run)

**Files:** none — verification only. The controller (not a subagent) performs this.

- [ ] Run API suite subset + portal suite one more time (foreground).
- [ ] Restart/attach the worktree portal (port 5199) against the dev API; sign in.
- [ ] Open an IMPORTED worker with a photo (e.g. from /people/workers, expand → Full details) — screenshot; verify hero photo, chips, trade/partner line, provenance panel with V2 notes, certifications empty state, initiative history empty state, notes panel add-note round-trip.
- [ ] Open the seeded dev worker (Claude Dev — has level L3 + initiative roster membership on the NAP11 demo initiative if present) — verify the level card and initiative history table render as a REAL table with chips and links.
- [ ] Exercise both edit forms (worker profile save; person details save) and confirm the page reloads with changes.
- [ ] LOOK at the screenshots against the binding form/table rules before declaring done.

## Self-Review Notes

- Spec coverage: photo/hero (/me-style) ✓, more info (person details, provenance, V2 notes, RFID, badge) ✓, more options (profile edit, person edit, certs, avatar upload, notes/files) ✓, work history (initiative table) ✓, entry point from list ✓.
- Type consistency: `WorkerDetailOut.person_notes` ↔ `WorkerDetailItem.person_notes`; `added_at` datetime ↔ string; `WorkerLevelOut` ↔ `WorkerLevelDef` field-compatible (level/rank/title/description/expected_skills/color).
- The `def vocab` placeholder in Task 1 Step 3 is explicitly flagged for deletion in the implementer notes.
