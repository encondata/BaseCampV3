"""MacroPoint API client: a placeholder until API access is set up.

When it exists, `fetch_updates` will return the same `ParsedMessage`
objects the email parser produces, so `apply.apply_messages` takes API data
unchanged. Nothing calls this yet: no route, setting or UI.
"""

from datetime import datetime

from serversherpa.trucks.macropoint.parse import ParsedMessage


class MacroPointClient:
    def fetch_updates(self, order_token: str,
                      since: datetime | None = None) -> list[ParsedMessage]:
        raise NotImplementedError("MacroPoint API access is not set up yet")
