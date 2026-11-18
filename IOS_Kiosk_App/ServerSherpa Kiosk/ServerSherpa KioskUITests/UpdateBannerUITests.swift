import XCTest

/// Settings › This Kiosk › App updates while signed out. Home's banner needs a session, which UI
/// tests never have, so only the signed-out row is checked here: even with `-uiTestUpdate available`
/// (Debug builds only) no check runs signed out, Check for updates shows but is off, and the row
/// says why. With SCREENSHOT_DIR set (TEST_RUNNER_SCREENSHOT_DIR), keeps
/// app-updates-signed-out-<device>-<os>.png there.
final class UpdateBannerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor func testSignedOutSettingsExplains() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestSignedOut", "-uiTestUpdate", "available"]
        app.launch()

        let gear = app.buttons["Kiosk settings"].firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 20), "No Kiosk settings button")
        gear.tap()
        XCTAssertTrue(app.buttons["Done"].firstMatch.waitForExistence(timeout: 5), "The Settings sheet never opened")

        let check = app.buttons["check-for-updates"].firstMatch
        XCTAssertTrue(check.waitForExistence(timeout: 5), "No Check for updates button")
        // The row is the panel's last: scroll the page to it.
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<6 where !check.isHittable { scroll.swipeUp() }
        XCTAssertFalse(check.isEnabled, "Check for updates is on while signed out")
        XCTAssertTrue(app.staticTexts["Sign in to check for updates."].firstMatch.exists, "No signed-out line")
        XCTAssertFalse(app.buttons["update-now"].exists, "An Update button showed while signed out")

        try keepScreenshot("app-updates-signed-out")
    }

    private func keepScreenshot(_ surface: String) throws {
        let shot = XCUIScreen.main.screenshot()
        let env = ProcessInfo.processInfo.environment
        let device = (env["SIMULATOR_DEVICE_NAME"] ?? "device").replacingOccurrences(of: " ", with: "_")
        let os = env["SIMULATOR_RUNTIME_VERSION"] ?? "os"
        let name = "\(surface)-\(device)-\(os)"
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = env["SCREENSHOT_DIR"], !dir.isEmpty else { return }
        try shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
