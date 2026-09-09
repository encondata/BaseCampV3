"""Step 3 of the Move Report: one SVG per rack on the requested side."""

from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from serversherpa.reports import rack_renderer
from serversherpa.reports.move_report.gather import MoveAsset

Renderer = Callable[[list[dict], str, str], Awaitable[str]]


@dataclass(frozen=True)
class RackSvg:
    rack_name: str
    svg: str
    assets: list[MoveAsset]        # racked on this side, sorted by RU desc (top of rack first)


def racks_on(assets: list[MoveAsset], side: str) -> dict[str, list[MoveAsset]]:
    rack = (lambda a: a.source_rack) if side == "source" else (lambda a: a.destination_rack)
    ru = (lambda a: a.source_ru) if side == "source" else (lambda a: a.destination_ru)
    groups: dict[str, list[MoveAsset]] = defaultdict(list)
    for a in assets:
        if rack(a) and ru(a) is not None:
            groups[rack(a)].append(a)
    return {name: sorted(rows, key=lambda a: -(ru(a) or 0)) for name, rows in sorted(groups.items())}


async def rack_svgs(assets: list[MoveAsset], side: str,
                    renderer: Renderer = rack_renderer.render) -> list[RackSvg]:
    out = []
    for name, rows in racks_on(assets, side).items():
        svg = await renderer([a.to_row() for a in assets], name, side)
        out.append(RackSvg(rack_name=name, svg=svg, assets=rows))
    return out
