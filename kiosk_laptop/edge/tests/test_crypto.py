import os
import stat

import pytest

from edge.crypto import (
    KeyFileError, check_verifier, decrypt, encrypt, load_or_create_keys, make_verifier,
)


def test_key_created_0600_and_reloaded(tmp_path):
    keys = load_or_create_keys(tmp_path)
    mode = stat.S_IMODE(os.stat(tmp_path / "edge.key").st_mode)
    assert mode == 0o600
    again = load_or_create_keys(tmp_path)
    assert decrypt(again, encrypt(keys, "secret")) == "secret"
    assert again.jwt_secret == keys.jwt_secret


def test_corrupt_key_file_refuses(tmp_path):
    (tmp_path / "edge.key").write_text("garbage")
    with pytest.raises(KeyFileError):
        load_or_create_keys(tmp_path)


def test_verifier_round_trip():
    v = make_verifier("CorrectHorse9!")
    assert check_verifier(v, "CorrectHorse9!")
    assert not check_verifier(v, "wrong")
    assert not check_verifier("not-a-hash", "CorrectHorse9!")
