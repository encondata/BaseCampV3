"""The storage client's shared SSLContext must already hold its CA bundle
before any request can use it.

botocore gives a client ONE SSLContext for its whole connection pool, and
urllib3 calls `load_verify_locations()` on that shared context for every
new connection. On a context that has never been loaded, OpenSSL's
`X509_STORE_add_lookup` pushes onto the store's lookup stack with no lock,
so two connections opening at once (4 wiki images completing together,
each running `head_object` in its own thread) can leave a NULL entry that
the next certificate check dereferences — the dev API died with SIGSEGV in
`X509_STORE_CTX_get_by_subject` exactly that way on 2026-09-29
(openssl/openssl#24480, boto/botocore#3164). Loading once, up front, means
the later per-connection loads find the lookup already there and never
push. No network here: building a client and loading a CA file are local."""
from types import SimpleNamespace

from pydantic import SecretStr

from serversherpa.services import storage


def _settings(endpoint: str):
    return SimpleNamespace(
        spaces_endpoint=endpoint,
        spaces_region="us-east-1",
        spaces_access_key=SecretStr("test-access"),
        spaces_secret_key=SecretStr("test-secret"),
        spaces_use_path_style=True,
    )


def _pool_context(client, url: str):
    """The SSLContext urllib3 will hand every connection it opens to `url`."""
    manager = client._endpoint.http_session._manager
    return manager.connection_from_url(url).conn_kw["ssl_context"]


def test_https_client_context_is_loaded_before_first_request(monkeypatch):
    monkeypatch.setattr(storage, "get_settings",
                        lambda: _settings("https://files.example.test"))
    client = storage._client.__wrapped__()   # bypass the process-wide cache
    ctx = _pool_context(client, "https://files.example.test/bucket/key")
    assert ctx.cert_store_stats()["x509_ca"] > 0


def test_plain_http_client_is_left_alone(monkeypatch):
    """MinIO on http://localhost:9000 never does TLS — nothing to load, and
    building the client must not fail."""
    monkeypatch.setattr(storage, "get_settings",
                        lambda: _settings("http://localhost:9000"))
    client = storage._client.__wrapped__()
    ctx = _pool_context(client, "https://files.example.test/bucket/key")
    assert ctx.cert_store_stats()["x509_ca"] == 0
