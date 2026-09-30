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
}
