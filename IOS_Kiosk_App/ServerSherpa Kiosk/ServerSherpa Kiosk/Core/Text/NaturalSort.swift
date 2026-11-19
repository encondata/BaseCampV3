import Foundation

/// Port of Android `core/text/NaturalSort.kt` (the portal's ICU collator, numeric and
/// case-insensitive): digit runs compare by value, everything else by lowercase UTF-16 unit.
/// Nil sorts as "". Negative, zero or positive, like `compareTo`.
func naturalCompare(_ a: String?, _ b: String?) -> Int {
    let x = Array((a ?? "").lowercased().utf16)
    let y = Array((b ?? "").lowercased().utf16)
    func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    func sign(_ l: Int, _ r: Int) -> Int { l < r ? -1 : (l > r ? 1 : 0) }
    var i = 0
    var j = 0
    var tie = 0
    while i < x.count && j < y.count {
        let cx = x[i]
        let cy = y[j]
        if isDigit(cx) && isDigit(cy) {
            var ei = i
            while ei < x.count && isDigit(x[ei]) { ei += 1 }
            var ej = j
            while ej < y.count && isDigit(y[ej]) { ej += 1 }
            let rx = x[i..<ei]
            let ry = y[j..<ej]
            let sx = rx.drop { $0 == 0x30 }
            let sy = ry.drop { $0 == 0x30 }
            if sx.count != sy.count { return sign(sx.count, sy.count) }
            for (dx, dy) in zip(sx, sy) where dx != dy { return sign(Int(dx), Int(dy)) }
            // equal value: the run with fewer leading zeros first (decided after the rest)
            if tie == 0 && rx.count != ry.count { tie = sign(rx.count, ry.count) }
            i = ei
            j = ej
        } else {
            if cx != cy { return sign(Int(cx), Int(cy)) }
            i += 1
            j += 1
        }
    }
    if i < x.count { return 1 }
    if j < y.count { return -1 }
    return tie
}
