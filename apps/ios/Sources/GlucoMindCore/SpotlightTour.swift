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

// The Teraz screen's spotlight tour (SpotlightTour), from the role review of 2026-11-14
// (docs/product/teraz-tour-review.md): what cannot be guessed, by importance, not top to bottom. Shown once per person on
// this phone when Teraz first opens, at any hour (owner), but never over a low or a button to act: then it waits for the
// next opening. Reopened from the chart's "?" and Ustawienia. The chart's marks stay in the legend under "?"; the states
// of a low explain themselves when they come.

public enum TerazTourStep: String, CaseIterable, Sendable {
    case situation = "teraz.tour.situation"
    case chips = "teraz.tour.chips"
    case chart = "teraz.tour.chart"
    case legend = "teraz.tour.legend"
    /// Only while Wzorce's row is on Teraz.
    case patterns = "teraz.tour.patterns"
    case equipment = "teraz.tour.equipment"
    /// Only with more than one patient on this phone; last (owner 2026-11-14: Wzorce and the equipment side by side,
    /// the other patients at the end).
    case patients = "teraz.tour.patients"

    public var text: String { text(hasSentence: true) }

    /// - hasSentence: the situation's sentence is on screen under the glucose (an older server sends none): without it
    ///   the first step speaks of the number and its change only (owner 2026-11-14).
    public func text(hasSentence: Bool) -> String {
        switch self {
        case .situation:
            guard hasSentence else {
                return "Liczba to glukoza teraz. Strzałka obok pokazuje, dokąd zmierza, a liczba pod strzałką, o ile zmieniła się w 5 minut."
            }
            return "Liczba to glukoza teraz, a zdanie pod nią mówi, co się z nią dzieje. Gdy trzeba działać, pojawi się tu ilość węgli i przycisk „Podano”: zapisuje węgle tylko w Mellis, a potem Mellis sam sprawdzi wynik."
        case .chips:
            return "Kropla to insulina, która jeszcze działa, sztućce to węglowodany, które jeszcze się wchłaniają, a schodek to baza podawana teraz. Przed kolejną dawką spójrz na kroplę, bo ta insulina dalej obniża glukozę."
        case .chart:
            return "Przytrzymaj palec na wykresie, aby zobaczyć godzinę, odczyt, bolusy, węgle i bazę z tamtej chwili. Linia za ostatnią kropką to prognoza pętli: im szersza chmura, tym mniej pewna."
        case .legend:
            return "Znak zapytania objaśnia wszystkie znaki na wykresie i w pasie bazy pod nim. Tam też otworzysz ponownie ten przewodnik."
        case .patterns:
            return "Wzorce pokazują, co powtarza się w ostatnich dwóch tygodniach, na przykład spadki o tej samej porze. Stuknij, aby zobaczyć dni, pytanie do sprawdzenia i co pokazać w poradni."
        case .patients:
            return "Przesuń ekran w bok, aby zobaczyć innego pacjenta. Gdy u niego glukoza spadnie poniżej 70, jego odczyt pojawi się pod imieniem."
        case .equipment:
            return "Tu widać, czy pętla działa i kiedy ostatnio przysłała dane. Stuknij, aby sprawdzić zbiornik, baterię, sensor i wkłucie."
        }
    }

    /// GLUCOMIND_UI_FIXTURES_TERAZ_TOUR: "1"…"7", the step's name ("chips") or its anchor id.
    public static func fixture(_ value: String) -> TerazTourStep? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if let number = Int(trimmed) {
            return allCases.indices.contains(number - 1) ? allCases[number - 1] : nil
        }
        return allCases.first { $0.rawValue == trimmed || $0.rawValue.lowercased() == "teraz.tour.\(trimmed.lowercased())" }
    }
}

public enum TerazTour {
    public static let id = "teraz"

    public static func steps(hasSentence: Bool = true) -> [SpotlightTourStep] {
        TerazTourStep.allCases.map { SpotlightTourStep(id: $0.rawValue, text: $0.text(hasSentence: hasSentence)) }
    }

    /// The steps this phone can show now: the other patients' only with more than one patient, Wzorce's only while
    /// their row is on Teraz.
    public static func isAvailable(patientCount: Int, hasPatternsRow: Bool = false) -> (String) -> Bool {
        { id in
            if id == TerazTourStep.patients.rawValue { return patientCount > 1 }
            if id == TerazTourStep.patterns.rawValue { return hasPatternsRow }
            return true
        }
    }

    public static func start(at step: TerazTourStep? = nil, patientCount: Int, hasPatternsRow: Bool = false, hasSentence: Bool = true) -> SpotlightTour {
        SpotlightTour(tourID: id, steps: steps(hasSentence: hasSentence), startAt: step?.rawValue,
                      isAvailable: isAvailable(patientCount: patientCount, hasPatternsRow: hasPatternsRow))
    }

    /// Whether the screen is calm enough for the tour to open by itself, or to stay open.
    public struct Calm: Equatable, Sendable {
        /// The situation on screen (nil: none yet, or the server sends none).
        public var state: String?
        /// The situation needs a look (a low or a forecast low: NowSituation.needsAttention).
        public var needsAttention: Bool
        /// A button to act under the sentence ("Podano 3 g", "Zapisz węgle", "Cofnij").
        public var hasAction: Bool
        /// The newest reading, mg/dL; nil when there is none.
        public var glucose: Double?
        /// The reading is fresh (not waiting for a read, not old).
        public var fresh: Bool

        public init(state: String?, needsAttention: Bool, hasAction: Bool, glucose: Double?, fresh: Bool) {
            self.state = state
            self.needsAttention = needsAttention
            self.hasAction = hasAction
            self.glucose = glucose
            self.fresh = fresh
        }

        /// Never over a low, a forecast low, a button to act or an old reading (owner 2026-11-14: any hour otherwise).
        public var allowsTour: Bool {
            guard fresh, let glucose, glucose >= 70, !needsAttention, !hasAction else { return false }
            // 9…: an old or missing reading asks for a meter; nothing to explain over it.
            return !(state?.hasPrefix("9") ?? false)
        }
    }

    /// The tour opening by itself on Teraz.
    public struct StartConditions: Equatable, Sendable {
        public var calm: Calm
        /// "Przewodnik konfiguracji" is on screen or about to open.
        public var setupGuideShowing: Bool
        /// A sheet, alert or popover is up.
        public var modalShowing: Bool
        /// Teraz is the tab on screen and its patient's page is the one in the middle (no swipe under way).
        public var onScreen: Bool
        /// Another tour is on (the Bolus one).
        public var otherTourActive: Bool

        public init(calm: Calm, setupGuideShowing: Bool = false, modalShowing: Bool = false, onScreen: Bool = true, otherTourActive: Bool = false) {
            self.calm = calm
            self.setupGuideShowing = setupGuideShowing
            self.modalShowing = modalShowing
            self.onScreen = onScreen
            self.otherTourActive = otherTourActive
        }

        public var allowsAutoStart: Bool {
            calm.allowsTour && !setupGuideShowing && !modalShowing && onScreen && !otherTourActive
        }

        /// Asked for (the legend's row, Ustawienia): only a low or a button to act holds it back.
        public var allowsRequestedStart: Bool {
            calm.allowsTour && !setupGuideShowing && onScreen && !otherTourActive
        }
    }
}
