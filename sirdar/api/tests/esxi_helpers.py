"""The fake ESXi wired into esxi.connect, for every test that reaches ESXi
through Sirdar's client."""

import pytest

from sirdar_api.deploy import esxi

from .fake_esxi import FakeEsxi


@pytest.fixture
def esxi_fake(monkeypatch):
    fake = FakeEsxi()
    fake.add_seed()
    monkeypatch.setattr(esxi, "connect", fake.connect)
    return fake
