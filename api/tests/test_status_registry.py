"""The record-type registry is code, not data — a record_type only means
something if code reads statuses for that entity. Mirrors test_access_registry."""

from serversherpa.access.resources import REGISTRY as RESOURCE_REGISTRY
from serversherpa.status.registry import STATUS_RECORD_TYPES, STATUS_REGISTRY


def test_registry_is_keyed_by_id():
    assert set(STATUS_REGISTRY) == {rt.id for rt in STATUS_RECORD_TYPES}


def test_launch_types_are_site_worker_and_asset():
    assert set(STATUS_REGISTRY) == {"site", "worker", "asset"}


def test_every_record_type_points_at_a_real_resource():
    for rt in STATUS_RECORD_TYPES:
        assert rt.resource in RESOURCE_REGISTRY, rt.id


def test_site_type_targets_the_sites_status_column():
    site = STATUS_REGISTRY["site"]
    assert (site.table, site.column, site.resource) == ("sites", "status", "sites")


def test_worker_type_targets_the_worker_profiles_status_column():
    worker = STATUS_REGISTRY["worker"]
    assert (worker.table, worker.column, worker.resource) == (
        "worker_profiles", "status", "workers")


def test_asset_type_targets_the_assets_status_column():
    asset = STATUS_REGISTRY["asset"]
    assert (asset.table, asset.column, asset.resource) == (
        "assets", "status", "assets")
