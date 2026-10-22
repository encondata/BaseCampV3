import Foundation
import SwiftUI
import Testing
import UIKit
@testable import ServerSherpa_Kiosk

/// The flow's view: layout A from the aspect ratio, the kiosk shell stepping
/// aside, and the state surviving a rotation (it lives in the model, not the view).
@MainActor
struct TimeclockFlowViewTests {
    private func model(_ backend: FakeTcBackend) -> TimeclockFlowModel {
        TimeclockFlowModel(mode: .kiosk, backend: backend, flash: FlashController(), sound: nil, appearance: { DEFAULT_APPEARANCE },
                           fetchImage: { _ in throw ApiError(status: 404, code: "missing") },
                           sleep: { _ in try await Task.sleep(for: .seconds(600)) })
    }

    @Test func landscapeIsChosenFromTheAspectRatio() {
        #expect(tcIsLandscape(CGSize(width: 1180, height: 820)))
        #expect(!tcIsLandscape(CGSize(width: 820, height: 1180)))
        #expect(!tcIsLandscape(CGSize(width: 500, height: 500)))
        #expect(tcIsLandscape(CGSize(width: 844, height: 390)))   // a phone on its side
    }

    @Test func theKioskShellStepsAsideForTheTimeClock() {
        #expect(shellHidesChrome(path: [.timeclock]))
        #expect(!shellHidesChrome(path: []))
        #expect(!shellHidesChrome(path: [.scan]))
        #expect(!shellHidesChrome(path: [.labels, .labelsPrint]))
    }

    @Test func rotationKeepsTheStep() async {
        let backend = FakeTcBackend()
        backend.peopleResult = { [TC_JIMMY, TC_TINA] }
        let m = model(backend)
        m.start(); await m.settle()

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 820, height: 1180))
        let host = UIHostingController(rootView: TimeclockFlowView(model: m, onCamera: nil, onSettings: nil))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()

        // typed text and the keyboard layer survive the turn
        m.pressKey(.letter("T")); m.pressKey(.letter("I")); m.pressKey(.numbers)
        rotate(window, host, to: CGSize(width: 1180, height: 820))
        #expect(m.step == .name)
        #expect(m.query == "Ti")
        #expect(m.kbSymbols)

        // so do the step and the person
        m.pressKey(.letters)
        m.onScan("B-UID-1"); await m.settle()
        m.confirmYes()
        rotate(window, host, to: CGSize(width: 820, height: 1180))
        #expect(m.step == .action)
        #expect(m.state.status?.person.id == "p1")

        // and a view rebuilt from scratch (a new hosting controller) reads the same model
        let rebuilt = UIHostingController(rootView: TimeclockFlowView(model: m, onCamera: nil, onSettings: nil))
        window.rootViewController = rebuilt
        rebuilt.view.layoutIfNeeded()
        #expect(m.step == .action)
        #expect(m.state.status?.person.id == "p1")
        window.isHidden = true
    }

    private func rotate(_ window: UIWindow, _ host: UIViewController, to size: CGSize) {
        window.frame = CGRect(origin: .zero, size: size)
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
    }
}
