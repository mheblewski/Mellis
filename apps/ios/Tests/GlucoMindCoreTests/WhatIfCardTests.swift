import XCTest
@testable import GlucoMindCore

final class WhatIfCardTests: XCTestCase {
    private let json = #"""
    {"kind":"SETTING_WHATIF","period_label":"9.10–8.11","whatif":{"version":"icr-whatif-card.v1","title":"ICR rano 5 → 6,3","scope_label":"Rano, 6:00–9:30","dose_change_u_per_meal":-0.44,"meals":32,"small_sample":true,"time_below_70":{"now":4.1,"after":1.3},"time_above_180":{"now":22.5,"after":39.2},"mean_mgdl":{"now":145,"after":170},"meals_with_drop_below_70":{"now":12,"after":5},"meals_above_180_over_1h":{"now":15,"after":28},"meals_high_then_low":11,"night":null,"blocks":[{"start":"06:00","end":"09:30","label":"Rano","icr_now":5,"icr_after":6.3,"meals":32,"time_below_70":{"now":4.1,"after":1.3},"time_above_180":{"now":22.5,"after":39.2},"small":false}],"best_block":null,"from_label":"9.10","to_label":"8.11","basis":"PROFILE_ISF_WITH_MEASURED_LOOP"}}
    """#

    private func decoded() throws -> ConversationMetricCard {
        try JSONDecoder().decode(ConversationMetricCard.self, from: Data(json.utf8))
    }

    func testDecodesTheCardAndOnlyTheWhatIfViewTakesIt() throws {
        let card = try decoded()
        XCTAssertEqual(card.whatif?.meals, 32)
        XCTAssertEqual(card.whatif?.blocks.first?.icr_after, 6.3)
        XCTAssertNil(MetricCardContent(card: card))
        XCTAssertNotNil(WhatIfCardView(card: card))
    }

    func testSentenceNamesTheTimeAndBothChanges() throws {
        let whatif = try XCTUnwrap(try decoded().whatif)
        let text = String(WhatIfWording.sentence(whatif).characters).replacingOccurrences(of: "\u{00A0}", with: " ")
        XCTAssertEqual(text, "Rano czas poniżej 70 spada z 4,1% do 1,3%, a czas powyżej 180 rośnie z 23% do 39%.")
        XCTAssertEqual(WhatIfWording.meta(whatif), "Przeliczone według ISF z ustawień, tak jak liczy pętla. Szacunek z 32 posiłków, 9.10–8.11 · mała próba.")
    }

    func testPolishCountsAndNumbers() {
        XCTAssertEqual(WhatIfWording.meals(1), "1 posiłek")
        XCTAssertEqual(WhatIfWording.meals(32), "32 posiłki")
        XCTAssertEqual(WhatIfWording.meals(12), "12 posiłków")
        XCTAssertEqual(WhatIfWording.meals(122), "122 posiłki")
        XCTAssertEqual(WhatIfWording.nights(24), "24 noce")
        XCTAssertEqual(WhatIfWording.units(-0.35), "−0,35")
        XCTAssertEqual(WhatIfWording.number(10.4), "10,4")
        XCTAssertEqual(WhatIfWording.number(5), "5")
    }
}
