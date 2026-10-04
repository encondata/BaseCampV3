"""A TerraformRunner for provisioner and pipeline tests: records each
request (its environment's names and the token it carried), prints lines,
answers from canned results (default: success), and runs effects — what a
real apply or destroy leaves behind (a state file, a VM in FakeProxmox)."""

import asyncio
import json

from sirdar_api.deploy.terraform import TfRequest, TfResult


def write_state(request: TfRequest, *, vm: bool = True) -> None:
    """What `terraform apply` (vm=True) or `destroy` (vm=False) leaves."""
    resources = [{"type": "proxmox_virtual_environment_vm", "name": "vm"}] if vm else []
    (request.workdir / "terraform.tfstate").write_text(json.dumps({"resources": resources}))


class FakeTerraform:
    def __init__(self):
        self.requests: list[TfRequest] = []
        self.results: dict[str, TfResult] = {}
        self.effects: dict = {}
        self.output: dict[str, list[str]] = {}
        self.gates: dict[str, asyncio.Event] = {}

    def commands(self) -> list[str]:
        return [r.args[0] for r in self.requests]

    async def run(self, request: TfRequest, on_output) -> TfResult:
        self.requests.append(request)
        command = request.args[0]
        if command == "init":
            (request.workdir / ".terraform").mkdir(exist_ok=True)
        for line in self.output.get(command, [f"fake terraform {command}\n"]):
            on_output(line)
        if command in self.gates:
            await self.gates[command].wait()
        if command in self.effects:
            self.effects[command](request)
        return self.results.get(command, TfResult(status="successful", rc=0))
