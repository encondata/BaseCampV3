import pytest

from serversherpa_devices.services.secrets import SecretError, seal, unseal


def test_seal_round_trip():
    token = seal(b"p12-bytes\x00\xff")
    assert token != b"p12-bytes\x00\xff"
    assert unseal(token) == b"p12-bytes\x00\xff"


def test_unseal_tampered_raises():
    token = bytearray(seal(b"secret"))
    mid = len(token) // 2   # not the last char: its spare base64 bits decode the same
    token[mid] = ord("A") if token[mid] != ord("A") else ord("B")
    with pytest.raises(SecretError):
        unseal(bytes(token))
    with pytest.raises(SecretError):
        unseal(b"not a token")
