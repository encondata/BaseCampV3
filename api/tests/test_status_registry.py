"""The record-type registry is code, not data — a record_type only means
something if code reads statuses for that entity. Mirrors test_access_registry."""

from serversherpa.access.resources import REGISTRY as RESOURCE_REGISTRY
from serversherpa.status.registry import STATUS_RECORD_TYPES, STATUS_REGISTRY


def test_registry_is_keyed_by_id():
    assert set(STATUS_REGISTRY) == {rt.id for rt in STATUS_RECORD_TYPES}


def test_launch_types_are_site_worker_asset_and_container():
    assert set(STATUS_REGISTRY) == {
        "site", "worker", "asset", "container", "container_type",
        "initiative", "initiative_type", "initiative_sub_type",
        "initiative_work_type", "shipping_type", "partner_type",
        "scan", "processed_scan"}


def test_every_record_type_points_at_a_real_resource():
    for rt in STATUS_RECORD_TYPES:
        assert rt.resource in RESOURCE_REGISTRY, rt.id


def test_site_type_targets_the_sites_status_column():
    site = STATUS_REGISTRY["site"]
    assert site.sources == (("sites", "status"),)
    assert site.resource == "sites"


def test_worker_type_targets_the_worker_profiles_status_column():
    worker = STATUS_REGISTRY["worker"]
    assert worker.sources == (("worker_profiles", "status"),)
    assert worker.resource == "workers"


def test_container_type_targets_the_containers_status_column():
    container = STATUS_REGISTRY["container"]
    assert container.sources == (("containers", "status"),)
    assert container.resource == "containers"


def test_container_type_type_targets_the_containers_container_type_column():
    container_type = STATUS_REGISTRY["container_type"]
    assert container_type.sources == (("containers", "container_type"),)
    assert container_type.resource == "containers"


def test_asset_type_counts_all_status_sources():
    """The merged vocabulary is referenced from four tables — usage counts
    must span assets, initiative_assets, and both scans tables' status."""
    asset = STATUS_REGISTRY["asset"]
    assert asset.sources == (("assets", "status"),
                             ("initiative_assets", "status"),
                             ("raw_scans", "status"),
                             ("processed_scans", "status"))
    assert asset.resource == "assets"
