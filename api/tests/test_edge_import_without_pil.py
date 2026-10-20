"""The laptop edge never has Pillow (kiosk_laptop/edge/pyproject.toml), so
the shared label core it imports must stay standard-library-only (spec
2026-10-20-badge-templates §4.5, §5). A fresh interpreter with PIL blocked
imports every `serversherpa` module the edge's source imports (read off
the source, so a new import is covered the day it lands) and, through
them, the shared core: compile, zpl, model and the dither the image
pipeline shares. Pillow belongs only in the API's labels/image_prep.py,
which the edge never imports."""

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

import serversherpa

SRC = Path(serversherpa.__file__).resolve().parents[1]
EDGE_SRC = SRC.parents[1] / "kiosk_laptop" / "edge" / "src" / "edge"
GENERATE = EDGE_SRC / "labels" / "generate.py"
# what the edge's imports pull in, the image core among them
SHARED_CORE = {"serversherpa.labels.compile", "serversherpa.labels.zpl",
               "serversherpa.labels.model", "serversherpa.labels.dither"}


def _is_module(name: str) -> bool:
    path = SRC.joinpath(*name.split("."))
    return path.with_suffix(".py").is_file() or (path / "__init__.py").is_file()


def imported_modules(source: str) -> set[str]:
    """Every `serversherpa` module `source` imports: `import a.b`, `from
    a.b import c` (a.b, and a.b.c when c is itself a module, as in `from
    serversherpa.labels import dither, zpl`), wherever the import sits."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names if a.name.split(".")[0] == "serversherpa")
        elif (isinstance(node, ast.ImportFrom) and node.level == 0 and node.module
              and node.module.split(".")[0] == "serversherpa"):
            found.add(node.module)
            found.update(f"{node.module}.{a.name}" for a in node.names
                         if _is_module(f"{node.module}.{a.name}"))
    return found


def edge_modules() -> list[str]:
    found: set[str] = set()
    for path in sorted(EDGE_SRC.rglob("*.py")):
        found |= imported_modules(path.read_text())
    return sorted(found)


def test_the_scanner_records_submodules():
    src = textwrap.dedent("""
        from serversherpa.labels import dither, zpl
        from serversherpa.labels.fields import (design_field_keys,
                                                field_values)
        import serversherpa.labels.model
        from os import path

        def later():
            from serversherpa.labels import pick as chooser
    """)
    assert imported_modules(src) == {
        "serversherpa.labels", "serversherpa.labels.dither", "serversherpa.labels.zpl",
        "serversherpa.labels.fields", "serversherpa.labels.model", "serversherpa.labels.pick"}


def test_the_edge_module_list_is_read_off_its_source():
    assert GENERATE.is_file(), GENERATE
    from_generate = imported_modules(GENERATE.read_text())
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
