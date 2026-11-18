"""Provisioning profiles: CMS-signed plists, classified by device list and
get-task-allow."""

import datetime as dt

import pytest

from serversherpa_devices.packages import PackageError
from serversherpa_devices.packages.provision import parse

from .package_fixtures import make_provision

UDIDS = ["00008110-000A1B2C3D4E5F60", "00008120-0011223344556677"]


def test_provision_classifies_adhoc_and_development():
    adhoc = parse(make_provision(devices=UDIDS, get_task_allow=False))
    assert adhoc.kind == "adhoc"
    assert adhoc.devices == UDIDS
    assert adhoc.team_id == "TEAM123456"
    assert adhoc.uuid == "3f1c6c1e-0000-4000-8000-000000000001"
    assert adhoc.name == "Hello Ad Hoc"
    assert adhoc.expires_at == dt.datetime(2027, 11, 17, 12, 30, tzinfo=dt.UTC)
    assert adhoc.entitlements["application-identifier"] == "TEAM123456.com.example.hello"
    assert adhoc.entitlements["get-task-allow"] is False

    development = parse(make_provision(devices=UDIDS, get_task_allow=True))
    assert development.kind == "development"
    assert development.devices == UDIDS


def test_provision_classifies_enterprise_and_appstore():
    enterprise = parse(make_provision(all_devices=True))
    assert enterprise.kind == "enterprise"
    assert enterprise.devices == []
    assert parse(make_provision()).kind == "appstore"


def test_provision_garbage_raises_package_error():
    with pytest.raises(PackageError) as caught:
        parse(b"\x30\x03not cms")
    assert caught.value.message == "The provisioning profile can't be read"
