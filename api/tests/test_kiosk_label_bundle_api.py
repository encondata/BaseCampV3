"""GET /kiosk/labels/bundle: the portal's Print Labels bundle, reachable
with a kiosk session (which can only touch /kiosk/*). Same body as
GET /labels/generated/bundle; gated by labels:view AND kiosk:view, locked
to the session's move, and 422 for a label type the vocabulary lacks."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import (
    GeneratedLabel,
    Initiative,
    PermissionOverride,
    Person,
    PersonRole,
)
from serversherpa.services import move_password as mp_svc
from tests.test_label_generate_api import _asset_on, _initiative, _template
from tests.test_label_print_bundle_api import _container_label, _container_on, _label
from tests.test_status_values_write import PW, _make

URL = "/kiosk/labels/bundle"


def _q(ini_id, label_type="top"):
    return f"{URL}?initiative_id={ini_id}&label_type={label_type}"


def _strip(body):
    return {k: v for k, v in body.items() if k != "fetched_at"}


def _code(resp):
    return resp.json()["detail"]["code"]


async def test_staff_gets_the_bundle_and_a_worker_is_refused(client, db, seeded_user):
    ini = await _initiative(db)
    a1 = await _asset_on(db, ini, legacy_id=7001)
    a2 = await _asset_on(db, ini, legacy_id=7002)
    tpl = await _template(db, "top")
    await _label(db, ini, a1, tpl)
    await _label(db, ini, a2, tpl)

    staff = await _make(db, client, "staff", "kb-staff@test.example.com")
    resp = await client.get(_q(ini.id), headers=staff)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {row["entity_id"] for row in body["labels"]} == {str(a1.id), str(a2.id)}
    assert body["label_type"] == "top"

    worker = await _make(db, client, "worker", "kb-worker@test.example.com")
    resp = await client.get(_q(ini.id), headers=worker)
    assert resp.status_code == 403
    assert _code(resp) == "forbidden"


async def test_labels_view_without_kiosk_view_is_refused(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "staff", "kb-nokiosk@test.example.com")
    person = await db.scalar(
        select(Person).where(Person.email == "kb-nokiosk@test.example.com"))
    db.add(PermissionOverride(person_id=person.id, resource="kiosk", action="view",
                              allow=False))
    await db.commit()
    resp = await client.get(_q(ini.id), headers=hdrs)
    assert resp.status_code == 403
    assert _code(resp) == "forbidden"


async def test_a_kiosk_sign_in_reaches_the_route(client, db, seeded_user):
    ini = await _initiative(db)
    await _make(db, client, "staff", "kb-kiosk@test.example.com")
    login = await client.post("/auth/login", json={
        "email": "kb-kiosk@test.example.com", "password": PW, "client": "kiosk"})
    assert login.status_code == 200, login.text
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    resp = await client.get(_q(ini.id), headers=hdrs)
    assert resp.status_code == 200, resp.text


async def test_a_locked_session_on_another_move_gets_move_locked(client, db, seeded_user):
    own = Initiative(name="KB own", initiative_type="move", status="in_progress")
    other = Initiative(name="KB other", initiative_type="move", status="in_progress")
    db.add_all([own, other])
    await db.flush()
    await mp_svc.set_password(db, own, "Crew-2026!", actor_id=seeded_user.id)
    account = await mp_svc.ensure_kiosk_identity(db, own)
    # Without labels:view the lock is never reached.
    db.add(PersonRole(person_id=account.person_id, role="staff"))
    await db.commit()

    login = await client.post("/kiosk/move-login", json={"password": "Crew-2026!"})
    assert login.status_code == 200, login.text
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}

    assert (await client.get(_q(own.id), headers=hdrs)).status_code == 200
    resp = await client.get(_q(other.id), headers=hdrs)
    assert resp.status_code == 403
    assert _code(resp) == "move_locked"


async def test_an_unknown_or_archived_move_gets_404(client, db, seeded_user):
    """Out-of-scope isn't constructible: `labels` is visible_to={"global"},
    so a scoped actor is refused before the scope check (see the docstring
    at tests/test_label_generate_api.py:310). Unknown and archived cover
    the 404 leg."""
    archived = await _initiative(db, archived=True)
    hdrs = await _make(db, client, "staff", "kb-404@test.example.com")
    for ini_id in (archived.id, uuid.uuid4()):
        resp = await client.get(_q(ini_id), headers=hdrs)
        assert resp.status_code == 404, resp.text
        assert _code(resp) == "initiative_not_found"


async def test_an_unknown_label_type_gets_422(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "staff", "kb-422@test.example.com")
    resp = await client.get(_q(ini.id, "nope"), headers=hdrs)
    assert resp.status_code == 422
    assert _code(resp) == "unknown_label_type"
    # the portal route is unchanged: same type, empty bundle
    portal = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=nope", headers=hdrs)
    assert portal.status_code == 200
    assert portal.json()["labels"] == []


async def test_the_body_matches_the_portal_route(client, db, seeded_user):
    ini = await _initiative(db)
    a = await _asset_on(db, ini, legacy_id=7101)
    b = await _asset_on(db, ini, legacy_id=7102)
    tpl = await _template(db, "top")
    await _label(db, ini, a, tpl)
    db.add(GeneratedLabel(entity_type="asset", entity_id=a.id, initiative_id=ini.id,
                          label_type="top", template_id=tpl.id,
                          template_version=tpl.version, language_key="zpl",
                          dpi_key="300", size_key="4x2", code="^XA3^XZ",
                          generated_at=datetime.now(UTC)))
    await db.commit()
    await _label(db, ini, b, tpl, stale=True)
    c = await _container_on(db, ini)
    ctpl = await _template(db, "container")
    await _container_label(db, ini, c, ctpl)

    hdrs = await _make(db, client, "staff", "kb-match@test.example.com")
    counts = {"top": 3, "container": 1}
    for label_type, n in counts.items():
        portal = await client.get(
            f"/labels/generated/bundle?initiative_id={ini.id}&label_type={label_type}",
            headers=hdrs)
        kiosk = await client.get(_q(ini.id, label_type), headers=hdrs)
        assert portal.status_code == 200 and kiosk.status_code == 200, kiosk.text
        assert _strip(kiosk.json()) == _strip(portal.json())
        assert len(kiosk.json()["labels"]) == n
