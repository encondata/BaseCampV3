"""Checks on the short one-line text people type in: names.

One rule for every name that must stay on one line and fit in a Postgres
text column (which refuses NUL outright): the label library's image names
and the company name staff ID badges print (System settings › Branding).
"""

import re

# C0 control characters and DEL, tab and line breaks included
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def has_control_chars(text: str) -> bool:
    """Whether `text` holds a control character (CONTROL_CHARS)."""
    return CONTROL_CHARS.search(text) is not None
