import PhotosUI
import SwiftUI
import UIKit

/// "+ New" (mockups 3–4), full screen: "New worker · Step 1 of 2 · Details", then the photo step
/// (camera or library, with the quiet "Continue without photo" and its confirmation), then
/// "Position your photo" and Create worker. The "Possible duplicate" sheet shows over whichever
/// step found the matches. Every bit of state is in `RolodexNewWorkerFlow`.
struct NewWorkerFlowView: View {
    @Bindable var flow: RolodexNewWorkerFlow
    @Environment(RolodexModel.self) private var model
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette
    @State private var picked: PhotosPickerItem?

    var body: some View {
        Group {
            switch flow.stage {
            case .details:
                NewWorkerDetailsStep(flow: flow)
            case .photo:
                PhotoCaptureView(backTitle: "‹ Details", onBack: { flow.backToDetails() }, front: $flow.frontCamera,
                                 busyText: flow.loadingPhoto ? "Loading photo…" : (flow.creating ? "Creating…" : nil),
                                 errorText: flow.errorText, onCapture: { data in Task { await flow.use(data) } },
                                 onLibrary: { flow.library = true }) {
                    Button { flow.continueWithoutPhoto() } label: {
                        Text("Continue without photo")
                            .font(KioskType.sans(14, .medium))
                            .underline()
                            .foregroundStyle(Color.white.opacity(0.75))
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(flow.busy)
                    .accessibilityIdentifier("new-worker-skip-photo")
                }
            case .crop:
                if let crop = flow.crop {
                    PhotoCropView(crop: crop, useTitle: "Create worker", busyText: flow.creating ? "Creating…" : nil,
                                  errorText: flow.errorText, onRetake: { flow.retake() },
                                  onUse: { Task { await flow.createWithPhoto() } })
                }
            }
        }
        .sheet(isPresented: Binding(get: { flow.showMatches }, set: { if !$0 { flow.dismissMatches() } })) {
            RolodexDuplicateSheet(flow: flow)
                .rolodexPresented(container, model, palette)
                .presentationDetents([.medium, .large])
                .presentationBackground(palette.paper)
                .presentationCornerRadius(16)
                .interactiveDismissDisabled(flow.busy)
        }
        .photosPicker(isPresented: $flow.library, selection: $picked, matching: .images, preferredItemEncoding: .current)
        .onChange(of: picked) { _, item in
            guard let item else { return }
            picked = nil
            Task { await flow.use { try await item.loadTransferable(type: Data.self) } }
        }
        // The default (bold, cancel-placed) choice goes back to the camera.
        .alert(flow.confirmTitle, isPresented: $flow.confirmNoPhoto) {
            Button("Take photo", role: .cancel) { flow.takePhotoInstead() }
            Button("Create without photo") { Task { await flow.createWithoutPhoto() } }
        } message: {
            Text(RolodexNewWorkerFlow.confirmMessage)
        }
    }
}

/// Step 1 of 2: first and last name (required), preferred name, job title, phone, email,
/// company, trade and level. A new worker starts Active (status isn't on this form).
private struct NewWorkerDetailsStep: View {
    @Bindable var flow: RolodexNewWorkerFlow
    @Environment(RolodexModel.self) private var model
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Capsule().fill(palette.accent).frame(height: 4)
                            Capsule().fill(palette.paperLine).frame(height: 4)
                        }
                        Text("STEP 1 OF 2 · DETAILS").font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                    }
                    .accessibilityElement(children: .combine)
                    HStack(alignment: .top, spacing: 8) {
                        field("First name *", $flow.form.firstName, content: .givenName)
                        field("Last name *", $flow.form.lastName, content: .familyName)
                    }
                    field("Preferred name", $flow.form.preferredName, content: .nickname)
                    field("Job title", $flow.form.jobTitle, content: .jobTitle)
                    HStack(alignment: .top, spacing: 8) {
                        field("Phone", $flow.form.phone, keyboard: .phonePad, content: .telephoneNumber)
                        field("Email", $flow.form.email, keyboard: .emailAddress, content: .emailAddress, capitalize: false)
                    }
                    RolodexMenuField(label: "Company", value: flow.form.partnerId,
                                     options: rolodexCompanyOptions(model.options, current: nil),
                                     placeholder: "Choose a company", disabled: flow.busy) { flow.form.partnerId = $0 }
                    HStack(alignment: .top, spacing: 8) {
                        field("Trade", $flow.form.trade)
                        RolodexMenuField(label: "Level", value: flow.form.level,
                                         options: rolodexLevelOptions(model.options, current: nil),
                                         placeholder: "Choose a level", disabled: flow.busy) { flow.form.level = $0 }
                    }
                }
                .padding(16)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            nextBar
        }
        .background(palette.paper2.ignoresSafeArea())
    }

    private var topBar: some View {
        ZStack {
            Text("New worker").font(KioskType.sans(16, .semibold)).foregroundStyle(palette.snow)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Button { flow.cancel() } label: {
                    Text("Cancel").font(KioskType.labelLarge).foregroundStyle(palette.accent)
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(flow.creating)
                .accessibilityIdentifier("new-worker-cancel")
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .background(palette.ink.ignoresSafeArea(edges: .top))
    }

    private var nextBar: some View {
        VStack(spacing: 0) {
            Rectangle().fill(palette.paperLine).frame(height: 1)
            VStack(spacing: 4) {
                KioskToast(text: flow.errorText, error: true).accessibilityIdentifier("new-worker-error")
                Button { Task { await flow.next() } } label: {
                    HStack(spacing: 8) {
                        if flow.checking { ProgressView().tint(palette.ink) }
                        Text(flow.checking ? "Checking…" : "Next: photo").font(KioskType.labelLarge).foregroundStyle(palette.ink)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(palette.accent, in: RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(flow.busy)
                .opacity(flow.busy ? 0.6 : 1)
                .accessibilityIdentifier("new-worker-next")
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: 720)
        }
        .frame(maxWidth: .infinity)
        .background(palette.paper.ignoresSafeArea(edges: .bottom))
    }

    private func field(_ label: String, _ text: Binding<String>, keyboard: UIKeyboardType = .default,
                       content: UITextContentType? = nil, capitalize: Bool = true) -> some View {
        RolodexTextField(label: label, text: text, keyboard: keyboard, content: content, capitalize: capitalize, disabled: flow.busy)
    }
}

/// "Possible duplicate": the people the new worker may already be, each with photo, name, job
/// title and company. A worker has Open; anyone else is "Already in the portal, not a worker. Add
/// the worker role there." An email match blocks Create anyway (the email can't be reused).
private struct RolodexDuplicateSheet: View {
    let flow: RolodexNewWorkerFlow
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("NEW WORKER").font(KioskType.labelSmall).tracking(1).foregroundStyle(palette.textMute)
                Text("Possible duplicate").font(KioskType.headline).foregroundStyle(palette.text)
                    .accessibilityAddTraits(.isHeader)
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(flow.matches.enumerated()), id: \.element.id) { i, match in
                        if i > 0 { Rectangle().fill(palette.paperLine).frame(height: 1) }
                        row(match)
                    }
                }
                .background(palette.paper2, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.paperLine, lineWidth: 1))
            }
            KioskToast(text: flow.blockText, error: true).accessibilityIdentifier("new-worker-email-block")
            HStack(spacing: 8) {
                SecondaryButton("Back", enabled: !flow.busy) { flow.dismissMatches() }.fixedSize()
                Spacer()
                PrimaryButton(flow.creating ? "Creating…" : "Create anyway", enabled: flow.canCreateAnyway && !flow.busy) {
                    Task { await flow.createAnyway() }
                }
                .fixedSize()
                .accessibilityIdentifier("new-worker-create-anyway")
            }
        }
        .padding(16)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
    }

    private func row(_ match: RolodexMatch) -> some View {
        HStack(spacing: 12) {
            RolodexAvatar(row: RolodexRow(personId: match.personId, displayName: match.displayName, hasPhoto: match.photoVersion != nil,
                                          photoUrl: match.photoUrl, photoVersion: match.photoVersion), size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(match.displayName).font(KioskType.sans(15, .semibold)).foregroundStyle(palette.text).lineLimit(1)
                if let subtitle = rolodexMatchSubtitle(match) {
                    Text(subtitle).font(KioskType.bodySmall).foregroundStyle(palette.textMute).lineLimit(1)
                }
                if let note = RolodexNewWorkerFlow.note(for: match) {
                    Text(note).font(KioskType.bodySmall).foregroundStyle(palette.textMute).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 6)
            if RolodexNewWorkerFlow.canOpen(match) {
                SecondaryButton("Open", enabled: !flow.busy) { Task { await flow.openMatch(match) } }
                    .fixedSize()
                    .accessibilityIdentifier("new-worker-open-\(match.personId)")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }
}

/// "Job title · Company" for a possible duplicate, each part only when set.
func rolodexMatchSubtitle(_ match: RolodexMatch) -> String? {
    let parts = [match.jobTitle, match.company].compactMap { RolodexLogic.clean($0) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}
