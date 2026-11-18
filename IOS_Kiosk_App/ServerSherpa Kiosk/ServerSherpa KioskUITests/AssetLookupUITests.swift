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

    /// Every state, in both orientations: Search, Clear and "‹ Home" are on screen and hittable
    /// with no scroll. In the list, a pick opens the card below it and scrolls it into view, and
    /// the pinned Search and Clear stay put. With TEST_RUNNER_EXPECT_SOFT_KEYBOARD=1 (the simulator's
    /// hardware keyboard disconnected) the on-screen keyboard must be up too, and the shots say so.
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
                let context = "\(mode), \(orientation.isLandscape ? "landscape" : "portrait")"
                let keyboard = softKeyboard(app, context)
                if keyboard { settleAfterKeyboard() }
                try keepScreenshot(mode + (keyboard ? "-keyboard" : ""), orientation)
                assertReachable(app, context)
                if let first = firstLine(app, mode: mode) { assertShown(first, app, context) }
                if mode == "list" {
                    app.buttons["lookup-match-a2"].tap()
                    let card = app.descendants(matching: .any)["lookup-card"].firstMatch
                    XCTAssertTrue(card.waitForExistence(timeout: 5), "\(context): the pick opened no card")
                    settle(card)
                    try keepScreenshot("picked" + (keyboard ? "-keyboard" : ""), orientation)
                    assertReachable(app, context + ", after a pick")
                    // The card's first match is its name (the identifier reaches its first line).
                    assertShown(card, app, context + ", after a pick")
                }
                app.terminate()
            }
        }
    }

    /// The answer's first line in each state: the list's table header (wide) or first row, the
    /// card's name, the offline notice. Nil for the empty screen.
    @MainActor
    private func firstLine(_ app: XCUIApplication, mode: String) -> XCUIElement? {
        switch mode {
        case "list":
            let header = app.staticTexts["NAME"]
            return header.exists ? header : app.buttons["lookup-match-a1"]
        case "detail": return app.staticTexts["Asset A"]
        case "offline": return app.descendants(matching: .any)["lookup-offline"].firstMatch
        default: return nil
        }
    }

    /// The top `line` of `answer` is on screen with no gesture: below the box row, above the footer
    /// and above the on-screen keyboard.
    @MainActor
    private func assertShown(_ answer: XCUIElement, _ app: XCUIApplication, _ context: String, line: CGFloat = 24) {
        let top = answer.frame.minY
        let rowBottom = max(app.textFields["scan-input"].frame.maxY, app.buttons["lookup-search"].frame.maxY)
        var bottom = app.windows.firstMatch.frame.maxY
        let footer = app.staticTexts["MODE"]
        if footer.exists { bottom = min(bottom, footer.frame.minY) }
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { bottom = min(bottom, keyboard.frame.minY) }
        XCTAssertGreaterThanOrEqual(top, rowBottom - 0.5, "\(context): the answer \(answer.frame) is under the box row (\(rowBottom))")
        XCTAssertLessThanOrEqual(top + line, bottom + 0.5, "\(context): the answer \(answer.frame) is not on screen above \(bottom)")
    }

    /// The keyboard has finished coming up and the screen has settled after it.
    private func settleAfterKeyboard() { Thread.sleep(forTimeInterval: 1.0) }

    /// Search, Clear and the shell's "‹ Home" lie inside the window and are hittable, with no gesture.
    @MainActor
    private func assertReachable(_ app: XCUIApplication, _ context: String) {
        let window = app.windows.firstMatch.frame
        let home = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Home'")).firstMatch
        for (name, button) in [("Search", app.buttons["lookup-search"]), ("Clear", app.buttons["lookup-clear"]), ("Home", home)] {
            XCTAssertTrue(button.exists, "\(context): no \(name)")
            XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(button.frame),
                          "\(context): \(name) \(button.frame) is outside the window \(window)")
            XCTAssertTrue(button.isHittable, "\(context): \(name) is not hittable without a scroll")
        }
    }

    /// Whether the on-screen keyboard is up; required when TEST_RUNNER_EXPECT_SOFT_KEYBOARD=1.
    @MainActor
    private func softKeyboard(_ app: XCUIApplication, _ context: String) -> Bool {
        let expected = ProcessInfo.processInfo.environment["EXPECT_SOFT_KEYBOARD"] == "1"
        let up = app.keyboards.firstMatch.waitForExistence(timeout: expected ? 5 : 1)
        if expected { XCTAssertTrue(up, "\(context): the on-screen keyboard is not up") }
        return up
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
