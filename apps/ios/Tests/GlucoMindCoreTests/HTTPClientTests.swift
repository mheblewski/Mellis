import XCTest
@testable import GlucoMindCore

final class HTTPClientTests: XCTestCase {
    override func tearDown() {
        FailingURLProtocol.error = nil
        super.tearDown()
    }

    func testOfflineFailureBecomesTransportError() async {
        FailingURLProtocol.error = URLError(.notConnectedToInternet)
        let client = URLSessionHTTPClient(session: Self.stubbedSession())

        do {
            _ = try await client.perform(URLRequest(url: URL(string: "https://api.example.com/v1/me/patients")!))
            XCTFail("expected a transport error")
        } catch APIClientError.transport {
            // "Brak połączenia" on the screens.
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testTimeoutBecomesTransportError() async {
        FailingURLProtocol.error = URLError(.timedOut)
        let client = URLSessionHTTPClient(session: Self.stubbedSession())

        do {
            _ = try await client.perform(URLRequest(url: URL(string: "https://api.example.com/v1/me/patients")!))
            XCTFail("expected a transport error")
        } catch APIClientError.transport {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testWriteThatTimedOutIsNotReportedAsNotSaved() async {
        // The server may have stored it: no "Brak połączenia — nic nie zapisano".
        FailingURLProtocol.error = URLError(.timedOut)
        let client = URLSessionHTTPClient(session: Self.stubbedSession())
        var request = URLRequest(url: URL(string: "https://api.example.com/v1/patients/p/rescue-carbs")!)
        request.httpMethod = "POST"

        do {
            _ = try await client.perform(request)
            XCTFail("expected an error")
        } catch APIClientError.transport {
            XCTFail("a timed-out write must not read as never sent")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
    }

    func testWriteWhileOfflineIsTransport() async {
        FailingURLProtocol.error = URLError(.notConnectedToInternet)
        let client = URLSessionHTTPClient(session: Self.stubbedSession())
        var request = URLRequest(url: URL(string: "https://api.example.com/v1/patients/p/rescue-carbs")!)
        request.httpMethod = "POST"

        do {
            _ = try await client.perform(request)
            XCTFail("expected a transport error")
        } catch APIClientError.transport {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testCancelledRequestStaysCancellation() async {
        FailingURLProtocol.error = URLError(.cancelled)
        let client = URLSessionHTTPClient(session: Self.stubbedSession())

        do {
            _ = try await client.perform(URLRequest(url: URL(string: "https://api.example.com/v1/me/patients")!))
            XCTFail("expected a cancellation")
        } catch {
            XCTAssertFalse(error is APIClientError, "a cancelled request must not read as a failure: \(error)")
            XCTAssertTrue(error.isRequestCancellation)
        }
    }

    func testAPIClientReportsOfflineAsTransport() async {
        FailingURLProtocol.error = URLError(.networkConnectionLost)
        let client = APIClient(
            baseURL: URL(string: "https://api.example.com")!,
            authorizationMode: .none,
            httpClient: URLSessionHTTPClient(session: Self.stubbedSession())
        )

        do {
            _ = try await client.listAccessiblePatients()
            XCTFail("expected a transport error")
        } catch APIClientError.transport {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    private static func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// Fails every request with `error` without touching the network.
private final class FailingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var error: URLError?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: Self.error ?? URLError(.unknown))
    }

    override func stopLoading() {}
}
