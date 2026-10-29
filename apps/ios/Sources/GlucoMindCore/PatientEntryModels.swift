import Foundation

public struct PendingInvestigationResponse: Codable, Equatable {
    public let patient_id: String
    public let pending_investigation: PendingInvestigation?
}

public struct PendingInvestigation: Codable, Equatable {
    public let investigation_id: String
    public let state: String
    public let question: String
    public let question_id: String
    public let conversation_id: String
    public let event_id: String
}

public struct PendingQuestionsListResponse: Codable, Equatable {
    public let patient_id: String
    public let items: [PendingQuestionListItem]
}

public struct PendingQuestionListItem: Codable, Equatable, Identifiable {
    public let id: String
    public let investigation_id: String
    public let state: String
    public let question_id: String
    public let question_text: String
    public let question_type: String
    public let conversation_id: String
    public let event_id: String?
    public let created_at: String
    public let status: String
    public let origin: String?
    public let conversation_type: String?
    public let trigger_type: String?

    public init(
        id: String,
        investigation_id: String,
        state: String,
        question_id: String,
        question_text: String,
        question_type: String,
        conversation_id: String,
        event_id: String?,
        created_at: String,
        status: String,
        origin: String? = nil,
        conversation_type: String? = nil,
        trigger_type: String? = nil
    ) {
        self.id = id
        self.investigation_id = investigation_id
        self.state = state
        self.question_id = question_id
        self.question_text = question_text
        self.question_type = question_type
        self.conversation_id = conversation_id
        self.event_id = event_id
        self.created_at = created_at
        self.status = status
        self.origin = origin
        self.conversation_type = conversation_type
        self.trigger_type = trigger_type
    }
}

public enum PatientLaunchDestination: Equatable {
    case empty
    case dashboard(AccessiblePatient)
    case selection([AccessiblePatient])
}

public enum RootPresentationState: Equatable {
    case loading
    case error
    case signIn
    case patientEntry
}

public struct PatientLaunchResolver {
    public static func resolve(patients: [AccessiblePatient]) -> PatientLaunchDestination {
        if patients.isEmpty {
            return .empty
        }

        if patients.count == 1, let only = patients.first {
            return .dashboard(only)
        }

        return .selection(patients.sorted { $0.display_name.localizedCaseInsensitiveCompare($1.display_name) == .orderedAscending })
    }

    /// A notification's route never changes this: the patient's tabs stay the same views and only switch tab and
    /// screen (a separate state for a route rebuilt every tab twice, once when the route was set and once when cleared).
    public static func resolveRootPresentation(
        bootstrapped: Bool,
        hasBootstrapError: Bool,
        requiresSignIn: Bool
    ) -> RootPresentationState {
        if !bootstrapped {
            return .loading
        }

        if hasBootstrapError {
            return .error
        }

        if requiresSignIn {
            return .signIn
        }

        return .patientEntry
    }
}