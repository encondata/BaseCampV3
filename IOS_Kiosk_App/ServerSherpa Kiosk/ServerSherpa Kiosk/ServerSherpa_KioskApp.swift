import SwiftUI

@main
struct ServerSherpa_KioskApp: App {
    @State private var container: AppContainer

    init() {
        KioskFonts.registerAll()
        _container = State(initialValue: AppContainer.live())
    }

    var body: some Scene {
        WindowGroup {
            RootView().appContainer(container)
        }
    }
}
