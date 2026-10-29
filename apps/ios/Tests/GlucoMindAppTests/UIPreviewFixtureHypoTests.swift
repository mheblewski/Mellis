import XCTest
@testable import GlucoMindApp
@testable import GlucoMindCore

/// The simulator's network-free fixtures must stay decodable: the hypo and rescue screens are checked visually through them.
final class UIPreviewFixtureHypoTests: XCTestCase {
    private let base = "https://fixtures.invalid/v1/patients/11111111-1111-4111-8111-111111111111"

    func testHypoConversationFixtureDecodes() async throws {
        let client = UIPreviewFixtureHTTPClient()

        let (data, response) = try await client.perform(URLRequest(url: URL(string: "\(base)/conversations/conv-hypo")!))
        XCTAssertEqual(response.statusCode, 200)
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: data)
        XCTAssertEqual(conversation.hypo?.minimum_glucose, 57)
        XCTAssertEqual(conversation.hypo?.glucose_readings.count, 20)
    }

    func testRescueCarbsFixtureDecodesBeforeAndAfterLoggingTheDose() async throws {
        let client = UIPreviewFixtureHTTPClient()

        let (data, response) = try await client.perform(URLRequest(url: URL(string: "\(base)/conversations/conv-rescue")!))
        XCTAssertEqual(response.statusCode, 200)
        let conversation = try JSONDecoder().decode(ConversationResponse.self, from: data)
        let rescue = try XCTUnwrap(conversation.rescue_carbs)
        XCTAssertEqual(rescue.levelKind, .predictedLow)
        XCTAssertEqual(rescue.proposedGrams, 4)
        XCTAssertEqual(rescue.glucose_readings.count, 26)
        XCTAssertEqual(rescue.prediction.count, 7)
        XCTAssertFalse(rescue.isTreated)
        let card = try XCTUnwrap(conversation.messages.compactMap(\.rescue_carb_proposals).first?.first)
        XCTAssertEqual(card.carbs_g, 6)

        var post = URLRequest(url: URL(string: "\(base)/conversations/conv-rescue/rescue-carbs")!)
        post.httpMethod = "POST"
        post.httpBody = try JSONEncoder().encode(RescueCarbsLogRequest(carbs_g: 6, given_at: "2026-10-20T12:00:00.000Z", proposal_id: card.id))
        let (savedData, savedResponse) = try await client.perform(post)
        XCTAssertEqual(savedResponse.statusCode, 200)
        let saved = try XCTUnwrap(JSONDecoder().decode(RescueCarbsLogResponse.self, from: savedData).rescue_carbs)
        XCTAssertEqual(saved.treatment?.carbs_g, 6)
        XCTAssertEqual(saved.treatment?.proposal_id, card.id)
        XCTAssertEqual(saved.status, "TREATED")

        // A second caregiver's save is refused the way the server refuses it.
        let (_, againResponse) = try await client.perform(post)
        XCTAssertEqual(againResponse.statusCode, 409)

        var put = URLRequest(url: URL(string: "\(base)/devices/device-1/notification-settings")!)
        put.httpMethod = "PUT"
        put.httpBody = Data(#"{"rescue_carb_alerts_enabled":true}"#.utf8)
        let (settingsData, _) = try await client.perform(put)
        XCTAssertEqual(try JSONDecoder().decode(DeviceNotificationSettings.self, from: settingsData).rescue_carb_alerts_enabled, true)
    }
}
