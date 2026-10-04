"""A Provisioner for pipeline and API tests: records each VM step and its
context, prints one line, and can fail (StepFailed), raise, wait on a gate,
run an async effect (what the real step leaves behind, such as the VM's
address) and answer an outcome."""

import asyncio

from sirdar_api.deploy import publish
from sirdar_api.deploy.provision import VmOutcome


class FakeProvisioner:
    def __init__(self):
        self.calls: list[str] = []
        self.contexts: list = []
        self.outcomes: dict[str, VmOutcome] = {}
        self.fail: dict[str, str] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.effects: dict = {}
        self.echo: dict[str, str] = {}

    async def run(self, step: str, ctx, out) -> VmOutcome:
        self.calls.append(step)
        self.contexts.append(ctx)
        out(self.echo.get(step, f"{step}: ok\n"))
        if step in self.gates:
            await self.gates[step].wait()
        if step in self.effects:
            await self.effects[step](ctx)
        if step in self.raises:
            raise self.raises[step]
        if step in self.fail:
            raise publish.StepFailed(self.fail[step])
        return self.outcomes.get(step, VmOutcome())
