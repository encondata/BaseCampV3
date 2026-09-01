"""Labels schema smoke tests: migration 0042 seeds + model round-trip."""

from sqlalchemy import select

from serversherpa.db.models import LabelPlaceholder, LabelTemplate, LabelVocab


async def test_vocab_seeds_present(db):
    rows = (await db.execute(select(LabelVocab))).scalars().all()
    assert {r.kind for r in rows} == {"type", "size", "dpi", "language"}
    keys = {(r.kind, r.key) for r in rows}
    for expected in [
        ("type", "top"), ("type", "front"), ("type", "rail"), ("type", "container"),
        ("size", "4x2"), ("size", "2x1"), ("size", "4x3-tab"), ("size", "1x1"),
        ("size", "6x4"), ("size", "id-badge"),
        ("dpi", "203"), ("dpi", "300"),
        ("language", "zpl"), ("language", "escp"), ("language", "ptouch"),
    ]:
        assert expected in keys, expected
    tab = next(r for r in rows if r.key == "4x3-tab")
    assert tab.meta == {"width_in": 4, "height_in": 3, "has_tab": True}
    assert next(r for r in rows if r.key == "300").meta == {"dots": 300}
    assert next(r for r in rows if r.key == "ptouch").meta == {"family": "brother"}


async def test_placeholder_seeds_present(db):
    rows = (await db.execute(select(LabelPlaceholder))).scalars().all()
    by_key = {r.key: r for r in rows}
    assert "serial_number" in by_key and by_key["serial_number"].sample_value
    assert "container" in by_key["container_name"].applies_to
    assert "top" in by_key["asset_id"].applies_to


async def test_template_roundtrip(db):
    t = LabelTemplate(
        name="rt-test", label_type="top", size_key="4x2", dpi_key="203",
        language_key="zpl", kind="design",
        design={"size": {"w": 4, "h": 2}, "elements": []},
    )
    db.add(t)
    await db.commit()
    row = (await db.execute(
        select(LabelTemplate).where(LabelTemplate.name == "rt-test")
    )).scalar_one()
    assert row.version == 1 and row.is_active is True and row.code is None
