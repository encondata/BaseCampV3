import SwiftUI
import UIKit

/// A narrow screen's worker page (Route.rolodexWorker), pushed over the list. The shell's
/// "‹ Home" clears the whole stack, so the page has its own "‹ Rolodex" back to the list.
struct RolodexWorkerScreen: View {
    let personId: String
    @Binding var path: [Route]
    @Environment(RolodexModel.self) private var model

    var body: some View {
        RolodexWorkerView(onBack: {
            model.cancelEdit()
            if !path.isEmpty { path.removeLast() }
        })
        .rolodexAdminOnly(path: $path)
        .onAppear {
            // The list's tap already opened this worker; a route reached another way opens it here.
            if model.selectedId != personId { Task { await model.select(personId) } }
        }
    }
}

/// The worker page (mockup 4): photo with its camera badge, name, "job title · company", status
/// and RFID chips, then the Contact and Work cards; Edit turns it into the form. Beside the list
/// on a wide screen (`onBack` nil), full screen with "‹ Rolodex" on a narrow one.
struct RolodexWorkerView: View {
    let onBack: (() -> Void)?
    @Environment(RolodexModel.self) private var model
    @Environment(\.kioskPalette) private var palette
    @State private var width: CGFloat = 0

    /// Room for the photo beside the name (the tablet layout); narrower, it stacks centered.
    private var wide: Bool { width >= 520 }

    var body: some View {
        Group {
            if model.editing != nil {
                RolodexEditForm()
            } else if let row = model.shownRow {
                page(row)
            } else {
                VStack(spacing: 10) {
                    if model.detailLoading {
                        ProgressView().tint(palette.textMute)
                    } else {
                        Text(model.detailError ?? "Choose a worker to see their page.")
                            .font(KioskType.bodyMedium).foregroundStyle(palette.textMute).multilineTextAlignment(.center)
                        if let onBack { LinkButton("‹ Rolodex", action: onBack) }
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(palette.paper2)
    }

    // MARK: the page

    private func page(_ row: RolodexRow) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !wide {
                    HStack {
                        if let onBack { LinkButton("‹ Rolodex", action: onBack).accessibilityIdentifier("rolodex-back") }
                        Spacer()
                        editButton
                    }
                    hero(row, size: 116).frame(maxWidth: .infinity).padding(.top, 4)
                } else {
                    HStack(alignment: .center, spacing: 16) {
                        RolodexPhotoBadge(row: row, size: 84)
                        VStack(alignment: .leading, spacing: 4) { identity(row, alignment: .leading) }
                        Spacer(minLength: 8)
                        editButton
                    }
                }
                if let reason = model.editBlockText {
                    note(reason)
                } else if model.offline {
                    note("Changes need a connection.")
                }
                cards(row)
            }
            .padding(16)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: wide ? .leading : .center)
        }
        .refreshable { await model.refresh() }
    }

    private func hero(_ row: RolodexRow, size: CGFloat) -> some View {
        VStack(spacing: 6) {
            RolodexPhotoBadge(row: row, size: size).padding(.bottom, 6)
            identity(row, alignment: .center)
        }
    }

    @ViewBuilder private func identity(_ row: RolodexRow, alignment: HorizontalAlignment) -> some View {
        Text(rolodexName(row))
            .font(KioskType.sans(21, .semibold)).foregroundStyle(palette.text)
            .multilineTextAlignment(alignment == .center ? .center : .leading)
        if let subtitle = rolodexSubtitle(row) {
            Text(subtitle).font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                .multilineTextAlignment(alignment == .center ? .center : .leading)
        }
        HStack(spacing: 6) {
            RolodexStatusChip(key: row.status, label: row.statusLabel, color: row.statusColor)
            if row.rfidEnrolled { RolodexStatusChip(key: "rfid", label: "RFID enrolled", color: "#0b6e93", dot: false) }
        }
        .padding(.top, 2)
    }

    private var editButton: some View {
        SecondaryButton("Edit", enabled: model.canEdit) { model.startEdit() }
            .fixedSize()
            .accessibilityIdentifier("rolodex-edit")
    }

    private func note(_ text: String) -> some View {
        Text(text).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            .frame(maxWidth: .infinity, alignment: wide ? .trailing : .center)
            .multilineTextAlignment(wide ? .trailing : .center)
            .padding(.top, 8)
    }

    // MARK: cards

