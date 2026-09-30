//
//  ServerSherpa_KioskApp.swift
//  ServerSherpa Kiosk
//
//  Created by James Henderson on 9/15/26.
//

import SwiftUI
import SwiftData

@main
struct ServerSherpa_KioskApp: App {
    var sharedModelContainer: ModelContainer = {
        let schema = Schema([
            Item.self,
        ])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(sharedModelContainer)
    }
}
