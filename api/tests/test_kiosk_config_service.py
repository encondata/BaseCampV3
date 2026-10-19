"""services/kiosk_config: the schema-1 document, normalize (strict for
portal edits, lenient for kiosk reports), the newest-whole-config-wins merge
rule with its first-contact case, and the check-in reply fields."""

import copy
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, KioskSound, Person
from serversherpa.services.kiosk_config import (
    DEFAULT_CONFIG,
    ConfigError,
    accept_kiosk_report,
    apply_portal_edit,
    normalize,
    reply_fields,
    sound_ids_in,
)

NOW = datetime(2026, 10, 17, 12, tzinfo=UTC)


# ── DEFAULT_CONFIG mirrors the kiosk's current defaults ──────────────

def test_default_config_values():
    assert DEFAULT_CONFIG == {
        "schema": 1,
        "appearance": {
            "good_scan": {"h": 150, "s": 60, "l": 45},
            "not_found_scan": {"h": 0, "s": 70, "l": 50},
            "duplicate_scan": {"h": 38, "s": 92, "l": 50},
            "flash_ms": 350,
        },
        "sound": {
            "good": {"kind": "builtin", "id": "chime"},
            "not_found": {"kind": "builtin", "id": "buzz"},
            "duplicate": {"kind": "builtin", "id": "double_beep"},
            "alarm": {"kind": "siren"},
            "volume": 0.8,
        },
        "checkpoints": {
            "enroll": "pre_stage",
            "container_pack": "in_container",
            "container_unpack": "un_pack",
            "truck_load": "on_truck",
            "truck_unload": "received",
        },
        "developer": {"dev_mode": False},
        "alarm": {"mode": "until_dismissed", "timed_seconds": 10},
    }


# ── normalize ────────────────────────────────────────────────────────

def test_normalize_none_and_empty_give_defaults():
    assert normalize(None, known_sounds=set(), strict=False) == DEFAULT_CONFIG
    for strict in (True, False):
        assert normalize({}, known_sounds=set(), strict=strict) == DEFAULT_CONFIG


def test_strict_normalize_refuses_none():
    with pytest.raises(ConfigError) as exc:
        normalize(None, known_sounds=set(), strict=True)
    assert exc.value.field == "config"


def test_normalize_fills_missing_fields_and_sections():
    doc = {"schema": 1, "appearance": {"flash_ms": 800}}
    out = normalize(doc, known_sounds=set(), strict=True)
    assert out["appearance"]["flash_ms"] == 800
    assert out["appearance"]["good_scan"] == {"h": 150, "s": 60, "l": 45}
    assert out["sound"] == DEFAULT_CONFIG["sound"]
    assert out["alarm"] == DEFAULT_CONFIG["alarm"]
    assert doc == {"schema": 1, "appearance": {"flash_ms": 800}}   # input untouched


def test_normalize_keeps_unknown_and_other_platform_sections_verbatim():
    extra = {
        "android_rfid": {"power": 270, "session": "S1", "nested": {"a": [1, 2, None]}},
        "ios": {"camera_position": "back"},
        "future_thing": [1, "two", {"three": 3}],
    }
    doc = {**copy.deepcopy(DEFAULT_CONFIG), **copy.deepcopy(extra)}
    for strict in (True, False):
        out = normalize(doc, known_sounds=set(), strict=strict)
        for key, value in extra.items():
            assert out[key] == value


def test_normalize_keeps_valid_upload_and_none_choices():
    sid = str(uuid.uuid4())
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["sound"]["good"] = {"kind": "upload", "id": sid}
    doc["sound"]["not_found"] = {"kind": "none"}
    doc["sound"]["alarm"] = {"kind": "builtin", "id": "bonk"}
    out = normalize(doc, known_sounds={sid}, strict=True)
    assert out["sound"]["good"] == {"kind": "upload", "id": sid}
    assert out["sound"]["not_found"] == {"kind": "none"}
    assert out["sound"]["alarm"] == {"kind": "builtin", "id": "bonk"}


