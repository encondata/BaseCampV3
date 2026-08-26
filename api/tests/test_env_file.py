""".env parsing/classification/rewrite — against temp files only."""

import pytest

from serversherpa.system.env_file import (
    EnvUpdateError, apply_updates, is_hidden, is_secret, read_entries,
)

SAMPLE = """# ServerSherpa dev environment
SS_ENV=development
SS_LOG_LEVEL=INFO

# auth
SS_JWT_SECRET=supersecret123
SS_PASSWORD_PEPPER=pepperpepper

# db (hidden)
SS_DATABASE_URL=postgresql+asyncpg://u:p@h/db
POSTGRES_PASSWORD=pgpass

SS_SMTP_HOST=
SS_SENTRY_DSN=https://key@sentry.example/1
"""


@pytest.fixture
def env_path(tmp_path):
    path = tmp_path / ".env"
    path.write_text(SAMPLE)
    return path


def test_classification():
    assert is_hidden("SS_DATABASE_URL")
    assert is_hidden("SS_SPACES_SECRET_KEY")
    assert is_hidden("POSTGRES_PASSWORD")
    assert is_hidden("MINIO_ROOT_USER")
    assert not is_hidden("SS_JWT_SECRET")
    assert is_secret("SS_JWT_SECRET")          # SecretStr introspection
    assert is_secret("SS_PASSWORD_PEPPER")
    assert is_secret("SS_GOD_MODE_WORDS")
    assert is_secret("SS_SENTRY_DSN")          # name heuristic (DSN)
    assert not is_secret("SS_LOG_LEVEL")


def test_read_entries_masks_and_hides(env_path):
    entries = {e["key"]: e for e in read_entries(env_path)}
    assert "SS_DATABASE_URL" not in entries
    assert "POSTGRES_PASSWORD" not in entries
    assert entries["SS_LOG_LEVEL"] == {
        "key": "SS_LOG_LEVEL", "secret": False, "value": "INFO"}
    jwt = entries["SS_JWT_SECRET"]
    assert jwt == {"key": "SS_JWT_SECRET", "secret": True, "set": True}
    assert "supersecret123" not in str(entries)
    assert entries["SS_SMTP_HOST"]["value"] == ""
    # file order preserved
    keys = [e["key"] for e in read_entries(env_path)]
    assert keys.index("SS_ENV") < keys.index("SS_JWT_SECRET")


def test_apply_updates_rewrites_preserving_layout(env_path):
    changed = apply_updates(env_path, {
        "SS_LOG_LEVEL": "DEBUG",
        "SS_JWT_SECRET": "",              # empty secret = keep
        "SS_SMTP_HOST": "smtp.local",
    })
    assert sorted(changed) == ["SS_LOG_LEVEL", "SS_SMTP_HOST"]
    text = env_path.read_text()
    assert "SS_LOG_LEVEL=DEBUG" in text
    assert "SS_JWT_SECRET=supersecret123" in text     # kept
    assert "SS_SMTP_HOST=smtp.local" in text
    assert text.startswith("# ServerSherpa dev environment")
    assert "# auth" in text                            # comments preserved
    backup = env_path.with_suffix(".bak")
    assert backup.exists()
    assert "SS_LOG_LEVEL=INFO" in backup.read_text()   # pre-change copy


def test_apply_updates_replaces_secret(env_path):
    changed = apply_updates(env_path, {"SS_JWT_SECRET": "newsecret"})
    assert changed == ["SS_JWT_SECRET"]
    assert "SS_JWT_SECRET=newsecret" in env_path.read_text()


def test_apply_updates_rejects_unknown_and_hidden(env_path):
    with pytest.raises(EnvUpdateError) as exc:
        apply_updates(env_path, {"SS_DATABASE_URL": "x",
                                 "SS_NOT_A_KEY": "y"})
    assert sorted(exc.value.unknown) == ["SS_DATABASE_URL", "SS_NOT_A_KEY"]
    # nothing written
    assert "SS_DATABASE_URL=postgresql+asyncpg://u:p@h/db" \
        in env_path.read_text()


def test_no_change_is_not_reported(env_path):
    assert apply_updates(env_path, {"SS_LOG_LEVEL": "INFO"}) == []
