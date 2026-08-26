""".env parsing/classification/rewrite — against temp files only."""

import pytest

from serversherpa.system.env_file import (
    EnvUpdateError, apply_updates, is_hidden, is_secret, read_entries,
)

SAMPLE = """# ServerSherpa dev environment
SS_ENV=development
SS_LOG_LEVEL=INFO  # Minimum level for process logs

# auth
SS_JWT_SECRET=supersecret123  # Signs  session JWTs
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
        "key": "SS_LOG_LEVEL", "secret": False, "value": "INFO",
        "description": "Minimum level for process logs",
        "section": "ServerSherpa dev environment"}
    jwt = entries["SS_JWT_SECRET"]
    assert jwt == {"key": "SS_JWT_SECRET", "secret": True, "set": True,
                    "description": "Signs  session JWTs", "section": "auth"}
    assert "supersecret123" not in str(entries)
    assert entries["SS_SMTP_HOST"]["value"] == ""
    # file order preserved
    keys = [e["key"] for e in read_entries(env_path)]
    assert keys.index("SS_ENV") < keys.index("SS_JWT_SECRET")


def test_read_entries_includes_descriptions(env_path):
    entries = {e["key"]: e for e in read_entries(env_path)}
    # trailing " # ..." comment is parsed into a separate description field
    assert entries["SS_LOG_LEVEL"]["description"] == \
        "Minimum level for process logs"
    # the value itself must not swallow the comment text
    assert entries["SS_LOG_LEVEL"]["value"] == "INFO"
    assert "#" not in entries["SS_LOG_LEVEL"]["value"]
    # no trailing comment -> description defaults to ""
    assert entries["SS_ENV"]["description"] == ""
    assert entries["SS_PASSWORD_PEPPER"]["description"] == ""


def test_read_entries_secret_description_without_value(env_path):
    entries = {e["key"]: e for e in read_entries(env_path)}
    jwt = entries["SS_JWT_SECRET"]
    assert jwt["description"] == "Signs  session JWTs"
    assert "value" not in jwt


def test_apply_updates_rewrites_preserving_layout(env_path):
    changed = apply_updates(env_path, {
        "SS_LOG_LEVEL": "DEBUG",
        "SS_JWT_SECRET": "",              # empty secret = keep
        "SS_SMTP_HOST": "smtp.local",
    })
    assert sorted(changed) == ["SS_LOG_LEVEL", "SS_SMTP_HOST"]
    text = env_path.read_text()
    # value updates AND the trailing description comment is preserved
    assert "SS_LOG_LEVEL=DEBUG  # Minimum level for process logs" in text
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


def test_apply_updates_preserves_trailing_comment_verbatim(env_path):
    # rewriting a commented key keeps exactly two spaces before "#" and
    # preserves the original comment text byte-for-byte (including the
    # double space inside "Signs  session JWTs" — no re-normalizing).
    apply_updates(env_path, {"SS_JWT_SECRET": "rotated"})
    text = env_path.read_text()
    assert "SS_JWT_SECRET=rotated  # Signs  session JWTs" in text
    # a key with no description rewrites to a plain KEY=value line
    apply_updates(env_path, {"SS_SMTP_HOST": "smtp.local"})
    assert "SS_SMTP_HOST=smtp.local\n" in env_path.read_text()


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


def test_hash_in_value_without_space_is_not_a_comment(tmp_path):
    path = tmp_path / ".env"
    path.write_text("SS_COOKIE_DOMAIN=pass#word\n")
    [entry] = [e for e in read_entries(path)
               if e["key"] == "SS_COOKIE_DOMAIN"]
    assert entry["value"] == "pass#word"
    assert entry["description"] == ""
    apply_updates(path, {"SS_COOKIE_DOMAIN": "new#value"})
    assert path.read_text() == "SS_COOKIE_DOMAIN=new#value\n"


# ── Mandate A: reject newline injection (security) ──────────────────


def test_apply_updates_rejects_newline_value(env_path):
    before = env_path.read_text()
    with pytest.raises(EnvUpdateError) as exc:
        apply_updates(env_path, {
            "SS_LOG_LEVEL": "INFO\nSS_DATABASE_URL=evil"})
    assert exc.value.unknown == ["SS_LOG_LEVEL"]
    assert env_path.read_text() == before      # nothing written


def test_apply_updates_rejects_carriage_return_value(env_path):
    before = env_path.read_text()
    with pytest.raises(EnvUpdateError) as exc:
        apply_updates(env_path, {"SS_LOG_LEVEL": "INFO\rSS_ENV=evil"})
    assert exc.value.unknown == ["SS_LOG_LEVEL"]
    assert env_path.read_text() == before


# ── Mandate B: section labels from standalone comments ───────────────

SECTION_SAMPLE = """SS_ENV=development

# E-Mail
SS_SMTP_HOST=smtp.example.com  # SMTP relay host
SS_SMTP_PORT=587

# Grafana
SS_GRAFANA_URL=https://grafana.example
"""


@pytest.fixture
def section_env_path(tmp_path):
    path = tmp_path / ".env"
    path.write_text(SECTION_SAMPLE)
    return path


def test_read_entries_tags_section_from_standalone_comment(section_env_path):
    entries = {e["key"]: e for e in read_entries(section_env_path)}
    # no standalone comment precedes SS_ENV -> ""
    assert entries["SS_ENV"]["section"] == ""
    # both keys under "# E-Mail" carry that section
    assert entries["SS_SMTP_HOST"]["section"] == "E-Mail"
    assert entries["SS_SMTP_PORT"]["section"] == "E-Mail"
    # a new standalone comment starts a new section
    assert entries["SS_GRAFANA_URL"]["section"] == "Grafana"
    # the trailing same-line comment (description) is a separate concern
    # from the standalone-comment section label
    assert entries["SS_SMTP_HOST"]["description"] == "SMTP relay host"


def test_apply_updates_preserves_standalone_comments(section_env_path):
    apply_updates(section_env_path, {"SS_SMTP_HOST": "smtp2.example.com"})
    text = section_env_path.read_text()
    assert "# E-Mail" in text
    assert "# Grafana" in text
    assert "SS_SMTP_HOST=smtp2.example.com  # SMTP relay host" in text
