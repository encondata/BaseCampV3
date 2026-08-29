/**
 * One tile source for every Leaflet map in the portal.
 *
 * Esri World Street Map rather than openstreetmap.org: OSM's raster
 * tiles label places in each region's local language/script with no way
 * to override, while Esri's street basemap uses English/anglicized
 * names for most of the world. (A guaranteed-English map everywhere
 * would need vector tiles + MapLibre — revisit if this basemap isn't
 * English enough.)
 */

export const MAP_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';

export const MAP_TILE_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, OpenStreetMap contributors';
