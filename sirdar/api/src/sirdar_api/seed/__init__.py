"""Seed Data: browse a snapshot in a scratch database and cut a smaller
seed snapshot from it with a recipe (see the Seed Data recipes design)."""


class SeedError(Exception):
    """`code` is the API error code; `extra` holds non-secret details."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra
