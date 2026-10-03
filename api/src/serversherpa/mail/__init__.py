"""Outbound email: templates (render.py), the transactional outbox
(outbox.py), SMTP transport (transport.py) and the worker-side delivery
loop (delivery.py). Named `mail`, not `email`, so it never shadows the
stdlib `email` package."""

from serversherpa.mail.outbox import email_enabled, enqueue

__all__ = ["email_enabled", "enqueue"]
