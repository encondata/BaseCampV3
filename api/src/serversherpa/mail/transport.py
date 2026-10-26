"""SMTP transport: stdlib smtplib in a worker thread. STARTTLS when
SS_SMTP_STARTTLS is on; AUTH only when SS_SMTP_USERNAME is set (mailpit
needs neither). A fresh SSL context per connection — never a shared one
across threads (see the 2026-09-29 storage TLS segfault)."""

import asyncio
import base64
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

from serversherpa.config import get_settings

TIMEOUT_SECONDS = 20


def build_message(*, sender: str, to: str, subject: str, html: str, text: str,
                  attachments: list[dict] | None = None) -> EmailMessage:
    """text + HTML alternatives. Each attachment ({cid, filename,
    content_type, b64}) becomes an inline part of a multipart/related HTML
    part, so the HTML can show it with `<img src="cid:<cid>">`."""
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    domain = parseaddr(sender)[1].rpartition("@")[2] or None
    msg["Message-ID"] = make_msgid(domain=domain)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    if attachments:
        html_part = msg.get_payload()[1]
        for item in attachments:
            maintype, _, subtype = item["content_type"].partition("/")
            html_part.add_related(base64.b64decode(item["b64"]), maintype=maintype,
                                  subtype=subtype, cid=f"<{item['cid']}>",
                                  filename=item["filename"], disposition="inline")
    return msg


def _send_sync(msg: EmailMessage) -> None:
    s = get_settings()
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=TIMEOUT_SECONDS) as smtp:
        if s.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password.get_secret_value())
        smtp.send_message(msg)


async def send_email(*, to: str, subject: str, html: str, text: str,
                     attachments: list[dict] | None = None) -> None:
    msg = build_message(sender=get_settings().smtp_from, to=to, subject=subject,
                        html=html, text=text, attachments=attachments)
    await asyncio.to_thread(_send_sync, msg)
