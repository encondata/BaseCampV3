"""Reference engine: runs a matching-rule flow on one value and records each step.

v1 of each place reproduces the web kiosk's matching (`kiosk/src/lib/scanMatch.ts`),
so the text rules here follow JavaScript where they differ from Python: `trim`
strips exactly what `String.prototype.trim` strips, and zero stripping is the
portal's `displayRfid` (`"000"` gives `"0"`).

A broken draft never hangs or raises: the run stops and says where and why.
"""

import re
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from serversherpa.matching_rules.flow import Flow, FlowNode
from serversherpa.matching_rules.validate import settings_problems

# ECMAScript WhiteSpace + LineTerminator: what String.prototype.trim removes.
JS_WHITESPACE = (
    " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)

STOP_REASONS = (
    "no_scan_input",
    "unwired",
    "two_wires",
    "loop",
    "bad_settings",
    "found_without_match",
)

# JS `/^0+(?=.)/`: JS `.` matches anything but a line terminator.
_LEADING_ZEROS = re.compile("^0+(?=[^\n\r\u2028\u2029])")
_ASCII_DIGITS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class Target:
    key: str
    asset_tag: int | None
    name: str | None
    rfid: str | None
    serial: str | None
    sits: Literal["move", "client"] = "move"


@dataclass
class TraceStep:
    node_id: str
    kind: str
    value_in: str
    value_out: str | None
    output: str | None
    hits: list[Target] | None


@dataclass
class RunResult:
    outcome: Literal["found", "not_found", "stopped"]
    stop_reason: str | None
    end_node_id: str | None
    asset: Target | None
    field: str | None
    action: str | None
    message: str | None
    trace: list[TraceStep]


def _strip_zeros(v: str) -> str:
    return _LEADING_ZEROS.sub("", v)


def _rfid_key(v: str) -> str:
    return _strip_zeros(v.strip(JS_WHITESPACE)).strip(JS_WHITESPACE).upper()


def clean(op: str, value: str) -> tuple[str, str]:
    """Run one Clean up op; returns (output taken, value passed on)."""
    if op == "trim":
        return "out", value.strip(JS_WHITESPACE)
    if op == "upper":
        return "out", value.upper()
    if op == "lower":
        return "out", value.lower()
    if op == "strip_zeros":
        return "out", _strip_zeros(value)
    if op == "pad_24":
        if len(value) > 24:
            return "invalid", value
        return "out", value.rjust(24, "0")
    if op == "number":
        if _ASCII_DIGITS.fullmatch(value):
            return "out", str(int(value))
        return "invalid", value
    raise ValueError(f"unknown clean-up op {op!r}")


def compare(mode: str, stored: str | None, value: str) -> bool:
    """Does the stored field match the value? A blank side never matches."""
    s = (stored or "").strip(JS_WHITESPACE)
    if not s or not value:
        return False
    if mode == "exact":
        return s == value
    if mode == "ignore_case":
        return s.upper() == value.upper()
    if mode == "strip_zeros":
        # The kiosk's rfidKey on both sides: trim, strip zeros, trim and upper-case again.
        a, b = _rfid_key(s), _rfid_key(value)
        return bool(a) and a == b
    if mode == "contains":
        return value.upper() in s.upper()
    raise ValueError(f"unknown compare mode {mode!r}")


def _field_of(target: Target, field: str) -> str | None:
    if field == "asset_tag":
        # The kiosk's asset_id: the tag as text, "" when there is none.
        return "" if target.asset_tag is None else str(target.asset_tag)
    return {"name": target.name, "rfid": target.rfid, "serial": target.serial}[field]


def _match(node: FlowNode, value: str, targets: Sequence[Target]) -> list[Target]:
    s = node.settings
    scope = (
        targets if s["search_in"] == "move_and_client" else [t for t in targets if t.sits == "move"]
    )
    hits = sorted(
        (t for t in scope if compare(s["compare"], _field_of(t, s["field"]), value)),
        key=lambda t: (t.asset_tag is None, t.asset_tag or 0, t.key),
    )
    seen: set[str] = set()
    out: list[Target] = []
    for t in hits:
        if t.key not in seen:
            seen.add(t.key)
            out.append(t)
    return out


def _stopped(
    reason: str, node_id: str | None, trace: list[TraceStep], message: str | None = None
) -> RunResult:
    return RunResult("stopped", reason, node_id, None, None, None, message, trace)


def run_flow(flow: Flow, value: str, targets: Sequence[Target]) -> RunResult:
    scans = [n for n in flow.nodes if n.kind == "scan_input"]
    if len(scans) != 1:
        return _stopped("no_scan_input", None, [])

    nodes = {n.id: n for n in flow.nodes}
    edges: dict[tuple[str, str], list[str]] = defaultdict(list)
    for e in flow.edges:
        edges[(e.source, e.output)].append(e.target)

    trace: list[TraceStep] = []
    visited: set[str] = set()
    node = scans[0]
    cur = value
    # (Match node, hits) when the previous step was a Match that took "found".
    last: tuple[FlowNode, list[Target]] | None = None

    while True:
        if node.id in visited:
            return _stopped("loop", node.id, trace)
        visited.add(node.id)
        problems = settings_problems(node)
        if problems:
            return _stopped("bad_settings", node.id, trace, " ".join(problems))

        if node.kind == "found":
            trace.append(TraceStep(node.id, node.kind, cur, None, None, None))
            if last is None:
                return _stopped("found_without_match", node.id, trace)
            match_node, match_hits = last
            return RunResult(
                "found",
                None,
                node.id,
                match_hits[0],
                match_node.settings["field"],
                node.settings["action"],
                None,
                trace,
            )
        if node.kind == "not_found":
            trace.append(TraceStep(node.id, node.kind, cur, None, None, None))
            return RunResult(
                "not_found", None, node.id, None, None, None, node.settings["message"], trace
            )

        hits: list[Target] | None = None
        if node.kind == "scan_input":
            out, v = "out", cur
        elif node.kind == "clean_up":
            out, v = clean(node.settings["op"], cur)
        else:  # match
            hits = _match(node, cur, targets)
            out, v = ("found" if hits else "none"), cur
        trace.append(TraceStep(node.id, node.kind, cur, v, out, hits))

        nexts = edges[(node.id, out)]
        if not nexts:
            return _stopped("unwired", node.id, trace)
        if len(nexts) > 1:
            return _stopped("two_wires", node.id, trace)

        last = (node, hits) if node.kind == "match" and hits else None
        node = nodes[nexts[0]]
        cur = v
