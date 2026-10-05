"""The image installs exactly the pyVmomi pyproject.toml names, hash-checked."""

import re
import tomllib
from pathlib import Path

API = Path(__file__).resolve().parents[1]
SIRDAR = API.parent


def test_pyproject_and_the_hash_file_pin_the_same_pyvmomi():
    deps = tomllib.loads((API / "pyproject.toml").read_text())["project"]["dependencies"]
    [pin] = [d for d in deps if d.startswith("pyvmomi")]
    hashed = (API / "requirements-esxi.txt").read_text()
    version = pin.split("==", 1)[1]
    assert re.search(rf"^pyvmomi=={re.escape(version)} \\$", hashed, re.M)
    assert re.search(r"^six==[0-9.]+ \\$", hashed, re.M)
    assert hashed.count("--hash=sha256:") == 3


def test_the_image_installs_the_hash_file_before_the_app():
    text = (SIRDAR / "Dockerfile").read_text()
    hashed = text.index("--require-hashes --no-deps -r requirements-esxi.txt")
    assert hashed < text.index("RUN pip install --no-cache-dir .")
