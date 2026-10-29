import Foundation

public protocol PatientAccessListing {
    func listAccessiblePatients() async throws -> AccessiblePatientsResponse
}

extension APIClient: PatientAccessListing {}

public actor PatientAccessResolver {
    private let api: PatientAccessListing

    public init(api: PatientAccessListing) {
        self.api = api
    }

    public func refreshAccessiblePatientIDs() async throws -> Set<String> {
        let response = try await api.listAccessiblePatients()
        return Set(response.patients.map { $0.patient_id })
    }
}
