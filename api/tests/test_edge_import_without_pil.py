"""The laptop edge never has Pillow (kiosk_laptop/edge/pyproject.toml), so
the shared label core it imports must stay standard-library-only (spec
2026-10-20-badge-templates §4.5, §5). A fresh interpreter with PIL blocked
imports the edge's whole module set; Pillow belongs only in the API's
labels/image_prep.py, which the edge never imports."""

import subprocess
import sys
import textwrap
from pathlib import Path

import serversherpa

SRC = Path(serversherpa.__file__).resolve().parents[1]

# kiosk_laptop/edge/src/edge/labels/generate.py's imports, plus everything
# they pull in, plus the dither the image pipeline shares
EDGE_MODULES = (
    "serversherpa.labels.fields",
    "serversherpa.labels.label_values",
    "serversherpa.labels.pick",
    "serversherpa.labels.render",
    "serversherpa.labels.template_fonts",
    "serversherpa.labels.compile",
    "serversherpa.labels.zpl",
    "serversherpa.labels.model",
    "serversherpa.labels.dither",
)


def test_edge_import_without_pil():
    code = textwrap.dedent(f"""
        import importlib, sys
        sys.path.insert(0, {str(SRC)!r})
        sys.modules["PIL"] = None          # `import PIL` now raises ImportError
        for name in {EDGE_MODULES!r}:
            importlib.import_module(name)
        loaded = sorted(m for m in sys.modules
                        if m == "PIL" or m.startswith("PIL.") or m.startswith("fontTools"))
        assert loaded == ["PIL"], loaded   # only the blocker itself
        assert sys.modules["PIL"] is None
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
