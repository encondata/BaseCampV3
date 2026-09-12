"""labels/generate/select.py: template resolution — site link beats
global, other-site links are never used, inactive templates are never
used, and ties break on version then updated_at. Also candidate_templates
— the superset select_template's auto-match is drawn from, used by the
per-type template picker and the preview endpoint."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import LabelTemplate, LabelTemplateSite, Site
from serversherpa.labels.generate.select import candidate_templates, select_template

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


# ── candidate_templates ─────────────────────────────────────────────

async def test_candidates_site_auto_match_first_then_remaining_groups(db):
    site = Site(name="NAP11")
    other_site = Site(name="NAP-Other")
    db.add_all([site, other_site])
    await db.flush()
    site_linked = _template("site-top", version=1)
    other_site_linked = _template("other-top", version=5)
    glob = _template("global-top", version=1)
    db.add_all([site_linked, other_site_linked, glob])
    await db.flush()
    db.add_all([
        LabelTemplateSite(template_id=site_linked.id, site_id=site.id),
        LabelTemplateSite(template_id=other_site_linked.id, site_id=other_site.id),
    ])
    await db.commit()

    candidates = await candidate_templates(db, "top", site.id)
    assert [c.template.id for c in candidates] == [
        site_linked.id, glob.id, other_site_linked.id]
    assert [c.scope for c in candidates] == ["site", "global", "other"]
    # the auto-match (candidates[0]) matches select_template exactly
    auto = await select_template(db, "top", site.id)
    assert auto.id == candidates[0].template.id
    other = candidates[2]
    assert other.site_names == ["NAP-Other"]
    # site/global candidates don't bother reporting site names
    assert candidates[0].site_names == [] and candidates[1].site_names == []


async def test_candidates_other_only_type_has_no_auto_match(db):
    """A type whose only active templates are linked to a DIFFERENT
    site has candidates but no auto-match — candidates[0].scope is
    'other', which the preview route reads as template: null."""
    site_a = Site(name="NAP-A")
    site_b = Site(name="NAP-B")
    db.add_all([site_a, site_b])
    await db.flush()
    b_only = _template("b-only-top")
    db.add(b_only)
    await db.flush()
    db.add(LabelTemplateSite(template_id=b_only.id, site_id=site_b.id))
    await db.commit()

    candidates = await candidate_templates(db, "top", site_a.id)
    assert len(candidates) == 1
    assert candidates[0].scope == "other"
    assert candidates[0].site_names == ["NAP-B"]
    assert await select_template(db, "top", site_a.id) is None    # no auto-match


async def test_candidates_inactive_templates_excluded(db):
    active = _template("active-top")
    inactive = _template("inactive-top", is_active=False)
    db.add_all([active, inactive])
    await db.commit()

    candidates = await candidate_templates(db, "top", None)
    assert [c.template.id for c in candidates] == [active.id]


async def test_candidates_empty_when_no_templates_of_type(db):
    assert await candidate_templates(db, "container", None) == []


async def test_candidates_groups_ordered_by_version_then_updated_at(db):
    site = Site(name="NAP11")
    db.add(site)
    await db.flush()
    older_v1 = _template("s-v1-older", version=1, updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    newer_v1 = _template("s-v1-newer", version=1, updated_at=datetime(2026, 6, 1, tzinfo=UTC))
    v2 = _template("s-v2", version=2, updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    db.add_all([older_v1, newer_v1, v2])
    await db.flush()
    for tpl in (older_v1, newer_v1, v2):
        db.add(LabelTemplateSite(template_id=tpl.id, site_id=site.id))
    await db.commit()

    candidates = await candidate_templates(db, "top", site.id)
    assert [c.template.id for c in candidates] == [v2.id, newer_v1.id, older_v1.id]
    assert all(c.scope == "site" for c in candidates)
