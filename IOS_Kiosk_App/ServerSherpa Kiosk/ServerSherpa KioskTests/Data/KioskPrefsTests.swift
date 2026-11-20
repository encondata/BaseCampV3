import Testing
import Foundation
@testable import ServerSherpa_Kiosk

@MainActor
struct KioskPrefsTests {
    @Test func defaultsWhenEmpty() {
        let prefs = KioskPrefs(defaults: freshDefaults())
        #expect(prefs.setupState == .incomplete)
        #expect(prefs.setupSelection == nil)
        #expect(prefs.appearance == DEFAULT_APPEARANCE)
        #expect(prefs.sound == DEFAULT_SOUND_SETTINGS)
        #expect(prefs.checkpoint(.enroll) == "pre_stage")
        #expect(prefs.devMode == false)
        #expect(prefs.environment == nil)
        #expect(prefs.environmentList == nil)
        #expect(!prefs.everRegistered)
        #expect(prefs.legacyApiUrl == nil)
        #expect(prefs.legacyPortalUrl == nil)
        #expect(prefs.kioskName == nil)
        #expect(prefs.cameraPosition == .back)
        #expect(prefs.signInMethod == nil)
    }

    /// Android's key and wire values; nil removes it, and a value this app doesn't know reads
    /// as unknown rather than as a guess.
    @Test func theSignInMethodIsKeptUnderItsKey() {
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        for method in [LoginMethod.password, .link, .biometric] {
            prefs.signInMethod = method
            #expect(defaults.string(forKey: "ss.kiosk.signInMethod") == method.rawValue)
            #expect(KioskPrefs(defaults: defaults).signInMethod == method)
        }
        #expect(LoginMethod.link.rawValue == "link")
        prefs.signInMethod = nil
        #expect(defaults.object(forKey: "ss.kiosk.signInMethod") == nil)
        #expect(KioskPrefs(defaults: defaults).signInMethod == nil)
        defaults.set("sso", forKey: "ss.kiosk.signInMethod")
        #expect(KioskPrefs(defaults: defaults).signInMethod == nil)
    }

    @Test func biometricEnrollmentRoundTripsAndNilRemoves() {
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        #expect(prefs.biometric == nil)
        let enrollment = BiometricEnrollment(keyId: "k1", personId: "p1", email: "tina@example.com")
        prefs.biometric = enrollment
        #expect(KioskPrefs(defaults: defaults).biometric == enrollment)
        #expect(defaults.string(forKey: "ss.kiosk.biometric") != nil)
        prefs.biometric = nil
        #expect(KioskPrefs(defaults: defaults).biometric == nil)
        #expect(defaults.object(forKey: "ss.kiosk.biometric") == nil)
        defaults.set("not json", forKey: "ss.kiosk.biometric")
        #expect(KioskPrefs(defaults: defaults).biometric == nil)
    }

