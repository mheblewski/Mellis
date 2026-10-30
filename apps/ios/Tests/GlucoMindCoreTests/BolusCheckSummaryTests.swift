import XCTest
@testable import GlucoMindCore

/// The Bolus tab's checks as one compact row (1.0.5): the owner's case (dose above the calculator while falling) and
/// the rules of the row: most serious first, repeated items not counted, the full text for VoiceOver.
final class BolusCheckSummaryTests: XCTestCase {
    private let low = Date(timeIntervalSince1970: 1_800_000_000)
    private let clock: (Date) -> String = { _ in "14:34" }

    /// The four rows of the owner's screenshot (2026-10-30).
    private var ownerCase: BolusCheckSummary {
        BolusCheckSummary.make(
            forecastLowAt: low,
            forecastLoopGenitive: "Trio",
            warnings: [
                RemoteCommandNotice(code: "GLUCOSE_FALLING_OR_LOW", key: "GLUCOSE_FALLING_OR_LOW:t", message: "Glukoza 180 mg/dL, zmiana -19 na 5 min."),
                RemoteCommandNotice(code: "RECENT_BOLUS", key: "RECENT_BOLUS:t:1.2", message: "Bolus 1,2 j podano 10 min temu."),
                RemoteCommandNotice(code: "DOSE_ABOVE_CALCULATOR", key: "DOSE_ABOVE_CALCULATOR:1.2:0", message: "1,2 j to o 1,2 j więcej, niż wychodzi z danych (dawka obniżona na spadek glukozy: 0 j (prognoza ok. 65 mg/dL)). W ostatnich 120 min podano 3,8 j. Większa dawka grozi niedocukrzeniem.", severity: "DANGER"),
            ],
            time: clock
        )
    }

    func testOwnerCaseIsOneRowWithTheForecastFirst() {
        let summary = ownerCase
        XCTAssertEqual(summary.collapsedText, "Prognoza < 70 ok. 14:34")
        XCTAssertEqual(summary.badgeText, "+2")
        XCTAssertEqual(summary.collapsedAccessibilityText, "Prognoza poniżej 70 około 14:34, i 2 inne ostrzeżenia")
        XCTAssertTrue(summary.headline?.isRed == true)
        XCTAssertEqual(summary.items.map(\.headline), [
            "Prognoza < 70 ok. 14:34",
            "Dawka wyższa niż z danych (+1,2 j)",
            "Bolus 1,2 j 10 min temu",
            "Glukoza 180 mg/dL (-19/5 min)",
        ])
        XCTAssertEqual(summary.items.map(\.level), [.danger, .danger, .warning, .repeated])
    }

    func testFullTextsStayForTheExpandedListAndVoiceOver() {
        let summary = ownerCase
        XCTAssertEqual(summary.items[0].fullText, "Prognoza Trio (bez tej dawki) schodzi poniżej 70 ok. 14:34.")
        XCTAssertTrue(summary.items[1].fullText.contains("W ostatnich 120 min podano 3,8 j."))
        XCTAssertTrue(summary.accessibilityText.contains("Glukoza 180 mg/dL, zmiana -19 na 5 min."))
        XCTAssertTrue(summary.accessibilityText.contains("Bolus 1,2 j podano 10 min temu."))
    }

    func testDangerWarningsAskForConfirmationExceptInsulinWhileLow() {
        XCTAssertEqual(ownerCase.confirmations.map(\.headline), ["Dawka wyższa niż z danych (+1,2 j)"])
        let low = BolusCheckSummary.make(forecastLowAt: nil, warnings: [
            RemoteCommandNotice(code: "INSULIN_WHILE_LOW", key: "k", message: "Glukoza 62 mg/dL: najpierw węglowodany.", severity: "DANGER"),
        ])
        XCTAssertTrue(low.confirmations.isEmpty)
        XCTAssertEqual(low.collapsedText, "Najpierw węglowodany")
    }

