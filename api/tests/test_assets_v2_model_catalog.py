"""V2 full make/model catalog import: field mapping, provenance note,
duplicate merging, alias attachment, and idempotent re-runs. Fixture rows
are verbatim from backup_20260825_193157.sql."""

from sqlalchemy import select

from serversherpa.assets.v2_import import import_model_catalog
from serversherpa.db.models import AssetModel, AssetModelAlias

FIXTURE = """
INSERT INTO assets_make_model (id, make, model, weight, ru_size, dimensions, mount_type, rail_type, knowledge, device_catagory) VALUES (42, 'Dell', 'R750XA', '95 lbs', '2U', '17.08" x 3.4" x 35.3"', 'rails', 'B19/B17', '', 'Server');
INSERT INTO assets_make_model (id, make, model, weight, ru_size, dimensions, mount_type, rail_type, knowledge, device_catagory) VALUES (478, 'Broadcom', 'Accton-AS7726-32X', '', '', '', '', '', '', '');
INSERT INTO assets_make_model (id, make, model, weight, ru_size, dimensions, mount_type, rail_type, knowledge, device_catagory) VALUES (166, 'IBM', 'Power S824 (8286-42A)', '43.8 kg (97 lbs)', '4U', '443x756x173 mm (17.5x29.8x6.9 in)', 'Rack', 'Standard 19-inch rack mount', '', 'Server');
INSERT INTO assets_make_model (id, make, model, weight, ru_size, dimensions, mount_type, rail_type, knowledge, device_catagory) VALUES (447, 'SuperMicro_1019P', 'FDN2T-1W-DN008', NULL, NULL, NULL, NULL, NULL, 'FORCED: hybrid mode creation (fuzzy match not found) for move F-T', NULL);
INSERT INTO assets_make_model (id, make, model, weight, ru_size, dimensions, mount_type, rail_type, knowledge, device_catagory) VALUES (448, 'SuperMicro_1019P', 'FDN2T-1W-DN008', NULL, NULL, NULL, NULL, NULL, 'FORCED: hybrid mode creation (fuzzy match not found) for move F-T', NULL);
INSERT INTO assets_make_model_fuzzy (id, assets_make_model_id, fuzzy_lookup_value) VALUES (1, 42, 'Dell PowerEdge R750XA');
INSERT INTO assets_make_model_fuzzy (id, assets_make_model_id, fuzzy_lookup_value) VALUES (2, 448, 'SuperMicro 1019P-FDN2T');
INSERT INTO assets_make_model_fuzzy (id, assets_make_model_id, fuzzy_lookup_value) VALUES (3, 42, 'DELL POWEREDGE R750XA');
"""


def _dump(tmp_path):
    p = tmp_path / "backup_v2_test.sql"
    p.write_text(FIXTURE)
    return str(p)


async def test_import_maps_fields_and_notes_provenance(db, tmp_path):
    stats = await import_model_catalog(db, _dump(tmp_path))
    await db.commit()

    assert stats["models_created"] == 4          # 5 rows, one dup pair
    assert stats["duplicates_merged"] == 1
    assert stats["aliases_created"] == 2         # case-insensitive dup skipped
    assert stats["aliases_skipped"] == 1

    models = {(m.make, m.model): m
              for m in await db.scalars(select(AssetModel))}
    dell = models[("Dell", "R750XA")]
    assert dell.legacy_id == 42
    assert float(dell.weight_lbs) == 95.0
    assert float(dell.weight_kg) == 43.09        # partner computed
    assert dell.ru_size == 2
    assert dell.category == "server"
    assert dell.mount_type == "rails"
    assert dell.rail_type == "B19/B17"
    assert "[imported from V2 backup_v2_test.sql on " in dell.knowledge

    ibm = models[("IBM", "Power S824 (8286-42A)")]
    assert float(ibm.weight_lbs) == 96.56        # '43.8 kg' converted
    assert ibm.mount_type == "custom"            # 'Rack' has no mapping
    assert "mount: Rack" in ibm.knowledge        # unparseable kept visible

    broadcom = models[("Broadcom", "Accton-AS7726-32X")]
    assert broadcom.weight_lbs is None and broadcom.ru_size is None

    supermicro = models[("SuperMicro_1019P", "FDN2T-1W-DN008")]
    assert supermicro.knowledge.startswith("FORCED: hybrid mode creation")

    aliases = {a.alias: a.model_id
               for a in await db.scalars(select(AssetModelAlias))}
    assert aliases["Dell PowerEdge R750XA"] == dell.id
    # alias on the duplicate legacy row lands on the merged model
    assert aliases["SuperMicro 1019P-FDN2T"] == supermicro.id


async def test_reimport_is_idempotent(db, tmp_path):
    path = _dump(tmp_path)
    await import_model_catalog(db, path)
    await db.commit()

    stats = await import_model_catalog(db, path)
    await db.commit()
    assert stats["models_created"] == 0
    assert stats["models_existing"] == 4
    assert stats["aliases_created"] == 0
    assert len(list(await db.scalars(select(AssetModel)))) == 4


async def test_existing_hand_entered_model_is_mapped_not_duplicated(
        db, tmp_path):
    db.add(AssetModel(make="dell", model="r750xa", knowledge="hand entered"))
    await db.commit()

    stats = await import_model_catalog(db, _dump(tmp_path))
    await db.commit()

    assert stats["models_created"] == 3          # Dell row mapped, not created
    dell = (await db.scalars(select(AssetModel).where(
        AssetModel.model == "R750XA"))).one()
    assert dell.knowledge == "hand entered"      # never mutated
    assert dell.legacy_id is None
    # its aliases still attach to the mapped row
    alias = (await db.scalars(select(AssetModelAlias).where(
        AssetModelAlias.alias == "Dell PowerEdge R750XA"))).one()
    assert alias.model_id == dell.id
