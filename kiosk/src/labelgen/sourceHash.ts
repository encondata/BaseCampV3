/**
 * Written by fixtures/make_reference.py: do not edit by hand.
 *
 * The `source_hash` of fixtures/reference.json (sha256 over the Python
 * label code the reference labels were printed with). The web kiosk
 * keys its stored labels on it (lib/webLabels/labelBuild.ts), so a kiosk
 * deploy carrying a generator made from other Python rebuilds every
 * label. reference.test.ts holds it equal to the fixture's.
 *
 * Deliberately NOT imported by labelgen/index.ts: the Android/iOS bundle
 * stays byte-identical when only this hash moves.
 */
export const SOURCE_HASH = '466ec01df02c0c79255fba7ac9337cfd7e3026028bbce65b4d219633d244076e';
