"""A stand-in for the Switchyard REST API calls deploy/switchyard.py makes:
an httpx.MockTransport over in-memory hosts, a staged/applied split and a
certificate list. Shaped after Switchyard's own handlers
(internal/server/hosts.go, ops.go, apikeys.go, store/hosts.go):

- every call needs `Authorization: Bearer <key>`; a wrong key is 401
  invalid_api_key, an operation the key lacks is 403 missing_permission;
- POST/PUT refuse unknown fields (400 bad_request) and a domain another
  host serves (409 conflict); PUT replaces the whole host;
- host changes are staged: `applied` holds the hosts Caddy runs, copied on
  POST /api/config/apply; `reject_apply` answers 422 caddy_rejected;
- GET /api/certificates lists one row per domain of every enabled host
  (staged, as Switchyard does), "valid" once `issue(domain)` (or
  `auto_issue`: on apply) made a certificate, else "pending"."""

import copy
import itertools
import json

import httpx

from sirdar_api.deploy import switchyard

from .integration_helpers import SY_KEY

HOST_KEYS = {
    "id", "type", "domains", "enabled", "upstreams", "load_balancing", "tls_mode",
    "force_https", "hsts", "compression", "redirect_to", "redirect_code", "preserve_path",
    "notes", "folder_id", "policy_ids", "dns_provider_id", "request_headers",
    "response_headers", "health_check_path", "health_check_interval", "advanced_json",
    "trap_exceptions", "rate_limit_events", "rate_limit_window", "created_at", "updated_at",
    "certs",
}
OPS = {
    ("GET", "/api/status"): "status.get",
    ("GET", "/api/hosts"): "hosts.list",
    ("POST", "/api/hosts"): "hosts.create",
    ("GET", "/api/hosts/{id}"): "hosts.get",
    ("PUT", "/api/hosts/{id}"): "hosts.update",
    ("DELETE", "/api/hosts/{id}"): "hosts.delete",
    ("POST", "/api/config/apply"): "config.apply",
    ("GET", "/api/certificates"): "certs.list",
    ("POST", "/api/certificates/retry"): "certs.retry",
}


def blank_host() -> dict:
    return {"id": 0, "type": "proxy", "domains": [], "enabled": True, "upstreams": [],
            "load_balancing": "round_robin", "tls_mode": "auto", "force_https": False,
            "hsts": False, "compression": False, "redirect_to": "", "redirect_code": 301,
            "preserve_path": False, "notes": "", "folder_id": None, "policy_ids": [],
            "dns_provider_id": None, "request_headers": [], "response_headers": [],
            "health_check_path": "", "health_check_interval": 30, "advanced_json": "",
            "trap_exceptions": [], "rate_limit_events": 0, "rate_limit_window": 60,
            "created_at": "2026-11-07T00:00:00Z", "updated_at": "2026-11-07T00:00:00Z"}


