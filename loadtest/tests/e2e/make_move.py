"""Makes a move on the scratch server for a load test run, the way the portal's
Bulk Actions › Create a move in steps does.

    .venv/bin/python tests/e2e/make_move.py --servers 60 [--enable-rules] [--planned]
    .venv/bin/python tests/e2e/make_move.py --activate-checkpoints
    .venv/bin/python tests/e2e/make_move.py --enable-rules        # rules only, no move
    .venv/bin/python tests/e2e/make_move.py --disable-rules       # rules only, no move
    .venv/bin/python tests/e2e/make_move.py --serve-route 8797    # canned road route

It talks only to the scratch API on http://127.0.0.1:8010, signs in as the scratch
admin (password read from LOADTEST_SCRATCH_DIR/admin-password, which scratch_stack.sh
up writes), makes two made-up sites (once), uploads a generated From-To with
make_model_mode=force, adds servers ÷ 20 crates and crates ÷ 15 trucks, waits for the
import worker, then gives the move a generated move password and sets it In progress
(unless --planned).

It prints the move id. The move password goes to LOADTEST_SCRATCH_DIR/moves/<id>.password
and is never printed.

`--serve-route PORT` answers the routing service's question on 127.0.0.1:PORT with a
road-like line of a few hundred points between the two coordinates asked about, in
the OSRM shape the tool reads, until it is stopped. Start the tool with
LOADTEST_ROUTER_URL=http://127.0.0.1:PORT so nothing leaves the machine.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import secrets
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

SERVER = "http://127.0.0.1:8010"      # the scratch API, never anything else
ADMIN_EMAIL = "loadtest-admin@example.com"
SCRATCH = Path(os.environ.get("LOADTEST_SCRATCH_DIR")
               or Path(tempfile.gettempdir()) / "loadtest-scratch").resolve()
ORIGIN = {"name": "Load test origin DC", "code": "LTO", "latitude": 39.0997,
          "longitude": -94.5786, "city": "Kansas City", "region": "MO"}
DESTINATION = {"name": "Load test destination DC", "code": "LTD", "latitude": 32.7767,
               "longitude": -96.797, "city": "Dallas", "region": "TX"}
HEADERS = [
    "Serial Number", "Asset Name", "Asset Make", "Asset Model", "RFID Tag", "Priority",
    "Disposition", "Owner", "Source Pod", "Source Rack", "Source RU", "Source Position",
    "Destination Pod", "Destination Rack", "Destination RU", "Destination Position",
    "Data 1", "Data 2", "Data 3", "Data 4", "Data 5", "Data 6", "Mgmt 1", "Mgmt 2",
    "Vendor Involvement",
]
CONTAINER_SIZE, CONTAINERS_PER_TRUCK = 20, 15


def die(text: str) -> None:
    print(f"make_move: {text}", file=sys.stderr, flush=True)
    sys.exit(1)


def code_of(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        return response.text[:200]
    return json.dumps(detail)[:400]


class Portal:
    def __init__(self) -> None:
        self.http = httpx.Client(base_url=SERVER, timeout=60)
        password = (SCRATCH / "admin-password").read_text(encoding="utf-8").strip()
        r = self.http.post("/auth/login", json={"email": ADMIN_EMAIL, "password": password})
        if r.status_code != 200 or "access_token" not in r.json():
            die(f"admin sign-in failed: {r.status_code} {code_of(r)}")
        self.http.headers["Authorization"] = f"Bearer {r.json()['access_token']}"

    def call(self, method: str, path: str, ok=(200, 201, 204), **kw) -> dict | list | None:
        r = self.http.request(method, path, **kw)
        if r.status_code not in ok:
            die(f"{method} {path}: {r.status_code} {code_of(r)}")
        return r.json() if r.content else None


def site(portal: Portal, spec: dict) -> str:
    for row in portal.call("GET", "/sites"):
        if row["name"] == spec["name"]:
            return row["id"]
    return portal.call("POST", "/sites", json=spec)["id"]


def from_to_csv(servers: int, tag: str) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=HEADERS, lineterminator="\n")
    writer.writeheader()
    for i in range(servers):
        rack, ru = divmod(i, 40)
        writer.writerow({
            "Serial Number": f"LT{tag}{i + 1:05d}", "Asset Name": f"lt-{tag.lower()}-{i + 1:05d}",
            "Asset Make": "Dell", "Asset Model": "PowerEdge R650",
            "Source Rack": f"SRC-{rack + 1:03d}", "Source RU": str(ru + 1),
            "Destination Rack": f"DST-{rack + 1:03d}", "Destination RU": str(ru + 1),
        })
    return out.getvalue().encode()


def wait_for(portal: Portal, path: str, what: str, timeout: float = 600) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = portal.call("GET", path)
        if job["status"] in ("completed", "failed", "cancelled", "error"):
            if job["status"] != "completed":
                die(f"{what} ended {job['status']}: {job.get('error')}")
            return job
        time.sleep(1)
    die(f"{what} did not finish in {timeout:.0f} s (is the import worker running?)")


def set_rules(portal: Portal, enabled: bool) -> int:
    changed = 0
    for rule in portal.call("GET", "/status-rules"):
        if rule["enabled"] != enabled:
            portal.call("PATCH", f"/status-rules/{rule['id']}", json={"enabled": enabled})
            changed += 1
    return changed


def profile_checkpoints() -> list[str]:
    import tomllib
    profile = Path(__file__).resolve().parents[2] / "profiles" / "fast.toml"
    stages = tomllib.loads(profile.read_text(encoding="utf-8"))["stage"]
    return [s["checkpoint"] for s in stages if s.get("checkpoint")]


def activate_checkpoints(portal: Portal) -> list[str]:
    """Every profile checkpoint an active asset status, as the readiness check asks."""
    active = {r["key"] for r in portal.call("GET", "/status-values",
                                            params={"record_type": "asset"})
              if r.get("is_active", True)}
    missing = [c for c in profile_checkpoints() if c not in active]
    for key in missing:
        portal.call("PATCH", f"/status-values/asset/{key}", json={"is_active": True})
    return missing


def make_move(portal: Portal, servers: int, planned: bool) -> str:
    tag = secrets.token_hex(3).upper()
    origin, destination = site(portal, ORIGIN), site(portal, DESTINATION)
    crates = math.ceil(servers / CONTAINER_SIZE)
    trucks = math.ceil(crates / CONTAINERS_PER_TRUCK)
    name = f"Load test move {tag}"
    draft = portal.call("POST", "/bulk/move-setup", json={
        "name": name, "initiative_type": "move", "origin_site_id": origin,
        "destination_site_id": destination})
    draft_id = draft["id"]
    portal.call("POST", f"/bulk/move-setup/{draft_id}/assets",
                files={"file": (f"from-to-{tag}.csv", from_to_csv(servers, tag), "text/csv")},
                data={"make_model_mode": "force"})
    wait_for(portal, f"/bulk/move-setup/{draft_id}/assets", "the From-To check")
    portal.call("PATCH", f"/bulk/move-setup/{draft_id}", json={
        "crates": {"convention": f"CRT-{tag}-xxx", "count": crates, "start": 1,
                   "container_type": "pelican_case"},
        "trucks": {"convention": f"TRK-{tag}-xx", "count": trucks, "start": 1}})
    portal.call("POST", f"/bulk/move-setup/{draft_id}/create")
    job = wait_for(portal, f"/bulk/move-setup/{draft_id}", "the move create")
    move_id = job["initiative_id"]
    roster = portal.call("GET", f"/initiatives/{move_id}/assets")
    if len(roster) != servers:
        die(f"the move has {len(roster)} servers, not {servers}")
    password = secrets.token_urlsafe(12)
    change = {"kiosk_password": password} if planned else {
        "status": "in_progress", "kiosk_password": password}
    portal.call("PATCH", f"/initiatives/{move_id}", json=change)
    folder = SCRATCH / "moves"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{move_id}.password"
    path.write_text(password + "\n", encoding="utf-8")
    path.chmod(0o600)
    print(f"{name}: {servers} servers, {crates} crates, {trucks} trucks, "
          f"{'planned' if planned else 'in progress'}", file=sys.stderr, flush=True)
    return move_id


# ── the canned road route ──────────────────────────────────────────────


def road_line(lng1: float, lat1: float, lng2: float, lat2: float, points: int = 400):
    """A plausible road: the straight line bent by two gentle curves and small wiggles."""
    line = []
    for i in range(points):
        t = i / (points - 1)
        bend = 0.35 * math.sin(math.pi * t) + 0.08 * math.sin(7 * math.pi * t)
        wiggle = 0.01 * math.sin(53 * math.pi * t)
        lng = lng1 + (lng2 - lng1) * t + bend + wiggle
        lat = lat1 + (lat2 - lat1) * t + 0.5 * wiggle
        line.append([round(lng, 6), round(lat, 6)])
    line[0], line[-1] = [lng1, lat1], [lng2, lat2]
    return line


class RouteHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server's name
        prefix = "/route/v1/driving/"
        path = self.path.split("?", 1)[0]
        try:
            if not path.startswith(prefix):
                raise ValueError(path)
            (lng1, lat1), (lng2, lat2) = (map(float, p.split(","))
                                          for p in path[len(prefix):].split(";"))
            body = {"code": "Ok", "routes": [{
                "distance": 890000.0, "duration": 32000.0,
                "geometry": {"type": "LineString",
                             "coordinates": road_line(lng1, lat1, lng2, lat2)}}]}
            status = 200
        except ValueError:
            body, status = {"code": "InvalidUrl", "message": "unknown path"}, 400
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        print(f"route: {fmt % args}", file=sys.stderr, flush=True)


def serve_route(port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), RouteHandler)
    print(f"Canned route on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--servers", type=int, help="make a move with this many servers")
    parser.add_argument("--planned", action="store_true",
                        help="leave the new move Planned (it still gets a move password)")
    rules = parser.add_mutually_exclusive_group()
    rules.add_argument("--enable-rules", action="store_true",
                       help="enable every status rule (the scan worker reloads them "
                            "within 60 s)")
    rules.add_argument("--disable-rules", action="store_true",
                       help="disable every status rule")
    parser.add_argument("--activate-checkpoints", action="store_true",
                        help="make every checkpoint in the profiles an active asset status")
    parser.add_argument("--serve-route", type=int, metavar="PORT",
                        help="serve the canned road route on 127.0.0.1:PORT until stopped")
    args = parser.parse_args()
    if args.serve_route:
        serve_route(args.serve_route)
        return
    if not (args.servers or args.enable_rules or args.disable_rules
            or args.activate_checkpoints):
        parser.error("nothing to do: give --servers, --activate-checkpoints, "
                     "--enable-rules or --disable-rules")
    portal = Portal()
    if args.activate_checkpoints:
        done = activate_checkpoints(portal)
        print(f"Checkpoints activated: {', '.join(done) or 'none needed'}",
              file=sys.stderr, flush=True)
    if args.enable_rules or args.disable_rules:
        changed = set_rules(portal, enabled=args.enable_rules)
        print(f"Status rules: {changed} {'enabled' if args.enable_rules else 'disabled'}",
              file=sys.stderr, flush=True)
    if args.servers:
        if args.servers < 1:
            parser.error("--servers must be at least 1")
        print(make_move(portal, args.servers, args.planned), flush=True)


if __name__ == "__main__":
    main()
