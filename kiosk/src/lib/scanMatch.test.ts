import { expect, it } from 'vitest';

import { buildScanIndex, matchScan, scanTypeFor, type ScanAsset } from './scanMatch';

const rows: ScanAsset[] = [
  {
    id: 'a-1', asset_id: '10042', name: 'Rack 4 switch', rfid: '000000000000100348',
    serial_number: 'sn-4242', make: 'Cisco', model: 'Nexus 9000', make_model: 'Cisco Nexus 9000',
  },
  {
    id: 'a-2', asset_id: '10043', name: 'Patch panel', rfid: null,
    serial_number: 'FDO2140X9ZZ', make: null, model: null, make_model: '',
  },
  {
    id: 'a-3', asset_id: 'A-99', name: 'No tags', rfid: '', serial_number: null, make_model: '',
  } as ScanAsset,
];

const index = buildScanIndex(rows);

it('matches an RFID tag with or without its leading zeros, any case', () => {
  for (const raw of ['000000000000100348', '100348', '  100348  ']) {
    expect(matchScan(index, raw)).toMatchObject({ kind: 'rfid', asset: { id: 'a-1' } });
  }
});

it('matches an RFID tag case-insensitively', () => {
  const hex = buildScanIndex([{ ...rows[0], rfid: '00000000E28011AB' }]);
  expect(matchScan(hex, 'e28011ab')).toMatchObject({ kind: 'rfid' });
  expect(matchScan(hex, 'E28011AB')).toMatchObject({ kind: 'rfid' });
});

it('matches an asset ID, case-insensitively', () => {
  expect(matchScan(index, '10043')).toMatchObject({ kind: 'asset_id', asset: { id: 'a-2' } });
  expect(matchScan(index, 'a-99')).toMatchObject({ kind: 'asset_id', asset: { id: 'a-3' } });
});

it('matches a serial number, case-insensitively and trimmed', () => {
  expect(matchScan(index, 'SN-4242')).toMatchObject({ kind: 'serial', asset: { id: 'a-1' } });
  expect(matchScan(index, ' fdo2140x9zz ')).toMatchObject({ kind: 'serial', asset: { id: 'a-2' } });
});

it('tries RFID before asset ID before serial', () => {
  // One row's asset_id is another row's serial; the asset_id wins.
  const clash = buildScanIndex([
    { ...rows[0], id: 'by-serial', serial_number: 'X1', asset_id: 'zzz', rfid: null },
    { ...rows[1], id: 'by-asset', asset_id: 'X1', serial_number: null, rfid: null },
    { ...rows[2], id: 'by-rfid', rfid: 'X1', asset_id: 'yyy', serial_number: null },
  ]);
  expect(matchScan(clash, 'X1')).toMatchObject({ kind: 'rfid', asset: { id: 'by-rfid' } });
});

it('returns null for an unknown value, a blank one, and empty/missing tags', () => {
  expect(matchScan(index, 'nope123')).toBeNull();
  expect(matchScan(index, '')).toBeNull();
  expect(matchScan(index, '   ')).toBeNull();
  // a-3 has rfid '' and no serial: neither may become a catch-all key
  expect(matchScan(index, '0')).toBeNull();
});

it('an empty roster matches nothing', () => {
  expect(matchScan(buildScanIndex([]), '100348')).toBeNull();
});

it('scanTypeFor reports rfid for a tag and barcode for everything else', () => {
  expect(scanTypeFor('rfid')).toBe('rfid');
  expect(scanTypeFor('asset_id')).toBe('barcode');
  expect(scanTypeFor('serial')).toBe('barcode');
});
