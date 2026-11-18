"""A bucket in a temp directory, patched over services.storage's functions
(no boto3, no moto). Routes call `storage.<fn>` through the module, so the
patch reaches them.

    bucket = FakeStorage(tmp_path / "bucket").install(monkeypatch)
    bucket.put(key, data)          # what the browser's presigned PUT does
    bucket.exists(key) / bucket.read(key) / bucket.object_keys()
    bucket.presigned               # [(key, content_type, size)]
"""

import shutil
from pathlib import Path

from serversherpa_devices.services import storage


class FakeStorage:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.content_types: dict[str, str] = {}
        self.presigned: list[tuple[str, str, int]] = []

    def install(self, monkeypatch) -> "FakeStorage":
        for name in ("presign_put", "head_object", "download_to", "upload_from",
                     "open_stream", "delete_object", "copy_object"):
            monkeypatch.setattr(storage, name, getattr(self, name))
        return self

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        assert self.root.resolve() in path.parents, key
        return path

    # Test helpers.
    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.content_types[key] = content_type

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def object_keys(self) -> set[str]:
        return {p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file()}

    # The storage API.
    def presign_put(self, key: str, content_type: str, size: int, expires: int = 900) -> str:
        self.presigned.append((key, content_type, size))
        return f"https://bucket.test/{key}?X-Amz-Expires={expires}"

    async def head_object(self, key: str) -> dict | None:
        path = self._path(key)
        if not path.is_file():
            return None
        return {"size": path.stat().st_size, "content_type": self.content_types.get(key, "")}

    async def download_to(self, key: str, path: Path) -> None:
        shutil.copyfile(self._path(key), path)

    async def upload_from(self, path: Path, key: str, content_type: str) -> None:
        self.put(key, Path(path).read_bytes(), content_type)

    async def open_stream(self, key: str):
        data = self._path(key).read_bytes()
        for i in range(0, len(data), 1024):
            yield data[i:i + 1024]

    async def delete_object(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    async def copy_object(self, source_key: str, key: str) -> None:
        self.put(key, self.read(source_key), self.content_types.get(source_key, ""))
