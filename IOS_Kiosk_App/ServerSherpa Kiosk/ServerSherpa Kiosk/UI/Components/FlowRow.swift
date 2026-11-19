import SwiftUI

/// Which items go on which line: left to right, a new line when the next item doesn't fit in
/// `maxWidth`. An item wider than the line gets a line of its own.
func flowLines(_ widths: [CGFloat], maxWidth: CGFloat, spacing: CGFloat) -> [[Int]] {
    var lines: [[Int]] = []
    var current: [Int] = []
    var used: CGFloat = 0
    for (i, w) in widths.enumerated() {
        if !current.isEmpty, used + spacing + w > maxWidth {
            lines.append(current)
            current = []
            used = 0
        }
        used += (current.isEmpty ? 0 : spacing) + w
        current.append(i)
    }
    if !current.isEmpty { lines.append(current) }
    return lines
}

/// Android's FlowRow: children left to right, wrapping onto new lines, each line's items aligned
/// to its center. A child is never wider than the row (its text wraps instead).
struct FlowRow: Layout {
    var spacing: CGFloat = 16
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let sizes = measure(subviews, maxWidth: maxWidth)
        let lines = flowLines(sizes.map(\.width), maxWidth: maxWidth, spacing: spacing)
        var width: CGFloat = 0
        var height: CGFloat = 0
        for (n, line) in lines.enumerated() {
            width = max(width, line.map { sizes[$0].width }.reduce(0, +) + spacing * CGFloat(line.count - 1))
            height += (line.map { sizes[$0].height }.max() ?? 0) + (n > 0 ? lineSpacing : 0)
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = measure(subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for line in flowLines(sizes.map(\.width), maxWidth: bounds.width, spacing: spacing) {
            let lineHeight = line.map { sizes[$0].height }.max() ?? 0
            var x = bounds.minX
            for i in line {
                subviews[i].place(at: CGPoint(x: x, y: y + (lineHeight - sizes[i].height) / 2), anchor: .topLeading,
                                  proposal: ProposedViewSize(sizes[i]))
                x += sizes[i].width + spacing
            }
            y += lineHeight + lineSpacing
        }
    }

    /// Each child's natural size, no wider than the row.
    private func measure(_ subviews: Subviews, maxWidth: CGFloat) -> [CGSize] {
        subviews.map { view in
            let natural = view.sizeThatFits(.unspecified)
            guard natural.width > maxWidth else { return natural }
            return view.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        }
    }
}
