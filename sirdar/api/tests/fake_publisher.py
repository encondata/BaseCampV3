"""A Publisher for pipeline tests: records each step and its context,
prints one line, and can fail (StepFailed), raise, or wait on a gate."""

import asyncio

from sirdar_api.deploy import publish


class FakePublisher:
    def __init__(self):
        self.calls: list[str] = []
        self.contexts: list = []
        self.fail: dict[str, str] = {}
        self.raises: dict[str, Exception] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.echo: dict[str, str] = {}

    async def run(self, step: str, ctx, out) -> None:
        self.calls.append(step)
        self.contexts.append(ctx)
        out(self.echo.get(step, f"{step}: ok\n"))
        if step in self.gates:
            await self.gates[step].wait()
        if step in self.raises:
            raise self.raises[step]
        if step in self.fail:
            raise publish.StepFailed(self.fail[step])
