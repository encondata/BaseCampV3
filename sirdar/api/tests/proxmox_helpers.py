"""The fake Proxmox wired into outbound.transports(), for every test that
reaches the Proxmox API through Sirdar's client."""

import pytest

from sirdar_api.deploy import outbound

from .fake_proxmox import FakeProxmox


async def no_sleep(_seconds: float) -> None:
    return None


@pytest.fixture
def proxmox_fake(monkeypatch):
    fake = FakeProxmox()
    earlier = outbound.transports
    monkeypatch.setattr(outbound, "transports",
                        lambda: {**earlier(), "proxmox": fake.transport()})
    return fake
