import XCTest

/// Asset Lookup on the device, on sample answers: `-uiTestAssetLookup <mode>` (honored by Debug
/// builds only) opens the real screen in the kiosk shell with no server, sign-in or setup. Search
/// and Clear show with no scroll in every state and orientation (Jimmy's rule), and a missed value
/// goes back in the box selected, so the next scanner burst replaces it. With
/// TEST_RUNNER_SCREENSHOT_DIR set, each state keeps lookup-<state>-<device>-<orientation>.png in
/// SCREENSHOT_DIR.
final class AssetLookupUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    @MainActor func testSearchAndClearShowInEveryState() throws {
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            for mode in ["empty", "detail", "list", "offline"] {
                let app = launch(mode, orientation)
                let search = app.buttons["lookup-search"]
                XCTAssertTrue(search.waitForExistence(timeout: 20), "\(mode): no Search")
                switch mode {
                case "detail", "offline":
                    XCTAssertTrue(app.descendants(matching: .any)["lookup-card"].waitForExistence(timeout: 5), "\(mode): no card")
                case "list":
                    XCTAssertTrue(app.buttons["lookup-match-a2"].waitForExistence(timeout: 5), "list: no matches")
                default: break
                }
                if mode == "offline" { XCTAssertTrue(app.descendants(matching: .any)["lookup-offline"].exists, "offline: no notice") }
                settle(search)
                try keepScreenshot(mode, orientation)
                let window = app.windows.firstMatch.frame
                for (name, button) in [("Search", search), ("Clear", app.buttons["lookup-clear"])] {
                    XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(button.frame),
                                  "\(mode), \(orientation.isLandscape ? "landscape" : "portrait"): \(name) \(button.frame) is off screen")
                    XCTAssertTrue(button.isHittable, "\(mode): \(name) is not hittable without a scroll")
                }
                app.terminate()
            }
        }
    }

    /// A miss keeps the value in the box, selected: the next scan replaces it rather than being
    /// appended to it. Clear then empties the screen.
    @MainActor func testAMissIsReplacedByTheNextScan() throws {
        let app = launch("empty", .portrait)
        let box = app.textFields["scan-input"]
        XCTAssertTrue(box.waitForExistence(timeout: 20))
        settle(box)
        box.typeText("nothing\n")
        XCTAssertTrue(app.staticTexts["No asset matches nothing."].waitForExistence(timeout: 5))
        XCTAssertEqual(box.value as? String, "nothing")
        Thread.sleep(forTimeInterval: 0.5)
        try keepScreenshot("miss", .portrait)
        box.typeText("102466\n")
        XCTAssertTrue(app.descendants(matching: .any)["lookup-card"].waitForExistence(timeout: 5),
                      "the second scan was appended to the missed value instead of replacing it")
        XCTAssertFalse(app.staticTexts["No asset matches nothing."].exists)
        app.buttons["lookup-clear"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["lookup-card"].waitForNonExistence(timeout: 5))
    }

    @MainActor
    private func launch(_ mode: String, _ orientation: UIDeviceOrientation) -> XCUIApplication {
        // Turned before the launch, so what opens opens in this orientation.
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestAssetLookup", mode]
        app.launch()
        return app
    }

    /// Waits for the element's frame to hold still for four reads, 0.4 s apart.
    @MainActor
    private func settle(_ element: XCUIElement) {
        var last = CGRect.null
        var steady = 0
        for _ in 0..<30 {
            let now = element.frame
            steady = now == last ? steady + 1 : 0
            if steady == 3 { return }
            last = now
            Thread.sleep(forTimeInterval: 0.4)
        }
    }

    private func keepScreenshot(_ mode: String, _ orientation: UIDeviceOrientation) throws {
        let shot = XCUIScreen.main.screenshot()
        let env = ProcessInfo.processInfo.environment
        let device = (env["SIMULATOR_DEVICE_NAME"] ?? "device").replacingOccurrences(of: " ", with: "_")
        let name = "lookup-\(mode)-\(device)-\(orientation.isLandscape ? "landscape" : "portrait")"
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = env["SCREENSHOT_DIR"], !dir.isEmpty else { return }
        try shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
