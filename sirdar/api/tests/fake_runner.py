"""A Runner for pipeline and API tests: records every request and answers
from canned results (default: success), with optional output, errors and
gates (an Event the step waits on, to test the lock and cancel)."""

import asyncio
from collections import defaultdict

from sirdar_api.deploy.runner import RunRequest, RunResult


class FakeRunner:
    def __init__(self):
        self.requests: list[RunRequest] = []
        self.results: dict[str, RunResult] = {}
        self.output: dict[str, list[str]] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.started: defaultdict[str, asyncio.Event] = defaultdict(asyncio.Event)

    def steps(self) -> list[str]:
        return [r.step for r in self.requests]

    async def run(self, request: RunRequest, on_output) -> RunResult:
        self.requests.append(request)
        self.started[request.step].set()
        if request.step in self.raises:
            raise self.raises[request.step]
        for line in self.output.get(request.step, [f"ok: [target] {request.step}\n"]):
            on_output(line)
        if request.step in self.gates:
            await self.gates[request.step].wait()
        return self.results.get(request.step, RunResult(status="successful", rc=0))
