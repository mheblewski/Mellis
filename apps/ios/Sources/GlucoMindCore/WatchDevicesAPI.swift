import Foundation

/// POST /v1/me/watch-devices: the phone's paired Apple Watch gets a read-only watch token (WatchSessionBridge).
public struct WatchDeviceCreated: Decodable, Equatable {
    public struct Device: Decodable, Equatable {
        public let id: String
    }
    public struct Patient: Decodable, Equatable {
        public let id: String
        public let name: String
    }
    public let token: String
    public let device: Device
    public let patients: [Patient]
}

private struct WatchDeviceRequest: Encodable {
    let kind: String
    let device: String
}

public extension APIClient {
    /// A read-only watch token for the phone's paired Apple Watch (the caregiver's first patients, up to four).
    func createAppleWatchDevice(label: String) async throws -> WatchDeviceCreated {
        var request = try await makeRequest(path: "/v1/me/watch-devices", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(WatchDeviceRequest(kind: "apple_watch", device: String(label.prefix(40))))
        return try await decode(request, as: WatchDeviceCreated.self)
    }

    /// The watch's token stops working (204; 404 when it was gone already).
    func revokeWatchDevice(id: String) async throws {
        let request = try await makeRequest(path: "/v1/me/watch-devices/\(id)", method: "DELETE")
        let (data, response) = try await httpClient.perform(request)
        try mapErrorStatusIfNeeded(status: response.statusCode, body: data)
    }
}
