"""A stand-in for the DigitalOcean API v2 calls deploy/do_api.py makes: an
httpx.MockTransport over in-memory accounts, VPCs, droplets, managed
databases (with firewall rules and a CA), Spaces keys, certificates, load
balancers and cloud firewalls. Tokens carry a team and, for a renewal
token, a scope set. Droplets, databases and load balancers become ready
after a few GETs, like the real thing.

Stricter than a mock: a droplet without `vpc_uuid` lands in the region's
default VPC (kept in `default_vpcs`, not `vpcs`); `user_data` over 64 KiB is
refused; droplet actions can stay `in-progress` for `action_polls` GETs, and
`power_on` is refused while a resize is pending; the database firewall
refuses droplets that don't exist; a load balancer's PUT replaces the whole
body; a load balancer refuses an unknown `certificate_id` and `droplet_ids`
together with `tag`."""

import base64
import itertools
import json
import uuid
from datetime import UTC, datetime

import httpx
from cryptography import x509

DO_TOKEN = "dop_v1_" + "1a2b3c4d" * 8
DEV_TOKEN = "dop_v1_" + "5e6f7a8b" * 8
RENEW_TOKEN = "dop_v1_" + "9c0d1e2f" * 8
DEV_RENEW_TOKEN = "dop_v1_" + "3a4b5c6d" * 8
TEAMS = {DO_TOKEN: ("team-prod-0001", "Encon Production"),
         DEV_TOKEN: ("team-dev-0002", "Encon Development"),
         RENEW_TOKEN: ("team-prod-0001", "Encon Production"),
         DEV_RENEW_TOKEN: ("team-dev-0002", "Encon Development")}
# What a custom-scoped renewal token may do: (method, first path segment).
RENEWAL_SCOPES = frozenset({("GET", "certificates"), ("POST", "certificates"),
                            ("DELETE", "certificates"), ("GET", "load_balancers"),
                            ("PUT", "load_balancers")})
DB_ADMIN_PASSWORD = "FAKE_doadmin-S3cr3t-0123456789"
LB_IP = "203.0.113.50"
VPC_RANGE = "10.116.0.0/20"
DEFAULT_VPC_RANGE = "10.108.0.0/20"
USER_DATA_LIMIT = 64 * 1024
CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfakeCA\n-----END CERTIFICATE-----\n"


def _err(status: int, code: str, message: str = "") -> httpx.Response:
    return httpx.Response(status, json={"id": code, "message": message or code})


