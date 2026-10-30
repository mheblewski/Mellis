import Foundation

// The Bolus tab's spotlight tour (SpotlightTour): eight steps, shown once per person on this phone when the tab first
// opens, again from the "?" next to "Podaj / Historia" and from Ustawienia → "Przewodnik po ekranie Bolus".
//
// Three elements are often not on screen: the alarm clock (only with carbs typed), the calculator / ICR switch (only
// with a calculator dose) and the warnings row (only when something needs attention). For their steps the tab draws a
// SAMPLE in their place (BolusTourStage): pictures of the clock and the switch, and a warnings row "Przykład: …". The sample lives only in the view while its step is on screen; it never
// writes to the form (RemoteBolusViewModel), and the slider stays off for the whole tour (BolusTour.slideEnabled).

public enum BolusTourStep: String, CaseIterable, Sendable {
    case modeSwitch = "bolus.tour.mode"
    case forecast = "bolus.tour.forecast"
    case carbs = "bolus.tour.carbs"
    case reminders = "bolus.tour.reminders"
    case insulin = "bolus.tour.insulin"
    case doseSource = "bolus.tour.doseSource"
    case checks = "bolus.tour.checks"
    case slider = "bolus.tour.slider"

    public var text: String {
        switch self {
        case .modeSwitch:
            return "Tu podajesz bolus. W Historii widzisz wszystkie wysłane polecenia i to, czy pętla je wykonała."
        case .forecast:
            return "Prognoza pętli na najbliższe godziny, na razie bez tej dawki. ⓘ wyjaśnia, co pokazuje linia."
        case .carbs:
            return "Wpisz, ile gramów węglowodanów zostanie zjedzonych. Zaznacz „Posiłek za 15 min”, gdy bolus podajesz przed jedzeniem: węglowodany trafią do pętli z godziną posiłku."
        case .reminders:
            return "Budzik ustawia przypomnienia po bolusie: o dawce na tłuszcz i białko (WBT) albo o drugiej części dawki, gdy glukoza zacznie rosnąć lub po zadanym czasie."
        case .insulin:
            return "Mellis proponuje dawkę z przelicznika, a obniża ją, gdy jest aktywna insulina albo glukoza spada. Pod dawką widać, o ile i dlaczego. Możesz też wpisać własną dawkę."
        case .doseSource:
            return "Przełącznik źródła dawki. Górne pole to dawka z kalkulatora (uwzględnia aktywną insulinę, trend glukozy i korektę), dolne to dawka z samego przelicznika (ICR). Wypełnione pole pokazuje, która dawka jest teraz w polu."
        case .checks:
            return "Gdy coś wymaga uwagi, pojawia się tu jedna linijka. Stuknij, żeby zobaczyć wszystkie ostrzeżenia. Decyzja zawsze należy do Ciebie."
        case .slider:
            return "Przesuń, żeby wysłać bolus do pętli. Przed wysłaniem pętla sprawdzi jeszcze swoje limity. „Zapisz jako posiłek” doda wpis do zakładki Posiłki."
        }
    }

    /// GLUCOMIND_UI_FIXTURES_BOLUS_TOUR: "1"…"8", the step's name ("doseSource") or its anchor id.
    public static func fixture(_ value: String) -> BolusTourStep? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if let number = Int(trimmed) {
            return allCases.indices.contains(number - 1) ? allCases[number - 1] : nil
        }
        return allCases.first { $0.rawValue == trimmed || $0.rawValue.lowercased() == "bolus.tour.\(trimmed.lowercased())" }
    }
}

/// What the tab draws in place of an element that is not on screen, while the tour points at it.
public struct BolusTourStage: Equatable, Sendable {
    /// A sample alarm clock (a picture, not a button) in the carbs field's corner.
    public var showsSampleReminders: Bool = false
    /// A sample ± (a picture, not a button) in the insulin field's corner.
    public let showsSampleDoseSource: Bool
    /// A sample warnings row ("Przykład: …") where the real one would be.
    public let showsSampleChecks: Bool

    public static let none = BolusTourStage(showsSampleDoseSource: false, showsSampleChecks: false)

    public init(showsSampleReminders: Bool = false, showsSampleDoseSource: Bool, showsSampleChecks: Bool) {
        self.showsSampleReminders = showsSampleReminders
        self.showsSampleDoseSource = showsSampleDoseSource
        self.showsSampleChecks = showsSampleChecks
    }

