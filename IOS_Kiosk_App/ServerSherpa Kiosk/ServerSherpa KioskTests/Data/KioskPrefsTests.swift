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
        #expect(prefs.apiUrl == nil)
        #expect(prefs.portalUrl == nil)
        #expect(prefs.kioskName == nil)
        #expect(prefs.cameraPosition == .back)
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
        prefs.apiUrl = "http://10.0.2.2:8000"
        prefs.portalUrl = "https://p.example"
        prefs.kioskName = "Dock 4"
        prefs.cameraPosition = .front

        for p in [prefs, KioskPrefs(defaults: defaults)] {
            #expect(p.setupState == .complete)
            #expect(p.setupSelection == sel)
            #expect(p.appearance.flashMs == 900)
            #expect(p.sound.good == SoundChoice.none)
            #expect(p.checkpoint(.enroll) == "received")
            #expect(p.devMode == true)
            #expect(p.apiUrl == "http://10.0.2.2:8000")
            #expect(p.portalUrl == "https://p.example")
            #expect(p.kioskName == "Dock 4")
            #expect(p.cameraPosition == .front)
        }

        prefs.setupSelection = nil
        prefs.apiUrl = nil
        let reloaded = KioskPrefs(defaults: defaults)
        #expect(reloaded.setupSelection == nil)
        #expect(reloaded.apiUrl == nil)
        #expect(defaults.object(forKey: "ss.kiosk.setup") == nil)
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
}
