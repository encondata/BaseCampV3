import { beforeEach, expect, it } from 'vitest';

import { checkTagEntry } from './enrollGate';
import { clearEnrollLog, noteTagHolder, recordEnrollment } from './enrollLog';
import { buildScanIndex, type ScanAsset } from './scanMatch';

const SWITCH: ScanAsset = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: null,
  serial_number: 'SN-4242', make: 'Cisco', model: 'Nexus 9000',
  make_model: 'Cisco Nexus 9000',
};
const PANEL: ScanAsset = {
  id: 'a-2', asset_id: '10043', name: 'Patch panel', rfid: '000000000000000000100348',
  serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '',
};

const index = buildScanIndex([SWITCH, PANEL]);
const PADDED = (v: string) => v.padStart(24, '0');

beforeEach(() => { clearEnrollLog(); });

it('passes a clean tag through, padded to the stored format', () => {
  expect(checkTagEntry(index, SWITCH, '200500')).toEqual({ ok: true, tag: PADDED('200500') });
});

it('passes the padded form of the tag this asset already has', () => {
  // Re-scanning the same tag changes nothing but is still a real scan —
  // the endpoint records it and answers already_had_tag.
  expect(checkTagEntry(index, PANEL, '100348')).toEqual({ ok: true, tag: PADDED('100348') });
});

it('refuses a value the stored format cannot hold', () => {
  expect(checkTagEntry(index, SWITCH, '   ')).toEqual({
    ok: false, message: 'Scan the RFID tag.',
  });
  expect(checkTagEntry(index, SWITCH, '0'.repeat(25))).toMatchObject({ ok: false });
  expect(checkTagEntry(index, SWITCH, 'AB-12')).toMatchObject({ ok: false });
});

it("refuses this asset's own ID — the double scan this gate exists for", () => {
  expect(checkTagEntry(index, SWITCH, '10042')).toEqual({
    ok: false,
    message: "That's this asset's own asset ID, not an RFID tag.",
  });
});

it("refuses this asset's own serial, however it is cased", () => {
  expect(checkTagEntry(index, SWITCH, 'sn4242')).toMatchObject({ ok: true });  // not the serial
  expect(checkTagEntry(index, PANEL, 'fdo2140x9zz')).toEqual({
    ok: false,
    message: "That's this asset's own serial, not an RFID tag.",
  });
});

it('refuses another asset\'s ID or serial, and names it', () => {
  expect(checkTagEntry(index, SWITCH, '10043')).toEqual({
    ok: false,
    message: "That's the asset ID for Patch panel, not an RFID tag.",
  });
  expect(checkTagEntry(index, PANEL, 'SN-4242')).toMatchObject({ ok: false });
});

it('refuses a tag the synced roster already has on another asset', () => {
  expect(checkTagEntry(index, SWITCH, '100348')).toEqual({
    ok: false, message: 'That tag is already on Patch panel.',
  });
});

it('refuses a tag this session just enrolled on another asset', () => {
  recordEnrollment({ tag: '200500', assetId: 'a-2', assetName: 'Patch panel' });
  expect(checkTagEntry(index, SWITCH, '200500')).toEqual({
    ok: false, message: 'That tag is already on Patch panel.',
  });
});

it('refuses a tag the portal itself refused a moment ago', () => {
  noteTagHolder('200500', 'a-9', 'Rack 9 PDU');
  expect(checkTagEntry(index, SWITCH, '200500')).toEqual({
    ok: false, message: 'That tag is already on Rack 9 PDU.',
  });
});

it('lets an asset keep a tag this session gave it', () => {
  recordEnrollment({ tag: '200500', assetId: 'a-1', assetName: 'Rack 4 switch' });
  expect(checkTagEntry(index, SWITCH, '200500')).toMatchObject({ ok: true });
});

it('names an unnamed asset by its ID rather than saying "null"', () => {
  const unnamed: ScanAsset = { ...PANEL, id: 'a-3', asset_id: '10044', name: null, rfid: null };
  const idx = buildScanIndex([SWITCH, unnamed]);
  expect(checkTagEntry(idx, SWITCH, '10044')).toEqual({
    ok: false, message: "That's the asset ID for 10044, not an RFID tag.",
  });
});
