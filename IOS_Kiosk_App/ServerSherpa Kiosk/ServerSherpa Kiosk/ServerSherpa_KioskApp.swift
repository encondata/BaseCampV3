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
                #if DEBUG
                // `-uiTestAssetLookup <mode>`: Asset Lookup's layout on sample answers (no server).
                if let sample = AssetLookupSampleMode.fromLaunch {
                    AssetLookupSampleHost(mode: sample).appContainer(container)
                } else {
                    RootView().appContainer(container)
                }
                #else
                RootView().appContainer(container)
                #endif
            } else {
                Color.clear
            }
        }
    }
}
