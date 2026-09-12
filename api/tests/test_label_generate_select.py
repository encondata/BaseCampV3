"""labels/generate/select.py: template resolution — site link beats
global, other-site links are never used, inactive templates are never
used, and ties break on version then updated_at."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import LabelTemplate, LabelTemplateSite, Site
from serversherpa.labels.generate.select import select_template

DESIGN = {"size": {"w": 4, "h": 2}, "elements": []}


def _template(name, **over):
    base = dict(name=name, label_type="top", size_key="4x2", dpi_key="203",
               language_key="zpl", kind="code", code="^XA^XZ")
    base.update(over)
    return LabelTemplate(**base)


async def test_site_linked_beats_global(db):
    site = Site(name="NAP11")
    db.add(site)
    await db.flush()
    glob = _template("global-top")
    linked = _template("site-top")
    db.add_all([glob, linked])
    await db.flush()
    db.add(LabelTemplateSite(template_id=linked.id, site_id=site.id))
    await db.commit()

    found = await select_template(db, "top", site.id)
    assert found.id == linked.id


async def test_other_site_never_falls_back_to_global(db):
    site_a = Site(name="NAP-A")
    site_b = Site(name="NAP-B")
    db.add_all([site_a, site_b])
    await db.flush()
    linked_b = _template("b-only-top")
    db.add(linked_b)
    await db.flush()
    db.add(LabelTemplateSite(template_id=linked_b.id, site_id=site_b.id))
    await db.commit()

    assert await select_template(db, "top", site_a.id) is None


async def test_other_site_link_falls_back_to_global_when_one_exists(db):
    site_a = Site(name="NAP-A")
    site_b = Site(name="NAP-B")
    db.add_all([site_a, site_b])
    await db.flush()
    linked_b = _template("b-only-top")
    glob = _template("global-fallback-top")
    db.add_all([linked_b, glob])
    await db.flush()
    db.add(LabelTemplateSite(template_id=linked_b.id, site_id=site_b.id))
    await db.commit()

    found = await select_template(db, "top", site_a.id)
    assert found.id == glob.id


async def test_inactive_template_never_selected(db):
    inactive_global = _template("inactive-top", is_active=False)
    db.add(inactive_global)
    await db.commit()
    assert await select_template(db, "top", None) is None

    site = Site(name="NAP11")
    db.add(site)
    await db.flush()
    inactive_linked = _template("inactive-linked-top", is_active=False)
    db.add(inactive_linked)
    await db.flush()
    db.add(LabelTemplateSite(template_id=inactive_linked.id, site_id=site.id))
    await db.commit()
    assert await select_template(db, "top", site.id) is None


async def test_ties_break_on_version_then_updated_at(db):
    older_v1 = _template("v1-older", version=1,
                         updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    newer_v1 = _template("v1-newer", version=1,
                         updated_at=datetime(2026, 6, 1, tzinfo=UTC))
    v2 = _template("v2", version=2, updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    db.add_all([older_v1, newer_v1, v2])
    await db.commit()

    found = await select_template(db, "top", None)
    assert found.id == v2.id                     # highest version wins outright

    await db.delete(v2)
    await db.commit()
    found = await select_template(db, "top", None)
    assert found.id == newer_v1.id                # same version -> newest updated_at


async def test_no_match_returns_none(db):
    assert await select_template(db, "container", None) is None


async def test_label_type_must_match(db):
    top = _template("top-only", label_type="top")
    rail = _template("rail-only", label_type="rail")
    db.add_all([top, rail])
    await db.commit()
    found = await select_template(db, "rail", None)
    assert found.id == rail.id
