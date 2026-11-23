import XCTest
@testable import GlucoMindCore

/// bolus-not-sent.v1 (owner 2026-11-19): the card says nothing went to the loop, why, and the risk, in numbers.
final class BolusNotSentTests: XCTestCase {
    func testServerMessageSplitsIntoWhyAndRisk() {
        let parts = BolusNotSent.parts(of: "W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.\nZ tą dawką prognoza schodzi do ok. 62 mg/dL.")
        XCTAssertEqual(parts.why, "W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.")
        XCTAssertEqual(parts.risk, "Z tą dawką prognoza schodzi do ok. 62 mg/dL.")
    }

    func testRepeatedNothingSentGoes() {
        let parts = BolusNotSent.parts(of: "Face ID nie potwierdziło. Nic nie zostało wysłane.")
        XCTAssertEqual(parts.why, "Face ID nie potwierdziło.")
        XCTAssertNil(parts.risk)
    }

    func testPhoneRefusalNamesTheDrop() {
        let before = RemoteCommandContextView.Glucose(value: 97, observed_at: "2026-11-18T11:41:00Z", delta: -2)
        let after = RemoteCommandContextView.Glucose(value: 90, observed_at: "2026-11-18T11:46:00Z", delta: -7)
        XCTAssertEqual(RemoteBolusViewModel.phoneRefusalWhy(before: before, after: after, newWarnings: [], loop: LoopSystemKind.trio.names), "W trakcie wysyłania glukoza spadła z 97 do 90 mg/dL.")
    }

    func testPhoneRefusalWithoutNumbersStillSaysWhy() {
        let why = RemoteBolusViewModel.phoneRefusalWhy(before: nil, after: nil, newWarnings: [], loop: LoopSystemKind.trio.names)
        XCTAssertTrue(why.hasPrefix("W trakcie wysyłania Trio"))
    }

    func testTitleAndNotificationForCarbsOnly() {
        let card = BolusNotSent(id: UUID(), insulinU: 0, carbsG: 20, why: "W trakcie wysyłania przyszedł nowy odczyt: 104 mg/dL.", risk: nil, glucoseObservedAt: nil, offersCarbsFirst: false)
        XCTAssertEqual(card.title, "Węglowodany nie zostały wysłane")
        XCTAssertEqual(card.notificationTitle(patientName: "Janek"), "Węglowodany nie zostały wysłane · Janek")
        XCTAssertEqual(card.notificationBody(loop: LoopSystemKind.trio.names), "Nic nie zostało wysłane do Trio. W trakcie wysyłania przyszedł nowy odczyt: 104 mg/dL. Otwórz Bolus, aby sprawdzić i przesunąć ponownie.")
    }

    func testServerDataChangedRefusalIsRecognised() {
        let changed = APIClientError.conflict(ProblemDetails(type: "about:blank", title: "REMOTE_COMMAND_WARNINGS_CHANGED: W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.", status: 409, code: "CONFLICT", instance: nil))
        XCTAssertTrue(changed.isWarningsChanged)
        XCTAssertEqual(changed.remoteCommandRefusal, "W trakcie wysyłania glukoza wyraźnie spadła z 97 do 90 mg/dL.")
        let other = APIClientError.conflict(ProblemDetails(type: "about:blank", title: "REMOTE_COMMAND_BLOCKED: Glukoza poniżej 70.", status: 409, code: "CONFLICT", instance: nil))
        XCTAssertFalse(other.isWarningsChanged)
    }

    func testOnlyDataChangedOpensTheSheet() {
        let faceID = BolusNotSent(id: UUID(), insulinU: 2, carbsG: 20, why: "Face ID nie potwierdziło.", risk: nil, glucoseObservedAt: nil, offersCarbsFirst: false)
        XCTAssertFalse(faceID.dataChanged)
        XCTAssertEqual(RemoteSendOutcome.dataChanged("x").diagnosticName, "data_changed")
    }

    func testOnlyADropOfFiveOpensTheSheetOnThePhone() {
        let before = RemoteCommandContextView.Glucose(value: 97, observed_at: "2026-11-18T11:41:00Z", delta: -2)
        XCTAssertTrue(RemoteBolusViewModel.glucoseDropped(before: before, after: .init(value: 92, observed_at: "2026-11-18T11:46:00Z", delta: -5)))
        XCTAssertFalse(RemoteBolusViewModel.glucoseDropped(before: before, after: .init(value: 94, observed_at: "2026-11-18T11:46:00Z", delta: -3)))
        XCTAssertFalse(RemoteBolusViewModel.glucoseDropped(before: before, after: .init(value: 104, observed_at: "2026-11-18T11:46:00Z", delta: 7)))
    }
}
