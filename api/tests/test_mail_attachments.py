"""Inline attachments in the mail outbox: enqueue stores them, delivery hands
them to the transport, and build_message nests them in a multipart/related
part beside the HTML so `cid:` images render. Never touches a real server."""

import base64

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import EmailOutbox
from serversherpa.mail import enqueue
from serversherpa.mail.delivery import deliver_once
from serversherpa.mail.transport import build_message

PNG = b"\x89PNG\r\n\x1a\nfake-image-bytes"
ATTACHMENT = {"cid": "qr", "filename": "qr.png", "content_type": "image/png",
              "b64": base64.b64encode(PNG).decode()}


def test_attachments_build_inline_related_part():
    msg = build_message(sender="noreply@x.test", to="a@x.test", subject="Hi",
                        html='<p>Scan <img src="cid:qr"></p>', text="Scan\n",
                        attachments=[ATTACHMENT])
    assert msg.get_content_type() == "multipart/alternative"
    plain, related = list(msg.iter_parts())
    assert plain.get_content_type() == "text/plain"
    assert related.get_content_type() == "multipart/related"
    html, image = list(related.iter_parts())
    assert html.get_content_type() == "text/html"
    assert 'src="cid:qr"' in html.get_content()
    assert image.get_content_type() == "image/png"
    assert image["Content-ID"] == "<qr>"
    assert image.get_content_disposition() == "inline"
    assert image.get_filename() == "qr.png"
    assert image.get_content() == PNG


def test_no_attachments_keeps_plain_alternative():
    msg = build_message(sender="noreply@x.test", to="a@x.test", subject="Hi",
                        html="<p>Hello</p>", text="Hello\n", attachments=None)
    assert [p.get_content_type() for p in msg.iter_parts()] == ["text/plain", "text/html"]


async def test_enqueue_stores_and_delivery_passes_attachments(db, email_on):
    row = await enqueue(db, "password_changed", "alice@test.example.com",
                        attachments=[ATTACHMENT], name="Alice", login_url="https://p/login")
    await db.commit()
    stored = await db.get(EmailOutbox, row.id)
    assert stored.attachments == [ATTACHMENT]

    calls = []

    async def send(**kw):
        calls.append(kw)

    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert calls[0]["attachments"] == [ATTACHMENT]


def test_rendered_subject_is_one_line():
    from serversherpa.mail.render import render

    out = render("learning_invite", subject_override=None, intro_override=None,
                 initiative_name="Acme\r\nBcc: x@y.test", name="K", start_on=None,
                 due_on=None, expires_on=None, documents=1, code="ABC DEF",
                 link="https://l/start#t=x", learn_origin="https://l", learn_host="l")
    assert out.subject == "Your training for Acme Bcc: x@y.test"
