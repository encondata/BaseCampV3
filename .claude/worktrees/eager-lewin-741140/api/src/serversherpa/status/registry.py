"""Status record types — the code-side list of entities that carry a status
vocabulary. Deploys introduce record types; the DB stores only the values.

Shaped after access/resources.py deliberately: a record_type is not data. A
row saying record_type='invoice' is inert until an invoices feature ships,
and that feature ships as a deploy anyway."""

from dataclasses import dataclass


@dataclass(frozen=True)
class StatusRecordType:
    id: str
    label: str
    # the table/column carrying this entity's status — used to count usage
    table: str
    column: str
    # the resource whose "view" permission gates reading these values
    resource: str


STATUS_RECORD_TYPES: list[StatusRecordType] = [
    StatusRecordType("site", "Site", table="sites",
                     column="status", resource="sites"),
    StatusRecordType("worker", "Worker", table="worker_profiles",
                     column="status", resource="workers"),
]

STATUS_REGISTRY: dict[str, StatusRecordType] = {
    rt.id: rt for rt in STATUS_RECORD_TYPES}
