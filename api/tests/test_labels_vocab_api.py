"""Vocab CRUD: labels:view reads, devtools-gated writes, usage counts."""

from serversherpa.db.models import LabelTemplate

from tests.test_sites_api import login
from tests.test_status_values_write import _make  # role helper: developer/admin login

PW = "CorrectHorse9!"


async def test_list_vocab_requires_labels_view(client, db, seeded_user):
    hdrs = await login(client)  # alice: staff → labels view granted
    resp = await client.get("/labels/vocab", headers=hdrs)
    assert resp.status_code == 200
    kinds = {r["kind"] for r in resp.json()}
    assert kinds == {"type", "size", "dpi", "language"}


async def test_list_vocab_filters_by_kind(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/labels/vocab?kind=size", headers=hdrs)
    assert resp.status_code == 200
    assert {r["kind"] for r in resp.json()} == {"size"}
    assert {r["key"] for r in resp.json()} >= {"4x2", "id-badge"}


async def test_usage_count_counts_templates(client, db, seeded_user):
    db.add(LabelTemplate(name="uc-1", label_type="top", size_key="4x2",
                         dpi_key="203", language_key="zpl", kind="code",
                         code="^XA^XZ"))
    await db.commit()
    hdrs = await login(client)
    rows = (await client.get("/labels/vocab?kind=size", headers=hdrs)).json()
    assert next(r for r in rows if r["key"] == "4x2")["usage_count"] == 1
    assert next(r for r in rows if r["key"] == "2x1")["usage_count"] == 0


async def test_developer_creates_vocab_value(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "size", "key": "3x1", "label": '3" x 1"',
        "meta": {"width_in": 3, "height_in": 1, "has_tab": False},
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["key"] == "3x1"


async def test_duplicate_vocab_409(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "dpi", "key": "203", "label": "dupe", "meta": {"dots": 203},
    })
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "label_vocab_exists"


async def test_bad_meta_422(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "size", "key": "bad", "label": "Bad", "meta": {},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_meta"


async def test_admin_cannot_write_vocab(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "type", "key": "side", "label": "Side Label",
    })
    assert resp.status_code == 403


async def test_patch_vocab(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.patch("/labels/vocab/type/top", headers=hdrs,
                              json={"description": "Lid of the crate."})
    assert resp.status_code == 200
    assert resp.json()["description"] == "Lid of the crate."
    resp = await client.patch("/labels/vocab/type/nope", headers=hdrs,
                              json={"label": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "unknown_vocab"


async def test_designer_adds_a_custom_size(client, db, seeded_user):
    """The builder's New template › Custom… (spec §4.10): a rank-80 designer
    with labels:add posts a size row, listed or (is_active false) kept off
    the list; every other kind stays devtools-only."""
    sa = await _make(db, client, "super_admin", "sa-size@test.example.com")
    resp = await client.post("/labels/vocab", headers=sa, json={
        "kind": "size", "key": "3_25x1_5", "label": '3.25" x 1.5"',
        "meta": {"width_in": 3.25, "height_in": 1.5, "has_tab": False}})
    assert resp.status_code == 201, resp.text
    assert resp.json()["is_active"] is True
    resp = await client.post("/labels/vocab", headers=sa, json={
        "kind": "size", "key": "2_5x1", "label": '2.5" x 1"', "is_active": False,
        "meta": {"width_in": 2.5, "height_in": 1, "has_tab": False}})
    assert resp.status_code == 201, resp.text
    assert resp.json()["is_active"] is False
    rows = (await client.get("/labels/vocab?kind=size", headers=sa)).json()
    assert {r["key"]: r["is_active"] for r in rows}["2_5x1"] is False

    resp = await client.post("/labels/vocab", headers=sa, json={
        "kind": "type", "key": "side", "label": "Side Label"})
    assert resp.status_code == 403
    admin = await _make(db, client, "admin", "adm-size@test.example.com")
    resp = await client.post("/labels/vocab", headers=admin, json={
        "kind": "size", "key": "5x5", "label": '5" x 5"',
        "meta": {"width_in": 5, "height_in": 5, "has_tab": False}})
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"code": "forbidden", "min_rank": 80}
