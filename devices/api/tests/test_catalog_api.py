"""The catalog: apps, their versions, notes, current version, delete."""

import uuid

from sqlalchemy import select

from serversherpa_devices.db.models import App, AppVersion, SignedBuild

from .catalog_support import apple_settings_filled, audits, hello_ipa, publish


async def _two_versions(api, bucket, db, tmp_path) -> tuple[str, dict, dict]:
    """An iOS app with 1.4 (2) and then 1.5 (10) committed."""
    await apple_settings_filled(db)
    first = await publish(api, bucket, hello_ipa(tmp_path / "a", version="1.4", build="2"))
    second = await publish(api, bucket, hello_ipa(tmp_path / "b", version="1.5", build="10"),
                           notes="Faster scans")
    assert first["app_id"] == second["app_id"]
    return first["app_id"], first["version"], second["version"]


async def test_app_detail_lists_versions_newest_first(api, bucket, db, tmp_path):
    app_id, _, v2 = await _two_versions(api, bucket, db, tmp_path)
    r = await api.get(f"/api/apps/{app_id}")
    assert r.status_code == 200
    body = r.json()
    assert (body["name"], body["platform"], body["identifier"]) == (
        "Hello Display", "ios", "com.example.hello")
    assert [v["build"] for v in body["versions"]] == ["10", "2"]   # 10 sorts after 2
    assert [v["is_current"] for v in body["versions"]] == [True, False]
    assert body["current"]["id"] == v2["id"]
    assert body["ios_state"] is None
    assert (await api.get(f"/api/apps/{uuid.uuid4()}")).status_code == 404


async def test_make_current_switches_and_audits(api, main_fake, bucket, db, tmp_path):
    _, v1, v2 = await _two_versions(api, bucket, db, tmp_path)
    main_fake.audit_route.reset()

    r = await api.post(f"/api/versions/{v1['id']}/make-current")
    assert r.status_code == 200
    assert r.json()["is_current"] is True
    current = (await db.scalars(select(AppVersion.id).where(AppVersion.is_current))).all()
    assert current == [uuid.UUID(v1["id"])]
    listed = (await api.get("/api/apps")).json()
    assert listed[0]["current"]["id"] == v1["id"]

    entries = audits(main_fake)
    assert [(e["entity_type"], e["entity_id"], e["action"]) for e in entries] == [
        ("appdist_version", v1["id"], "make_current")]
    assert entries[0]["changes"] == {"current_version": {"from": v2["id"], "to": v1["id"]}}

    # Already current: nothing changes and nothing is audited.
    main_fake.audit_route.reset()
    assert (await api.post(f"/api/versions/{v1['id']}/make-current")).status_code == 200
    assert audits(main_fake) == []

    main_fake.as_staff()
    r = await api.post(f"/api/versions/{v2['id']}/make-current")
    assert r.status_code == 403


async def test_edit_notes_audits(api, main_fake, bucket, db, tmp_path):
    _, _, v2 = await _two_versions(api, bucket, db, tmp_path)
    main_fake.audit_route.reset()
    r = await api.patch(f"/api/versions/{v2['id']}", json={"notes": "Faster scans, fewer taps"})
    assert r.status_code == 200
    assert r.json()["notes"] == "Faster scans, fewer taps"
    assert (await db.get(AppVersion, uuid.UUID(v2["id"]))).notes == "Faster scans, fewer taps"
    entries = audits(main_fake)
    assert [(e["entity_id"], e["action"]) for e in entries] == [(v2["id"], "edit_notes")]
    assert entries[0]["changes"] == {"notes": {"from": "Faster scans",
                                               "to": "Faster scans, fewer taps"}}
    assert (await api.patch(f"/api/versions/{uuid.uuid4()}", json={"notes": "x"})).status_code \
        == 404


async def test_cannot_delete_current(api, main_fake, bucket, db, tmp_path):
    app_id, v1, v2 = await _two_versions(api, bucket, db, tmp_path)
    r = await api.delete(f"/api/versions/{v2['id']}")
    assert r.status_code == 409
    assert r.json()["detail"]["message"] == "Make another version current first."

    old = await db.get(AppVersion, uuid.UUID(v1["id"]))
    db.add(SignedBuild(version_id=old.id, profile_uuid="p-1", status="ready",
                       file_key=f"apps/{app_id}/{old.id}/signed/p-1.ipa"))
    await db.commit()
    bucket.put(f"apps/{app_id}/{old.id}/signed/p-1.ipa", b"signed")
    assert bucket.exists(old.file_key)

    main_fake.audit_route.reset()
    r = await api.delete(f"/api/versions/{v1['id']}")
    assert r.status_code == 204
    old_id = old.id
    db.expire_all()
    old = await db.get(AppVersion, old_id)
    assert old.deleted_at is not None
    # The objects go in the background (done once the response is out).
    assert not bucket.exists(old.file_key)
    assert not bucket.exists(f"apps/{app_id}/{old.id}/signed/p-1.ipa")
    assert [(e["entity_id"], e["action"]) for e in audits(main_fake)] == [(v1["id"], "delete")]

    # Gone is gone.
    assert (await api.delete(f"/api/versions/{v1['id']}")).status_code == 404
    assert (await api.post(f"/api/versions/{v1['id']}/make-current")).status_code == 404

    main_fake.as_admin(actions=["view", "add", "change"])
    assert (await api.delete(f"/api/versions/{v2['id']}")).status_code == 403


async def test_list_hides_deleted_versions(api, bucket, db, tmp_path):
    app_id, v1, v2 = await _two_versions(api, bucket, db, tmp_path)
    assert (await api.delete(f"/api/versions/{v1['id']}")).status_code == 204
    body = (await api.get(f"/api/apps/{app_id}")).json()
    assert [v["id"] for v in body["versions"]] == [v2["id"]]
    listed = (await api.get("/api/apps")).json()
    assert [a["current"]["id"] for a in listed] == [v2["id"]]


async def test_app_without_icon_has_no_icon_url(api, bucket, db, tmp_path):
    app_id, _, _ = await _two_versions(api, bucket, db, tmp_path)
    app = await db.get(App, uuid.UUID(app_id))
    app.icon_key = None
    await db.commit()
    assert (await api.get("/api/apps")).json()[0]["icon_url"] is None
    assert (await api.get(f"/api/apps/{app_id}/icon")).status_code == 404
