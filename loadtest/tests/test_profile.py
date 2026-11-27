import dataclasses
import re

import pytest

from loadtest.profile import (
    ProfileError,
    containers_needed,
    device_count,
    load_profile,
    profile_path,
    trucks_needed,
)


def test_real_time_profile_matches_the_spec():
    p = load_profile(profile_path("real-time"))
    assert [s.key for s in p.stages] == ["enroll", "cage_exit", "label", "loading_dock", "pack",
        "truck_load", "trip", "truck_unload", "unpack", "staging", "into_cage", "qa", "complete"]
    assert p.trip.updates == 68
    assert device_count(p) == 32
    label = next(s for s in p.stages if s.key == "label")
    assert (label.crews, label.seconds) == (3, (15.0, 30.0))


def test_fast_profile_only_changes_waits():
    rt, fast = load_profile(profile_path("real-time")), load_profile(profile_path("fast"))
    strip = lambda s: dataclasses.replace(s, seconds=(0, 0), per="server")  # noqa: E731
    assert [strip(s) for s in rt.stages] == [strip(s) for s in fast.stages]
    assert all(s.seconds == (0.5, 1.0) for s in fast.stages if s.kind != "trip")
    assert fast.trip.pause_seconds == (0.5, 1.0) and fast.trip.updates == 68


def test_counts_needed():
    p = load_profile(profile_path("real-time"))
    assert containers_needed(p, 3000) == 150 and trucks_needed(p, 150) == 10
    assert containers_needed(p, 45) == 3 and trucks_needed(p, 17) == 2


def _mutated(tmp_path, edit):
    text = profile_path("real-time").read_text()
    new = edit(text)
    assert new != text
    path = tmp_path / "bad.toml"
    path.write_text(new)
    return path


def _stage_edit(key, old, new):
    def edit(text):
        head, sep, rest = text.partition(f'key = "{key}"\n')
        return head + sep + rest.replace(old, new, 1)
    return edit


def _expect(tmp_path, edit, *words):
    with pytest.raises(ProfileError) as err:
        load_profile(_mutated(tmp_path, edit))
    for w in words:
        assert w in str(err.value)


def test_unknown_key(tmp_path):
    _expect(tmp_path, lambda t: t.replace("container_size", "container_sizee"), "container_sizee")


def test_missing_key(tmp_path):
    _expect(tmp_path, lambda t: t.replace("heartbeat_seconds = 60\n", ""), "heartbeat_seconds")


def test_unknown_stage_key(tmp_path):
    _expect(tmp_path, _stage_edit("qa", "devices = 5", "devices = 5\nbogus = 1"), "qa", "bogus")


def test_seconds_min_over_max(tmp_path):
    _expect(tmp_path, _stage_edit("label", "[15, 30]", "[30, 15]"), "label", "seconds")


def test_seconds_negative(tmp_path):
    _expect(tmp_path, _stage_edit("qa", "[15, 15]", "[-1, 15]"), "qa", "seconds")


@pytest.mark.parametrize("field", ["crews", "devices", "batch"])
def test_counts_below_one_on_non_trip(tmp_path, field):
    pattern = re.compile(rf'({field} = )\d+')
    def edit(text):
        head, sep, rest = text.partition('key = "label"\n')
        return head + sep + pattern.sub(r"\g<1>0", rest, count=1)
    _expect(tmp_path, edit, "label", field)


def test_duplicate_stage_key(tmp_path):
    _expect(tmp_path, lambda t: t.replace('key = "complete"', 'key = "qa"'), "qa", "duplicate")


def test_missing_trip_stage(tmp_path):
    def edit(text):
        a = text.index('[[stage]]\nkey = "trip"')
        b = text.index('[[stage]]\nkey = "truck_unload"')
        return text[:a] + text[b:]
    _expect(tmp_path, edit, "trip")


def test_pack_stages_out_of_order(tmp_path):
    def edit(text):
        a = text.index('[[stage]]\nkey = "pack"')
        b = text.index('[[stage]]\nkey = "truck_load"')
        block = text[a:b]
        text = text[:a] + text[b:]
        c = text.index('[[stage]]\nkey = "trip"')
        return text[:c] + block + text[c:]
    _expect(tmp_path, edit, "pack", "order")


def test_each_stage_between_pack_and_unpack(tmp_path):
    def edit(text):
        return text.replace(
            '[[stage]]\nkey = "truck_unload"',
            '[[stage]]\nkey = "extra"\nlabel = "Extra"\nsite = "origin"\nkind = "each"\n'
            'action = "scan"\ncheckpoint = "qa"\ndevice = "handheld"\ndevices = 1\ncrews = 1\n'
            'batch = 1\nseconds = [1, 1]\nper = "server"\n\n[[stage]]\nkey = "truck_unload"',
        )
    _expect(tmp_path, edit, "extra", "between")


def test_site_before_trip_must_be_origin(tmp_path):
    _expect(tmp_path, _stage_edit("enroll", 'site = "origin"', 'site = "destination"'),
            "enroll", "origin")


