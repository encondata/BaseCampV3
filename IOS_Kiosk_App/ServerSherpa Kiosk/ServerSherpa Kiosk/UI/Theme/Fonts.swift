import CoreText
import Foundation

enum KioskFonts {
    /// Registers the bundled TTFs for this process. A missing file is skipped, so
    /// the theme falls back to system fonts instead of failing launch.
    static func registerAll() {
        for url in Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [] {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}
