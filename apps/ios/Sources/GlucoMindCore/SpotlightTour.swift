import CoreGraphics
import Foundation

// A guided spotlight tour over one screen: the screen dimmed, one element cut out of the dim at a time, a callout next
// to it with the text, "N/M", "Dalej" ("Gotowe" last) and "Pomiń". The state machine and the persistence live here
// (testable without SwiftUI); the app draws it (SpotlightTourOverlay, `.tourAnchor(id)`). The Bolus tab's tour is the
// first (BolusTour); Dashboard and Rozmowy can add their own steps the same way.
//
// Shown once per person on this phone and server (SetupGuideKey): the "seen" mark is set only by "Gotowe" or "Pomiń"
// (closing the app in the middle shows it again next time). Reopening it (the "?" button, Ustawienia) never clears it.

/// One step: the element it points at (its anchor id) and what the callout says.
public struct SpotlightTourStep: Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

/// Where the person is in a tour. A value: the screen keeps it in its state and every change redraws the overlay.
public struct SpotlightTour: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        /// "Gotowe" on the last step.
        case completed
        /// "Pomiń".
        case skipped
        /// The screen went away or something more important came up (a send, another screen).
        case interrupted
    }

    public let tourID: String
    public let steps: [SpotlightTourStep]
    /// The step on screen; nil once the tour is over.
    public private(set) var index: Int?
    /// Steps whose element never showed up on screen: passed over and left out of "N/M".
    public private(set) var missing: Set<String> = []
    public private(set) var outcome: Outcome?

    /// - startAt: the step to open at (fixtures); the first available one at or after it.
    /// - isAvailable: whether a step's element can be shown now (real or as a sample); the others are passed over.
    public init(tourID: String, steps: [SpotlightTourStep], startAt: String? = nil, isAvailable: (String) -> Bool = { _ in true }) {
        self.tourID = tourID
        self.steps = steps
        let start = startAt.flatMap { id in steps.firstIndex { $0.id == id } } ?? 0
        index = Self.firstAvailable(in: steps, from: start, missing: [], isAvailable: isAvailable)
        if index == nil { outcome = .completed }
    }

    public var isActive: Bool { index != nil }
    public var current: SpotlightTourStep? { index.map { steps[$0] } }
    public var isLastStep: Bool { isLast(isAvailable: { _ in true }) }

    /// "Gotowe" instead of "Dalej": no available step follows.
    public func isLast(isAvailable: (String) -> Bool) -> Bool {
        guard let index else { return false }
        return Self.firstAvailable(in: steps, from: index + 1, missing: missing, isAvailable: isAvailable) == nil
    }

    /// "N/M": the current step among the steps that can be shown.
    public func progress(isAvailable: (String) -> Bool = { _ in true }) -> (position: Int, total: Int) {
        let shown = steps.filter { !missing.contains($0.id) && isAvailable($0.id) }
        guard let current else { return (shown.count, shown.count) }
        let position = (shown.firstIndex { $0.id == current.id } ?? 0) + 1
        return (position, shown.count)
    }

    public func progressText(isAvailable: (String) -> Bool = { _ in true }) -> String {
        let progress = progress(isAvailable: isAvailable)
        return "\(progress.position)/\(progress.total)"
    }

    /// "Dalej" ("Gotowe" on the last step): the next available step, or the end.
    public mutating func next(isAvailable: (String) -> Bool = { _ in true }) {
        guard let index else { return }
        if let following = Self.firstAvailable(in: steps, from: index + 1, missing: missing, isAvailable: isAvailable) {
            self.index = following
        } else {
            self.index = nil
            outcome = .completed
        }
    }

    /// "Pomiń": the whole tour ends.
    public mutating func skip() {
        guard isActive else { return }
        index = nil
        outcome = .skipped
    }

    /// The tour stops without being finished (the screen went away, a send started).
    public mutating func interrupt() {
        guard isActive else { return }
        index = nil
        outcome = .interrupted
    }

    /// The current step's element never appeared: the tour moves on without it (and leaves it out of "N/M").
    public mutating func stepIsMissing(_ id: String, isAvailable: (String) -> Bool = { _ in true }) {
        guard current?.id == id else { return }
        missing.insert(id)
        next(isAvailable: isAvailable)
    }

    private static func firstAvailable(in steps: [SpotlightTourStep], from start: Int, missing: Set<String>, isAvailable: (String) -> Bool) -> Int? {
        guard start < steps.count else { return nil }
        return (start..<steps.count).first { !missing.contains(steps[$0].id) && isAvailable(steps[$0].id) }
    }
}

