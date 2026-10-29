import XCTest
@testable import GlucoMindCore

final class QuestionAnswerOptionsTests: XCTestCase {
    func testDecodesServerAnswerOptionsAndToleratesOlderServers() throws {
        let withOptions = Data("""
        {"question_id":"additional_carbohydrates","question_type":"CONTEXT_QUESTION",
         "question_text":"Ile węglowodanów podano, żeby podnieść cukier?","expected_answer_types":["YES","NO","UNKNOWN","TEXT"],
         "reason":"r","expected_information_gain":"HIGH","status":"OPEN","created_at":"2026-10-15T15:00:00Z",
         "answer_options":[{"label":"4 g","answer_type":"TEXT","answer_text":"Podano 4 g węglowodanów"},
                           {"label":"Nie podano","answer_type":"NO"}]}
        """.utf8)
        let question = try JSONDecoder().decode(PendingQuestion.self, from: withOptions)
        XCTAssertEqual(question.answer_options?.first, QuestionAnswerOption(label: "4 g", answer_type: .text, answer_text: "Podano 4 g węglowodanów"))
        XCTAssertEqual(question.answer_options?.last?.answer_type, .no)

        let withoutOptions = Data("""
        {"question_id":"activity_before_drop","question_type":"CONTEXT_QUESTION","question_text":"?",
         "expected_answer_types":["YES"],"reason":"r","expected_information_gain":"HIGH","status":"OPEN","created_at":"2026-10-15T15:00:00Z"}
        """.utf8)
        XCTAssertNil(try JSONDecoder().decode(PendingQuestion.self, from: withoutOptions).answer_options)
    }

    func testButtonAnswersReadInPolishEvenWhenStoredAsCodes() throws {
        let stored = Data("""
        {"id":"m1","role":"USER","message_type":"CONTEXT_ANSWER","content":"YES","question_id":"activity_before_drop",
         "answer_type":"YES","answer_text":null,"ai_cost":null,"created_at":"2026-10-15T15:00:00Z","response_status":null,"analysis_cancellable":null}
        """.utf8)
        XCTAssertEqual(try JSONDecoder().decode(ConversationMessage.self, from: stored).displayContent, "Tak")

        let typed = Data("""
        {"id":"m2","role":"USER","message_type":"CONTEXT_ANSWER","content":"Podano 4 g węglowodanów","question_id":"additional_carbohydrates",
         "answer_type":"TEXT","answer_text":"Podano 4 g węglowodanów","ai_cost":null,"created_at":"2026-10-15T15:00:00Z","response_status":null,"analysis_cancellable":null}
        """.utf8)
        XCTAssertEqual(try JSONDecoder().decode(ConversationMessage.self, from: typed).displayContent, "Podano 4 g węglowodanów")
    }
}