class FakeDigitalOcean:
    def __init__(self, *, tokens: dict | None = None):
        # token -> None (full access) or a scope set
        self.tokens = tokens if tokens is not None else {
            DO_TOKEN: None, DEV_TOKEN: None, RENEW_TOKEN: RENEWAL_SCOPES,
            DEV_RENEW_TOKEN: RENEWAL_SCOPES}
        self.vpcs: dict[str, dict] = {}
        self.droplets: dict[str, dict] = {}
        self.databases: dict[str, dict] = {}
        self.db_rules: dict[str, list] = {}
        self.keys: dict[str, dict] = {}
        self.certificates: dict[str, dict] = {}
        self.load_balancers: dict[str, dict] = {}
        self.firewalls: dict[str, dict] = {}
        self.default_vpcs: dict[str, dict] = {}   # region slug -> its default VPC
        self.actions: dict[str, dict] = {}        # action id -> action (+ _droplet, _polls)
        self.requests: list[httpx.Request] = []
        self.boot_polls = 1           # GETs before a droplet is active
        self.db_polls = 1             # GETs before a database is online
        self.lb_polls = 1             # GETs before a load balancer is active
        self.firewall_wait = 0        # database firewall PUTs refused before one is accepted
        self.vpc_lingering = 0        # VPC deletes refused after its members went
        self.action_polls = 0         # action GETs before a droplet action completes
        self.public_ip = "127.0.0.1"  # the tests' SSH server plays every droplet
        self.down = False
        self.fail: dict[tuple[str, str], int] = {}   # (method, path) -> status
        self._ids = itertools.count(4001)
        self._private = itertools.count(2)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def writes(self) -> list[tuple[str, str]]:
        return [(r.method, r.url.path.removeprefix("/v2")) for r in self.requests
                if r.method != "GET"]

    # ---- helpers for tests ---------------------------------------------------------

    def add_droplet(self, name: str, tags: list[str], **over) -> dict:
        did = str(next(self._ids))
        self.droplets[did] = {"id": int(did), "name": name, "status": "active", "tags": tags,
                              "region": {"slug": "nyc3"}, "size_slug": "s-2vcpu-4gb",
                              "vpc_uuid": None, "networks": self._networks(), "_polls": 99,
                              "_user_data": "", **over}
        return self.droplets[did]

    def _networks(self) -> dict:
        return {"v4": [{"ip_address": self.public_ip, "type": "public"},
                       {"ip_address": f"10.116.0.{next(self._private)}", "type": "private"}]}

    # ---- the handler ---------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ")
        if token not in self.tokens:
            return _err(401, "unauthorized", "Unable to authenticate you")
        path = request.url.path.removeprefix("/v2")
        parts = [p for p in path.split("/") if p]
        method = request.method
        scopes = self.tokens[token]
        if scopes is not None and (method, parts[0] if parts else "") not in scopes:
            return _err(403, "forbidden", "You are not authorized to perform this operation")
        if (method, path) in self.fail:
            return _err(self.fail[(method, path)], "unprocessable_entity", "refused " + token)
        body = json.loads(request.content) if request.content else {}
        handler = getattr(self, f"_{parts[0]}", None) if parts else None
        if handler is None:
            return _err(404, "not_found")
        return handler(method, parts[1:], body, request, token)

    # ---- account, regions, sizes ---------------------------------------------------------

    def _account(self, method, rest, body, request, token):
        team_uuid, team_name = TEAMS.get(token, ("team-x", "Team X"))
        return httpx.Response(200, json={"account": {
            "uuid": "acct-" + team_uuid, "email": "ops@encondata.com", "status": "active",
            "droplet_limit": 25, "team": {"uuid": team_uuid, "name": team_name}}})

    def _regions(self, method, rest, body, request, token):
        return httpx.Response(200, json={"regions": [
            {"slug": "nyc3", "name": "New York 3", "available": True},
            {"slug": "sfo3", "name": "San Francisco 3", "available": True}],
            "meta": {"total": 2}})

    def _sizes(self, method, rest, body, request, token):
        sizes = [{"slug": "s-1vcpu-2gb", "vcpus": 1, "memory": 2048, "disk": 50},
                 {"slug": "s-2vcpu-4gb", "vcpus": 2, "memory": 4096, "disk": 80},
                 {"slug": "s-4vcpu-8gb", "vcpus": 4, "memory": 8192, "disk": 160}]
        return httpx.Response(200, json={"sizes": [{**s, "available": True} for s in sizes],
                                         "links": {}, "meta": {"total": 3}})

    # ---- VPCs ------------------------------------------------------------------------------

    def _vpc_members(self, vid: str) -> int:
        return (sum(d.get("vpc_uuid") == vid for d in self.droplets.values())
                + sum(d.get("private_network_uuid") == vid for d in self.databases.values())
                + sum(lb.get("vpc_uuid") == vid for lb in self.load_balancers.values()))

    def _find_vpc(self, vid: str) -> dict | None:
        if vid in self.vpcs:
            return self.vpcs[vid]
        return next((v for v in self.default_vpcs.values() if v["id"] == vid), None)

    def _default_vpc(self, region: str) -> str:
        if region not in self.default_vpcs:
            vid = str(uuid.uuid4())
            self.default_vpcs[region] = {"id": vid, "urn": f"do:vpc:{vid}",
                                         "name": f"default-{region}", "region": region,
                                         "description": "", "ip_range": DEFAULT_VPC_RANGE,
                                         "default": True}
        return self.default_vpcs[region]["id"]

    def _vpcs(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            vid = str(uuid.uuid4())
            self.vpcs[vid] = {"id": vid, "urn": f"do:vpc:{vid}", "name": body["name"],
                              "region": body["region"], "description": body.get("description", ""),
                              "ip_range": VPC_RANGE, "default": False}
            return httpx.Response(201, json={"vpc": self.vpcs[vid]})
        vpc = self._find_vpc(rest[0]) if rest else None
        if vpc is None:
            return _err(404, "not_found")
        if method == "GET" and rest[1:] == ["members"]:
            n = self._vpc_members(vpc["id"])
            return httpx.Response(200, json={"members": [{"urn": "x"}] * n,
                                             "links": {}, "meta": {"total": n}})
        if method == "GET":
            return httpx.Response(200, json={"vpc": vpc})
        if method == "DELETE":
            if vpc["default"]:
                return _err(403, "forbidden", "Can not delete a default VPC")
            if self._vpc_members(vpc["id"]) or self.vpc_lingering:
                self.vpc_lingering = max(0, self.vpc_lingering - 1)
                return _err(403, "forbidden", "Can not delete VPC with members")
            del self.vpcs[vpc["id"]]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    # ---- droplets --------------------------------------------------------------------------

    def _droplets(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            user_data = body.get("user_data") or ""
            if len(user_data.encode()) > USER_DATA_LIMIT:
                return _err(422, "unprocessable_entity", "user_data is too long")
            vpc_uuid = body.get("vpc_uuid")
            if vpc_uuid is None:
                vpc_uuid = self._default_vpc(body["region"])
            elif self._find_vpc(vpc_uuid) is None:
                return _err(422, "unprocessable_entity", "vpc not found")
            did = str(next(self._ids))
            self.droplets[did] = {"id": int(did), "name": body["name"], "status": "new",
                                  "tags": list(body.get("tags") or []),
                                  "region": {"slug": body["region"]},
                                  "size_slug": body["size"], "vpc_uuid": vpc_uuid,
                                  "image": body["image"], "networks": {"v4": []}, "_polls": 0,
                                  "_user_data": user_data,
                                  "_ssh_keys": list(body.get("ssh_keys") or [])}
            return httpx.Response(202, json={"droplet": self._public_droplet(did)})
        if method == "GET" and not rest:
            tag = request.url.params.get("tag_name")
            rows = [self._public_droplet(k) for k, d in self.droplets.items()
                    if tag is None or tag in d["tags"]]
            return httpx.Response(200, json={"droplets": rows, "links": {},
                                             "meta": {"total": len(rows)}})
        did = rest[0]
        if did not in self.droplets:
            return _err(404, "not_found")
        if method == "GET" and len(rest) == 1:
            d = self.droplets[did]
            d["_polls"] += 1
            if d["status"] == "new" and d["_polls"] >= self.boot_polls:
                d["status"], d["networks"] = "active", self._networks()
            return httpx.Response(200, json={"droplet": self._public_droplet(did)})
        if method == "DELETE" and len(rest) == 1:
            del self.droplets[did]
            return httpx.Response(204)
        if method == "POST" and rest[1:] == ["actions"]:
            return self._start_action(did, body)
        if method == "GET" and len(rest) == 3 and rest[1] == "actions":
            action = self.actions.get(rest[2])
            if action is None or action["_droplet"] != did:
                return _err(404, "not_found")
            if action["status"] == "in-progress":
                action["_polls"] += 1
                if action["_polls"] >= self.action_polls:
                    self._finish_action(action)
            return httpx.Response(200, json={"action": self._public_action(action)})
        return _err(405, "method_not_allowed")

    def _pending(self, did: str, type_: str) -> bool:
        return any(a["_droplet"] == did and a["type"] == type_ and a["status"] == "in-progress"
                   for a in self.actions.values())

    def _start_action(self, did: str, body: dict) -> httpx.Response:
        if body["type"] == "power_on" and self._pending(did, "resize"):
            return _err(422, "unprocessable_entity", "a resize is in progress")
        aid = str(next(self._ids))
        action = {"id": int(aid), "status": "in-progress", "type": body["type"],
                  "_droplet": did, "_body": body, "_polls": 0}
        self.actions[aid] = action
        if self.action_polls <= 0:
            self._finish_action(action)
        return httpx.Response(201, json={"action": self._public_action(action)})

    def _finish_action(self, action: dict) -> None:
        action["status"] = "completed"
        d = self.droplets.get(action["_droplet"])
        if d is None:
            return
        body = action["_body"]
        if body["type"] == "power_off":
            d["status"] = "off"
        elif body["type"] == "power_on":
            d["status"] = "active"
        elif body["type"] == "resize":
            d["size_slug"] = body["size"]

    @staticmethod
    def _public_action(action: dict) -> dict:
        return {k: v for k, v in action.items() if not k.startswith("_")}

    def _public_droplet(self, did: str) -> dict:
        return {k: v for k, v in self.droplets[did].items() if not k.startswith("_")}

    # ---- managed databases ----------------------------------------------------------------

    def _databases(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            dbid = str(uuid.uuid4())
            name = body["name"]
            conn = {"user": "doadmin", "password": DB_ADMIN_PASSWORD, "port": 25060,
                    "database": "defaultdb", "ssl": True}
            self.databases[dbid] = {
                "id": dbid, "name": name, "engine": body["engine"], "version": body["version"],
                "status": "creating", "region": body["region"], "size": body["size"],
                "num_nodes": body["num_nodes"], "tags": list(body.get("tags") or []),
                "private_network_uuid": body.get("private_network_uuid"),
                "connection": {**conn, "host": f"{name}-do-user-1.db.ondigitalocean.com"},
                "private_connection": {**conn,
                                       "host": f"private-{name}-do-user-1.db.ondigitalocean.com"},
                "_polls": 0}
            self.db_rules[dbid] = []
            return httpx.Response(201, json={"database": self._public_db(dbid)})
        if method == "GET" and rest == ["options"]:
            sizes = ["db-s-1vcpu-1gb", "db-s-1vcpu-2gb", "db-s-2vcpu-4gb", "db-s-4vcpu-8gb"]
            return httpx.Response(200, json={"options": {"pg": {
                "versions": ["14", "15", "16", "17"],
                "layouts": [{"num_nodes": 1, "sizes": sizes}, {"num_nodes": 2, "sizes": sizes}]}}})
        if method == "GET" and not rest:
            tag = request.url.params.get("tag_name")
            rows = [self._public_db(k) for k, d in self.databases.items()
                    if tag is None or tag in d["tags"]]
            return httpx.Response(200, json={"databases": rows})
        dbid = rest[0]
        if dbid not in self.databases:
            return _err(404, "not_found")
        sub = rest[1:]
        d = self.databases[dbid]
        if method == "GET" and not sub:
            d["_polls"] += 1
            if d["status"] == "creating" and d["_polls"] >= self.db_polls:
                d["status"] = "online"
            return httpx.Response(200, json={"database": self._public_db(dbid)})
        if sub == ["firewall"] and method == "PUT":
            if self.firewall_wait:
                self.firewall_wait -= 1
                return _err(422, "unprocessable_entity", "cluster is not ready")
            unknown = [r["value"] for r in body["rules"]
                       if r["type"] == "droplet" and str(r["value"]) not in self.droplets]
            if unknown:
                return _err(422, "unprocessable_entity", "unknown droplet " + unknown[0])
            self.db_rules[dbid] = [{"type": r["type"], "value": r["value"]} for r in body["rules"]]
            return httpx.Response(204)
        if sub == ["firewall"] and method == "GET":
            return httpx.Response(200, json={"rules": self.db_rules[dbid]})
        if sub == ["ca"] and method == "GET":
            return httpx.Response(200, json={"ca": {
                "certificate": base64.b64encode(CA_PEM.encode()).decode()}})
        if sub == ["resize"] and method == "PUT":
            d["size"], d["num_nodes"] = body["size"], body["num_nodes"]
            return httpx.Response(202)
        if method == "DELETE" and not sub:
            del self.databases[dbid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_db(self, dbid: str) -> dict:
        return {k: v for k, v in self.databases[dbid].items() if not k.startswith("_")}

    # ---- Spaces keys -------------------------------------------------------------------------

    def _spaces(self, method, rest, body, request, token):
        if rest[:1] != ["keys"]:
            return _err(404, "not_found")
        if method == "POST" and len(rest) == 1:
            n = next(self._ids)
            key = {"name": body["name"], "access_key": f"DO00KEY{n:06d}",
                   "secret_key": f"spaces-SECRET-{n:06d}-xyz", "grants": body["grants"],
                   "created_at": datetime.now(UTC).isoformat()}
            self.keys[key["access_key"]] = key
            return httpx.Response(201, json={"key": key})
        if method == "GET" and len(rest) == 1:
            return httpx.Response(200, json={"keys": [
                {k: v for k, v in key.items() if k != "secret_key"} for key in self.keys.values()],
                "links": {}, "meta": {"total": len(self.keys)}})
        if method == "DELETE" and len(rest) == 2:
            if self.keys.pop(rest[1], None) is None:
                return _err(404, "not_found")
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    # ---- certificates ------------------------------------------------------------------------

    def _certificates(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            leaf = x509.load_pem_x509_certificate(body["leaf_certificate"].encode())
            names = leaf.extensions.get_extension_for_class(
                x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
            cid = str(uuid.uuid4())
            self.certificates[cid] = {
                "id": cid, "name": body["name"], "type": "custom", "state": "verified",
                "not_after": leaf.not_valid_after_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "dns_names": sorted(names), "sha1_fingerprint": "ab" * 20,
                "_private_key": body["private_key"]}
            return httpx.Response(201, json={"certificate": self._public_cert(cid)})
        if method == "GET" and not rest:
            return httpx.Response(200, json={"certificates": [
                self._public_cert(c) for c in self.certificates], "links": {},
                "meta": {"total": len(self.certificates)}})
        cid = rest[0] if rest else None
        if cid not in self.certificates:
            return _err(404, "not_found")
        if method == "GET":
            return httpx.Response(200, json={"certificate": self._public_cert(cid)})
        if method == "DELETE":
            if any(r.get("certificate_id") == cid for lb in self.load_balancers.values()
                   for r in lb["forwarding_rules"]):
                return _err(403, "forbidden", "certificate is in use")
            del self.certificates[cid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_cert(self, cid: str) -> dict:
        return {k: v for k, v in self.certificates[cid].items() if not k.startswith("_")}

    # ---- load balancers ----------------------------------------------------------------------

    _LB_FIELDS = ("name", "region", "size_unit", "vpc_uuid", "forwarding_rules", "health_check",
                  "droplet_ids", "tag", "redirect_http_to_https", "sticky_sessions")

    def _lb_refusal(self, body: dict) -> httpx.Response | None:
        if body.get("droplet_ids") and body.get("tag"):
            return _err(422, "unprocessable_entity", "droplet_ids and tag are exclusive")
        for rule in body.get("forwarding_rules") or []:
            cid = rule.get("certificate_id")
            if cid and cid not in self.certificates:
                return _err(422, "unprocessable_entity", "certificate not found")
        return None

    def _load_balancers(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            if (refused := self._lb_refusal(body)) is not None:
                return refused
            lid = str(uuid.uuid4())
            self.load_balancers[lid] = {"id": lid, "ip": "", "status": "new", "_polls": 0,
                                        **{k: body.get(k) for k in self._LB_FIELDS}}
            self.load_balancers[lid]["region"] = {"slug": body["region"]}
            return httpx.Response(202, json={"load_balancer": self._public_lb(lid)})
        if method == "GET" and not rest:
            return httpx.Response(200, json={"load_balancers": [
                self._public_lb(k) for k in self.load_balancers], "links": {},
                "meta": {"total": len(self.load_balancers)}})
        lid = rest[0]
        if lid not in self.load_balancers:
            return _err(404, "not_found")
        lb = self.load_balancers[lid]
        if method == "GET":
            lb["_polls"] += 1
            if lb["status"] == "new" and lb["_polls"] >= self.lb_polls:
                lb["status"], lb["ip"] = "active", LB_IP
            return httpx.Response(200, json={"load_balancer": self._public_lb(lid)})
        if method == "PUT":
            missing = [k for k in ("name", "region", "forwarding_rules") if k not in body]
            if missing:                     # PUT replaces the whole load balancer
                return _err(422, "unprocessable_entity", "missing " + ",".join(missing))
            if (refused := self._lb_refusal(body)) is not None:
                return refused
            for k in self._LB_FIELDS:       # what the body leaves out is gone
                lb[k] = body.get(k)
            lb["region"] = {"slug": body["region"]} if isinstance(body["region"], str) \
                else body["region"]
            return httpx.Response(200, json={"load_balancer": self._public_lb(lid)})
        if method == "DELETE":
            del self.load_balancers[lid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")

    def _public_lb(self, lid: str) -> dict:
        return {k: v for k, v in self.load_balancers[lid].items() if not k.startswith("_")}

    # ---- cloud firewalls ---------------------------------------------------------------------

    def _firewalls(self, method, rest, body, request, token):
        if method == "POST" and not rest:
            fid = str(uuid.uuid4())
            self.firewalls[fid] = {"id": fid, "status": "succeeded", "name": body["name"],
                                   "inbound_rules": body["inbound_rules"],
                                   "outbound_rules": body["outbound_rules"],
                                   "tags": body.get("tags") or [], "droplet_ids": []}
            return httpx.Response(202, json={"firewall": self.firewalls[fid]})
        fid = rest[0] if rest else None
        if fid not in self.firewalls:
            return _err(404, "not_found")
        if method == "GET":
            return httpx.Response(200, json={"firewall": self.firewalls[fid]})
        if method == "DELETE":
            del self.firewalls[fid]
            return httpx.Response(204)
        return _err(405, "method_not_allowed")
