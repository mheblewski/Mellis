import Foundation

/// How wide the "Teraz" chips (IOB, COB, basal) are. Only two looks, so a difference never reads as an accident: all
/// equal while each content fits its share with room to spare, otherwise the long one clearly wider, with room inside,
/// and the others equal to each other. No chip ever gets less than its content needs while the row can give it.
public enum DashboardChipWidths {
    /// The room a chip's content should have on top of what it needs, not to look squeezed.
    static let breathingRoom = 16.0
    /// A wider chip takes at least this part of the row: a few points more would look like a mistake.
    static let wideShare = 0.40

    public static func widths(needs: [Double], free: Double) -> [Double] {
        guard !needs.isEmpty else { return [] }
        let equal = free / Double(needs.count)
        let isWide = needs.map { $0 + breathingRoom > equal }
        guard isWide.contains(true) else { return needs.map { _ in equal } }

        let wants = needs.map { max($0 + breathingRoom, free * wideShare) }
        let wideNeeds = zip(needs, isWide).filter(\.1).map(\.0).reduce(0, +)
        let wideWants = zip(wants, isWide).filter(\.1).map(\.0).reduce(0, +)
        let narrowNeeds = zip(needs, isWide).filter { !$0.1 }.map(\.0)
        let narrowCount = Double(narrowNeeds.count)
        // The others keep what the longest of them needs; the wide ones get their room from what is left.
        let forWide = free - (narrowNeeds.max() ?? 0) * narrowCount
        let extra = wideWants > wideNeeds ? (forWide - wideNeeds) / (wideWants - wideNeeds) : 0
        let portion = min(max(extra, 0), 1)
        let wide = zip(needs, wants).map { $0 + ($1 - $0) * portion }
        let wideTotal = zip(wide, isWide).filter(\.1).map(\.0).reduce(0, +)
        let narrow = narrowCount > 0 ? (free - wideTotal) / narrowCount : 0
        return needs.indices.map { isWide[$0] ? wide[$0] : narrow }
    }
}
