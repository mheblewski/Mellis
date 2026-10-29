import XCTest
@testable import GlucoMindCore

@MainActor
final class MealChatViewModelTests: XCTestCase {
    private let route = MealRoute(patientID: "p", mealID: "m")

    func testSendUploadsPhotosThenPostsAndPollsUntilTheReplyArrives() async throws {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: true), Self.chat(pending: true), Self.chat(pending: false, withReply: true)]
        let viewModel = MealChatViewModel(route: route, api: api, pollIntervalNanoseconds: 1_000_000, maxPolls: 10)
        viewModel.draft = "  Kanapka  "
        viewModel.addPhoto(Data([0xff, 0xd8, 0xff]))

        await viewModel.send()
        for _ in 0..<200 where viewModel.chat?.reply_pending != false {
            try await Task.sleep(nanoseconds: 2_000_000)
        }

        XCTAssertEqual(api.uploads, 1)
        XCTAssertEqual(api.posted.first?.content, "Kanapka")
        XCTAssertEqual(api.posted.first?.photoIDs, ["photo-1"])
        XCTAssertEqual(viewModel.draft, "")
        XCTAssertTrue(viewModel.draftPhotos.isEmpty)
        XCTAssertEqual(viewModel.chat?.reply_pending, false)
        XCTAssertEqual(viewModel.latestProposalMessageID, "a1")
    }

    func testResendingTheSameDraftReusesTheKeyAndTheUploadedPhotos() async {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: false)]
        api.postFailures = 1
        let viewModel = MealChatViewModel(route: route, api: api)
        viewModel.draft = "Kanapka"
        viewModel.addPhoto(Data([0xff, 0xd8, 0xff]))

        await viewModel.send()
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertEqual(viewModel.draft, "Kanapka", "a failed send keeps the draft")

        await viewModel.send()
        XCTAssertEqual(api.keys.count, 2)
        XCTAssertEqual(api.keys[0], api.keys[1], "the same message keeps its idempotency key")
        XCTAssertEqual(api.uploads, 1, "the photo is not uploaded twice")
        XCTAssertEqual(api.posted.map(\.photoIDs), [["photo-1"], ["photo-1"]])
        XCTAssertEqual(viewModel.draft, "")

        // A new message after a successful one gets its own key.
        viewModel.draft = "Jabłko"
        await viewModel.send()
        XCTAssertNotEqual(api.keys[2], api.keys[1])
    }

    func testAChangedDraftAfterAFailedSendGetsANewKey() async {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: false)]
        api.postFailures = 1
        let viewModel = MealChatViewModel(route: route, api: api)
        viewModel.draft = "Kanapka"
        await viewModel.send()

        viewModel.draft = "Kanapka z serem"
        await viewModel.send()

        XCTAssertEqual(api.keys.count, 2)
        XCTAssertNotEqual(api.keys[0], api.keys[1])
    }

    func testPollingDoesNotKeepAClosedChatAlive() async throws {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: true)]
        var viewModel: MealChatViewModel? = MealChatViewModel(route: route, api: api, pollIntervalNanoseconds: 20_000_000, maxPolls: 1_000)
        await viewModel?.load()
        weak var released = viewModel

        viewModel = nil
        try await Task.sleep(nanoseconds: 300_000_000)

        XCTAssertNil(released, "the polling task must not hold the view model")
        let reads = api.reads
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(api.reads, reads, "no reads after the chat went away")
    }

    func testStoppingAndRestartingPollingKeepsTheNewPoll() async throws {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: true)]
        let viewModel = MealChatViewModel(route: route, api: api, pollIntervalNanoseconds: 5_000_000, maxPolls: 1_000)
        await viewModel.load()
        viewModel.stopPolling()
        await viewModel.load()
        try await Task.sleep(nanoseconds: 50_000_000)
        let reads = api.reads

        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertGreaterThan(api.reads, reads, "the restarted poll keeps reading")
        viewModel.stopPolling()
    }

    func testAtMostThreePhotosAndNothingToSendWithoutTextOrPhoto() {
        let viewModel = MealChatViewModel(route: route, api: StubMealChatAPI())
        XCTAssertFalse(viewModel.canSend)
        for _ in 0..<5 { viewModel.addPhoto(Data([1])) }
        XCTAssertEqual(viewModel.draftPhotos.count, 3)
        XCTAssertFalse(viewModel.canAddPhoto)
        XCTAssertTrue(viewModel.canSend)
    }

    func testAcceptSendsTheMessageID() async {
        let api = StubMealChatAPI()
        api.chats = [Self.chat(pending: false, withReply: true)]
        let viewModel = MealChatViewModel(route: route, api: api)
        await viewModel.accept(messageID: "a1")
        XCTAssertEqual(api.accepted, ["a1"])
    }

    func testEditSavesOnlyWhatChanged() async throws {
        let meal = Self.chat(pending: false).meal
        let api = StubMealChatAPI()

        // Only the description changed; the prefilled Nightscout carbs were not touched: no values saved.
        try? await MealEdit.apply(MealEdit(description: "Naleśniki", carbs: 30, protein: nil, fat: nil, saveValues: false), to: meal, api: api, route: route)
        XCTAssertEqual(api.descriptions, ["Naleśniki"])
        XCTAssertTrue(api.corrected.isEmpty)

        // Values edited, description unchanged: only the correction.
        let other = StubMealChatAPI()
        try? await MealEdit.apply(MealEdit(description: "Kanapka", carbs: 25, protein: 5, fat: nil, saveValues: true), to: meal, api: other, route: route)
        XCTAssertTrue(other.descriptions.isEmpty)
        XCTAssertEqual(other.corrected.count, 1)

        do {
            try await MealEdit.apply(MealEdit(description: " ", carbs: nil, protein: nil, fat: nil, saveValues: true), to: meal, api: api, route: route)
            XCTFail("expected nothingToSave")
        } catch MealEditError.nothingToSave {}
    }

    static func chat(pending: Bool, withReply: Bool = false) -> MealChatResponse {
        let reply = withReply ? """
        ,{"id":"a1","role":"ASSISTANT","content":"Kanapka.","photo_ids":[],"question":null,"author_display_name":null,"reply_to_message_id":"u1","created_at":"x",
          "proposal":{"items":[{"name":"Bułka","grams":50,"carbs_g":28,"protein_g":4,"fat_g":2,"source":"DIABCALC"}],"carbs_g":28,"protein_g":4,"fat_g":2,"confidence":"MEDIUM","assumptions":"","proposal_id":"pr1"}}
        """ : ""
        let json = """
        {"patient_id":"p","reply_pending":\(pending),"reply_failed":false,
         "meal":{"meal_id":"m","status":"DESCRIBED","started_at":"2026-10-15T06:15:00.000Z","source_carbs_g":30,"description":"Kanapka","has_photo":true,
                 "macros":{"carbs":{"grams":null,"origin":null},"protein":{"grams":null,"origin":null},"fat":{"grams":null,"origin":null}},
                 "pending_proposal_id":null,"proposal_in_progress":false,"proposal_failed":null,"trusted":false},
         "messages":[{"id":"u1","role":"USER","content":"Kanapka","photo_ids":["photo-1"],"proposal":null,"question":null,"author_display_name":"Piotr","reply_to_message_id":null,"created_at":"x"}\(reply)]}
        """
        return try! JSONDecoder().decode(MealChatResponse.self, from: Data(json.utf8))
    }
}