@pytest.mark.parametrize("path,value", [
    (("appearance", "flash_ms"), 50),
    (("appearance", "flash_ms"), 2001),
    (("appearance", "flash_ms"), "350"),
    (("appearance", "flash_ms"), True),
    (("appearance", "good_scan"), {"h": 361, "s": 60, "l": 45}),
    (("appearance", "duplicate_scan"), {"h": 38, "s": 92}),
    (("sound", "good"), {"kind": "builtin", "id": "kazoo"}),
    (("sound", "good"), {"kind": "upload", "id": "not-a-known-sound"}),
    (("sound", "good"), {"kind": "siren"}),
    (("sound", "alarm"), {"kind": "none"}),
    (("sound", "volume"), 1.5),
    (("checkpoints", "enroll"), ""),
    (("checkpoints", "truck_load"), 7),
    (("developer", "dev_mode"), "yes"),
    (("alarm", "mode"), "forever"),
    (("alarm", "timed_seconds"), 2),
    (("alarm", "timed_seconds"), 601),
])
def test_normalize_strict_refuses_and_lenient_defaults(path, value):
    section, field = path
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["appearance"]["flash_ms"] = 700           # a good value that must survive
    doc[section][field] = value
    if path == ("appearance", "flash_ms"):
        doc["sound"]["volume"] = 0.3              # keep a survivor elsewhere
    with pytest.raises(ConfigError) as err:
        normalize(doc, known_sounds=set(), strict=True)
    assert err.value.field == f"{section}.{field}"
    assert err.value.message

    out = normalize(doc, known_sounds=set(), strict=False)
    assert out[section][field] == DEFAULT_CONFIG[section][field]
    if path == ("appearance", "flash_ms"):
        assert out["sound"]["volume"] == 0.3
    else:
        assert out["appearance"]["flash_ms"] == 700


def test_normalize_bad_section_and_document_shapes():
    with pytest.raises(ConfigError) as err:
        normalize({"appearance": "pink"}, known_sounds=set(), strict=True)
    assert err.value.field == "appearance"
    assert normalize({"appearance": "pink"}, known_sounds=set(),
                     strict=False)["appearance"] == DEFAULT_CONFIG["appearance"]
    with pytest.raises(ConfigError) as err:
        normalize({"schema": 2}, known_sounds=set(), strict=True)
    assert err.value.field == "schema"
    assert normalize({"schema": 2}, known_sounds=set(), strict=False)["schema"] == 1
    with pytest.raises(ConfigError):
        normalize(["not", "a", "dict"], known_sounds=set(), strict=True)
    assert normalize(["x"], known_sounds=set(), strict=False) == DEFAULT_CONFIG


def test_sound_ids_in():
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["sound"]["good"] = {"kind": "upload", "id": a}
    doc["sound"]["alarm"] = {"kind": "upload", "id": b}
    assert sound_ids_in(doc) == {a, b}
    assert sound_ids_in(None) == set()


# ── merge rule ───────────────────────────────────────────────────────

async def _kiosk(db) -> Device:
    d = Device(device_type="kiosk", name=f"K-{uuid.uuid4().hex[:6]}",
               serial=uuid.uuid4().hex, sub_type="web")
    db.add(d)
    await db.flush()
    return d


async def _person(db) -> Person:
    p = Person(first_name="Jimmy", last_name="Henderson")
    db.add(p)
    await db.flush()
    return p


def _with(**appearance) -> dict:
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["appearance"].update(appearance)
    return doc


async def _audits(db, device):
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(device.id), AuditLog.action == "config_change"))).all()
    return sorted(rows, key=lambda r: r.changes["version"])   # one txn: same `at`


async def test_unstamped_first_report_is_stored(db):
    d = await _kiosk(db)
    stored = await accept_kiosk_report(db, d, _with(flash_ms=900), None, now=NOW)
    await db.commit()
    assert stored is True
    assert d.config["appearance"]["flash_ms"] == 900
    assert d.config_version == 1
    assert d.config_source == "kiosk"
    assert d.config_changed_at == NOW
    assert d.config_changed_by is None
    assert d.config_reported_at == NOW
    [row] = await _audits(db, d)
    assert row.actor_person_id is None
    assert row.entity_type == "device"
    assert row.changes["source"] == "kiosk"
    assert row.changes["version"] == 1
    assert row.changes["fields"]["appearance.flash_ms"] == {"from": None, "to": 900}


async def test_unstamped_first_report_ignored_after_portal_edit(db):
    d = await _kiosk(db)
    p = await _person(db)
    await apply_portal_edit(db, d, _with(flash_ms=1200), actor_id=p.id,
                            now=NOW - timedelta(hours=1))
    later = NOW + timedelta(minutes=5)
    stored = await accept_kiosk_report(db, d, _with(flash_ms=400), None, now=later)
    await db.commit()
    assert stored is False
    assert d.config["appearance"]["flash_ms"] == 1200
    assert d.config_version == 1
    assert d.config_source == "portal"
    assert d.config_changed_by == p.id
    assert d.config_reported_at == later
    assert len(await _audits(db, d)) == 1


