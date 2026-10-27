"""Learning translations and quiz admin: per-language status (missing,
draft, in_review, published, out_of_date), Claude drafts (a fake client,
never the network), the last-editor review rule, HTML sanitizing on every
write, question validation, and unlocking a locked quiz."""
import json
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog
from serversherpa.learning import translate
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningQuizAttempt,
    LearningQuizQuestion,
    LearningTranslation,
)
from serversherpa.spec_lookup.provider import ClaudeProvider
from tests.test_learn_training import _assign, _fresh, _learner, _plain_doc, _question
from tests.test_learning_assign import _doc, _manager, _publish
from tests.test_spec_lookup_provider import FakeMessages, Resp
from tests.test_status_values_write import _make

# ── helpers ──────────────────────────────────────────────────────────

HTML = ('<p data-text-align="left">Wear <strong>boots</strong>.</p>'
        '<figure data-wiki-image="123e4567-e89b-12d3-a456-426614174000">'
        '<img alt="Boots"></figure>')


def _url(doc, lang="ja", tail=""):
    return f"/learning/documents/{doc.id}/translations/{lang}{tail}"


async def _published_doc(db, title="Site safety"):
    doc = await _doc(db, title)
    (await db.get(LearningDocumentVersion, doc.current_version_id)).content_html = HTML
    await db.commit()
    return doc


@pytest.fixture
def claude(monkeypatch):
    """A key is set and the Anthropic client is a fake that answers with
    whatever `claude.answer` holds."""
    monkeypatch.setenv("SS_ANTHROPIC_API_KEY", "sk-test-key")
    get_settings.cache_clear()
    messages = FakeMessages([])
    state = SimpleNamespace(messages=messages, answer={
        "title": "現場の安全", "content_html": "<p>ブーツを履いてください。</p>"})

    def get_provider():
        text = json.dumps(state.answer)
        messages.responses.append(Resp([{"type": "text", "text": text}]))
        client = SimpleNamespace(messages=messages, close=lambda: None)
        return ClaudeProvider(api_key="sk-test-key", model="claude-sonnet-5", client=client)

    monkeypatch.setattr(translate.lookup, "get_provider", get_provider)
    yield state
    get_settings.cache_clear()


async def _save(client, hdrs, doc, lang="ja", html="<p>こんにちは</p>", title="安全"):
    return await client.put(_url(doc, lang), headers=hdrs,
                            json={"title": title, "content_html": html})


# ── statuses and the review flow ─────────────────────────────────────


