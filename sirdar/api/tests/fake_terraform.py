"""A TerraformRunner for provisioner and pipeline tests: records each
request (its environment's names and the token it carried), prints lines,
answers from canned results (default: success), and runs effects — what a
real apply or destroy leaves behind (a state file, a VM in FakeProxmox).

`plan -out=tfplan` writes a plan the way Terraform decides it: "create"
without a VM in the state; "delete" + "create" (a replace) when the clone
block differs from the state's and lifecycle.ignore_changes doesn't cover
"clone" (bpg/proxmox's clone fields force a new VM); "update" otherwise.
`plan_actions` forces the actions. `show -json tfplan` prints that plan as
one JSON line."""

import asyncio
import json

from sirdar_api.deploy.terraform import TfRequest, TfResult

PLAN_FILE = "tfplan"


def _vm_config(request: TfRequest) -> dict:
    config = json.loads((request.workdir / "main.tf.json").read_text())
    return config["resource"]["proxmox_virtual_environment_vm"]["vm"]


def _state_vm(request: TfRequest) -> dict | None:
    try:
        state = json.loads((request.workdir / "terraform.tfstate").read_text())
    except (OSError, ValueError):
        return None
    for res in state.get("resources", []):
        if res.get("type") == "proxmox_virtual_environment_vm":
            instances = res.get("instances") or [{}]
            return instances[0].get("attributes") or {}
    return None


def write_state(request: TfRequest, *, vm: bool = True) -> None:
    """What `terraform apply` (vm=True) or `destroy` (vm=False) leaves. An
    apply records the clone block it built from."""
    resources = []
    if vm:
        resources = [{"type": "proxmox_virtual_environment_vm", "name": "vm",
                      "instances": [{"attributes": {"clone": _vm_config(request)["clone"]}}]}]
    (request.workdir / "terraform.tfstate").write_text(json.dumps({"resources": resources}))


def plan_of(actions: list[str]) -> dict:
    return {"format_version": "1.2", "resource_changes": [
        {"address": "proxmox_virtual_environment_vm.vm", "type": "proxmox_virtual_environment_vm",
         "change": {"actions": actions}}]}


class FakeTerraform:
    def __init__(self):
        self.requests: list[TfRequest] = []
        self.results: dict[str, TfResult] = {}
        self.effects: dict = {}
        self.output: dict[str, list[str]] = {}
        self.gates: dict[str, asyncio.Event] = {}
        self.plan_actions: list[str] | None = None
        self.plans: list[list[str]] = []          # the actions of each plan made

    def commands(self) -> list[str]:
        return [r.args[0] for r in self.requests]

    def _plan(self, request: TfRequest) -> None:
        actions = self.plan_actions
        if actions is None:
            vm = _vm_config(request)
            built = _state_vm(request)
            ignored = vm.get("lifecycle", {}).get("ignore_changes", [])
            if built is None:
                actions = ["create"]
            elif built.get("clone") != vm["clone"] and "clone" not in ignored:
                actions = ["delete", "create"]
            else:
                actions = ["update"]
        self.plans.append(list(actions))
        (request.workdir / PLAN_FILE).write_text(json.dumps(plan_of(actions)))

    async def run(self, request: TfRequest, on_output) -> TfResult:
        self.requests.append(request)
        command = request.args[0]
        if command == "init":
            (request.workdir / ".terraform").mkdir(exist_ok=True)
        if command == "plan":
            self._plan(request)
        if command == "show" and command not in self.output:
            on_output((request.workdir / PLAN_FILE).read_text() + "\n")
        for line in self.output.get(command, [] if command == "show"
                                    else [f"fake terraform {command}\n"]):
            on_output(line)
        if command in self.gates:
            await self.gates[command].wait()
        if command in self.effects:
            self.effects[command](request)
        return self.results.get(command, TfResult(status="successful", rc=0))
