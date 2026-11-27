import random
import re
import uuid

from loadtest.ids import device_name, device_serial, make_tags, scan_id


def test_tags_are_24_uppercase_hex_unique_and_not_zero_led():
    tags = make_tags(random.Random(7), 5000)
    assert len(set(tags)) == 5000
    assert all(re.fullmatch(r"[1-9A-F][0-9A-F]{23}", t) for t in tags)
    assert make_tags(random.Random(7), 5) == tags[:5]


def test_scan_ids_are_stable_and_distinct():
    run = uuid.UUID(int=1)
    assert scan_id(run, "label", "a") == scan_id(run, "label", "a")
    assert len({scan_id(run, "label", "a"), scan_id(run, "qa", "a"), scan_id(run, "label", "b"),
                scan_id(uuid.UUID(int=2), "label", "a")}) == 4


def test_device_names():
    assert device_serial("label", 2) == "LOADTEST-LABEL-2"
    assert device_serial("cage_exit", 1) == "LOADTEST-CAGE-EXIT-1"
    assert device_name("Label station", 2, 3) == "Load test – Label station 2"
    assert device_name("RFID 1 – Cage Exit", 1, 1) == "Load test – RFID 1 – Cage Exit"
