"""Data cleanup, "Old history" group: mail, notifications, finished import
jobs, report runs, label runs, spec lookups and status rule logs, plus the
keys_in_use helper that decides whether a stored file can go."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset,
    AssetModel,
    Attachment,
    AuditLog,
    Client,
    EmailOutbox,
    GeneratedLabel,
    ImportJob,
    Initiative,
    LabelFont,
    LabelGenerationRun,
    LabelTemplate,
    Notification,
    Partner,
    Person,
    ReportDefinition,
    ReportRun,
    SpecLookupJob,
    SpecSuggestion,
    StatusRuleExecution,
)
from tests.test_cleanup_api import _by_key, _developer, _run

NOW = datetime.now(UTC)
OLD = NOW - timedelta(days=100)
RECENT = NOW - timedelta(days=5)
AGE = 30


@pytest.fixture
def storage_calls(monkeypatch):
    """Fake object storage: records every key the cleanup deletes; a key in
    `fail` raises instead."""
    class Calls:
        deleted: list[str]
        fail: set[str]

    calls = Calls()
    calls.deleted, calls.fail = [], set()

    async def fake_delete(key):
        if key in calls.fail:
            raise RuntimeError("storage down")
        calls.deleted.append(key)

    monkeypatch.setattr("serversherpa.devtools.cleanup.storage.delete_object", fake_delete)
    return calls


async def _go(client, db, seeded_user, category):
    hdrs = await _developer(db, client, seeded_user)
    resp = await _run(client, hdrs, "history", [category], AGE)
    assert resp.status_code == 200, resp.text
    return _by_key(resp.json()["categories"])[category], hdrs


async def _ids(db, model, *ids):
    db.expire_all()
    rows = await db.scalars(select(model.id).where(model.id.in_(ids)))
    return set(rows)


def _idmap(rows):
    return {name: row.id for name, row in rows.items()}


def _key():
    return f"cleanup-test/{uuid.uuid4().hex}"


# -- registry ----------------------------------------------------------


def test_history_group_has_the_seven_categories_in_order():
    from serversherpa.devtools import cleanup

    group = cleanup.GROUPS["history"]
    assert [(c.key, c.label) for c in group.categories] == [
        ("mail", "Sent, failed and skipped mail"),
        ("notifications", "Read or hidden notifications"),
        ("imports", "Finished import jobs"),
        ("reports", "Report runs"),
        ("label_runs", "Label generation runs"),
        ("spec_lookups", "Finished spec lookups"),
        ("rule_logs", "Status rule run logs"),
    ]
    assert all(c.description for c in group.categories)


def test_terminal_statuses_are_the_ones_the_workers_write():
    from serversherpa.devtools import cleanup

    assert set(cleanup.IMPORT_DONE) == {"completed", "failed", "cancelled"}
    assert set(cleanup.REPORT_DONE) == {"completed", "failed"}
    assert set(cleanup.LABEL_RUN_DONE) == {"completed", "failed", "canceled"}
    assert set(cleanup.SPEC_JOB_DONE) == {"done", "failed"}
    assert set(cleanup.MAIL_DONE) == {"sent", "failed", "skipped"}


# -- mail --------------------------------------------------------------


def _mail(status, created):
    return EmailOutbox(template="t", to_address="a@example.com", subject="s",
                       html_body="h", text_body="t", status=status, created_at=created)


async def test_mail_old_finished_goes_queued_sending_and_recent_stay(
        client, db, seeded_user, storage_calls):
    rows = {n: _mail(s, c) for n, s, c in [
        ("sent", "sent", OLD), ("failed", "failed", OLD), ("skipped", "skipped", OLD),
        ("queued", "queued", OLD), ("sending", "sending", OLD),
        ("recent", "sent", RECENT)]}
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "mail")
    assert res["rows_deleted"] == 3
    kept = await _ids(db, EmailOutbox, *ids.values())
    assert kept == {ids[n] for n in ("queued", "sending", "recent")}


# -- notifications -----------------------------------------------------


def _note(seeded_user, *, read=None, dismissed=None, created=OLD, payload=None):
    return Notification(person_id=seeded_user.id, kind="test", title="t",
                        read_at=read, dismissed_at=dismissed, created_at=created,
                        payload=payload if payload is not None else {})


async def test_notifications_read_or_hidden_old_go_the_rest_stay(
        client, db, seeded_user, storage_calls):
    rows = {
        "read": _note(seeded_user, read=OLD),
        "dismissed": _note(seeded_user, dismissed=OLD),
        "unread": _note(seeded_user),
        "pending": _note(seeded_user, read=OLD, payload={"state": "pending"}),
        "open": _note(seeded_user, read=OLD, payload={"state": "open"}),
        "approved": _note(seeded_user, read=OLD, payload={"state": "approved"}),
        "recent": _note(seeded_user, read=RECENT, created=RECENT),
    }
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "notifications")
    assert res["rows_deleted"] == 3                    # read, dismissed, approved
    kept = await _ids(db, Notification, *ids.values())
    assert kept == {ids[n] for n in ("unread", "pending", "open", "recent")}


# -- imports -----------------------------------------------------------


def _job(status, *, finished=OLD, key="", kind="move_assets", **kw):
    return ImportJob(kind=kind, filename="f.csv", file_key=key, status=status,
                     finished_at=finished, **kw)


async def test_imports_terminal_old_go_with_their_file(
        client, db, seeded_user, storage_calls):
    keys = {n: _key() for n in ("completed", "failed", "cancelled", "queued", "running",
                                "preview", "recent")}
    rows = {
        "completed": _job("completed", key=keys["completed"]),
        "failed": _job("failed", key=keys["failed"]),
        "cancelled": _job("cancelled", key=keys["cancelled"]),
        "queued": _job("queued", key=keys["queued"], finished=None),
        "running": _job("running", key=keys["running"], finished=None),
        "preview": _job("preview", key=keys["preview"], finished=None),
        "recent": _job("completed", key=keys["recent"], finished=RECENT),
        "nofile": _job("completed", key=""),
    }
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res == {"key": "imports", "rows_deleted": 4, "files_deleted": 3,
                   "files_kept": 0, "files_failed": 0}
    assert sorted(storage_calls.deleted) == sorted(
        keys[n] for n in ("completed", "failed", "cancelled"))
    kept = await _ids(db, ImportJob, *ids.values())
    assert kept == {ids[n] for n in ("queued", "running", "preview", "recent")}


async def test_imports_a_file_a_kept_job_still_uses_is_kept(
        client, db, seeded_user, storage_calls):
    shared = _key()
    old = _job("completed", key=shared)
    reprocess = _job("queued", key=shared, finished=None)     # a reprocess child
    db.add_all([old, reprocess])
    await db.commit()
    old_id, reprocess_id = old.id, reprocess.id
    res, _ = await _go(client, db, seeded_user, "imports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (1, 0, 1)
    assert storage_calls.deleted == []
    assert await _ids(db, ImportJob, old_id, reprocess_id) == {reprocess_id}


async def test_imports_two_old_jobs_sharing_a_file_delete_it_once(
        client, db, seeded_user, storage_calls):
    shared = _key()
    db.add_all([_job("completed", key=shared), _job("failed", key=shared)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "imports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (2, 1, 0)
    assert storage_calls.deleted == [shared]


async def test_imports_a_check_a_kept_move_draft_points_at_stays(
        client, db, seeded_user, storage_calls):
    check = _job("completed", key=_key(), kind="move_assets")
    db.add(check)
    await db.flush()
    draft = ImportJob(kind="move_setup", filename="m", status="preview",
                      payload={"assets": {"check_job_id": str(check.id)}})
    other = _job("completed", key=_key())
    db.add_all([draft, other])
    await db.commit()
    check_id, other_id, draft_id = check.id, other.id, draft.id
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res["rows_deleted"] == 1
    assert await _ids(db, ImportJob, check_id, other_id, draft_id) == {check_id, draft_id}


async def test_imports_storage_failure_is_counted_rows_still_go(
        client, db, seeded_user, storage_calls):
    bad, good = _key(), _key()
    db.add_all([_job("completed", key=bad), _job("completed", key=good)])
    await db.commit()
    storage_calls.fail.add(bad)
    res, _ = await _go(client, db, seeded_user, "imports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_failed"]) == (2, 1, 1)
    assert storage_calls.deleted == [good]
    assert await db.scalar(select(func.count()).select_from(ImportJob)) == 0


# -- reports -----------------------------------------------------------


async def _report_fixture(db, seeded_user):
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:6]}", report_type="x", is_system=False)
    ini = Initiative(name=f"ini-{uuid.uuid4().hex[:6]}", initiative_type="move",
                     status="planned")
    db.add_all([d, ini])
    await db.flush()
    return d, ini


def _report(d, ini, person, status, *, key=None, finished=OLD, attachment=None):
    return ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                     requested_by=person.id, status=status, storage_key=key,
                     finished_at=finished, attachment_id=attachment)


async def test_reports_terminal_old_go_with_their_object(
        client, db, seeded_user, storage_calls):
    d, ini = await _report_fixture(db, seeded_user)
    k1, k2 = _key(), _key()
    rows = {
        "done": _report(d, ini, seeded_user, "completed", key=k1),
        "failed": _report(d, ini, seeded_user, "failed"),
        "queued": _report(d, ini, seeded_user, "queued", finished=None),
        "running": _report(d, ini, seeded_user, "running", finished=None),
        "recent": _report(d, ini, seeded_user, "completed", key=k2, finished=RECENT),
    }
    db.add_all(rows.values())
    await db.commit()
    ids = _idmap(rows)
    res, _ = await _go(client, db, seeded_user, "reports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (2, 1, 0)
    assert storage_calls.deleted == [k1]
    kept = await _ids(db, ReportRun, *ids.values())
    assert kept == {ids[n] for n in ("queued", "running", "recent")}


async def test_reports_object_shared_with_a_live_attachment_is_kept(
        client, db, seeded_user, storage_calls):
    d, ini = await _report_fixture(db, seeded_user)
    shared, gone_att_key = _key(), _key()
    att = Attachment(entity_type="initiative", entity_id=ini.id, kind="document",
                     storage_key=shared, filename="r.xlsx", content_type="x", size_bytes=1)
    soft = Attachment(entity_type="initiative", entity_id=ini.id, kind="document",
                      storage_key=gone_att_key, filename="r2.xlsx", content_type="x",
                      size_bytes=1, deleted_at=OLD)
    db.add_all([att, soft])
    await db.flush()
    r_live = _report(d, ini, seeded_user, "completed", key=shared, attachment=att.id)
    r_soft = _report(d, ini, seeded_user, "completed", key=gone_att_key, attachment=soft.id)
    db.add_all([r_live, r_soft])
    await db.commit()
    att_ids = (att.id, soft.id)
    res, _ = await _go(client, db, seeded_user, "reports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (2, 1, 1)
    assert storage_calls.deleted == [gone_att_key]
    assert await _ids(db, Attachment, *att_ids) == set(att_ids)


async def test_reports_object_also_used_by_a_kept_report_or_avatar_is_kept(
        client, db, seeded_user, storage_calls):
    d, ini = await _report_fixture(db, seeded_user)
    k_run, k_avatar, k_logo = _key(), _key(), _key()
    person = Person(first_name="A", last_name="B", avatar_key=k_avatar)
    cl = Client(name=f"c-{uuid.uuid4().hex[:6]}", logo_key=k_logo)
    db.add_all([person, cl])
    await db.flush()
    db.add_all([
        _report(d, ini, seeded_user, "completed", key=k_run),
        _report(d, ini, seeded_user, "queued", key=k_run, finished=None),
        _report(d, ini, seeded_user, "completed", key=k_avatar),
        _report(d, ini, seeded_user, "completed", key=k_logo),
    ])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "reports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (3, 0, 3)
    assert storage_calls.deleted == []


async def test_reports_storage_failure_is_counted_run_completes(
        client, db, seeded_user, storage_calls):
    d, ini = await _report_fixture(db, seeded_user)
    bad = _key()
    db.add(_report(d, ini, seeded_user, "completed", key=bad))
    await db.commit()
    storage_calls.fail.add(bad)
    res, _ = await _go(client, db, seeded_user, "reports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_failed"]) == (1, 0, 1)


# -- label runs --------------------------------------------------------


async def test_label_runs_terminal_old_go_labels_stay_with_no_run(
        client, db, seeded_user, storage_calls):
    inis = [Initiative(name=f"i{n}-{uuid.uuid4().hex[:5]}", initiative_type="move",
                       status="planned") for n in range(5)]
    tpl = LabelTemplate(name=f"tpl-{uuid.uuid4()}", label_type="top", size_key="4x2",
                        dpi_key="203", language_key="zpl", kind="code", code="{asset_id}")
    db.add_all(inis + [tpl])
    await db.flush()

    def run(ini, status, finished):
        return LabelGenerationRun(
            initiative_id=ini.id, label_types=["top"], status=status,
            requested_by=seeded_user.id, finished_at=finished)

    old_done = run(inis[0], "completed", OLD)
    old_failed = run(inis[1], "failed", OLD)
    old_canceled = run(inis[2], "canceled", OLD)
    running = run(inis[3], "running", None)
    recent = run(inis[4], "completed", RECENT)
    runs = [old_done, old_failed, old_canceled, running, recent]
    db.add_all(runs)
    await db.flush()
    labels = []
    for i, r in enumerate(runs):
        a = Asset(legacy_id=9000 + i, name="a", serial_number=f"S{i}")
        db.add(a)
        await db.flush()
        labels.append(GeneratedLabel(
            entity_type="asset", entity_id=a.id, initiative_id=r.initiative_id,
            label_type="top", template_id=tpl.id, template_version=1, language_key="zpl",
            dpi_key="203", size_key="4x2", code="X", run_id=r.id))
    db.add_all(labels)
    await db.commit()
    label_ids = [lb.id for lb in labels]
    run_ids_all = [r.id for r in runs]
    running_id, recent_id = running.id, recent.id

    res, _ = await _go(client, db, seeded_user, "label_runs")
    assert res["rows_deleted"] == 3
    assert await _ids(db, LabelGenerationRun, *run_ids_all) == {running_id, recent_id}
    db.expire_all()
    run_ids = dict((await db.execute(
        select(GeneratedLabel.id, GeneratedLabel.run_id)
        .where(GeneratedLabel.id.in_(label_ids)))).all())
    assert set(run_ids) == set(label_ids)                      # no label was deleted
    assert [run_ids[i] for i in label_ids] == [None, None, None, running_id, recent_id]


# -- spec lookups ------------------------------------------------------


async def test_spec_lookups_finished_old_go_suggestions_stay(
        client, db, seeded_user, storage_calls):
    models = [AssetModel(make="HPE", model=f"M{i}-{uuid.uuid4().hex[:4]}") for i in range(6)]
    db.add_all(models)
    await db.flush()

    def job(i, status, finished):
        return SpecLookupJob(model_id=models[i].id, status=status, finished_at=finished)

    done = job(0, "done", OLD)
    failed = job(1, "failed", OLD)
    queued = job(2, "queued", None)
    running = job(3, "running", None)
    recent = job(4, "done", RECENT)
    jobs = [done, failed, queued, running, recent]
    db.add_all(jobs)
    await db.flush()
    sugg = SpecSuggestion(model_id=models[0].id, job_id=done.id, field="ru_size", value="2",
                          source_url="https://example.com", quote="2U")
    db.add(sugg)
    await db.commit()
    job_ids, sugg_id = [j.id for j in jobs], sugg.id
    kept_expected = {queued.id, running.id, recent.id}

    res, _ = await _go(client, db, seeded_user, "spec_lookups")
    assert res["rows_deleted"] == 2
    assert await _ids(db, SpecLookupJob, *job_ids) == kept_expected
    db.expire_all()
    row = (await db.execute(
        select(SpecSuggestion.id, SpecSuggestion.job_id)
        .where(SpecSuggestion.id == sugg_id))).one()
    assert row.job_id is None                                  # kept, just unlinked


# -- rule logs ---------------------------------------------------------


async def test_rule_logs_old_go_recent_stay(client, db, seeded_user, storage_calls):
    def row(when):
        return StatusRuleExecution(rule_name="r", conditions_met=True, executed_at=when)

    old, recent = row(OLD), row(RECENT)
    db.add_all([old, recent])
    await db.commit()
    old_id, recent_id = old.id, recent.id
    res, _ = await _go(client, db, seeded_user, "rule_logs")
    assert res["rows_deleted"] == 1
    assert await _ids(db, StatusRuleExecution, old_id, recent_id) == {recent_id}


# -- preview -----------------------------------------------------------


async def test_preview_counts_rows_and_files_that_would_go(client, db, seeded_user):
    shared, solo = _key(), _key()
    db.add_all([
        _mail("sent", OLD),
        _job("completed", key=shared), _job("completed", key=shared),
        _job("queued", key=shared, finished=None),                 # keeps `shared`
        _job("completed", key=solo), _job("failed", key=solo),
        _job("completed", key=""),
    ])
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/cleanup/preview?older_than_days={AGE}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    history = next(g for g in resp.json()["groups"] if g["key"] == "history")
    cats = _by_key(history["categories"])
    assert (cats["mail"]["rows"], cats["mail"]["files"]) == (1, 0)
    assert (cats["imports"]["rows"], cats["imports"]["files"]) == (5, 1)   # only `solo`


async def test_preview_files_skips_objects_a_live_attachment_uses(client, db, seeded_user):
    d, ini = await _report_fixture(db, seeded_user)
    shared, solo = _key(), _key()
    att = Attachment(entity_type="initiative", entity_id=ini.id, kind="document",
                     storage_key=shared, filename="r", content_type="x", size_bytes=1)
    db.add(att)
    await db.flush()
    db.add_all([_report(d, ini, seeded_user, "completed", key=shared, attachment=att.id),
                _report(d, ini, seeded_user, "completed", key=solo)])
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/cleanup/preview?older_than_days={AGE}", headers=hdrs)
    history = next(g for g in resp.json()["groups"] if g["key"] == "history")
    reports = _by_key(history["categories"])["reports"]
    assert (reports["rows"], reports["files"]) == (2, 1)


# -- keys_in_use -------------------------------------------------------


async def test_keys_in_use_checks_every_table_that_holds_stored_keys(db, seeded_user):
    from serversherpa.devtools.cleanup import keys_in_use

    k = {n: _key() for n in ("att", "att_deleted", "report", "import", "avatar", "client",
                             "partner", "font", "font_deleted", "free")}
    ini = Initiative(name=f"i-{uuid.uuid4().hex[:5]}", initiative_type="move", status="planned")
    d = ReportDefinition(name=f"d-{uuid.uuid4().hex[:5]}", report_type="x")
    db.add_all([ini, d])
    await db.flush()
    db.add_all([
        Attachment(entity_type="initiative", entity_id=ini.id, kind="document",
                   storage_key=k["att"], filename="a", content_type="x", size_bytes=1),
        Attachment(entity_type="initiative", entity_id=ini.id, kind="document",
                   storage_key=k["att_deleted"], filename="a", content_type="x",
                   size_bytes=1, deleted_at=OLD),
        ReportRun(definition_id=d.id, report_type="x", initiative_id=ini.id,
                  requested_by=seeded_user.id, storage_key=k["report"]),
        _job("completed", key=k["import"]),
        Person(first_name="A", last_name="B", avatar_key=k["avatar"]),
        Client(name=f"c-{uuid.uuid4().hex[:5]}", logo_key=k["client"]),
        Partner(name=f"p-{uuid.uuid4().hex[:5]}", logo_key=k["partner"]),
        LabelFont(name=f"f{uuid.uuid4().hex[:5]}", storage_key=k["font"], size_bytes=1),
        LabelFont(name=f"g{uuid.uuid4().hex[:5]}", storage_key=k["font_deleted"],
                  size_bytes=1, deleted_at=OLD),
    ])
    await db.commit()
    used = await keys_in_use(db, set(k.values()))
    assert used == {k["att"], k["report"], k["import"], k["avatar"], k["client"],
                    k["partner"], k["font"]}
    assert await keys_in_use(db, set()) == set()


# -- audit -------------------------------------------------------------


async def test_a_history_run_writes_one_audit_row(client, db, seeded_user, storage_calls):
    db.add(_mail("sent", OLD))
    await db.commit()
    await _go(client, db, seeded_user, "mail")
    db.expire_all()
    rows = (await db.scalars(select(AuditLog).where(AuditLog.action == "cleanup.run"))).all()
    assert len(rows) == 1
    assert rows[0].changes["group"] == "history"
    assert rows[0].changes["older_than_days"] == AGE
    assert rows[0].changes["categories"]["mail"]["rows_deleted"] == 1


# -- chunking and edge cases -------------------------------------------


async def test_imports_in_small_chunks_still_delete_a_shared_file_once_it_is_free(
        client, db, seeded_user, storage_calls, monkeypatch):
    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    shared = _key()
    db.add_all([_job("completed", key=shared) for _ in range(3)]
               + [_job("completed", key=_key()) for _ in range(2)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res["rows_deleted"] == 5
    assert await db.scalar(select(func.count()).select_from(ImportJob)) == 0
    # the shared object is only free in the chunk that holds its last row
    assert len(storage_calls.deleted) == 3 and storage_calls.deleted.count(shared) == 1


async def test_a_draft_that_is_itself_purged_does_not_protect_its_check(
        client, db, seeded_user, storage_calls):
    check = _job("completed", key=_key())
    db.add(check)
    await db.flush()
    draft = ImportJob(kind="move_setup", filename="m", status="completed", finished_at=OLD,
                      payload={"assets": {"check_job_id": str(check.id)}})
    db.add(draft)
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res["rows_deleted"] == 2


async def test_label_runs_in_small_chunks_keep_every_label(
        client, db, seeded_user, storage_calls, monkeypatch):
    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 2)
    tpl = LabelTemplate(name=f"tpl-{uuid.uuid4()}", label_type="top", size_key="4x2",
                        dpi_key="203", language_key="zpl", kind="code", code="{asset_id}")
    db.add(tpl)
    inis = [Initiative(name=f"i{n}-{uuid.uuid4().hex[:5]}", initiative_type="move",
                       status="planned") for n in range(5)]
    db.add_all(inis)
    await db.flush()
    runs = [LabelGenerationRun(initiative_id=i.id, label_types=["top"], status="completed",
                               requested_by=seeded_user.id, finished_at=OLD) for i in inis]
    db.add_all(runs)
    await db.flush()
    for n, r in enumerate(runs):
        a = Asset(legacy_id=9100 + n, name="a", serial_number=f"C{n}")
        db.add(a)
        await db.flush()
        db.add(GeneratedLabel(
            entity_type="asset", entity_id=a.id, initiative_id=r.initiative_id,
            label_type="top", template_id=tpl.id, template_version=1, language_key="zpl",
            dpi_key="203", size_key="4x2", code="X", run_id=r.id))
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "label_runs")
    assert res["rows_deleted"] == 5
    assert await db.scalar(select(func.count()).select_from(GeneratedLabel)) == 5
    assert await db.scalar(select(func.count()).select_from(GeneratedLabel)
                           .where(GeneratedLabel.run_id.is_not(None))) == 0


async def test_a_notification_with_no_state_in_its_payload_is_not_protected(
        client, db, seeded_user, storage_calls):
    db.add(_note(seeded_user, read=OLD, payload={"other": 1}))
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "notifications")
    assert res["rows_deleted"] == 1


async def test_a_notification_a_mail_row_mirrors_is_deleted_and_the_mail_row_stays(
        client, db, seeded_user, storage_calls):
    note = _note(seeded_user, read=OLD)
    db.add(note)
    await db.flush()
    mail = _mail("queued", RECENT)
    mail.notification_id = note.id
    db.add(mail)
    await db.commit()
    mail_id = mail.id
    res, _ = await _go(client, db, seeded_user, "notifications")
    assert res["rows_deleted"] == 1
    db.expire_all()
    assert (await db.get(EmailOutbox, mail_id)).notification_id is None


# -- review fixes ------------------------------------------------------


async def test_imports_a_file_kept_across_many_chunks_counts_once(
        client, db, seeded_user, storage_calls, monkeypatch):
    monkeypatch.setattr("serversherpa.devtools.cleanup.CHUNK_SIZE", 1)
    shared = _key()
    db.add_all([_job("completed", key=shared) for _ in range(3)]
               + [_job("queued", key=shared, finished=None)])
    await db.commit()
    res, _ = await _go(client, db, seeded_user, "imports")
    assert (res["rows_deleted"], res["files_deleted"], res["files_kept"]) == (3, 0, 1)
    assert storage_calls.deleted == []


async def test_imports_a_failed_move_draft_is_never_purged(
        client, db, seeded_user, storage_calls):
    failed_draft = ImportJob(kind="move_setup", filename="m", status="failed",
                             finished_at=OLD, payload={"move": {}})
    created = ImportJob(kind="move_setup", filename="m2", status="completed",
                        finished_at=OLD)
    db.add_all([failed_draft, created])
    await db.commit()
    failed_id, created_id = failed_draft.id, created.id
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res["rows_deleted"] == 1
    assert await _ids(db, ImportJob, failed_id, created_id) == {failed_id}


async def test_imports_a_check_of_a_failed_draft_stays_with_it(
        client, db, seeded_user, storage_calls):
    check = _job("completed", key=_key())
    db.add(check)
    await db.flush()
    draft = ImportJob(kind="move_setup", filename="m", status="failed", finished_at=OLD,
                      payload={"assets": {"check_job_id": str(check.id)}})
    db.add(draft)
    await db.commit()
    check_id, draft_id = check.id, draft.id
    res, _ = await _go(client, db, seeded_user, "imports")
    assert res["rows_deleted"] == 0
    assert await _ids(db, ImportJob, check_id, draft_id) == {check_id, draft_id}
