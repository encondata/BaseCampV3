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


async def test_a_literal_name_wins_over_an_ambiguous_normalized_key(db):
    """"Panel 1U" and "Panel 2U" both normalize to "blank panel", so the
    normalized tier holds neither — but the row names "Blank Panel 2U"
    verbatim, and a literal catalog name always matches."""
    ini = await _move(db)
    db.add(AssetModel(make="Blank", model="Panel 1U", ru_size=1))
    db.add(AssetModel(make="Blank", model="Panel 2U", ru_size=2))
    await db.commit()
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="BP-1", asset_make="Blank",
                     asset_model="Panel 2U",
                     destination_rack="R1", destination_ru="10")
    row = parse_row(2, canonical, {}, generate_serials=False)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy", write=True)
    detail = result["details"][0]
    assert detail["match_method"] == "exact", detail
    assert result["summary"].get("models_created", 0) == 0


async def test_a_non_literal_row_on_an_ambiguous_key_goes_to_review(db):
    """"Blank_Panel 2U" names no catalog row literally, and normalizing
    it lands on the ambiguous "blank panel". Picking one of the two
    panels would be a coin flip, so the row is reviewed."""
    ini = await _move(db)
    db.add(AssetModel(make="Blank", model="Panel 1U", ru_size=1))
    db.add(AssetModel(make="Blank", model="Panel 2U", ru_size=2))
    await db.commit()
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="BP-2", asset_make="",
                     asset_model="Blank_Panel 2U",
                     destination_rack="R1", destination_ru="10")
    row = parse_row(2, canonical, {}, generate_serials=False)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy", write=True)
    detail = result["details"][0]
    assert detail["match_method"] == "review", detail
    assert result["summary"].get("models_created", 0) == 0


async def test_an_unambiguous_key_still_matches_exactly(db):
    """The collision guard drops only the ambiguous keys; a neighboring
    row with a key of its own still matches."""
    ini = await _move(db)
    db.add(AssetModel(make="Blank", model="Panel 1U", ru_size=1))
    db.add(AssetModel(make="Blank", model="Panel 2U", ru_size=2))
    db.add(AssetModel(make="Dell", model="R740", ru_size=2))
    await db.commit()
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="SRV-1", asset_make="Dell",
                     asset_model="R740",
                     destination_rack="R1", destination_ru="10")
    row = parse_row(2, canonical, {}, generate_serials=False)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy", write=True)
    detail = result["details"][0]
    assert detail["match_method"] == "exact", detail
    assert result["summary"].get("models_created", 0) == 0
