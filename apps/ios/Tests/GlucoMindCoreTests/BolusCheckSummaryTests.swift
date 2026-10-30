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
        XCTAssertEqual(summary.collapsedText, "Prognoza < 70 ok. 14:34 · +2")
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
        XCTAssertEqual(summary.collapsedText, "Ponad limit tego telefonu: 5 j. · +1")
        XCTAssertEqual(summary.headline?.level, .block)

        let orange = BolusCheckSummary.make(forecastLowAt: nil, warnings: [RemoteCommandNotice(code: "RECENT_BOLUS", key: "k", message: "Bolus 0,5 j podano 30 min temu.")])
        XCTAssertEqual(orange.collapsedText, "Bolus 0,5 j 30 min temu")
        XCTAssertFalse(orange.headline?.isRed ?? true)
    }

    func testARepeatedItemAloneIsStillShownButNeverCounted() {
        let summary = BolusCheckSummary.make(forecastLowAt: nil, warnings: [
            RemoteCommandNotice(code: "GLUCOSE_FALLING_OR_LOW", key: "k", message: "Glukoza 75 mg/dL."),
        ])
        XCTAssertEqual(summary.collapsedText, "Glukoza 75 mg/dL")
        XCTAssertEqual(summary.moreCount, 0)
    }

    func testAnUnknownWarningKeepsTheServersText() {
        let summary = BolusCheckSummary.make(forecastLowAt: nil, warnings: [RemoteCommandNotice(code: "SOMETHING_NEW", key: "k", message: "Nowe ostrzeżenie serwera.")])
        XCTAssertEqual(summary.headline?.headline, "Nowe ostrzeżenie serwera.")
        XCTAssertNil(summary.headline?.detail)
        XCTAssertTrue(BolusCheckSummary.make(forecastLowAt: nil).isEmpty)
        XCTAssertNil(BolusCheckSummary.make(forecastLowAt: nil).collapsedText)
    }
}
