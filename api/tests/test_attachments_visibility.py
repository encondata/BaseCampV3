"""Per-file visibility: Everyone / Internal / Admin on Notes & files
attachments, and the shared host read rule that lets non-global actors list
Everyone files on records they can see."""

from sqlalchemy import select

from serversherpa.db.models import (
    Asset,
    AuditLog,
    Initiative,
    Person,
    PersonRole,
    ReportDefinition,
)
from tests.test_assets_api import login, make_login
from tests.test_attachments import PNG
from tests.test_initiatives_client_scope import (
    _two_clients_with_initiatives,
    client_login,
)

PDF = b"%PDF-1.4 fake"


async def _admin(db, client, email="att-vis-admin@test.example.com"):
    p = Person(first_name="Att", last_name="Admin")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    return await make_login(db, client, p, email)


async def _initiative(db, name="att-vis-host"):
    i = Initiative(name=name, initiative_type="project")
    db.add(i)
    await db.commit()
    return i


def _upload(client, hdrs, entity_type, entity_id, filename="doc.pdf",
            kind="document", data=PDF, ctype="application/pdf", **extra):
    return client.post(
        "/attachments", headers=hdrs,
        data={"entity_type": entity_type, "entity_id": str(entity_id),
              "kind": kind, **extra},
        files={"file": (filename, data, ctype)})


def _list(client, hdrs, entity_type, entity_id):
    return client.get(
        f"/attachments?entity_type={entity_type}&entity_id={entity_id}",
        headers=hdrs)


async def test_upload_visibility_levels(client, db, seeded_user):
    hdrs = await login(client)
    init = await _initiative(db)

    resp = await _upload(client, hdrs, "initiative", init.id)
    assert resp.status_code == 201, resp.text
    assert resp.json()["visibility"] == "everyone"

    resp = await _upload(client, hdrs, "initiative", init.id, "i.pdf",
                         visibility="internal")
    assert resp.status_code == 201, resp.text
    assert resp.json()["visibility"] == "internal"

    resp = await _upload(client, hdrs, "initiative", init.id, "a.pdf",
                         visibility="admin")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "visibility_not_allowed"

    resp = await _upload(client, hdrs, "initiative", init.id, "b.pdf",
                         visibility="bogus")
    assert resp.status_code == 422


async def test_avatar_cannot_carry_a_visibility(client, db, seeded_user):
    hdrs = await login(client)
    me = await db.scalar(select(Person).where(Person.id == seeded_user.id))
    resp = await _upload(client, hdrs, "person", me.id, "me.png", "avatar",
                         PNG, "image/png", visibility="internal")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "visibility_not_supported"
    resp = await _upload(client, hdrs, "person", me.id, "me.png", "avatar",
                         PNG, "image/png", visibility="everyone")
    assert resp.status_code == 201
    assert resp.json()["visibility"] == "everyone"


async def test_list_is_filtered_by_level(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    staff = await login(client)
    admin = await _admin(db, client)
    for name, level in (("e.pdf", "everyone"), ("i.pdf", "internal")):
        assert (await _upload(client, staff, "initiative", ia.id, name,
                              visibility=level)).status_code == 201
    assert (await _upload(client, admin, "initiative", ia.id, "a.pdf",
                          visibility="admin")).status_code == 201
    await _upload(client, staff, "initiative", ib.id, "other.pdf")

    def names(resp):
        return sorted(r["filename"] for r in resp.json())

    assert names(await _list(client, admin, "initiative", ia.id)) == [
        "a.pdf", "e.pdf", "i.pdf"]
    assert names(await _list(client, staff, "initiative", ia.id)) == [
        "e.pdf", "i.pdf"]

    cl = await client_login(db, client, a.id)
    resp = await _list(client, cl, "initiative", ia.id)
    assert resp.status_code == 200, resp.text
    assert names(resp) == ["e.pdf"]
    resp = await _list(client, cl, "initiative", ib.id)
    assert resp.status_code == 404


async def test_client_sees_only_everyone_asset_files(client, db, seeded_user):
    from tests.test_assets_api import _client_contact
    org, cl = await _client_contact(db, client, "Acme AV", "av@acme.example.com")
    staff = await login(client)
    asset = Asset(name="vis-asset", client_id=org.id)
    db.add(asset)
    await db.commit()
    await _upload(client, staff, "asset", asset.id, "pub.pdf")
    await _upload(client, staff, "asset", asset.id, "priv.pdf",
                  visibility="internal")
    resp = await _list(client, cl, "asset", asset.id)
    assert resp.status_code == 200, resp.text
    assert [r["filename"] for r in resp.json()] == ["pub.pdf"]
    assert len((await _list(client, staff, "asset", asset.id)).json()) == 2


async def test_patch_visibility_audited(client, db, seeded_user):
    hdrs = await login(client)
    init = await _initiative(db)
    att = (await _upload(client, hdrs, "initiative", init.id, "x.pdf")).json()

    resp = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                              json={"visibility": "internal"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "internal"
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "attachment.update"))).all()
    assert len(rows) == 1
    assert rows[0].changes == {
        "filename": "x.pdf",
        "visibility": {"from": "everyone", "to": "internal"}}

    resp = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                              json={"visibility": "internal"})
    assert resp.status_code == 200
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "attachment.update"))).all()
    assert len(rows) == 1

    resp = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                              json={"visibility": "admin"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "visibility_not_allowed"

    resp = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                              json={"visibility": "everyone", "extra": 1})
    assert resp.status_code == 422
    resp = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                              json={"visibility": "bogus"})
    assert resp.status_code == 422