    @ViewBuilder private func cards(_ row: RolodexRow) -> some View {
        let detail = model.detail?.personId == row.personId ? model.detail : nil
        RolodexCard(title: "Contact") {
            RolodexKeyValue(key: "Preferred name", value: row.preferredName)
            if let detail {
                RolodexKeyValue(key: "Phone", value: detail.phone)
                RolodexKeyValue(key: "Email", value: detail.email)
            } else {
                pending
            }
        }
        RolodexCard(title: "Work") {
            RolodexKeyValue(key: "Company", value: row.company?.name)
            RolodexKeyValue(key: "Trade · Level", value: rolodexTradeLevel(trade: row.trade, level: row.level))
            if let detail {
                RolodexKeyValue(key: "Employee ID", value: detail.externalId, mono: true)
                if let statusNote = RolodexLogic.clean(detail.statusNote) {
                    RolodexKeyValue(key: "Status note", value: statusNote)
                }
            }
        }
    }

    /// Phone and email arrive with the worker's page, never with the list.
    @ViewBuilder private var pending: some View {
        HStack(spacing: 8) {
            if model.detailLoading { ProgressView().tint(palette.textMute) }
            Text(model.detailLoading ? "Loading contact details…" : (model.detailError ?? "Contact details need a connection."))
                .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(palette.paperLine).frame(height: 1) }
    }
}

/// The photo with its camera badge (Take new photo / Choose photo, Task 10). The badge is off
/// while the worker can't be edited or the kiosk is offline.
private struct RolodexPhotoBadge: View {
    let row: RolodexRow
    let size: CGFloat
    @Environment(RolodexModel.self) private var model
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let badge = size >= 100 ? 34.0 : 28.0
        RolodexAvatar(row: row, size: size)
            .overlay(Circle().stroke(palette.paper, lineWidth: 4))
            .shadow(color: palette.ink.opacity(0.18), radius: 9, y: 4)
            .overlay(alignment: .bottomTrailing) {
                Button { model.startPhoto() } label: {
                    Image(systemName: "camera.fill")
                        .font(.system(size: badge * 0.45, weight: .semibold))
                        .foregroundStyle(palette.ink)
                        .frame(width: badge, height: badge)
                        .background(palette.accent, in: Circle())
                        .overlay(Circle().stroke(palette.paper, lineWidth: 3))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canEdit)
                .opacity(model.canEdit ? 1 : 0.5)
                .offset(x: 8, y: 6)
                .accessibilityLabel("Change photo")
                .accessibilityIdentifier("rolodex-photo")
            }
    }
}

/// `.card` with an eyebrow title and key/value rows.
private struct RolodexCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased()).font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 6)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.paperLine, lineWidth: 1))
        .padding(.top, 12)
    }
}

private struct RolodexKeyValue: View {
    let key: String
    let value: String?
    var mono = false
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let shown = RolodexLogic.clean(value)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(key).font(KioskType.bodyMedium).foregroundStyle(palette.textMute).frame(width: 120, alignment: .leading)
            Text(shown ?? "—")
                .font(mono ? KioskType.mono(14) : KioskType.sans(14, .medium))
                .foregroundStyle(shown == nil ? palette.textMute : palette.text)
                .lineLimit(2)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .overlay(alignment: .top) { Rectangle().fill(palette.paperLine).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Edit

/// The Edit form (mockup 4, "Editing"): names, contact, company, trade, level and status, with
/// Save changes / Cancel pinned below. Blacklist reveals its required note. The status control
/// is off (with the reason) when the server says so. A failed save keeps every field as typed.
private struct RolodexEditForm: View {
    @Environment(RolodexModel.self) private var model
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        if let edit = model.editing, let detail = model.detail {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("EDIT WORKER").font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                            Text(rolodexName(detail.row)).font(KioskType.headline).foregroundStyle(palette.text)
                        }
                        HStack(alignment: .top, spacing: 8) {
                            field("First name *", \.firstName, content: .givenName)
                            field("Last name *", \.lastName, content: .familyName)
                        }
                        field("Preferred name", \.preferredName, content: .nickname)
                        field("Job title", \.jobTitle, content: .jobTitle)
                        field("Phone", \.phone, keyboard: .phonePad, content: .telephoneNumber)
                        field("Email", \.email, keyboard: .emailAddress, content: .emailAddress, capitalize: false)
                        picker("Company", value: edit.partnerId, options: companyOptions(detail)) { model.editing?.partnerId = $0 }
                        HStack(alignment: .top, spacing: 8) {
                            field("Trade", \.trade)
                            picker("Level", value: edit.level, options: levelOptions(detail)) { model.editing?.level = $0 }
                        }
                        status(edit, detail)
                        if edit.status == RolodexLogic.blacklistKey {
                            field("Blacklist note *", \.statusNote, multiline: true)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: 720, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                saveBar
            }
        }
    }

