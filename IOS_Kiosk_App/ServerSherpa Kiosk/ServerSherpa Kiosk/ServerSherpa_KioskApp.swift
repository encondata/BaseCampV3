import SwiftUI

@main
struct ServerSherpa_KioskApp: App {
    init() { KioskFonts.registerAll() }
    var body: some Scene {
        WindowGroup { Text("ServerSherpa Kiosk") }
    }
}
