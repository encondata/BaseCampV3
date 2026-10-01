import json

import pytest

from edge.identity import load_or_create, rename


def test_first_start_generates_and_persists(tmp_path):
    ident = load_or_create(tmp_path)
    assert ident.serial.startswith("kiosk-laptop-")
    assert ident.name == f"Kiosk {ident.serial[-4:].upper()}"
    on_disk = json.loads((tmp_path / "identity.json").read_text())
    assert on_disk["serial"] == ident.serial


def test_later_starts_reuse_the_same_identity(tmp_path):
    first = load_or_create(tmp_path)
    assert load_or_create(tmp_path) == first


def test_rename_keeps_serial_and_persists(tmp_path):
    first = load_or_create(tmp_path)
    renamed = rename(tmp_path, first, "  Dock Door 3  ")
    assert renamed.serial == first.serial
    assert renamed.name == "Dock Door 3"
    assert load_or_create(tmp_path).name == "Dock Door 3"


@pytest.mark.parametrize("bad", ["", "   ", "x" * 81])
def test_rename_rejects_bad_names(tmp_path, bad):
    first = load_or_create(tmp_path)
    with pytest.raises(ValueError, match="bad_name"):
        rename(tmp_path, first, bad)


def test_corrupt_identity_refuses_rather_than_regenerating(tmp_path):
    (tmp_path / "identity.json").write_text("{not json")
    with pytest.raises(ValueError):
        load_or_create(tmp_path)