private final class StubMealChatAPI: MealChatAPI {
    var chats: [MealChatResponse] = []
    private(set) var uploads = 0
    private(set) var posted: [(content: String?, photoIDs: [String])] = []
    private(set) var accepted: [String] = []
    private(set) var keys: [String] = []
    private(set) var reads = 0
    var postFailures = 0

    private func nextChat() -> MealChatResponse {
        chats.count > 1 ? chats.removeFirst() : chats[0]
    }

    func getMealChat(patientID: String, mealID: String) async throws -> MealChatResponse {
        reads += 1
        return nextChat()
    }
    func postMealChat(patientID: String, mealID: String, content: String?, photoIDs: [String], idempotencyKey: String) async throws -> MealChatResponse {
        posted.append((content, photoIDs))
        keys.append(idempotencyKey)
        if postFailures > 0 {
            postFailures -= 1
            throw APIClientError.transport("offline")
        }
        return nextChat()
    }
    func uploadMealPhoto(patientID: String, mealID: String, jpegData: Data) async throws -> MealPhotoUploadResponse {
        uploads += 1
        return MealPhotoUploadResponse(patient_id: patientID, photo_id: "photo-\(uploads)")
    }
    func mealPhotoData(patientID: String, mealID: String, photoID: String) async throws -> Data { Data() }
    func retryMealChatReply(patientID: String, mealID: String) async throws -> MealChatResponse { nextChat() }
    func acceptMealChatProposal(patientID: String, mealID: String, messageID: String) async throws -> MealChatResponse {
        accepted.append(messageID)
        return nextChat()
    }
    func getMeal(patientID: String, mealID: String) async throws -> MealResponse { throw APIClientError.invalidResponse }
    private(set) var corrected: [(Double?, Double?, Double?)] = []
    private(set) var descriptions: [String] = []
    func correctMeal(patientID: String, mealID: String, carbsG: Double?, proteinG: Double?, fatG: Double?) async throws -> MealResponse {
        corrected.append((carbsG, proteinG, fatG))
        throw APIClientError.invalidResponse
    }
    func updateMealDescription(patientID: String, mealID: String, description: String) async throws -> MealResponse {
        descriptions.append(description)
        throw APIClientError.invalidResponse
    }
}