    @Test func roundTripsAndSurvivesANewInstance() {
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        prefs.setupState = .complete
        let sel = KioskSetupSelection(initiativeId: "i", initiativeName: "Move", siteId: "s", siteName: "Site", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        prefs.setupSelection = sel
        var a = DEFAULT_APPEARANCE
        a.flashMs = 900
        prefs.appearance = a
        var snd = DEFAULT_SOUND_SETTINGS
        snd.good = .none
        prefs.sound = snd
        prefs.setCheckpoint(.enroll, "received")
        prefs.devMode = true
        prefs.environment = #"{"kind":"named"}"#
        prefs.environmentList = #"{"version":1}"#
        prefs.markEverRegistered()
        prefs.kioskName = "Dock 4"
        prefs.cameraPosition = .front

        for p in [prefs, KioskPrefs(defaults: defaults)] {
            #expect(p.setupState == .complete)
            #expect(p.setupSelection == sel)
            #expect(p.appearance.flashMs == 900)
            #expect(p.sound.good == SoundChoice.none)
            #expect(p.checkpoint(.enroll) == "received")
            #expect(p.devMode == true)
            #expect(p.environment == #"{"kind":"named"}"#)
            #expect(p.environmentList == #"{"version":1}"#)
            #expect(p.everRegistered)
            #expect(p.kioskName == "Dock 4")
            #expect(p.cameraPosition == .front)
        }

        prefs.setupSelection = nil
        prefs.environment = nil
        let reloaded = KioskPrefs(defaults: defaults)
        #expect(reloaded.setupSelection == nil)
        #expect(reloaded.environment == nil)
        #expect(defaults.object(forKey: "ss.kiosk.environment") == nil)
        #expect(defaults.object(forKey: "ss.kiosk.setup") == nil)
    }

    /// The URLs typed before the environment picker are read under their old keys and go in one
    /// step: the converted environment is saved only when none is, and both old keys are removed.
    @Test func theLegacyUrlsMigrateInOneStep() {
        let defaults = freshDefaults()
        defaults.set("http://10.0.2.2:8000", forKey: "ss.kiosk.apiUrl")
        defaults.set("https://p.example", forKey: "ss.kiosk.portalUrl")
        let prefs = KioskPrefs(defaults: defaults)
        #expect(prefs.legacyApiUrl == "http://10.0.2.2:8000")
        #expect(prefs.legacyPortalUrl == "https://p.example")
        var seen: [String?] = []
        prefs.migrateLegacyUrls { api, portal in seen = [api, portal]; return "converted" }
        #expect(seen == ["http://10.0.2.2:8000", "https://p.example"])
        #expect(prefs.environment == "converted")
        #expect(prefs.legacyApiUrl == nil && prefs.legacyPortalUrl == nil)
        #expect(defaults.object(forKey: "ss.kiosk.apiUrl") == nil)
        #expect(defaults.object(forKey: "ss.kiosk.portalUrl") == nil)

        defaults.set("http://other:1", forKey: "ss.kiosk.apiUrl")       // beside a saved environment
        let again = KioskPrefs(defaults: defaults)
        again.migrateLegacyUrls { _, _ in "replaced" }
        #expect(again.environment == "converted")
        #expect(defaults.object(forKey: "ss.kiosk.apiUrl") == nil)

        var called = false                                               // nothing typed: nothing to do
        KioskPrefs(defaults: freshDefaults()).migrateLegacyUrls { _, _ in called = true; return "x" }
        #expect(!called)
    }

    @Test func corruptStoredValuesFallBack() {
        let defaults = freshDefaults()
        defaults.set("{not json", forKey: "ss.kiosk.appearance")
        defaults.set("{not json", forKey: "ss.kiosk.sound")
        defaults.set("{not json", forKey: "ss.kiosk.setup")
        defaults.set("bogus", forKey: "ss.kiosk.setupState")
        defaults.set("sideways", forKey: "ss.kiosk.cameraPosition")
        defaults.set("   ", forKey: CheckpointId.enroll.storageKey)
        let prefs = KioskPrefs(defaults: defaults)
        #expect(prefs.appearance == DEFAULT_APPEARANCE)
        #expect(prefs.sound == DEFAULT_SOUND_SETTINGS)
        #expect(prefs.setupSelection == nil)
        #expect(prefs.setupState == .incomplete)
        #expect(prefs.cameraPosition == .back)
        #expect(prefs.checkpoint(.enroll) == "pre_stage")
    }

    /// A selection saved before the Top/Front step has no labelKind: it reads as "top".
    @Test func aSelectionSavedBeforeTheLabelStepReadsAsTop() {
        let defaults = freshDefaults()
        defaults.set(#"{"initiativeId":"i","initiativeName":"Move","siteId":"s","siteName":"Site","siteRole":"source","scanStatus":"pre_stage","scanLabel":"Pre-stage"}"#,
                     forKey: "ss.kiosk.setup")
        #expect(KioskPrefs(defaults: defaults).setupSelection?.labelKind == "top")
    }

    @Test func labelKindRoundTripsInTheSelection() {
        let defaults = freshDefaults()
        let sel = KioskSetupSelection(initiativeId: "i", initiativeName: "Move", siteId: "s", siteName: "Site", siteRole: "source",
                                      scanStatus: "pre_stage", scanLabel: "Pre-stage", labelKind: "front")
        KioskPrefs(defaults: defaults).setupSelection = sel
        #expect(KioskPrefs(defaults: defaults).setupSelection?.labelKind == "front")
    }

    /// The printer, offsets and peel live under `ss.kiosk.labels`; an update reads and writes together.
    @Test func labelOptionsRoundTripUnderTheirKey() {
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        #expect(prefs.labels == LabelOptions())
        let printer = SavedPrinter(host: "10.0.0.7", model: "ZD421", serial: "D4J123456", dpi: 300)
        prefs.updateLabels { $0.printer = printer }
        prefs.updateLabels { $0.offsetX = -4; $0.peel = true }
        let expected = LabelOptions(printer: printer, offsetX: -4, offsetY: 0, peel: true)
        #expect(prefs.labels == expected)
        #expect(KioskPrefs(defaults: defaults).labels == expected)
        #expect(defaults.string(forKey: "ss.kiosk.labels")?.contains(#""offsetX":-4"#) == true)
    }

    @Test func unreadableLabelOptionsFallBackToDefaults() {
        let defaults = freshDefaults()
        defaults.set("{not json", forKey: "ss.kiosk.labels")
        #expect(KioskPrefs(defaults: defaults).labels == LabelOptions())
        defaults.set(#"{"peel":true}"#, forKey: "ss.kiosk.labels")
        #expect(KioskPrefs(defaults: defaults).labels == LabelOptions(peel: true))
    }

    // MARK: Clear Setup (Android KioskPrefsTest / HeartbeatTest)

    /// Same key and stored shape as the web kiosk's setupClear.ts and Android: all three fields,
    /// even at their defaults, read back by a relaunch.
    @Test func setupClearIsStoredWithAllThreeFields() throws {
        let defaults = freshDefaults()
        let prefs = KioskPrefs(defaults: defaults)
        #expect(prefs.applySetupClear("x1"))
        func stored() throws -> [String: Any] {
            let raw = try #require(defaults.string(forKey: "ss.kiosk.setupClear"))
            return try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        }
        var o = try stored()
        #expect(o.count == 3)
        #expect(o["id"] as? String == "x1"); #expect(o["acked"] as? Bool == false); #expect(o["notice"] as? Bool == true)
        prefs.settleSetupClearAck(sentAck: "x1", replyId: nil)
        prefs.dismissSetupClearNotice()
        o = try stored()
        #expect(o.count == 3)
        #expect(o["acked"] as? Bool == true); #expect(o["notice"] as? Bool == false)
        #expect(KioskPrefs(defaults: defaults).setupClear == SetupClearRecord(id: "x1", acked: true, notice: false))
        defaults.set("{not json", forKey: "ss.kiosk.setupClear")
        #expect(KioskPrefs(defaults: defaults).setupClear == nil)
    }

    /// Applying drops the saved setup and marks it incomplete, once per id; a re-request is a
    /// new id and raises the notice again.
    @Test func applyIsOncePerIdAndTheNoticeDismisses() {
        let prefs = KioskPrefs(defaults: freshDefaults())
        prefs.setupState = .complete
        prefs.setupSelection = testSelection(initiativeId: "i1")
        #expect(prefs.applySetupClear("x6"))
        #expect(prefs.setupState == .incomplete)
        #expect(prefs.setupSelection == nil)
        #expect(prefs.setupClear?.notice == true)
        prefs.setupState = .complete                              // set up again
        #expect(!prefs.applySetupClear("x6"))
        #expect(prefs.setupState == .complete)                    // the same id never clears twice
        prefs.dismissSetupClearNotice()
        #expect(prefs.setupClear == SetupClearRecord(id: "x6", acked: false, notice: false))
        #expect(prefs.applySetupClear("x7"))
        #expect(prefs.setupClear == SetupClearRecord(id: "x7", acked: false, notice: true))
    }

    /// The ack lands only when the beat that carried it gets an answer that stopped asking.
    @Test func theAckSettlesOnlyWhenItWasSentAndTheServerStoppedAsking() {
        let prefs = KioskPrefs(defaults: freshDefaults())
        #expect(prefs.pendingSetupClearAck() == nil)
        prefs.applySetupClear("x4")
        prefs.settleSetupClearAck(sentAck: nil, replyId: nil)     // a beat that didn't carry it
        #expect(prefs.pendingSetupClearAck() == "x4")
        prefs.settleSetupClearAck(sentAck: "x4", replyId: "x4")   // the server still asks
        #expect(prefs.pendingSetupClearAck() == "x4")
        prefs.settleSetupClearAck(sentAck: "old", replyId: nil)   // another id's ack
        #expect(prefs.pendingSetupClearAck() == "x4")
        prefs.settleSetupClearAck(sentAck: "x4", replyId: nil)    // the beat that did
        #expect(prefs.pendingSetupClearAck() == nil)
        #expect(prefs.setupClear == SetupClearRecord(id: "x4", acked: true, notice: true))
    }
}
