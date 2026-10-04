"""A stand-in for the Cloudflare API v4 calls deploy/cloudflare.py makes:
an httpx.MockTransport over one in-memory zone."""

import itertools
import json

import httpx

from .integration_helpers import CF_TOKEN

ZONE_ID = "zone-0001"
API = "/client/v4"
RECORDS = f"{API}/zones/{ZONE_ID}/dns_records"


class FakeCloudflare:
    def __init__(self, *, zone: str = "serversherpa.com", token: str = CF_TOKEN):
        self.zone = zone
        self.token = token
        self.records: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.fail_writes: int | None = None     # answer every write with this status
        self.down = False
        self._ids = itertools.count(1)

    def add(self, type_: str, name: str, content: str, *, proxied: bool = False,
            comment: str | None = None) -> str:
        rid = f"rec-{next(self._ids):04d}"
        self.records[rid] = {"id": rid, "type": type_, "name": name, "content": content,
                             "proxied": proxied, "ttl": 1, "comment": comment}
        return rid

    def writes(self) -> list[tuple[str, str]]:
        return [(r.method, r.url.path.removeprefix(RECORDS).lstrip("/"))
                for r in self.requests if r.method != "GET"]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    @staticmethod
    def _ok(result, **extra) -> httpx.Response:
        return httpx.Response(200, json={"success": True, "errors": [], "messages": [],
                                         "result": result, **extra})

    @staticmethod
    def _error(status: int, code: int, message: str) -> httpx.Response:
        return httpx.Response(status, json={"success": False, "messages": [], "result": None,
                                            "errors": [{"code": code, "message": message}]})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        if request.headers.get("authorization") != f"Bearer {self.token}":
            return self._error(403, 9109, "Invalid access token")
        path, method = request.url.path, request.method
        if path == f"{API}/zones" and method == "GET":
            name = request.url.params.get("name")
            return self._ok([{"id": ZONE_ID, "name": self.zone}] if name == self.zone else [])
        if path == RECORDS and method == "GET":
            per_page = int(request.url.params.get("per_page", "100"))
            page = int(request.url.params.get("page", "1"))
            rows = sorted(self.records.values(), key=lambda r: r["id"])
            chunk = rows[(page - 1) * per_page:page * per_page]
            return self._ok(chunk, result_info={
                "page": page, "per_page": per_page, "count": len(chunk),
                "total_count": len(rows), "total_pages": max(1, -(-len(rows) // per_page))})
        if self.fail_writes:
            return self._error(self.fail_writes, 81057, "Record already exists.")
        if path == RECORDS and method == "POST":
            body = json.loads(request.content)
            rid = self.add(body["type"], body["name"], body["content"],
                           proxied=body.get("proxied", False), comment=body.get("comment"))
            return self._ok(self.records[rid])
        if path.startswith(RECORDS + "/"):
            rid = path.removeprefix(RECORDS + "/")
            if rid not in self.records:
                return self._error(404, 81044, "Record does not exist.")
            if method == "PATCH":
                self.records[rid].update(json.loads(request.content))
                return self._ok(self.records[rid])
            if method == "DELETE":
                del self.records[rid]
                return self._ok({"id": rid})
        return self._error(404, 7003, "No route for that URI")
