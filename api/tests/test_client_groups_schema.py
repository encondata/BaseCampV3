import pytest
from sqlalchemy import Text, cast, literal, select
from sqlalchemy.exc import IntegrityError

from serversherpa.clientgroups.keys import group_key, is_blank_sql, owner_key_sql
from serversherpa.db.models import (
    Asset,
    Client,
    ClientGroup,
    Initiative,
    InitiativeAsset,
    Person,
    PersonRole,
    Role,
    asset_owner_current,
)


async def test_group_key_rules(db):
    assert group_key("  Platform   Team ") == "platform team"
    assert group_key(None) == ""
    assert group_key("   ") == ""
    got = await db.scalar(select(owner_key_sql(literal("  PLAT  form "))))
    assert got == "plat form"


async def test_individual_role_exists(db):
    role = await db.get(Role, "client_individual")
    assert role is not None and role.rank == 8 and role.scope_anchor == "client"
    assert role.color == "c-blue" and role.is_system is True
    c = Client(name="Acme")
    p = Person(first_name="I", last_name="Ndividual")
    db.add_all([c, p])
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="client_individual", client_id=c.id))
    await db.commit()


async def test_group_name_unique_per_client(db):
    a, b = Client(name="A"), Client(name="B")
    db.add_all([a, b])
    await db.flush()
    a_id, b_id = a.id, b.id
    db.add(ClientGroup(client_id=a_id, name="Team", name_key="team"))
    await db.commit()
    db.add(ClientGroup(client_id=a_id, name="TEAM", name_key="team"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(ClientGroup(client_id=b_id, name="Team", name_key="team"))
    await db.commit()


async def test_asset_owner_current_picks_newest_row(db):
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    c_id = c.id
    i1 = Initiative(name="Move 1", initiative_type="move", client_id=c.id)
    i2 = Initiative(name="Move 2", initiative_type="move", client_id=c.id)
    asset = Asset(serial_number="SN1", client_id=c.id)
    db.add_all([i1, i2, asset])
    await db.flush()
    asset_id = asset.id
    db.add(InitiativeAsset(initiative_id=i1.id, asset_id=asset_id, owner="A"))
    # now() is fixed per transaction: commit so B gets a later created_at
    await db.commit()
    db.add(InitiativeAsset(initiative_id=i2.id, asset_id=asset_id, owner="B"))
    await db.commit()
    rows = (await db.execute(select(asset_owner_current).where(
        asset_owner_current.c.asset_id == asset_id))).all()
    assert len(rows) == 1
    assert rows[0].owner == "B" and rows[0].client_id == c_id


@pytest.mark.parametrize("value", [
    "\tTeam\n", "  Platform   Team ", "A\tB", "   ", "\n", "", "Plain", "A \n\t B"])
async def test_python_and_sql_keys_agree(db, value):
    assert await db.scalar(select(owner_key_sql(literal(value)))) == group_key(value)


async def test_is_blank_sql(db):
    for value, blank in [(None, True), ("", True), ("  ", True), ("\t\n", True), ("x", False)]:
        got = await db.scalar(select(is_blank_sql(cast(literal(value), Text))))
        assert got is blank, value
