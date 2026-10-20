# Fact sheet — WYSIWYG label builder design conversation (BaseCampV3, 2026-10-19)

Paths: `api/…` = `/Users/jrh1812/Developer/BaseCampV3/api/src/serversherpa/…` unless it starts with `api/migrations` (= `/Users/jrh1812/Developer/BaseCampV3/api/migrations/versions/…`); `portal/…` = `/Users/jrh1812/Developer/BaseCampV3/portal/src/…`; V2 paths are under `/Users/jrh1812/Developer/BaseCampV2-reference/`. Dev-DB counts are read-only SELECTs taken by the readers on 2026-10-19.

---

## 1. Field catalog

**"On kiosk sync today" legend** (each value names the kiosk endpoint/field that carries the column; `—` = not sent anywhere):
- `A` = `/kiosk/sync/assets` `KioskAssetOut` field (`api/api/routes/kiosk.py:950-1023`, `api/api/schemas.py:3175-3211`); `A.label` = the per-asset `label` dict; `A.env` = `KioskAssetsSyncOut` envelope (`schemas.py:3224-3229`); `ctx` = `label_context` (`schemas.py:3213-3221`, `kiosk.py:1017-1023`).
- `C` = `/kiosk/sync/containers` `KioskContainerOut` (`kiosk.py:1067`, `1098-1125`; `schemas.py:3486-3508`).
- `T` = `/kiosk/sync/trucks` `KioskTruckOut` (`kiosk.py:2008`, `2043-2066`; `schemas.py:3651-3675`).
- `P` = `/kiosk/sync/people` `KioskPersonOut` (`kiosk.py:1026`, `1044-1062`; `schemas.py:3256-3268`).
- `CA` = `/kiosk/sync/client-assets` (`kiosk.py:1360`, `1392-1437`; `schemas.py:3232-3253`).
- The kiosk label dict is `placeholder_values(asset_row, initiative, sites, catalog_keys)` with **no generation_rules** (`kiosk.py:999`) and `catalog_keys` = active catalog **minus** `container_name`/`container_id` (`kiosk.py:898-908` `_label_catalog_keys`, `api/labels/generate/values.py:28` `CONTAINER_KEYS`) → **16 of the 18 active keys**; `label_tag` stays in the list and is always `""` on an asset row.

**"Placeholder today"** = the `label_placeholders` catalog key (18 active rows, identical to the scratchpad `label_placeholders.json`; `LabelPlaceholder` `api/db/models.py:1656-1669`; seeds `api/migrations/0042_labels.py:50-66`, `0066_container_zpl_templates.py:172-183`).

### 1a. Asset (the device itself) — `assets` / `class Asset` `api/db/models.py:775-802`

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Row id `assets.id` (uuid PK; the kiosk keys its cache/scans on it) | `a3f1…` | `A` (`id`) | — |
| Asset ID (human) `assets.legacy_id` — bigint NOT NULL UNIQUE, `nextval('asset_number_seq')`; V2 ids 38257-38484 kept, V3 rows start at 100000 (`models.py:794-796`, `api/migrations/0047_asset_numbers*.py:1-8`) | `100190` / `113840` / `38420` | `A` (`asset_id`, `legacy_id`) | `asset_id` |
| Asset name / hostname `assets.name` (citext NULL; From-To importer lowercases and falls back to the serial when blank: `api/imports/move_assets.py:116` `"asset_name": (name_raw or serial).lower()`) | `lvn-hm1w2-vc1-c1n7` / `INIT-ORD1-PRD-DB1360` / `atl1-sql-171` | `A` (`name`) | `asset_name` |
| Serial number `assets.serial_number` (citext NULL; importer lowercases, `move_assets.py:88`; `gnrtd-xxxxxx` when generated) | `36b7144` / `DEMO-05513BB4` / `n2j0w7b` | `A` (`serial_number`) | `serial_number` |
| RFID tag (EPC) `assets.rfid_tag` (citext NULL; every dev EPC is a 24-digit zero-padded string) | `000000000000000000700022` (asset `phx1-sw-022`) | `A` (`rfid`) | — |
| Pod number (today) `assets.pod_number` (text NULL, free text; migration 0069: "Nap 14 numbers its pods, Nap 9 does not") | `P4` / `P1` / NULL | — | — |
| Make/model link `assets.model_id → asset_models.id` (uuid FK NULL) | → Dell R660 | — (the FK itself is not sent; only the joined `make`/`model`/`make_model`, see 1b; `kiosk.py:982-983`, `1003`) | — (no key for the FK; `make`/`model`/`make_model` are computed from `asset_models`, see 1b) |
| Asset's client `assets.client_id → clients.name` (uuid FK NULL; separate from the move's client) | `Initech` / `Acme Widget` | — (drives the `CA` row selection, `kiosk.py:1411`, but is not emitted per row) | — |
| Asset's current site `assets.site_id → sites.name` | `INITECH-ORD1 - Initech Chicago DC` | — | — |
| Location detail (today) `assets.location_detail` (text NOT NULL default `''`) | `F01 U18` / `DFW1-F10 U27` / `''` | — | — |
| Asset status `assets.status` + `status_values.label` (record_type `asset`) | `racked` ('Racked') / `pre_stage` ('Pre-Stage') / `unknown` | — | — |
| Has rails `assets.has_rails` (boolean NULL) | `true` / NULL | — | — |
| Last seen `assets.last_seen_at` (timestamptz NULL) | `2026-10-05 20:18:21+00` | — | — |
| Last scan WHERE/by whom/at which checkpoint — latest `processed_scans` row per asset: `scanned_at, site_id → sites.name, location_detail, device_id, operator_id → people, status` (`models.py:1042-1047, 1053`; dev: 15,137 asset scans over 1,678 assets) | — | — | — |
| Asset notes `notes.body` (entity_type `asset`, visibility everyone/internal/admin; `models.py:1545-1551`) | — | — | — |
| Asset photo `attachments.storage_key / filename` (entity_type `asset`, kind `photo`; `models.py:361-377`, `api/api/routes/attachments.py:43, 48, 132`; 0 dev rows) | — | — | — |
| The OTHER move a client asset is on: `initiative_assets.initiative_id → initiatives.id/name` for the move's client's assets not on this move (`kiosk.py:1392-1403, 1430-1433`; `schemas.py:3232-3246`) | — | `CA` (`initiative_id`, `initiative_name`) | — |
| Bookkeeping `assets.source, source_ref, created_by, archived_at, created_at, updated_at, status_record_type (GENERATED)` | `source='manual'` | — | — |

### 1b. Model / specs — `asset_models` / `class AssetModel` `api/db/models.py:679-709` (joined by `_assets_body`, `kiosk.py:973-978`)

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Make `asset_models.make` (citext NOT NULL) | `Dell` / `HP` / `Pure` / `Cohesity` | `A` (`make`) | `make` |
| Model `asset_models.model` (citext NOT NULL) | `R660` / `DL560 G8` / `Storage FlashArray //X20 R3-Controller` | `A` (`model`) | `model` |
| Make + model (derived) `make_model_text(make, model)` (`api/labels/label_values.py:68-76`) | `Dell R660` / `Cohesity C5036 Node` | `A` (`make_model`, computed at `kiosk.py:998`) | `make_model` |
| Category `asset_models.category → asset_categories.key` + `asset_categories.label` (`models.py:668-676`; keys server, node 'Server Node', storage, network, power, other; dev models: NULL 226, server 153, other 23, network 10, storage 4 of 416) | `server` / `node` ('Server Node') / NULL | — | — |
| RU size `asset_models.ru_size` (integer NULL) | `1` / `2` / `4` | — | — |
| Weight `asset_models.weight_lbs / weight_kg` (numeric(8,2) pair, always written together, `api/assets/units.py`) | `45.00 lbs / 20.41 kg` | — | — |
| Dimensions `length_in, width_in, height_in / length_cm, width_cm, height_cm` (numeric(8,2) pairs; `width_in` is the RU-height axis in dev data, e.g. 1.70 for 1U) | `17.08 x 1.70 x 29.03 in` | — | — |
| Mount type `asset_models.mount_type` (text NULL) | `rails` / `custom` / NULL | — | — |
| Rail type `asset_models.rail_type` (text NULL) | `A15/A14/A16` / `B6/B4` / `HP Rail Kit 6` | — | — |
| Form factor `asset_models.form_factor` (text NULL: standalone / chassis / node; migration 0068, `models.py:701`; nodes sit at RU N.x) | `node` / `chassis` / NULL | — | — |
| Knowledge `asset_models.knowledge` (text NOT NULL default `''`; 407 of 416 dev rows are importer provenance, not printable notes) | `[imported from V2 backup_20260825_193157.sql on 2026-09-02]` / `FORCED: hybrid mode creation (fuzzy match not found) for move F-T` | — | — |
| Aliases `asset_model_aliases.alias` (citext) | alternate spellings | — | — |
| Bookkeeping `asset_models.id` (uuid PK, `models.py:685`), `private, spec_lookup_skip, specs_looked_up_at, review_dismissed_at, legacy_id, created_at, updated_at` | `private=false` | — | — |