async def test_newer_kiosk_config_is_stored(db):
    d = await _kiosk(db)
    p = await _person(db)
    await apply_portal_edit(db, d, _with(flash_ms=1200), actor_id=p.id, now=NOW)
    changed = NOW + timedelta(minutes=10)
    stored = await accept_kiosk_report(db, d, _with(flash_ms=500), changed,
                                       now=NOW + timedelta(minutes=11))
    await db.commit()
    assert stored is True
    assert d.config["appearance"]["flash_ms"] == 500
    assert d.config_version == 2
    assert d.config_source == "kiosk"
    assert d.config_changed_at == changed
    assert d.config_changed_by is None
    rows = await _audits(db, d)
    assert [r.changes["source"] for r in rows] == ["portal", "kiosk"]
    assert rows[1].changes["version"] == 2
    assert rows[1].changes["fields"] == {"appearance.flash_ms": {"from": 1200, "to": 500}}


async def test_older_kiosk_config_is_ignored(db):
    d = await _kiosk(db)
    p = await _person(db)
    await apply_portal_edit(db, d, _with(flash_ms=1200), actor_id=p.id, now=NOW)
    stored = await accept_kiosk_report(db, d, _with(flash_ms=500),
                                       NOW - timedelta(minutes=1),
                                       now=NOW + timedelta(minutes=1))
    assert stored is False
    # an equal stamp is not "later" either
    assert await accept_kiosk_report(db, d, _with(flash_ms=500), NOW,
                                     now=NOW + timedelta(minutes=2)) is False
    await db.commit()
    assert d.config["appearance"]["flash_ms"] == 1200
    assert d.config_version == 1
    assert d.config_reported_at == NOW + timedelta(minutes=2)


async def test_unstamped_later_report_is_ignored(db):
    d = await _kiosk(db)
    assert await accept_kiosk_report(db, d, _with(flash_ms=900), None, now=NOW)
    assert await accept_kiosk_report(db, d, _with(flash_ms=300), None,
                                     now=NOW + timedelta(hours=1)) is False
    assert d.config["appearance"]["flash_ms"] == 900
    assert d.config_version == 1


async def test_stamped_first_report_stored_with_its_stamp(db):
    d = await _kiosk(db)
    changed = NOW - timedelta(days=2)               # made offline two days ago
    assert await accept_kiosk_report(db, d, _with(flash_ms=900), changed, now=NOW)
    assert d.config_changed_at == changed


async def test_future_stamp_is_clamped_to_now(db):
    d = await _kiosk(db)
    far = NOW + timedelta(days=30)
    assert await accept_kiosk_report(db, d, _with(flash_ms=900), far, now=NOW)
    assert d.config_changed_at == NOW
    # so a portal edit a minute later is the newer config: the far-future
    # stamp did not lock the portal out
    p = await _person(db)
    await apply_portal_edit(db, d, _with(flash_ms=1500), actor_id=p.id,
                            now=NOW + timedelta(minutes=1))
    assert d.config_changed_at == NOW + timedelta(minutes=1)
    assert d.config["appearance"]["flash_ms"] == 1500


async def test_newer_but_identical_report_is_not_a_change(db):
    d = await _kiosk(db)
    assert await accept_kiosk_report(db, d, _with(flash_ms=900), NOW, now=NOW)
    assert await accept_kiosk_report(db, d, _with(flash_ms=900),
                                     NOW + timedelta(minutes=1),
                                     now=NOW + timedelta(minutes=1)) is False
    await db.commit()
    assert d.config_version == 1
    assert len(await _audits(db, d)) == 1


async def test_report_differing_only_in_json_type_is_a_change(db):
    """`true` and `1` (or `1` and `1.0`) are equal in Python but not in the
    stored JSON: the comparison is on canonical JSON, so a kiosk that sends
    a pass-through value with a new type is stored as a new version."""
    d = await _kiosk(db)
    first = _with()
    first["android_rfid"] = {"beep": True, "power": 270}
    assert await accept_kiosk_report(db, d, first, NOW, now=NOW)
    second = _with()
    second["android_rfid"] = {"beep": 1, "power": 270.0}
    later = NOW + timedelta(minutes=1)
    assert await accept_kiosk_report(db, d, second, later, now=later) is True
    await db.commit()
    assert d.config_version == 2
    assert d.config["android_rfid"]["beep"] == 1
    assert d.config["android_rfid"]["beep"] is not True


