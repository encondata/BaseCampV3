"""Helpers for the install-link and update-check tests: apps seeded straight
into the database with their files in the fake bucket, a profile, signed
builds, and a client that sends no session."""

import datetime as dt
import io
import uuid
from urllib.parse import parse_qs, urlsplit

from httpx import ASGITransport, AsyncClient
from PIL import Image
from sqlalchemy import select

from serversherpa_devices.db.models import App, AppVersion, IosProfile, Job, SignedBuild
from serversherpa_devices.packages.versions import ios_build_sort

from .catalog_support import HELLO_A, KEY_A_DIGEST
from .fake_main_api import PERSON_ID
from .worker_support import EXPIRES

PUBLIC_URL = "https://devices.test"


def anon_client(devices_app) -> AsyncClient:
    """A client with no Authorization header (what iOS and a download use)."""
    return AsyncClient(transport=ASGITransport(app=devices_app), base_url="http://testserver")


def local(url: str) -> str:
    """A public URL's path, for the test client."""
    assert url.startswith(PUBLIC_URL + "/"), url
    return url[len(PUBLIC_URL):]


def manifest_url(itms: str) -> str:
    """The https manifest URL inside an itms-services:// link."""
    parts = urlsplit(itms)
    assert parts.scheme == "itms-services", itms
    query = parse_qs(parts.query)
    assert query["action"] == ["download-manifest"]
    return query["url"][0]


def png(size: int = 120, color=(10, 120, 200, 255)) -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (size, size), color).save(out, format="PNG")
    return out.getvalue()


def _version(app: App, *, version_name: str, build: str, build_sort: int, file_key: str,
             size: int, current: bool, notes: str = "") -> AppVersion:
    return AppVersion(
        id=uuid.uuid4(), app_id=app.id, version_name=version_name, build=build,
        build_sort=build_sort, notes=notes, file_key=file_key, size=size, sha256="0" * 64,
        uploaded_by=PERSON_ID, uploaded_by_name="Pat Admin", is_current=current)


async def seed_android(db, bucket, *, versions=(("1.0", 1),), current: int = -1,
                       notes: str = "", identifier: str = "com.example.hello",
                       digest: str = KEY_A_DIGEST) -> tuple[App, list[AppVersion]]:
    """An Android app with one version per (version_name, version_code);
    `current` indexes the current one. Each APK is hello-a.apk's bytes."""
    app = App(id=uuid.uuid4(), platform="android", identifier=identifier,
              name="Hello Fixture", signing_digest=digest)
    db.add(app)
    await db.flush()
    data = HELLO_A.read_bytes()
    rows = []
    for i, (name, code) in enumerate(versions):
        key = f"apps/{app.id}/{uuid.uuid4()}/hello-{code}.apk"
        bucket.put(key, data, "application/vnd.android.package-archive")
        rows.append(_version(app, version_name=name, build=str(code), build_sort=code,
                             file_key=key, size=len(data), notes=notes,
                             current=i == (current % len(versions))))
    db.add_all(rows)
    await db.commit()
    return app, rows


async def add_ios_version(db, bucket, app: App, *, version_name: str, build: str,
                          current: bool = False) -> AppVersion:
    key = f"apps/{app.id}/{uuid.uuid4()}/Hello.ipa"
    bucket.put(key, b"original ipa " + build.encode())
    version = _version(app, version_name=version_name, build=build,
                       build_sort=ios_build_sort(build), file_key=key, size=13 + len(build),
                       current=current)
    db.add(version)
    await db.commit()
    return version


async def add_icon(db, bucket, app: App) -> None:
    app = await db.get(App, app.id)
    app.icon_key = f"apps/{app.id}/icon.png"
    bucket.put(app.icon_key, png(), "image/png")
    await db.commit()


async def add_profile(db, app: App, device_ids: list[uuid.UUID],
                      profile_uuid: str = "PROFILE-UUID-1") -> IosProfile:
    profile = IosProfile(app_id=app.id, asc_profile_id="ASCPROF1", content=b"profile",
                         expires_at=EXPIRES, device_ids=device_ids, uuid=profile_uuid)
    db.add(profile)
    await db.commit()
    return profile


async def add_signed(db, bucket, version: AppVersion, *, status: str = "ready",
                     profile_uuid: str = "PROFILE-UUID-1",
                     data: bytes = b"signed ipa bytes",
                     failed_at: dt.datetime | None = None) -> SignedBuild:
    key = None
    if status == "ready":
        key = f"apps/{version.app_id}/{version.id}/signed/{profile_uuid}.ipa"
        bucket.put(key, data)
    row = SignedBuild(id=uuid.uuid4(), version_id=version.id, profile_uuid=profile_uuid,
                      status=status, file_key=key,
                      error="Signing didn't finish." if status == "failed" else None,
                      failed_at=failed_at)
    db.add(row)
    await db.commit()
    return row


async def sign_jobs(db) -> list[Job]:
    return list((await db.scalars(
        select(Job).where(Job.kind == "sign_build").order_by(Job.created_at)
        .execution_options(populate_existing=True))).all())
