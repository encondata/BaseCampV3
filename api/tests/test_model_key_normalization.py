"""normalize_model_key: the lookup key used to match an imported
make/model string against the catalog (exact rows and aliases). Keeps
every word — "(Chassis)" and "(Node)" distinguish real rows — and only
removes the noise that creates accidental duplicates."""

from serversherpa.db.models import AssetModel
from serversherpa.imports.move_assets import normalize_model_key, parse_row, run_import
from serversherpa.imports.parsing import CANONICAL

from .test_move_asset_import_commit import _move


def test_normalizes_underscores_parens_height_whitespace_and_case():
    assert normalize_model_key("DellEMC_Isilon H5600 Storage (Node)") == "dellemc isilon h5600 storage node"
    assert normalize_model_key("DellEMC Isilon H5600 (Chassis)") == "dellemc isilon h5600 chassis"
    assert normalize_model_key("Netapp AFF A900 (Chassis) 8U") == "netapp aff a900 chassis"
    assert normalize_model_key('EMC 25x2.5" Disk Array Enclosure 2U') == 'emc 25x2.5" disk array enclosure'
    assert normalize_model_key("  Dell   R740 ") == "dell r740"
    assert normalize_model_key("Dell R740") == normalize_model_key("dell r740")


def test_chassis_and_node_variants_stay_distinct():
    assert normalize_model_key("X H5600 (Chassis)") != normalize_model_key("X H5600 (Node)")


def test_a_height_token_is_only_stripped_at_the_end():
    assert normalize_model_key("2U Shelf Kit") == "2u shelf kit"


async def test_import_matches_an_underscore_and_parenthesis_variant(db):
    ini = await _move(db)
    db.add(AssetModel(make="DellEMC", model="Isilon H5600 (Chassis)", ru_size=4))
    await db.commit()
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="CH-1", asset_make="DellEMC_Isilon",
                     asset_model="H5600 Chassis 4U",
                     destination_rack="R1", destination_ru="10")
    row = parse_row(2, canonical, {}, generate_serials=False)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy", write=True)
    detail = result["details"][0]
    assert detail["match_method"] == "exact", detail
    assert result["summary"].get("models_created", 0) == 0