    /// The current step's element is a sample (the callout says "Przykład").
    public var isSample: Bool { showsSampleReminders || showsSampleDoseSource || showsSampleChecks }
}

public enum BolusTour {
    public static let id = "bolus"

    public static var steps: [SpotlightTourStep] {
        BolusTourStep.allCases.map { SpotlightTourStep(id: $0.rawValue, text: $0.text) }
    }

    /// A new tour (nil step: from the first).
    public static func start(at step: BolusTourStep? = nil, isAvailable: (String) -> Bool = { _ in true }) -> SpotlightTour {
        SpotlightTour(tourID: id, steps: steps, startAt: step?.rawValue, isAvailable: isAvailable)
    }

    /// The sample for the step on screen: only when the real element is not there, only during its own step.
    /// - realRemindersShown: the alarm clock is on screen (carbs typed).
    /// - realDoseSourceShown: the form has its own switch now (RemoteBolusViewModel.doseSwitch != nil).
    /// - realChecksShown: the real warnings row is on screen (a non-empty BolusCheckSummary).
    public static func stage(tour: SpotlightTour?, realRemindersShown: Bool = true, realDoseSourceShown: Bool, realChecksShown: Bool) -> BolusTourStage {
        guard let current = tour?.current.flatMap({ BolusTourStep(rawValue: $0.id) }) else { return .none }
        return BolusTourStage(
            showsSampleReminders: current == .reminders && !realRemindersShown,
            showsSampleDoseSource: current == .doseSource && !realDoseSourceShown,
            showsSampleChecks: current == .checks && !realChecksShown
        )
    }

    /// The sample warnings row: one red line and "· +1", each line said to be an example.
    public static let sampleChecks = BolusCheckSummary(items: [
        BolusCheckItem(id: "tour.sample.low", level: .danger, headline: "Przykład: Prognoza < 70 ok. 14:30", detail: "Przykład: prognoza z tą dawką schodzi poniżej 70 mg/dL około 14:30."),
        BolusCheckItem(id: "tour.sample.iob", level: .warning, headline: "Przykład: aktywna insulina", detail: "Przykład: w organizmie jest jeszcze aktywna insulina z poprzedniego bolusu.")
    ])

    /// The slider sends only outside the tour: off for the whole tour, whatever the form says.
    public static func slideEnabled(_ formAllows: Bool, tour: SpotlightTour?) -> Bool {
        formAllows && !(tour?.isActive ?? false)
    }

    /// Whether the tour may open now on the Bolus tab.
    public struct StartConditions: Equatable, Sendable {
        /// "Przewodnik konfiguracji" is on screen or about to open.
        public var setupGuideShowing: Bool
        /// A sheet, alert or popover is up (the app's own or this tab's).
        public var modalShowing: Bool
        /// A field is being typed in (the keyboard is up).
        public var keyboardVisible: Bool
        /// A command is on its way (this tab's send, Face ID, the check before it) or another phone's waits for its answer.
        public var sendInFlight: Bool
        /// "Podaj" is on screen (not "Historia").
        public var onGiveSegment: Bool
        /// The tab has read its data at least once (the layout is settled).
        public var loaded: Bool

        public init(setupGuideShowing: Bool = false, modalShowing: Bool = false, keyboardVisible: Bool = false, sendInFlight: Bool = false, onGiveSegment: Bool = true, loaded: Bool = true) {
            self.setupGuideShowing = setupGuideShowing
            self.modalShowing = modalShowing
            self.keyboardVisible = keyboardVisible
            self.sendInFlight = sendInFlight
            self.onGiveSegment = onGiveSegment
            self.loaded = loaded
        }

        /// The tour opening by itself: nothing else on screen, nothing typed in, nothing on its way.
        public var allowsAutoStart: Bool {
            !setupGuideShowing && !modalShowing && !keyboardVisible && !sendInFlight && onGiveSegment && loaded
        }

        /// The tour asked for ("?", Ustawienia): the keyboard is put away and "Podaj" shown first, so only the others wait.
        public var allowsRequestedStart: Bool {
            !setupGuideShowing && !modalShowing && !sendInFlight
        }
    }
}
