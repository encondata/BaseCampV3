import SwiftUI

/// Settings › Appearance: the three scan flash colors and their duration.
struct AppearancePanel: View {
    @Environment(KioskPrefs.self) private var prefs
    @Environment(FlashController.self) private var flash
    @Environment(\.kioskPalette) private var palette

    private func preview(_ hsl: Hsl) { flash.flash(Color(hsl: hsl), ms: prefs.appearance.flashMs) }

    var body: some View {
        @Bindable var prefs = prefs
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Good scan flash", detail: "The color the whole screen flashes when a scan matches this kiosk's local move data. Stored on this kiosk only.") {
                HslPicker(label: "Good scan flash", value: $prefs.appearance.goodScan) { preview(prefs.appearance.goodScan) }
            }
            SettingsRow(title: "Not-found scan flash", detail: "The color the whole screen flashes when a scan matches nothing. Stored on this kiosk only.") {
                HslPicker(label: "Not-found scan flash", value: $prefs.appearance.notFoundScan) { preview(prefs.appearance.notFoundScan) }
            }
            SettingsRow(title: "Duplicate scan flash", detail: "Shown when a scan changes nothing — an asset already in this container, or a container already on this truck.") {
                HslPicker(label: "Duplicate scan flash", value: $prefs.appearance.duplicateScan) { preview(prefs.appearance.duplicateScan) }
            }
            SettingsRow(title: "Flash duration", detail: "How long the screen flashes after a scan.") {
                HStack {
                    Slider(value: Binding(get: { Double(prefs.appearance.flashMs) },
                                          set: { prefs.appearance.flashMs = Int((($0 / Double(FLASH_MS_STEP)).rounded()) * Double(FLASH_MS_STEP)) }),
                           in: Double(FLASH_MS_MIN)...Double(FLASH_MS_MAX))
                        .accessibilityLabel("Flash duration")
                    Text("\(prefs.appearance.flashMs) ms").font(KioskType.labelMedium).foregroundStyle(palette.text)
                }
            }
        }
    }
}
