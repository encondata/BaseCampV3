import SwiftUI

@main
struct ServerSherpa_KioskApp: App {
    /// Nil in a unit-test host, which must never build the live container.
    @State private var container: AppContainer?

    init() {
        KioskFonts.registerAll()
        _container = State(initialValue: RuntimeEnvironment.isUnitTestHost ? nil : AppContainer.live())
    }

    var body: some Scene {
        WindowGroup {
            if let container {
                RootView().appContainer(container)
            } else {
                Color.clear
            }
        }
    }
}
