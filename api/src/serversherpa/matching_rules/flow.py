"""Matching-rule flow schema: nodes, edges and the vocabularies they use."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Place = Literal["printing", "scanning"]
PLACES: tuple[Place, ...] = ("printing", "scanning")

NodeKind = Literal["scan_input", "clean_up", "match", "found", "not_found"]

KIND_LABELS = {
    "scan_input": "Scan input",
    "clean_up": "Clean up",
    "match": "Match",
    "found": "Found",
    "not_found": "Not found",
}
CLEAN_OPS = {
    "trim": "Trim",
    "upper": "Upper-case",
    "lower": "Lower-case",
    "strip_zeros": "Strip leading zeros",
    "pad_24": "Pad to 24",
    "number": "Read as a number",
}
FIELDS = {"asset_tag": "asset tag", "serial": "serial", "rfid": "RFID", "name": "name"}
COMPARES = {
    "exact": "Exact",
    "ignore_case": "Ignore case",
    "strip_zeros": "Strip leading zeros on both sides",
    "contains": "Contains",
}
SEARCH_IN = {
    "move": "This move",
    "move_and_client": "This move plus the client's other devices",
}
FOUND_ACTIONS = {"print_label": "Print the label", "record_scan": "Record the scan"}
TABLES = {"assets": "Assets"}
MULTIPLE = {"first": "Take the first, by asset tag order"}
EXPECTED = ("asset_tag", "serial", "rfid", "name", "not_found")


class Position(BaseModel):
    x: float
    y: float


class FlowNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    kind: NodeKind
    settings: dict[str, str] = {}
    position: Position


class FlowEdge(BaseModel):
    id: str
    source: str
    output: str
    target: str


class Flow(BaseModel):
    format: Literal[1] = 1
    nodes: list[FlowNode] = Field(max_length=100)
    edges: list[FlowEdge] = Field(max_length=200)

    @model_validator(mode="after")
    def _consistent(self) -> "Flow":
        node_ids = [n.id for n in self.nodes]
        if len(set(node_ids)) != len(node_ids):
            raise ValueError("duplicate node ids")
        edge_ids = [e.id for e in self.edges]
        if len(set(edge_ids)) != len(edge_ids):
            raise ValueError("duplicate edge ids")
        known = set(node_ids)
        for e in self.edges:
            if e.source not in known or e.target not in known:
                raise ValueError(f"edge {e.id} points at a missing node")
        return self


def outputs_for(node: FlowNode) -> tuple[str, ...]:
    if node.kind == "scan_input":
        return ("out",)
    if node.kind == "clean_up":
        if node.settings.get("op") in ("pad_24", "number"):
            return ("out", "invalid")
        return ("out",)
    if node.kind == "match":
        return ("found", "none")
    return ()


def node_title(node: FlowNode) -> str:
    base = KIND_LABELS[node.kind]
    if node.kind == "clean_up":
        op = node.settings.get("op")
        if op in CLEAN_OPS:
            return f"{base} ({CLEAN_OPS[op]})"
    elif node.kind == "match":
        field = node.settings.get("field")
        if field in FIELDS:
            return f"{base} ({FIELDS[field]})"
    return base
