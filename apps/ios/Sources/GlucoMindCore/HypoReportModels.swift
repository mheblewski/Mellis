import Foundation

/// The hypo a conversation is about (a hypo conversation from before; none are started now): the episode and its CGM
/// curve, shown above its chat. Sent with conversations about a hypo; nil for other conversations. The server may
/// still send the old report form's fields: they are not read.
public struct ConversationHypo: Codable, Equatable {
    public let episode_id: String
    public let state: String
    public let severity: String
    public let started_at: String
    public let ended_at: String?
    public let duration_minutes: Int?
    public let minimum_glucose: Int?
    public let glucose_readings: [HypoGlucoseReading]

    public init(
        episode_id: String,
        state: String,
        severity: String,
        started_at: String,
        ended_at: String?,
        duration_minutes: Int?,
        minimum_glucose: Int?,
        glucose_readings: [HypoGlucoseReading]
    ) {
        self.episode_id = episode_id
        self.state = state
        self.severity = severity
        self.started_at = started_at
        self.ended_at = ended_at
        self.duration_minutes = duration_minutes
        self.minimum_glucose = minimum_glucose
        self.glucose_readings = glucose_readings
    }
}

public struct HypoGlucoseReading: Codable, Equatable {
    public let observed_at: String
    public let glucose_mgdl: Int

    public init(observed_at: String, glucose_mgdl: Int) {
        self.observed_at = observed_at
        self.glucose_mgdl = glucose_mgdl
    }
}