def test_site_after_trip_must_be_destination(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'site = "destination"', 'site = "origin"'),
            "qa", "destination")


def test_kind_action_pair(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'action = "scan"', 'action = "pack"'), "qa", "action")


def test_device_for_action(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'device = "handheld"', 'device = "rfid_station"'),
            "qa", "device")


def test_per_cart_only_on_cart_stages(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'per = "server"', 'per = "cart"'), "qa", "per")


def test_per_container_only_on_container_stages(tmp_path):
    _expect(tmp_path, _stage_edit("cage_exit", 'per = "cart"', 'per = "container"'),
            "cage_exit", "per")


def test_trip_hours_must_divide_into_whole_updates(tmp_path):
    _expect(tmp_path, lambda t: t.replace("update_minutes = 15", "update_minutes = 7"),
            "update_minutes")


def test_retry_attempts_at_least_one(tmp_path):
    _expect(tmp_path, lambda t: t.replace("attempts = 5", "attempts = 0"), "attempts")


def test_retry_needs_a_backoff_value(tmp_path):
    _expect(tmp_path, lambda t: t.replace("backoff_seconds = [1, 2, 5, 10, 30]",
                                          "backoff_seconds = []"), "backoff_seconds")


def test_invalid_toml_names_line(tmp_path):
    path = tmp_path / "bad.toml"
    path.write_text('container_size = 20\nbroken = = 1\n')
    with pytest.raises(ProfileError) as err:
        load_profile(path)
    assert "line 2" in str(err.value)


@pytest.mark.parametrize("old,new,words", [
    ("crews = 5", 'crews = "x"', ("enroll", "crews")),
    ("[15, 15]", '"15"', ("enroll", "seconds")),
    ("[15, 15]", "[15]", ("enroll", "seconds")),
    ("[15, 15]", '[15, "x"]', ("enroll", "seconds")),
    ("hours = 17", 'hours = "17"', ("hours",)),
    ("backoff_seconds = [1, 2, 5, 10, 30]", "backoff_seconds = 5", ("backoff_seconds",)),
    ("backoff_seconds = [1, 2, 5, 10, 30]", 'backoff_seconds = [1, "x"]', ("backoff_seconds",)),
    ("attempts = 5", "attempts = true", ("attempts",)),
    ("pause_seconds = [900, 900]", "pause_seconds = 900", ("pause_seconds",)),
    ('label = "RFID enroll"', "label = 3", ("enroll", "label")),
])
def test_wrong_type_is_a_profile_error(tmp_path, old, new, words):
    _expect(tmp_path, lambda t: t.replace(old, new, 1), *words)


def test_stage_not_a_list_of_tables(tmp_path):
    def edit(text):
        return text[: text.index("[[stage]]")].replace("[retry]", "stage = 5\n\n[retry]", 1)
    # "stage = 5" placed before [retry] is a top-level key
    _expect(tmp_path, edit, "stage")


def test_retry_not_a_table(tmp_path):
    def edit(text):
        block = "[retry]\nattempts = 5\nbackoff_seconds = [1, 2, 5, 10, 30]\n"
        assert block in text
        return "retry = 5\n" + text.replace(block, "")
    _expect(tmp_path, edit, "retry")


@pytest.mark.parametrize("field", ["container_size", "containers_per_truck"])
@pytest.mark.parametrize("value", ["0", "2.5", '"20"'])
def test_size_fields_are_whole_and_positive(tmp_path, field, value):
    _expect(tmp_path, lambda t: re.sub(rf"^{field} = .*$", f"{field} = {value}", t, flags=re.M),
            field)


@pytest.mark.parametrize("field", ["heartbeat_seconds", "sample_seconds",
                                   "request_timeout_seconds"])
@pytest.mark.parametrize("value", ["0", "-1", '"x"'])
def test_second_fields_are_positive(tmp_path, field, value):
    _expect(tmp_path, lambda t: re.sub(rf"^{field} = .*$", f"{field} = {value}", t, flags=re.M),
            field)


@pytest.mark.parametrize("value", ['""', "3"])
def test_final_status_non_empty_string(tmp_path, value):
    _expect(tmp_path, lambda t: t.replace('final_status = "complete"',
                                          f"final_status = {value}"), "final_status")


@pytest.mark.parametrize("old,new,field", [
    ("devices = 0", "devices = 1", "devices"),
    ("crews = 0", "crews = 1", "crews"),
    ("devices = 0", 'devices = 0\ndevice = "handheld"', "device"),
    ("devices = 0", 'devices = 0\ncheckpoint = "qa"', "checkpoint"),
])
def test_trip_stage_has_no_devices_crews_device_or_checkpoint(tmp_path, old, new, field):
    _expect(tmp_path, _stage_edit("trip", old, new), "trip", field)


def test_site_outside_origin_destination(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'site = "destination"', 'site = "moon"'), "qa", "site")


def test_missing_stage_key(tmp_path):
    _expect(tmp_path, _stage_edit("qa", 'label = "QA"\n', ""), "qa", "label")
