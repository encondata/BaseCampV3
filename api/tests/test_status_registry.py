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
        "initiative_work_type", "shipping_type"}


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


def test_container_type_targets_the_containers_status_column():
    container = STATUS_REGISTRY["container"]
    assert (container.table, container.column, container.resource) == (
        "containers", "status", "containers")


def test_container_type_type_targets_the_containers_container_type_column():
    container_type = STATUS_REGISTRY["container_type"]
    assert (container_type.table, container_type.column,
             container_type.resource) == ("containers", "container_type", "containers")
