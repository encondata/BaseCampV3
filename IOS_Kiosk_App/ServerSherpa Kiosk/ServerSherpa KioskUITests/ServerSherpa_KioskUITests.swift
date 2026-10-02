//
//  ServerSherpa_KioskUITests.swift
//  ServerSherpa KioskUITests
//
//  Created by James Henderson on 9/15/26.
//

import XCTest

final class ServerSherpa_KioskUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// `-uiTestSignedOut` (honored by Debug builds only) skips the session restore.
    @MainActor
    private func launchSignedOut() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestSignedOut"]
        app.launch()
        return app
    }

    @MainActor
    func testLaunchShowsSignIn() throws {
        let app = launchSignedOut()
        XCTAssertTrue(app.staticTexts["Sign in"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["you@company.com"].exists)
    }

    /// The visual check: writes login-landscape.png and login-portrait.png to
    /// SCREENSHOT_DIR (set it with TEST_RUNNER_SCREENSHOT_DIR). Without it the test passes untouched.
    @MainActor
    func testLoginScreenshots() throws {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"], !dir.isEmpty else { return }
        let app = launchSignedOut()
        XCTAssertTrue(app.staticTexts["Sign in"].waitForExistence(timeout: 10))
        for (orientation, name) in [(UIDeviceOrientation.landscapeLeft, "landscape"), (.portrait, "portrait")] {
            XCUIDevice.shared.orientation = orientation
            sleep(1)
            let png = XCUIScreen.main.screenshot().pngRepresentation
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("login-\(name).png"))
        }
    }

    /// Signed-out visual check of the screens reachable without an account: the Settings sheet
    /// (This Kiosk), Pair with phone, and Use a move password, in both orientations. Writes
    /// signedout-<screen>-<orientation>.png to SCREENSHOT_DIR; types nothing.
    @MainActor
    func testSignedOutScreenshots() throws {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"], !dir.isEmpty else { return }
        let orientations: [(UIDeviceOrientation, String)] = [(.landscapeLeft, "landscape"), (.portrait, "portrait")]
        func shot(_ screen: String, _ orientation: String) throws {
            sleep(2)
            let png = XCUIScreen.main.screenshot().pngRepresentation
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("signedout-\(screen)-\(orientation).png"))
        }
        for (orientation, name) in orientations {
            let settings = launchSignedOut()
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(settings.buttons["Kiosk settings"].firstMatch.waitForExistence(timeout: 10))
            settings.buttons["Kiosk settings"].firstMatch.tap()
            try shot("settings", name)
            settings.terminate()

            let pair = launchSignedOut()
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(pair.buttons["Pair with phone"].firstMatch.waitForExistence(timeout: 10))
            pair.buttons["Pair with phone"].firstMatch.tap()
            try shot("pair", name)
            pair.terminate()

            let move = launchSignedOut()
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(move.buttons["Use a move password"].firstMatch.waitForExistence(timeout: 10))
            move.buttons["Use a move password"].firstMatch.tap()
            try shot("move", name)
            move.terminate()
        }
    }
}
