"""Shared seed helpers for the client groups tests."""
from types import SimpleNamespace

from serversherpa.clientgroups.keys import group_key
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Asset, Client, ClientContactGroup, ClientGroup, Initiative, InitiativeAsset,
    Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password

from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _move(db, client, name):
    ini = Initiative(name=name, initiative_type="move", sub_type="migration",
                     client_id=client.id)
    db.add(ini)
    await db.flush()
    return ini


async def _asset(db, client, serial, owner, move):
    asset = Asset(name=serial, serial_number=serial, client_id=client.id)
    db.add(asset)
    await db.flush()
    row = InitiativeAsset(initiative_id=move.id, asset_id=asset.id, owner=owner)
    db.add(row)
    await db.flush()
    return asset


async def seed_grouped_client(db) -> SimpleNamespace:
    """A client with groups Platform and Storage and a move whose four roster
    owners are "Platform", "storage ", blank and "Platfrom". The rows start
    unmatched (call rematch_client). `other_client` has its own move with one
    "Platform" row and no groups."""
    client = Client(name="Acme")
    other = Client(name="Bravo")
    db.add_all([client, other])
    await db.flush()
    groups = {}
    for name in ("Platform", "Storage"):
        g = ClientGroup(client_id=client.id, name=name, name_key=group_key(name))
        db.add(g)
        groups[name] = g
    await db.flush()
    move = await _move(db, client, "Acme move")
    assets = [await _asset(db, client, f"sn-{i}", owner, move)
              for i, owner in enumerate(["Platform", "storage ", "", "Platfrom"])]
    other_move = await _move(db, other, "Bravo move")
    other_asset = await _asset(db, other, "sn-other", "Platform", other_move)
    await db.commit()
    return SimpleNamespace(client=client, groups=groups, move=move, assets=assets,
                           other_client=other, other_move=other_move,
                           other_assets=[other_asset])


async def client_user(db, api, client_id, tier: str, group_ids=(),
                      email="cg-user@test.example.com") -> dict:
    """A client-anchored login of the given role, limited to `group_ids`."""
    p = Person(first_name="Cli", last_name="Ent", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=tier, client_id=client_id))
    for gid in group_ids:
        db.add(ClientContactGroup(person_id=p.id, client_id=client_id, group_id=gid))
    await db.commit()
    return await login(api, email=email)