async def test_admin_file_is_missing_for_staff_patch_and_delete(
        client, db, seeded_user):
    staff = await login(client)
    admin = await _admin(db, client)
    init = await _initiative(db)
    att = (await _upload(client, admin, "initiative", init.id, "s.pdf",
                         visibility="admin")).json()

    r = await client.patch(f"/attachments/{att['id']}", headers=staff,
                           json={"visibility": "everyone"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "attachment_not_found"
    r = await client.delete(f"/attachments/{att['id']}", headers=staff)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "attachment_not_found"

    # an admin can still move it down and delete it
    r = await client.patch(f"/attachments/{att['id']}", headers=admin,
                           json={"visibility": "everyone"})
    assert r.status_code == 200
    r = await client.delete(f"/attachments/{att['id']}", headers=staff)
    assert r.status_code == 204


async def test_client_cannot_patch_or_delete(client, db, seeded_user):
    a, *_rest = await _two_clients_with_initiatives(db)
    ia = _rest[1]
    staff = await login(client)
    pub = (await _upload(client, staff, "initiative", ia.id, "p.pdf")).json()
    priv = (await _upload(client, staff, "initiative", ia.id, "q.pdf",
                          visibility="internal")).json()
    cl = await client_login(db, client, a.id)

    r = await client.patch(f"/attachments/{pub['id']}", headers=cl,
                           json={"visibility": "internal"})
    assert r.status_code == 403
    r = await client.patch(f"/attachments/{priv['id']}", headers=cl,
                           json={"visibility": "everyone"})
    assert r.status_code == 404
    r = await client.delete(f"/attachments/{pub['id']}", headers=cl)
    assert r.status_code == 403
    r = await client.delete(f"/attachments/{priv['id']}", headers=cl)
    assert r.status_code == 404


async def test_avatar_patch_is_422(client, db, seeded_user):
    hdrs = await login(client)
    att = (await _upload(client, hdrs, "person", seeded_user.id, "me.png",
                         "avatar", PNG, "image/png")).json()
    r = await client.patch(f"/attachments/{att['id']}", headers=hdrs,
                           json={"visibility": "internal"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "visibility_not_supported"


async def test_avatars_stay_listed_for_anyone_who_can_view_the_person(
        client, db, seeded_user):
    staff = await login(client)
    assert (await _upload(client, staff, "person", seeded_user.id, "me.png",
                          "avatar", PNG, "image/png")).status_code == 201
    resp = await _list(client, staff, "person", seeded_user.id)
    assert resp.status_code == 200
    assert [r["kind"] for r in resp.json()] == ["avatar"]


async def test_report_definition_files_still_need_reports_view(
        client, db, seeded_user):
    definition = ReportDefinition(
        name="Site & Move Survey", report_type="site_move_survey",
        options={}, is_system=True)
    db.add(definition)
    await db.commit()
    staff = await login(client)
    resp = await _list(client, staff, "report_definition", definition.id)
    assert resp.status_code == 200
    a, *_ = await _two_clients_with_initiatives(db)
    cl = await client_login(db, client, a.id)
    resp = await _list(client, cl, "report_definition", definition.id)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_report_definition_kinds_must_stay_everyone(
        client, db, seeded_user):
    """The report gather ignores visibility, so survey_template and
    report_asset files cannot carry a level other than Everyone."""
    definition = ReportDefinition(
        name="Site & Move Survey", report_type="site_move_survey",
        options={}, is_system=True)
    db.add(definition)
    await db.commit()
    admin = await _admin(db, client, "att-vis-admin-fixed@test.example.com")

    for kind, name, ctype in (
            ("survey_template", "t.xlsx", "application/octet-stream"),
            ("report_asset", "r.docx", "application/octet-stream")):
        resp = await _upload(client, admin, "report_definition", definition.id,
                             name, kind, b"bytes", ctype, visibility="internal")
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "visibility_not_supported"

        resp = await _upload(client, admin, "report_definition", definition.id,
                             name, kind, b"bytes", ctype)
        assert resp.status_code == 201, resp.text
        assert resp.json()["visibility"] == "everyone"

        r = await client.patch(f"/attachments/{resp.json()['id']}",
                               headers=admin, json={"visibility": "internal"})
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["code"] == "visibility_not_supported"