async def test_report_differing_only_in_key_order_is_not_a_change(db):
    d = await _kiosk(db)
    assert await accept_kiosk_report(db, d, _with(), NOW, now=NOW)
    reordered = {k: _with()[k] for k in reversed(list(_with()))}
    later = NOW + timedelta(minutes=1)
    assert await accept_kiosk_report(db, d, reordered, later, now=later) is False
    assert d.config_version == 1


async def test_kiosk_report_records_its_actor(db):
    d = await _kiosk(db)
    p = await _person(db)
    assert await accept_kiosk_report(db, d, _with(flash_ms=900), NOW, now=NOW, actor_id=p.id)
    await db.commit()
    (a,) = await _audits(db, d)
    assert a.actor_person_id == p.id
    assert d.config_changed_by == p.id and d.config_source == "kiosk"


def _blob(kb: int) -> dict:
    return {"blob": "x" * (kb * 1024)}


async def test_kiosk_report_over_64kb_after_merge_is_not_stored(db):
    """Each document fits the 64 KB request cap, but the stored sections
    carried forward push the merged one over it: the stored config stays."""
    d = await _kiosk(db)
    first = _with()
    first["android_rfid"] = _blob(40)
    assert await accept_kiosk_report(db, d, first, NOW, now=NOW)
    second = _with(flash_ms=900)
    second["ios"] = _blob(40)       # android_rfid omitted -> carried forward
    later = NOW + timedelta(minutes=1)
    assert await accept_kiosk_report(db, d, second, later, now=later) is False
    await db.commit()
    assert d.config_version == 1
    assert d.config["appearance"]["flash_ms"] == 350 and "ios" not in d.config
    assert d.config_reported_at == later


async def test_portal_edit_over_64kb_after_merge_is_refused(db):
    d = await _kiosk(db)
    first = _with()
    first["android_rfid"] = _blob(40)
    assert await accept_kiosk_report(db, d, first, NOW, now=NOW)
    edit = _with()
    edit["ios"] = _blob(40)
    with pytest.raises(ConfigError) as exc:
        await apply_portal_edit(db, d, edit, actor_id=None, now=NOW + timedelta(minutes=1))
    assert exc.value.field == "config"
    assert d.config_version == 1 and "ios" not in d.config


def _sections(n: int) -> dict:
    doc = _with()
    for i in range(n):
        doc[f"extra_{i}"] = {"v": i}
    return doc


async def test_more_than_16_unknown_sections_is_refused(db):
    """16 truly unknown sections fit; the spec's platform sections
    (android_rfid, ios) don't count against the cap."""
    d = await _kiosk(db)
    doc = _sections(16)
    doc["android_rfid"] = {"power": 270}
    doc["ios"] = {"haptics": True}
    assert await accept_kiosk_report(db, d, doc, NOW, now=NOW)
    assert d.config_version == 1
    assert d.config["ios"] == {"haptics": True} and "extra_15" in d.config
    later = NOW + timedelta(minutes=1)
    assert await accept_kiosk_report(db, d, _sections(17), later, now=later) is False
    assert d.config_version == 1 and "extra_16" not in d.config
    with pytest.raises(ConfigError) as exc:
        await apply_portal_edit(db, d, _sections(17), actor_id=None, now=later)
    assert exc.value.field == "config"
    assert d.config_version == 1


@pytest.mark.parametrize("value", [{"label_kind": "container", "dpi": 203,
                                    "printer": {"type": "network", "ip": "10.0.0.9"}}, None])
async def test_label_station_section_does_not_count_against_the_cap(db, value):
    """The laptop's label_station section is a platform section: it rides
    alongside 16 unknown sections, verbatim (null stays null), and a
    report that leaves it out carries it forward."""
    d = await _kiosk(db)
    doc = _sections(16)
    doc["label_station"] = value
    assert await accept_kiosk_report(db, d, doc, NOW, now=NOW)
    assert d.config_version == 1
    assert "label_station" in d.config and d.config["label_station"] == value
    later = NOW + timedelta(minutes=1)
    again = _sections(16)
    again["extra_0"] = {"v": "changed"}
    assert await accept_kiosk_report(db, d, again, later, now=later)
    assert d.config["label_station"] == value and d.config["extra_0"] == {"v": "changed"}


