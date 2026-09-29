"""`serversherpa.wiki.export_pdf`'s memory guard: `_apply_memory_limit`
caps this process's RLIMIT_AS from WIKI_EXPORT_PDF_MAX_MEMORY_MB before
WeasyPrint ever runs, so one pathological page dies of MemoryError
instead of slowly starving the worker host. Best-effort and never
fatal: there's no `resource` module on Windows, and even where there
is one, the platform may not honor RLIMIT_AS at all (macOS's kernel
doesn't enforce it the way Linux's does) — either way the export still
runs."""
import pytest

from serversherpa.wiki import export_pdf

pytest.importorskip("resource")
import resource  # noqa: E402 - importorskip must run first


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("WIKI_EXPORT_PDF_MAX_MEMORY_MB", raising=False)


def test_default_limit_is_2048mb(monkeypatch):
    calls = []
    monkeypatch.setattr(resource, "setrlimit",
                        lambda which, limits: calls.append((which, limits)))
    export_pdf._apply_memory_limit()
    [(which, (soft, hard))] = calls
    assert which == resource.RLIMIT_AS
    assert soft == hard == 2048 * 1024 * 1024


def test_honors_the_env_override(monkeypatch):
    monkeypatch.setenv("WIKI_EXPORT_PDF_MAX_MEMORY_MB", "512")
    calls = []
    monkeypatch.setattr(resource, "setrlimit", lambda which, limits: calls.append(limits))
    export_pdf._apply_memory_limit()
    assert calls == [(512 * 1024 * 1024, 512 * 1024 * 1024)]


def test_a_platform_that_refuses_the_limit_does_not_raise(monkeypatch):
    """macOS: RLIMIT_AS is sometimes refused outright."""
    def refuse(which, limits):
        raise ValueError("RLIMIT_AS not supported")
    monkeypatch.setattr(resource, "setrlimit", refuse)
    export_pdf._apply_memory_limit()    # must not raise


def test_a_platform_without_the_resource_module_does_not_raise(monkeypatch):
    """Windows: there's no `resource` module at all."""
    import builtins
    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name == "resource":
            raise ImportError("no module named resource")
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", blocked)
    export_pdf._apply_memory_limit()    # must not raise


def test_a_non_numeric_env_value_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("WIKI_EXPORT_PDF_MAX_MEMORY_MB", "not-a-number")
    calls = []
    monkeypatch.setattr(resource, "setrlimit", lambda which, limits: calls.append(limits))
    export_pdf._apply_memory_limit()
    assert calls == [(2048 * 1024 * 1024, 2048 * 1024 * 1024)]
