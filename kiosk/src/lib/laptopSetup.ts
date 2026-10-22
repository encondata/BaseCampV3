/**
 * The laptop's finished Kiosk Setup, shared with every browser that uses
 * it (D2). The edge keeps the last setup the cloud accepted and serves it at
 * GET /edge/setup; a browser on the laptop or on the LAN with no complete
 * local setup loads it, marks itself set up, and downloads the move data —
 * as Kiosk Setup does after saving — instead of starting blank.
 *
 * Laptop mode only: a web kiosk keeps its own browser-local setup.
 */

import { getEdgeSetup, type EdgeSetup } from './api';
import { readKioskSetup, writeKioskSetup, type KioskSetupSelection } from './kioskSetup';
import { isLaptop } from './platform';
import { isSetupComplete, readSetupState, writeSetupState } from './setupState';
import { runSync } from './sync';

function hasLocalSetup(): boolean {
  return readKioskSetup() !== null && isSetupComplete(readSetupState());
}

function str(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A Time Clock setup may have no move, no site, and no scan type; those
 *  become the "No move" / "No site" selection. A move or site that is set
 *  still needs its name (and, for a move's site, its role). */
function timeclockSelection(setup: EdgeSetup): KioskSetupSelection | null {
  const { initiative_id, initiative_name, site_id, site_name, site_role } = setup;
  const hasMove = initiative_id != null && initiative_id !== '';
  const hasSite = site_id != null && site_id !== '';
  if (hasMove && !str(initiative_name)) return null;
  if (hasSite && !str(site_name)) return null;
  let role: KioskSetupSelection['siteRole'] = 'none';
  if (hasSite) {
    role = hasMove && (site_role === 'source' || site_role === 'destination') ? site_role : 'other';
  }
  return {
    initiativeId: hasMove ? initiative_id : '',
    initiativeName: hasMove ? (initiative_name as string) : 'No move',
    siteId: hasSite ? site_id : '',
    siteName: hasSite ? (site_name as string) : 'No site',
    siteRole: role,
    scanStatus: '', scanLabel: '',
    stationType: 'timeclock',
  };
}

/** The kiosk's cached selection from the edge's copy; null when the copy
 *  is missing a field the summary needs. */
export function selectionFromEdge(setup: EdgeSetup | null): KioskSetupSelection | null {
  if (!setup || typeof setup !== 'object') return null;
  const { initiative_id, initiative_name, site_id, site_name, site_role, scan_status,
    scan_status_label, station_type, reader } = setup;
  if (station_type === 'timeclock') return timeclockSelection(setup);
  if (!str(initiative_id) || !str(initiative_name) || !str(site_id) || !str(site_name)
      || (site_role !== 'source' && site_role !== 'destination')
      || !str(scan_status) || !str(scan_status_label)) return null;
  const selection: KioskSetupSelection = {
    initiativeId: initiative_id, initiativeName: initiative_name, siteId: site_id,
    siteName: site_name, siteRole: site_role, scanStatus: scan_status, scanLabel: scan_status_label,
  };
  if (station_type === 'label' || station_type === 'rfid') selection.stationType = station_type;
  if (station_type === 'rfid' && reader && str(reader.ip) && str(reader.serial) && str(reader.model)) {
    selection.reader = { ip: reader.ip, serial: reader.serial, model: reader.model };
  }
  return selection;
}

/** A Label Station's setup is saved at Site, before its label kind and
 *  printer (steps 4-5): it only counts as finished once those are saved,
 *  i.e. when the edge's copy carries `label_station`. Otherwise a reload or
 *  a second browser mid-setup would skip the printer step. */
export function edgeSetupComplete(setup: EdgeSetup | null): boolean {
  if (!setup || typeof setup !== 'object') return false;
  if (setup.station_type === 'label') {
    return typeof setup.label_station === 'object' && setup.label_station !== null;
  }
  return true;
}

let inFlight: Promise<EdgeSetup | null> | null = null;

/** One GET /edge/setup shared by concurrent callers; null on any failure. */
function fetchShared(): Promise<EdgeSetup | null> {
  inFlight ??= getEdgeSetup().catch(() => null).finally(() => { inFlight = null; });
  return inFlight;
}

/** Loads the laptop's setup when this browser has none (or an incomplete
 *  one). True when it did. Never throws.
 *
 *  `lockedMove` is a move-password session's move: such a session is
 *  limited to that move, so the laptop's setup for any other move is never
 *  taken (checked once the edge has answered). */
export async function hydrateLaptopSetup(lockedMove: string | null = null): Promise<boolean> {
  if (!isLaptop() || hasLocalSetup()) return false;
  const shared = await fetchShared();
  const selection = selectionFromEdge(shared);
  if (!selection || !edgeSetupComplete(shared)) return false;
  if (lockedMove && selection.initiativeId !== lockedMove) return false;
  // a setup finished in this browser while the edge answered wins
  if (hasLocalSetup()) return false;
  writeKioskSetup(selection);
  writeSetupState('complete');
  void runSync(selection.initiativeId, selection.initiativeName);
  return true;
}
