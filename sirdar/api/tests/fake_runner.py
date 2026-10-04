"""A Runner for pipeline and API tests: records every request and answers
from canned results (default: success), with optional output, errors,
gates (an Event the step waits on, to test the lock and cancel) and
effects (a function of the request, run before answering: what the real
playbook would leave behind, such as a fetched snapshot bundle)."""

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
        self.effects: dict = {}
        self.started: defaultdict[str, asyncio.Event] = defaultdict(asyncio.Event)

    def steps(self) -> list[str]:
        return [r.step for r in self.requests]

    async def run(self, request: RunRequest, on_output) -> RunResult:
        self.requests.append(request)
        self.started[request.step].set()
        if request.step in self.raises:
            raise self.raises[request.step]
        for line in self.output.get(request.step, [f"ok: [target] {request.step}\n"]):
            await asyncio.to_thread(on_output, line)   # a worker thread, like AnsibleRunner
        if request.step in self.gates:
            await self.gates[request.step].wait()
        if request.step in self.effects:
            self.effects[request.step](request)
        return self.results.get(request.step, RunResult(status="successful", rc=0))
