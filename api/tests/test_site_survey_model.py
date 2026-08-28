"""Site survey rows — schema defaults, uniqueness, provenance links."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import RawSurveyEntry, Site, SiteSurveyEntry


async def test_raw_entry_defaults(db):
    site = Site(name="Raw Survey Site")
    db.add(site)
    await db.flush()

    entry = RawSurveyEntry(site_id=site.id, field_key="dock_available",
                           value=True, captured_at=datetime.now(UTC))
    db.add(entry)
    await db.commit()
    assert isinstance(entry.id, int)
    assert entry.device_id == ""
    assert entry.source == ""
    assert entry.submitted_by is None
    assert entry.created_at is not None

    # stray key — no registry FK, inserts fine
    stray = RawSurveyEntry(site_id=site.id, field_key="totally_custom",
                           value="x", captured_at=datetime.now(UTC))
    db.add(stray)
    await db.commit()
    assert isinstance(stray.id, int)


async def test_curated_unique_per_field(db):
    site = Site(name="Curated Unique Site")
    db.add(site)
    await db.flush()
    site_id = site.id

    db.add(SiteSurveyEntry(site_id=site_id, field_key="dock_available",
                           value=True))
    await db.commit()

    db.add(SiteSurveyEntry(site_id=site_id, field_key="dock_available",
                           value=False))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # different field_key on the same site is fine
    db.add(SiteSurveyEntry(site_id=site_id, field_key="floor", value=2))
    await db.commit()


async def test_curated_raw_link(db):
    site = Site(name="Curated Raw Link Site")
    db.add(site)
    await db.flush()

    raw = RawSurveyEntry(site_id=site.id, field_key="dock_available",
                         value=True, captured_at=datetime.now(UTC))
    db.add(raw)
    await db.flush()

    db.add(SiteSurveyEntry(site_id=site.id, field_key="dock_available",
                           value=True, raw_id=raw.id))
    await db.commit()

    db.add(SiteSurveyEntry(site_id=site.id, field_key="floor",
                           value=2, raw_id=999999))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_survey_blob_column_gone(db):
    rows = (await db.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='sites' AND column_name='survey_data'"))).all()
    assert rows == []
    assert not hasattr(Site, "survey_data")
