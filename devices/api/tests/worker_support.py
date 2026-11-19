"""Helpers for the worker tests: Apple settings, an iOS app with a current
version in the fake bucket, iPhones, and the worker's App Store Connect
client swapped for a FakeAsc."""

import datetime as dt
import uuid
from pathlib import Path

from sqlalchemy import select

from serversherpa_devices.db.engine import get_sessionmaker
from serversherpa_devices.db.models import (
    App,
    AppleSettings,
    AppVersion,
    IosDevice,
    Job,
    SignedBuild,
)
from serversherpa_devices.services.secrets import seal

from .catalog_support import hello_ipa
from .fake_asc import ISSUER_ID, KEY_ID, TEAM_ID, TEST_P8, FakeAsc
from .fake_main_api import PERSON_ID

P12 = b"p12-bytes"
P12_PASSWORD = "p12 password"
UDID_A = "00008110-000A1B2C3D4E5F60"
UDID_B = "00008120-001122334455667E"
UDID_C = "00008030-00AA22BB33CC44DD"


def install_fake(monkeypatch) -> FakeAsc:
    """A FakeAsc with one distribution certificate; the worker's clients
    talk to it."""
    from serversherpa_devices.worker import jobs

    fake = FakeAsc()
    fake.cert_id = fake.add_certificate("1A2B3C")
    monkeypatch.setattr(jobs, "make_client", lambda creds: fake.client())
    return fake


async def seed_apple(db, *, cert_id: str = "CERT0001") -> None:
    db.add(AppleSettings(
        id=1, team_id=TEAM_ID, issuer_id=ISSUER_ID, key_id=KEY_ID, p8_enc=seal(TEST_P8),
        p12_enc=seal(P12), p12_password_enc=seal(P12_PASSWORD.encode()),
        asc_certificate_id=cert_id))
    await db.commit()


async def seed_ios_app(db, bucket, tmp_path: Path, *, identifier: str = "com.example.hello",
                       name: str = "Hello", asc_bundle_id: str | None = None,
                       current: bool = True) -> tuple[App, AppVersion]:
    """An iOS app with one version whose IPA is in the bucket."""
    app = App(id=uuid.uuid4(), platform="ios", identifier=identifier, name=name,
              asc_bundle_id=asc_bundle_id)
    ipa = hello_ipa(tmp_path / f"ipa-{app.id}")
    version = AppVersion(
        id=uuid.uuid4(), app_id=app.id, version_name="1.4", build="2", build_sort=2,
        file_key=f"apps/{app.id}/v/{ipa.name}", size=ipa.stat().st_size, sha256="0" * 64,
        min_os="16.0", uploaded_by=PERSON_ID, uploaded_by_name="Pat Admin",
        is_current=current)
    bucket.put(version.file_key, ipa.read_bytes())
    db.add(app)
    await db.flush()
    db.add(version)
    await db.commit()
    return app, version


async def seed_device(db, udid: str, *, name: str = "Pat's iPhone", status: str = "pending",
                      asc_device_id: str | None = None) -> IosDevice:
    device = IosDevice(id=uuid.uuid4(), udid=udid, name=name, product="iPhone14,5",
                       os_version="22B83", added_by=PERSON_ID, added_by_name="Pat Admin",
                       status=status, asc_device_id=asc_device_id)
    db.add(device)
    await db.commit()
    return device


async def queue(kind: str, payload: dict) -> Job:
    """Queue a job in its own committed transaction."""
    from serversherpa_devices.worker.queue import enqueue

    async with get_sessionmaker()() as session:
        job = await enqueue(session, kind, payload)
        await session.commit()
        return job


async def jobs_of(kind: str | None = None) -> list[Job]:
    async with get_sessionmaker()() as session:
        query = select(Job).order_by(Job.created_at, Job.id)
        if kind is not None:
            query = query.where(Job.kind == kind)
        return list((await session.scalars(query)).all())


async def fresh(model, ident):
    async with get_sessionmaker()() as session:
        return await session.get(model, ident)


async def signed_builds() -> list[SignedBuild]:
    async with get_sessionmaker()() as session:
        return list((await session.scalars(select(SignedBuild))).all())


async def run_all(limit: int = 20) -> int:
    """Run due jobs until the queue is idle; how many ran."""
    from serversherpa_devices.worker.run import run_once

    ran = 0
    while ran < limit and await run_once(get_sessionmaker()):
        ran += 1
    return ran


EXPIRES = dt.datetime(2027, 11, 17, 12, 0, tzinfo=dt.UTC)
