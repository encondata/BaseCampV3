import SwiftUI

// MARK: - Row text (pure, tested)

/// The name a row shows: preferred (else first) name and last name, as the server's display name.
func rolodexName(_ row: RolodexRow) -> String {
    let name = "\(RolodexLogic.clean(row.preferredName) ?? row.firstName) \(row.lastName)".trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? row.displayName : name
}

/// "Job title · Company", each part only when set.
func rolodexSubtitle(_ row: RolodexRow) -> String? {
    let parts = [row.jobTitle, row.company?.name].compactMap { RolodexLogic.clean($0) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

/// "Trade · Level", each part only when set.
func rolodexTradeLevel(trade: String?, level: String?) -> String? {
    let parts = [trade, level].compactMap { RolodexLogic.clean($0) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

/// The list's title: "112 workers", "1 worker".
func rolodexWorkerCount(_ n: Int) -> String { n == 1 ? "1 worker" : "\(n) workers" }

/// Which of `count` jump-strip letters a drag at `y` (in a strip `height` tall) points at; nil
/// with no strip.
func rolodexJumpIndex(y: CGFloat, height: CGFloat, count: Int) -> Int? {
    guard count > 0, height > 0 else { return nil }
    let i = Int((y / height * CGFloat(count)).rounded(.down))
    return min(max(i, 0), count - 1)
}

// MARK: - The list

/// The Rolodex list (mockup 2): "Rolodex" / "N workers" with + New, the offline banner, search,
/// filter chips with counts, then A–Z sections with a jump strip down the right edge.
struct RolodexListView: View {
    /// Beside the worker page (the selected row is highlighted).
    let split: Bool
    let onSelect: (String) -> Void
    @Environment(RolodexModel.self) private var model
    @Environment(\.kioskPalette) private var palette
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                header
                if model.offline, let at = model.cachedAt {
                    RolodexBanner(text: RolodexModel.offlineText(cachedAt: at, now: Date()))
                        .accessibilityIdentifier("rolodex-offline")
                }
                KioskToast(text: model.listError, error: true)
                search($model.query)
                chips
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            Rectangle().fill(palette.paperLine).frame(height: 1)
            list
        }
        .background(palette.paper2)
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("ROLODEX").font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                Text(model.loaded ? rolodexWorkerCount(model.rows.count) : "Workers")
                    .font(KioskType.headline).foregroundStyle(palette.text)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            Spacer(minLength: 8)
            Button { Task { await model.refresh() } } label: {
                Group {
                    if model.loading { ProgressView().tint(palette.textMute) } else {
                        Image(systemName: "arrow.clockwise").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.loading)
            .accessibilityLabel("Refresh")
            PrimaryButton("+ New", enabled: model.canStartNewWorker && !model.offline) { model.startNewWorker() }
                .fixedSize()
                .accessibilityIdentifier("rolodex-new")
        }
    }

    // MARK: search and chips

    private func search(_ query: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.textMute)
            TextField("Search by name, job or company…", text: query)
                .font(KioskType.bodyLarge)
                .foregroundStyle(palette.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
                .accessibilityIdentifier("rolodex-search")
            if !query.wrappedValue.isEmpty {
                Button { query.wrappedValue = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 17)).foregroundStyle(palette.textMute)
                        .frame(width: 32, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 46)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(searchFocused ? palette.accent : palette.paperLine, lineWidth: searchFocused ? 2 : 1))
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.filterChips) { chip in
                    let on = chip.key == model.filter
                    // Ink on paper; on a dark theme the inverse, or the chip would vanish.
                    let fill = palette.isDark ? palette.snow : palette.ink
                    let ink = palette.isDark ? palette.ink : palette.snow
                    Button { model.filter = chip.key } label: {
                        HStack(spacing: 5) {
                            Text(chip.label)
                            Text("\(chip.count)").foregroundStyle(on ? ink.opacity(0.7) : palette.textMute)
                        }
                        .font(KioskType.sans(13, .medium))
                        .foregroundStyle(on ? ink : palette.text)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .background(on ? fill : palette.paper, in: Capsule())
                        .overlay(Capsule().stroke(on ? fill : palette.paperLine, lineWidth: 1))
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(chip.label), \(chip.count)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
    }

    // MARK: the list

    @ViewBuilder private var list: some View {
        if model.sections.isEmpty {
            VStack(spacing: 10) {
                if model.loading && !model.loaded {
                    ProgressView().tint(palette.textMute)
                    Text("Loading workers…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                } else if model.loaded {
                    Text(model.rows.isEmpty ? "No workers yet." : "No workers match.")
                        .font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                List {
                    ForEach(model.sections) { section in
                        Section {
                            ForEach(section.rows) { row in
                                Button { onSelect(row.personId) } label: {
                                    RolodexListRow(row: row, selected: split && row.personId == model.selectedId,
                                                   stripPadding: model.sections.count > 1)
                                }
                                .buttonStyle(.plain)
                                // Beside an open Edit form a stray tap can't throw away what was typed
                                // (ruling S18); a phone's list (the form hidden) opens that form instead.
                                .disabled(split && model.selectionLocked)
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(palette.paper)
                                .listRowSeparatorTint(palette.paperLine)
                                .id(row.personId)
                                .accessibilityIdentifier("rolodex-row-\(row.personId)")
                            }
                        } header: {
                            Text(section.letter)
                                .font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                                .padding(.horizontal, 14).padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(palette.paper2)
                                .listRowInsets(EdgeInsets())
                                .accessibilityAddTraits(.isHeader)
                        }
                        .listSectionSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .listSectionSpacing(0)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 44)
                .scrollDismissesKeyboard(.immediately)
                .refreshable { await model.refresh() }
                .overlay(alignment: .trailing) {
                    if model.sections.count > 1 {
                        RolodexJumpStrip(letters: model.sections.map(\.letter)) { letter in
                            guard let first = model.sections.first(where: { $0.letter == letter })?.rows.first else { return }
                            proxy.scrollTo(first.personId, anchor: .top)
                        }
                        .padding(.trailing, 2)
                    }
                }
            }
        }
    }
}

/// The offline line over the list: amber, not an error (the list still works, read-only).
private struct RolodexBanner: View {
    let text: String
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "wifi.slash").font(.system(size: 13, weight: .semibold)).foregroundStyle(ChipTone.amber.text)
            Text(text).font(KioskType.bodyMedium).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(ChipTone.amber.bg, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(ChipTone.amber.border, lineWidth: 1))
    }
}

/// One worker: 44 pt photo or initials, name, "job title · company", status chip.
private struct RolodexListRow: View {
    let row: RolodexRow
    let selected: Bool
    /// Room on the right for the jump strip.
    let stripPadding: Bool
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            RolodexAvatar(row: row, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(rolodexName(row)).font(KioskType.sans(15, .semibold)).foregroundStyle(palette.text).lineLimit(1)
                if let subtitle = rolodexSubtitle(row) {
                    Text(subtitle).font(KioskType.bodySmall).foregroundStyle(palette.textMute).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            RolodexStatusChip(key: row.status, label: row.statusLabel, color: row.statusColor)
        }
        .padding(.vertical, 8)
        .padding(.leading, 14)
        .padding(.trailing, stripPadding ? 26 : 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? palette.accent.opacity(0.14) : palette.paper)
        .overlay(alignment: .leading) {
            if selected { Rectangle().fill(palette.accent).frame(width: 3) }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The letters down the list's right edge: touch or drag to jump to a section.
private struct RolodexJumpStrip: View {
    let letters: [String]
    let onJump: (String) -> Void
    @Environment(\.kioskPalette) private var palette
    @State private var height: CGFloat = 0
    @State private var last: String?

    var body: some View {
        VStack(spacing: 1) {
            ForEach(letters, id: \.self) { letter in
                Text(letter).font(KioskType.mono(11)).foregroundStyle(palette.accent).frame(width: 20, height: 15)
            }
        }
        .padding(.vertical, 6)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    guard let i = rolodexJumpIndex(y: value.location.y, height: height, count: letters.count) else { return }
                    let letter = letters[i]
                    if letter != last {
                        last = letter
                        onJump(letter)
                    }
                }
                .onEnded { _ in last = nil }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Jump to letter")
        .accessibilityAdjustableAction { direction in
            let current = last.flatMap { letters.firstIndex(of: $0) } ?? -1
            let next = direction == .increment ? min(current + 1, letters.count - 1) : max(current - 1, 0)
            guard letters.indices.contains(next) else { return }
            last = letters[next]
            onJump(letters[next])
        }
    }
}
