import SwiftUI

/// The worker page's "Previous jobs" card, below the details: one row per initiative the worker
/// was added to, newest first (the latest 50), or "No jobs yet.". A row is the initiative's name
/// (wrapping, never cut), "Type · Work type · Site", the date they were added and the
/// initiative's status chip in its own color. When the worker has more jobs than were sent
/// (`total`), a last line says so. Words come from `RolodexLogic` (the Android page's, verbatim).
struct WorkerJobsCard: View {
    let jobs: [RolodexJob]
    let total: Int
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let shown = RolodexLogic.jobsShown(jobs)
        RolodexCard(title: "Previous jobs") {
            if shown.isEmpty {
                line(RolodexLogic.noJobsText, font: KioskType.bodyMedium).accessibilityIdentifier("worker-jobs-empty")
            }
            ForEach(shown) { job in row(job) }
            if let more = RolodexLogic.jobsShownText(shown: shown.count, total: total) {
                line(more, font: KioskType.bodySmall).accessibilityIdentifier("worker-jobs-shown")
            }
        }
        .accessibilityIdentifier("worker-jobs")
    }

    private func line(_ text: String, font: Font) -> some View {
        Text(text).font(font).foregroundStyle(palette.textMute)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Rectangle().fill(palette.paperLine).frame(height: 1) }
    }

    private func row(_ job: RolodexJob) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(job.initiativeName).font(KioskType.sans(14, .semibold)).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = RolodexLogic.jobLine(job) {
                    Text(detail).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                }
                if let added = RolodexLogic.jobAddedText(job.addedAt) {
                    Text(added).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                }
            }
            Spacer(minLength: 0)
            if !job.statusLabel.trimmingCharacters(in: .whitespaces).isEmpty {
                // At most 120 pt, a long custom status ellipsized, so the name keeps its room.
                RolodexStatusChip(key: "", label: job.statusLabel, color: job.statusColor, dot: false)
                    .frame(maxWidth: 120)
                    .accessibilityIdentifier("worker-job-status")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(palette.paperLine).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("worker-job-\(job.initiativeId)")
    }
}
