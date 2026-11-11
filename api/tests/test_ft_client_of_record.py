"""From-To client of record (SS-526, SS-527): imported assets get the move's
client; a serial that belongs to another client is a conflict at the check
and needs a per-serial Continue/Skip choice at commit."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select

from serversherpa.clientgroups.keys import group_key
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AuditLog,
    Client,
    ClientGroup,
    ClientGroupAlias,
    ClientGroupDismissal,
    ImportJob,
    Initiative,
    InitiativeAsset,
)
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.notices import count_left_out
from serversherpa.imports.owner_check import unmatched_owner_count
from serversherpa.imports.parsing import CANONICAL
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import put_object


async def _clients(db, *names):
    out = [Client(name=n) for n in names]
    db.add_all(out)
    await db.flush()
    return out


async def _move(db, owner=None, name="Move FT"):
    ini = Initiative(name=name, initiative_type="move", status="planned",
                     client_id=owner.id if owner is not None else None)
    db.add(ini)
    await db.flush()
    return ini


async def _asset(db, serial, owner=None, move=None, **extra):
    asset = Asset(name=serial, serial_number=serial,
                  client_id=owner.id if owner is not None else None, **extra)
    db.add(asset)
    await db.flush()
    if move is not None:
        db.add(InitiativeAsset(initiative_id=move.id, asset_id=asset.id))
        await db.flush()
    return asset


def _row(n, **over):
    canonical = {c: "" for c in CANONICAL}
    canonical.update(over)
    return parse_row(n, canonical, dict(over), generate_serials=False)


async def _roster(db, move, asset):
    return await db.scalar(select(func.count()).select_from(InitiativeAsset).where(
        InitiativeAsset.initiative_id == move.id, InitiativeAsset.asset_id == asset.id))


async def _asset_audits(db, asset):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.entity_id == str(asset.id)))).all()


async def test_new_asset_gets_move_client(db):
    acme, = await _clients(db, "Acme")
    move = await _move(db, acme)
    await db.commit()
    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=[_row(2, serial_number="SN-NEW")], write=True)
    asset = await db.scalar(select(Asset).where(Asset.serial_number == "sn-new"))
    assert asset.client_id == acme.id
    assert result["details"][0]["status"] == "created"
    assert "client_moved_from" not in result["details"][0]
    assert result["summary"]["client_id"] == str(acme.id)
    assert result["summary"]["moved"] == 0 and result["summary"]["skipped"] == 0


async def test_existing_null_client_asset_gets_move_client(db):
    acme, = await _clients(db, "Acme")
    move = await _move(db, acme)
    asset = await _asset(db, "sn-free")
    await db.commit()
    check = await run_import(db, initiative_id=move.id, added_by=None,
                             rows=[_row(2, serial_number="sn-free")], write=False)
    assert check["details"][0]["status"] == "created"
    assert check["summary"]["conflicts"] == 0
    await db.refresh(asset)
    assert asset.client_id is None                       # validate writes nothing

    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=[_row(2, serial_number="sn-free")], write=True)
    await db.refresh(asset)
    assert asset.client_id == acme.id
    assert result["details"][0]["status"] == "created"
    assert "client_moved_from" not in result["details"][0]
    assert result["summary"]["moved"] == 0


async def test_same_client_no_conflict(db):
    acme, = await _clients(db, "Acme")
    move = await _move(db, acme)
    await _asset(db, "sn-mine", acme)
    await db.commit()
    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=[_row(2, serial_number="sn-mine")], write=False)
    assert result["details"][0]["status"] == "created"
    assert result["summary"]["conflicts"] == 0


async def test_validate_flags_conflict_with_current_client(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    other = await _asset(db, "sn-theirs", bravo)
    await db.commit()
    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=[_row(2, serial_number="SN-THEIRS"),
                                    _row(3, serial_number="sn-ok")], write=False)
    by_row = {d["row"]: d for d in result["details"]}
    assert by_row[2]["status"] == "conflict"
    assert by_row[2]["current_client"] == {"id": str(bravo.id), "name": "Bravo"}
    assert by_row[2]["serial_number"] == "sn-theirs"
    assert by_row[3]["status"] == "created"
    assert result["summary"]["conflicts"] == 1
    assert result["summary"]["created"] == 1 and result["summary"]["updated"] == 0
    assert result["summary"]["client_id"] == str(acme.id)
    await db.refresh(other)
    assert other.client_id == bravo.id
    assert await _roster(db, move, other) == 0


async def test_continue_reassigns_and_audits(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    bravo_move = await _move(db, bravo, name="Bravo move")
    away = await _asset(db, "sn-away", bravo, bravo_move)     # only on Bravo's move
    here = await _asset(db, "sn-here", bravo, move)           # already on this roster
    await db.commit()
    job_id = uuid.uuid4()
    result = await run_import(
        db, initiative_id=move.id, added_by=None, job_id=job_id, write=True,
        rows=[_row(2, serial_number="sn-away"), _row(3, serial_number="sn-here")],
        client_choices={"sn-away": "continue", "sn-here": "continue"})

    by_row = {d["row"]: d for d in result["details"]}
    # processed as usual once reassigned: added to this roster / updated on it
    assert by_row[2]["status"] == "created"
    assert by_row[3]["status"] == "updated"
    for d in by_row.values():
        assert d["client_moved_from"] == {"id": str(bravo.id), "name": "Bravo"}
    assert result["summary"]["moved"] == 2
    assert result["summary"]["skipped"] == 0

    for asset in (away, here):
        await db.refresh(asset)
        assert asset.client_id == acme.id
        [log] = await _asset_audits(db, asset)
        assert log.action == "update"
        assert log.changes["client_id"] == {"from": str(bravo.id), "to": str(acme.id)}
        assert log.changes["source"] == {"from": None, "to": "from_to_import"}
        assert log.changes["job_id"] == str(job_id)
    assert await _roster(db, move, away) == 1
    assert await _roster(db, bravo_move, away) == 1           # Bravo's row stays put


async def test_skip_leaves_asset_and_adds_no_roster_row(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    other = await _asset(db, "sn-theirs", bravo, rfid_tag=None)
    await db.commit()
    result = await run_import(
        db, initiative_id=move.id, added_by=None, write=True,
        rows=[_row(2, serial_number="sn-theirs", rfid_tag="TAG-1", source_pod="P9")],
        client_choices={"sn-theirs": "skip"})
    [d] = result["details"]
    assert d["status"] == "skipped"
    assert d["current_client"] == {"id": str(bravo.id), "name": "Bravo"}
    assert result["summary"]["skipped"] == 1
    assert result["summary"]["moved"] == 0
    assert result["summary"]["created"] == 0 and result["summary"]["updated"] == 0
    await db.refresh(other)
    assert other.client_id == bravo.id
    assert other.rfid_tag is None and other.pod_number is None
    assert await _roster(db, move, other) == 0
    assert await _asset_audits(db, other) == []


async def test_new_conflict_at_commit_is_skipped(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    other = await _asset(db, "sn-late", bravo)
    await db.commit()
    for choices in (None, {}, {"sn-else": "continue"}):
        result = await run_import(
            db, initiative_id=move.id, added_by=None, write=True,
            rows=[_row(2, serial_number="sn-late")], client_choices=choices)
        assert result["details"][0]["status"] == "skipped"
        assert result["summary"]["skipped"] == 1
    await db.refresh(other)
    assert other.client_id == bravo.id
    assert await _roster(db, move, other) == 0


async def test_duplicate_conflict_serial_one_choice(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    go = await _asset(db, "sn-go", bravo)
    stay = await _asset(db, "sn-stay", bravo)
    await db.commit()
    rows = [_row(2, serial_number="sn-go"), _row(3, serial_number="sn-stay"),
            _row(4, serial_number="SN-GO"), _row(5, serial_number="sn-stay")]

    check = await run_import(db, initiative_id=move.id, added_by=None,
                             rows=rows, write=False)
    assert [d["status"] for d in check["details"]] == ["conflict"] * 4
    assert check["summary"]["conflicts"] == 4

    result = await run_import(db, initiative_id=move.id, added_by=None, write=True,
                              rows=rows,
                              client_choices={"sn-go": "continue", "sn-stay": "skip"})
    by_row = {d["row"]: d for d in result["details"]}
    assert by_row[2]["status"] == "created" and "client_moved_from" in by_row[2]
    assert by_row[4]["status"] == "updated"               # same device, already moved
    assert by_row[3]["status"] == by_row[5]["status"] == "skipped"
    assert result["summary"]["moved"] == 1
    assert result["summary"]["skipped"] == 2
    await db.refresh(go)
    await db.refresh(stay)
    assert go.client_id == acme.id and stay.client_id == bravo.id
    assert len(await _asset_audits(db, go)) == 1
    assert await _roster(db, move, go) == 1
    assert await _roster(db, move, stay) == 0


async def test_archived_asset_conflicts_too(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    await _asset(db, "sn-old", bravo, archived_at=datetime.now(UTC))
    await db.commit()
    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=[_row(2, serial_number="sn-old")], write=False)
    assert result["details"][0]["status"] == "conflict"
    assert result["details"][0]["current_client"]["name"] == "Bravo"


async def test_move_without_client_unchanged(db):
    bravo, = await _clients(db, "Bravo")
    move = await _move(db)
    theirs = await _asset(db, "sn-theirs", bravo)
    await db.commit()
    rows = [_row(2, serial_number="sn-new", owner="Platform"),
            _row(3, serial_number="sn-theirs")]
    check = await run_import(db, initiative_id=move.id, added_by=None,
                             rows=rows, write=False)
    assert [d["status"] for d in check["details"]] == ["created", "created"]
    assert check["summary"]["conflicts"] == 0
    assert check["summary"]["client_id"] is None
    assert "owner_unmatched" not in check["summary"]

    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=rows, write=True)
    assert [d["status"] for d in result["details"]] == ["created", "created"]
    assert result["summary"]["skipped"] == 0 and result["summary"]["moved"] == 0
    new = await db.scalar(select(Asset).where(Asset.serial_number == "sn-new"))
    assert new.client_id is None
    await db.refresh(theirs)
    assert theirs.client_id == bravo.id
    assert await _roster(db, move, theirs) == 1


async def test_owner_unmatched_count(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    group = ClientGroup(client_id=acme.id, name="Platform", name_key=group_key("Platform"))
    db.add(group)
    # Bravo's group must not count for Acme
    db.add(ClientGroup(client_id=bravo.id, name="Unknown A", name_key=group_key("Unknown A")))
    await db.flush()
    db.add(ClientGroupAlias(group_id=group.id, client_id=acme.id, alias="Storage Team",
                            alias_key=group_key("Storage Team")))
    db.add(ClientGroupDismissal(client_id=acme.id, value_key=group_key("Ignore Me")))
    move = await _move(db, acme)
    await db.commit()

    owners = ["Platform", " platform ", "storage  team", "Ignore me", "", "   ", None,
              "Unknown A", "unknown   a", "Other"]
    assert await unmatched_owner_count(db, acme.id, owners) == 2   # unknown a, other
    assert await unmatched_owner_count(db, acme.id, []) == 0

    rows = [_row(i + 2, serial_number=f"sn-{i}", owner=o or "")
            for i, o in enumerate(owners)]
    check = await run_import(db, initiative_id=move.id, added_by=None,
                             rows=rows, write=False)
    assert check["summary"]["owner_unmatched"] == 2
    result = await run_import(db, initiative_id=move.id, added_by=None,
                              rows=rows, write=True)
    assert "owner_unmatched" not in result["summary"]


def test_skipped_counts_as_left_out():
    assert count_left_out({"errors": 1, "review": 2, "skipped": 3, "created": 9}) == 6
    assert count_left_out({"skipped": 1}) == 1


# ── the worker hands the job's choices and the wizard draft's client in ──

async def _file_job(db, *, initiative_id, phase, options, content):
    job = ImportJob(kind="move_assets", initiative_id=initiative_id, filename="ft.csv",
                    phase=phase, status="queued", options=options)
    db.add(job)
    await db.flush()
    key = f"import-jobs/{initiative_id or 'draft'}/{job.id}/ft.csv"
    await put_object(key, content, "text/csv")
    job.file_key = key
    await db.commit()
    return job.id


async def test_worker_commit_applies_job_choices(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    move = await _move(db, acme)
    go = await _asset(db, "sn-go", bravo)
    stay = await _asset(db, "sn-stay", bravo)
    await db.commit()
    acme_id, bravo_id, go_id, stay_id = acme.id, bravo.id, go.id, stay.id
    job_id = await _file_job(
        db, initiative_id=move.id, phase="commit",
        options={"client_choices": {"sn-go": "continue", "sn-stay": "skip"}},
        content=b"Serial Number\nSN-GO\nSN-STAY\n")
    assert await run_once(get_sessionmaker()) is True
    db.expire_all()
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert job.results["summary"]["moved"] == 1
    assert job.results["summary"]["skipped"] == 1
    assert (await db.get(Asset, go_id)).client_id == acme_id
    assert (await db.get(Asset, stay_id)).client_id == bravo_id
    [log] = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.entity_id == str(go_id)))).all()
    assert log.changes["job_id"] == str(job_id)


async def test_wizard_check_reads_draft_client(db):
    acme, bravo = await _clients(db, "Acme", "Bravo")
    await _asset(db, "sn-theirs", bravo)
    draft = ImportJob(kind="move_setup", filename="", phase="commit", status="preview",
                      options={},
                      payload={"move": {"name": "Draft move", "client_id": str(acme.id)},
                               "assets": None, "crates": None, "trucks": None})
    db.add(draft)
    await db.commit()
    acme_id = acme.id
    job_id = await _file_job(db, initiative_id=None, phase="validate",
                             options={"move_setup_id": str(draft.id)},
                             content=b"Serial Number\nSN-THEIRS\nSN-NEW\n")
    assert await run_once(get_sessionmaker()) is True
    db.expire_all()
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    summary = job.results["summary"]
    assert summary["client_id"] == str(acme_id)
    assert summary["conflicts"] == 1
    assert [d["status"] for d in job.results["details"]] == ["conflict", "created"]
