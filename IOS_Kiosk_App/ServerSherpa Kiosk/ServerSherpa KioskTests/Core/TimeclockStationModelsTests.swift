import Foundation
import Testing
@testable import ServerSherpa_Kiosk

/// The wire shapes the Time Clock station adds (api/schemas.py KioskTimeclock*,
/// KioskPersonOut, KioskSetupIn/Out, SetupOptionsOut), and the setup selection
/// a regular kiosk saved before station types existed still reading the same.
struct TimeclockStationModelsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try KioskJSON.decoder.decode(type, from: Data(json.utf8))
    }

    private func encode<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try KioskJSON.encoder.encode(value), as: UTF8.self)
    }

    @Test func statusCarriesTodaysHoursAndThePersonsTitleAndEmployeeId() throws {
        let st = try decode(KioskTimeclockStatus.self, """
            {"person":{"id":"p","display_name":"Tina T","first_name":"Tina","last_name":"T","job_title":"Technician","external_id":"E-42"},
             "clocked_in":true,"entry":{"id":"e","started_at":"2026-10-21T13:00:00Z"},"last_entry":null,
             "today_minutes":444,
             "today_entries":[{"clock_in_at":"2026-10-21T08:00:00Z","clock_out_at":"2026-10-21T12:00:00Z","minutes":240},
                              {"clock_in_at":"2026-10-21T13:00:00Z","clock_out_at":null,"minutes":204}]}
            """)
        #expect(st.person.jobTitle == "Technician")
        #expect(st.person.externalId == "E-42")
        #expect(st.todayMinutes == 444)
        #expect(st.todayEntries == [
            KioskTimeclockTodayEntry(clockInAt: "2026-10-21T08:00:00Z", clockOutAt: "2026-10-21T12:00:00Z", minutes: 240),
            KioskTimeclockTodayEntry(clockInAt: "2026-10-21T13:00:00Z", clockOutAt: nil, minutes: 204),
        ])
    }

    @Test func statusFromAnOlderServerDefaultsTodayToNothing() throws {
        let st = try decode(KioskTimeclockStatus.self, #"{"person":{"id":"p","display_name":"T"},"clocked_in":false}"#)
        #expect(st.todayMinutes == 0)
        #expect(st.todayEntries.isEmpty)
        #expect(st.person.jobTitle == nil && st.person.externalId == nil)
    }

    @Test func punchBodiesCarryTheZoneOnlyWhenSet() throws {
        #expect(try encode(ClockOutIn(serial: "s", personId: "p", tz: "America/Chicago"))
                == #"{"person_id":"p","serial":"s","tz":"America\/Chicago"}"#)
        #expect(try encode(ClockOutIn(serial: "s", personId: "p")) == #"{"person_id":"p","serial":"s"}"#)
        let clockIn = try encode(ClockInIn(serial: "s", personId: "p", siteId: "s1", tz: "UTC"))
        #expect(clockIn == #"{"person_id":"p","serial":"s","site_id":"s1","tz":"UTC"}"#)
        #expect(try encode(StationClockIn(serial: "s", personId: "p", tz: "UTC")) == #"{"person_id":"p","serial":"s","tz":"UTC"}"#)
    }

    @Test func syncedPersonCarriesBadgeTitleAndEmployeeId() throws {
        let p = try decode(KioskPersonRow.self, """
            {"id":"p","display_name":"Bea Badge","first_name":"Bea","last_name":"Badge","badge_uid":"ab12cd34-2222-4333-8444-555555555555",
             "job_title":"Lead","external_id":"E-7","is_worker":true,"has_account":false}
            """)
        #expect(p.badgeUid == "ab12cd34-2222-4333-8444-555555555555")
        #expect(p.jobTitle == "Lead")
        #expect(p.externalId == "E-7")
        let old = try decode(KioskPersonRow.self, #"{"id":"p","display_name":"A"}"#)
        #expect(old.badgeUid == nil && old.jobTitle == nil && old.externalId == nil)
    }

    @Test func setupForARegularKioskSendsWhatItAlwaysSent() throws {
        #expect(try encode(KioskSetupIn(serial: "k", initiativeId: "i1", siteId: "s1", scanStatus: "pre_stage"))
                == #"{"initiative_id":"i1","scan_status":"pre_stage","serial":"k","site_id":"s1"}"#)
    }

    @Test func setupForATimeClockStationLeavesOutWhatItHasNot() throws {
        #expect(try encode(KioskSetupIn(serial: "k", initiativeId: nil, siteId: "s1", scanStatus: nil, stationType: "timeclock"))
                == #"{"serial":"k","site_id":"s1","station_type":"timeclock"}"#)
    }

    @Test func setupResultWithNoMoveOrSiteDecodes() throws {
        let r = try decode(KioskSetupResult.self, """
            {"device_id":"d","initiative_id":null,"initiative_name":null,"site_id":null,"site_name":null,"site_role":null,
             "scan_status":null,"scan_status_label":null}
            """)
        #expect(r.deviceId == "d")
        #expect(r.initiativeId == nil && r.siteId == nil && r.siteRole == nil && r.scanStatus == nil)
        let full = try decode(KioskSetupResult.self, #"{"device_id":"d","initiative_id":"i1","initiative_name":"Move A","site_id":"s1","site_name":"Origin","site_role":"source","scan_status":"pre_stage","scan_status_label":"Pre-stage"}"#)
        #expect(full.initiativeId == "i1" && full.siteRole == "source" && full.scanStatusLabel == "Pre-stage")
    }

    @Test func setupOptionsListEverySite() throws {
        let opts = try decode(SetupOptions.self, #"{"initiatives":[],"scan_types":[],"sites":[{"id":"s1","name":"HQ"},{"id":"s2","name":"Dock"}]}"#)
        #expect(opts.sites == [SetupOptionSite(id: "s1", name: "HQ"), SetupOptionSite(id: "s2", name: "Dock")])
        #expect(try decode(SetupOptions.self, "{}").sites.isEmpty)
    }

    /// The JSON a regular kiosk saved before station types existed.
    @Test func aSelectionSavedBeforeStationTypesStillReads() throws {
        let saved = #"{"initiativeId":"i","initiativeName":"Move","siteId":"s","siteName":"Site","siteRole":"source","scanStatus":"pre_stage","scanLabel":"Pre-stage","labelKind":"front"}"#
        let sel = try decode(KioskSetupSelection.self, saved)
        #expect(sel.stationType == nil)
        #expect(!sel.isTimeclockStation)
        #expect(sel.labelKind == "front")
        #expect(sel.moveId == "i" && sel.siteIdOrNil == "s")
        #expect(!(try encode(sel)).contains("stationType"))
    }

    @Test func aTimeClockSelectionWithNoMoveOrSiteRoundTrips() throws {
        let sel = KioskSetupSelection.timeclock(initiativeId: nil, initiativeName: nil, siteId: nil, siteName: nil, siteRole: nil)
        #expect(sel.isTimeclockStation)
        #expect(sel.initiativeId == "" && sel.initiativeName == "No move")
        #expect(sel.siteId == "" && sel.siteName == "No site" && sel.siteRole == "none")
        #expect(sel.scanStatus == "" && sel.scanLabel == "")
        #expect(sel.moveId == nil && sel.siteIdOrNil == nil)
        let text = try encode(sel)
        #expect(text.contains(#""stationType":"timeclock""#))
        #expect(try decode(KioskSetupSelection.self, text) == sel)
    }

    @Test func aTimeClockSelectionKeepsAMovesSiteRoleAndMarksASiteWithoutAMoveOther() {
        let onMove = KioskSetupSelection.timeclock(initiativeId: "i1", initiativeName: "Move A", siteId: "s2", siteName: "Dest", siteRole: "destination")
        #expect(onMove.siteRole == "destination" && onMove.moveId == "i1" && onMove.siteIdOrNil == "s2")
        let siteOnly = KioskSetupSelection.timeclock(initiativeId: nil, initiativeName: nil, siteId: "s3", siteName: "HQ", siteRole: "other")
        #expect(siteOnly.siteRole == "other" && siteOnly.initiativeName == "No move" && siteOnly.siteName == "HQ")
        let moveOnly = KioskSetupSelection.timeclock(initiativeId: "i1", initiativeName: "Move A", siteId: nil, siteName: nil, siteRole: nil)
        #expect(moveOnly.siteRole == "none" && moveOnly.siteName == "No site")
    }
}
