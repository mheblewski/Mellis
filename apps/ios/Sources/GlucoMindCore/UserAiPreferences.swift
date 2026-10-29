import Foundation

/// Who is writing to the AI ("Kim jesteś?" in "Instrukcje dla Mellisa"); the server's users.ai_role.
public enum AiUserRole: String, Codable, CaseIterable, Identifiable, Sendable {
    case parent = "PARENT"
    case grandparent = "GRANDPARENT"
    case institutionCaregiver = "INSTITUTION_CAREGIVER"
    case patientSelf = "PATIENT_SELF"
    case clinician = "CLINICIAN"
    case other = "OTHER"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .parent: return "Rodzic"
        case .grandparent: return "Babcia lub dziadek"
        case .institutionCaregiver: return "Opiekun w placówce"
        case .patientSelf: return "Jestem pacjentem"
        case .clinician: return "Lekarz lub pielęgniarka"
        case .other: return "Inna osoba"
        }
    }
}

/// "Instrukcje dla Mellisa" (GET/PUT /v1/me/ai-preferences): the user's role and own wishes for the AI, for every
/// patient. They change the tone and who the AI talks to, never the safety rules.
public struct UserAiPreferences: Equatable, Sendable {
    /// Characters of the text, counted as the server counts them (Unicode scalars).
    public static let maxInstructionsLength = 500

    public var role: AiUserRole?
    public var instructions: String

    public init(role: AiUserRole? = nil, instructions: String = "") {
        self.role = role
        self.instructions = instructions
    }

    /// The text's length as the server counts it, after trimming.
    public static func characterCount(_ text: String) -> Int {
        text.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    public var instructionsCount: Int { Self.characterCount(instructions) }
    public var isInstructionsTooLong: Bool { instructionsCount > Self.maxInstructionsLength }
    public var isEmpty: Bool { role == nil && instructionsCount == 0 }

    /// The value next to the Settings row.
    public var summary: String {
        if let role { return role.label }
        return instructionsCount > 0 ? "Własne instrukcje" : "Nie ustawiono"
    }
}

extension UserAiPreferences: Codable {
    private enum CodingKeys: String, CodingKey {
        case role = "ai_role"
        case instructions = "ai_instructions"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A role this app does not know (from a newer server) reads as not chosen.
        role = (try? container.decodeIfPresent(String.self, forKey: .role)).flatMap(AiUserRole.init(rawValue:))
        instructions = (try container.decodeIfPresent(String.self, forKey: .instructions)) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // Both keys always sent: null clears a value on the server.
        try container.encode(role?.rawValue, forKey: .role)
        let trimmed = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        try container.encode(trimmed.isEmpty ? nil : trimmed, forKey: .instructions)
    }
}

/// A ready example under "Opowiedz o sobie": tapping it puts its text in the field in place of an example tapped before
/// (the user's own words stay) and, when the example says who is writing, chooses that role.
public struct AiInstructionExample: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    /// SF Symbol.
    public let symbol: String
    public let text: String
    /// The role the example implies; nil keeps the role already chosen.
    public let role: AiUserRole?

    public static let all: [AiInstructionExample] = [
        AiInstructionExample(
            id: "new-diagnosis", title: "Świeżo po diagnozie", subtitle: "Mów prosto i dużo tłumacz", symbol: "leaf",
            text: "Jesteśmy świeżo po diagnozie. Mów prosto, tłumacz każde pojęcie (np. WBT, ISF, IOB) i podawaj jeden krok naraz.",
            role: nil
        ),
        AiInstructionExample(
            id: "clinician", title: "Jestem lekarzem", subtitle: "Mów jak do specjalisty", symbol: "stethoscope",
            text: "Jestem lekarzem. Mów do mnie jak do specjalisty: terminy kliniczne, konkretne liczby i źródła, bez upraszczania.",
            role: .clinician
        ),
        AiInstructionExample(
            id: "institution", title: "Opiekuję się w placówce", subtitle: "Krótko: co zrobić teraz", symbol: "building.2",
            text: "Opiekuję się pacjentem w placówce. Pisz krótko, co zrobić teraz i kiedy zadzwonić do rodziny.",
            role: .institutionCaregiver
        ),
        AiInstructionExample(
            id: "self", title: "Choruję sam", subtitle: "Zwracaj się do mnie", symbol: "person",
            text: "Mam cukrzycę typu 1 i piszę o sobie. Zwracaj się bezpośrednio do mnie.",
            role: .patientSelf
        ),
        AiInstructionExample(
            id: "experienced", title: "Mam doświadczenie", subtitle: "Same konkrety", symbol: "bolt",
            text: "Mam kilka lat doświadczenia z pętlą. Pisz krótko: liczby, propozycja i najważniejsze ryzyko.",
            role: nil
        ),
        AiInstructionExample(
            id: "support", title: "Potrzebuję wsparcia", subtitle: "Ciepło i spokojnie", symbol: "heart",
            text: "Bywa mi ciężko z tym wszystkim. Odpowiadaj ciepło i spokojnie, bez straszenia.",
            role: nil
        ),
    ]
}

public extension UserAiPreferences {
    /// The example whose text is in the field, as written; nil once the user removed or changed that text.
    var selectedExample: AiInstructionExample? {
        AiInstructionExample.all.first { instructions.contains($0.text) }
    }

    /// The user's own words: the text without any example in it, line by line.
    var ownInstructions: String {
        var own = instructions
        for example in AiInstructionExample.all {
            own = own.replacingOccurrences(of: example.text, with: "")
        }
        return own.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    /// The preferences after tapping an example: the text of any example already in the field gives way to this one, the
    /// user's own words stay before it; its role if it has one.
    func applying(_ example: AiInstructionExample) -> UserAiPreferences {
        let own = ownInstructions
        return UserAiPreferences(role: example.role ?? role, instructions: own.isEmpty ? example.text : own + "\n" + example.text)
    }

    /// The preferences after tapping the selected example again: its text leaves the field, the role stays.
    func removingExample() -> UserAiPreferences {
        UserAiPreferences(role: role, instructions: ownInstructions)
    }
}

/// The role the user had before an example changed it, so taking the example back (or switching to an example that
/// says nothing about the role) gives that role back instead of leaving the example's one unnoticed. A role the user
/// picks by hand wins: it forgets the saved one.
public struct AiExampleRoleMemory: Equatable, Sendable {
    /// Some(role) while an example's role replaced it (the role may be "none"); nil when no example changed it.
    public private(set) var saved: AiUserRole?? = nil

    public init() {}

    /// The role after tapping an example: its own role, or the user's role when it has none.
    public mutating func roleAfterApplying(_ example: AiInstructionExample, current: AiUserRole?) -> AiUserRole? {
        guard let exampleRole = example.role else {
            let restored = saved ?? current
            saved = nil
            return restored
        }
        if saved == nil { saved = .some(current) }
        return exampleRole
    }

    /// The role after the example's text left the field (tapped again, or the field cleared).
    public mutating func roleAfterRemovingExample(current: AiUserRole?) -> AiUserRole? {
        defer { saved = nil }
        return saved ?? current
    }

    /// The user chose a role in "Kim jesteś".
    public mutating func userChoseRole() {
        saved = nil
    }
}