/// The tour's "seen" marks on this phone, per tour, server and person (SetupGuideKey.make).
public protocol SpotlightTourSeenStoring {
    func hasSeen(tourID: String, key: String) -> Bool
    func markSeen(tourID: String, key: String)
}

public struct UserDefaultsSpotlightTourSeenStore: SpotlightTourSeenStoring {
    static let prefix = "mellis.tour.seen."
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func hasSeen(tourID: String, key: String) -> Bool { defaults.bool(forKey: Self.prefix + tourID + "." + key) }
    public func markSeen(tourID: String, key: String) { defaults.set(true, forKey: Self.prefix + tourID + "." + key) }
}

public final class InMemorySpotlightTourSeenStore: SpotlightTourSeenStoring {
    public private(set) var seen: Set<String> = []
    public init() {}
    public func hasSeen(tourID: String, key: String) -> Bool { seen.contains(tourID + "|" + key) }
    public func markSeen(tourID: String, key: String) { seen.insert(tourID + "|" + key) }
}

public enum SpotlightTourSeen {
    /// The tour opens by itself only for a known person who has not seen it on this phone and server.
    public static func shouldAutoStart(tourID: String, key: String?, store: SpotlightTourSeenStoring) -> Bool {
        guard let key else { return false }
        return !store.hasSeen(tourID: tourID, key: key)
    }

    /// The tour ended (by itself or reopened): "Gotowe" or "Pomiń" mark it seen, so it never opens by itself again for
    /// this person here; an interruption (the app closed, a send, another tab) does not. Nothing ever clears the mark,
    /// so reopening the tour does not reset it.
    public static func noteEnded(_ outcome: SpotlightTour.Outcome, tourID: String, key: String?, store: SpotlightTourSeenStoring) {
        guard let key, outcome == .completed || outcome == .skipped else { return }
        store.markSeen(tourID: tourID, key: key)
    }
}

/// Where the callout goes next to the cut-out element: below it when it fits, else above, else on the side with more
/// room with the callout scrolling (a large text size); always inside the screen's margins.
public struct SpotlightCalloutPlacement: Equatable, Sendable {
    public enum Edge: Equatable, Sendable { case below, above }

    public let edge: Edge
    /// The callout's top-left corner, in the container's coordinates.
    public let origin: CGPoint
    /// The callout's width and the height it may take (its content scrolls inside when taller).
    public let width: CGFloat
    public let maxHeight: CGFloat

    /// - target: the cut-out (the element plus its padding), in the container's coordinates.
    /// - calloutHeight: the callout's natural height at `width`.
    public init(edge: Edge, origin: CGPoint, width: CGFloat, maxHeight: CGFloat) {
        self.edge = edge
        self.origin = origin
        self.width = width
        self.maxHeight = maxHeight
    }

    public static func place(target: CGRect, calloutHeight: CGFloat, container: CGSize, margin: CGFloat = 16, gap: CGFloat = 12, maxWidth: CGFloat = 380, minHeight: CGFloat = 140) -> SpotlightCalloutPlacement {
        let width = max(0, min(container.width - 2 * margin, maxWidth))
        let x = min(max(margin, target.midX - width / 2), max(margin, container.width - margin - width))
        let below = container.height - margin - (target.maxY + gap)
        let above = (target.minY - gap) - margin
        if calloutHeight <= below {
            return .init(edge: .below, origin: CGPoint(x: x, y: target.maxY + gap), width: width, maxHeight: below)
        }
        if calloutHeight <= above {
            return .init(edge: .above, origin: CGPoint(x: x, y: target.minY - gap - calloutHeight), width: width, maxHeight: above)
        }
        // Too tall for either side: the side with more room, the callout scrolling. A target taller than the screen
        // allows (a very large text size) is covered in part rather than the callout getting too small to read.
        let available = max(minHeight, min(max(below, above), container.height - 2 * margin))
        let height = min(calloutHeight, available)
        if below >= above {
            let y = min(target.maxY + gap, container.height - margin - height)
            return .init(edge: .below, origin: CGPoint(x: x, y: max(margin, y)), width: width, maxHeight: available)
        }
        let y = max(margin, target.minY - gap - height)
        return .init(edge: .above, origin: CGPoint(x: x, y: y), width: width, maxHeight: available)
    }
}
