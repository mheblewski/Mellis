import XCTest
@testable import GlucoMindCore

@MainActor
final class ConversationPhotoTests: XCTestCase {
    func testPhotosAreUploadedOnceAndSentWithTheMessage() async throws {
        let api = PhotoStubAPI()
        api.messageStatus = 503
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        XCTAssertFalse(model.hasComposerContent)
        model.addPhoto(Data([0xff, 0xd8, 0xff, 0x01]))
        model.addPhoto(Data([0xff, 0xd8, 0xff, 0x02]))
        // A photo alone can be sent.
        XCTAssertTrue(model.hasComposerContent)

        model.userMessageText = "Ile insuliny na to?"
        await model.submitUserMessage()
        XCTAssertEqual(api.uploads, 2)
        XCTAssertTrue(model.canRetryFailedSubmission)
        XCTAssertEqual(model.draftPhotos.count, 2, "a failed send keeps the photos")

        api.messageStatus = 200
        await model.submitUserMessage()
        XCTAssertEqual(api.uploads, 2, "the retry reuses the uploaded photos")
        XCTAssertEqual(api.messageBodies.count, 2)
        XCTAssertEqual(Set(api.messageKeys).count, 1, "same text and photos: same idempotency key")
        let body = try XCTUnwrap(api.messageBodies.last)
        XCTAssertEqual(body["photo_ids"] as? [String], ["photo-1", "photo-2"])
        XCTAssertEqual(body["content"] as? String, "Ile insuliny na to?")
        XCTAssertTrue(model.draftPhotos.isEmpty)
        // Photos sent from this device are shown without downloading them again.
        let cached = await model.photo("photo-1")
        XCTAssertEqual(cached, Data([0xff, 0xd8, 0xff, 0x01]))
        XCTAssertEqual(api.photoDownloads, 0)
    }

    func testAtMostThreePhotosAndTextOnlyMessagesHaveNoPhotoIDs() async throws {
        let api = PhotoStubAPI()
        let model = ConversationViewModel(apiClient: api.client, patientID: "patient-1", conversationID: "conv-a", pollInterval: .milliseconds(1))
        await model.loadConversation()

        for byte in 1...4 {
            model.addPhoto(Data([0xff, 0xd8, 0xff, UInt8(byte)]))
        }
        XCTAssertEqual(model.draftPhotos.count, 3)
        XCTAssertFalse(model.canAddPhoto)
        model.removeDraftPhoto(at: 0)
        model.removeDraftPhoto(at: 0)
        model.removeDraftPhoto(at: 0)
        XCTAssertTrue(model.draftPhotos.isEmpty)

        model.userMessageText = "Ile węglowodanów ma kajzerka?"
        await model.submitUserMessage()
        XCTAssertEqual(api.uploads, 0)
        XCTAssertNil(try XCTUnwrap(api.messageBodies.last)["photo_ids"])
    }

    func testMessagePhotoIDsDecodeAndOlderMessagesHaveNone() throws {
        let json = """
        [{"id":"u-1","role":"USER","message_type":"USER_MESSAGE","content":"","created_at":"2026-10-17T10:00:00.000Z","photo_ids":["p-1"]},
         {"id":"u-2","role":"USER","message_type":"USER_MESSAGE","content":"Hej","created_at":"2026-10-17T10:00:00.000Z"}]
        """
        let messages = try JSONDecoder().decode([ConversationMessage].self, from: Data(json.utf8))
        XCTAssertEqual(messages[0].photo_ids, ["p-1"])
        XCTAssertNil(messages[1].photo_ids)
    }
}

private final class PhotoStubAPI {
    var messageStatus = 200
    private(set) var uploads = 0
    private(set) var photoDownloads = 0
    private(set) var messageBodies: [[String: Any]] = []
    private(set) var messageKeys: [String] = []

    private static let conversation = """
    {"id":"conv-a","patient_id":"patient-1","origin":"USER","awaiting_user_answer":false,"processing":null,
     "messages":[{"id":"a-0","role":"ASSISTANT","message_type":"ASSISTANT_MESSAGE","content":"Cześć","created_at":"2026-10-17T09:00:00.000Z"}]}
    """

    lazy var client = APIClient(
        baseURL: URL(string: "https://api.example.com")!,
        authorizationMode: .none,
        httpClient: PhotoClosureHTTPClient { [unowned self] request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path.hasSuffix("/photos") {
                self.uploads += 1
                return (Data(#"{"patient_id":"patient-1","photo_id":"photo-\#(self.uploads)"}"#.utf8), 201)
            }
            if request.httpMethod == "POST", path.hasSuffix("/messages") {
                self.messageKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
                let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
                self.messageBodies.append(body)
                guard self.messageStatus == 200 else { return (Data("{}".utf8), self.messageStatus) }
                let response = """
                {"message":{"id":"u-1","role":"USER","message_type":"USER_MESSAGE","content":"x","created_at":"2026-10-17T10:00:00.000Z"},
                 "conversation":\(PhotoStubAPI.conversation),"decision":"ANALYSIS_REQUEST"}
                """
                return (Data(response.utf8), 200)
            }
            if path.contains("/photos/") {
                self.photoDownloads += 1
                return (Data([0xff, 0xd8, 0xff]), 200)
            }
            return (Data(PhotoStubAPI.conversation.utf8), 200)
        }
    )
}

private final class PhotoClosureHTTPClient: HTTPClient {
    private let handler: (URLRequest) async throws -> (Data, Int)

    init(handler: @escaping (URLRequest) async throws -> (Data, Int)) {
        self.handler = handler
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, status) = try await handler(request)
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
