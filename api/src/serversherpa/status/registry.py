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
    # True when column is text[] — usage counting must unnest
    array: bool = False


STATUS_RECORD_TYPES: list[StatusRecordType] = [
    StatusRecordType("site", "Site", table="sites",
                     column="status", resource="sites"),
    StatusRecordType("worker", "Worker", table="worker_profiles",
                     column="status", resource="workers"),
    StatusRecordType("asset", "Asset", table="assets",
                     column="status", resource="assets"),
    StatusRecordType("container", "Container", table="containers",
                     column="status", resource="containers"),
    StatusRecordType("container_type", "Container type", table="containers",
                     column="container_type", resource="containers"),
    StatusRecordType("initiative", "Initiative", table="initiatives",
                     column="status", resource="initiatives"),
    StatusRecordType("initiative_type", "Initiative type", table="initiatives",
                     column="initiative_type", resource="initiatives"),
    StatusRecordType("initiative_sub_type", "Initiative sub-type",
                     table="initiatives", column="sub_type",
                     resource="initiatives"),
    StatusRecordType("initiative_work_type", "Initiative work type",
                     table="initiative_people", column="work_type",
                     resource="initiatives"),
    StatusRecordType("shipping_type", "Shipping type", table="initiatives",
                     column="shipping_types", resource="initiatives",
                     array=True),
]

STATUS_REGISTRY: dict[str, StatusRecordType] = {
    rt.id: rt for rt in STATUS_RECORD_TYPES}
