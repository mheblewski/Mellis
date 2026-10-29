import XCTest
@testable import GlucoMindCore

final class TrioReplyTextTests: XCTestCase {
    func testTheServersPolishReasonsAreShortened() {
        let text = TrioReplyText(statusMessage: "Błąd: bolus 3,85 j przekracza maksymalny bolus w Trio (3 j)")
        XCTAssertEqual(text.short, "Za duży bolus dla Trio (max 3 j)")
        XCTAssertEqual(text.details, "bolus 3,85 j przekracza maksymalny bolus w Trio (3 j)")
        XCTAssertEqual(TrioReplyText(statusMessage: "Błąd: przekroczyłby maksymalne IOB w Trio (5 j, teraz 4,2 j)").short, "Przekroczone max IOB w Trio (5 j, teraz 4,2 j)")
        XCTAssertEqual(TrioReplyText(statusMessage: "Węglowodany zapisane w Trio, bolus odrzucony: przekroczyłby maksymalne IOB w Trio (5 j, teraz 3.4 j)").short, "Przekroczone max IOB w Trio (5 j, teraz 3,4 j)")
        XCTAssertEqual(TrioReplyText(statusMessage: "Błąd: Remote Control jest wyłączone w Trio").short, "Zdalne sterowanie wyłączone w Trio")
    }

    func testTriosEnglishKeepsItsGistInPolish() {
        let partial = TrioReplyText(statusMessage: "Węglowodany zapisane w Trio, bolus odrzucony: Bolus failed: pump communication error (Bluetooth connection lost while enacting bolus). Details: retry later")
        XCTAssertEqual(partial.short, "Brak łączności z pompą")
        XCTAssertNotNil(partial.details)
        XCTAssertEqual(TrioReplyText(statusMessage: "Błąd: Command rejected: Bolus amount (3.85 units) exceeds the maximum allowed (3.0 units)").short, "Za duży bolus dla Trio (max 3 j)")
        XCTAssertEqual(TrioReplyText(statusMessage: "Błąd: Pump is suspended, resume delivery first").short, "Pompa jest wstrzymana")
        XCTAssertEqual(TrioReplyText(statusMessage: "Błąd: Occlusion detected during delivery").short, "Okluzja w pompie")
    }

    func testAnUnknownLongAnswerIsCutAtAWordAndKeptWhole() {
        let long = "Błąd: The remote command could not be processed because an unexpected internal state was encountered while preparing the dose for the pump that was selected in the remote control settings. Please open Trio to check."
        let text = TrioReplyText(statusMessage: long)
        XCTAssertLessThanOrEqual(text.short.count, TrioReplyText.maxShort)
        XCTAssertTrue(text.short.hasSuffix("…"))
        XCTAssertTrue(text.short.hasPrefix("The remote command could not be processed"))
        XCTAssertEqual(text.details, String(long.dropFirst("Błąd: ".count)))
    }

    func testTriosOwnPolishWrapperIsDroppedAndTheCauseKept() {
        let message = "Węglowodany zapisane w Trio, bolus odrzucony: Błąd! Bolus nie powiódł się z powodu błędu: Czas oczekiwania na odpowiedź pompy minął."
        let text = TrioReplyText(statusMessage: message)
        XCTAssertEqual(text.short, "Czas oczekiwania na odpowiedź pompy minął")
        XCTAssertNotNil(text.details)
    }

    func testAShortAnswerHasNoDetails() {
        let text = TrioReplyText(statusMessage: "Trio nie zna aktualnego IOB")
        XCTAssertEqual(text.short, "Trio nie zna aktualnego IOB")
        XCTAssertNil(text.details)
        XCTAssertEqual(TrioReplyText(statusMessage: nil).short, "Trio nie podało powodu")
    }
}