### 1c. Move roster row (asset on this move) — `initiative_assets` / `class InitiativeAsset` `api/db/models.py:1378-1412`; columns `api/migrations/0019_initiative_assets.py:66-78`, `raw_ft`+`label_info` `0023_import_jobs.py:1-5, 24-25`, pods `0069_pod_number.py:1-10`; From-To meanings `api/imports/parsing.py:80-106` (`TEMPLATE_GUIDE`), header aliases `parsing.py:25-47` (`HEADER_MAP`)

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Priority / wave `initiative_assets.priority_wave` (varchar(30) NULL; importer truncates to `PRIORITY_MAX`, `move_assets.py:104-107`; "Move wave or priority, free text" `parsing.py:85`) | `1` / `Wave 1` / `Wave 4` | `A` (`priority_wave`) | — |
| Disposition `initiative_assets.disposition` (text NULL; "What happens to the asset (for example Relocate), free text" `parsing.py:86`) | `move` / `Relocate` / NULL | `A` (`disposition`) | — |
| Owner `initiative_assets.owner` (text NULL; "The team or customer that owns the asset, free text" `parsing.py:87`) | `Data Services` / `Finance IT` / `Network Ops` | — | — |
| Source pod `initiative_assets.source_pod` (text NULL; headers `Pod`, `Pod #`, `Pod number`, `Source Pod`, `Source Pod #`, `Source Pod Number` all map here, `parsing.py:31-33`) | `P4` / `P1` / NULL | `A` (`source_pod`) | — |
| Destination pod `initiative_assets.destination_pod` (text NULL; `parsing.py:36-38`) | `D4` / `D1` / NULL | `A` (`destination_pod`) | — |
| **Source rack `initiative_assets.source_rack`** (text NULL) — **the dotted location string lives HERE**; "Rack the asset sits in today" `parsing.py:89`; dev: 1,790 rows with exactly 4 dots (5 parts), 1,691 with none, 2 NULL; longest 31 chars `AN17 (Room=N (Singapore,SGD,3))` | `11.03.01B.01.03` / `09.01.05D.02.10` / `ORD1-F01` / `BJ14` | `A` (`source_rack`) | `source_raw` **only as fallback** (`source_position or source_rack`, `label_values.py:138`) |
| Source RU `initiative_assets.source_ru` (numeric NULL; dev 0.0-51.0; fractional allowed — 3.5, 5.4, 13.2, 33.2 = chassis node slots; "halves like 3.5 are allowed" `parsing.py:90`) | `17.0` / `18` / `3.5` / `33.2` | `A` (`source_ru` = `"17"`, `source_ru_raw` = `"17.0"`; `kiosk.py:938-947`) | `source_ru` (`"U17"` / `"U3.5"`) |
| Source position `initiative_assets.source_position` (text NULL; "Front or Rear today" `parsing.py:91`; **1 of 3,483 dev rows set**) | `Front` | `A` (`source_position`) | `source_raw` (**preferred over rack when set**, `label_values.py:138`) |
| Source verified `initiative_assets.source_verified` (boolean NULL) | `true` / `false` / NULL | — | — |
| **Destination rack `initiative_assets.destination_rack`** (text NULL; "Rack the asset moves to" `parsing.py:94`; dev: 1,800 with 4 dots, 1,497 with none, 186 NULL; longest 15 chars `14.03.02B.01.10`) | `14.01.06A.01.08` / `09.04.03C.01.01` / `AUS1-M06` / `DFW1-I06` | `A` (`destination_rack`) | `destination_raw` (fallback after `destination_position`, `label_values.py:139`) |
| Destination RU `initiative_assets.destination_ru` (numeric NULL; dev 1-51, fractional allowed; `parsing.py:95`) | `13.0` / `8` / `30` / `5.4` | `A` (`destination_ru` = `"13"`, `destination_ru_raw` = `"13.0"`) | `destination_ru` (`"U13"`) |
| Destination position `initiative_assets.destination_position` (text NULL; "Front or Rear after the move" `parsing.py:96`; 1 dev row set) | `Rear` | `A` (`destination_position`) | `destination_raw` (preferred over rack) |
| Destination verified `initiative_assets.destination_verified` (boolean NULL) | `true` / `false` / NULL | — | — |
| Cable info `initiative_assets.cable_info` (text NULL — **dual-shaped**: 1,489 dev rows free text (seeded) OR a JSON string `{"data_1".."data_6","mgmt_1","mgmt_2"}` written by the From-To importer, 33 rows; `move_assets.py:95-101`, `222-223`) | `2x 16G FC, 2x 10G` / `{"data_1": "lvn14-dctor-p39-0302br01c10sw01/01", "mgmt_1": "lvn14-dctor-p39-0302br01c10sw03/01"}` | — | — |
| Vendor involved `initiative_assets.vendor_involved` (boolean NULL; any non-blank "Vendor Involvement" cell → true, `move_assets.py:133`) | `false` (3,468) / `true` (15) | — | — |
| Raw From-To row `initiative_assets.raw_ft` (jsonb NULL; 1,994 of 3,483 dev rows; keys are the ORIGINAL spreadsheet headers verbatim — observed: Asset Make, Asset Model, Asset Name, Data 1-6, Destination Pod, Destination Pod Number, Destination Position, Destination RU, Destination Rack, Disposition, Mgmt 1, Mgmt 2, Notes, Owner, Pod #, Priority, RFID Tag, Serial Number, Source Pod, Source Position, Source RU, Source Rack, Vendor Involvement, Vendor Involvment; `move_assets.py:135, 226`; 0023:3-4 "nothing from an upload is dropped") | `{'Asset Name': 'nvlarch03-mgmt030', 'Source Rack': '09.01.05D.02.10', 'Source RU': '33.2', 'Destination Rack': '14.03.02B.01.10', 'Data 1': 'lvn14-dctor-p39-0302br01c10sw02/17', 'Priority': 'Wave 1', 'Disposition': 'Relocate', …}` | — | — |
| Label info `initiative_assets.label_info` (jsonb NULL; **0 dev rows, no writer anywhere in api/src** — 0023:5 "unused until label printing lands") | NULL | — | — |
| Roster status `initiative_assets.status` (text NOT NULL default `loaded_in_system`; `status_record_type` is `asset` on every dev row; labels from `status_values` record_type `asset`) | `loaded_in_system` ('Loaded') / `pre_stage` / `labeled` / `racked` / `rfid_1_cage_exit` ('RFID 1 - Cage Exit') | — | — |
| Container the asset is packed in (derived) `container_assets.container_id` (asset_id UNIQUE, `models.py:960-971`) → `containers.name / legacy_id` | `ATL1-W1M-DC-02` / `PHX1-W3M-DC-05` | `A` (`container_id` = **containers.id uuid**, `kiosk.py:1004`, `schemas.py:3195`) — the name is on `C` | `container_name` / `container_id` — portal generator: **always `""` on an asset row** (`label_values.py:159-162`); kiosk: **absent** (filtered by `CONTAINER_KEYS`). Note the catalog's `container_id` = `str(containers.legacy_id)` — same name as the kiosk uuid field, different value |
| Packed when / last validated `container_assets.added_at, last_validated_at` (`models.py:969-971`) | — | — | — |
| Truck carrying the asset (derived two-hop) `container_assets → truck_containers (models.py:876-883) → trucks` | `SEA1-T01 (Wave 1)` | — | — |
| Bookkeeping `initiative_assets.id, added_by, created_at, updated_at` | — | — (`initiative_id` rides only as `A.env.initiative_id`, `schemas.py:3225`; `asset_id` only as `A.id` = `assets.id`, `kiosk.py:1001`) | — |

### 1d. Move (initiative) — `initiatives` / `class Initiative` `api/db/models.py:1280-1340`; `LabelMove` built by `_move` `api/labels/generate/values.py:78-85`

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Move name `initiatives.name` (citext NOT NULL) | `Initech ORD1 to AUS1 Migration` / `NAP11 Hall Migration (demo)` / `Child Test Move 1` | `A.env` (`initiative_name`), `ctx` (`move_name`), `A.label` | `move_name` |
| Scheduled start = move date `initiatives.scheduled_start` (timestamptz NULL; read with `stored_day` = UTC date parts, `api/services/timezone.py:30-40`; dev values are 13:00 UTC or 05:00 UTC, none midnight — a local-evening value west of UTC would print the next day) | `2026-10-07 13:00+00` → `10/07/2026` / `07-OCT-2026` | `ctx` (`move_day`), `A.label` | `move_date`, `move_date_long` |
| Scheduled end `initiatives.scheduled_end` | `2026-10-16 23:00+00` | — | — |
| Real start / end `initiatives.real_start_at, real_end_at` | `2026-10-07 13:30+00` | — | — |
| Origin site `initiatives.origin_site_id → sites` | `INITECH-ORD1 - Initech Chicago DC` / `ACC4 - Digital Reality` | `ctx` (`source_site`, Site.name), `A.label` | `source_site` |
| Destination site `initiatives.destination_site_id → sites` | `INITECH-AUS1 - Initech Austin DC` / `DA11 - Equinix` | `ctx` (`destination_site`), `A.label` | `destination_site` |
| Move's client `initiatives.client_id → clients.name / code` | `Initech` / `INITECH` | `CA` envelope `client_id` (uuid only, `kiosk.py:1435-1437`, `schemas.py:3249-3253`); name/code not sent | — |
| Description `initiatives.description` | `Bring the Chicago colo home to Austin (4 waves).` | — | — |
| Type / sub-type / status `initiatives.initiative_type, sub_type, status` + `status_values.label` (`models.py:578-580, 1297-1300`; sub_type keys migration, decommission, deployment, maintenance, office_move, conference) | `move` / `migration` ('Migration') / `in_progress` ('In Progress') | — | — |
| Color `initiatives.color` (`#rrggbb`) | `#7c3aed` | — | — |
| Generic site / location text `initiatives.site_id → sites`; `initiatives.location` | `Las Vegas` | — | — |
| Priority devices / shipping types `initiatives.priority_devices; shipping_types` (boolean; text[]) | `true; ['truck']` | — | — |
| Partners on the move `initiatives.shipping_partner_id, origin_tech_partner_id, origin_cable_partner_id, origin_logistics_partner_id, destination_tech_partner_id, destination_cable_partner_id, destination_logistics_partner_id → partners.name` | dev `Las Vega 3 Cluster Move`: origin/destination tech + cable = `Hen-U`, origin/destination logistics = `Champagne Logistics` | — | — |
| Vendor involved per side `initiatives.origin_vendor_involved, destination_vendor_involved` (10 dev initiatives non-null; 5 moves `false`/`true`) | `false` / `true` | — | — |
| Parent move / program `initiative_links.parent_id → initiatives.name`, `role`, `sort_order` (`models.py:1360-1375`; dev `Parent Test Project` → `Child Test Move 1`, role `Move Phase 1`) | `Parent Test Project` | — | — |
| Sky Command project id `initiatives.sky_command_project_id` (none in dev) | NULL | — | — |
| People on the move `initiative_people.work_type, site_worked_id, rating → people` (`models.py:1343-1357`) | `tech — Paolo Abangan @ AMS - NorthC` | — | — |
| Never printable `initiatives.kiosk_password_enc, kiosk_password_fp, kiosk_person_id` | — | — | — |
| Bookkeeping `initiatives.id` (uuid PK `models.py:1287`), created/updated | — | `A.env`/`C`/`T` envelope `initiative_id` | — |

### 1e. Sites (origin, destination, asset's site, container's site, truck start/end) — `sites` / `class Site` `api/db/models.py:591-617`

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Site name `sites.name` (citext NOT NULL; 46 of 68 dev names start with a `WORD - ` prefix; only 17 have a prefix equal to `sites.code`) | `INITECH-ORD1 - Initech Chicago DC` / `DA11 - Equinix` (code NULL) / `Austin Office` | `ctx` (`source_site`, `destination_site`); `C` (`site_name`); `T` (`start_site_name`, `end_site_name`) | `source_site` / `destination_site` (origin + destination only; **the whole name string prints**) |
| Site code `sites.code` (citext NULL; set on only 23 of 68) | `INITECH-ORD1` / `ACME-DFW1` / `AUS` | — | — (catalog sample `NAP7` is this shape, but today's value prints the full name) |
| Site type `sites.site_type → site_types.key` + `site_types.label` (`models.py:562-563, 598`; keys colo, datacenter, client_office, office, warehouse, partner_office, other) | `colo` ('Colocation') / `client_office` ('Client Office') | — | — |
| Address `sites.address_line1, address_line2, city, region, postal_code, country` (country default `US`) | `350 E Cermak Rd, Chicago, IL 60616 US` | — | — |
| Coordinates `sites.latitude, longitude` (numeric(9,6)) | `33.425500, -111.940000` | — | — |
| Timezone `sites.timezone` (IANA) | `America/Chicago` | — | — |
| DC provider `sites.dc_provider` | `Equinix` / `Digital Realty` / `QTS` | — | — |
| Site survey answers `site_survey_data.field_key / value` (`models.py:650-665`; dev 32 rows, 15 keys: contact_name, contact_phone, contact_email, dock_available, dock_hours, dock_to_dc_distance_ft, elevator_available, entrance_details, floor, ground_level_entrance, security_details, security_clearance_required, trailer_75ft_accessible …) | `dock_hours = 07:00-17:00` | — | — |
| Clients served at the site `site_clients.client_id → clients.name` (`models.py:620-628`; dev 24 rows) | `Initech` | — | — |
| Partner / status / notes / bookkeeping `sites.partner_id → partners, status, notes, source, source_ref, created_by, archived_at, created_at, updated_at` | `status='active'` | — | — |
| `sites.id` (uuid PK `models.py:594`) | — | `C` (`site_id`); `T` (`start_site_id`, `end_site_id`) | — |

### 1f. Client / partner — `clients` + `OrgColumns` `api/db/models.py:156-186`; `partners` `models.py:189-217`

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Client name `clients.name` (citext NOT NULL; reachable via `initiatives.client_id`, `assets.client_id`, `site_clients`) | `Initech` / `Acme Widget` / `Planet Express` | — | — |
| Client code `clients.code` (citext NULL) | `INITECH` / `ACME` / `PLANETEX` | — | — |
| Tier / status / notes `clients.tier, status, notes` | `standard` / `active` | — | — |
| Org contact + address `clients.phone, website, address_line1, address_line2, city, region, postal_code, country, account_manager → people, logo_key` (`OrgColumns` `models.py:156-169`; `logo_key` = storage key of the client logo, a candidate label image) | `Tempe, AZ` | — | — |
| Client bookkeeping `clients.id` (`models.py:175`), `source, source_ref, created_by, archived_at, created_at, updated_at` (`models.py:181-186`) | — | — | — |
| Partner name `partners.name` (citext NOT NULL; reachable via the 7 initiative partner FKs, `sites.partner_id`, `worker_profiles.partner_id`) | `Dynamic Lifecycle Innovations` / `Sonigo` / `Champagne Logistics` | — | — |
| Partner code `partners.code` | `DYNAM` / `CPTNA` | — | — |
| Partner types `partners.partner_types` (text[]; `status_values` partner_type: cable, consultant, ewaste, logistics, other, staffing, subcontractor, tech) | `['logistics','ewaste']` | — | — |
| Service region `partners.service_region` (free text) | `Worldwide` / `Israel` | — | — |
| Parent partner `partners.parent_id → partners.name` (migration 0095, `models.py:210-211`) | `Capitol North American` (CPTNA) → `Champagne Logistics` | — | — |
| Partner status / account manager `partners.status`, `account_manager → people` (`models.py:167-168, 189-190`) | `active` | — | — |
| Partner org contact + address + bookkeeping (`OrgColumns` incl. `logo_key`) + `notes, source, source_ref, created_by, archived_at, created_at, updated_at`; `partners.id` (`models.py:196`) | — | — | — |

### 1g. Container (crate / cart / pallet) — `containers` / `class Container` `api/db/models.py:805-837`

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Container name `containers.name` (citext NOT NULL) | `ORD1-DC-25` / `PHX1-W3M-DC-05` / `ATL1-W1M-DC-02` | `C` (`name`, `schemas.py:3494`) | `container_name` (container rows only; `""` on asset rows) |
| Container ID (human) `containers.legacy_id` (bigint NULL — **NULL on all 136 dev containers**) | NULL (catalog sample `C-0017`) | — (not on `C` either: `schemas.py:3493-3502`, `kiosk.py:1120-1125`) | `container_id` (`str(legacy_id)` or `""`) |
| Label tag `containers.label_tag` (text NULL, CHECK priority/vendor/accessories/ewaste/warehouse; migration 0058; `api/labels/tags.py:11-26`) | NULL → prints `CONTAINER`; `ewaste` → `E-WASTE` | `C` (`label_tag` raw key, `schemas.py:3496`, `kiosk.py:1121`); `A.label` carries the key `label_tag` = `""` | `label_tag` (upper-cased display label, fallback `UNTAGGED_LABEL = "CONTAINER"`, `label_values.py:23, 185`) |
| RFID tag `containers.rfid_tag` (citext NULL) | `000000000000000875310678` | `C` (`rfid_tag`, `schemas.py:3495`) | — |
| Container type `containers.container_type` (`status_values` container_type: cart, crate, d_container, pallet, pelican_case, shipping_container) | `d_container` ('D-container') | `C` (`container_type`, `schemas.py:3497`) | — |
| Status `containers.status` (default `available`) + `status_values.label` (record_type `container`; `kiosk.py:1109-1111, 1123`) | `available` / `in_transit` | `C` (`status`, `status_label`, `schemas.py:3498-3499`) | — |
| Site `containers.site_id → sites.name` | `INITECH-ORD1 - Initech Chicago DC` | `C` (`site_id`, `site_name`, `schemas.py:3500-3501`) | — |
| Move `containers.initiative_id` (0057) → `initiatives.name` | `Initech ORD1 to AUS1 Migration` | `C` envelope `initiative_id` (`schemas.py:3506`); name not sent | — |
| Location `containers.location_detail` (text) | `Staging cage` | — | — |
| Asset count (derived) `count(container_assets)` | `12` | `C` (`asset_count`, `schemas.py:3502`) | — |
| Counted stock packed in it `stock_lines.description, quantity, unit, model_id → asset_models, location_detail, notes` (`models.py:931-957`; dev `PDU, 30A vertical` × 24, `Fiber patch, LC-LC 3 m` × 12) | `PDU, 30A vertical × 24` | — | — |
| Audit / bookkeeping `containers.last_audit_at, audit_by, last_validated_at, source, source_ref, created_by, archived_at, created_at, updated_at`; `containers.id` (`models.py:808`) | — | `C` (`id`); `A` (`container_id`) | — |

### 1h. Other — Truck, Person / worker, Print context, PKs

| Field (column) | Example | On kiosk sync today | Placeholder today |
|---|---|---|---|
| Truck name `trucks.name` (citext NOT NULL; `class Truck` `models.py:840-873`) | `SEA1-T01 (Wave 1)` / `Demo Truck 2` | `T` (`name`, `schemas.py:3662`) | — |
| Load number `trucks.load_number` | `CONT-SEA1-001` / `L-1043` | `T` (`load_number`, `schemas.py:3663`) | — |
| Seal ID `trucks.seal_id` (varchar(24)) | `SEAL-88232` | — | — |
| Driver / co-driver / team drive `trucks.driver_name, co_driver_name, team_drive` | `Hector Alvarez` / `Brianna Cole` / `true` | `T` (`driver_name` only, `schemas.py:3666`) | — |
| Contact info `trucks.contact_info` | `+1 (555) 012-6957` | — | — |
| Truck status `trucks.status` (created, active, in_transit, at_destination, inactive, historical) + `status_values.label` (`kiosk.py:2050-2052`) | `in_transit` / `at_destination` ('At Destination') / `inactive` ('In-Active') | `T` (`status`, `status_label`, `schemas.py:3664-3665`) | — |
| Tracking `trucks.tracking_type` (jsonb `{type, tracker_id, update_type}`) | `{'type':'gps','tracker_id':'CONT-SEA1-1','update_type':'API'}` | — | — |
| Route `trucks.start_site_id, end_site_id → sites.name`; `initiative_id` | `CONTOSO-SEA1 - Contoso Quincy DC → CONTOSO-IAD1 - Contoso Ashburn DC` | `T` (`start_site_id/name`, `end_site_id/name`, `schemas.py:3667-3670`); envelope `initiative_id` (`schemas.py:3675`) | — |
| Container count (derived) `count(truck_containers)` (`models.py:876-883`; `kiosk.py:2056-2059`) | `6` | `T` (`container_count`, `schemas.py:3671`) | — |
| Trip timing / history `trucks.trip_started_at`; `truck_updates.recorded_at, location ('lat, lng' text), lat/lng, approximate_address` (`models.py:898-902`); `truck_events.event, event_kind, stop, recorded_at` (`models.py:920-923`) | `Departed at Pickup` | — | — |
| Truck bookkeeping `trucks.legacy_id, created_by, created_at, updated_at, archived_at`; `trucks.id` (`models.py:846`) | — | `T` (`id`) | — |
| Person name `people.first_name, last_name, preferred_name`; `display_name` property = `(preferred_name or first_name) + ' ' + last_name` (`models.py:26-63`) | `Jeffrey Ambrosio` / `Robert Holguin` | `P` (`display_name`, `first_name`, `last_name`, `preferred_name`, `schemas.py:3261-3265`) | — |
| Contact / title `people.email, phone, job_title`; login email `user_accounts.email` (separate column, `models.py:71`) | `jhenderson@…` | — | — |
| Identifiers `people.external_id, badge_uid (uuid, default gen), rfid_tag` (badge_uid is what an ID badge would encode) | `badge_uid cdee261a-ee7f-4ddc-97c9-75508d694e12` | `P` (`rfid_tag` only, `schemas.py:3266`) | — |
| Badge photo `people.avatar_key` (attachments kind `avatar`, 49 dev rows; `AVATAR_KEY_FIELD` `attachments.py:47`; `models.py:47`) | — | — | — |
| Address `people.address_line1, address_line2, city, region, postal_code, country` | — | — | — |
| Worker profile `worker_profiles.trade, level → worker_levels (level key L1..L6, title, rank, color; models.py:383-389, 400), status, status_note, partner_id → partners.name` (`models.py:393-405`) | `L1 Apprentice #8a93a6` … `L6 Master #ffb84d`; partner `Hen-U` / `Nesco` | `P` (derived `is_worker`, `has_account`, `schemas.py:3267-3268`; `kiosk.py:1046-1049, 1061-1062`) | — |
| Certifications `worker_certifications.name, issuer, issued_on, expires_on` (`models.py:408-419`; 0 dev rows) | — | — | — |
| Links to an asset/move `initiative_assets.added_by, assets.created_by, container_assets.added_by, initiative_people.person_id, processed_scans.operator_id` | — | — | — |
| Person bookkeeping `people.notes, source, source_ref, created_by, archived_at, created_at, updated_at`; `people.id` (`models.py:29`) | — | `P` (`id`) | — |
| Print context: `devices.name, serial, station_type, site_id, session_person_id → people` (the kiosk that prints and who is signed in; `models.py:1158-1163, 1186-1188, 1192`) + print time | — | — (the kiosk knows itself locally) | — |

### 1i. Values computed today — exact rules

| Key | Rule | Where |
|---|---|---|
| `asset_id` | `str(asset.legacy_id) if asset.legacy_id is not None else ""` | `api/labels/label_values.py:144` |
| `asset_name` / `serial_number` / `make` / `model` | column value or `""` (V2 parity: missing data never errors) | `label_values.py:136-137, 145-148` |
| `make_model` | `make_model_text()`: `f"{make} {model}"` when both set, else `make or model` | `label_values.py:68-76, 149`; kiosk computes the same at `kiosk.py:998` |
| `source_raw` | `asset.source_position or asset.source_rack or ""` — **position wins when set**; this is the string the split rules operate on | `label_values.py:138` |
| `destination_raw` | `asset.destination_position or asset.destination_rack or ""` | `label_values.py:139` |
| `source_ru` / `destination_ru` | `_format_ru()`: None → `""`; whole → `"U14"`; fractional → `"U14.5"` (trailing zeros stripped: `format(value,"f").rstrip("0").rstrip(".")`). V2 stored the `U14` string; V3 stores numeric | `label_values.py:55-65, 151, 154` |
| `source_site` / `destination_site` | `Site.name` of `initiative.origin_site_id` / `destination_site_id` (full name), or `""` | `api/labels/generate/values.py:78-85` (`_move`); `label_values.py:152, 155` |
| `move_name` | `initiative.name or ""` | `label_values.py:156` |
| `move_date` | `day.strftime("%m/%d/%Y")`, `day = stored_day(scheduled_start)` (UTC date parts) | `label_values.py:118-123`; `api/services/timezone.py:30-40` |
| `move_date_long` | `f"{day.day:02d}-{MON}-{day.year}"` with upper-cased 3-letter month, e.g. `07-OCT-2026` | `label_values.py:25-26, 123` |
| `container_name` / `container_id` | asset row: **always `""`**; container row: `name or ""` / `str(legacy_id)` or `""` | `label_values.py:159-162` (asset), `183-184` (container) |
| `label_tag` | `(LABEL_TAG_LABELS.get(tag, tag) or "CONTAINER").upper()` — container rows only; not in the asset `computed` dict, so `""` on asset rows | `label_values.py:23, 185`; `api/labels/tags.py:20-26` |
| Position-split tokens (`generation_rules.source` / `.destination`) | `raw.split(".")`; for each `{"<1-based pos>": "<name>"}`, `out[name] = parts[idx]` when `0 <= idx < len(parts)`; a position past the end is left **UNSET** so the unknown-token scan reports it; applied AFTER the catalog, NOT filtered by `catalog_keys`; **asset rows only** (containers get length limits only). All 12 dev templates have `generation_rules = {}` | `label_values.py:79-100, 164-168, 194-197`; `models.py:1697-1702` |
| `length_limits` (`generation_rules.length_limits`) | `out[field] = out[field][:limit]` for each `{"field": int}` where field present and `limit > 0`; asset and container rows | `label_values.py:103-115, 168, 197` |
| Token syntax | `TOKEN_RE = r"\{([a-z0-9_]+)\}"` — only bare `{key}`; V2's `{'x'}` / `{row['x']}` are "deliberately not supported" and pass through to the printer verbatim; unknown bare tokens substitute `""` (render reports them, `api/labels/render.py:11-19, 42-45`) | `api/labels/tokens.py:1-9, 12-21` |
| Kiosk RU text (not in the label map) | `_ru_text`: `format(ru.normalize(), "f")` → `"14"` / `"14.5"`; `_ru_raw`: `str(ru)` → `"14.0"` (dev RUs stored with scale 1) so the edge can rebuild the Decimal | `kiosk.py:938-947` |
| Kiosk label map | `placeholder_values(asset_row, initiative, sites, catalog_keys)`, keys = active catalog minus `container_name`/`container_id` (16 of 18), **no generation_rules**; plus `label_context {move_name, move_day, source_site, destination_site, catalog_keys}` so the edge can recompute | `kiosk.py:898-908, 962, 999, 1017-1023`; `schemas.py:3175-3221` |
| Kiosk mock test label | `POST /kiosk/labels/test-render` → `mock_label_values()` applies the template's `generation_rules` via `_apply_position_rules` on `MOCK_VALUES` `source_raw "A1.R01.U12"` / `destination_raw "B2.R04.U12"` (3 parts) | `kiosk.py:1203-1239, 1322-1358` |
| `cable_info` JSON | importer packs non-blank Data 1-6 / Mgmt 1-2 cells into `{"data_n": …, "mgmt_n": …}`, stored as `json.dumps()` TEXT (None when empty) | `move_assets.py:95-101, 222-223` |
| `raw_ft` | the per-row `raw` dict keyed by the ORIGINAL headers (case preserved, unknown columns such as `Notes` kept) | `api/imports/parsing.py:1-7`; `move_assets.py:135, 226` |
| From-To header normalization | `HEADER_MAP` lower-cased header → canonical column; `vendor involvment` (V2 spelling) accepted | `parsing.py:25-47` |

---

## 2. Location strings

### 2a. What V2 did

- **Storage.** `moves_assets_list.source_raw` / `destination_raw` are the untouched From-To "Source Rack" / "Destination Rack" cells: `api/portal_routes.py:5366-5368` (`"source_rack": row.get('Source Rack', '').strip() or None`), written as `"source_raw": parsed_row["source_rack"]` at `:5612` / `:5652` (second importer `:6472-6473`). `destination_ru` is the separate "Destination RU" column. There is no `Rack` model and no rack-name grammar anywhere; `destination_raw` is used as an opaque id for collision checks (`portal_routes.py:5726`).
- **The only split mechanism** is a per-template JSON map in `label_templates.label_generation_code` (text column, `json.loads`-ed at `:27454-27459`; the `label_generation_code_json` jsonb twin is written at `:27215`, `:27304-27306` but never read). Exact rule, `api/portal_routes.py:27623-27650` (duplicate `:28087-28120`):
  ```python
  dest_parts = dest_raw.split('.')
  for pos_str, var_name in label_generation_code['destination'].items():
      pos = int(pos_str) - 1
      if 0 <= pos < len(dest_parts):
          field_values[var_name] = dest_parts[pos]
  # same for 'source' with src_parts
  ```
  - plain `str.split('.')`: no trimming, no regex, no numeric parsing, no zero-padding, case preserved;
  - keys are 1-based positions as strings, values are the placeholder names the template uses (comment `:28088-28089`: `{"1": "nap", "2": "sector"} … map directly to template placeholders like {'nap'}, {'sector'}`);
  - positions past the end silently skipped; extra segments ignored; no dot → segment 1 = whole string;
  - a mapped name may **overwrite a built-in key** (same `field_values` dict), e.g. `"5": "ru"`;
  - the background job loads `label_generation_code` only for `top` labels (`:27489-27497`); the synchronous endpoint loads it for all types (`:27942-27960`);
  - after substitution every still-unmatched `{...}` is deleted: `re.sub(r"\{[^}]+\}", "", zpl)` (`:27673`, `:28154`), so a missing part prints blank.
- **The only stored mapping** — "Vegas Destination" id 5 (`type='asset_top'`, `printer_type='Zebra 300dpi'`), `server-prep/backups/SS-DB_Backup_20251217_172922.sql:15845`:
  ```json
  {"source": {}, "destination": {"1":"dest_nap", "2":"dest_sector", "3":"dest_tscif", "4":"dest_row", "5":"dest_rack"}}
  ```
  i.e. `A.B.C.D.E` → nap, sector, tscif, row, rack. The V2 template body did **not** reference any `dest_*` name (it used `{row['asset track']}` etc., which were blanked), so the split never visibly worked in V2 either.
- **Length limits**: `label_generation_code.length_limits` → hard truncation `field_values[f][:max_len]` (`:27652-27661`); no padding, no min length, no auto-fit. No template in the dump used it.

### 2b. What real data looks like in V3 today

- The dotted strings live in `initiative_assets.source_rack` / `destination_rack` (never in `*_position`, which the From-To template defines as "Front or Rear", `parsing.py:91, 96`).
- Dev DB (`initiative_assets`, 3,483 rows; dot-count = `length(col)-length(replace(col,'.',''))`):
  - `source_rack`: 1,790 rows with exactly 4 dots (5 parts), 1,691 with none, 2 NULL; longest 31 chars `AN17 (Room=N (Singapore,SGD,3))` (parentheses, `=`, commas).
  - `destination_rack`: 1,800 with 4 dots, 1,497 with none, 186 NULL; longest 15 chars `14.03.02B.01.10`.
  - 5-part examples: `11.03.01B.01.03`, `09.01.05D.02.10`, `14.01.06A.01.08`, `09.04.03C.01.01`, `14.03.02B.01.10`, `11.01.01.01A.02`. Note the letter-suffixed part sits at **position 3** in `14.01.07C.02.03`-style strings but at **position 4** in `11.01.01.01A.02`.
  - no-dot examples: `ORD1-F01`, `BJ14`, `BJ08`, `AUS1-M06`, `DFW1-I06`, `IAD1-L07`.
  - All dotted values came in through From-To uploads (`raw_ft` populated on 1,994 rows, e.g. `{'Source Rack': '09.01.05D.02.10', 'Destination Rack': '14.03.02B.01.10', …}`); the seeded demo rows carry the no-dot `SITE-RACK` style.
- The dev DB has almost **none** of the data a split rule actually needs: `source_position`/`destination_position` are set on **1 row** (`Front` with `source_rack '11.01.01.01A.02'`; `Rear` with `destination_rack 'BJ08'`) — and because `source_raw` prefers position (`label_values.py:138`), that row's `source_raw` is `Front`, so a split would run on `Front`; `label_info` is **0 rows**; **0 of 12** `label_templates` have `generation_rules` ≠ `{}`; `generated_labels.values` show real output such as `source_ru 'U0'` and blank destination fields when a move has no destination.
- RU: numeric, dev range 0.0-51.0, fractional values exist (3.5, 5.4, 13.2, 33.2 — chassis node slots, `form_factor = node`, migration 0068); the `U` prefix exists only in the label map.
- The only dot-separated sample anywhere in V3 is the kiosk mock: `source_raw "A1.R01.U12"`, `destination_raw "B2.R04.U12"` (`kiosk.py:1207, 1210`) — 3 parts, a different shape from Vegas's 5.
- Pods: `initiative_assets.source_pod` / `destination_pod` (`P4` / `D4`) and `assets.pod_number` already hold a "pod" that is **not** part 3 of the dotted string (migration 0069: "Nap 14 numbers its pods, Nap 9 does not").

---

## 3. V2 placeholder vocabulary

Substitution loop (`api/portal_routes.py:27664-27669`, `:28133-28145`): for each key, literal `str.replace` of `{'field'}`, `{"field"}`, `{row['field']}`, `{row["field"]}`, `{field}` in that order; case-sensitive, exact (no trimming). The daemon (`helper_scripts/label_generator.py:298-316`) also accepts curly quotes `‘ ’ “ ”` and backticks. V3's import translator: `V2_ALIASES` `api/labels/v2_import.py:53-72`; `_ROW_RE` / `_QUOTED_RE` / `_BARE_RE` `:76-84`; `translate_code` `:88-105` strips whitespace but does **no** space→underscore normalization; unknown aliases and `{{handlebars}}` are left verbatim and reported (`:9-12`).

| V2 spelling | V2 source | V3 equivalent today |
|---|---|---|
| `{asset id}` / `{'asset id'}` / `{row['asset id']}` / `{asset_id}` | `portal_routes.py:27599-27621` (`str(mal.asset_id)`) | `{asset_id}` (`V2_ALIASES` "asset id", "asset_id") |
| `{asset name}` / `{asset_name}` / `{name}` | `:27599-27621` (`assets.name`) | `{asset_name}` |
| `{asset_serial_number}` / `{serial_number}` | `:27599-27621` (`mal.asset_serial_number`) | `{serial_number}` |
| `{'asset serial number'}` (with spaces) | **not** in the V2 API dict; appears in the V3-stored Vegas/Amsterdam/Generic templates | **none** — not in `V2_ALIASES`, not `TOKEN_RE`; prints literally (in both ACTIVE Generic templates) |
| `{serial}` | daemon only, `label_generator.py:237-275` | `{serial_number}` |
| `{make}` / `{model}` | daemon only | `{make}` / `{model}` |
| `{assets.make_model}` / `{make_model}` | `:27576-27583` | `{make_model}` |
| `{source_raw}` | `:27599-27621` (`mal.source_raw`) | `{source_raw}` (= `source_position or source_rack`) |
| `{source}` | daemon only (= `source_raw`) | `{source_raw}` |
| `{source_ru}` | `:27599-27621` (`mal.source_ru`, stored as `U14` text) | `{source_ru}` (`_format_ru` of numeric) |
| `{source site}` / `{source_site}` | `:27599-27621` (`sites.name` of `moves.source`) | `{source_site}` |
| `{destination_raw}` | `:27599-27621` | `{destination_raw}` |
| `{destination}` | daemon only | `{destination_raw}` |
| `{destination_ru}` / `{ru}` | `:27599-27621`; `"ru"` = "Alias for destination_ru" `:28064` | `{destination_ru}`; **`ru` has no alias** (none) |
| `{destination site}` / `{destination_site}` | `:27599-27621` | `{destination_site}` |
| `{move date}` / `{move_date}` | `:27586-27591` (`strftime('%m/%d/%Y')`) | `{move_date}` (same format); `{move_date_long}` is V3-only |
| `{move_name}` / `{moves_id}` | daemon only | `{move_name}` / none |
| `{'nap'}` `{'sector'}` `{'pod'}` `{'row'}` `{'rack'}` `{'ru'}` `{'floor'}` `{'room'}` | per-template split names — **never defined by V2 code**; came only from `label_generation_code` maps | none (prints literally); would need `generation_rules.destination/source` naming `nap`, `sector`, … and bare `{nap}` spelling |
| `dest_nap`, `dest_sector`, `dest_tscif`, `dest_row`, `dest_rack` | Vegas id 5 `label_generation_code` (`SS-DB_Backup_20251217_172922.sql:15845`) | none until typed into `generation_rules` (`portal/components/labels/GenerationRulesPanel.tsx`) |
| `{row['asset track']}` `{row['asset tpos']}` `{row['asset srack']}` `{row['asset spos']}` `{row['asset serial num']}` `{row['asset model']}` | V2 Vegas id 5 body (`:15845`) — not in any V2 map, blanked by the regex sweep | none |
| `{{QR:manifestNumber}}` `{{#assets}}…{{/assets}}` `{{CALCULATED}}` `{{FOOTER_*_Y}}` `{{BOLD_ON}}` `{{CUT}}` | container_manifest ids 3/4 (`:15844`, `:15846`), filled by device apps, not the server | none (`_HANDLEBARS_RE` reports them verbatim, `v2_import.py:82, 113`) |

---

## 4. The Vegas Destination tag

Two bodies carry this name. The one in the **V3 database** (`label_templates` "Vegas Destination", kind=`code`, type `top`, size `4x2`, dpi `300`, language `zpl`, **is_active=False**, v1, `generation_rules={}`; recon file `template_Vegas_Destination.txt`) is the one below. The V2 backup's id 5 is an older 406×203 body using `{row['…']}` spellings and `E:85620388.TTF` (shown in the V2 report; it is not the one in V3). No file named "Vegas" exists in the repo — the template lives only in the DB.

### 4a. Layout sketch (1200 × 600 dots @ 300 dpi; 1 column ≈ 20 dots; baseline y at left)

```
x:    0   100  200  300  400  500  600  700  800  900  1000 1100 1200
      |    |    |    |    |    |    |    |    |    |    |    |    |
y10   {nap}    ████████  {pod}     ████████  {rack}    ████████        <- banner, all h100 (24 pt), baseline y=100
      ^FT10    █SECTOR█  ^FT400    █ ROW  █  ^FT850    █  RU  █           blocks ^GB165,110,90 @ x190-355, 630-795, 1030-1195
y120           ████████            ████████            ████████           white text = ^LRY XOR over the block; 20-dot left pad
y173  Name:    {asset_name}                                            <- caption h42 @x38, value h35 @x185
y220  Serial:  {'asset serial number'}                     ┌───────┐
y270  Model:   {make_model}                                │  QR   │   <- ^FT1000,300 bottom-left, ^BQN,2,7 ≈147² (x1000-1147, y153-300)
y295  ═══════════════════════════════════════════════════  └───────┘   <- rule ^FO38,295 ^GB1120,5,5 (x38-1158); QR overlaps it by 5 dots
y351  NAP:     {'nap'}                 SECTOR:  {'sector'}        ▲ ▲
y420  POD:     {'pod'}                 ROW:     {'row'}           │ │  <- ^AKB h45 bottom-up, start y=580, read upward
y489  RACK:    {'rack'}                RU:      {'ru'}            │ │     {source_site} ^FT1120,580 (ink x≈1088-1120)
y500                     ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌                     │ │     {move_date}   ^FT1160,580 (ink x≈1128-1160)
y550                     ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  Code128 ^FO440,500  │ │
y575                         1 0 4 8 2   (interp. line, ^BY4, h50, ≈x440-780)
y600  ──────────────────────────────────────────────────────────────────
      captions x38 / x627 ; values x185 / x790 ; grid h35 ; row pitch 69
```

Glyph tops sit ≈0.72 × height above each baseline, so the h100 banner text occupies ≈ y28-100 inside its y10-120 block.

### 4b. Element inventory (recon line numbers; `^FT` = baseline-left, `^FO` = top-left)

Label-level: L5 `^MMT` (tear-off), L6 `^PR2` (2 ips), L7 `^PW1200^LL600^LS0`, L8 `^CWK,E:TT0003M_.TTF` (alias font **K** → Zebra's resident Swiss 721 bold-condensed TTF), L9 `^FO38,295^GB1120,5,5^FS` (plain rule, emitted BEFORE `^LRY`), L10 `^LRY` (label reverse ON: every later field XORs onto what is printed), L51 `^PQ1,0,1,Y`, L52 `^XZ`. No `^FB`, no `^FR`, no `^CI`, no `^FH` anywhere.

| # | Line | Element | Anchor | Font / size | Data | Note |
|---|---|---|---|---|---|---|
| 1 | 13 | text | `^FT10,100` | `^AKN,100,` (24 pt) | `{'nap'}` | plain; x=10 while every other left edge is 38 |
| 2 | 14 | filled box | `^FO190,10^GB165,110,90` | — | — | border 90 ≥ h/2 → solid block x190-355 y10-120 |
| 3 | 15 | text | `^FT210,100` | K N h100 | `{'sector'}` | white-on-black via `^LRY`; 20-dot left pad |
| 4 | 16 | text | `^FT400,100` | K N h100 | `{'pod'}` | plain |
| 5 | 17 | filled box | `^FO630,10^GB165,110,90` | — | — | x630-795 |
| 6 | 18 | text | `^FT650,100` | K N h100 | `{'row'}` | inverted over #5 |
| 7 | 19 | text | `^FT850,100` | K N h100 | `{'rack'}` | plain |
| 8 | 20 | filled box | `^FO1030,10^GB165,110,90` | — | — | x1030-1195 |
| 9 | 21 | text | `^FT1050,100` | K N h100 | `{'ru'}` | inverted over #8 |
| 10-15 | 23-28 | text ×6 | `^FT38,{173,270,220}` captions, `^FT185,{173,270,220}` values | captions h42 (10.08 pt), values h35 (8.4 pt) | `Name:`/`{asset_name}`, `Model:`/`{make_model}`, `Serial:`/`{'asset serial number'}` | file order Name/Model/Serial, visual order Name/Serial/Model |
| 16-27 | 30-41 | text ×12 | captions `^FT38,y` / `^FT627,y`; values `^FT185,y` / `^FT790,y`; y = 351, 420, 489 | K N h35 | `NAP:`/`{'nap'}` + `SECTOR:`/`{'sector'}`; `POD:`/`{'pod'}` + `ROW:`/`{'row'}`; `RACK:`/`{'rack'}` + `RU:`/`{'ru'}` | 3×2 grid |
| 28 | 45 | Code 128 | `^FO440,500` | `^BY4` (module 4), `^BC,50` (orientation default N, h50, interpretation line default Y, line-above N, check digit N, mode N) | `{asset_id}` | comment L44 `^FX Bottom Aeest Bar Code` (typo) |
| 29 | 47 | QR | `^FT1000,300` (bottom-left) | `^BY2,2.0,65` then `^BQN,2,7` (model 2, magnification 7) | `<{asset_id}` | **no `<ECL><mode>,` prefix**; data begins with a literal `<`; 6-byte payload → version 1 ≈147² dots |
| 30 | 49 | text | `^FT1120,580` | `^AKB,45,45` (270°, bottom-up; 10.8 pt) | `{source_site}` | reads upward; ink x≈1088-1120 |
| 31 | 50 | text | `^FT1160,580` | `^AKB,45,45` | `{move_date}` | a 10-char date ≈220-250 dots tall → y≈340-580 |

Siblings (same scaffold): **Amsterdam Destination** (inactive v1) banner = `{'floor'}` in a 200-wide box, `{'room'}` plain, `{'rack'}` in a 250-wide box (40-dot pad), `{'ru'}` plain; grid FLOOR/ROOM, POD/ROW, RACK/RU with values at x759, and it carries `{'pod'}`/`{'row'}` tokens beside the POD:/ROW: captions (6-token location vocabulary). **Generic Rack and RU - 3400DPI** (sic; dpi=300, **active**, v3) = Amsterdam minus the boxes (`{'rack'}` `^FT120,100`, `{'ru'}` `^FT650,100`). **Generic Rack and RU - 203DPI** (active, v8) = a hand-scaled copy at 203/300 (`^PW812^LL406`, `^FT81,68 ^AKN,68`, `^BY3^BC,34`, `^BQN,2,5`, `^AKB,30,30`) — the same point sizes V3's inch/pt model would produce automatically. **Front Asset Tag** (front, 2x1, inactive) uses `^A@N,35,,E:85620388.TTF`, `^BCN,35,Y,N,N,A` (mode A) and `^GB570,7,4,B,8`. **Switch Front Tag** (type=top, 4x2, **active**, v3) is one field `^XA^FO50,50^A0N,40,40^FD{serial_number}^FS^XZ` with no `^PW`/`^LL`.

### 4c. Tokens in the Vegas body and their V3 status

| Spelling | Lines | V3 status |
|---|---|---|
| `{'nap'}` `{'sector'}` `{'pod'}` `{'row'}` `{'rack'}` `{'ru'}` | 13-21, 31-41 | not `TOKEN_RE` (`tokens.py:9`); not in `V2_ALIASES`; left verbatim by import (`v2_import.py:93-105`); not reported by `render.py:44-45`; **print literally**. Even as `{nap}` they would resolve only if `generation_rules.destination` named them — and it is `{}` |
| `{'asset serial number'}` | 28 | same; the alias table has `asset_serial_number`/`serial_number`/`serial`, never the spaced form |
| `{asset_name}` `{make_model}` `{asset_id}` (also `<{asset_id}`) `{source_site}` `{move_date}` | 24, 26, 45, 47, 49, 50 | valid catalog keys |
| Intended split (inferred from the V2 id-5 map and the captions) | — | `destination {1: nap, 2: sector, 3: pod, 4: row, 5: rack}` with `ru` from `destination_ru` — but (a) split `pod` collides in meaning with `initiative_assets.destination_pod`, (b) `{destination_ru}` prints `U13`, the banner expects `13`, (c) `source_raw` prefers Front/Rear over the rack string |

### 4d. ZPL features in these templates the current V3 design model cannot express

Model = `api/labels/model.py` (`Design` L72-76; `TextEl` L33-43; `BarcodeEl` L46-54; `QrEl` L57-59; `LineEl`/`BoxEl` L62-69). Compiler = `api/labels/zpl.py` (header L89-92, `_text` L47-58, `_barcode` L61-71, `_qr` L74-77, `_shape` L80-84).

| # | ZPL feature (command) | V3 today | Gap |
|---|---|---|---|
| 1 | Baseline anchoring `^FT x,y` (every text/QR field) | only `^FO` top-left (`zpl.py:50, 70, 76, 84`) | converting these templates needs per-font ascent at each size; the compiler has no glyph metrics (`zpl.py:7-8`) |
| 2 | Named / resident TrueType font `^CWK,E:TT0003M_.TTF` + `^AK…`; `^A@N,35,,E:85620388.TTF` | hard-coded `^A0` (`zpl.py:55`); `TextEl` has no font field | no font choice, no `^CW` alias, no `^A@` E: object; `template_fonts.py:22-30` only *detects* these in code templates (and would demand the factory-resident `TT0003M_.TTF` in the font library) |
| 3 | True bold face (Swiss 721 bold-condensed) | `bold` = width ×1.2 (`zpl.py:49`) | faux bold by stretching, not a weight |
| 4 | Omitted font width `^AKN,100,` (natural aspect) | always emits `h,w` (`zpl.py:55`); sizes only in pt (`zpl.py:48`) | cannot emit natural width |
| 5 | Inverted text: label-level `^LRY` over filled `^GB…,90` blocks | per-field `reverse` → `^FR` (`model.py:42`, `zpl.py:56-57`) exists but (a) absent from `portal/lib/labelModel.ts:12-13` and the properties panel, (b) `BoxEl` has no `fill` — solid block only via `strokeIn ≥ h/2`, (c) no `^LRY`, (d) no single "Inverted" switch that auto-builds a padded black box (Vegas pad: 20 left, 10 above, 20 below) | |
| 6 | `^GB` color + rounding `^GB570,7,4,B,8` (Front) | `_shape` emits `w,h,t` only (`zpl.py:84`); rotation dropped | no color, no corner radius |
| 7 | QR `^BQN,2,7` + `^FD<{asset_id}` (explicit magnification, no ECL/mode prefix, literal `<` sentinel, `^FT` anchor) | `mag = clamp(1..10, round(w_dots/25))` (`zpl.py:75`); forces `^FDQA,` (`zpl.py:76-77`) | magnification not settable; EC level/mode forced; the `<` survives `_esc` (`zpl.py:22-29`) so `data: "<{asset_id}"` works |
| 8 | Code 128 `^BCN,35,Y,N,N,A` mode **A** (Front); interpretation-line font via `^A@` inside the barcode field; `^BC,50` | `^BC{rot},{h},{Y/N},N,N` (`zpl.py:67`) — mode omitted (= N), no font for the human-readable line | mode A packs digit pairs (narrower symbol); `^BY4` IS expressible via `moduleIn` (4/300 = 0.0133 in → 3 at 203, matching the hand-scaled template) |
| 9 | Chained commands in one field (`^A@` + `^BC` + `^A@` + `^FD`, Front L7) | one command set per element | not expressible |
| 10 | Label-level `^MMT`, `^PR2`, `^LS0`, `^PQ1,0,1,Y`, `^CW`, `^LRY`, `^FX` comments | `Design` = size + elements; header fixed `^XA ^PW ^LL ^CI28` (`zpl.py:89-92`) | no print mode, speed, shift, quantity/pause, font aliases, element notes |
| 11 | No `^CI`/`^FH` in the templates | V3 always emits `^CI28` and `^FH_` hex escaping (`zpl.py:58, 22-29`) | not a gap, but output differs byte-for-byte |
| 12 | Rotated text `^AKB,45,45` | rotation 270 → `B` (`model.py:12`, `zpl.py:15`); canvas rotates about top-left (`EditorCanvas.tsx:159`) matching `^FO` | expressible except for #1 |
| 13 | "Split" display type (break `14.01.07C.02.03` on `.`) | template-level `generation_rules` only (`label_values.py:79-100`) | no element-level split, no sub-fields under a parent, no catalog entries/sample values for parts, `.` only, no from-the-end positions |
| 14 | "Expected character length" / fixed-width cells | fixed `w`/`h` in inches; `length_limits` only truncates (`label_values.py:103-115`) | no "size to N chars of this font"; no glyph metrics in preview or compiler |
| 15 | Display type Number / formatting | text / barcode / qr / line / box only (`model.py:117-176`) | no numeric formatting, no per-element display-type switch |
| 16 | Example values while designing | global `sample_value` per catalog key only | nothing per template, nothing for split parts, no site-shaped sample string |
| 17 | Two hand-scaled DPI versions | inch model + `_dots` (`zpl.py:18-19`) makes this automatic | not a gap — an improvement |

Hazards in the stored templates (fix regardless of the builder): `{'asset serial number'}` prints literally in **both active Generic templates**; "3400DPI" name; `^FX … Aeest` typo; QR overlaps the rule by 3-5 dots; `^LRY`/`^BY` state-order dependence (a z-order model must emit `^BY`/`^FR` per element); banner cells (165/200/250 dots) overflow at 3 chars of h100 condensed digits (~50 dots each) with nothing enforcing it; Front Asset Tag's font-name-less `^A@N,35,`; Switch Front Tag is an active global `top` template with no `^PW`/`^LL`, which `pick.py:47` (`destination, source, global, generic`) would prefer over Generic Rack and RU for any move without a site template (site links not in the recon dump — verify).

---

## 5. The current V3 designer

### 5a. Design JSON schema (validator `parse_design`, `api/labels/model.py:83-183`; portal mirror `portal/lib/labelModel.ts:9-19`)

```json
{ "size": { "w": <in > 0>, "h": <in > 0> },
  "elements": [ { "id": "t1", "type": "text", "x": 0.2, "y": 0.2, "w": 1.5, "h": 0.25, "rotation": 0,
                  "content": "Name: {asset_name}", "fontSizePt": 10, "bold": false, "align": "left",
                  "reverse": false, "lines": 1 },
                { "type": "barcode", "symbology": "code128|code39", "data": "{asset_id}", "showText": true, "moduleIn": 0.01 },
                { "type": "qr", "data": "{asset_id}" },
                { "type": "line" | "box", "strokeIn": 0.01 } ] }
```
- Coordinates are **inches**; "only compilers convert to dots" (`model.py:4`). `size` is **overridden at compile time** by the size vocab row (`api/labels/compile.py:45`; `render.py:50`; `kiosk_templates.py:144`).
- Common: `id` (fallback `"element {i}"`, `model.py:100`); `x,y,w,h` ≥ 0 (`:103-111`); `rotation` ∈ 0/90/180/270 (`:12, 113-116`).
- `text`: `content`, `fontSizePt` > 0, `bold`, `align` left/center/right (`:14`), `reverse` (→ `^FR`, `:39-42`), `lines` ≥ 1 (`^FB` line count, `:40-44, 133-136`).
- `barcode`: `symbology` code128/code39 only (`:13`), `data` non-empty, `showText`, `moduleIn` (narrow module in inches; absent = historical `^BY2`, `:51-54`).
- `qr`: `data` only — no EC level, model, or magnification property (`:57-59`).
- `line`/`box`: `strokeIn` > 0 (`:62-69`); a line is a box with `h` or `w` = 0; filled bar = `strokeIn ≥ h`.
- Anything else: `"unknown type"` (`:175-176`). Problems collected per element and raised as `DesignError` (`:17-20, 178-181`).
- **Portal TS gap**: `labelModel.ts:12-13` declares `TextEl` without `reverse`/`lines` and `BarcodeEl` without `moduleIn`; the reducer's spread (`:104-107`) preserves them on round-trip, but no UI reads or writes them.
- Storage: `LabelTemplate` (`api/db/models.py:1672-1705`): `kind` design/code, `design` JSONB, `code` text (exactly one, CHECK 0042 + `routes/labels.py:389-392, 444-451`), `label_type`/`size_key`/`dpi_key`/`language_key` vocab keys, `version` bumped on every change (`routes/labels.py:480-482`), `generation_rules` JSONB default `{}` (`:1697-1702`), `site_links` (`:1727-1735`; none = global).
- Vocabularies (`LabelVocab` `models.py:1639-1653`; meta validated `routes/labels.py:68-82`): `size.meta = {width_in, height_in, has_tab}` seeded `4x2, 2x1, 4x3-tab, 1x1, 6x4, id-badge 3.375×2.125` (`0042_labels.py:36-41`) + `4x6` (`0066:130-133`); `dpi.meta = {dots}` 203/300; `language.meta = {family}` zpl/escp/ptouch; `type` top/front/rail/container + `container_info` (`default_copies`). Edits are devtools-gated on Variables › Labels (`routes/labels.py:118-122, 207-212`; `portal/components/variables/LabelsTab.tsx`).
- New-element defaults (`newElement`, `labelModel.ts:58-77`): ids `t1/b1/q1/l1/x1…`, all at (0.2, 0.2); text 1.5×0.25 in "Text" 10 pt left; barcode 2×0.5 code128 `{asset_id}`; qr 0.6×0.6 `{asset_id}`; line 1.5×0 stroke 0.01; box 1.5×1 stroke 0.02.

### 5b. What the UI does today (`portal/pages/LabelTemplateEditor.tsx`, routes `/labels/templates/new?kind=design|code`, `/labels/templates/:id/edit`; grid `180px / 1fr / 260px` `portal/styles/labels.css:22`)

- ✓ Top bar: name, description, Type/Size/DPI/Language selects (`:204-231`); size change dispatches `setSize` (`:115-122`); deactivated-but-current vocab spliced back (`:188-193`)
- ✓ Zoom fixed 1x / 1.5x / 2x (`:32, 234-238`; canvas = 96 css-px/in × zoom, `EditorCanvas.tsx:21, 52-53`)
- ✓ Undo/Redo buttons (`:239-246`; snapshot history cap 100, `labelModel.ts:5-6, 39, 88-96, 130-143`; one entry per drag, `EditorCanvas.tsx:10-13`; selection not undoable)
- ✓ Palette `+ Text / + Barcode / + QR / + Line / + Box` (`ElementPalette.tsx:18-24`)
- ✓ Layers list, top first, with ↑ ↓ ✕ (`ElementPalette.tsx:29, 41-58`; `reorder` swaps adjacent, `labelModel.ts:115-122`)
- ✓ SVG canvas in inches (`EditorCanvas.tsx:140-147`): click-select, background click clears (`:148`), drag-move with pointer capture (`:73-82, 95-106`), **one** bottom-right resize handle changing w and h together (`:168-177, 84-93, 103`), snap to 0.025 in (`:22`; `snap()` `labelModel.ts:40-44`), gridlines every 0.25 in (`:23, 131-137`), arrow-key nudge one step (`:108-129`), clamp to label (`clampToLabel` `labelModel.ts:79-86`; `EditorCanvas.tsx:60-71`), tab outline for `has_tab` (`:150`), rotation drawn about the element origin (`:159`)
- ✓ Canvas rendering "layout-true but glyph-approximate" (`EditorCanvas.tsx:3-5`): text = one `<text>` at baseline `y + fontSize`, `fontWeight 700` when bold (`:189-203`); barcode = 12 fake bars + data (`:205-226`); QR = crosshatch + data (`:228-237`); line/box stroke only (`:239-247`); **raw `{token}` text, never sample values** (`:201`)
- ✓ Properties panel (`PropertiesPanel.tsx`): X/Y/W/H step 0.025 (`:72-90`); Rotation select (`:24, 92-95`); Text: content textarea, font size pt, align, Bold checkbox (`:99-130`); Barcode: data, symbology, show text (`:133-155`); QR: data (`:158-165`); Line/Box: stroke (`:168-179`); "Insert variable…" select of `label — sample_value` filtered by `applies_to ∋ label_type` (`portal/lib/labels.ts:75-81`; panel `:182-193`) that **appends** `{key}` (`:57-66`); Delete element (`:196-198`)
- ✓ Generated-code panel (`CodePanel.tsx`): debounced 500 ms `POST /labels/templates/compile` `mode: 'sample'` (`:34-63`) substituting `sample_value` server-side (`routes/labels.py:491-493, 527`); "Printer preview" (ZPL only, `:93-97`) → `/labels/preview/zpl` Labelary PNG (`:70-80, 99-101`); validation problems listed under the panel (`:51-55, 91`), not on the canvas
- ✓ Sites tag input (`:262-267`); Generation rules panel (`:269`); Save (`:254-258`); one-way "Edit as raw ZPL/code" with `window.confirm` (`:157-170, 249-253`; list row menu `LabelTemplates.tsx:388-398`); code kind = mono textarea (`:273-277`)
- ✗ Keyboard shortcuts (Ctrl+Z, Delete, Ctrl+C/V), copy/paste/duplicate, multi-select, marquee, alignment/smart guides, distribute/align commands, rulers, free zoom/fit, pan (grep `ctrlKey|metaKey|clipboard|paste|duplicate|dirty|beforeunload|Delete'|Backspace|shiftKey|multi|guide` across the five editor files: no hits)
- ✗ Dirty indicator / unsaved-changes guard (promised at `docs/superpowers/specs/2026-09-01-labels-design.md:218`, not built)
- ✗ Per-side resize handles, aspect lock, rotation handle
- ✗ Font selection (every text → `^A0`); the font library (`~DY` upload, `routes/labels.py:940-1084`; `api/labels/template_fonts.py`) matters only to **code** templates (`_fonts_used_by` scans `.code`, `routes/labels.py:962-972`; `fonts_used()` looks for `^A@…E:NAME.TTF` / `^CWa,E:NAME.TTF`, `template_fonts.py:22-30`)
- ✗ Real bold weight (1.2× width only, `zpl.py:7-8, 49`)
- ✗ Inverted/knockout, multi-line wrap, barcode module width — in the model (`reverse`, `lines`, `moduleIn`) but **no UI, no canvas rendering**
- ✗ Sample values on the canvas; per-template or per-part example values
- ✗ Number/length-aware display types, split fields, expected-character-length padding, conditional visibility, images/logos, other symbologies (spec out of scope `2026-09-01-labels-design.md:260`)
- ✗ Any WYSIWYG preview of ESC/P or P-touch beyond the canvas (`2026-09-01-labels-design.md:30-32`)
- ✗ Split tokens in the Insert-variable picker (lists catalog placeholders only, `PropertiesPanel.tsx:55`); rules and canvas are disconnected

### 5c. How a design compiles

- Route resolves vocab rows → `compile_design(design_json, width_in, height_in, dots, language_key, subs)` (`api/labels/compile.py:39-46`) → `parse_design` with size overridden (`:45`) → dispatch `zpl|escp|ptouch` (`:27-36`; else `UnsupportedLanguage` → 422 `unsupported_language`, `routes/labels.py:513-514`). Callers: `_compile_design` `routes/labels.py:496-514`; generation `api/labels/generate/engine.py:13-20`; kiosk sync `api/labels/kiosk_templates.py:129-146`. **One inch-based JSON is compiled per DPI; 203 and 300 templates are separate rows sharing the JSON** (0066 seeds both from one dict `0066:103-115`; `family_name` strips " - 203DPI", `kiosk_templates.py:38-46`).
- `compile_zpl(design, dpi, substitutions)` (`api/labels/zpl.py:87-103`): `^XA ^PW{round(w*dpi)} ^LL{round(h*dpi)} ^CI28` … `^XZ`; `_dots(v) = round(v*dpi)` (`:18-19`).
  - Substitution `_fd()` (`:32-41`): literals hex-escaped behind `^FH_` (`^ ~ _ \` and non-ASCII → `_xx`, `:22-29`); tokens pass through when `subs is None` (storage/kiosk form) or are substituted and escaped (`:37-38`).
  - Text `_text` (`:47-58`): `h = round(pt*dpi/72)`, `w = round(1.2h) if bold else h`; `^FO{x},{y}`; `^FB{w_dots},{lines},0,{L|C|R},0` **only when** `align != left or lines > 1` (`:53-54`); `^A0{N|R|I|B},{h},{w}`; `^FR` when `reverse`; `^FH_^FD…^FS`. Element `h` unused.
  - Barcode `_barcode` (`:61-71`): `^BY{2 | clamp(1..10, round(moduleIn*dpi))}`; code128 `^BC{rot},{h},{Y|N},N,N`, code39 `^B3{rot},N,{h},{Y|N},N`. Element `w` unused.
  - QR `_qr` (`:74-77`): `^BQ{rot},2,{clamp(1..10, round(w_dots/25))}`, `^FDQA,{data}`. `h` unused; steps coarse (`api/tests/test_container_zpl_templates.py:212-219`).
  - Line/Box `_shape` (`:80-84`): `t = max(1, stroke)`, `^GB{w},{h},{t}`; rotation ignored; filled bar = box with `strokeIn ≥ h` (0066:46-47 → `^GB731,162,162`).
  - Everything absolute `^FO`; no `^LH`, `^FT`, `^PR`, `^MD`, print mode, copies, or `^XG` graphics.
- Previews: Labelary proxy `POST /labels/preview/zpl` (`routes/labels.py:574-591`), dpmm map `{203: 8, 300: 12}` only (`:571, 583-585`; `api/labels/labelary.py:12-26`).
- Brother: `brother_escp.py` (line-oriented reading order; ignores shapes/rotation/`reverse`/`lines`/`module_in`, docstring `:1-13`) and `brother_ptouch.py` (printer-resident template `001`, objects `obj1..N`, `:1-12`); both "FIRST PASS"; spec `2026-09-16-container-labels-zpl-design.md:136-137` says they honor `lines` — code and spec disagree.
- Generation: `render_template` (`api/labels/render.py:37-59`) compiles with `subs=values` and reports unknown tokens (`:51-56`); laptop Label Station renders from the `design` JSON "never from its token-intact compiled code" (`kiosk_laptop/edge/src/edge/labels/generate.py:1-26`); kiosk sync sends design templates pre-compiled with tokens intact plus `design` and `generation_rules` (`kiosk_templates.py:129-146`; `kiosk.py:1186, 1190`; `schemas.py:3511-3550`).
- Tests pinning output: `api/tests/test_labels_zpl.py` (goldens `^XA\n^PW812\n^LL406\n^CI28\n^FO51,102^A0N,34,34^FH_^FDHello^FS\n^XZ` `:12-20`; `^FR` `:89-95`; `^FB731,2,0,L,0` `:98-103`; `^BY2`/`^BY3` `:106-112`; byte-identical when the three new props are absent `:115-129`), `test_labels_design_model.py:27-103`, `test_container_zpl_templates.py:166-261` (203-vs-300 physical equivalence), `test_label_generate_values.py` (split `:143`, out-of-range unset `:152`, limits `:160-176`), `test_kiosk_label_templates_sync.py:336-527`, portal `labelModel.test.ts`, `EditorCanvas.test.tsx`, `PropertiesPanel.test.tsx`, `CodePanel.test.tsx`, `GenerationRulesPanel.test.tsx`, `LabelTemplateEditor.test.tsx:97-244`.

### 5d. `generation_rules` shape

```json
{ "destination":   { "1": "nap", "2": "sector", "3": "pod", "4": "row", "5": "rack" },
  "source":        { "1": "nap", … },
  "length_limits": { "asset_name": 20 } }
```
- Validation `_validate_generation_rules` (`routes/labels.py:264-302`): unknown top-level keys rejected; each side must be an object (explicit `null` is an error); position keys positive-integer strings; token names `^[a-z0-9_]+$` (`:262`); `length_limits` values positive ints, bool rejected; all problems returned → 422 `bad_generation_rules` on create (`:396-398`) and update (`:452-455`). Column from `0055_generate_labels.py:131`. Portal type `portal/lib/api.ts:5285-5289`.
- UI `portal/components/labels/GenerationRulesPanel.tsx`: always-visible section under Sites for both kinds; Destination/Source rows `Pos → token_name` (`:16-47, 95-98`), Length limits `token_name ≤ N` (`:49-80, 99`); string rows (`generateLabels.ts:136-145`), `jsonToRuleRows`/`ruleRowsToJson` (`:155-191`, blank rows dropped), `validateRuleRows` blocks Save (`:196-215`; editor `:124, 127, 255`).

---

## 6. Competitor checklist (table stakes)

ZD = ZebraDesigner 3 (E = Essentials free, P = Professional ≈ $295 one-time, Windows-only, per-PC license); BT = BarTender (S = Starter $199/yr, P = Professional $299/yr, A = Automation $575/yr, E = Enterprise; Windows-only; printer-count licensing; Cloud Essentials $390/yr). Sources: ZD-UG = ZebraDesigner 3 Pro User Guide Rev-2025-5 (line refs into the scratchpad extract `zd3pro-ug.txt`); BT-CMP21 = BarTender 2021 edition comparison; BT-HELP = help.seagullscientific.com pages as cited in the competitor report.

### Canvas

| Feature | ZD | BT | Note |
|---|---|---|---|
| Rulers in label units | E/P | S/P/A | ZD-UG L2104-2106 |
| Grid with configurable X/Y spacing + offset; snap to grid | E/P | S/P/A | ZD-UG L1202-1209 |
| Snap to objects / smart alignment lines; Shift to suspend | E/P (align to objects) | S/P/A (+ template boundaries, center lines; Shift-drag) | ZD-UG L1207-1208; BT SnapBehavior |
| Zoom to document / to objects / typed % / Ctrl+wheel | E/P | S/P/A (Fit to Window, zoom tool) | ZD-UG L1173-1183 |
| Align L/C/R/T/M/B; distribute H/V | E/P | S/P/A (+ center in region) | ZD-UG L1078-1095; BT Toolbar_Arrange |
| Make same size | n/f | n/f | neither documents it |
| Nine-point anchoring + growth direction for variable-size objects | E/P (Ctrl+click placeholder) | yes | ZD-UG L547-548, L1299-1301 |
| Lock position; group/ungroup | E/P | lock yes; groups n/f | ZD-UG L1305, L1100 |
| Layers (stack, hide, reorder, lock) | none | P/A/E | BT-CMP21 p2 |
| Measurement units incl. **dots** | E/P (cm/in/mm/dot) | in/cm/mm | ZD-UG L2525-2526 |
| Printable-area indicator; rotate design surface 90° | E/P | n/f | ZD-UG L2110-2111, L1213-1219 |
| Format painter; object markers | E/P | n/f | ZD-UG L1013-1016, L1185-1191 |
| Keyboard shortcuts (Ctrl+B/I, zoom, nudge) | E/P | yes | ZD-UG L572-598 |

### Objects

| Feature | ZD | BT | Note |
|---|---|---|---|
| Single-line auto-growing text | E/P | all | ZD-UG L2660-2664 |
| Fixed-width wrapped paragraph text box | **no** | all (Wrap Width) | ZD-UG L2655-2690 |
| Auto-fit (shrink/grow text to box) | **no** | all | BT HIDD_FITPAGE; ZD-UG L2770-2772 |
| Justified alignment, line + character spacing, RTL | E/P | yes | ZD-UG L1749-1757, L2736-2746 |
| 1D barcodes (Code 39/128 A-B-C/93, GS1-128, EAN/UPC, ITF, DataBar, USPS IMb …) | E/P native ZPL | 105 symbologies | ZD-UG L3760-4436 |
| 2D (Aztec, DataMatrix, PDF417, MicroPDF, QR, Micro QR, GS1 QR, MaxiCode) with ECL/version/encoding | E/P | yes (+ iQR, composites, postal) | ZD-UG L4575-4651 |
| Barcode geometry: X-dim, ratio, height, quiet zone, bearer, check digit, human-readable options | E/P | all | ZD-UG L1383-1394, L3527-3644 |
| Printer-element vs graphic rendering choice | E/P | yes | ZD-UG L1272-1279, L3700-3715 |
| Images (png/svg/jpg/bmp/…) embedded, dithering | E/P | all (70+ formats; P: dynamic images) | ZD-UG L2826-2900 |
| Shapes: rectangle (corner radius), line, ellipse, outline + fill | E/P | 50+ shapes | ZD-UG L1504-1559, L2975-3306 |
| **Inverse / white-on-black** | E/P: dedicated Inverse object + text Inverse effect | all: one-click white-on-black; page Negative | ZD-UG L3349-3351, L1756, L2747; BT-CMP21 p1 |
| Rotation any angle (typed/slider/handle) | E/P | yes (0.1°; barcodes 90/180/270) | ZD-UG L1297, L2775-2782 |
| Tables / grids (DB-filled) | none | all (P: DB-sourced) | BT Objects_TypesOfObjects |
| RFID encode object | P | P | ZD-FS L50; ZD-UG L1833-2080 |
| Per-object name/description, Not-printable, Visible flags | E/P | yes | ZD-UG L2797-2818 |
| Label background picture | E/P | yes | ZD-UG L2618-2641 |

### Data

| Feature | ZD | BT | Note |
|---|---|---|---|
| Fixed data; keyboard-input prompts with data types, initial value, required, order | E/P | all (P/A: forms with 15+ controls) | ZD-UG L5159-5260 |
| Database (Excel/Access/text/ODBC; filter/sort/SQL; pick records at print) | **P only**, single table | S: Excel/CSV; P: 20+ sources | ZD-UG L5900-5947; ZD-FS L46-47 |
| Counter / serialization (step, rollover, remember last, printer-internal) | E/P | S: +1 only; P: alphanumeric/custom, reset events, preserve char count | ZD-UG L5658-5786 |
| Date/time variables with format tokens; printer RTC; date offset | E/P | all (offset transform) | ZD-UG L5463-5560 |
| Concatenation with delimiter / ignore empty | P | S/P | ZD-UG L5833-5880 |
| Substring / truncate / character template / search-replace | P (VBScript only) | all (Truncation, Character Template `?`/`%`/`@x`, Search & Replace) | BT HIDD_TRIMPAGE, CharacterTemplate |
| **Split on delimiter into child fields** | **none** | **none** | script only in both |
| **Padding / fixed length / expected character count** | E/P: Limit length, Fixed length (exact N), Prefix/Suffix | all: min chars + Pad On left/right + pad char, max chars, print-time warnings | ZD-UG L5217-5248, L5753-5786; BT HIDD_NUMBER_OF_CHARACTERS_DIALOG |
| Number formatting (decimals, separators) | E/P (Floating point / Currency) | yes | ZD-UG L5343-5404 |
| Case transforms (upper/lower) as a GUI option | n/f | n/f (script) | — |
| Conditional print / visibility by data | **no** (static flags) | P/A/E (When to Print; layers; template selector; Suppression) | BT conditional-printing article |
| Reuse a value in another object | E/P (Link to Another Object) | yes (Object Value) | ZD-UG L5807-5820 |
| **Sample / example values at design time** | counter preview, date sample, RFID dummy | P: dynamic data preview, Live Database View | ZD-UG L5673-5676, L5254, L2050-2056; BT-CMP21 p2 |
| Validation / range check / character filter | E/P (range) | yes | ZD-UG L5220-5228 |
| VB scripting | P | all | ZD-FS L54 |

### Fonts

| Feature | ZD | BT | Note |
|---|---|---|---|
| Printer-resident fonts listed separately (toggle, icon) | E/P | with Seagull drivers | ZD-UG L1047-1049, L1719-1726 |
| TrueType sent as graphics vs printer text | E/P | yes (PrintMethod) | ZD-UG L4985-4990 |
| Bold / Italic / Underline / Strikethrough; width scaling % | E/P (scaling 50-200 %) | yes | ZD-UG L1727, L1735-1741 |
| Unicode; bundled OCR-A/B; custom .ttf upload | E/P; —; — | yes; yes; Cloud Font Manager | ZD-FS L42; BT-PRICE |

### Print

| Feature | ZD | BT | Note |
|---|---|---|---|
| DPI via driver; dot unit | E/P | 12,000+ drivers | ZD-UG L2525 |
| Speed/darkness in print pane, saved to label | E/P | yes | ZD-UG L4819-4835 |
| Print preview | E/P | all | ZD-UG L4921-4934 |
| Offsets (H/V) | driver page setup | Cloud print page; driver | BT Print_PrintPage |
| Quantity / copies / sets / skip N / unlimited | E/P | all (copies per serial) | ZD-UG L4836-4878 |
| Print to file / export printer code (ZPL) | E/P | yes (Printer Code Template) | ZD-UG L4826 |
| Store format on printer + recall | E/P | — | ZD-UG L765, L817-856 |
| Use printer-internal fonts/elements/counter | E/P | yes | ZD-UG L1272-1279 |
| Stock library / label setup wizard | E/P | yes | ZD-UG L2365-2612 |
| Remote/web printing, reprint console | — | E / Cloud | BT Print Portal |

### Templates

| Feature | ZD | BT | Note |
|---|---|---|---|
| Sample/industry templates | E/P | 400+ | ZD-UG L784-785 |
| **Versioning / revision history** | **none** | on-prem revision log; Librarian (E); Cloud revision control | BT-PRICE |
| Locking / password / protected actions | position lock only | layer lock + document password | BT LayerSecurity |
| Sharing / central storage | file share | Librarian / Cloud | BT-PRICE |
| Intelligent templates (layers, conditional, selector) | — | P/A/E | BT-CMP21 p2 |
| Printer settings stored in label | E/P | — | ZD-UG L5018-5030 |

**Gaps in both a web builder can exploit**: no native split-on-delimiter into child fields; no GUI case transform; no "expected character length" preview at design time (BT pads at print time, ZD only validates); no browser/Mac access except BarTender Cloud ($390+/yr); no template versioning in ZD at any price; no conditional printing in ZD; no wrapped/auto-fit text box in ZD; Windows-only desktop apps; BT printer-count licensing and license-server dependency are the most-cited pain points.

---

## 7. Open questions the builder design must settle

1. **Split source column.** The dotted string is `source_rack`/`destination_rack`, but today's split input is `source_raw = source_position or source_rack` (`label_values.py:138-139`), which turns into `Front` on the one row with a position. Does the builder bind Split to the rack column directly and expose Front/Rear as its own field, and does `source_raw`/`destination_raw` keep its position-first rule for existing templates?
2. **Split grammar.** Is `.` the only separator? How are no-dot values (`ORD1-F01`, 1,691 source rows) handled — one part = whole string, blank sub-fields, or a fallback element? What about parenthesized free text with commas (`AN17 (Room=N (Singapore,SGD,3))`), and the letter-suffixed part moving between position 3 (`14.01.07C.02.03`) and position 4 (`11.01.01.01A.02`)? Should a mismatch between the sample's part count and a real value's part count print blank, print the whole string, or flag the asset?
3. **Where split part names live and who owns them.** V2 named parts per template (`dest_nap …`); the stored templates use site-specific vocabularies (Vegas nap/sector/pod/row/rack, Amsterdam floor/room/pod/row/rack); the kiosk mock uses 3 parts. Is the vocabulary per template, per site (`site_links`), or a system catalog with sample values — and should split parts become catalog entries so the Insert-variable picker, `sample_value` and `applies_to` cover them?
4. **"Pod" and "RU" collisions.** Split part 3 ("pod") vs `initiative_assets.source_pod/destination_pod` and `assets.pod_number` (migration 0069 says Nap 14 pods are numbered separately); banner `{ru}` vs `{destination_ru}` (`13` vs `U13`) and fractional RUs (`3.5`, `33.2`). Which one prints, and does the "number" display type own the `U` prefix / decimals / zero-padding?
5. **Where values are computed at print time.** Portal generator applies `generation_rules`; the kiosk asset sync does **not** (`kiosk.py:999`) while `/kiosk/sync/label-templates` sends `design` + `generation_rules`; the kiosk test-render splits server-side. With labels now built on the kiosk, is the rule "edge recomputes everything from raw columns + template rules" (and the portal generator must match byte-for-byte), or does the sync grow new keys?
6. **Example values.** Three scopes exist or are wanted: catalog `sample_value` (global), per-template examples (no home today; `label_info` is unused jsonb but is per-asset-per-move), and per-split-part samples. Where are they stored, and does a template carry a site-shaped sample raw string (`14.01.07C.02.03`) so the canvas can show real spacing?
7. **"Expected character length" semantics.** Is it (a) size the element to N glyphs of the chosen font at its size (needs real glyph metrics for `TT0003M_.TTF`/`^A0` in both canvas and compiler), (b) pad left/right with a character, (c) truncate (today's `length_limits`), (d) warn at print, or a combination — and does it drive `^FB` width / alignment inside a fixed cell?
8. **Fonts.** Today every design text compiles to `^A0` and the font library only serves code templates. Which fonts does the builder offer (resident `0`, resident `TT0003M_.TTF` via `^CW`, uploaded `E:` TTFs via `^A@`), how does the canvas get matching metrics, and does "Bold" become a real font object instead of the 1.2× stretch (`zpl.py:49`)?
9. **Inverted.** Per-element `^FR` over an auto-built filled box vs label-level `^LRY`; what is the padding rule (Vegas: 20 left / 10 above / 20 below) and is it editable; does `BoxEl` gain `fill` (and color/rounding `^GB…,B,r`); and what prints when the value is blank (today a solid black block with nothing in it — see `UNTAGGED_LABEL`, `label_values.py:20-23`)?
10. **Anchoring and resize.** The compiler ignores text `h`, barcode `w`, QR `h`, and shape rotation; it only emits `^FO`. With resizing in the UI, which dimension controls what (font size from box height? barcode module from width? QR magnification from width in 25-dot steps capped at 10?), and is `^FT` baseline anchoring added so existing templates can be reproduced?
11. **Barcode / QR options.** Does the builder expose Code 128 mode (A vs N), interpretation-line font, `^BY` module/ratio, QR magnification, EC level, and the `<`/`M<` data prefix the Vegas/V2 templates emit — and what do the scanners actually expect in the QR payload (asset_id vs uuid)?
12. **Label-level settings.** `^MMT`, `^PR`, `^LS`, `^PQ`, copies, darkness: template properties, kiosk print-time settings (today's `/labels/print` settings modal), or both?
13. **Catalog expansion and sync.** Which non-catalog fields does the builder list (sites.code, client name/code, pods, owner, cable `data_n`/`mgmt_n`, category, ru_size/form_factor, status labels, container label_tag on asset rows, truck/load)? Most are absent from `/kiosk/sync/assets`; every exposed field needs a sync column or an edge-side join.
14. **Multi-DPI.** One inch-based design already compiles per DPI; do 203/300 remain separate template rows (today's `family_name` grouping) or one template with DPI chosen by the printer at print time?
15. **Migration of the six stored code templates.** Code→design conversion is "impossible by design" (`2026-09-01-labels-sites-and-convert-design.md:121`): rebuild Vegas/Amsterdam/Generic/Front in the builder by hand, or keep them as code? Fix `{'asset serial number'}` in the two **active** Generic templates and the active no-size Switch Front Tag now, independent of the builder?
16. **Site-specific selection.** `pick.py:47` order is destination → source → global → generic. With per-site split vocabularies, is a template bound to a site (as today) or does the site carry its location grammar and one template serve many sites?
17. **Portal model scope.** `labelModel.ts` lacks `reverse`/`lines`/`moduleIn`; is the new element vocabulary (display type, split children, length, inverted, font) an extension of the current `Design` JSON or a new schema version, and must the Brother compilers (`brother_escp.py`, `brother_ptouch.py`) honor it or is the builder Zebra-only?
18. **Unknown/legacy tokens.** Quoted tokens pass through silently and unknown bare tokens blank; should the builder refuse anything not in the catalog or split vocabulary, and should `render.py` report quoted spellings?
19. **Date handling.** Dev `scheduled_start` values are 05:00/13:00 UTC, not midnight; `stored_day` takes UTC date parts. Does the label's move date follow the site's timezone, the UTC day, or a date-only column?
20. **Conditional visibility.** Should an element (or its inverted box) be hidden when its value is blank (moves with no destination print `source_ru 'U0'` and empty destination fields today), and is that a per-element flag or a rule?