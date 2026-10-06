"""Stands in for the dashboard's live certificate check: each hostname
answers with the date a test set in `dates`, or an error string; any other
hostname "Couldn't connect". Records every check."""

from datetime import datetime

from sirdar_api.dashboard.certcheck import NO_CONNECT, HostCert


class FakeCerts:
    def __init__(self):
        self.dates: dict[str, datetime | str] = {}
        self.calls: list[str] = []

    async def __call__(self, hostname: str, **kw) -> HostCert:
        self.calls.append(hostname)
        value = self.dates.get(hostname, NO_CONNECT)
        if isinstance(value, datetime):
            return HostCert(hostname, value, None)
        return HostCert(hostname, None, value)
