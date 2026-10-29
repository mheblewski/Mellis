import SwiftUI

/// The system running the patient's loop, as the server recognised it from Nightscout (GET capabilities `loop_system`;
/// modules/loop-system/domain/loop-system.ts). Texts take its name from here instead of saying "Trio".
public enum LoopSystemKind: String, Equatable, Sendable {
    case trio = "TRIO"
    case aaps = "AAPS"
    case openaps = "OPENAPS"
    case loop = "LOOP"
    /// No loop calculation in the data yet, or an older server.
    case unknown = "UNKNOWN"

    /// The name in the forms Polish texts need: "Trio liczy" / "w Trio" / "do Trio" / "sprawdź Trio",
    /// "Loop liczy" / "w Loopie" / "do Loopa" / "sprawdź Loop".
    public var names: LoopSystemNames {
        switch self {
        case .trio: return LoopSystemNames(nominative: "Trio", locative: "Trio", genitive: "Trio", accusative: "Trio", gender: .neuter)
        case .loop: return LoopSystemNames(nominative: "Loop", locative: "Loopie", genitive: "Loopa", accusative: "Loop", gender: .masculine)
        case .aaps: return LoopSystemNames(nominative: "AAPS", locative: "AAPS", genitive: "AAPS", accusative: "AAPS", gender: .masculine)
        case .openaps: return LoopSystemNames(nominative: "OpenAPS", locative: "OpenAPS", genitive: "OpenAPS", accusative: "OpenAPS", gender: .masculine)
        case .unknown: return LoopSystemNames(nominative: "pętla", locative: "pętli", genitive: "pętli", accusative: "pętlę", gender: .feminine)
        }
    }
}

public struct LoopSystemNames: Equatable, Sendable {
    public enum Gender: Equatable, Sendable { case masculine, feminine, neuter }

    public let nominative: String
    public let locative: String
    public let genitive: String
    public let accusative: String
    /// For the words that agree with the name: "Trio rozpoczęło", "Loop rozpoczął", "pętla rozpoczęła".
    public let gender: Gender

    /// The form that agrees with the name.
    public func agree(m: String, f: String, n: String) -> String {
        switch gender {
        case .masculine: return m
        case .feminine: return f
        case .neuter: return n
        }
    }

    /// The name at the start of a sentence.
    public var capitalized: String { nominative.prefix(1).uppercased() + nominative.dropFirst() }
}

/// `loop_system` of the capabilities: the kind and the version the system uploads (Loop only).
public struct LoopSystemInfo: Codable, Equatable, Sendable {
    public let kind: String
    public let version: String?

    public init(kind: String, version: String?) {
        self.kind = kind
        self.version = version
    }

    public static let unknown = LoopSystemInfo(kind: LoopSystemKind.unknown.rawValue, version: nil)

    /// An unknown value (a newer server) reads as unknown.
    public var system: LoopSystemKind { LoopSystemKind(rawValue: kind) ?? .unknown }

    /// "Loop 3.14.11", "Trio"; nil when unknown.
    public var displayName: String? {
        guard system != .unknown else { return nil }
        return [system.names.nominative, version].compactMap { $0 }.joined(separator: " ")
    }
}

private struct LoopSystemKey: EnvironmentKey {
    static let defaultValue: LoopSystemKind = .unknown
}

public extension EnvironmentValues {
    /// The current patient's loop (set above the patient's tabs from the capabilities); unknown in previews.
    var loopSystem: LoopSystemKind {
        get { self[LoopSystemKey.self] }
        set { self[LoopSystemKey.self] = newValue }
    }
}

private struct AiLimitNoticeKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

public extension EnvironmentValues {
    /// "Limit AI na ten miesiąc wyczerpany…" while the server's monthly AI limit is used up (from the capabilities).
    var aiLimitNotice: String? {
        get { self[AiLimitNoticeKey.self] }
        set { self[AiLimitNoticeKey.self] = newValue }
    }
}

/// Puts the capabilities' loop system (and the AI limit notice) into the environment of `content`, following changes.
public struct LoopSystemEnvironment<Content: View>: View {
    @ObservedObject private var capabilities: PatientCapabilitiesStore
    private let content: Content

    public init(capabilities: PatientCapabilitiesStore, @ViewBuilder content: () -> Content) {
        self.capabilities = capabilities
        self.content = content()
    }

    public var body: some View {
        content
            .environment(\.loopSystem, loopSystem)
            .environment(\.aiLimitNotice, capabilities.aiLimit?.notice())
    }

    /// The recognised loop; before the data say, the one this caregiver's commands go to (Trio's or Loop's driver).
    private var loopSystem: LoopSystemKind {
        let recognised = capabilities.loopSystem.system
        guard recognised == .unknown, capabilities.remoteCommands.enabled else { return recognised }
        return capabilities.remoteCommands.sendsToLoop ? .loop : .trio
    }
}
