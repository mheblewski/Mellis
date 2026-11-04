import XCTest
@testable import GlucoMindCore

final class AnswerWaitTextTests: XCTestCase {
    private func plan(stale: Bool = false, catalog: [String] = ["Pierwsze.", "Drugie."]) -> ConversationWaitPlan {
        ConversationWaitPlan(started_at: "2026-11-04T12:00:00.000Z", stale_reading: stale, catalog: catalog)
    }

    func testARealEventComesFirstWhileItLasts() {
        XCTAssertEqual(AnswerWaitText.mainLine(plan: plan(), event: "Szukam produktów w DiabCalc", eventAge: 3, elapsed: 7), "Szukam produktów w DiabCalc")
        XCTAssertEqual(AnswerWaitText.mainLine(plan: plan(), event: "Szukam produktów w DiabCalc", eventAge: 9, elapsed: 7), "Drugie.")
    }

    func testTheCatalogRunsOnceThenStops() {
        let lines = [0, 3, 7, 11.4, 11.6, 40].map { AnswerWaitText.mainLine(plan: plan(), event: nil, eventAge: 0, elapsed: $0) }
        XCTAssertEqual(lines, [AnswerWaitText.starting, "Pierwsze.", "Drugie.", "Drugie.", AnswerWaitText.preparing, AnswerWaitText.preparing])
    }

    func testAnEmptyCatalogSaysOneLine() {
        XCTAssertEqual(AnswerWaitText.mainLine(plan: plan(catalog: []), event: nil, eventAge: 0, elapsed: 30), AnswerWaitText.preparing)
    }

    func testTheSecondLineFollowsTheTime() {
        XCTAssertNil(AnswerWaitText.secondLine(plan: plan(), elapsed: 19))
        XCTAssertEqual(AnswerWaitText.secondLine(plan: plan(stale: true), elapsed: 19), "Ostatni odczyt ma ponad 10 minut")
        XCTAssertEqual(AnswerWaitText.secondLine(plan: plan(), elapsed: 20), "To pytanie zajmuje więcej czasu niż zwykle")
        XCTAssertEqual(AnswerWaitText.secondLine(plan: plan(), elapsed: 35), "Możesz wyjść z rozmowy. Odpowiedź będzie tu czekać")
        XCTAssertEqual(AnswerWaitText.secondLine(plan: plan(), elapsed: 60), "Odpowiedź bardzo się opóźnia. Można ją zatrzymać i zapytać ponownie")
    }

    func testEveryFigureHasAtMostFourDotsThatStayApartAndInTheirBox() {
        for figure in ThinkingDots.Figure.allCases {
            for tick in 0..<3_000 {
                let dots = ThinkingDots.dots(figure, at: Double(tick) / 50)
                XCTAssertLessThanOrEqual(dots.count, 4)
                for (index, dot) in dots.enumerated() {
                    XCTAssertLessThanOrEqual(abs(dot.x) + dot.radius, 1.001, "\(figure)")
                    XCTAssertLessThanOrEqual(abs(dot.y) + dot.radius, 1.001, "\(figure)")
                    for other in dots[(index + 1)...] where dot.radius > 0.02 && other.radius > 0.02 {
                        let gap = hypot(dot.x - other.x, dot.y - other.y) - dot.radius - other.radius
                        XCTAssertGreaterThan(gap, 0, "\(figure) at \(tick)")
                    }
                }
            }
        }
    }

    func testADotGrowsSplitsIntoFourAndFormsTheFigureWithoutAJump() {
        for figure in ThinkingDots.Figure.allCases {
            XCTAssertTrue(ThinkingDots.frame(figure, sinceStart: -0.1).isEmpty, "no dot while the sent message scrolls")
            let first = ThinkingDots.frame(figure, sinceStart: 0)
            XCTAssertEqual(first.count, 1)
            XCTAssertLessThan(first[0].radius, 0.1)

            let grown = ThinkingDots.frame(figure, sinceStart: ThinkingDots.growDuration - 0.001)
            XCTAssertEqual(grown.count, 1)
            XCTAssertGreaterThan(grown[0].radius, first[0].radius)

            // At the split the four lie exactly on the one dot, in its colour.
            let split = ThinkingDots.frame(figure, sinceStart: ThinkingDots.growDuration)
            XCTAssertEqual(split.count, 4, "\(figure)")
            for dot in split {
                XCTAssertEqual(dot.x, 0, accuracy: 0.001)
                XCTAssertEqual(dot.y, 0, accuracy: 0.001)
                XCTAssertEqual(dot.amber, 0, accuracy: 0.001)
                XCTAssertEqual(dot.radius, grown[0].radius, accuracy: 0.01)
            }

            // After the split it is the figure itself, on the figure's clock.
            let after = ThinkingDots.growDuration + ThinkingDots.splitDuration + 0.5
            XCTAssertEqual(ThinkingDots.frame(figure, sinceStart: after), ThinkingDots.dots(figure, at: after - ThinkingDots.growDuration))

            // No dot moves far between two frames at 60 Hz, all the way through.
            var previous = ThinkingDots.frame(figure, sinceStart: ThinkingDots.growDuration)
            for tick in 1..<180 {
                let current = ThinkingDots.frame(figure, sinceStart: ThinkingDots.growDuration + Double(tick) / 60)
                for (a, b) in zip(previous, current) {
                    XCTAssertLessThan(hypot(a.x - b.x, a.y - b.y), 0.25, "\(figure) at \(tick)")
                }
                previous = current
            }
        }
    }

    func testOneWaitIsOneTimelineRowFromSendingToTheAnswer() {
        let rows: [ConversationViewModel.ProcessingState] = [.sending, .processing, .waitingForNextQuestion]
        XCTAssertEqual(Set(rows.map(\.rowID)).count, 1)
        XCTAssertNotEqual(ConversationViewModel.ProcessingState.processing.rowID, ConversationViewModel.ProcessingState.error("x").rowID)
    }

    func testAnOlderServerSendsNoPlan() throws {
        let json = #"{"execution_id":"e","sequence":1,"type":"ANALYZING_REQUEST","status":"STARTED","label":"Analizuję pytanie","tool":null,"detail":null,"time_range":null,"started_at":null,"completed_at":null}"#
        XCTAssertNil(try JSONDecoder().decode(ConversationProcessingStep.self, from: Data(json.utf8)).wait_plan)
    }
}
