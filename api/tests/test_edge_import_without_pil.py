"""The laptop edge never has Pillow (kiosk_laptop/edge/pyproject.toml), so
the shared label core it imports must stay standard-library-only (spec
2026-10-20-badge-templates §4.5, §5). A fresh interpreter with PIL blocked
imports every `serversherpa` module the edge's source imports (read off
the source, so a new import is covered the day it lands) and, through
them, the shared core: compile, zpl, model and the dither the image
pipeline shares. Pillow belongs only in the API's labels/image_prep.py,
which the edge never imports."""

import re
import subprocess
import sys
import textwrap
from pathlib import Path

import serversherpa

SRC = Path(serversherpa.__file__).resolve().parents[1]
EDGE_SRC = SRC.parents[1] / "kiosk_laptop" / "edge" / "src" / "edge"
GENERATE = EDGE_SRC / "labels" / "generate.py"
_IMPORT = re.compile(r"^\s*(?:from\s+(serversherpa(?:\.\w+)*)\s+import|import\s+(serversherpa(?:\.\w+)*))",
                     re.MULTILINE)
# what the edge's imports pull in, the image core among them
SHARED_CORE = {"serversherpa.labels.compile", "serversherpa.labels.zpl",
               "serversherpa.labels.model", "serversherpa.labels.dither"}


def edge_modules() -> list[str]:
    found: set[str] = set()
    for path in sorted(EDGE_SRC.rglob("*.py")):
        for m in _IMPORT.finditer(path.read_text()):
            found.add(m.group(1) or m.group(2))
    return sorted(found)


def test_the_edge_module_list_is_read_off_its_source():
    assert GENERATE.is_file(), GENERATE
    from_generate = {m.group(1) or m.group(2) for m in _IMPORT.finditer(GENERATE.read_text())}
    assert from_generate >= {"serversherpa.labels.fields", "serversherpa.labels.render"}
    assert from_generate <= set(edge_modules())
    # never the API's generation package or the Pillow module
    assert not {m for m in edge_modules()
                if m.startswith(("serversherpa.labels.generate", "serversherpa.labels.image_prep"))}


def test_edge_import_without_pil():
    modules = edge_modules()
    code = textwrap.dedent(f"""
        import importlib, sys
        sys.path.insert(0, {str(SRC)!r})
        sys.modules["PIL"] = None          # `import PIL` now raises ImportError
        for name in {modules!r}:
            importlib.import_module(name)
        loaded = sorted(m for m in sys.modules
                        if m == "PIL" or m.startswith("PIL.") or m.startswith("fontTools"))
        assert loaded == ["PIL"], loaded   # only the blocker itself
        assert sys.modules["PIL"] is None
        missing = {sorted(SHARED_CORE)!r}
        missing = [m for m in missing if m not in sys.modules]
        assert not missing, missing        # the shared core was in the import set
        print("ok")
    """)
    r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True,
                       timeout=60, check=False)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "ok"


def test_the_blocker_works():
    """Guard the guard: a module that does import Pillow fails under it."""
    code = 'import sys; sys.modules["PIL"] = None; from PIL import Image'
    r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True,
                       timeout=60, check=False)
    assert r.returncode != 0 and "ModuleNotFoundError" in r.stderr
