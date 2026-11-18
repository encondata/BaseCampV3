import time
import uuid

import jwt
import pytest

from serversherpa_devices.services import links
from serversherpa_devices.services.links import LinkError, make_install_token, read_install_token


def test_link_round_trip():
    ref = uuid.uuid4()
    token = make_install_token(kind="apk", ref=ref)
    assert read_install_token(token, kind="apk") == ref


def test_link_wrong_kind_raises():
    token = make_install_token(kind="apk", ref=uuid.uuid4())
    with pytest.raises(LinkError):
        read_install_token(token, kind="ipa")


def test_link_expired_raises():
    token = make_install_token(kind="ipa", ref=uuid.uuid4(), ttl_seconds=-1)
    with pytest.raises(LinkError):
        read_install_token(token, kind="ipa")


def test_link_tampered_or_foreign_key_raises():
    ref = uuid.uuid4()
    good = make_install_token(kind="manifest", ref=ref)
    with pytest.raises(LinkError):
        read_install_token(good[:-2] + ("AA" if not good.endswith("AA") else "BB"),
                           kind="manifest")
    forged = jwt.encode({"k": "manifest", "r": str(ref), "exp": int(time.time()) + 60},
                        "some-other-key-of-sufficient-length-0123456789", algorithm="HS256")
    with pytest.raises(LinkError):
        read_install_token(forged, kind="manifest")
    with pytest.raises(LinkError):
        read_install_token("garbage", kind="manifest")


def test_link_key_is_derived_not_the_raw_secret():
    from serversherpa_devices.config import get_settings
    raw = get_settings().secret_key.get_secret_value()
    assert links._key() != raw.encode()
