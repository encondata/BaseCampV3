import SwiftUI

/// `.segmented`: a row of tabs/radios; `options` are (value, label). Scrolls when narrow.
struct Segmented<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T
    @Environment(\.kioskPalette) private var palette

    init(options: [(T, String)], selection: Binding<T>) {
        self.options = options
        self._selection = selection
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(options, id: \.0) { value, label in
                    let on = value == selection
                    Button { selection = value } label: {
                        Text(label)
                            .font(KioskType.labelLarge)
                            .foregroundStyle(on ? palette.ink : palette.text)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 48)
                            .background(on ? palette.accent : palette.paper2, in: RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(3)
            .background(palette.paper2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
