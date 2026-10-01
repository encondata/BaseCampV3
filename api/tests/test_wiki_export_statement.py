"""The confidentiality statement for an exported PDF's cover: the wiki's
standard text (`system_config` section `wiki`, edited through
`GET`/`PUT /wiki/admin/export-settings` by wiki administrators), a
library's own override (`PATCH /wiki/spaces/{key}` settings), and how the
two combine (`serversherpa.wiki.statement`)."""
import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog
from serversherpa.wiki.statement import (
    DEFAULT_CONFIDENTIALITY_STATEMENT,
    MAX_STATEMENT_LENGTH,
    effective_statement,
    standard_statement,
)
from tests.test_wiki_spaces_api import _create_space
from tests.wiki_helpers import login_as

URL = "/wiki/admin/export-settings"


# ── the statement helpers ────────────────────────────────────────────


async def test_standard_statement_is_the_default_without_a_row(db):
    assert await standard_statement(db) == DEFAULT_CONFIDENTIALITY_STATEMENT
    assert DEFAULT_CONFIDENTIALITY_STATEMENT == (
        "CONFIDENTIAL — This document contains proprietary information of Cumulus "
        "Solutions Group. It is intended solely for authorized recipients and may not "
        "be copied, distributed or disclosed without written permission.")
    assert MAX_STATEMENT_LENGTH == 1000


def test_a_library_statement_overrides_the_standard_one():
    assert effective_statement("std", {"confidentiality_statement": "  own  "}) == "own"


def test_an_empty_library_statement_falls_back_to_the_standard_one():
    assert effective_statement("std", {"confidentiality_statement": "   "}) == "std"
    assert effective_statement("std", {"confidentiality_statement": ""}) == "std"
    assert effective_statement("std", {}) == "std"
    assert effective_statement("std", None) == "std"
    assert effective_statement("  ", None) == ""


# ── GET / PUT /wiki/admin/export-settings ────────────────────────────


async def _admin(client, db):
    headers, _ = await login_as(client, db, roles=("admin",))
    return headers


async def test_get_returns_the_default_until_one_is_saved(client, db):
    admin = await _admin(client, db)
    resp = await client.get(URL, headers=admin)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"confidentiality_statement": DEFAULT_CONFIDENTIALITY_STATEMENT}


async def test_put_trims_saves_and_audits(client, db):
    admin = await _admin(client, db)
    resp = await client.put(URL, headers=admin,
                            json={"confidentiality_statement": "  Line one\nLine two  \n"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"confidentiality_statement": "Line one\nLine two"}
    assert (await client.get(URL, headers=admin)).json() == {
        "confidentiality_statement": "Line one\nLine two"}
    assert await standard_statement(db) == "Line one\nLine two"

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "wiki",
        AuditLog.action == "wiki_config_update"))).all()
    assert len(audits) == 1
    assert audits[0].changes == {"confidentiality_statement": {
        "from": DEFAULT_CONFIDENTIALITY_STATEMENT, "to": "Line one\nLine two"}}


async def test_put_allows_an_empty_statement(client, db):
    admin = await _admin(client, db)
    resp = await client.put(URL, headers=admin, json={"confidentiality_statement": "   "})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"confidentiality_statement": ""}
    assert (await client.get(URL, headers=admin)).json() == {"confidentiality_statement": ""}
    assert await standard_statement(db) == ""


async def test_put_rejects_control_characters_but_keeps_line_breaks(client, db):
    admin = await _admin(client, db)
    bad = await client.put(URL, headers=admin,
                           json={"confidentiality_statement": "Secret\u0000 stuff"})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "bad_setting"
    ok = await client.put(URL, headers=admin,
                          json={"confidentiality_statement": "Line one\nLine two\tend"})
    assert ok.status_code == 200
    assert ok.json()["confidentiality_statement"] == "Line one\nLine two\tend"


async def test_put_rejects_a_statement_over_1000_characters(client, db):
    admin = await _admin(client, db)
    resp = await client.put(URL, headers=admin,
                            json={"confidentiality_statement": "x" * 1001})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_setting"
    # 1000 after trimming is fine
    ok = await client.put(URL, headers=admin,
                          json={"confidentiality_statement": " " + "x" * 1000 + " "})
    assert ok.status_code == 200, ok.text
    assert len(ok.json()["confidentiality_statement"]) == 1000


@pytest.mark.parametrize("body", [
    {"confidentiality_statement": 5},
    {"confidentiality_statement": None},
    {},
    {"confidentiality_statement": "x", "extra": 1},
])
async def test_put_rejects_a_malformed_body(client, db, body):
    admin = await _admin(client, db)
    assert (await client.put(URL, headers=admin, json=body)).status_code == 422


async def test_only_wiki_admins_can_read_or_change_it(client, db):
    staff, _ = await login_as(client, db, roles=("staff",))
    for resp in (await client.get(URL, headers=staff),
                 await client.put(URL, headers=staff,
                                  json={"confidentiality_statement": "x"})):
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["code"] == "forbidden"
    assert await standard_statement(db) == DEFAULT_CONFIDENTIALITY_STATEMENT


# ── the library override (PATCH /wiki/spaces/{key}) ──────────────────


async def _library(client, db, key):
    headers, _ = await login_as(client, db, roles=("staff",))
    assert (await _create_space(client, headers, key=key, default_access="private")).status_code == 201
    return headers


async def test_patch_stores_a_trimmed_library_statement(client, db):
    headers = await _library(client, db, "stmt-own")
    resp = await client.patch("/wiki/spaces/stmt-own", headers=headers,
                              json={"settings": {"confidentiality_statement": " x "}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["confidentiality_statement"] == "x"
    got = await client.get("/wiki/spaces/stmt-own", headers=headers)
    assert got.json()["settings"]["confidentiality_statement"] == "x"


async def test_patch_clears_the_library_statement_with_an_empty_one(client, db):
    headers = await _library(client, db, "stmt-clear")
    await client.patch("/wiki/spaces/stmt-clear", headers=headers,
                       json={"settings": {"confidentiality_statement": "x"}})
    resp = await client.patch("/wiki/spaces/stmt-clear", headers=headers,
                              json={"settings": {"confidentiality_statement": "  "}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["confidentiality_statement"] == ""


@pytest.mark.parametrize("value", ["x" * 1001, "a\u0000b", "bell\u0007", 5, None, True, ["x"]])
async def test_patch_rejects_a_bad_library_statement(client, db, value):
    headers = await _library(client, db, "stmt-bad")
    resp = await client.patch("/wiki/spaces/stmt-bad", headers=headers,
                              json={"settings": {"confidentiality_statement": value}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_setting"
