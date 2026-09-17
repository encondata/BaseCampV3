"""Print Labels' data source: GET /labels/generated/bundle returns every
generated label for one initiative + label type in one response (no
paging) with the language/size/dpi keys the print page needs — the same
payload the page stores in its offline cache."""

from serversherpa.db.models import Container, GeneratedLabel

from tests.test_label_generate_api import _asset_on, _initiative, _template
from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def _label(db, ini, asset, tpl, *, label_type="top", code="^XA^XZ", stale=False,
                 language="zpl"):
    db.add(GeneratedLabel(entity_type="asset", entity_id=asset.id, initiative_id=ini.id,
                          label_type=label_type, template_id=tpl.id,
                          template_version=tpl.version, language_key=language,
                          dpi_key="203", size_key="4x2", code=code, stale=stale))
    await db.commit()


async def _container_on(db, ini, *, name="crate"):
    container = Container(name=name, initiative_id=ini.id, label_tag="priority")
    db.add(container)
    await db.commit()
    return container


async def _container_label(db, ini, container, tpl, *, label_type="container",
                           code="^XAC^XZ", stale=False, language="zpl"):
    db.add(GeneratedLabel(entity_type="container", entity_id=container.id,
                          initiative_id=ini.id, label_type=label_type, template_id=tpl.id,
                          template_version=tpl.version, language_key=language,
                          dpi_key="203", size_key="4x2", code=code, stale=stale))
    await db.commit()


async def test_bundle_returns_every_label_for_the_pair(client, db, seeded_user):
    ini = await _initiative(db)
    other = await _initiative(db)
    a1 = await _asset_on(db, ini, legacy_id=5001, name="sw-1", serial="S1")
    a2 = await _asset_on(db, ini, legacy_id=5002, name="sw-2", serial="S2")
    tpl = await _template(db, "top")
    await _label(db, ini, a1, tpl, code="^XA1^XZ")
    await _label(db, ini, a2, tpl, code="^XA2^XZ", stale=True, language="escp")
    await _label(db, ini, a1, tpl, label_type="front", code="^XAF^XZ")
    await _label(db, other, a1, tpl, code="^XAO^XZ")
    hdrs = await login(client)

    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(ini.id)
    assert body["label_type"] == "top"
    assert body["fetched_at"]
    by_entity = {row["entity_id"]: row for row in body["labels"]}
    assert set(by_entity) == {str(a1.id), str(a2.id)}
    row = by_entity[str(a1.id)]
    assert row["code"] == "^XA1^XZ"
    assert row["template_id"] == str(tpl.id)
    assert row["template_name"] == tpl.name
    assert row["template_version"] == tpl.version
    assert row["language_key"] == "zpl"
    assert row["size_key"] == "4x2" and row["dpi_key"] == "203"
    assert row["stale"] is False and row["entity_type"] == "asset"
    # No display name: the print page keys this payload by entity_id and
    # takes names from its own roster (/assets, /containers).
    assert "entity_name" not in row
    assert by_entity[str(a2.id)]["stale"] is True
    assert by_entity[str(a2.id)]["language_key"] == "escp"


async def test_bundle_empty_for_type_without_labels(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=rail", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["labels"] == []


async def test_bundle_404_for_archived_or_unknown_initiative(client, db, seeded_user):
    ini = await _initiative(db, archived=True)
    hdrs = await login(client)
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"
    resp = await client.get(
        "/labels/generated/bundle?initiative_id=00000000-0000-0000-0000-000000000001&label_type=top",
        headers=hdrs)
    assert resp.status_code == 404


async def test_bundle_requires_labels_view(client, db, seeded_user):
    ini = await _initiative(db)
    worker = await _make(db, client, "worker", "w-bundle@test.example.com")
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=worker)
    assert resp.status_code == 403


async def test_the_bundle_serves_container_labels_for_a_container_type(client, db, seeded_user):
    """The route hardcoded entity_type == 'asset', so a container type
    returned an empty bundle however many labels existed."""
    ini = await _initiative(db)
    tpl = await _template(db, "container")
    c1 = await _container_on(db, ini, name="crate-17")
    c2 = await _container_on(db, ini, name="crate-18")
    await _container_label(db, ini, c1, tpl, code="^XAC1^XZ")
    await _container_label(db, ini, c2, tpl, code="^XAC2^XZ")
    hdrs = await login(client)

    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=container", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["labels"]) == 2
    assert {l["entity_type"] for l in body["labels"]} == {"container"}
    assert {l["entity_id"] for l in body["labels"]} == {str(c1.id), str(c2.id)}
    assert {l["code"] for l in body["labels"]} == {"^XAC1^XZ", "^XAC2^XZ"}


async def test_an_asset_bundle_is_unchanged(client, db, seeded_user):
    ini = await _initiative(db)
    tpl = await _template(db, "top")
    a1 = await _asset_on(db, ini, legacy_id=5101, name="sw-a")
    a2 = await _asset_on(db, ini, legacy_id=5102, name="sw-b")
    await _label(db, ini, a1, tpl, code="^XA1^XZ")
    await _label(db, ini, a2, tpl, code="^XA2^XZ")
    hdrs = await login(client)

    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {l["entity_type"] for l in body["labels"]} == {"asset"}
    assert {l["entity_id"] for l in body["labels"]} == {str(a1.id), str(a2.id)}


async def test_a_container_bundle_never_leaks_asset_labels(client, db, seeded_user):
    """Both kinds exist on this initiative; each bundle must be pure."""
    ini = await _initiative(db)
    asset_tpl = await _template(db, "top")
    container_tpl = await _template(db, "container")
    asset = await _asset_on(db, ini, legacy_id=5201, name="sw-mixed")
    container = await _container_on(db, ini, name="crate-mixed")
    await _label(db, ini, asset, asset_tpl, code="^XA1^XZ")
    await _container_label(db, ini, container, container_tpl, code="^XAC1^XZ")
    hdrs = await login(client)

    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=container", headers=hdrs)
    assert resp.status_code == 200, resp.text
    container_body = resp.json()
    # The container label, and only it — an `all(...)` over an empty bundle
    # would pass while serving nothing, which is the failure this test is for.
    assert [(l["entity_type"], l["entity_id"]) for l in container_body["labels"]] \
        == [("container", str(container.id))]

    # ...and the other direction: the asset type's bundle carries the asset
    # label alone.
    resp = await client.get(
        f"/labels/generated/bundle?initiative_id={ini.id}&label_type=top", headers=hdrs)
    assert resp.status_code == 200, resp.text
    asset_body = resp.json()
    assert [(l["entity_type"], l["entity_id"]) for l in asset_body["labels"]] \
        == [("asset", str(asset.id))]
