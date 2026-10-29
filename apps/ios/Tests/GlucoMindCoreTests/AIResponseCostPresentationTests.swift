import XCTest
@testable import GlucoMindCore

final class AIResponseCostPresentationTests: XCTestCase {
    func testKnownCostUsesTwoDecimalFormatting() {
        let text = AIResponseCostPresentation.labelText(for: AIResponseCost(
            status: "KNOWN",
            amount: 1.24,
            currency: "PLN",
            pricing_version: "openai.pricing.v1",
            provider: "openai",
            model: "gpt-5.6-terra"
        ))

        XCTAssertEqual(text, "koszt AI: 1,24\u{00A0}zł")
    }

    func testKnownVerySmallCostUsesLowerThanThresholdLabel() {
        let text = AIResponseCostPresentation.labelText(for: AIResponseCost(
            status: "KNOWN",
            amount: 0.001,
            currency: "PLN",
            pricing_version: "openai.pricing.v1",
            provider: "openai",
            model: "gpt-5.6-terra"
        ))

        XCTAssertEqual(text, "koszt AI: <0,01 zł")
    }

    func testUnknownCostUsesUnavailableLabel() {
        let text = AIResponseCostPresentation.labelText(for: AIResponseCost(
            status: "UNKNOWN",
            amount: nil,
            currency: "USD",
            pricing_version: nil,
            provider: "openai",
            model: "gpt-5.6-terra"
        ))

        XCTAssertEqual(text, "koszt AI: niedostępny")
    }

    func testMissingCurrencyReturnsNil() {
        let text = AIResponseCostPresentation.labelText(for: AIResponseCost(
            status: "KNOWN",
            amount: 0.08,
            currency: nil,
            pricing_version: "openai.pricing.v1",
            provider: "openai",
            model: "gpt-5.6-terra"
        ))

        XCTAssertNil(text)
    }
}
