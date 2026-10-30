import CoreGraphics
import XCTest
@testable import GlucoMindCore

final class SpotlightTourTests: XCTestCase {
    // MARK: The state machine

    func testTheBolusTourWalksEightStepsAndEndsCompleted() {
        var tour = BolusTour.start()
        XCTAssertEqual(tour.current?.id, BolusTourStep.modeSwitch.rawValue)
        XCTAssertEqual(tour.progressText(), "1/8")
        var seen: [String] = []
        while let current = tour.current {
            seen.append(current.id)
            XCTAssertEqual(tour.isLast(isAvailable: { _ in true }), seen.count == 8, "\"Gotowe\" only on the last step")
            tour.next()
        }
        XCTAssertEqual(seen, BolusTourStep.allCases.map(\.rawValue))
        XCTAssertEqual(tour.outcome, .completed)
        XCTAssertFalse(tour.isActive)
        tour.next()
        XCTAssertEqual(tour.outcome, .completed, "nothing after the end")
    }

    func testTheStepTextsAreTheApprovedOnes() {
        XCTAssertEqual(BolusTourStep.modeSwitch.text, "Tu podajesz bolus. W Historii widzisz wszystkie wysłane polecenia i to, czy pętla je wykonała.")
        XCTAssertEqual(BolusTourStep.forecast.text, "Prognoza pętli na najbliższe godziny, na razie bez tej dawki. ⓘ wyjaśnia, co pokazuje linia.")
        XCTAssertEqual(BolusTourStep.carbs.text, "Wpisz, ile gramów węglowodanów zostanie zjedzonych. Zaznacz „Posiłek za 15 min”, gdy bolus podajesz przed jedzeniem: węglowodany trafią do pętli z godziną posiłku.")
        XCTAssertEqual(BolusTourStep.reminders.text, "Budzik ustawia przypomnienia po bolusie: o dawce na tłuszcz i białko (WBT) albo o drugiej części dawki, gdy glukoza zacznie rosnąć lub po zadanym czasie.")
        XCTAssertEqual(BolusTourStep.allCases.count, 8)
        XCTAssertEqual(BolusTourStep.reminders.rawValue, "bolus.tour.reminders", "its own anchor, next to the carbs")
        XCTAssertEqual(BolusTourStep.insulin.text, "Mellis proponuje dawkę z przelicznika, a obniża ją, gdy jest aktywna insulina albo glukoza spada. Pod dawką widać, o ile i dlaczego. Możesz też wpisać własną dawkę.")
        XCTAssertEqual(BolusTourStep.doseSource.text, "Przełącznik źródła dawki. Górne pole to dawka z kalkulatora (uwzględnia aktywną insulinę, trend glukozy i korektę), dolne to dawka z samego przelicznika (ICR). Wypełnione pole pokazuje, która dawka jest teraz w polu.")
        XCTAssertEqual(BolusTourStep.checks.text, "Gdy coś wymaga uwagi, pojawia się tu jedna linijka. Stuknij, żeby zobaczyć wszystkie ostrzeżenia. Decyzja zawsze należy do Ciebie.")
        XCTAssertEqual(BolusTourStep.slider.text, "Przesuń, żeby wysłać bolus do pętli. Przed wysłaniem pętla sprawdzi jeszcze swoje limity. „Zapisz jako posiłek” doda wpis do zakładki Posiłki.")
    }

    func testSkipEndsTheWholeTour() {
        var tour = BolusTour.start()
        tour.next()
        tour.skip()
        XCTAssertNil(tour.current)
        XCTAssertEqual(tour.outcome, .skipped)
        tour.interrupt()
        XCTAssertEqual(tour.outcome, .skipped, "the first ending counts")
    }

    func testInterruptStopsWithoutCompleting() {
        var tour = BolusTour.start(at: .carbs)
        tour.interrupt()
        XCTAssertFalse(tour.isActive)
        XCTAssertEqual(tour.outcome, .interrupted)
    }

