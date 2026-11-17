"""Continue/Skip choices for serials a From-To check flagged as another
client's (SS-526, SS-527), shared by the import commit and the wizard.

Staff send {serial: "continue"|"skip"}; the server stores each choice with
the client that owned the serial at the check:

    {serial_lower: {"choice": "continue"|"skip", "from_client_id": "<uuid>"}}

run_import applies a Continue only while the asset still belongs to that
client; if it has changed hands since (or no owner was recorded), the row is
skipped — fail safe."""

from collections.abc import Iterable, Mapping

CHOICES = ("continue", "skip")


class ChoiceError(Exception):
    """A request's choices are not acceptable; `code` is the API error code."""

    def __init__(self, code: str, serials: list[str] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.serials = serials


def flagged_owners(details: Iterable[dict] | None) -> dict[str, str | None]:
    """Each distinct serial the check flagged (lower-cased) → the id of the
    client that owned it at the check."""
    out: dict[str, str | None] = {}
    for d in details or []:
        if d.get("status") != "conflict" or not d.get("serial_number"):
            continue
        out.setdefault(d["serial_number"], (d.get("current_client") or {}).get("id"))
    return out


def stored_choices(requested: Mapping[str, str] | None,
                   details: Iterable[dict] | None) -> dict[str, dict]:
    """The map to store for a request: one entry per flagged serial, carrying
    the owner the check saw. Raises ChoiceError for a bad value
    (invalid_client_choice) or a flagged serial with no choice
    (client_choices_required, naming the serials)."""
    choices: dict[str, str] = {}
    for serial, value in (requested or {}).items():
        if value not in CHOICES:
            raise ChoiceError("invalid_client_choice")
        choices[str(serial).strip().lower()] = value
    owners = flagged_owners(details)
    if missing := sorted(owners.keys() - choices.keys()):
        raise ChoiceError("client_choices_required", missing)
    return {s: {"choice": choices[s], "from_client_id": owners[s]}
            for s in sorted(owners)}


def choice_of(stored: object) -> tuple[str | None, str | None]:
    """(choice, from_client_id) for one stored entry. A bare string (never
    stored by the API) has no owner, so a Continue in it never applies."""
    if isinstance(stored, Mapping):
        return stored.get("choice"), stored.get("from_client_id")
    return (stored if isinstance(stored, str) else None), None
