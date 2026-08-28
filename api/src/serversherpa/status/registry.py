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
    # the (table, column) pairs carrying this entity's status — usage
    # counting sums across all of them (asset spans two tables since the
    # 0022 vocabulary merge)
    sources: tuple[tuple[str, str], ...]
    # the resource whose "view" permission gates reading these values
    resource: str
    # True when the columns are text[] — usage counting must unnest
    array: bool = False


STATUS_RECORD_TYPES: list[StatusRecordType] = [
    StatusRecordType("site", "Site",
                     sources=(("sites", "status"),), resource="sites"),
    StatusRecordType("worker", "Worker",
                     sources=(("worker_profiles", "status"),),
                     resource="workers"),
    StatusRecordType("asset", "Asset",
                     sources=(("assets", "status"),
                              ("initiative_assets", "status"),
                              ("raw_scans", "status"),
                              ("processed_scans", "status")),
                     resource="assets"),
    StatusRecordType("container", "Container",
                     sources=(("containers", "status"),),
                     resource="containers"),
    StatusRecordType("container_type", "Container type",
                     sources=(("containers", "container_type"),),
                     resource="containers"),
    StatusRecordType("initiative", "Initiative",
                     sources=(("initiatives", "status"),),
                     resource="initiatives"),
    StatusRecordType("initiative_type", "Initiative type",
                     sources=(("initiatives", "initiative_type"),),
                     resource="initiatives"),
    StatusRecordType("initiative_sub_type", "Initiative sub-type",
                     sources=(("initiatives", "sub_type"),),
                     resource="initiatives"),
    StatusRecordType("initiative_work_type", "Initiative work type",
                     sources=(("initiative_people", "work_type"),),
                     resource="initiatives"),
    StatusRecordType("shipping_type", "Shipping type",
                     sources=(("initiatives", "shipping_types"),),
                     resource="initiatives", array=True),
    StatusRecordType("partner_type", "Partner type",
                     sources=(("partners", "partner_types"),),
                     resource="partners", array=True),
    StatusRecordType("scan", "Scan method",
                     sources=(("raw_scans", "scan_type"),
                              ("processed_scans", "scan_type")),
                     resource="scans"),
    StatusRecordType("processed_scan", "Scan match",
                     sources=(("processed_scans", "match_type"),),
                     resource="scans"),
    StatusRecordType("time_entry", "Time entry",
                     sources=(("time_entries", "status"),), resource="time"),
]

STATUS_REGISTRY: dict[str, StatusRecordType] = {
    rt.id: rt for rt in STATUS_RECORD_TYPES}
