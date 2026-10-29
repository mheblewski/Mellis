import XCTest
@testable import GlucoMindCore

final class DeviceRegistrationTests: XCTestCase {
    func testTokenRegistrationBoundaryCallsBackendEndpoint() async throws {
        let capture = CaptureHTTPClient()
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authProvider: StubAuthProvider(),
            httpClient: capture
        )
        let service = APIBasedDeviceRegistrationService(apiClient: client)

        try await service.registerDeviceToken(
            patientID: "patient-1",
            deviceID: "ios-device-1",
            pushToken: "abcd",
            appVersion: "0.1.0"
        )

        XCTAssertEqual(capture.lastRequest?.url?.path, "/v1/patients/patient-1/devices")
        XCTAssertEqual(capture.lastRequest?.httpMethod, "POST")
    }
}

private struct StubAuthProvider: AuthProvider {
    func bearerToken() async throws -> String { "user-1" }
}

private final class CaptureHTTPClient: HTTPClient {
    var lastRequest: URLRequest?

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        let data = """
        {
          "device": {
            "id":"dev-1",
            "patient_id":"patient-1",
            "platform":"ios",
            "device_id":"ios-device-1",
            "push_token":"abcd",
            "active":true
          }
        }
        """.data(using: .utf8)!
        let response = HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}

final class DeviceSignOutAndRegistrationTests: XCTestCase {
    func testSignOutDevicePostsTheTokenAndAccepts204() async throws {
        let http = RecordingHTTPClient(status: 204)
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: StubAuthProvider(), httpClient: http)

        try await client.signOutDevice(pushToken: "a1b2c3")

        let request = try XCTUnwrap(http.requests.first)
        XCTAssertEqual(request.url?.path, "/v1/me/devices/sign-out")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer user-1")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["push_token": "a1b2c3", "platform": "ios"])
    }

    func testSignOutDeviceReportsAServerRefusal() async {
        let client = APIClient(baseURL: URL(string: "https://api.example.com")!, authProvider: StubAuthProvider(), httpClient: RecordingHTTPClient(status: 401))

        do {
            try await client.signOutDevice(pushToken: "a1b2c3")
            XCTFail("expected an error")
        } catch APIClientError.unauthenticated {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testOneRefusedPatientDoesNotSkipTheOthers() async {
        let registrar = PartlyRefusingRegistrar(refused: ["patient-2"])

        let failures = await registrar.registerDeviceToken(
            patientIDs: ["patient-1", "patient-2", "patient-3"],
            deviceID: "ios-device-1",
            pushToken: "abcd",
            appVersion: "1.0"
        )

        XCTAssertEqual(registrar.registered, ["patient-1", "patient-3"])
        XCTAssertEqual(failures.map(\.patientID), ["patient-2"])
    }
}

private final class RecordingHTTPClient: HTTPClient {
    let status: Int
    private(set) var requests: [URLRequest] = []

    init(status: Int) {
        self.status = status
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return (Data(), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

private final class PartlyRefusingRegistrar: DeviceRegistrationService {
    let refused: Set<String>
    private(set) var registered: [String] = []

    init(refused: Set<String>) {
        self.refused = refused
    }

    func registerDeviceToken(patientID: String, deviceID: String, pushToken: String, appVersion: String?) async throws {
        if refused.contains(patientID) {
            throw APIClientError.forbidden(nil)
        }
        registered.append(patientID)
    }
}
