# Pod # on assets and move rosters — design

**Source:** Mark's "Capture Pod #" row on the parity sheet's Future Features tab.
Nap 9 has no pod numbers; Nap 14 does. Moving devices between Naps in Las Vegas
means the source pod and destination pod differ, so the roster row needs both.

**Decision (Jimmy, 2026-09-21):** two columns on the move roster,
`source_pod` and `destination_pod`; one column on the asset, `pod_number`,
meaning where the asset sits today.

## Terminology

There is no `move_assets` table. The per-move roster is `initiative_assets`
(ORM `InitiativeAsset`). "Roster row" below means one of those.

## Data

Migration `0069_pod_number` (revises 0068), plain `add_column`, no backfill:

| Table | Column | Type | Meaning |
|---|---|---|---|
| `assets` | `pod_number` | text, nullable | The pod the asset is in now. |
| `initiative_assets` | `source_pod` | text, nullable | Pod the asset leaves from on this move. |
| `initiative_assets` | `destination_pod` | text, nullable | Pod the asset lands in on this move. |

Downgrade drops the three columns. Free text, no format check: pod labels
vary by site ("14", "P-07", "Pod 3").

## API

- `AssetItem`, `AssetCreateIn`, `AssetUpdateIn`: `pod_number: str | None`.
  `ASSET_FIELDS` and `_item()` in `routes/assets.py` carry it, so create/patch
  and the audit snapshot work with no other route code.
- `InitiativeAssetSummary`: `pod_number` (the embedded asset's current pod).
- `InitiativeAssetOut`, `InitiativeAssetUpdateIn`: `source_pod`, `destination_pod`.
- `NULLABLE_TEXT_ASSET_FIELDS` in `routes/initiatives.py` gains both roster
  fields so a PATCH of `""` clears them, as it does for `owner`.
- `_initiative_asset_rows()` copies all three onto the outgoing rows.

## From-To import

`imports/parsing.py`:

- `CANONICAL` gains `source_pod` and `destination_pod`.
- `HEADER_MAP` aliases (all lower-case, matched case-insensitively):
  `source pod`, `source pod #`, `source pod number` → `source_pod`;
  `destination pod`, `destination pod #`, `destination pod number` →
  `destination_pod`; and the bare V2-style `pod`, `pod #`, `pod number` →
  `source_pod` (a sheet with one pod column is describing where the gear is).
- `TEMPLATE_HEADERS` gains `Source Pod` immediately before `Source Rack` and
  `Destination Pod` immediately before `Destination Rack` (the pod contains the
  rack). `SAMPLE_ROWS` gain both keys: `"14"` and `"9"` on the first row, blank
  on the second. The CSV and xlsx template builders derive from these lists.

`imports/move_assets.py`:

- `parse_row` emits `"source_pod"` and `"destination_pod"` (stripped, blank →
  `None`), exactly like `owner`.
- `_apply_row` writes both onto the roster row.
- Asset side: when the importer creates an asset, `pod_number` is set from the
  row's `source_pod`. When the row matches an existing asset and `source_pod`
  is present, `pod_number` is overwritten (the import states where the asset is
  today, the same rule the importer already applies to `rfid_tag`). A blank
  `source_pod` never clears an existing `pod_number`.
- `destination_pod` is never written to the asset by the importer. Rolling the
  destination pod onto the asset when a move completes is out of scope (no
  existing field does that today).

## Portal

Labels use "Pod #" in the UI. Column keys are `pod` (assets list),
`source_pod`, `destination_pod`, and `pod_number` (roster: the asset's current
pod, next to the existing asset-derived `location`/`rfid_tag` columns).

**Types** (`lib/api.ts`): `AssetItem.pod_number`, `InitiativeAssetSummary.pod_number`,
`InitiativeAssetRow.source_pod`, `InitiativeAssetRow.destination_pod`, all
required `string | null` like their neighbors. Every test fixture that builds a
full object of these types gains the new keys (tsc finds them).

**Assets list** (`pages/Assets.tsx`, `lib/assets.ts`): four lists updated in
lockstep: `COLUMNS` (`{ key: 'pod', label: 'Pod #', width: '0.7fr', default: false }`
after `location`), `sortValueFor`, `assetCellText`, `CSV_COLUMNS` (`Pod #`
after `Location`), plus the `cellFor` renderer (mono span, `—` when blank).
Form: `AssetFormState.pod_number`, `formFromAsset`, `assetPayload` (`put`), an
input labeled "Pod #" after "Location detail" in `AssetEditModal`. God edit:
`ASSET_GOD_FIELDS` text entry on column `pod`. Detail page: `Pod #` row after
`RFID tag` in the Identity list.

**Move roster** (`lib/initiatives.ts`, `InitiativeDetail`, `AssetEditDialog`,
`MoveAssetDetail`): `MOVE_ASSET_COLUMNS` gains `source_pod` ("Source Pod")
after `source_position`, `destination_pod` ("Destination Pod") after
`destination_position`, and `pod_number` ("Pod #") after `location`, all
`default: false`. `moveAssetCellText` returns each with the `—` blank marker.
`MOVE_ASSET_EDIT_FIELDS` gains text entries for the two roster fields. The
edit dialog's Source & destination grid gains a "Pod" pair as its first row
(source left, destination right), sent as `source_pod`/`destination_pod` with
`|| null`. The move-asset detail Placement list shows "Source pod" first and
"Destination pod" before "Destination rack". CSV export, sort, and the column
picker on Full Details derive from `MOVE_ASSET_COLUMNS`, so they need no edit.

Column visibility is a server-side user preference keyed by page; a new key
surfaces in the picker automatically.

## Out of scope

Kiosk (shows no roster text fields), the Move Report and rack drawings, the
scan-history export, search indexing, and any pod format validation.

## Testing

- API: migration applies in the suite (`SS_TEST_DB=serversherpa_test_podnumber`);
  parsing tests for the aliases and template headers; `parse_row`/`_apply_row`
  round trip; commit test for asset `pod_number` on create, overwrite, and
  blank-preserves; assets API create/patch/clear; roster PATCH set and `""`
  clear.
- Portal: `assetCellText`, `moveAssetCellText`, form round trip, dialog payload;
  whole suite plus `tsc --noEmit`.
- Live: template download shows the new headers; import a two-row CSV with pods
  onto a dev move; toggle the columns on Full Details and Assets.