class FakeSwitchyard:
    def __init__(self, *, key: str = SY_KEY, permissions: set[str] | None = None):
        self.key = key
        self.permissions = set(OPS.values()) if permissions is None else permissions
        self.hosts: dict[int, dict] = {}
        self.applied: dict[int, dict] = {}
        self.applies: list[str] = []             # the note of every apply
        self.issued: set[str] = set()            # domains with a certificate
        self.cert_errors: dict[str, str] = {}    # domain -> Caddy's last error
        self.auto_issue = True                   # an apply issues every name's certificate
        self.issue_on_retry = False              # a retry issues them instead
        self.retries = 0
        self.reject_apply: str | None = None     # the next apply answers 422 with this
        self.apply_errors = 0                    # the next N applies answer a plain 502
        self.down = False
        self.caddy_reachable = True
        self.host_errors = 0                     # the next N host writes answer a plain 500
        self.put_errors: set[int] = set()        # PUTs to these host ids answer a 500
        self.cert_list_errors = 0                # the next N certificate lists answer 500
        self.requests: list[httpx.Request] = []
        self._ids = itertools.count(1)

    # ---- set-up -------------------------------------------------------------------

    def add_host(self, domain: str, upstream_host: str = "10.0.0.9", port: int = 8000,
                 **over) -> int:
        hid = next(self._ids)
        self.hosts[hid] = {**blank_host(), "id": hid, "domains": [domain],
                           "upstreams": [{"scheme": "http", "host": upstream_host, "port": port,
                                          "skip_tls_verify": False}], **over}
        self.applied[hid] = copy.deepcopy(self.hosts[hid])
        return hid

    def issue(self, *domains: str) -> None:
        self.issued.update(domains)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def calls(self, method: str, path: str) -> int:
        return sum(1 for r in self.requests if (r.method, r.url.path) == (method, path))

    # ---- the API --------------------------------------------------------------------

    @staticmethod
    def _error(status: int, code: str, message: str, fields: dict | None = None):
        body = {"error": code, "message": message}
        if fields is not None:
            body["fields"] = fields
        return httpx.Response(status, json=body)

    def _op(self, method: str, path: str) -> str | None:
        if path.startswith("/api/hosts/"):
            path = "/api/hosts/{id}"
        return OPS.get((method, path))

    def _check(self, body: dict, hid: int) -> httpx.Response | None:
        extra = sorted(set(body) - HOST_KEYS)
        if extra:
            return self._error(400, "bad_request", f'json: unknown field "{extra[0]}"')
        if not body.get("domains"):
            return self._error(400, "invalid", "Fix the highlighted fields.",
                               {"domains": "add at least one domain"})
        if body.get("type", "proxy") == "proxy" and not body.get("upstreams"):
            return self._error(400, "invalid", "Fix the highlighted fields.",
                               {"upstreams": "add at least one upstream"})
        for other in self.hosts.values():
            if other["id"] != hid and set(other["domains"]) & set(body["domains"]):
                taken = min(set(other["domains"]) & set(body["domains"]))
                return self._error(409, "conflict", f"{taken} is already used by another host")
        return None

    def _save(self, body: dict, hid: int) -> dict:
        host = {**blank_host(), **{k: v for k, v in body.items() if k != "certs"}, "id": hid}
        host["upstreams"] = [{"skip_tls_verify": False, **u} for u in host["upstreams"]]
        if host["type"] != "proxy":
            host["upstreams"] = []
        self.hosts[hid] = host
        return host

    def _cert_rows(self) -> list[dict]:
        rows = []
        for h in self.hosts.values():
            if not h["enabled"] or h["tls_mode"] == "off":
                continue
            for d in h["domains"]:
                row = {"domain": d, "host_id": h["id"], "tls_mode": h["tls_mode"],
                       "state": "valid" if d in self.issued else "pending"}
                if d in self.issued:
                    row.update(issuer="R11", not_after="2027-02-05T00:00:00Z")
                if d in self.cert_errors and d not in self.issued:
                    row["last_error"] = {"message": self.cert_errors[d],
                                         "at": "2026-11-07T00:00:00Z"}
                rows.append(row)
        return sorted(rows, key=lambda r: r["domain"])

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        method, path = request.method, request.url.path
        op = self._op(method, path)
        if op is None:
            return self._error(404, "not_found", "Not found.")
        if request.headers.get("authorization") != f"Bearer {self.key}":
            return self._error(401, "invalid_api_key",
                               "That API key isn't valid, or it has been revoked or has expired.")
        if op not in self.permissions:
            return self._error(403, "missing_permission",
                               f"This API key doesn't have permission for {op}. An admin can add "
                               "it on the API keys page.")
        if op == "status.get":
            caddy = ({"reachable": True, "socket": "/run/caddy/admin.sock"}
                     if self.caddy_reachable else {"reachable": False, "error": "dial unix: nope"})
            return httpx.Response(200, json={"version": "1.4.0", "caddy": caddy})
        if op == "hosts.list":
            return httpx.Response(200, json=[{**h, "certs": []} for h in self.hosts.values()])
        if op == "certs.list":
            if self.cert_list_errors:
                self.cert_list_errors -= 1
                return self._error(500, "internal", "Something went wrong.")
            return httpx.Response(200, json=self._cert_rows())
        if op == "certs.retry":
            self.retries += 1
            if self.issue_on_retry:
                self.issued.update(d for h in self.applied.values() for d in h["domains"])
            return httpx.Response(204)
        if op == "config.apply":
            note = json.loads(request.content or b"{}").get("note", "")
            if self.apply_errors:
                self.apply_errors -= 1
                return self._error(502, "caddy_unreachable", "dial unix: no such file")
            if self.reject_apply is not None:
                message, self.reject_apply = self.reject_apply, None
                return self._error(422, "caddy_rejected", message)
            self.applies.append(note)
            self.applied = copy.deepcopy(self.hosts)
            if self.auto_issue:
                self.issued.update(d for h in self.applied.values() for d in h["domains"])
            return httpx.Response(200, json={"n": len(self.applies), "note": note,
                                             "result": "ok"})
        if op == "hosts.create":
            if self.host_errors:
                self.host_errors -= 1
                return self._error(500, "internal", "Something went wrong.")
            body = json.loads(request.content)
            problem = self._check(body, 0)
            if problem is not None:
                return problem
            return httpx.Response(201, json=self._save(body, next(self._ids)))
        hid = int(path.rsplit("/", 1)[1])
        if hid not in self.hosts:
            return self._error(404, "not_found", "Not found.")
        if op == "hosts.get":
            return httpx.Response(200, json=self.hosts[hid])
        if op == "hosts.delete":
            del self.hosts[hid]
            return httpx.Response(204)
        # hosts.update
        if self.host_errors or hid in self.put_errors:
            self.host_errors = max(0, self.host_errors - 1)
            return self._error(500, "internal", "Something went wrong.")
        body = json.loads(request.content)
        problem = self._check(body, hid)
        if problem is not None:
            return problem
        return httpx.Response(200, json=self._save(body, hid))


assert set(OPS.values()) == set(switchyard.OPERATIONS)
