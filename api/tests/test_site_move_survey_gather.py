"""Tests for `reports/site_move_survey/gather.py` — the DB read step
that assembles `SurveyData`. Seeds everything through the ORM directly
against the real test database (and the real dev MinIO bucket via
`put_object`/`get_object`, the same pattern `test_report_worker.py` and
`test_import_worker.py` use), rather than mocking the DB or storage. See
docs/superpowers/specs/2026-09-11-site-move-survey-design.md § "Report
module" (the `gather` bullet) and
/Users/jrh1812/Developer/BaseCampV2-reference/api/reports/site_move_survey.py
(read-only reference) for the resolution rules this ports where V3's
schema still supports them.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, Attachment, Initiative, InitiativeAsset, Partner, Person,
    ReportDefinition, ReportRun, Site, SiteSurveyEntry,
)
from serversherpa.reports.site_move_survey.assets import AssetRowInput
from serversherpa.reports.site_move_survey.gather import SurveyGatherError, gather
from serversherpa.services.storage import get_object, put_object

XLSX_BYTES_1 = b"PK\x03\x04 fake xlsx template (older)"
XLSX_BYTES_2 = b"PK\x03\x04 fake xlsx template (newer)"
DOCX_BYTES = b"PK\x03\x04 fake standards docx"
PHOTO_BYTES = b"fake photo bytes"


def _partner(**kw):
    base = dict(id=uuid.uuid4(), name="Champagne Logistics", partner_types=["logistics"])
    base.update(kw)
    return Partner(**base)


def _site(**kw):
    base = dict(id=uuid.uuid4(), name="Datacenter West", address_line1="300 Origin St",
                city="Seattle", region="WA", postal_code="98101", country="US")
    base.update(kw)
    return Site(**base)


def _person(**kw):
    base = dict(id=uuid.uuid4(), first_name="Jimmy", last_name="Henderson",
                email="jimmy@cumulus.example")
    base.update(kw)
    return Person(**base)


def _asset_model(**kw):
    base = dict(id=uuid.uuid4(), make="Dell", model="R740", ru_size=2,
               weight_lbs=Decimal("55.50"))
    base.update(kw)
    return AssetModel(**base)


def _asset(**kw):
    base = dict(id=uuid.uuid4(), name="db-01", serial_number="SN-001", rfid_tag="RFID-1")
    base.update(kw)
    return Asset(**base)


async def _attachment(db, *, entity_type, entity_id, kind, filename, content_type,
                      storage_key, content, created_at, id=None):
    await put_object(storage_key, content, content_type)
    kwargs = dict(entity_type=entity_type, entity_id=entity_id, kind=kind,
                 storage_key=storage_key, filename=filename, content_type=content_type,
                 size_bytes=len(content), created_at=created_at)
    if id is not None:
        kwargs["id"] = id
    att = Attachment(**kwargs)
    db.add(att)
    await db.flush()
    return att


def _times(n):
    """`n` strictly increasing timestamps, oldest first — used so
    "newest wins" queries (`ORDER BY created_at DESC`) have an
    unambiguous answer regardless of how fast the test runs."""
    base = datetime(2026, 1, 1, tzinfo=UTC)
    return [base + timedelta(minutes=i) for i in range(n)]


@pytest.fixture
async def requester(db):
    person = _person(first_name="Rae", last_name="Requester", email="rae@cumulus.example")
    db.add(person)
    await db.flush()
    return person


async def _definition(db):
    """The report definition a run belongs to — also where the
    survey_template attachment (and report_asset docx) now lives, since
    templates are company-owned rather than partner-owned. Looked up by
    name first (clean_db TRUNCATEs report_definitions between tests, so
    this may create a fresh one), the same recipe `_run()` used before it
    was factored out."""
    definition = await db.scalar(select(ReportDefinition).where(
        ReportDefinition.name == "Site & Move Survey Test"))
    if definition is None:
        definition = ReportDefinition(name="Site & Move Survey Test",
                                      report_type="site_move_survey", options={})
        db.add(definition)
        await db.flush()
    return definition


async def _run(db, *, requester, definition=None, initiative=None, options):
    if definition is None:
        definition = await _definition(db)
    run = ReportRun(definition_id=definition.id, report_type="site_move_survey",
                    initiative_id=initiative.id if initiative is not None else None,
                    options=options, requested_by=requester.id, requested_rank=0)
    db.add(run)
    await db.flush()
    return run, definition


# ---------------------------------------------------------------------------
# The full happy path — every field
# ---------------------------------------------------------------------------

async def test_gather_assembles_every_field(db, requester):
    t0, t1, t2 = _times(3)
    partner = _partner()
    origin = _site(name="Datacenter West", city="Seattle")
    destination = _site(name="Datacenter East", city="Ashburn", id=uuid.uuid4(),
                        address_line1="900 Destination Ave", region="VA",
                        postal_code="20147")
    contact = _person(first_name="Bob", last_name="Origin", email="bob@partner.example")
    db.add_all([partner, origin, destination, contact])
    await db.flush()

    db.add_all([
        SiteSurveyEntry(site_id=origin.id, field_key="contact_name", value="Bob Origin"),
        SiteSurveyEntry(site_id=origin.id, field_key="dock_available", value=True),
        SiteSurveyEntry(site_id=destination.id, field_key="contact_name", value="Deb Dest"),
        SiteSurveyEntry(site_id=destination.id, field_key="forklift_required", value=False),
    ])

    model = _asset_model()
    asset1 = _asset(name="db-01", serial_number="SN-001")
    asset2 = _asset(name="db-02", serial_number="SN-002", id=uuid.uuid4(), rfid_tag="RFID-2")
    db.add_all([model, asset1, asset2])
    await db.flush()

    initiative = Initiative(name="Champagne Move", initiative_type="move", status="planned",
                            origin_site_id=origin.id, destination_site_id=destination.id)
    db.add(initiative)
    await db.flush()

    # AssetModel is linked via Asset.model_id, not InitiativeAsset.
    asset1.model_id = model.id
    asset2.model_id = model.id
    db.add_all([
        InitiativeAsset(initiative_id=initiative.id, asset_id=asset1.id,
                        source_rack="RACK-12", source_ru=Decimal("20")),
        InitiativeAsset(initiative_id=initiative.id, asset_id=asset2.id,
                        source_rack="RACK-13", source_ru=Decimal("5")),
    ])
    await db.flush()

    definition = await _definition(db)

    # Two survey_template attachments on the report definition — the
    # newer one wins.
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="old_template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/old.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="new_template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/new.xlsx", content=XLSX_BYTES_2,
                      created_at=t1)

    photo_att = await _attachment(
        db, entity_type="site", entity_id=origin.id, kind="photo", filename="dock.jpg",
        content_type="image/jpeg", storage_key=f"test/sms/{origin.id}/dock.jpg",
        content=PHOTO_BYTES, created_at=t0)

    run, definition = await _run(db, requester=requester, definition=definition, initiative=initiative,
                                 options={"partner_id": str(partner.id), "asset_notes": "handle with care"})

    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="report_asset", filename="Transportation Standards.docx",
                      content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      storage_key=f"test/sms/{definition.id}/standards.docx", content=DOCX_BYTES,
                      created_at=t2)

    data = await gather(db, run)

    assert data.partner.id == partner.id
    assert data.contact is not None and data.contact.id == requester.id  # no contact_person_id given
    assert data.client_address == ""
    assert data.initiative.id == initiative.id
    assert data.origin.id == origin.id
    assert data.destination.id == destination.id
    assert data.origin_survey == {"contact_name": "Bob Origin", "dock_available": True}
    assert data.destination_survey == {"contact_name": "Deb Dest", "forklift_required": False}

    assert len(data.assets) == 2
    for row in data.assets:
        assert isinstance(row, AssetRowInput)
    by_serial = {row.serial: row for row in data.assets}
    assert by_serial["SN-001"].rack == "RACK-12"
    assert by_serial["SN-001"].ru_position == 20.0
    assert by_serial["SN-002"].rack == "RACK-13"
    assert by_serial["SN-002"].ru_position == 5.0
    assert all(row.make == "Dell" and row.model == "R740" and row.ru_size == 2
              for row in data.assets)

    assert data.asset_notes == "handle with care"
    assert data.template_bytes == XLSX_BYTES_2  # newest wins, not the older one
    assert data.standards_docx_bytes == DOCX_BYTES
    assert data.standards_attachment_id is not None

    assert data.photos == [("Origin: Datacenter West", [PHOTO_BYTES])]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

async def test_missing_partner_id_option_raises_partner_not_found(db, requester):
    run, _ = await _run(db, requester=requester, options={})
    with pytest.raises(SurveyGatherError) as exc_info:
        await gather(db, run)
    assert exc_info.value.code == "partner_not_found"


async def test_unknown_partner_id_raises_partner_not_found(db, requester):
    run, _ = await _run(db, requester=requester, options={"partner_id": str(uuid.uuid4())})
    with pytest.raises(SurveyGatherError) as exc_info:
        await gather(db, run)
    assert exc_info.value.code == "partner_not_found"


async def test_non_logistics_partner_raises_partner_not_logistics(db, requester):
    partner = _partner(partner_types=["staffing"])
    db.add(partner)
    await db.flush()
    run, _ = await _run(db, requester=requester, options={"partner_id": str(partner.id)})
    with pytest.raises(SurveyGatherError) as exc_info:
        await gather(db, run)
    assert exc_info.value.code == "partner_not_logistics"


async def test_logistics_partner_with_no_template_raises_no_survey_template(db, requester):
    partner = _partner()
    db.add(partner)
    await db.flush()
    run, _ = await _run(db, requester=requester, options={"partner_id": str(partner.id)})
    with pytest.raises(SurveyGatherError) as exc_info:
        await gather(db, run)
    assert exc_info.value.code == "no_survey_template"


async def test_survey_template_still_on_the_partner_is_ignored(db, requester):
    """A `survey_template` attachment still sitting on the partner (a
    legacy row from before migration 0053 moved templates onto the
    report definition) must not be picked up — only a report_definition-
    scoped row counts, so this still raises `no_survey_template`."""
    t0, = _times(1)
    partner = _partner()
    db.add(partner)
    await db.flush()

    await _attachment(db, entity_type="partner", entity_id=partner.id, kind="survey_template",
                      filename="legacy_template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{partner.id}/legacy.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)

    run, _ = await _run(db, requester=requester, options={"partner_id": str(partner.id)})
    with pytest.raises(SurveyGatherError) as exc_info:
        await gather(db, run)
    assert exc_info.value.code == "no_survey_template"


async def test_newest_survey_template_ties_break_on_id_desc(db, requester):
    """Two survey_template attachments with the identical `created_at`
    must resolve deterministically via the `id` DESC tie-break — not
    whichever row the database happens to return first. Explicit,
    ordered ids (rather than the random ones `gen_random_uuid()` would
    assign) make which one "wins" predictable for the assertion."""
    t0, = _times(1)
    partner = _partner()
    db.add(partner)
    await db.flush()
    definition = await _definition(db)

    lower_id = uuid.UUID(int=1)
    higher_id = uuid.UUID(int=2)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template", filename="lower_id.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/lower.xlsx", content=XLSX_BYTES_1,
                      created_at=t0, id=lower_id)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template", filename="higher_id.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/higher.xlsx", content=XLSX_BYTES_2,
                      created_at=t0, id=higher_id)

    run, _ = await _run(db, requester=requester, definition=definition,
                        options={"partner_id": str(partner.id)})
    data = await gather(db, run)
    assert data.template_bytes == XLSX_BYTES_2  # higher id wins the created_at tie


# ---------------------------------------------------------------------------
# Site override + no-initiative run
# ---------------------------------------------------------------------------

async def test_run_options_override_the_initiatives_sites(db, requester):
    t0, = _times(1)
    partner = _partner()
    ini_origin = _site(name="Initiative Origin")
    ini_destination = _site(name="Initiative Destination", id=uuid.uuid4())
    override_origin = _site(name="Override Origin", id=uuid.uuid4())
    override_destination = _site(name="Override Destination", id=uuid.uuid4())
    db.add_all([partner, ini_origin, ini_destination, override_origin, override_destination])
    await db.flush()

    initiative = Initiative(name="Move With Overrides", initiative_type="move", status="planned",
                            origin_site_id=ini_origin.id, destination_site_id=ini_destination.id)
    db.add(initiative)
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)

    run, _ = await _run(db, requester=requester, definition=definition, initiative=initiative, options={
        "partner_id": str(partner.id),
        "source_site_id": str(override_origin.id),
        "destination_site_id": str(override_destination.id),
    })

    data = await gather(db, run)
    assert data.origin.id == override_origin.id
    assert data.destination.id == override_destination.id


async def test_non_move_initiative_never_seeds_sites_from_its_site_columns(db, requester):
    """`Initiative`'s move-only site columns are retained (not wiped) if
    an admin changes its type away from `move` (db/models.py's
    docstring), so a `project`-type initiative with populated
    `origin_site_id`/`destination_site_id` must not leak stale sites into
    the survey — only run options may supply sites for non-move types."""
    t0, = _times(1)
    partner = _partner()
    stale_origin = _site(name="Stale Origin")
    stale_destination = _site(name="Stale Destination", id=uuid.uuid4())
    option_origin = _site(name="Option Origin", id=uuid.uuid4())
    db.add_all([partner, stale_origin, stale_destination, option_origin])
    await db.flush()

    initiative = Initiative(name="Some Project", initiative_type="project", status="planned",
                            origin_site_id=stale_origin.id, destination_site_id=stale_destination.id)
    db.add(initiative)
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)

    # No site options at all: the stale move-only columns must not leak.
    run_no_options, _ = await _run(db, requester=requester, definition=definition, initiative=initiative,
                                   options={"partner_id": str(partner.id)})
    data_no_options = await gather(db, run_no_options)
    assert data_no_options.origin is None
    assert data_no_options.destination is None

    # Option sites still win when given.
    run_with_option, _ = await _run(db, requester=requester, definition=definition, initiative=initiative, options={
        "partner_id": str(partner.id), "source_site_id": str(option_origin.id),
    })
    data_with_option = await gather(db, run_with_option)
    assert data_with_option.origin.id == option_origin.id
    assert data_with_option.destination is None


async def test_no_initiative_run_uses_option_sites_and_has_zero_assets(db, requester):
    t0, = _times(1)
    partner = _partner()
    origin = _site(name="Standalone Origin")
    destination = _site(name="Standalone Destination", id=uuid.uuid4())
    db.add_all([partner, origin, destination])
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)

    run, _ = await _run(db, requester=requester, definition=definition, initiative=None, options={
        "partner_id": str(partner.id),
        "source_site_id": str(origin.id),
        "destination_site_id": str(destination.id),
    })

    data = await gather(db, run)
    assert data.initiative is None
    assert data.origin.id == origin.id
    assert data.destination.id == destination.id
    assert data.assets == []
    assert data.standards_docx_bytes is None
    assert data.standards_attachment_id is None


# ---------------------------------------------------------------------------
# Contact override, and photos capped at 10
# ---------------------------------------------------------------------------

async def test_contact_person_id_option_overrides_the_requester(db, requester):
    t0, = _times(1)
    partner = _partner()
    contact = _person(first_name="Chosen", last_name="Contact", email="chosen@cumulus.example")
    db.add_all([partner, contact])
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)

    run, _ = await _run(db, requester=requester, definition=definition, options={
        "partner_id": str(partner.id), "contact_person_id": str(contact.id),
    })

    data = await gather(db, run)
    assert data.contact.id == contact.id


async def test_site_photos_are_capped_at_ten_newest_first(db, requester):
    times = _times(12)
    partner = _partner()
    origin = _site(name="Photo Site")
    db.add_all([partner, origin])
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=times[0])

    # 12 photos, each with distinguishable content and a strictly
    # increasing created_at — the newest 10 should come back, newest
    # first.
    for i in range(12):
        await _attachment(
            db, entity_type="site", entity_id=origin.id, kind="photo",
            filename=f"photo{i}.jpg", content_type="image/jpeg",
            storage_key=f"test/sms/{origin.id}/photo{i}.jpg",
            content=f"photo-{i}".encode(), created_at=times[i])

    run, _ = await _run(db, requester=requester, definition=definition, options={
        "partner_id": str(partner.id), "source_site_id": str(origin.id),
    })

    data = await gather(db, run)
    assert len(data.photos) == 1
    label, images = data.photos[0]
    assert label == "Origin: Photo Site"
    assert len(images) == 10
    assert images[0] == b"photo-11"  # newest (index 11, created last) first
    assert images[-1] == b"photo-2"  # the two oldest (0, 1) were dropped


async def test_photos_skip_destination_when_it_is_the_same_site_as_origin(db, requester):
    """An origin/destination override pair (or a move whose two ends
    were set to the same site) must not show one site's photos twice
    under both an "Origin:" and a "Destination:" heading."""
    t0, = _times(1)
    partner = _partner()
    shared_site = _site(name="Shared Site")
    db.add_all([partner, shared_site])
    await db.flush()

    definition = await _definition(db)
    await _attachment(db, entity_type="report_definition", entity_id=definition.id,
                      kind="survey_template",
                      filename="template.xlsx",
                      content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      storage_key=f"test/sms/{definition.id}/t.xlsx", content=XLSX_BYTES_1,
                      created_at=t0)
    await _attachment(db, entity_type="site", entity_id=shared_site.id, kind="photo",
                      filename="dock.jpg", content_type="image/jpeg",
                      storage_key=f"test/sms/{shared_site.id}/dock.jpg", content=PHOTO_BYTES,
                      created_at=t0)

    run, _ = await _run(db, requester=requester, definition=definition, options={
        "partner_id": str(partner.id),
        "source_site_id": str(shared_site.id),
        "destination_site_id": str(shared_site.id),
    })

    data = await gather(db, run)
    assert data.origin.id == shared_site.id
    assert data.destination.id == shared_site.id
    assert data.photos == [("Origin: Shared Site", [PHOTO_BYTES])]
