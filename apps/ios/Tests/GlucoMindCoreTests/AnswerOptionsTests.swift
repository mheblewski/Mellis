import XCTest
@testable import GlucoMindCore

final class AnswerOptionsTests: XCTestCase {
    private func message(bolusState: String = "PROPOSED", rescueStatus: String = "PROPOSED", options: Bool = true) throws -> ConversationMessage {
        let json = """
        {"id":"a1","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Opcje poniżej.","question_id":null,"answer_type":null,
         "answer_text":null,"ai_cost":null,"created_at":"2026-10-22T12:00:00.000Z","response_status":null,"analysis_cancellable":null,
         \(options ? #""answer_options":[{"key":"A","title":"Najpierw 3 g, bolus później","detail":"15 g do Trio bez insuliny","recommended":true},{"key":"B","title":"Mniejsza dawka teraz","detail":"1,6 j na 15 g","recommended":false}],"# : "")
         "rescue_carb_proposals":[{"id":"r1","carbs_g":3,"reason":null,"status":"\(rescueStatus)","created_at":null,"option_key":"A"}],
         "bolus_proposals":[
           \(card(id: "b1", option: "A", insulin: 0, state: "PROPOSED", risk: nil)),
           \(card(id: "b2", option: "B", insulin: 1.6, state: bolusState, risk: #"{"min_mgdl":55,"min_in_minutes":70,"level":"LOW","baseline_min_mgdl":73}"#))
         ]}
        """
        return try JSONDecoder().decode(ConversationMessage.self, from: Data(json.utf8))
    }

    private func card(id: String, option: String, insulin: Double, state: String, risk: String?) -> String {
        """
        {"id":"\(id)","purpose":"MEAL","carbs_g":15,"insulin_u":\(insulin),"icr_g_per_u":9,"icr_insulin_u":1.7,"meal_description":null,"reason":null,
         "warnings":[],"expires_at":"2099-01-01T00:00:00.000Z","state":"\(state)","command":null,"option_key":"\(option)","risk":\(risk ?? "null")}
        """
    }

    func testTheRecommendedOptionIsChosenFirstAndShowsOnlyItsCards() throws {
        let message = try message()
        let options = try XCTUnwrap(AnswerOptionsPresentation(message: message, chosenKey: nil))
        XCTAssertEqual(options.selectedKey, "A")
        XCTAssertEqual(message.bolus_proposals?.filter { options.shows(optionKey: $0.option_key) }.map(\.id), ["b1"])
        XCTAssertEqual(message.rescue_carb_proposals?.filter { options.shows(optionKey: $0.option_key) }.map(\.id), ["r1"])
        XCTAssertTrue(options.shows(optionKey: nil))
        XCTAssertEqual(options.forecastMinimum(of: "B", in: message), 55)
        XCTAssertNil(options.forecastMinimum(of: "A", in: message))
        XCTAssertEqual(options.summary(of: "A", in: message), "3 g dosłodzenia · 15 g bez insuliny teraz")
        XCTAssertEqual(options.summary(of: "B", in: message), "1,6 j teraz")
    }

    func testAnotherOptionOrTheOwnPlanCanBeChosen() throws {
        let message = try message()
        let b = try XCTUnwrap(AnswerOptionsPresentation(message: message, chosenKey: "B"))
        XCTAssertEqual(message.bolus_proposals?.filter { b.shows(optionKey: $0.option_key) }.map(\.id), ["b2"])
        let own = try XCTUnwrap(AnswerOptionsPresentation(message: message, chosenKey: AnswerOptionsPresentation.ownPlanKey))
        XCTAssertTrue(own.isOwnPlan)
        XCTAssertEqual(message.bolus_proposals?.filter { own.shows(optionKey: $0.option_key) }, [])
        // A key the answer does not have falls back to the recommended option.
        XCTAssertEqual(AnswerOptionsPresentation(message: message, chosenKey: "C")?.selectedKey, "A")
    }

    func testSomethingSentFixesThePickerOnItsOption() throws {
        let sent = try XCTUnwrap(AnswerOptionsPresentation(message: try message(bolusState: "SENT"), chosenKey: "A"))
        XCTAssertEqual(sent.lockedKey, "B")
        XCTAssertEqual(sent.selectedKey, "B")
        let logged = try XCTUnwrap(AnswerOptionsPresentation(message: try message(rescueStatus: "ACCEPTED"), chosenKey: AnswerOptionsPresentation.ownPlanKey))
        XCTAssertEqual(logged.selectedKey, "A")
    }

    func testTheRecommendedOptionIsOnTopWhateverItsLetter() throws {
        var message = try message()
        message.answer_options = [AnswerOption(key: "A", title: "a"), AnswerOption(key: "B", title: "b", recommended: true)]
        let options = try XCTUnwrap(AnswerOptionsPresentation(message: message, chosenKey: nil))
        XCTAssertEqual(options.options.map(\.key), ["B", "A"])
        XCTAssertEqual(options.selectedKey, "B")
    }

        func testAnAlertTreatmentFromAnOptionsCardFixesThatOption() throws {
        let locked = try XCTUnwrap(AnswerOptionsPresentation(message: try message(), chosenKey: "B", treatedProposalID: "r1"))
        XCTAssertEqual(locked.lockedKey, "A")
        let card = ConversationRescueCarbProposal(id: "r2", carbs_g: 5, status: "PROPOSED", option_key: "B")
        let treatment = RescueCarbsTreatment(carbs_g: 3, given_at: "2026-10-22T12:00:00Z", proposal_id: "r1")
        XCTAssertEqual(RescueCarbProposalCard.decidedLine(proposal: card, treatment: treatment), "Dosłodzenie już zapisane z innej karty (3 g)")
    }

    func testAnAnswerWithoutOptionsShowsItsCardsAsBefore() throws {
        XCTAssertNil(AnswerOptionsPresentation(message: try message(options: false), chosenKey: nil))
    }

    @MainActor
    func testTheChoiceIsKeptPerAnswer() {
        let viewModel = ConversationViewModel(apiClient: APIClient(baseURL: URL(string: "http://localhost")!, authorizationMode: .none, httpClient: URLSessionHTTPClient()), patientID: "p1")
        viewModel.chooseAnswerOption(messageID: "a1", key: AnswerOptionsPresentation.ownPlanKey)
        viewModel.chooseAnswerOption(messageID: "a2", key: "B")
        XCTAssertEqual(viewModel.answerOptionChoices, ["a1": AnswerOptionsPresentation.ownPlanKey, "a2": "B"])
    }
}
