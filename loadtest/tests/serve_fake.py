"""Serves the fake BaseCamp server on this machine, for trying the page by hand.

    .venv/bin/python tests/serve_fake.py [--port 8796] [--truck-rules]

A 60-server move in progress (3 containers, 1 truck), a second move that is only
planned, one portal user, and a ticker that processes waiting scans every second, the
way the server's scan worker does. The same port answers the road-route question in
the routing service's shape, so the tool can be started with
`LOADTEST_ROUTER_URL=http://127.0.0.1:8796` and nothing leaves the machine.

By default the status rules for On Truck and Received are left out, so the readiness
check and the result carry their warnings. `--truck-rules` keeps every rule.
"""

from __future__ import annotations

import argparse
import asyncio

import uvicorn
from fakeserver import FakeBaseCamp

from loadtest.clock import RealClock

EMAIL = "loadtest@example.com"
PASSWORD = "fake-portal-pass"
MOVE_PASSWORD = "move-pass-1"
NO_RULE_STATUSES = ("on_truck", "received")


def build(*, truck_rules: bool) -> FakeBaseCamp:
    fake = FakeBaseCamp(RealClock())
    fake.add_move(servers=60, containers=3, trucks=1, password=MOVE_PASSWORD)
    fake.add_move(servers=5, containers=1, trucks=1, status="planned", password="move-pass-2")
    fake.add_portal_user(EMAIL, PASSWORD)
    if not truck_rules:
        fake.status_rules = [r for r in fake.status_rules
                             if r["trigger_status"] not in NO_RULE_STATUSES]

    @fake.app.get("/route/v1/driving/{points:path}")
    async def route(points: str) -> dict:
        (lng1, lat1), (lng2, lat2) = (map(float, p.split(",")) for p in points.split(";"))
        coords = [[lng1 + (lng2 - lng1) * i / 20, lat1 + (lat2 - lat1) * i / 20 + 0.05 * (i % 2)]
                  for i in range(21)]
        return {"code": "Ok", "routes": [{"geometry": {"type": "LineString",
                                                      "coordinates": coords}}]}

    return fake


async def main(port: int, truck_rules: bool) -> None:
    fake = build(truck_rules=truck_rules)
    server = uvicorn.Server(uvicorn.Config(fake.app, host="127.0.0.1", port=port,
                                           log_level="warning", lifespan="off"))

    async def tick() -> None:
        while True:
            await asyncio.sleep(1)
            fake.process_scans()

    print(f"Fake BaseCamp: http://127.0.0.1:{port}")
    print(f"  Server         http://127.0.0.1:{port}")
    print(f"  Portal email   {EMAIL}")
    print(f"  Password       {PASSWORD}")
    print(f"  Move           Load test move 1 (60 servers), move password {MOVE_PASSWORD}")
    print(f"  Status rules   {'all' if truck_rules else 'none for On Truck and Received'}")
    print(f"Start the tool with LOADTEST_ROUTER_URL=http://127.0.0.1:{port}", flush=True)
    ticker = asyncio.create_task(tick())
    try:
        await server.serve()
    finally:
        ticker.cancel()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8796)
    parser.add_argument("--truck-rules", action="store_true",
                        help="keep the status rules for On Truck and Received")
    args = parser.parse_args()
    asyncio.run(main(args.port, args.truck_rules))