    func testBlocksComeFirstAndOrangeWhenOnlyWarnings() {
        let summary = BolusCheckSummary.make(
            forecastLowAt: nil,
            limitProblem: "Ponad limit tego telefonu: 5 j.",
            warnings: [RemoteCommandNotice(code: "RECENT_BOLUS", key: "k", message: "Bolus 0,5 j podano 30 min temu.")]
        )
        XCTAssertEqual(summary.collapsedText, "Ponad limit tego telefonu: 5 j.", "the count is its own badge, not in the headline")
        XCTAssertEqual(summary.badgeText, "+1")
        XCTAssertEqual(summary.headline?.level, .block)

        let orange = BolusCheckSummary.make(forecastLowAt: nil, warnings: [RemoteCommandNotice(code: "RECENT_BOLUS", key: "k", message: "Bolus 0,5 j podano 30 min temu.")])
        XCTAssertEqual(orange.collapsedText, "Bolus 0,5 j 30 min temu")
        XCTAssertNil(orange.badgeText, "no badge when nothing else is counted")
        XCTAssertEqual(orange.collapsedAccessibilityText, "Bolus 0,5 j 30 min temu")
        XCTAssertFalse(orange.headline?.isRed ?? true)
    }

    func testARepeatedItemAloneIsStillShownButNeverCounted() {
        let summary = BolusCheckSummary.make(forecastLowAt: nil, warnings: [
            RemoteCommandNotice(code: "GLUCOSE_FALLING_OR_LOW", key: "k", message: "Glukoza 75 mg/dL."),
        ])
        XCTAssertEqual(summary.collapsedText, "Glukoza 75 mg/dL")
        XCTAssertEqual(summary.moreCount, 0)
        XCTAssertNil(summary.badgeText)
    }

    func testAnUnknownWarningKeepsTheServersText() {
        let summary = BolusCheckSummary.make(forecastLowAt: nil, warnings: [RemoteCommandNotice(code: "SOMETHING_NEW", key: "k", message: "Nowe ostrzeżenie serwera.")])
        XCTAssertEqual(summary.headline?.headline, "Nowe ostrzeżenie serwera.")
        XCTAssertNil(summary.headline?.detail)
        XCTAssertTrue(BolusCheckSummary.make(forecastLowAt: nil).isEmpty)
        XCTAssertNil(BolusCheckSummary.make(forecastLowAt: nil).collapsedText)
    }

    func testTheBadgeCountsTheOthersAndVoiceOverSaysThemInWords() {
        var parts = DateComponents()
        parts.hour = 17; parts.minute = 49
        let at = Calendar.current.date(from: parts)!
        let summary = BolusCheckSummary.make(forecastLowAt: at, warnings: [
            RemoteCommandNotice(code: "RECENT_BOLUS", key: "a", message: "Bolus 0,5 j podano 30 min temu."),
            RemoteCommandNotice(code: "LOOP_STALE", key: "b", message: "Pętla nie wysyła obliczeń."),
            RemoteCommandNotice(code: "NO_THERAPY_PROFILE", key: "c", message: "Brak ICR."),
            RemoteCommandNotice(code: "CALCULATOR_UNAVAILABLE", key: "d", message: "Kalkulator niedostępny."),
            RemoteCommandNotice(code: "GLUCOSE_FALLING_OR_LOW", key: "e", message: "Glukoza 75 mg/dL."),
        ], time: { _ in "17:49" })
        XCTAssertEqual(summary.collapsedText, "Prognoza < 70 ok. 17:49")
        XCTAssertEqual(summary.badgeText, "+4", "the repeated glucose item is listed but not counted")
        XCTAssertEqual(summary.collapsedAccessibilityText, "Prognoza poniżej 70 około 17:49, i 4 inne ostrzeżenia")
        XCTAssertEqual(BolusCheckSummary.otherWarnings(1), "inne ostrzeżenie")
        XCTAssertEqual(BolusCheckSummary.otherWarnings(3), "inne ostrzeżenia")
        XCTAssertEqual(BolusCheckSummary.otherWarnings(5), "innych ostrzeżeń")
        XCTAssertEqual(BolusCheckSummary.otherWarnings(12), "innych ostrzeżeń")
        XCTAssertEqual(BolusCheckSummary.otherWarnings(22), "inne ostrzeżenia")
    }
}
