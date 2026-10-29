import XCTest
@testable import GlucoMindCore

final class APIClientTests: XCTestCase {
    func testConversationDecoding() async throws {
        let json = """
        {
          "id":"conv-1",
          "patient_id":"patient-1",
          "awaiting_user_answer":true,
          "pending_question":{
            "question_id":"activity_before_drop",
            "question_type":"CONTEXT_QUESTION",
            "question_text":"Was there activity?",
            "expected_answer_types":["YES","NO","UNKNOWN","TEXT"],
            "reason":"missing context",
            "expected_information_gain":"HIGH",
            "status":"OPEN",
            "created_at":"2026-01-01T00:00:00.000Z"
          },
          "messages":[],
          "analysis_id":null,
          "recommendation_id":null
        }
        """.data(using: .utf8)!

        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 200, data: json)
        )

        let conversation = try await client.getConversation(patientID: "patient-1", conversationID: "conv-1")
        XCTAssertEqual(conversation.id, "conv-1")
        XCTAssertEqual(conversation.pending_question?.question_id, "activity_before_drop")
    }

        func testConversationDecodingIncludesAssistantAiCost() async throws {
                let json = """
                {
                    "id":"conv-1",
                    "patient_id":"patient-1",
                    "awaiting_user_answer":false,
                    "pending_question":null,
                    "messages":[
                        {
                            "id":"msg-assistant-1",
                            "role":"ASSISTANT",
                            "message_type":"ASSISTANT_MESSAGE",
                            "content":"Dzisiaj glikemia byla stabilna.",
                            "question_id":null,
                            "answer_type":null,
                            "answer_text":null,
                            "ai_cost":{
                                "status":"KNOWN",
                                "amount":0.002841,
                                "currency":"USD",
                                "pricing_version":"openai.pricing.v1",
                                "provider":"openai",
                                "model":"gpt-5.6-terra"
                            },
                            "created_at":"2026-01-01T00:00:00.000Z"
                        }
                    ],
                    "analysis_id":null,
                    "recommendation_id":null
                }
                """.data(using: .utf8)!

                let client = APIClient(
                        baseURL: URL(string: "https://api.example.com")!,
                        authProvider: StubAuthProvider(token: "user-1"),
                        httpClient: StubHTTPClient(status: 200, data: json)
                )

                let conversation = try await client.getConversation(patientID: "patient-1", conversationID: "conv-1")
                XCTAssertEqual(conversation.messages.count, 1)
                XCTAssertEqual(conversation.messages.first?.ai_cost?.status, "KNOWN")
                XCTAssertEqual(conversation.messages.first?.ai_cost?.currency, "USD")
                XCTAssertEqual(conversation.messages.first?.ai_cost?.provider, "openai")
        }

    func testProblemJSONDecodingForValidationError() async throws {
        let problem = """
        {
          "type":"https://api.glucomind.local/problems/validation_error",
          "title":"Validation error",
          "status":422,
          "code":"VALIDATION_ERROR",
          "instance":"/v1/patients/patient-1/conversations/conv-1/messages"
        }
        """.data(using: .utf8)!

        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 422, data: problem)
        )

        do {
            _ = try await client.getConversation(patientID: "patient-1", conversationID: "conv-1")
            XCTFail("Expected validation error")
        } catch APIClientError.validation(let details) {
            XCTAssertEqual(details?.code, "VALIDATION_ERROR")
            XCTAssertEqual(details?.status, 422)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testAnswerSubmissionUsesIdempotencyKeyHeader() async throws {
        let response = """
        {
          "message": {
            "id":"msg-1",
            "role":"USER",
            "message_type":"CONTEXT_ANSWER",
            "content":"YES",
            "question_id":"activity_before_drop",
            "answer_type":"YES",
            "answer_text":null,
            "created_at":"2026-01-01T00:00:00.000Z"
          },
          "conversation": {
            "id":"conv-1",
            "patient_id":"patient-1",
            "awaiting_user_answer":false,
            "pending_question":null,
            "messages":[],
            "analysis_id":"an-1",
            "recommendation_id":null
          }
        }
        """.data(using: .utf8)!

        let http = CapturingHTTPClient(status: 200, data: response)
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: http
        )

        _ = try await client.postAnswer(
            patientID: "patient-1",
            conversationID: "conv-1",
            questionID: "activity_before_drop",
            answer: MessageAnswer(type: .yes),
            idempotencyKey: "idem-1"
        )

        XCTAssertEqual(http.lastRequest?.value(forHTTPHeaderField: "Idempotency-Key"), "idem-1")
    }

        func testUserMessageSubmissionUsesUserMessagePayloadAndIdempotencyHeader() async throws {
                let response = """
                {
                    "message": {
                        "id":"msg-2",
                        "role":"USER",
                        "message_type":"USER_MESSAGE",
                        "content":"What does this trend mean?",
                        "question_id":null,
                        "answer_type":null,
                        "answer_text":null,
                        "created_at":"2026-01-01T00:00:00.000Z"
                    },
                    "conversation": {
                        "id":"conv-1",
                        "patient_id":"patient-1",
                        "awaiting_user_answer":false,
                        "pending_question":null,
                        "messages":[],
                        "analysis_id":null,
                        "recommendation_id":null
                    },
                    "decision":"DIRECT_RESPONSE"
                }
                """.data(using: .utf8)!

                let http = CapturingHTTPClient(status: 200, data: response)
                let client = APIClient(
                        baseURL: URL(string: "https://api.example.com")!,
                        authProvider: StubAuthProvider(token: "user-1"),
                        httpClient: http
                )

                let result = try await client.postUserMessage(
                        patientID: "patient-1",
                        conversationID: "conv-1",
                        content: "What does this trend mean?",
                        idempotencyKey: "idem-user-1"
                )

                XCTAssertEqual(result.decision, "DIRECT_RESPONSE")
                XCTAssertEqual(http.lastRequest?.value(forHTTPHeaderField: "Idempotency-Key"), "idem-user-1")

                let requestBody = try XCTUnwrap(http.lastRequest?.httpBody)
                let payload = try JSONDecoder().decode(UserMessageSubmissionRequest.self, from: requestBody)
                XCTAssertEqual(payload.message_type, "USER_MESSAGE")
                XCTAssertEqual(payload.content, "What does this trend mean?")
        }

    func testDeleteConversationSendsDeleteAndTreatsAlreadyDeletedAsSuccess() async throws {
        let http = CapturingHTTPClient(status: 204, data: Data())
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: http
        )

        try await client.deleteConversation(patientID: "patient-1", conversationID: "conv-1")
        XCTAssertEqual(http.lastRequest?.httpMethod, "DELETE")
        XCTAssertEqual(http.lastRequest?.url?.path, "/v1/patients/patient-1/conversations/conv-1")

        let gone = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 404, data: Data())
        )
        try await gone.deleteConversation(patientID: "patient-1", conversationID: "conv-1")

        let forbidden = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 403, data: Data())
        )
        do {
            try await forbidden.deleteConversation(patientID: "patient-1", conversationID: "conv-1")
            XCTFail("expected forbidden")
        } catch APIClientError.forbidden {
        }
    }

    func testUpdateConversationSendsOnlyTheChangedFields() async throws {
        let http = CapturingHTTPClient(status: 204, data: Data())
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: http
        )

        try await client.updateConversation(patientID: "patient-1", conversationID: "conv-1", pinned: true)
        XCTAssertEqual(http.lastRequest?.httpMethod, "PATCH")
        XCTAssertEqual(http.lastRequest?.url?.path, "/v1/patients/patient-1/conversations/conv-1")
        let pinBody = try JSONSerialization.jsonObject(with: XCTUnwrap(http.lastRequest?.httpBody)) as? [String: Any]
        XCTAssertEqual(pinBody?.keys.sorted(), ["pinned"])
        XCTAssertEqual(pinBody?["pinned"] as? Bool, true)

        try await client.updateConversation(patientID: "patient-1", conversationID: "conv-1", title: "Pizza w sobotę")
        let titleBody = try JSONSerialization.jsonObject(with: XCTUnwrap(http.lastRequest?.httpBody)) as? [String: Any]
        XCTAssertEqual(titleBody?.keys.sorted(), ["title"])
        XCTAssertEqual(titleBody?["title"] as? String, "Pizza w sobotę")

        let forbidden = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 403, data: Data())
        )
        do {
            try await forbidden.updateConversation(patientID: "patient-1", conversationID: "conv-1", pinned: false)
            XCTFail("expected forbidden")
        } catch APIClientError.forbidden {
        }
    }

    func testRecommendationDecoding() async throws {
        let http = RoutingHTTPClient()
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: http
        )

        let recommendation = try await client.getRecommendation(patientID: "patient-1", recommendationID: "rec-1")
        XCTAssertEqual(recommendation.id, "rec-1")
        XCTAssertEqual(recommendation.proposal.type, "PROPOSAL")
    }

    func testForbiddenMapsToAuthorizationError() async {
        let problem = """
        {
          "type":"https://api.glucomind.local/problems/forbidden",
          "title":"Forbidden",
          "status":403,
          "code":"FORBIDDEN",
          "instance":"/v1/patients/patient-1/current-state"
        }
        """.data(using: .utf8)!

        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 403, data: problem)
        )

        do {
            _ = try await client.getConversation(patientID: "patient-1", conversationID: "conv-1")
            XCTFail("Expected forbidden error")
        } catch APIClientError.forbidden(let details) {
            XCTAssertEqual(details?.code, "FORBIDDEN")
            XCTAssertEqual(details?.status, 403)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testListAccessiblePatients() async throws {
        let payload = """
        {
          "user_id":"user-1",
          "patients":[
            {"patient_id":"11111111-1111-4111-8111-111111111111","display_name":"Patient A"},
            {"patient_id":"22222222-2222-4222-8222-222222222222","display_name":"Patient B"}
          ]
        }
        """.data(using: .utf8)!

        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(token: "user-1"),
            httpClient: StubHTTPClient(status: 200, data: payload)
        )

        let response = try await client.listAccessiblePatients()
        XCTAssertEqual(response.user_id, "user-1")
        XCTAssertEqual(response.patients.count, 2)
        XCTAssertEqual(response.patients.first?.patient_id, "11111111-1111-4111-8111-111111111111")
    }

        func testPendingInvestigationDecodingIsIndependentReadModel() async throws {
                let payload = """
                {
                    "patient_id":"patient-1",
                    "pending_investigation":{
                        "investigation_id":"inv-1",
                        "state":"QUESTION_PENDING",
                        "question":"Was there activity before the drop?",
                        "question_id":"activity_before_drop",
                        "conversation_id":"conv-1",
                        "event_id":"evt-1"
                    }
                }
                """.data(using: .utf8)!

                let client = APIClient(
                        baseURL: URL(string: "https://api.example.com")!,
                        authProvider: StubAuthProvider(token: "user-1"),
                        httpClient: StubHTTPClient(status: 200, data: payload)
                )

                let response = try await client.getPendingInvestigation(patientID: "patient-1")
                XCTAssertEqual(response.pending_investigation?.state, "QUESTION_PENDING")
                XCTAssertEqual(response.pending_investigation?.conversation_id, "conv-1")
        }

        func testListConversationsDecodingAndQueryParameters() async throws {
                let payload = """
                {
                    "patient_id":"patient-1",
                    "items":[
                        {
                            "id":"conv-1",
                            "patient_id":"patient-1",
                            "episode_id":null,
                            "trigger_id":null,
                            "origin":"USER",
                            "trigger_type":null,
                            "thread_state_version":"conv-v1",
                            "awaiting_user_answer":false,
                            "conversation_type":"USER_INITIATED",
                            "workflow_status":"ACTIVE",
                            "analysis_id":null,
                            "recommendation_id":null,
                            "created_at":"2026-10-06T08:00:00.000Z",
                            "updated_at":"2026-10-06T08:03:00.000Z"
                        }
                    ],
                    "next_cursor":null
                }
                """.data(using: .utf8)!

                let http = CapturingHTTPClient(status: 200, data: payload)
                let client = APIClient(
                        baseURL: URL(string: "https://api.example.com")!,
                        authProvider: StubAuthProvider(token: "user-1"),
                        httpClient: http
                )

                let response = try await client.listConversations(patientID: "patient-1", limit: 20, cursor: "abc")
                XCTAssertEqual(response.patient_id, "patient-1")
                XCTAssertEqual(response.items.count, 1)
                XCTAssertEqual(response.items.first?.id, "conv-1")
                XCTAssertEqual(response.items.first?.origin, "USER")

                let query = http.lastRequest?.url?.query ?? ""
                XCTAssertTrue(query.contains("limit=20"))
                XCTAssertTrue(query.contains("cursor=abc"))
        }

    func testLocalDisabledModeSendsRequestWithoutAuthorizationHeader() async throws {
        let payload = """
        {
          "user_id":"user-1",
          "patients":[]
        }
        """.data(using: .utf8)!

        let http = CapturingHTTPClient(status: 200, data: payload)
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authorizationMode: .none,
            httpClient: http
        )

        _ = try await client.listAccessiblePatients()
        XCTAssertNil(http.lastRequest?.value(forHTTPHeaderField: "Authorization"))
    }

    func testCognitoModeUsesAuthProviderAndSetsAuthorizationHeader() async throws {
        let payload = """
        {
          "user_id":"user-1",
          "patients":[]
        }
        """.data(using: .utf8)!

        let auth = CountingAuthProvider(token: "token-123")
        let http = CapturingHTTPClient(status: 200, data: payload)
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: auth,
            httpClient: http
        )

        _ = try await client.listAccessiblePatients()

        XCTAssertEqual(auth.calls, 1)
        XCTAssertEqual(http.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
    }

    #if DEBUG
    func testLocalTokenModeSendsDevelopmentTokenAsBearerHeader() async throws {
        let payload = """
        {
          "user_id":"user-1",
          "patients":[]
        }
        """.data(using: .utf8)!

        // Synthetic value; real development tokens live only in the gitignored local configuration.
        let http = CapturingHTTPClient(status: 200, data: payload)
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: DevelopmentTokenAuthProvider(token: "synthetic-dev-token"),
            httpClient: http
        )

        _ = try await client.listAccessiblePatients()
        XCTAssertEqual(http.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-dev-token")
    }

    func testLocalTokenModeWithEmptyTokenSendsNoRequest() async {
        let http = CapturingHTTPClient(status: 200, data: Data())
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: DevelopmentTokenAuthProvider(token: ""),
            httpClient: http
        )

        do {
            _ = try await client.listAccessiblePatients()
            XCTFail("Expected unauthenticated error")
        } catch {
            XCTAssertNil(http.lastRequest)
        }
    }
    #endif

    func testCognitoModeRequiresAuthProviderTokenBeforeRequest() async {
        let http = CapturingHTTPClient(status: 200, data: Data("{}".utf8))
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: ThrowingAuthProvider(),
            httpClient: http
        )

        do {
            _ = try await client.listAccessiblePatients()
            XCTFail("Expected unauthenticated error")
        } catch APIClientError.unauthenticated {
            XCTAssertNil(http.lastRequest)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}

private struct StubAuthProvider: AuthProvider {
    let token: String
    func bearerToken() async throws -> String { token }
}

private final class CountingAuthProvider: AuthProvider {
    private(set) var calls = 0
    private let token: String

    init(token: String) {
        self.token = token
    }

    func bearerToken() async throws -> String {
        calls += 1
        return token
    }
}

private struct ThrowingAuthProvider: AuthProvider {
    func bearerToken() async throws -> String {
        throw APIClientError.unauthenticated(nil)
    }
}

private final class StubHTTPClient: HTTPClient {
    let status: Int
    let data: Data

    init(status: Int, data: Data) {
        self.status = status
        self.data = data
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}

private final class CapturingHTTPClient: HTTPClient {
    let status: Int
    let data: Data
    var lastRequest: URLRequest?

    init(status: Int, data: Data) {
        self.status = status
        self.data = data
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}

private final class RoutingHTTPClient: HTTPClient {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                let data = """
                {
                    "id":"rec-1",
                    "status":"READY",
                    "proposal":{"type":"PROPOSAL","title":"title","text":"text"}
                }
                """.data(using: .utf8)!

                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (data, response)
        }
}
