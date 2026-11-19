"""Structure checks for a matching-rule flow (no database)."""

from collections import defaultdict
from dataclasses import dataclass

from serversherpa.matching_rules.flow import (
    CLEAN_OPS,
    COMPARES,
    FIELDS,
    FOUND_ACTIONS,
    MULTIPLE,
    SEARCH_IN,
    TABLES,
    Flow,
    FlowNode,
    node_title,
    outputs_for,
)


@dataclass(frozen=True)
class Problem:
    message: str
    node_ids: tuple[str, ...]


@dataclass(frozen=True)
class CheckItem:
    code: str
    label: str
    problems: tuple[Problem, ...]

    @property
    def ok(self) -> bool:
        return not self.problems


CHECKS: tuple[tuple[str, str], ...] = (
    ("one_scan_input", "Exactly one Scan input"),
    ("outputs_wired", "Every output is wired to one step"),
    ("all_reachable", "Every step is reachable from the Scan input"),
    ("paths_end", "Every path ends in Found or Not found"),
    ("no_loops", "No loops"),
    ("settings_filled", "Every step's settings are filled in"),
    ("found_after_match", "Found follows a Match's found output"),
)

# (settings key, vocabulary, message) per kind, in the order they are reported.
_REQUIRED: dict[str, tuple[tuple[str, dict[str, str], str], ...]] = {
    "clean_up": (("op", CLEAN_OPS, "choose a clean-up."),),
    "match": (
        ("table", TABLES, "choose a table."),
        ("field", FIELDS, "choose a field."),
        ("compare", COMPARES, "choose how to compare."),
        ("search_in", SEARCH_IN, "choose where to search."),
        ("multiple", MULTIPLE, "choose what happens when two or more match."),
    ),
    "found": (("action", FOUND_ACTIONS, "choose what happens."),),
}


def settings_problems(node: FlowNode) -> list[str]:
    """Messages (each led by the step's title) for settings that are unfilled or unknown."""
    title = node_title(node)
    out = [
        f"{title}: {message}"
        for key, vocab, message in _REQUIRED.get(node.kind, ())
        if node.settings.get(key) not in vocab
    ]
    if node.kind == "not_found" and not node.settings.get("message", "").strip():
        out.append(f"{title}: enter the message.")
    return out


def structure_checks(flow: Flow) -> list[CheckItem]:
    nodes = {n.id: n for n in flow.nodes}
    scans = [n for n in flow.nodes if n.kind == "scan_input"]
    out_edges: dict[str, list] = defaultdict(list)
    for e in flow.edges:
        out_edges[e.source].append(e)

    results: dict[str, list[Problem]] = {code: [] for code, _ in CHECKS}

    # one_scan_input
    if not scans:
        results["one_scan_input"].append(Problem("The flow has no Scan input.", ()))
    elif len(scans) > 1:
        results["one_scan_input"].append(
            Problem(
                f"The flow has {len(scans)} Scan inputs; it needs exactly one.",
                tuple(n.id for n in scans),
            )
        )

    # outputs_wired
    wired = results["outputs_wired"]
    for n in flow.nodes:
        t = node_title(n)
        valid = outputs_for(n)
        for o in valid:
            count = sum(1 for e in out_edges[n.id] if e.output == o)
            if count == 0:
                wired.append(Problem(f'{t}: the "{o}" output isn\'t wired.', (n.id,)))
            elif count > 1:
                wired.append(Problem(f'{t}: the "{o}" output is wired to {count} steps.', (n.id,)))
        for e in out_edges[n.id]:
            if e.output not in valid:
                wired.append(
                    Problem(
                        f'{t}: wired from "{e.output}", an output this step doesn\'t have.', (n.id,)
                    )
                )
    for e in flow.edges:
        target = nodes[e.target]
        if target.kind == "scan_input":
            wired.append(
                Problem(
                    f"{node_title(target)}: nothing can be wired into a Scan input.", (target.id,)
                )
            )

    # reachability (BFS from the Scan input(s))
    reached: set[str] = set()
    queue = [n.id for n in scans]
    while queue:
        cur = queue.pop()
        if cur in reached:
            continue
        reached.add(cur)
        queue.extend(e.target for e in out_edges[cur])

    if len(scans) == 1:
        for n in flow.nodes:
            if n.id not in reached:
                results["all_reachable"].append(
                    Problem(f"{node_title(n)} can't be reached from the Scan input.", (n.id,))
                )

    # paths_end: reachable step with an output nothing is wired to
    for n in flow.nodes:
        if n.id not in reached:
            continue
        used = {e.output for e in out_edges[n.id]}
        if any(o not in used for o in outputs_for(n)):
            results["paths_end"].append(
                Problem(
                    f"A path through {node_title(n)} doesn't end in Found or Not found.", (n.id,)
                )
            )

    # no_loops: DFS with white/gray/black colors; a back edge flags every node on its cycle
    color: dict[str, int] = {}
    on_cycle: set[str] = set()
    stack: list[str] = []

    def visit(start: str) -> None:
        # iterative DFS so a long chain can't hit the recursion limit
        frames = [(start, iter(out_edges[start]))]
        color[start] = 1
        stack.append(start)
        while frames:
            node_id, it = frames[-1]
            advanced = False
            for e in it:
                state = color.get(e.target, 0)
                if state == 0:
                    color[e.target] = 1
                    stack.append(e.target)
                    frames.append((e.target, iter(out_edges[e.target])))
                    advanced = True
                    break
                if state == 1:
                    on_cycle.update(stack[stack.index(e.target) :])
            if not advanced:
                color[node_id] = 2
                stack.pop()
                frames.pop()

    for n in flow.nodes:
        if color.get(n.id, 0) == 0:
            visit(n.id)
    for n in flow.nodes:
        if n.id in on_cycle:
            results["no_loops"].append(Problem(f"{node_title(n)} is part of a loop.", (n.id,)))

    # settings_filled
    for n in flow.nodes:
        for message in settings_problems(n):
            results["settings_filled"].append(Problem(message, (n.id,)))

    # found_after_match
    for e in flow.edges:
        source, target = nodes[e.source], nodes[e.target]
        if target.kind == "found" and not (source.kind == "match" and e.output == "found"):
            results["found_after_match"].append(
                Problem(
                    f"{node_title(target)} is wired from {node_title(source)}; "
                    'only a Match\'s "found" output can lead to Found.',
                    (target.id,),
                )
            )
        elif source.kind == "match" and e.output == "found" and target.kind != "found":
            results["found_after_match"].append(
                Problem(
                    f'{node_title(source)}: the "found" output must lead to Found.', (source.id,)
                )
            )

    return [CheckItem(code, label, tuple(results[code])) for code, label in CHECKS]