    func testUnavailableStepsArePassedOverAndLeftOutOfTheCount() {
        let unavailable: Set<String> = [BolusTourStep.doseSource.rawValue]
        let available: (String) -> Bool = { !unavailable.contains($0) }
        var tour = BolusTour.start(at: .insulin, isAvailable: available)
        XCTAssertEqual(tour.progressText(isAvailable: available), "5/7")
        tour.next(isAvailable: available)
        XCTAssertEqual(tour.current?.id, BolusTourStep.checks.rawValue)
        XCTAssertEqual(tour.progressText(isAvailable: available), "6/7")

        // Starting at an unavailable step opens at the next available one.
        let fromMissing = BolusTour.start(at: .doseSource, isAvailable: available)
        XCTAssertEqual(fromMissing.current?.id, BolusTourStep.checks.rawValue)

        // Nothing available: the tour is over at once.
        let none = BolusTour.start(isAvailable: { _ in false })
        XCTAssertFalse(none.isActive)
    }

    func testAnAnchorThatNeverAppearsIsSkipped() {
        var tour = BolusTour.start(at: .checks)
        tour.stepIsMissing(BolusTourStep.forecast.rawValue)
        XCTAssertEqual(tour.current?.id, BolusTourStep.checks.rawValue, "only the current step's absence counts")
        tour.stepIsMissing(BolusTourStep.checks.rawValue)
        XCTAssertEqual(tour.current?.id, BolusTourStep.slider.rawValue)
        XCTAssertEqual(tour.progressText(), "7/7", "the missing step is out of the count")
        tour.stepIsMissing(BolusTourStep.slider.rawValue)
        XCTAssertEqual(tour.outcome, .completed)
    }

    func testFixtureStepsByNumberNameOrID() {
        XCTAssertEqual(BolusTourStep.fixture("1"), .modeSwitch)
        XCTAssertEqual(BolusTourStep.fixture("4"), .reminders)
        XCTAssertEqual(BolusTourStep.fixture("8"), .slider)
        XCTAssertNil(BolusTourStep.fixture("9"))
        XCTAssertEqual(BolusTourStep.fixture("doseSource"), .doseSource)
        XCTAssertEqual(BolusTourStep.fixture("bolus.tour.checks"), .checks)
        XCTAssertNil(BolusTourStep.fixture("nope"))
    }

    // MARK: Persistence

