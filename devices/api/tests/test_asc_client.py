"""The App Store Connect client against the in-memory fake."""

import base64
import datetime as dt

import pytest

from serversherpa_devices.apple.asc import AscDevice, AscError, AscRateLimited
from serversherpa_devices.packages import provision

from .fake_asc import ISSUER_ID, KEY_ID, OTHER_P8, TEAM_ID, FakeAsc
from .fake_main_api import FakeClock

UDID_A = "00008110-000A1B2C3D4E5F60"
UDID_B = "00008120-001122334455667E"


@pytest.fixture
def fake():
    return FakeAsc()


async def test_jwt_claims_and_header():
    clock = FakeClock(start=1_800_000_000.0)
    fake = FakeAsc(clock=clock)
    async with fake.client(clock=clock) as client:
        await client.find_device(UDID_A)
        header, claims = fake.tokens[0]
        assert header == {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
        assert claims == {"iss": ISSUER_ID, "iat": 1_800_000_000, "exp": 1_800_001_200,
                          "aud": "appstoreconnect-v1"}
        token = fake.calls[0].headers["Authorization"]

        # Reused until 60 s before it expires.
        clock.advance(1139)
        await client.find_device(UDID_A)
        assert fake.calls[1].headers["Authorization"] == token
        clock.advance(1)
        await client.find_device(UDID_A)
        assert fake.calls[2].headers["Authorization"] != token
        assert fake.tokens[2][1]["iat"] == 1_800_001_140

    # A key Apple doesn't know is refused.
    async with fake.client(p8=OTHER_P8) as client:
        with pytest.raises(AscError) as refused:
            await client.find_device(UDID_A)
    assert (refused.value.status, refused.value.code) == (401, "NOT_AUTHORIZED")


async def test_register_then_find_device(fake):
    async with fake.client() as client:
        assert await client.find_device(UDID_A) is None
        device = await client.register_device("Pat's iPhone", UDID_A)
        assert device == AscDevice(id=device.id, udid=UDID_A, name="Pat's iPhone",
                                   device_class="IPHONE", status="ENABLED", model="iPhone 15")
        assert fake.devices[device.id]["platform"] == "IOS"
        assert await client.find_device(UDID_A) == device
        assert await client.find_device(UDID_B) is None

        with pytest.raises(AscError) as duplicate:
            await client.register_device("Again", UDID_A)
        assert duplicate.value.status == 409
        assert duplicate.value.code.startswith("ENTITY_ERROR.ATTRIBUTE.INVALID")
        assert UDID_A in duplicate.value.detail

        disabled = await client.set_device_status(device.id, "DISABLED")
        assert disabled.status == "DISABLED"
        assert fake.devices[device.id]["status"] == "DISABLED"
        assert (await client.set_device_status(device.id, "ENABLED")).status == "ENABLED"
        with pytest.raises(ValueError):
            await client.set_device_status(device.id, "PROCESSING")


async def test_list_devices_follows_next(fake):
    udids = [f"00008110-00000000000000{n:02X}" for n in range(5)]
    for udid in udids:
        fake.add_device(udid, device_class="IPAD" if udid.endswith("4") else "IPHONE")
    fake.page_size = 2
    async with fake.client() as client:
        devices = await client.list_devices()
    assert [d.udid for d in devices] == udids
    assert [d.device_class for d in devices] == ["IPHONE"] * 4 + ["IPAD"]
    assert len(fake.calls) == 3
    assert all(call.url.params["limit"] == "200" for call in fake.calls)

    # A next link off Apple's API is never followed (it would get the token).
    fake.next_base = "https://elsewhere.test/v1"
    async with fake.client() as client:
        with pytest.raises(AscError):
            await client.list_devices()
    assert all(call.url.host == "api.appstoreconnect.apple.com" for call in fake.calls)


async def test_bundle_ids_and_certificates_match_exactly(fake):
    fake.add_bundle_id("com.example.hello.widget")
    async with fake.client() as client:
        assert await client.find_bundle_id("com.example.hello") is None
        created = await client.create_bundle_id("com.example.hello", "Hello")
        assert await client.find_bundle_id("com.example.hello") == created
        assert fake.bundle_ids[created]["platform"] == "IOS"

        fake.add_certificate("7D2A", certificate_type="DEVELOPMENT")
        dist = fake.add_certificate("07D2A0", name="Apple Distribution: Test",
                                    certificate_type="IOS_DISTRIBUTION")
        assert await client.find_certificate_by_serial("7D2A") is None
        found = await client.find_certificate_by_serial("7d2a0")
        assert found is not None and found.id == dist
        assert found.name == "Apple Distribution: Test"
        assert found.expires_at == dt.datetime(2027, 11, 17, 12, 0, tzinfo=dt.UTC)


async def test_create_profile_returns_decoded_content(fake):
    bundle = fake.add_bundle_id("com.example.hello")
    cert = fake.add_certificate("1A2B")
    devices = [fake.add_device(UDID_A), fake.add_device(UDID_B)]
    name = "ServerSherpa Devices · com.example.hello"
    fake.add_profile(name + " (old)")
    fake.add_profile("Xcode Managed")
    async with fake.client() as client:
        profile = await client.create_adhoc_profile(name, bundle, cert, devices)
        stored = fake.profiles[profile.id]
        assert profile.content == base64.b64decode(stored["profileContent"])
        assert stored["relationships"] == {"bundleId": bundle, "certificates": [cert],
                                           "devices": devices}
        info = provision.parse(profile.content)
        assert (info.kind, info.uuid, info.team_id) == ("adhoc", profile.uuid, TEAM_ID)
        assert info.devices == [UDID_A, UDID_B]
        assert profile.name == name
        assert profile.expires_at == dt.datetime(2027, 11, 17, 12, 0, tzinfo=dt.UTC)

        # Only the exact name.
        assert [p.id for p in await client.list_profiles(name)] == [profile.id]
        await client.delete_profile(profile.id)
        assert profile.id not in fake.profiles
        assert await client.list_profiles(name) == []
        with pytest.raises(AscError) as missing:
            await client.delete_profile(profile.id)
        assert missing.value.status == 404


async def test_429_raises_rate_limited(fake):
    fake.rate_limit(1)
    async with fake.client() as client:
        with pytest.raises(AscRateLimited) as limited:
            await client.find_device(UDID_A)
        assert isinstance(limited.value, AscError)
        assert (limited.value.status, limited.value.code) == (429, "RATE_LIMIT_EXCEEDED")
        assert await client.find_device(UDID_A) is None   # the next one goes through