    private var saveBar: some View {
        VStack(spacing: 0) {
            Rectangle().fill(palette.paperLine).frame(height: 1)
            VStack(alignment: .trailing, spacing: 6) {
                KioskToast(text: model.errorText, error: true).accessibilityIdentifier("rolodex-save-error")
                HStack(spacing: 8) {
                    Spacer()
                    SecondaryButton("Cancel", enabled: !model.saving) { model.cancelEdit() }.fixedSize()
                    PrimaryButton(model.saving ? "Saving…" : "Save changes", enabled: !model.saving) {
                        Task {
                            if await model.save() { container.toast.show("Changes saved.") }
                        }
                    }
                    .fixedSize()
                    .accessibilityIdentifier("rolodex-save")
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
        .background(palette.paper)
    }

    // MARK: fields

    private func binding(_ key: WritableKeyPath<RolodexEdit, String>) -> Binding<String> {
        Binding(get: { model.editing?[keyPath: key] ?? "" }, set: { model.editing?[keyPath: key] = $0 })
    }

    private func field(_ label: String, _ key: WritableKeyPath<RolodexEdit, String>, keyboard: UIKeyboardType = .default,
                       content: UITextContentType? = nil, capitalize: Bool = true, multiline: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            Group {
                if multiline {
                    TextField(label, text: binding(key), axis: .vertical).lineLimit(2...5).padding(.vertical, 12)
                } else {
                    TextField(label, text: binding(key))
                }
            }
            .keyboardType(keyboard)
            .textContentType(content)
            .textInputAutocapitalization(capitalize ? .words : .never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .disabled(model.saving)
            .rolodexField(palette)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A menu picker styled as a field; nil is "None".
    private func picker(_ label: String, value: String?, options: [(id: String, name: String)],
                        set: @escaping (String?) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            Menu {
                Button { set(nil) } label: { if value == nil { Label("None", systemImage: "checkmark") } else { Text("None") } }
                ForEach(options, id: \.id) { option in
                    Button { set(option.id) } label: {
                        if option.id == value { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
                    }
                }
            } label: {
                HStack {
                    Text(options.first { $0.id == value }?.name ?? value ?? "None")
                        .foregroundStyle(value == nil ? palette.textMute : palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.textMute)
                }
                .rolodexField(palette)
                .contentShape(Rectangle())
            }
            .disabled(model.saving)
            .accessibilityLabel(label)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Non-archived companies, plus the worker's own when it has since been archived (spec §3.9).
    private func companyOptions(_ detail: RolodexDetail) -> [(id: String, name: String)] {
        var options = model.options.partners.map { (id: $0.id, name: $0.name) }
        if let company = detail.company, !options.contains(where: { $0.id == company.id }) {
            options.append((id: company.id, name: company.name))
        }
        return options
    }

    /// The level scale ("L3 · Lead"), plus the worker's own level when the scale didn't load.
    private func levelOptions(_ detail: RolodexDetail) -> [(id: String, name: String)] {
        var options = model.options.levels.map { (id: $0.level, name: $0.title.isEmpty ? $0.level : "\($0.level) · \($0.title)") }
        if let level = detail.level, !options.contains(where: { $0.id == level }) {
            options.append((id: level, name: level))
        }
        return options
    }

    @ViewBuilder private func status(_ edit: RolodexEdit, _ detail: RolodexDetail) -> some View {
        let statuses = statusOptions(detail)
        let locked = !detail.canChangeStatus || model.saving
        VStack(alignment: .leading, spacing: 4) {
            Text("Status").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            Segmented(options: statuses.map { ($0.key, $0.label.isEmpty ? $0.key.capitalized : $0.label) },
                      selection: Binding(get: { model.editing?.status ?? edit.status }, set: { model.editing?.status = $0 }))
                .disabled(locked)
                .opacity(detail.canChangeStatus ? 1 : 0.5)
                .accessibilityIdentifier("rolodex-status")
            if let reason = model.statusBlockText {
                Text(reason).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            }
        }
    }

    /// The server's statuses (with the worker's own when it's no longer offered).
    private func statusOptions(_ detail: RolodexDetail) -> [RolodexStatus] {
        var statuses = model.statusFilters
        if !detail.status.isEmpty, !statuses.contains(where: { $0.key == detail.status }) {
            statuses.append(RolodexStatus(key: detail.status, label: detail.statusLabel, color: detail.statusColor))
        }
        return statuses
    }
}
