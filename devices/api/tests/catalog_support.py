"""Helpers for the catalog and upload API tests: push a file through
POST /uploads → presigned PUT (the fake bucket) → inspect → commit."""

import json
from pathlib import Path

from serversherpa_devices.db.models import AppleSettings

from .package_fixtures import (
    gradient_pixels,
    hello_info_plist,
    make_cgbi,
    make_ipa,
    make_provision,
)

FIXTURES = Path(__file__).parent / "fixtures"
HELLO_A = FIXTURES / "hello-a.apk"
HELLO_A2 = FIXTURES / "hello-a2.apk"
KEY_A_DIGEST = "2eb648de103c7514530f1d0a85f492a5e924ad53e4e94700b0115e19575f1e1f"
KEY_B_DIGEST = "96c8b9d024605bc3455e7779a9b4efe5c57f69a5b3d528d152b2cb7710ca39a4"
APK_TYPE = "application/vnd.android.package-archive"


def hello_ipa(directory: Path, *, version: str = "1.4", build: str = "2") -> Path:
    """An IPA for com.example.hello with an icon and an Ad Hoc profile."""
    directory.mkdir(parents=True, exist_ok=True)
    return make_ipa(
        directory / f"Hello-{version}-{build}.ipa",
        info=hello_info_plist(CFBundleShortVersionString=version, CFBundleVersion=build),
        files={
            "Payload/Hello.app/AppIcon60x60@2x.png": make_cgbi(120, 120, gradient_pixels(120, 120)),
            "Payload/Hello.app/embedded.mobileprovision": make_provision(
                devices=["00008110-000A1B2C3D4E5F60"]),
        })


async def apple_settings_filled(db) -> None:
    db.add(AppleSettings(id=1, team_id="TEAM123456", p12_enc=b"sealed"))
    await db.commit()


async def start_upload(api, bucket, path: Path, *, put: bool = True,
                       content_type: str = "application/octet-stream") -> str:
    """POST /uploads, then (when `put`) the browser's PUT. The upload id."""
    data = path.read_bytes()
    r = await api.post("/api/uploads", json={"filename": path.name, "size": len(data),
                                             "content_type": content_type})
    assert r.status_code == 201, r.text
    body = r.json()
    key, signed_type, size = bucket.presigned[-1]
    assert body["put_url"].startswith(f"https://bucket.test/{key}")
    assert body["headers"] == {"Content-Type": signed_type}
    assert size == len(data)
    if put:
        bucket.put(key, data, signed_type)
    return body["upload_id"]


async def inspect(api, upload_id: str) -> dict:
    r = await api.post(f"/api/uploads/{upload_id}/inspect")
    assert r.status_code == 200, r.text
    return r.json()


async def commit(api, upload_id: str, notes: str = ""):
    return await api.post(f"/api/uploads/{upload_id}/commit", json={"notes": notes})


async def publish(api, bucket, path: Path, notes: str = "") -> dict:
    """Upload, inspect and commit a file that has no problems."""
    upload_id = await start_upload(api, bucket, path)
    review = await inspect(api, upload_id)
    assert review["problems"] == [], review
    r = await commit(api, upload_id, notes)
    assert r.status_code == 201, r.text
    return r.json()


def audits(main_fake) -> list[dict]:
    return [json.loads(call.request.content) for call in main_fake.audit_route.calls]
