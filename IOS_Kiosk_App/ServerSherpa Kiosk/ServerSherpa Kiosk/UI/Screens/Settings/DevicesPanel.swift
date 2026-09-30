import GameController
import SwiftUI

/// Settings › Devices: which scan inputs this device has, and which camera scans.
struct DevicesPanel: View {
    @Environment(KioskPrefs.self) private var prefs
    @Environment(\.kioskPalette) private var palette
    @State private var caps = DeviceCapabilities.current()

    private func line(_ text: String) -> some View {
        Text(text).font(KioskType.bodyMedium).foregroundStyle(palette.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsRow(title: "Camera", detail: "Barcode scanning with the camera, single or multi read.") { line(caps.camera) }
            if DeviceCapabilities.offersCameraChoice(hasBack: CameraSupport.hasBackCamera, hasFront: CameraSupport.hasFrontCamera) {
                SettingsRow(title: "Camera used for scanning", detail: "Which camera opens first when you scan with the camera. You can still flip it while scanning.") {
                    Segmented(options: [(CameraPosition.back, "Back"), (CameraPosition.front, "Front")],
                              selection: Binding(get: { prefs.cameraPosition }, set: { prefs.cameraPosition = $0 }))
                }
            }
            SettingsRow(title: "Torch", detail: "The flashlight, for scanning in the dark.") { line(caps.torch) }
            SettingsRow(title: "Hardware keyboard / HID scanner", detail: "A Bluetooth or USB scanner types into the focused box like a keyboard.") { line(caps.keyboard) }
        }
        .onAppear { caps = DeviceCapabilities.current() }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in caps = DeviceCapabilities.current() }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in caps = DeviceCapabilities.current() }
    }
}