async def test_kiosk_report_bad_values_defaulted_rest_kept(db):
    d = await _kiosk(db)
    doc = _with(flash_ms=99999)
    doc["sound"]["good"] = {"kind": "upload", "id": str(uuid.uuid4())}   # unknown
    doc["sound"]["volume"] = 0.25
    doc["android_rfid"] = {"power": 270}
    assert await accept_kiosk_report(db, d, doc, NOW, now=NOW)
    assert d.config["appearance"]["flash_ms"] == 350
    assert d.config["sound"]["good"] == DEFAULT_CONFIG["sound"]["good"]
    assert d.config["sound"]["volume"] == 0.25
    assert d.config["android_rfid"] == {"power": 270}


async def test_kiosk_report_with_known_uploaded_sound(db):
    d = await _kiosk(db)
    s = KioskSound(name="ding.mp3", content_type="audio/mpeg", size=10,
                   storage_key=f"kiosk-sounds/{uuid.uuid4()}")
    db.add(s)
    await db.flush()
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["sound"]["good"] = {"kind": "upload", "id": str(s.id)}
    assert await accept_kiosk_report(db, d, doc, NOW, now=NOW)
    assert d.config["sound"]["good"] == {"kind": "upload", "id": str(s.id)}


async def test_passthrough_sections_survive_a_report_that_omits_them(db):
    d = await _kiosk(db)
    first = copy.deepcopy(DEFAULT_CONFIG)
    first["android_rfid"] = {"power": 270, "region": "US"}
    first["ios"] = {"camera_position": "back"}
    assert await accept_kiosk_report(db, d, first, NOW, now=NOW)
    # a web kiosk that dropped them must not erase them
    assert await accept_kiosk_report(db, d, _with(flash_ms=600),
                                     NOW + timedelta(minutes=1),
                                     now=NOW + timedelta(minutes=1))
    assert d.config["android_rfid"] == {"power": 270, "region": "US"}
    assert d.config["ios"] == {"camera_position": "back"}
    assert d.config["appearance"]["flash_ms"] == 600


async def test_portal_edit_strict_and_audited(db):
    d = await _kiosk(db)
    p = await _person(db)
    with pytest.raises(ConfigError) as err:
        await apply_portal_edit(db, d, _with(flash_ms=5), actor_id=p.id, now=NOW)
    assert err.value.field == "appearance.flash_ms"
    assert d.config is None and d.config_version == 0

    await apply_portal_edit(db, d, _with(flash_ms=1000), actor_id=p.id, now=NOW)
    await db.commit()
    assert d.config_version == 1
    assert d.config_source == "portal"
    assert d.config_changed_at == NOW
    assert d.config_changed_by == p.id
    assert d.config_reported_at is None       # the portal is not a report
    [row] = await _audits(db, d)
    assert row.actor_person_id == p.id
    assert row.changes["source"] == "portal"
    assert row.changes["fields"]["appearance.flash_ms"] == {"from": None, "to": 1000}


async def test_portal_edit_keeps_passthrough_sections(db):
    d = await _kiosk(db)
    p = await _person(db)
    first = copy.deepcopy(DEFAULT_CONFIG)
    first["android_rfid"] = {"power": 270}
    assert await accept_kiosk_report(db, d, first, NOW, now=NOW)
    await apply_portal_edit(db, d, copy.deepcopy(DEFAULT_CONFIG), actor_id=p.id,
                            now=NOW + timedelta(minutes=1))
    assert d.config["android_rfid"] == {"power": 270}


async def test_identical_portal_edit_is_a_no_op(db):
    d = await _kiosk(db)
    p = await _person(db)
    assert await apply_portal_edit(db, d, _with(flash_ms=1000), actor_id=p.id, now=NOW)
    later = NOW + timedelta(minutes=5)
    # same content, keys in another order: nothing stored, changed_at kept
    edit = dict(reversed(list(_with(flash_ms=1000).items())))
    assert await apply_portal_edit(db, d, edit, actor_id=p.id, now=later) is False
    assert d.config_version == 1 and d.config_changed_at == NOW
    assert len(await _audits(db, d)) == 1


# ── reply_fields ─────────────────────────────────────────────────────

async def test_reply_fields(db):
    d = await _kiosk(db)
    assert reply_fields(d, None) == {"config_version": 0, "config": None}
    p = await _person(db)
    await apply_portal_edit(db, d, _with(flash_ms=1000), actor_id=p.id, now=NOW)
    assert reply_fields(d, None) == {"config_version": 1, "config": d.config}
    assert reply_fields(d, 0) == {"config_version": 1, "config": d.config}
    assert reply_fields(d, 1) == {"config_version": 1, "config": None}
    assert reply_fields(d, 5) == {"config_version": 1, "config": None}
