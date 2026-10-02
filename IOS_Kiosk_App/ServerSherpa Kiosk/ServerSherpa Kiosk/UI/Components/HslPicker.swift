import SwiftUI

/// One color: swatch, three channel sliders, the hsl() readout, Preview flash.
struct HslPicker: View {
    let label: String
    @Binding var value: Hsl
    let onPreview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8).fill(Color(hsl: value)).frame(width: 40, height: 40)
                Text(hslCss(value)).font(KioskType.labelMedium)
            }
            HslChannel(label: "Hue", owner: label, value: $value.h, max: 360)
            HslChannel(label: "Saturation", owner: label, value: $value.s, max: 100)
            HslChannel(label: "Lightness", owner: label, value: $value.l, max: 100)
            SecondaryButton("Preview flash", action: onPreview)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct HslChannel: View {
    let label: String
    let owner: String
    @Binding var value: Double
    let max: Double

    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(KioskType.bodySmall).frame(width: 84, alignment: .leading)
            Slider(value: Binding(get: { value }, set: { value = $0.rounded() }), in: 0...max)
                .accessibilityLabel("\(owner) \(label.lowercased())")
            Text("\(Int(value.rounded()))").font(KioskType.labelMedium).frame(width: 40, alignment: .trailing)
        }
    }
}
