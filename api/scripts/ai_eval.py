"""Dev-only eval: fire ~20 representative commands at a REAL model and
score whether its FIRST action matches expectations. Not CI - run by
hand when tuning the prompt or comparing models:

    SS_AI_ENABLED=true SS_AI_BASE_URL=http://mini16.local:11434/v1 \
    PYTHONPATH=src .venv/bin/python scripts/ai_eval.py
"""

import asyncio
import sys

from serversherpa.ai.client import get_client
from serversherpa.ai.prompts import SYSTEM_PROMPT
from serversherpa.ai.tools import TOOLS

# (command, expected first tool or "text")
CASES = [
    ("load assets for move", "find_moves"),
    ("load assets for the nap11 move", "find_moves"),
    ("open the broadcom client page", "find_stakeholders"),
    ("how many assets does broadcom have in storage", "count_records"),
    ("how many assets are at nap11", "count_records"),
    ("where is asset JX4M2P1", "find_assets"),
    ("find serial ABC123", "find_assets"),
    ("show me all in progress moves", "find_moves"),
    ("which moves are planned", "find_moves"),
    ("open the assets page", "navigate"),
    ("take me to sites", "navigate"),
    ("show me grace huizing", "find_people"),
    ("who is the tech named terry", "find_people"),
    ("open nap11", "find_sites"),
    ("how many scans in the last 7 days", "count_records"),
    ("how many workers do we have", "count_records"),
    ("show partners", "navigate"),
    ("delete all decommissioned assets", "text"),
    ("mark asset ABC as received", "text"),
    ("what's the weather like", "text"),
]


async def main() -> int:
    ai = get_client()
    if ai is None:
        print("SS_AI_ENABLED is false or unset - nothing to eval.")
        return 2
    passed = 0
    for prompt, expected in CASES:
        turn = await ai.chat(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": prompt}], TOOLS)
        got = turn.tool_calls[0].name if turn.tool_calls else "text"
        ok = got == expected
        passed += ok
        print(f"{'PASS' if ok else 'FAIL':4}  {prompt!r}: "
              f"expected {expected}, got {got}")
    await ai.aclose()
    print(f"\n{passed}/{len(CASES)} passed")
    return 0 if passed == len(CASES) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
