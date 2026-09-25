"""Naming conventions for records created in numbered batches (Bulk Actions ›
Create a move in steps: crates and trucks).

A convention is literal text holding exactly one run of the letter x (either
case) that marks the number: `CRT-SJC-DAL-xxx` → CRT-SJC-DAL-001, 002, …
The run's length is the zero-padding; a longer number is never truncated.
Names are start + i for i in 0 … count-1. The portal mirrors this rule and
every sentence below in portal/src/lib/namingConvention.ts — change both."""

import re
from dataclasses import dataclass

X_RUN = re.compile(r"[xX]+")
CRATE_MAX = 500
TRUCK_MAX = 100


class NamingError(Exception):
    """A convention, count or start the rule rejects; `message` is the
    sentence shown to the user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Convention:
    prefix: str
    width: int
    suffix: str


def parse_convention(text: str) -> Convention:
    value = (text or "").strip()
    if not value:
        raise NamingError("convention_required", "Enter a naming convention, like CRT-xxx.")
    runs = list(X_RUN.finditer(value))
    if not runs:
        raise NamingError("no_number", "Mark the number with a run of x's, like CRT-xxx.")
    if len(runs) > 1:
        raise NamingError("many_numbers", "Use only one run of x's for the number.")
    run = runs[0]
    return Convention(prefix=value[:run.start()], width=run.end() - run.start(),
                      suffix=value[run.end():])


def generate_names(convention: str, count: int, start: int, *, max_count: int) -> list[str]:
    """Every name the batch would create, in creation order. Checks the
    convention first, then the count, then the start."""
    rule = parse_convention(convention)
    if count < 0 or count > max_count:
        raise NamingError("count_range", f"The count must be between 0 and {max_count}.")
    if start < 0:
        raise NamingError("start_negative", "The start number can't be below 0.")
    return [f"{rule.prefix}{str(start + i).zfill(rule.width)}{rule.suffix}"
            for i in range(count)]


def clash_sentence(noun: str, names: list[str], limit: int = 10) -> str:
    shown = ", ".join(names[:limit])
    more = f", and {len(names) - limit} more" if len(names) > limit else ""
    return f"These {noun} names already exist: {shown}{more}."
