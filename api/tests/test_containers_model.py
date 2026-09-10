# api/tests/test_containers_model.py
"""Containers schema — defaults, constraints, vocabulary seeds, registry."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, Container, ContainerAsset, StatusValue,
)


async def test_container_defaults(db):
    c = Container(name="Crate 1")
    db.add(c)
    await db.commit()
    assert c.id is not None
    assert c.status == "available"
    assert c.location_detail == ""
    assert c.source == "manual"
    assert c.archived_at is None


async def test_vocabulary_seeds(db):
    statuses = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "container"))}
    assert statuses == {"available", "packed", "in_transit", "historical"}
    types = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "container_type"))}
    assert types == {"pelican_case", "shipping_container", "cart",
                     "pallet", "crate", "d_container"}


async def test_unknown_status_rejected_by_fk(db):
    db.add(Container(name="Bad", status="nope"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_one_container_per_asset(db):
    a = Asset(name="asset-1")
    c1, c2 = Container(name="C1"), Container(name="C2")
    db.add_all([a, c1, c2])
    await db.flush()
    db.add(ContainerAsset(container_id=c1.id, asset_id=a.id))
    await db.commit()
    db.add(ContainerAsset(container_id=c2.id, asset_id=a.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_registry_shape():
    from serversherpa.access.resources import REGISTRY
    from serversherpa.status.registry import STATUS_REGISTRY

    assert REGISTRY["containers"].visible_to == frozenset({"global"})
    assert "/logistics/containers" in REGISTRY["containers"].routes
    assert STATUS_REGISTRY["container"].sources == (("containers", "status"),)
    assert STATUS_REGISTRY["container_type"].sources == (
        ("containers", "container_type"),)
    assert STATUS_REGISTRY["container"].resource == "containers"