async def test_out_of_date_after_new_version(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    r = await client.get(f"/learning/documents/{doc.id}/translations", headers=hdrs)
    assert r.status_code == 200, r.text
    assert [(x["language"], x["status"], x["version_no"]) for x in r.json()] == [
        ("ja", "missing", None), ("ko", "missing", None), ("he", "missing", None)]

    saved = await _save(client, hdrs, doc)
    assert saved.status_code == 200, saved.text
    assert saved.json()["status"] == "draft" and saved.json()["source"] == "manual"
    rows = {x["language"]: x for x in (await client.get(
        f"/learning/documents/{doc.id}/translations", headers=hdrs)).json()}
    assert (rows["ja"]["status"], rows["ja"]["version_no"]) == ("draft", 1)
    assert rows["ja"]["updated_at"] is not None and rows["ja"]["reviewed_by"] is None
    assert rows["ko"]["status"] == "missing"

    await _publish(db, doc)                                    # version 2
    rows = {x["language"]: x for x in (await client.get(
        f"/learning/documents/{doc.id}/translations", headers=hdrs)).json()}
    assert (rows["ja"]["status"], rows["ja"]["version_no"]) == ("out_of_date", 1)
    # the old translation is still readable as a starting point
    old = await client.get(_url(doc), headers=hdrs)
    assert old.json()["status"] == "out_of_date"
    assert (old.json()["version_no"], old.json()["current_version_no"]) == (1, 2)
    # it can't move through review for a version it isn't of
    submit = await client.post(_url(doc, tail="/submit"), headers=hdrs)
    assert submit.status_code == 409 and submit.json()["detail"]["code"] == "out_of_date"
    # a save is a new draft for version 2; version 1's row is kept
    again = await _save(client, hdrs, doc)
    assert again.json()["status"] == "draft" and again.json()["version_no"] == 2
    assert len(list(await db.scalars(select(LearningTranslation)))) == 2
    # the library list reads the same way
    listed = (await client.get("/learning/documents", headers=hdrs)).json()
    assert listed[0]["languages"] == {"ja": "draft"}


async def test_approve_requires_different_reviewer(client, db, seeded_user):
    editor = await _manager(db, client)
    reviewer = await _manager(db, client)
    developer = await _make(db, client, "developer", f"dv-{uuid.uuid4().hex[:6]}@test.example.com")
    doc = await _published_doc(db)
    await _save(client, editor, doc)

    # only a draft can be sent to review; only one in review approved
    early = await client.post(_url(doc, tail="/approve"), headers=reviewer)
    assert early.status_code == 409 and early.json()["detail"]["code"] == "not_in_review"
    sent = await client.post(_url(doc, tail="/submit"), headers=editor)
    assert sent.status_code == 200 and sent.json()["status"] == "in_review"
    twice = await client.post(_url(doc, tail="/submit"), headers=editor)
    assert twice.status_code == 409 and twice.json()["detail"]["code"] == "not_draft"

    own = await client.post(_url(doc, tail="/approve"), headers=editor)
    assert own.status_code == 409 and own.json()["detail"]["code"] == "self_review"
    row = await db.scalar(select(LearningTranslation))
    await db.refresh(row)
    assert row.status == "in_review" and row.reviewed_by is None

    done = await client.post(_url(doc, tail="/approve"), headers=reviewer)
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["status"] == "published" and body["reviewed_by"]["name"]
    assert body["reviewed_at"] is not None
    assert await db.scalar(select(AuditLog.id).where(
        AuditLog.action == "learning_translation_approve")) is not None

    # an edit makes it a draft again and clears the review
    edited = await _save(client, reviewer, doc, html="<p>更新</p>")
    assert edited.json()["status"] == "draft" and edited.json()["reviewed_by"] is None

    # a developer may approve their own work
    await client.post(_url(doc, tail="/submit"), headers=developer)
    await _save(client, developer, doc, html="<p>開発者</p>")
    await client.post(_url(doc, tail="/submit"), headers=developer)
    mine = await client.post(_url(doc, tail="/approve"), headers=developer)
    assert mine.status_code == 200 and mine.json()["status"] == "published"


async def test_languages_limited_to_configured_targets(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    for lang in ("en", "fr"):
        r = await _save(client, hdrs, doc, lang=lang)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_language", lang
    r = await client.get(_url(doc, "ko"), headers=hdrs)
    assert r.status_code == 404
    unpublished = LearningDocument(title="Draft only")
    db.add(unpublished)
    await db.commit()
    r = await _save(client, hdrs, unpublished)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_published"


async def test_published_translation_is_what_workers_read(client, db, seeded_user):
    editor = await _manager(db, client)
    reviewer = await _manager(db, client)
    doc = await _published_doc(db)
    row = await _plain_doc_like(db, doc)
    wanda, whdrs = await _learner(db)
    assignment = await _assign(db, wanda, row, opened_ago=10)
    await _save(client, editor, doc, html='<p>日本語<script>alert(1)</script></p>')
    # a draft isn't served
    got = (await client.get(f"/learn/assignments/{assignment.id}?lang=ja", headers=whdrs)).json()
    assert got["fallback"] is True and "日本語" not in got["html"]
    await client.post(_url(doc, tail="/submit"), headers=editor)
    await client.post(_url(doc, tail="/approve"), headers=reviewer)
    got = (await client.get(f"/learn/assignments/{assignment.id}?lang=ja", headers=whdrs)).json()
    assert got["fallback"] is False and got["language"] == "ja"
    assert "日本語" in got["html"] and "<script" not in got["html"]


async def _plain_doc_like(db, doc):
    doc.require_scroll, doc.sign_style = False, "checkbox"
    await db.commit()
    return doc


# ── Claude ───────────────────────────────────────────────────────────


async def test_draft_via_claude_saved_as_draft(client, db, seeded_user, claude):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    claude.answer = {"title": "現場の安全",
                     "content_html": "<p>ブーツを<strong>履いて</strong>ください。"
                                     "<script>alert(1)</script></p>"}
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "draft" and body["source"] == "claude"
    assert body["title"] == "現場の安全"
    assert body["content_html"] == "<p>ブーツを<strong>履いて</strong>ください。</p>"
    row = await db.scalar(select(LearningTranslation))
    assert row.source == "claude" and row.status == "draft" and row.language == "ja"
    assert row.updated_by is not None

    # the request told Claude to translate the text only, and carried the document
    [call] = claude.messages.calls
    assert call["model"] == get_settings().spec_lookup_model
    assert "tag" in call["system"] and "attribute" in call["system"]
    prompt = call["messages"][0]["content"]
    assert 'language with code "ja"' in prompt and HTML in prompt and "Site safety" in prompt
    assert "tools" not in call

    # regenerating a draft is fine; reviewed work isn't overwritten by accident
    claude.answer = {"title": "安全", "content_html": "<p>再</p>"}
    assert (await client.post(_url(doc, tail="/draft"), headers=hdrs)).status_code == 200
    await client.post(_url(doc, tail="/submit"), headers=hdrs)
    refused = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "translation_exists"


async def test_claude_failures(client, db, seeded_user, claude):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    claude.answer = {"title": "x"}                       # no content_html
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 502 and r.json()["detail"]["code"] == "translation_failed"
    claude.answer = {"title": "x", "content_html": "<script>x</script>"}   # nothing left
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 502
    assert list(await db.scalars(select(LearningTranslation))) == []


async def test_no_key_503(client, db, seeded_user, monkeypatch):
    monkeypatch.setenv("SS_ANTHROPIC_API_KEY", "")
    get_settings.cache_clear()
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "translation_unavailable"
    assert list(await db.scalars(select(LearningTranslation))) == []


async def test_translation_needs_a_manager(client, db, seeded_user):
    doc = await _published_doc(db)
    for method, tail in (("get", ""), ("put", ""), ("post", "/draft"), ("post", "/submit"),
                         ("post", "/approve")):
        r = await getattr(client, method)(
            _url(doc, tail=tail), **({"json": {"title": "x", "content_html": "<p>x</p>"}}
                                     if method == "put" else {}))
        assert r.status_code == 401, (method, tail)


# ── sanitizing ───────────────────────────────────────────────────────


async def test_sanitizes_script(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    dirty = (
        '<h2 onclick="x()">Title</h2><script>alert(1)</script><style>p{}</style>'
        '<p onmouseover="x()" style="position:fixed; text-align: center">Hi '
        '<a href="javascript:alert(1)">bad</a> <a href="https://ok.example.com/p" '
        'onclick="x()" target="_blank" rel="opener">ok</a> <a href="/n/1">rel</a></p>'
        '<iframe src="https://evil.example.com"></iframe><img src="https://t.example/p.png" '
        'onerror="x()" alt="a"><form action="/x"><input type="text" value="x"></form>'
        '<svg onload="x()"></svg><!-- c -->')
    r = await _save(client, hdrs, doc, html=dirty, title="<b>Sa</b>fety<script>1</script>")
    assert r.status_code == 200, r.text
    out = r.json()
    html = out["content_html"]
    for bad in ("script", "onclick", "onmouseover", "onerror", "iframe", "javascript:",
                "<style", "<form", "<svg", "position", "t.example", "<!--", "text\"", "/n/1"):
        assert bad not in html, bad
    assert "<h2>Title</h2>" in html
    assert 'href="https://ok.example.com/p"' in html and "noopener noreferrer" in html
    assert "text-align:center" in html
    assert out["title"] == "Safety"
    # what's stored is the sanitized text (that's what workers are served)
    row = await db.scalar(select(LearningTranslation))
    assert "script" not in row.content_html and row.title == "Safety"


async def test_sanitizer_keeps_what_the_wiki_renders():
    """Everything `generateHTML` + `finish_fragment` emit survives untouched,
    notably the figure/img shape the image-source rewrite matches."""
    wiki = (
        '<h1 data-text-align="center" style="text-align: center">T</h1>'
        '<p>a <strong>b</strong> <em>c</em> <s>d</s> <u>e</u> <mark>f</mark> <sub>g</sub> '
        '<sup>h</sup> <code>i</code> <a href="https://x.example.com" target="_blank" '
        'rel="noopener noreferrer nofollow">j</a></p>'
        '<pre><code class="language-js">k</code></pre><blockquote><p>q</p></blockquote>'
        '<ul><li><p>l</p></li></ul><ol><li><p>m</p></li></ol><hr>'
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label>'
        '<input type="checkbox" checked="checked"><span></span></label><div><p>n</p></div>'
        '</li></ul>'
        '<table style="min-width: 50px"><colgroup><col style="min-width: 25px"></colgroup>'
        '<tbody><tr><th colspan="1" rowspan="1"><p>o</p></th><td colspan="1" rowspan="1" '
        'colwidth="100"><p>p</p></td></tr></tbody></table>'
        '<div data-callout="warning"><p>r</p></div>'
        '<details open="" data-details=""><summary>s</summary>'
        '<div data-details-content=""><p>t</p></div></details>'
        '<span data-mention="" class="wiki-mention">@Wanda</span>'
        '<figure data-wiki-image="123e4567-e89b-12d3-a456-426614174000" data-width="300">'
        '<img alt="u" style="width: 300px; max-width: 100%"><figcaption>v</figcaption></figure>')
    out = translate.sanitize(wiki)
    for needle in (
            '<h1 data-text-align="center" style="text-align:center">T</h1>',
            '<mark>f</mark>', '<sub>g</sub>', '<sup>h</sup>', '<u>e</u>', '<s>d</s>',
            '<pre><code class="language-js">k</code></pre>', '<blockquote>', '<hr>',
            ('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label>'
             '<input type="checkbox" checked="checked"><span></span></label>'),
            '<table style="min-width:50px"><colgroup><col style="min-width:25px"></colgroup>',
            '<th colspan="1" rowspan="1">', 'colwidth="100"',
            '<div data-callout="warning">',
            '<details open="" data-details=""><summary>s</summary><div data-details-content="">',
            '<span data-mention="" class="wiki-mention">@Wanda</span>',
            ('<figure data-wiki-image="123e4567-e89b-12d3-a456-426614174000" data-width="300">'
             '<img alt="u" style="width:300px;max-width:100%"><figcaption>v</figcaption>')):
        assert needle in out, needle
    # the read-time image rewrite still finds the stored shape
    from serversherpa.learning.render import _STORED_IMAGE
    assert _STORED_IMAGE.search(out)
    # values outside the schema's own are dropped, not kept
    odd = translate.sanitize(
        '<div data-callout="x" class="y" id="z"><input type="image" src="a"><span class="b '
        'wiki-mention">m</span><figure data-wiki-image="not-an-id"></figure>'
        '<a href="mailto:a@example.com">m</a><a href="tel:+1555">t</a></div>')
    assert 'data-callout' not in odd and 'class="y"' not in odd and 'id=' not in odd
    assert 'type=' not in odd and 'class="wiki-mention"' in odd and 'not-an-id' not in odd
    assert 'href="mailto:a@example.com"' in odd and 'href="tel:+1555"' in odd


# ── quiz questions ───────────────────────────────────────────────────

GOOD = {"prompt": "Can you post photos?",
        "choices": [{"id": "a", "text": "Yes"}, {"id": "b", "text": "No"}],
        "correct_choice_ids": ["b"]}


async def test_question_validation(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "NDA")
    url = f"/learning/documents/{doc.id}/questions"
    bad = {
        "too_few_choices": {**GOOD, "choices": [], "correct_choice_ids": []},
        "no_correct_choice": {**GOOD, "correct_choice_ids": []},
        "unknown_correct_choice": {**GOOD, "correct_choice_ids": ["z"]},
        "duplicate_choice": {**GOOD, "choices": [{"id": "a", "text": "Yes"},
                                                 {"id": "a", "text": "No"}],
                             "correct_choice_ids": ["a"]},
        "duplicate_correct": {**GOOD, "correct_choice_ids": ["b", "b"]},
        "unknown_language": {**GOOD, "translations": {"fr": {"prompt": "Photos ?"}}},
        "unknown_translated_choice": {**GOOD, "translations": {
            "ja": {"choices": {"zz": "x"}}}},
    }
    for code, body in bad.items():
        r = await client.post(url, headers=hdrs, json=body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == code, (code, r.text)
    # empty prompt/choice text is a schema error
    assert (await client.post(url, headers=hdrs, json={**GOOD, "prompt": " "})
            ).status_code == 422
    assert (await client.post(url, headers=hdrs, json={**GOOD, "choices": [
        {"text": ""}, {"text": "No"}]})).status_code == 422
    assert list(await db.scalars(select(LearningQuizQuestion))) == []

    # a good one; answers are shown to managers
    r = await client.post(url, headers=hdrs, json={
        **GOOD, "translations": {"ja": {"prompt": "写真?", "choices": {"a": "はい", "b": "いいえ"}}}})
    assert r.status_code == 201, r.text
    q = r.json()
    assert q["correct_choice_ids"] == ["b"] and q["position"] == 1.0
    assert q["translations"]["ja"]["choices"] == {"a": "はい", "b": "いいえ"}
    assert await db.scalar(select(AuditLog.id).where(
        AuditLog.action == "learning_quiz_question_create")) is not None

    # patch is checked as a merged whole
    qurl = f"/learning/questions/{q['id']}"
    r = await client.patch(qurl, headers=hdrs, json={"correct_choice_ids": ["nope"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_correct_choice"
    r = await client.patch(qurl, headers=hdrs, json={"choices": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_few_choices"
    # a lone choice is only refused while the correct id points elsewhere
    r = await client.patch(qurl, headers=hdrs, json={"choices": [{"id": "a", "text": "Yes"}]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_correct_choice"
    r = await client.patch(qurl, headers=hdrs, json={"prompt": None})
    assert r.status_code == 422
    # dropping a choice drops its translated text with it
    r = await client.patch(qurl, headers=hdrs, json={
        "choices": [{"id": "b", "text": "No"}, {"id": "c", "text": "Maybe"}],
        "correct_choice_ids": ["b", "c"]})
    assert r.status_code == 200, r.text
    assert r.json()["translations"]["ja"]["choices"] == {"b": "いいえ"}
    assert r.json()["correct_choice_ids"] == ["b", "c"]
    # choices sent without ids get one each
    r = await client.post(url, headers=hdrs, json={
        "prompt": "PPE?", "choices": [{"text": "Boots"}, {"text": "Phone"}],
        "correct_choice_ids": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_correct_choice"
    r = await client.patch(qurl, headers=hdrs, json={
        "choices": [{"id": "b", "text": "No"}, {"text": "Maybe"}],
        "correct_choice_ids": ["b"]})
    assert r.status_code == 200, r.text
    made = [c["id"] for c in r.json()["choices"]]
    assert made[0] == "b" and len(made[1]) == 8 and made[1] != "c"


async def test_single_answer_question(client, db, seeded_user):
    """An acknowledgment: one choice, and it is the correct one."""
    hdrs = await _manager(db, client)
    doc = await _doc(db, "NDA")
    url = f"/learning/documents/{doc.id}/questions"
    ack = {"prompt": "I have read this.", "choices": [{"id": "y", "text": "Yes"}],
           "correct_choice_ids": ["y"]}
    r = await client.post(url, headers=hdrs, json=ack)
    assert r.status_code == 201, r.text
    assert r.json()["correct_choice_ids"] == ["y"] and len(r.json()["choices"]) == 1
    qurl = f"/learning/questions/{r.json()['id']}"
    r = await client.patch(qurl, headers=hdrs, json={"prompt": "I have read and understand this."})
    assert r.status_code == 200, r.text
    # patching down to one choice works once the correct id is that choice
    r = await client.patch(qurl, headers=hdrs, json={
        "choices": [{"id": "y", "text": "Yes, I do"}], "correct_choice_ids": ["y"]})
    assert r.status_code == 200, r.text
    assert len(r.json()["choices"]) == 1
    # no choices at all is still refused
    r = await client.post(url, headers=hdrs, json={**ack, "choices": [], "correct_choice_ids": []})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_few_choices"


async def test_question_list_reorder_delete(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "NDA")
    other = await _doc(db, "Other")
    url = f"/learning/documents/{doc.id}/questions"
    ids = []
    for n in range(3):
        r = await client.post(url, headers=hdrs, json={**GOOD, "prompt": f"Q{n}"})
        assert r.status_code == 201
        ids.append(r.json()["id"])
    foreign = (await client.post(f"/learning/documents/{other.id}/questions", headers=hdrs,
                                 json=GOOD)).json()["id"]
    assert [q["prompt"] for q in (await client.get(url, headers=hdrs)).json()] == [
        "Q0", "Q1", "Q2"]

    r = await client.post(f"{url}/reorder", headers=hdrs, json={"ids": [ids[2], ids[0]]})
    assert r.status_code == 200, r.text
    assert [q["prompt"] for q in r.json()] == ["Q2", "Q0", "Q1"]
    for body in ({"ids": [ids[0], ids[0]]}, {"ids": [foreign]},
                 {"ids": [str(uuid.uuid4())]}):
        r = await client.post(f"{url}/reorder", headers=hdrs, json=body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_order"

    # delete archives (past attempts keep their question), then it's gone from the list
    assert (await client.delete(f"/learning/questions/{ids[0]}", headers=hdrs)
            ).status_code == 204
    assert (await client.delete(f"/learning/questions/{ids[0]}", headers=hdrs)
            ).status_code == 404
    assert [q["prompt"] for q in (await client.get(url, headers=hdrs)).json()] == ["Q2", "Q1"]
    row = await db.scalar(select(LearningQuizQuestion).where(
        LearningQuizQuestion.id == uuid.UUID(ids[0])))
    assert row.archived_at is not None
    assert (await client.get("/learning/documents/" + str(uuid.uuid4()) + "/questions",
                             headers=hdrs)).status_code == 404


# ── unlocking a quiz ─────────────────────────────────────────────────


async def test_unlock_quiz_forgives_attempts(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _plain_doc(db, "Acme NDA", quiz_enabled=True, quiz_pass_percent=100,
                           quiz_fail_action="lock", quiz_max_attempts=2)
    q = await _question(db, doc, "Share photos?", [("a", "Yes"), ("b", "No")], ["b"])
    wanda, whdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=10)
    quiz_url = f"/learn/assignments/{row.id}/quiz"
    wrong = {"answers": {str(q.id): ["a"]}}
    unlock = f"/learning/assignments/{row.id}/unlock-quiz"

    # not locked yet: nothing to unlock
    r = await client.post(unlock, headers=hdrs)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_locked"

    for left in (1, 0):
        r = await client.post(quiz_url, headers=whdrs, json=wrong)
        assert r.json()["attempts_left"] == left
    assert r.json()["locked"] is True
    assert (await client.post(quiz_url, headers=whdrs, json=wrong)).status_code == 409

    r = await client.post(unlock, headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json()["assignment_id"] == str(row.id)
    fresh = await _fresh(db, row)
    assert fresh.quiz_locked_at is None and fresh.quiz_attempts_forgiven == 2
    assert r.json()["attempts_forgiven"] == 2
    audit_row = await db.scalar(select(AuditLog).where(AuditLog.action == "learning_quiz_unlock"))
    assert audit_row.entity_id == str(row.id) and audit_row.changes["attempts_forgiven"] == 2
    assert audit_row.actor_person_id is not None

    # a fresh set of attempts: one failure doesn't re-lock, the second does
    r = await client.post(quiz_url, headers=whdrs, json=wrong)
    assert r.status_code == 200 and r.json() == {
        "score_percent": 0, "passed": False, "attempts_left": 1, "locked": False}
    r = await client.post(quiz_url, headers=whdrs, json=wrong)
    assert r.json() == {"score_percent": 0, "passed": False, "attempts_left": 0, "locked": True}
    # earlier attempts stay on record
    assert len(list(await db.scalars(select(LearningQuizAttempt)))) == 4

    # a second unlock forgives cumulatively (all 4 so far), not just the last lock's
    r = await client.post(unlock, headers=hdrs)
    assert r.status_code == 200 and r.json()["attempts_forgiven"] == 4
    r = await client.post(quiz_url, headers=whdrs, json=wrong)
    assert r.json() == {"score_percent": 0, "passed": False, "attempts_left": 1, "locked": False}
    # a passing attempt after an unlock still passes and never locks
    right = {"answers": {str(q.id): ["b"]}}
    r = await client.post(quiz_url, headers=whdrs, json=right)
    assert r.json()["passed"] is True and r.json()["locked"] is False

    # and unlocking needs the manager
    assert (await client.post(unlock, headers=whdrs)).status_code in (401, 403)
    assert (await client.post(f"/learning/assignments/{uuid.uuid4()}/unlock-quiz",
                              headers=hdrs)).status_code == 404


# ── plain-text titles ────────────────────────────────────────────────


async def test_titles_are_plain_text(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    cases = {
        # entity-encoded markup must not come back as live markup
        "&lt;img src=x onerror=alert(1)&gt;Safety": "img src=x onerror=alert(1)Safety",
        "<img src=x onerror=alert(1)>Safety": "Safety",
        "<b>Sa</b>fety<script>1</script>": "Safety",
        "A &amp; B &lt; C": "A & B  C".replace("  ", " "),
        "  Plain   title ": "Plain title",
    }
    for given, expected in cases.items():
        r = await _save(client, hdrs, doc, title=given)
        assert r.status_code == 200, (given, r.text)
        assert r.json()["title"] == expected, given
        assert "<" not in r.json()["title"] and ">" not in r.json()["title"]
        row = await db.scalar(select(LearningTranslation.title))
        assert row == expected
    # nothing left once markup is gone
    r = await _save(client, hdrs, doc, title="<script>x</script>&lt;&gt;")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "title_required"


async def test_claude_title_is_plain_text(client, db, seeded_user, claude):
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    claude.answer = {"title": "&lt;img src=x onerror=alert(1)&gt;安全",
                     "content_html": "<p>x</p>"}
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 200 and r.json()["title"] == "img src=x onerror=alert(1)安全"


# ── style values and obfuscated links ────────────────────────────────


async def test_style_values_and_obfuscated_hrefs(client, db, seeded_user):
    sanitize = translate.sanitize
    for bad in ("width:url(https://evil.example/x)", "width: expression(alert(1))",
                "width:calc(100% - 1px)", "width:100px url(x)", "width: 1e3px",
                "text-align: center url(x)", "text-align:inherit", "max-width:100",
                "width:-5px", "background:url(x)", "position:fixed"):
        out = sanitize(f'<p style="{bad}">x</p><img style="{bad}" alt="a">')
        assert "style" not in out and "url(" not in out and "expression" not in out, bad
    # the valid ones survive, mixed with dropped ones
    out = sanitize('<img alt="a" style="width: 300px; background: red; max-width:100%">')
    assert 'style="width:300px;max-width:100%"' in out
    assert 'style="text-align:center"' in sanitize('<p style="TEXT-ALIGN: Center">x</p>')
    assert 'style="min-width:50.5px"' in sanitize('<table style="min-width:50.5px"></table>')

    for href in ("javascript:alert(1)", "  javascript:alert(1)", "JaVaScRiPt:alert(1)",
                 "&#106;avascript:alert(1)", "&#x6A;avascript:alert(1)",
                 "jav&#x09;ascript:alert(1)", "jav&#x0A;ascript:alert(1)",
                 "java\tscript:alert(1)", "java\nscript:alert(1)", "&#0000106avascript:alert(1)",
                 "data:text/html,<script>alert(1)</script>", "vbscript:x", "//evil.example",
                 "/n/123", "x.html", "ht\ttps://x.example"):
        out = sanitize(f'<a href="{href}">x</a>')
        assert "href" not in out, (href, out)
        assert "javascript" not in out.lower().replace("&", "")
    for href in ("https://ok.example.com/a?b=1", "mailto:a@example.com", "tel:+15551234"):
        assert f'href="{href}"' in sanitize(f'<a href="{href}">x</a>')


def test_link_attributes_stay_closed_if_the_allowlist_grows(monkeypatch):
    """A link keeps href, target and the rel nh3 adds; anything else added to
    ATTRIBUTES["a"] later is still dropped by the filter."""
    widened = {**translate.ATTRIBUTES, "a": {"href", "target", "onclick", "title", "style"}}
    monkeypatch.setattr(translate, "ATTRIBUTES", widened)
    out = translate.sanitize('<a href="https://ok.example" target="_blank" onclick="x()" '
                             'title="t" style="color:red">x</a>')
    assert 'href="https://ok.example"' in out and 'target="_blank"' in out
    assert 'rel="noopener noreferrer"' in out
    assert "onclick" not in out and "title" not in out and "style" not in out


# ── the draft path and the audit diff ────────────────────────────────


async def test_draft_releases_the_transaction_before_claude(client, db, seeded_user,
                                                            monkeypatch):
    from sqlalchemy import text
    hdrs = await _manager(db, client)
    doc = await _published_doc(db)
    seen = {}

    async def fake_draft(html, title, lang):
        seen["idle_in_transaction"] = await db.scalar(text(
            "select count(*) from pg_stat_activity where datname = current_database() "
            "and state like 'idle in transaction%' and pid <> pg_backend_pid()"))
        return "安全", "<p>x</p>"

    monkeypatch.setattr(translate, "draft", fake_draft)
    r = await client.post(_url(doc, tail="/draft"), headers=hdrs)
    assert r.status_code == 200, r.text
    assert seen["idle_in_transaction"] == 0


async def test_question_audit_diff_ignores_untouched_fields(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "NDA")
    q = await _question(db, doc, "Share photos?", [("a", "Yes"), ("b", "No")], ["b"])
    q.translations = None                  # a legacy null, as an untouched field
    await db.commit()
    r = await client.patch(f"/learning/questions/{q.id}", headers=hdrs,
                           json={"prompt": "Post photos?"})
    assert r.status_code == 200, r.text
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "learning_quiz_question_update"))
    assert row.changes["fields"] == ["prompt"]