    func testSeenPerServerAndPersonAndReopeningNeverResetsIt() {
        let store = InMemorySpotlightTourSeenStore()
        let ania = SetupGuideKey.make(server: URL(string: "https://mellis.example")!, userID: "U-Ania")
        let mateusz = SetupGuideKey.make(server: URL(string: "https://mellis.example")!, userID: "u-mateusz")
        let aniaElsewhere = SetupGuideKey.make(server: URL(string: "https://other.example:8443")!, userID: "u-ania")

        XCTAssertFalse(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: nil, store: store), "nobody known: no tour by itself")
        XCTAssertTrue(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: ania, store: store))
        SpotlightTourSeen.noteEnded(.completed, tourID: BolusTour.id, key: ania, store: store)
        XCTAssertFalse(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: ania, store: store), "once per person")
        XCTAssertTrue(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: mateusz, store: store), "another person on the same phone")
        XCTAssertTrue(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: aniaElsewhere, store: store), "another server")
        XCTAssertTrue(SpotlightTourSeen.shouldAutoStart(tourID: "dashboard", key: ania, store: store), "another tour")

        // Reopened ("?", Ustawienia) and interrupted half way: still seen.
        var reopened = BolusTour.start()
        reopened.next()
        reopened.interrupt()
        SpotlightTourSeen.noteEnded(reopened.outcome!, tourID: BolusTour.id, key: ania, store: store)
        XCTAssertFalse(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: ania, store: store))
        SpotlightTourSeen.noteEnded(.completed, tourID: BolusTour.id, key: nil, store: store)
        XCTAssertEqual(store.seen.count, 1, "a fixture tour (no key) changes no mark")
    }

    func testOnlyGotoweOrPominMarkTheTourSeen() {
        let store = InMemorySpotlightTourSeenStore()
        let key = "mellis.example|u1"
        // Shown, then the app was closed or a send interrupted it: it comes back next time.
        var interrupted = BolusTour.start()
        interrupted.next()
        interrupted.interrupt()
        SpotlightTourSeen.noteEnded(interrupted.outcome!, tourID: BolusTour.id, key: key, store: store)
        XCTAssertTrue(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: key, store: store))

        var skipped = BolusTour.start()
        skipped.skip()
        SpotlightTourSeen.noteEnded(skipped.outcome!, tourID: BolusTour.id, key: key, store: store)
        XCTAssertFalse(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: key, store: store), "\"Pomiń\"")

        let other = "mellis.example|u2"
        var done = BolusTour.start()
        while done.isActive { done.next() }
        SpotlightTourSeen.noteEnded(done.outcome!, tourID: BolusTour.id, key: other, store: store)
        XCTAssertFalse(SpotlightTourSeen.shouldAutoStart(tourID: BolusTour.id, key: other, store: store), "\"Gotowe\"")
    }

    func testUserDefaultsStoreKeepsTheMarkPerKey() {
        let defaults = UserDefaults(suiteName: "SpotlightTourTests-\(UUID().uuidString)")!
        let store = UserDefaultsSpotlightTourSeenStore(defaults: defaults)
        XCTAssertFalse(store.hasSeen(tourID: "bolus", key: "a|1"))
        store.markSeen(tourID: "bolus", key: "a|1")
        XCTAssertTrue(UserDefaultsSpotlightTourSeenStore(defaults: defaults).hasSeen(tourID: "bolus", key: "a|1"))
        XCTAssertFalse(store.hasSeen(tourID: "bolus", key: "a|2"))
    }

    // MARK: Start conditions

    func testTheTourWaitsForTheSetupGuideSheetsTheKeyboardAndASend() {
        XCTAssertTrue(BolusTour.StartConditions().allowsAutoStart)
        XCTAssertFalse(BolusTour.StartConditions(setupGuideShowing: true).allowsAutoStart)
        XCTAssertFalse(BolusTour.StartConditions(modalShowing: true).allowsAutoStart)
        XCTAssertFalse(BolusTour.StartConditions(keyboardVisible: true).allowsAutoStart)
        XCTAssertFalse(BolusTour.StartConditions(sendInFlight: true).allowsAutoStart)
        XCTAssertFalse(BolusTour.StartConditions(onGiveSegment: false).allowsAutoStart, "not over Historia by itself")
        XCTAssertFalse(BolusTour.StartConditions(loaded: false).allowsAutoStart)
        // Asked for: the keyboard is put away and "Podaj" shown first.
        XCTAssertTrue(BolusTour.StartConditions(keyboardVisible: true, onGiveSegment: false).allowsRequestedStart)
        XCTAssertFalse(BolusTour.StartConditions(setupGuideShowing: true).allowsRequestedStart)
        XCTAssertFalse(BolusTour.StartConditions(modalShowing: true).allowsRequestedStart)
        XCTAssertFalse(BolusTour.StartConditions(sendInFlight: true).allowsRequestedStart)
    }

    // MARK: Samples and the slider

    func testSamplesOnlyForTheirOwnStepAndOnlyWhenTheRealElementIsMissing() {
        XCTAssertEqual(BolusTour.stage(tour: nil, realDoseSourceShown: false, realChecksShown: false), .none)
        var tour = BolusTour.start()
        for step in BolusTourStep.allCases {
            let stage = BolusTour.stage(tour: tour, realRemindersShown: false, realDoseSourceShown: false, realChecksShown: false)
            XCTAssertEqual(stage.showsSampleReminders, step == .reminders, "\(step)")
            XCTAssertEqual(stage.showsSampleDoseSource, step == .doseSource, "\(step)")
            XCTAssertEqual(stage.showsSampleChecks, step == .checks, "\(step)")
            let real = BolusTour.stage(tour: tour, realRemindersShown: true, realDoseSourceShown: true, realChecksShown: true)
            XCTAssertEqual(real, .none, "the real element is pointed at instead (\(step))")
            tour.next()
        }
        XCTAssertEqual(BolusTour.stage(tour: tour, realDoseSourceShown: false, realChecksShown: false), .none, "no sample after the tour")
    }

    func testTheSampleRowSaysItIsAnExample() {
        XCTAssertTrue(BolusTour.sampleChecks.items.allSatisfy { $0.headline.hasPrefix("Przykład") && $0.fullText.hasPrefix("Przykład") })
        XCTAssertEqual(BolusTour.sampleChecks.collapsedText, "Przykład: Prognoza < 70 ok. 14:30")
        XCTAssertEqual(BolusTour.sampleChecks.badgeText, "+1")
        XCTAssertTrue(BolusTour.sampleChecks.confirmations.isEmpty, "nothing in the sample asks to be confirmed")
    }

    func testTheSliderIsOffForTheWholeTour() {
        var tour: SpotlightTour? = BolusTour.start()
        while tour?.isActive == true {
            XCTAssertFalse(BolusTour.slideEnabled(true, tour: tour), "\(tour?.current?.id ?? "")")
            tour?.next()
        }
        XCTAssertTrue(BolusTour.slideEnabled(true, tour: tour), "back once the tour is over")
        XCTAssertTrue(BolusTour.slideEnabled(true, tour: nil))
        XCTAssertFalse(BolusTour.slideEnabled(false, tour: nil), "the tour never turns the slider on")
        var skipped: SpotlightTour? = BolusTour.start(at: .slider)
        skipped?.skip()
        XCTAssertTrue(BolusTour.slideEnabled(true, tour: skipped))
    }

    // MARK: Callout placement

    func testTheCalloutGoesBelowAboveOrScrollsAndStaysOnScreen() {
        let screen = CGSize(width: 375, height: 667)
        let top = SpotlightCalloutPlacement.place(target: CGRect(x: 8, y: 20, width: 300, height: 40), calloutHeight: 180, container: screen)
        XCTAssertEqual(top.edge, .below)
        XCTAssertEqual(top.origin.y, 72)
        XCTAssertEqual(top.width, 343)
        XCTAssertEqual(top.origin.x, 16, "clamped to the margin")

        let bottom = SpotlightCalloutPlacement.place(target: CGRect(x: 8, y: 580, width: 359, height: 64), calloutHeight: 180, container: screen)
        XCTAssertEqual(bottom.edge, .above)
        XCTAssertEqual(bottom.origin.y, 580 - 12 - 180)

        // A huge text size: too tall for either side, on the larger side, scrolling, never off screen.
        let tall = SpotlightCalloutPlacement.place(target: CGRect(x: 8, y: 250, width: 359, height: 120), calloutHeight: 600, container: screen)
        XCTAssertEqual(tall.edge, .below)
        XCTAssertLessThanOrEqual(tall.origin.y + min(600, tall.maxHeight), screen.height - 16 + 0.5)
        XCTAssertGreaterThanOrEqual(tall.origin.y, 16)

        // A wide phone: at most 380 wide, centred on the target, inside the screen.
        let wide = SpotlightCalloutPlacement.place(target: CGRect(x: 300, y: 100, width: 120, height: 40), calloutHeight: 150, container: CGSize(width: 440, height: 956))
        XCTAssertEqual(wide.width, 380)
        XCTAssertLessThanOrEqual(wide.origin.x + wide.width, 440 - 16)
    }
}
